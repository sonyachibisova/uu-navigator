/**
 * Камера, орбитальные контролы и стартовая рамка.
 *
 * Ракурс задан углами, а расстояние не берётся долей габарита: оно считается
 * так, чтобы габарит здания целиком поместился в кадр по обеим осям при текущем
 * соотношении сторон. Поэтому на телефоне в портрете здание видно целиком,
 * а не обрезанным с двух концов, и рамка пересчитывается при смене размера окна.
 *
 * Всё сглаживание идёт по времени кадра (`damp`), а не по числу кадров
 * (инвариант 6 правил проекта): на 120 Гц и на 30 Гц движение одинаковое.
 */
import { MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { DISTANCE_FULL } from '@core/dollhouse';
import { prefersReducedMotion } from '@core/motion';

/** Габарит, от которого считаются все расстояния камеры. */
export interface CameraFrame {
  /** Центр здания в плане, на уровне земли. */
  center: Vector3;
  /** Половина наибольшего измерения в плане, метры. */
  radius: number;
  /** Высота здания, метры. */
  height: number;
  /** Габарит в плане, метры: по нему считается вписывание в кадр. */
  width: number;
  depth: number;
}

/** Угол обзора по вертикали (в three.js `fov` — вертикальный). */
const FOV = 55;
/**
 * Ракурс: подъём над горизонтом и поворот в плане от лицевой грани.
 * В портрете камера поднимается выше и уходит вбок — тогда длинный корпус
 * ложится по диагонали кадра и требует меньшего отъезда.
 */
const LANDSCAPE_VIEW = { elevation: 31, azimuth: 42 };
const PORTRAIT_VIEW = { elevation: 50, azimuth: 66 };
/** Соотношение сторон, ниже которого кадр считается портретным. */
const PORTRAIT_ASPECT = 0.95;
/** Запас вокруг габарита, чтобы здание не касалось краёв кадра. */
const FRAME_MARGIN = 1.08;
/** Точка интереса по высоте: середина габарита. */
const TARGET_HEIGHT = 0.5;
/** Скорость подвода точки интереса: λ ≈ 3.7 повторяет прежнее ощущение на 60 кадрах. */
const TARGET_LAMBDA = 3.7;
/** Скорость перелёта камеры: возврат к стартовой рамке и подлёт к зданию. */
const FLIGHT_LAMBDA = 4.2;
/**
 * Подлёт «заглянуть внутрь»: подъём над горизонтом в градусах и расстояние в
 * долях дистанции обзора.
 *
 * Расстояние выводится из порога кукольного дома (`src/core/dollhouse.ts`),
 * а не подбирается отдельно: камера обязана встать ближе `DISTANCE_FULL`,
 * иначе кнопка подводит камеру, но ничего не раскрывает. Подъём с раскрытием
 * больше не связан — кровля уходит вместе с ним при любом угле, — и остаётся
 * чистым выбором ракурса: сверху виден план, но ракурс не становится отвесным.
 */
const REVEAL_ELEVATION = 52;
/**
 * Подъём над горизонтом при показе выбранного этажа, градусы. Ниже плана не
 * видно: ближняя стена начинает съедать первый ряд помещений. Отвесно тоже
 * нельзя — пропадает объём, и человек перестаёт понимать, что смотрит на этаж
 * здания, а не на чертёж.
 */
const FLOOR_ELEVATION = 56;
const REVEAL_DISTANCE_FACTOR = DISTANCE_FULL - 0.03;
/** Ниже горизонта камера не опускается: под землёй смотреть не на что. */
const MAX_POLAR = MathUtils.degToRad(85);
/** Ближняя и дальняя плоскости в долях габарита. */
const NEAR_FACTOR = 1 / 50;
const FAR_FACTOR = 18;
/** Насколько близко и далеко разрешено отходить, в долях габарита. */
const MIN_DISTANCE_FACTOR = 0.08;
const MAX_DISTANCE_FACTOR = 4;
/** Запас панорамирования вокруг пятна застройки, доля габарита. */
const PAN_MARGIN = 0.25;
/** Погрешность, ниже которой считаем, что доехали. */
const SETTLED = 0.01;

export interface CameraHandle {
  camera: PerspectiveCamera;
  controls: OrbitControls;
  /** Плавно вести камеру и точку интереса; вызывается каждый кадр. */
  update: (dt: number) => void;
  /** Задать новую точку интереса (клик по помещению). */
  lookAt: (point: Vector3) => void;
  /**
   * Подвести камеру к выбранному этажу: кадр строится по плите этажа, а не по
   * всему зданию. Без этого после нажатия на этаж камера оставалась в рамке
   * общего вида, рассчитанной на здание вместе с высотой, и план занимал
   * четверть кадра. Поворот в плане сохраняется — человек не теряет, куда смотрел.
   */
  frameFloor: (centerY: number, thickness: number) => void;
  /**
   * Подвести камеру к помещению: кадр строится по окну вокруг него, а не по
   * всей стометровой длине корпуса. Иначе найденное помещение показывается
   * с той же дистанции, с которой его и не было видно.
   */
  frameRoom: (center: Vector3, radius: number) => void;
  /**
   * Подвести камеру так, чтобы в кадр попал прямоугольник в плане: им
   * кадрируется маршрут целиком. Показывать маршрут, у которого в кадре
   * только конец, — то же самое, что не показывать его вовсе.
   */
  frameArea: (center: Vector3, halfX: number, halfZ: number) => void;
  /** Вернуть камеру и точку интереса к стартовой рамке с анимацией. */
  home: () => void;
  /**
   * Подлететь к зданию с анимацией, сохранив выбранный человеком поворот в
   * плане. Механику раскрытия камера не трогает: она только подходит ближе.
   */
  approach: () => void;
  /**
   * Дистанция обзора: расстояние, с которого габарит здания целиком помещается
   * в кадр. Это опорная длина для всего, что меряет близость камеры, — она
   * считается из габарита здания и текущего кадра и пересчитывается при
   * изменении соотношения сторон.
   */
  overviewDistance: () => number;
  /**
   * Сообщить камере, сколько пикселей внизу экрана закрыто интерфейсом
   * (стартовый лист, карточка места), — здание должно центрироваться
   * в свободной части экрана, а не за вычетом невидимой полосы.
   * Двигает не саму камеру, а срез кадра (`setViewOffset`): точка интереса
   * остаётся на месте, картинка просто смещается вверх на нужную долю —
   * ракурс и дистанция подлёта этим не затрагиваются.
   */
  setBottomInset: (px: number) => void;
  dispose: () => void;
}

/** Единичный вектор «от центра здания к камере» по подъёму и повороту в градусах. */
function directionOf(view: { elevation: number; azimuth: number }): Vector3 {
  const elevation = MathUtils.degToRad(view.elevation);
  const azimuth = MathUtils.degToRad(view.azimuth);
  return new Vector3(
    -Math.sin(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.cos(azimuth) * Math.cos(elevation),
  ).normalize();
}

/**
 * Расстояние, с которого габарит `half` (полуразмеры от точки интереса) целиком
 * помещается в кадр. Считается по восьми углам габарита: каждый угол задаёт
 * минимальную дистанцию по горизонтали и по вертикали, берётся наибольшая.
 */
function frameDistance(
  direction: Vector3,
  half: Vector3,
  fovDegrees: number,
  aspect: number,
): number {
  const forward = direction.clone().negate();
  const right = new Vector3(-forward.z, 0, forward.x);
  if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
  right.normalize();
  const up = right.clone().cross(forward).normalize();

  const tanV = Math.tan(MathUtils.degToRad(fovDegrees) / 2);
  const tanH = tanV * Math.max(aspect, 0.05);

  const corner = new Vector3();
  let distance = 0;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        corner.set(half.x * sx, half.y * sy, half.z * sz);
        const depth = corner.dot(forward);
        distance = Math.max(
          distance,
          Math.abs(corner.dot(right)) / tanH - depth,
          Math.abs(corner.dot(up)) / tanV - depth,
        );
      }
    }
  }
  return distance * FRAME_MARGIN;
}

