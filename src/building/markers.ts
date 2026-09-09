/**
 * Метки на плане: булавка «я здесь», выделение выбранного места и его подпись.
 *
 * Это шестая группа верхнего уровня — `markersGroup`. Как и маршрут, она не
 * часть корпуса: инвариант 1 правил проекта говорит про геометрию здания,
 * а метки появляются и исчезают вместе с ответом на вопрос человека.
 *
 * Зачем модуль вообще есть. Осветления плиты и её подъёма оказалось мало:
 * человек, выбравший помещение из списка, не разглядывал план секунду назад
 * и не помнит, каким оттенком оно было. Метка над местом и контур по краю
 * плиты читаются сразу и рядом с соседями — и читаются одинаково при любой
 * палитре пола, потому что контур двухцветный: светлая полоса изнутри,
 * тёмная снаружи. На светлой ступени серого работает тёмная, на тёмной —
 * светлая, и подбирать цвет под палитру не нужно.
 *
 * Подпись висит над меткой выбора и появляется только вместе с ней. Это
 * единственное место, где человек видит номер помещения на плане: сам план
 * подписей не несёт (`LOOK.planLabels`), иначе полсотни номеров разом
 * читаются как шум. Спросили про комнату — комната назвалась.
 *
 * Объектов ровно пять на всю сцену, а не по объекту на помещение: булавка
 * старта с кольцом по полу, метка выбранного места, контур и подпись. Пять
 * вызовов отрисовки, независимо от того, сколько в здании помещений.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  ConeGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RingGeometry,
  SRGBColorSpace,
} from 'three';
import type { Camera } from 'three';
import { SELECT_RAISE } from '@building/floors';

/** Лайм интерфейса: путь и главное действие. Булавка старта — начало пути. */
const START_COLOR = 0xd8ff3e;
/** Метка выбранного места — нейтральная: выбор ещё не путь. */
const PICK_COLOR = 0xffffff;
/** Тёмная половина контура: она держит его на светлых ступенях серого. */
const RIM_DARK = 0x0b0c09;
/** Светлая половина контура: она держит его на тёмных ступенях. */
const RIM_LIGHT = 0xffffff;

/** Размеры метки, метры: остриё внизу, конус над ним. */
const PIN_RADIUS = 0.7;
const PIN_HEIGHT = 1.5;
/**
 * На сколько остриё метки поднято над тем, что она отмечает. Подпись
 * помещения висит на 2.5 м и занимает около метра: метка ниже этого
 * пряталась за номером ровно того помещения, которое отмечает.
 */
const PIN_CLEARANCE = 3;
/** Размах покачивания метки и его период, метры и секунды. */
const BOB = 0.22;
const BOB_PERIOD = 2.4;

/** Кольцо булавки по полу: внутренний и внешний радиус, метры. */
const RING_INNER = 0.85;
const RING_OUTER = 1.15;
/** Высота кольца и контура над плитой: чтобы не спорили с ней по глубине. */
const LIFT = 0.05;

/**
 * Ширина одной полосы контура, метры. С высоты, на которой человек смотрит
 * на этаж, полоса в четверть метра — это один пиксель: контур был, а видно
 * его не было.
 */
const RIM_WIDTH = 0.6;
/** Порядок отрисовки: поверх плит и ленты маршрута, под подписями. */
const RENDER_ORDER = 3;

/**
 * Подпись выбранного места. Светлая плашка с тёмной надписью — она обязана
 * читаться и на светлой подложке, и на тёмной, и на любой ступени серого,
 * поэтому цвет у неё свой, а не взятый из палитры этажа.
 */
