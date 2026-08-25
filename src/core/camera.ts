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
/** Скорость возврата к стартовой рамке. */
const HOME_LAMBDA = 4.2;
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
  /** Вернуть камеру и точку интереса к стартовой рамке с анимацией. */
  home: () => void;
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
  let lastAspect = camera.aspect;
  /** Трогал ли человек камеру: до первого касания рамка вправе двигать камеру сама. */
  let touched = false;
  /** Идёт ли возврат к стартовой рамке. */
  let homing = false;
  /** Ведём ли точку интереса к цели (клик по помещению или возврат). */
  let focusing = false;

  function onUserInput(): void {
    touched = true;
    // Ввод человека всегда главнее анимации: он не должен бороться с камерой.
    homing = false;
    focusing = false;
  }
  controls.addEventListener('start', onUserInput);

  return {
    camera,
    controls,
    update(dt: number): void {
      if (Math.abs(camera.aspect - lastAspect) > 1e-4) {
        lastAspect = camera.aspect;
        updateHomeFrame();
        // Пока человек не трогал камеру (первые секунды, поворот экрана в руках),
        // рамка подстраивается сама. После первого касания — только по кнопке возврата.
        if (!touched) {
          camera.position.copy(homePosition);
          controls.target.copy(homeTarget);
          goal.copy(homeTarget);
        }
      }

      if (homing) {
        dampVector(camera.position, homePosition, HOME_LAMBDA, dt);
        if (camera.position.distanceToSquared(homePosition) < SETTLED * SETTLED) {
          camera.position.copy(homePosition);
          homing = false;
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
      focusing = true;
    },
    home(): void {
      updateHomeFrame();
      goal.copy(homeTarget);
      homing = true;
      focusing = true;
    },
    dispose(): void {
      controls.removeEventListener('start', onUserInput);
      controls.dispose();
    },
  };
}