/** Покомпонентное сглаживание по времени кадра. */
function dampVector(current: Vector3, goal: Vector3, lambda: number, dt: number): void {
  current.set(
    MathUtils.damp(current.x, goal.x, lambda, dt),
    MathUtils.damp(current.y, goal.y, lambda, dt),
    MathUtils.damp(current.z, goal.z, lambda, dt),
  );
}

export function createCamera(frame: CameraFrame, domElement: HTMLElement): CameraHandle {
  const camera = new PerspectiveCamera(
    FOV,
    1,
    Math.max(0.05, frame.radius * NEAR_FACTOR),
    frame.radius * FAR_FACTOR,
  );

  const half = new Vector3(frame.width / 2, frame.height / 2, frame.depth / 2);
  const homeTarget = new Vector3(frame.center.x, frame.height * TARGET_HEIGHT, frame.center.z);
  const homePosition = new Vector3();
  /** Куда летим сейчас: стартовая рамка или точка подлёта. */
  const flightPosition = new Vector3();
  /** Дистанция обзора при текущем соотношении сторон. */
  let overview = 0;

  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.maxPolarAngle = MAX_POLAR;
  controls.minDistance = Math.max(2, frame.radius * MIN_DISTANCE_FACTOR);

  /** Пятно, за которое нельзя увести точку интереса панорамированием. */
  const panMargin = frame.radius * PAN_MARGIN;
  const limits = {
    x0: frame.center.x - frame.width / 2 - panMargin,
    x1: frame.center.x + frame.width / 2 + panMargin,
    z0: frame.center.z - frame.depth / 2 - panMargin,
    z1: frame.center.z + frame.depth / 2 + panMargin,
    y1: frame.height * 1.3,
  };

  function clampTarget(point: Vector3): void {
    point.set(
      MathUtils.clamp(point.x, limits.x0, limits.x1),
      MathUtils.clamp(point.y, 0, limits.y1),
      MathUtils.clamp(point.z, limits.z0, limits.z1),
    );
  }

  /** Пересчитать стартовую рамку под текущее соотношение сторон. */
  function updateHomeFrame(): void {
    const portrait = camera.aspect < PORTRAIT_ASPECT;
    const direction = directionOf(portrait ? PORTRAIT_VIEW : LANDSCAPE_VIEW);
    const distance = frameDistance(direction, half, FOV, camera.aspect);
    overview = distance;
    homePosition.copy(direction).multiplyScalar(distance).add(homeTarget);
    controls.maxDistance = Math.max(frame.radius * MAX_DISTANCE_FACTOR, distance * 1.6);
    const far = Math.max(frame.radius * FAR_FACTOR, distance * 3);
    if (camera.far !== far) {
      camera.far = far;
      camera.updateProjectionMatrix();
    }
  }

  updateHomeFrame();
  camera.position.copy(homePosition);
  controls.target.copy(homeTarget);

  const goal = homeTarget.clone();
  const shift = new Vector3();
  const offset = new Vector3();
  /** Направление «от цели к камере» для перелётов: без аллокации на каждый вызов. */
  const flightDirection = new Vector3();
  /** Полуразмеры кадрируемого объёма: тот же вектор переиспользуется. */
  const flightHalf = new Vector3();
  /** Человек попросил без анимации: перелёты применяются сразу, результат тот же. */
  const instant = prefersReducedMotion();
  let lastAspect = camera.aspect;
  /** Трогал ли человек камеру: до первого касания рамка вправе двигать камеру сама. */
  let touched = false;
  /** Идёт ли перелёт камеры. */
  let flying = false;
  /** Ведём ли точку интереса к цели (клик по помещению или возврат). */
  let focusing = false;

  /** Начать перелёт к `flightPosition` и подвод точки интереса к `goal`. */
  function startFlight(): void {
    if (instant) {
      camera.position.copy(flightPosition);
      controls.target.copy(goal);
      flying = false;
      focusing = false;
      return;
    }
    flying = true;
    focusing = true;
  }

  function onUserInput(): void {
    touched = true;
    // Ввод человека всегда главнее анимации: он не должен бороться с камерой.
    flying = false;
    focusing = false;
  }
  controls.addEventListener('start', onUserInput);

  /** Пикселей снизу, закрытых интерфейсом — см. `setBottomInset`. */
  let bottomInset = 0;

  /**
   * Пересчитать срез кадра под текущий размер холста и текущий отступ.
   * Смещение — доля от отношения (высота холста + отступ) к высоте холста:
   * ровно то, что нужно, чтобы точка интереса, обычно попадающая в центр
   * кадра, встала в центр области над панелью, а не экрана целиком.
   */
  function applyBottomInset(): void {
    const width = domElement.clientWidth;
    const height = domElement.clientHeight;
    if (bottomInset > 0 && width > 0 && height > 0) {
      camera.setViewOffset(width, height + bottomInset, 0, bottomInset, width, height);
    } else {
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
  }

  return {
    camera,
    controls,
    update(dt: number): void {
      if (Math.abs(camera.aspect - lastAspect) > 1e-4) {
        lastAspect = camera.aspect;
        updateHomeFrame();
        // Холст сменил размер (resize, поворот экрана) — срез кадра посчитан
        // под старые пиксели и без обновления съедет.
        applyBottomInset();
        // Пока человек не трогал камеру (первые секунды, поворот экрана в руках),
        // рамка подстраивается сама. После первого касания — только по кнопке возврата.
        if (!touched) {
          camera.position.copy(homePosition);
          controls.target.copy(homeTarget);
          goal.copy(homeTarget);
        }
      }

      if (flying) {
        dampVector(camera.position, flightPosition, FLIGHT_LAMBDA, dt);
        if (camera.position.distanceToSquared(flightPosition) < SETTLED * SETTLED) {
          camera.position.copy(flightPosition);
          flying = false;
        }
      }

      if (focusing) {
        dampVector(controls.target, goal, TARGET_LAMBDA, dt);
        if (controls.target.distanceToSquared(goal) < SETTLED * SETTLED) {
          controls.target.copy(goal);
          focusing = false;
        }
      }

      controls.update();

      // Панорамирование двигает и точку интереса, и камеру: возвращаем обе
      // на тот же вектор, иначе ракурс «поплывёт» относительно здания.
      shift.copy(controls.target);
      clampTarget(controls.target);
      shift.subVectors(controls.target, shift);
      if (shift.lengthSq() > 0) camera.position.add(shift);
    },
    lookAt(point: Vector3): void {
      goal.copy(point);
      clampTarget(goal);
      if (instant) {
        controls.target.copy(goal);
        focusing = false;
        return;
      }
      focusing = true;
    },
    frameFloor(centerY: number, thickness: number): void {
      updateHomeFrame();
      offset.subVectors(camera.position, controls.target);
      const azimuth = Math.atan2(offset.x, offset.z);
      const elevation = MathUtils.degToRad(FLOOR_ELEVATION);
      const flat = Math.cos(elevation);
      flightDirection.set(Math.sin(azimuth) * flat, Math.sin(elevation), Math.cos(azimuth) * flat);
      // Кадрируется плита этажа: габарит в плане тот же, а высота — своя,
      // и именно она раньше отбрасывала камеру на дистанцию всего здания.
      flightHalf.set(half.x, Math.max(thickness, 0.5) / 2, half.z);
      const distance = MathUtils.clamp(
        frameDistance(flightDirection, flightHalf, FOV, camera.aspect),
        controls.minDistance * 1.2,
        controls.maxDistance * 0.9,
      );
      goal.set(homeTarget.x, centerY, homeTarget.z);
      flightPosition.copy(flightDirection).multiplyScalar(distance).add(goal);
      touched = true;
      startFlight();
    },
    frameArea(center: Vector3, halfX: number, halfZ: number): void {
      updateHomeFrame();
      offset.subVectors(camera.position, controls.target);
      const azimuth = Math.atan2(offset.x, offset.z);
      const elevation = MathUtils.degToRad(FLOOR_ELEVATION);
      const flat = Math.cos(elevation);
      flightDirection.set(Math.sin(azimuth) * flat, Math.sin(elevation), Math.cos(azimuth) * flat);
      flightHalf.set(Math.max(halfX, 4), 2, Math.max(halfZ, 4));
      const distance = MathUtils.clamp(
        frameDistance(flightDirection, flightHalf, FOV, camera.aspect),
        controls.minDistance * 1.2,
        controls.maxDistance * 0.9,
      );
      goal.copy(center);
      clampTarget(goal);
      flightPosition.copy(flightDirection).multiplyScalar(distance).add(goal);
      touched = true;
      startFlight();
    },
    frameRoom(center: Vector3, radius: number): void {
      updateHomeFrame();
      offset.subVectors(camera.position, controls.target);
      const azimuth = Math.atan2(offset.x, offset.z);
      const elevation = MathUtils.degToRad(FLOOR_ELEVATION);
      const flat = Math.cos(elevation);
      flightDirection.set(Math.sin(azimuth) * flat, Math.sin(elevation), Math.cos(azimuth) * flat);
      const size = Math.max(radius, 1);
      flightHalf.set(size, size / 2, size);
      const distance = MathUtils.clamp(
        frameDistance(flightDirection, flightHalf, FOV, camera.aspect),
        controls.minDistance * 1.2,
        controls.maxDistance * 0.9,
      );
      goal.copy(center);
      clampTarget(goal);
      flightPosition.copy(flightDirection).multiplyScalar(distance).add(goal);
      touched = true;
      startFlight();
    },
    home(): void {
      updateHomeFrame();
      flightPosition.copy(homePosition);
      goal.copy(homeTarget);
      startFlight();
    },
    approach(): void {
      updateHomeFrame();
      // Поворот в плане человек уже выбрал сам — подлёт его сохраняет и меняет
      // только подъём и расстояние. Иначе здание на глазах «перескакивает»
      // на другую сторону, и человек теряет, куда смотрел.
      offset.subVectors(camera.position, controls.target);
      const azimuth = Math.atan2(offset.x, offset.z);
      const elevation = MathUtils.degToRad(REVEAL_ELEVATION);
      const flat = Math.cos(elevation);
      const distance = MathUtils.clamp(
        overview * REVEAL_DISTANCE_FACTOR,
        controls.minDistance * 1.2,
        controls.maxDistance * 0.9,
      );
      flightPosition
        .set(Math.sin(azimuth) * flat, Math.sin(elevation), Math.cos(azimuth) * flat)
        .multiplyScalar(distance)
        .add(homeTarget);
      goal.copy(homeTarget);
      touched = true;
      startFlight();
    },
    overviewDistance: () => overview,
    setBottomInset(px: number): void {
      const next = Math.max(0, Math.round(px));
      if (next === bottomInset) return;
      bottomInset = next;
      applyBottomInset();
    },
    dispose(): void {
      controls.removeEventListener('start', onUserInput);
      controls.dispose();
    },
  };
}