const PLAQUE_BG = '#ffffff';
const PLAQUE_EDGE = 'rgba(11,12,9,0.14)';
const PLAQUE_INK = '#14171a';
const PLAQUE_FONT_SIZE = 46;
const PLAQUE_FONT = `400 ${PLAQUE_FONT_SIZE}px Univers, Arial, Helvetica, sans-serif`;
const PLAQUE_LINE_HEIGHT = Math.round(PLAQUE_FONT_SIZE * 1.24);
const PLAQUE_PAD_X = 34;
const PLAQUE_PAD_Y = 20;
const PLAQUE_RADIUS = 20;
/** Дальше строка переносится: длинное название не должно расти на полэкрана. */
const PLAQUE_MAX_TEXT = 560;
const PLAQUE_MAX_LINES = 2;
/**
 * Метры на пиксель растра. Задано через высоту строки: строка подписи выходит
 * ростом 1.15 м независимо от кегля, а плашка растёт от содержимого.
 */
const PLAQUE_METERS_PER_PX = 1.15 / PLAQUE_LINE_HEIGHT;
/** Зазор между верхушкой метки и низом плашки, метры. */
const PLAQUE_GAP = 0.45;

/** Место, отмеченное булавкой или выделением. */
export interface MarkSpot {
  x: number;
  z: number;
  level: number;
  /** Габарит плиты в плане: есть только у помещения. Коридор контура не получает. */
  width?: number;
  depth?: number;
  /**
   * Плита этого помещения сейчас поднята подсветкой выбора. Метка и контур
   * обязаны подняться вместе с ней, иначе контур уедет под плиту.
   */
  raised?: boolean;
  /**
   * Что написать на плашке над меткой: название и номер по плану. Пусто —
   * плашки нет. У точек графа (лестница, вход) названия может не быть вовсе.
   */
  caption?: string;
}

export interface MarkersHandle {
  group: Group;
  /** Булавка «я здесь». `undefined` — снять. */
  setStart: (spot: MarkSpot | undefined) => void;
  /** Выбранное место: метка над ним и контур по краю плиты. */
  setSelected: (spot: MarkSpot | undefined) => void;
  /**
   * Какой этаж показан сейчас: `null` — здание целиком. Метка на невидимом
   * этаже висела бы в воздухе над чужим планом.
   */
  setVisibleLevel: (level: number | null) => void;
  /**
   * Шаг анимации: метки едва заметно покачиваются, плашка держится лицом
   * к камере — поэтому камера и приходит сюда.
   */
  update: (dt: number, camera: Camera) => void;
  dispose: () => void;
}

/** Высота пола этажа: приходит снаружи, метки не знают про паспорт здания. */
export type FloorElevation = (level: number) => number;

/** Конус остриём вниз: общая геометрия обеих меток. */
function pinGeometry(): ConeGeometry {
  const geometry = new ConeGeometry(PIN_RADIUS, PIN_HEIGHT, 6);
  geometry.rotateX(Math.PI);
  return geometry;
}

/** Разбить надпись на строки по ширине растра: не больше двух, лишнее — многоточием. */
function wrapCaption(measure: CanvasRenderingContext2D, text: string): string[] {
  if (measure.measureText(text).width <= PLAQUE_MAX_TEXT) return [text];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (measure.measureText(next).width <= PLAQUE_MAX_TEXT || !line) {
      line = next;
      continue;
    }
    lines.push(line);
    line = word;
    if (lines.length === PLAQUE_MAX_LINES) break;
  }
  if (lines.length < PLAQUE_MAX_LINES && line) lines.push(line);
  // Не поместившееся закрывается многоточием: обрезанное без него читается
  // как настоящее название помещения, а это уже неправда.
  const last = lines[PLAQUE_MAX_LINES - 1];
  if (lines.length === PLAQUE_MAX_LINES && last !== undefined) {
    const joined = lines.join(' ');
    if (joined.length < text.length) {
      let tail = last;
      while (tail.length > 1 && measure.measureText(`${tail}…`).width > PLAQUE_MAX_TEXT) {
        tail = tail.slice(0, -1);
      }
      lines[PLAQUE_MAX_LINES - 1] = `${tail}…`;
    }
  }
  return lines;
}

/** Скруглённый прямоугольник: у плашки те же углы, что у панелей интерфейса. */
function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

