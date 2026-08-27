/**
 * `BuildingSource` — контракт между данными здания и движком.
 *
 * Движок не знает, откуда взялась структура: из `data/*.json` (`ProceduralSource`)
 * или из разобранного `.glb` (`GltfSource`, появится позже). Он получает уже
 * разобранное здание: паспорт, оболочку по этажам с именованными гранями,
 * кровлю и этажи с помещениями, дверьми, коридорами и вертикальными связями.
 *
 * Здесь нет ни одного слова про конкретное здание и ни одного числа из чертежа:
 * всё, что специфично, приходит реализацией источника.
 *
 * Имена — точечная нотация правил проекта:
 *   `shell.floor.04.wall.north`, `roof.slab`, `roof.struct.01`,
 *   `floor.04.room.f04-lab-03.wall.north`, `floor.04.room.f04-lab-03.door.01`.
 */
import type { Bounds, Envelope, RoomPurpose, Side } from '@data/schema';

export type { Bounds, Envelope, RoomPurpose, Side };

/** Точка в системе сцены: метры, ось Y вверх. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Ключ поверхности. Это не цвет и не материал, а роль поверхности в здании:
 * конкретную палитру подбирает `src/building/materials.ts`.
 */
export type SurfaceKey =
  // наружные
  | 'brick'
  | 'panel'
  | 'plaster'
  | 'glassTinted'
  | 'glassDark'
  | 'glassClear'
  | 'accent'
  | 'trim'
  // внутренние
  | 'slab'
  | 'partition'
  | 'door'
  | 'corridor'
  | 'lift'
  | 'stair';

/** Примитив, которым описан элемент здания. */
export type PartShape =
  /** Прямоугольный объём; строится из общей unit-`BoxGeometry` масштабированием. */
  | { kind: 'box'; width: number; height: number; depth: number }
  /** Диск (цилиндр вдоль оси Z): иллюминаторы, круглые проёмы. */
  | { kind: 'disc'; radius: number; thickness: number };

/** Элемент здания: форма + положение + роль поверхности + имя. */
export interface Part {
  /** Полное точечное имя, например `facade.floor.02.south.window.05.glass`. */
  name: string;
  shape: PartShape;
  center: Vec3;
  surface: SurfaceKey;
  /** По умолчанию элемент отбрасывает и принимает тень. */
  shadow?: boolean;
}

/** Плоская надпись на фасаде: рендерится текстурой на плоскости. */
export interface SignPart {
  name: string;
  /**
   * Грань, на которой висит вывеска. Обязательное поле: плоскость надо
   * развернуть наружу этой грани, а движок не вправе догадываться о стороне
   * по форме здания — на другом корпусе вывеска висит на другой стене.
   * По этой же стороне вывеска попадает в канал растворения своей грани.
   */
  side: Side;
  center: Vec3;
  width: number;
  height: number;
  text: string;
  /** Цвет текста и относительный кегль — подбираются источником, не движком. */
  color: string;
  /** Доля высоты плоскости, которую занимает строка. */
  fill: number;
}

/** Именованная грань: `wall.north` и всё, что на ней висит. */
export interface Face {
  /** Полное имя грани: `shell.floor.03.wall.north`. */
  name: string;
  side: Side;
  parts: Part[];
}

/**
 * Кольцо оболочки — один этаж по высоте. Срез здания по этажу гасит кольца выше
 * выбранного, поэтому оболочка обязана быть разложена по этажам, а не быть
 * единым объёмом.
 */
export interface ShellBand {
  /** Номер этажа, 1-based. */
  level: number;
  /** Имя кольца: `floor.03`. */
  name: string;
  elevation: number;
  height: number;
  /** Несущие грани: `shell.floor.03.wall.north` и т. д. */
  shell: Face[];
  /** Навесное: остекление, вставки, входная группа, вывески. */
  facade: Face[];
  /** Вывески этого кольца (обычно только у первого этажа). */
  signs: SignPart[];
}

/** Кровля: плита, парапет, надстройки. */
export interface RoofView {
  parts: Part[];
}

/** Подпись в интерьере: номер по плану и/или название. */
export interface LabelSpec {
  name: string;
  /** Крупная строка — номер по плану. */
  title: string;
  /** Мелкая строка — название. */
  subtitle: string;
  position: Vec3;
}

/** Дверь помещения так, как её видит движок. */
export interface RoomDoor {
  id: string;
  side: 'north' | 'south' | 'west' | 'east';
  x: number;
  z: number;
  width: number;
}

/** Помещение так, как его видит движок. */
export interface RoomView {
  id: string;
  name: string;
  planNumber: string | null;
  type: RoomPurpose;
  floor: number;
  bounds: Bounds;
  area?: number;
  seats?: number;
  description?: string;
  /** Точка, к которой ведём камеру при выборе помещения. */
  focus: Vec3;
  /** Кликабельная плита пола: одна на помещение. */
  plate: { center: Vec3; width: number; depth: number };
  /**
   * Двери помещения: точка в плане и сторона, с которой дверь стоит.
   * Нужны маршрутам: войти в помещение можно только через дверь, и именно
   * поэтому путь огибает стены, а не идёт сквозь них.
   */
  doors: RoomDoor[];
  /** Стены и дверные полотна помещения — именованные элементы. */
  parts: Part[];
  label: LabelSpec | null;
}

export interface CorridorView {
  id: string;
  name: string | null;
  bounds: Bounds;
  part: Part;
}

export interface VerticalView {
  id: string;
  kind: 'stairs' | 'lift';
  name: string;
  bounds: Bounds;
  accessible: boolean;
  parts: Part[];
  label: LabelSpec | null;
}

/** Этаж целиком. */
export interface FloorView {
  level: number;
  name: string;
  elevation: number;
  height: number;
  /**
   * Известна ли планировка. `false` — помещений нет и выдумывать их нельзя;
   * интерфейс обязан объяснить это состояние, а не показывать пустую плиту.
   */
  layoutKnown: boolean;
  /** Плита, колонны и прочее, что не принадлежит помещению. */
  parts: Part[];
  rooms: RoomView[];
  corridors: CorridorView[];
  vertical: VerticalView[];
}

export interface BuildingPassport {
  id: string;
  name: string;
  shortName: string;
  size: { width: number; depth: number; height: number };
  floorCount: number;
  floorHeight: number;
  footprint: Bounds;
}

/**
 * Источник здания. Все методы синхронные и возвращают уже проверенную структуру:
 * валидация происходит при создании источника, а не при обращении к геометрии.
 */
export interface BuildingSource {
  readonly passport: BuildingPassport;
  /** Оболочка по кольцам этажей. */
  bands(): ShellBand[];
  /** Кровля. */
  roof(): RoofView;
  /** Этажи с интерьерами. */
  floors(): FloorView[];
}

/** Центр здания в плане, на уровне земли. */
export function passportCenter(passport: BuildingPassport): Vec3 {
  const { x0, x1, z0, z1 } = passport.footprint;
  return { x: (x0 + x1) / 2, y: 0, z: (z0 + z1) / 2 };
}

/** Половина наибольшего измерения в плане: опорный масштаб для камеры и света. */
export function passportRadius(passport: BuildingPassport): number {
  const { x0, x1, z0, z1 } = passport.footprint;
  return Math.max(x1 - x0, z1 - z0) / 2;
}