/** Нарисовать плашку с надписью. Возвращает текстуру и её размер в метрах. */
function drawPlaque(text: string): { texture: CanvasTexture; width: number; height: number } | null {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = PLAQUE_FONT;
  const lines = wrapCaption(ctx, text);
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
  canvas.width = Math.ceil(widest + PLAQUE_PAD_X * 2);
  canvas.height = Math.ceil(lines.length * PLAQUE_LINE_HEIGHT + PLAQUE_PAD_Y * 2);
  // Размер холста сбрасывает контекст — шрифт задаётся снова.
  ctx.font = PLAQUE_FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  roundedRect(ctx, 0.5, 0.5, canvas.width - 1, canvas.height - 1, PLAQUE_RADIUS);
  ctx.fillStyle = PLAQUE_BG;
  ctx.fill();
  ctx.strokeStyle = PLAQUE_EDGE;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = PLAQUE_INK;
  const top = (canvas.height - lines.length * PLAQUE_LINE_HEIGHT) / 2;
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, top + (index + 0.5) * PLAQUE_LINE_HEIGHT);
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return {
    texture,
    width: canvas.width * PLAQUE_METERS_PER_PX,
    height: canvas.height * PLAQUE_METERS_PER_PX,
  };
}

export function createMarkers(elevationOf: FloorElevation): MarkersHandle {
  const group = new Group();
  group.name = 'markersGroup';

  // Геометрия конуса одна на обе метки (инвариант 8 правил проекта):
  // различаются они только материалом.
  const cone = pinGeometry();

  const startMaterial = new MeshBasicMaterial({ color: START_COLOR });
  const pickMaterial = new MeshBasicMaterial({ color: PICK_COLOR });

  const startPin = new Mesh(cone, startMaterial);
  startPin.name = 'marker.start.pin';
  startPin.renderOrder = RENDER_ORDER;
  startPin.visible = false;

  const ring = new RingGeometry(RING_INNER, RING_OUTER, 24);
  ring.rotateX(-Math.PI / 2);
  const startRing = new Mesh(ring, startMaterial);
  startRing.name = 'marker.start.ring';
  startRing.renderOrder = RENDER_ORDER;
  startRing.visible = false;

  const pickPin = new Mesh(cone, pickMaterial);
  pickPin.name = 'marker.selected.pin';
  pickPin.renderOrder = RENDER_ORDER;
  pickPin.visible = false;

  /**
   * Контур выбранного помещения: две рамки, светлая изнутри и тёмная снаружи,
   * одним мешем с цветами по вершинам. Буфер выделяется один раз: подмена
   * атрибута оставляла бы прежний VBO в видеопамяти, а выбор меняется
   * на каждый тап.
   */
  const RIM_VERTICES = 48;
  const rimGeometry = new BufferGeometry();
  const rimPositions = new Float32Array(RIM_VERTICES * 3);
  const rimColors = new Float32Array(RIM_VERTICES * 3);
  const rimPositionAttribute = new BufferAttribute(rimPositions, 3);
  rimPositionAttribute.setUsage(DynamicDrawUsage);
  const rimColorAttribute = new BufferAttribute(rimColors, 3);
  rimColorAttribute.setUsage(DynamicDrawUsage);
  rimGeometry.setAttribute('position', rimPositionAttribute);
  rimGeometry.setAttribute('color', rimColorAttribute);
  const rimMaterial = new MeshBasicMaterial({ vertexColors: true, side: DoubleSide });
  const rim = new Mesh(rimGeometry, rimMaterial);
  rim.name = 'marker.selected.rim';
  rim.renderOrder = RENDER_ORDER;
  rim.frustumCulled = false;
  rim.visible = false;

  /**
   * Плашка подписи: один общий квадрат, растянутый под размер надписи. Текстура
   * пересоздаётся при смене выбора, геометрия — никогда (инвариант 8 правил
   * проекта). Глубина не пишется и не проверяется: подпись обязана быть видна
   * поверх плит и стен верхних этажей, ради этого она и появилась.
   */
  const plaqueGeometry = new PlaneGeometry(1, 1);
  const plaqueMaterial = new MeshBasicMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const plaque = new Mesh(plaqueGeometry, plaqueMaterial);
  plaque.name = 'marker.selected.caption';
  plaque.renderOrder = RENDER_ORDER + 1;
  plaque.frustumCulled = false;
  plaque.visible = false;
  let plaqueTexture: CanvasTexture | undefined;
  let plaqueText: string | undefined;
  /** Высота плашки в метрах: от неё считается, куда её поднять над меткой. */
  let plaqueHeight = 0;

  /** Пересобрать текстуру подписи. Тот же текст — ничего не делаем. */
  function setCaption(text: string | undefined): void {
    if (text === plaqueText) return;
    plaqueText = text;
    plaqueTexture?.dispose();
    plaqueTexture = undefined;
    plaqueMaterial.map = null;
    if (!text) {
      plaque.visible = false;
      return;
    }
    const drawn = drawPlaque(text);
    if (!drawn) {
      plaque.visible = false;
      return;
    }
    plaqueTexture = drawn.texture;
    plaqueMaterial.map = drawn.texture;
    plaqueMaterial.needsUpdate = true;
    plaque.scale.set(drawn.width, drawn.height, 1);
    plaqueHeight = drawn.height;
  }

  group.add(startPin, startRing, pickPin, rim, plaque);

  /** Записать прямоугольную рамку в буфер контура, начиная с вершины `at`. */
  function writeRim(
    at: number,
    cx: number,
    cz: number,
    y: number,
    halfX: number,
    halfZ: number,
    thickness: number,
    color: [number, number, number],
  ): number {
    const outerX = halfX;
    const outerZ = halfZ;
    const innerX = Math.max(halfX - thickness, 0.02);
    const innerZ = Math.max(halfZ - thickness, 0.02);
    /** Полоса рамки: прямоугольник между двумя парами границ. */
    const strip = (x0: number, x1: number, z0: number, z1: number): void => {
      const quad = [
        [x0, z0],
        [x1, z0],
        [x1, z1],
        [x0, z0],
        [x1, z1],
        [x0, z1],
      ];
      for (const [x, z] of quad) {
        const base = at * 3;
        rimPositions[base] = cx + (x ?? 0);
        rimPositions[base + 1] = y;
        rimPositions[base + 2] = cz + (z ?? 0);
        rimColors[base] = color[0];
        rimColors[base + 1] = color[1];
        rimColors[base + 2] = color[2];
        at += 1;
      }
    };
    strip(-outerX, outerX, -outerZ, -innerZ);
    strip(-outerX, outerX, innerZ, outerZ);
    strip(-outerX, -innerX, -innerZ, innerZ);
    strip(innerX, outerX, -innerZ, innerZ);
    return at;
  }

  let startSpot: MarkSpot | undefined;
  let pickSpot: MarkSpot | undefined;
  let visibleLevel: number | null = null;
  let clock = 0;

  /** Основание метки: пол этажа плюс подъём выбранной плиты, если она поднята. */
  function baseOf(spot: MarkSpot): number {
    return elevationOf(spot.level) + (spot.raised === true ? SELECT_RAISE : 0);
  }

  function place(): void {
    const shown = (spot: MarkSpot | undefined): boolean =>
      Boolean(spot) && (visibleLevel === null || spot?.level === visibleLevel);

    startPin.visible = shown(startSpot);
    startRing.visible = startPin.visible;
    if (startSpot) {
      const y = baseOf(startSpot);
      startPin.position.set(startSpot.x, y + PIN_CLEARANCE + PIN_HEIGHT / 2, startSpot.z);
      startRing.position.set(startSpot.x, y + LIFT, startSpot.z);
    }

    // Булавка старта и метка выбора в одной точке — это два конуса друг
    // в друге. Показывается булавка: она отвечает на более важный вопрос.
    const together =
      Boolean(startSpot && pickSpot) &&
      Math.abs((startSpot?.x ?? 0) - (pickSpot?.x ?? 0)) < 0.2 &&
      Math.abs((startSpot?.z ?? 0) - (pickSpot?.z ?? 0)) < 0.2 &&
      startSpot?.level === pickSpot?.level;
    pickPin.visible = shown(pickSpot) && !(together && startPin.visible);
    if (pickSpot) {
      const y = baseOf(pickSpot);
      pickPin.position.set(pickSpot.x, y + PIN_CLEARANCE + PIN_HEIGHT / 2, pickSpot.z);
    }

    // Подпись живёт при метке выбора: видна метка — видна подпись. Когда метка
    // спрятана под булавкой старта, подпись остаётся: человек всё равно должен
    // прочитать, что за место он открыл.
    setCaption(pickSpot?.caption);
    plaque.visible = shown(pickSpot) && Boolean(plaqueTexture);
    if (pickSpot && plaque.visible) {
      plaque.position.set(
        pickSpot.x,
        baseOf(pickSpot) + PIN_CLEARANCE + PIN_HEIGHT + PLAQUE_GAP + plaqueHeight / 2,
        pickSpot.z,
      );
    }

    const hasPlate = Boolean(pickSpot?.width && pickSpot.depth);
    rim.visible = shown(pickSpot) && hasPlate;
    if (pickSpot && hasPlate) {
      const y = baseOf(pickSpot) + LIFT;
      const halfX = (pickSpot.width ?? 0) / 2;
      const halfZ = (pickSpot.depth ?? 0) / 2;
      // Светлая полоса идёт по самому краю плиты, тёмная — сразу за ней:
      // какая из двух видна, решает ступень серого под контуром.
      let written = writeRim(0, pickSpot.x, pickSpot.z, y, halfX, halfZ, RIM_WIDTH, rgb(RIM_LIGHT));
      written = writeRim(
        written,
        pickSpot.x,
        pickSpot.z,
        y,
        halfX + RIM_WIDTH,
        halfZ + RIM_WIDTH,
        RIM_WIDTH,
        rgb(RIM_DARK),
      );
      rimGeometry.setDrawRange(0, written);
      rimPositionAttribute.needsUpdate = true;
      rimColorAttribute.needsUpdate = true;
    }
  }

  return {
    group,
    setStart(spot): void {
      startSpot = spot;
      place();
    },
    setSelected(spot): void {
      pickSpot = spot;
      place();
    },
    setVisibleLevel(level): void {
      if (visibleLevel === level) return;
      visibleLevel = level;
      place();
    },
    update(dt: number, camera: Camera): void {
      if (!startPin.visible && !pickPin.visible && !plaque.visible) return;
      clock = (clock + dt) % BOB_PERIOD;
      const bob = Math.sin((clock / BOB_PERIOD) * Math.PI * 2) * BOB;
      if (startSpot && startPin.visible) {
        startPin.position.y = baseOf(startSpot) + PIN_CLEARANCE + PIN_HEIGHT / 2 + bob;
      }
      if (pickSpot && pickPin.visible) {
        pickPin.position.y = baseOf(pickSpot) + PIN_CLEARANCE + PIN_HEIGHT / 2 + bob;
      }
      if (pickSpot && plaque.visible) {
        // Разворот к камере кватернионом самой камеры: подпись читается
        // с любого ракурса и сохраняет размер в метрах.
        plaque.quaternion.copy(camera.quaternion);
        plaque.position.y =
          baseOf(pickSpot) + PIN_CLEARANCE + PIN_HEIGHT + PLAQUE_GAP + plaqueHeight / 2 + bob;
      }
    },
    dispose(): void {
      startPin.removeFromParent();
      startRing.removeFromParent();
      pickPin.removeFromParent();
      rim.removeFromParent();
      plaque.removeFromParent();
      plaqueGeometry.dispose();
      plaqueMaterial.dispose();
      plaqueTexture?.dispose();
      cone.dispose();
      ring.dispose();
      rimGeometry.dispose();
      startMaterial.dispose();
      pickMaterial.dispose();
      rimMaterial.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}

/** Цвет из шестнадцатеричного числа в тройку долей: цвета лежат по вершинам. */
function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
