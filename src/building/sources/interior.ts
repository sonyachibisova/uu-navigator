/**
 * Интерьер этажа из данных: плита перекрытия, коридорные полосы, помещения,
 * двери и вертикальные связи.
 *
 * Модуль — интерпретатор данных, а не описание конкретной планировки: он не
 * знает ни номеров помещений, ни их назначения, и работает с любым этажом,
 * который прошёл схему `data/schema.ts`.
 */
import type { Bounds, Floor, Room, VerticalLink } from '@data/schema';
import type {
  CorridorView,
  FloorView,
  LabelSpec,
  Part,
  RoomView,
  SurfaceKey,
  Vec3,
  VerticalView,
} from '@building/source';
import { levelTag } from '@building/sources/envelope';

/** Пропорции интерьера, снятые с прототипа. Это размеры человека, не здания. */
const INTERIOR = {
  /** Высота перегородки = высота этажа минус перекрытие. */
  wallDrop: 0.45,
  wallThickness: 0.12,
  /** Толщина плиты перекрытия и её вылет внутрь габарита. */
  slabThickness: 0.25,
  slabInset: 1,
  /** Подъём центра плиты над отметкой этажа. */
  slabRise: 0.12,
  /** Отступ помещения от осевой линии: перегородка стоит по оси. */
  roomInset: 0.04,
  /** Уровень чистого пола над плитой. */
  floorLevel: 0.2,
  plateThickness: 0.06,
  corridorThickness: 0.05,
  doorHeight: 2.1,
  doorThickness: 0.26,
  /** Высота подписи над полом. */
  labelHeight: 2.5,
  /** Ступень и число подъёмов в марше двухмаршевой лестницы. */
  tread: 0.3,
  straightSteps: 8,
} as const;

interface FloorFrame {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  cx: number;
  cz: number;
  width: number;
  depth: number;
  /** Отметка верха плиты перекрытия (низ этажа). */
  base: number;
  floorHeight: number;
  wallHeight: number;
}

/**
 * Элемент интерьера. Тень по умолчанию снята: солнце снаружи кладёт длинные
 * тени перегородок поперёк плит этажа и портит именно то, ради чего этаж
 * открывают. Тень оставлена только несущему — плите перекрытия.
 */
function box(
  name: string,
  surface: SurfaceKey,
  width: number,
  height: number,
  depth: number,
  center: Vec3,
  shadow = false,
): Part {
  return { name, surface, shape: { kind: 'box', width, height, depth }, center, shadow };
}

/** Двузначный номер для точечных имён: `wall.north.02`. */
function pad(index: number): string {
  return String(index).padStart(2, '0');
}

function centerOf(bounds: Bounds): { x: number; z: number } {
  return { x: (bounds.x0 + bounds.x1) / 2, z: (bounds.z0 + bounds.z1) / 2 };
}

/** Полоса перегородки вдоль X: пропускаем вырожденные куски. */
function wallAlongX(
  frame: FloorFrame,
  name: string,
  xa: number,
  xb: number,
  z: number,
  parts: Part[],
): void {
  const width = xb - xa;
  if (width < 0.02) return;
  parts.push(
    box(name, 'partition', width, frame.wallHeight, INTERIOR.wallThickness, {
      x: (xa + xb) / 2,
      y: frame.base + INTERIOR.floorLevel + frame.wallHeight / 2,
      z,
    }),
  );
}

/** Полоса перегородки вдоль Z. */
function wallAlongZ(
  frame: FloorFrame,
  name: string,
  za: number,
  zb: number,
  x: number,
  parts: Part[],
): void {
  const depth = zb - za;
  if (depth < 0.02) return;
  parts.push(
    box(name, 'partition', INTERIOR.wallThickness, frame.wallHeight, depth, {
      x,
      y: frame.base + INTERIOR.floorLevel + frame.wallHeight / 2,
      z: (za + zb) / 2,
    }),
  );
}

function roomParts(frame: FloorFrame, room: Room, prefix: string): Part[] {
  const parts: Part[] = [];
  const inset = INTERIOR.roomInset;
  const x0 = room.bounds.x0 + inset;
  const x1 = room.bounds.x1 - inset;
  const z0 = room.bounds.z0 + inset;
  const z1 = room.bounds.z1 - inset;
  const doorY = frame.base + INTERIOR.floorLevel + INTERIOR.doorHeight / 2;

  // Дверей на одной стороне может быть несколько: схема это разрешает, и
  // перегородка режется на N+1 кусок. Карта «сторона → одна дверь» теряла все,
  // кроме последней, и оставляла проёмы заложенными.
  const doorsBySide = new Map<string, (typeof room.doors)[number][]>();
  for (const door of room.doors) {
    const list = doorsBySide.get(door.side);
    if (list) list.push(door);
    else doorsBySide.set(door.side, [door]);
  }
  /** Имя куска перегородки: без дверей — цельная стена, иначе кусок с номером. */
  const segment = (side: string, index: number, total: number): string =>
    total === 0 ? `${prefix}.wall.${side}` : `${prefix}.wall.${side}.${pad(index)}`;

  for (const side of ['north', 'south'] as const) {
    const z = side === 'north' ? z0 : z1;
    const doors = [...(doorsBySide.get(side) ?? [])].sort((a, b) => a.x - b.x);
    let cursor = x0;
    doors.forEach((door, index) => {
      const half = door.width / 2;
      wallAlongX(
        frame,
        segment(side, index + 1, doors.length),
        cursor,
        Math.max(cursor, door.x - half),
        z,
        parts,
      );
      cursor = Math.min(x1, Math.max(cursor, door.x + half));
      parts.push(
        box(
          `${prefix}.door.${door.id}`,
          'door',
          door.width - 0.06,
          INTERIOR.doorHeight,
          INTERIOR.doorThickness,
          { x: door.x, y: doorY, z },
        ),
      );
    });
    wallAlongX(frame, segment(side, doors.length + 1, doors.length), cursor, x1, z, parts);
  }

  for (const side of ['west', 'east'] as const) {
    const x = side === 'west' ? x0 : x1;
    const doors = [...(doorsBySide.get(side) ?? [])].sort((a, b) => a.z - b.z);
    let cursor = z0;
    doors.forEach((door, index) => {
      const half = door.width / 2;
      wallAlongZ(
        frame,
        segment(side, index + 1, doors.length),
        cursor,
        Math.max(cursor, door.z - half),
        x,
        parts,
      );
      cursor = Math.min(z1, Math.max(cursor, door.z + half));
      parts.push(
        box(
          `${prefix}.door.${door.id}`,
          'door',
          INTERIOR.doorThickness,
          INTERIOR.doorHeight,
          door.width - 0.06,
          { x, y: doorY, z: door.z },
        ),
      );
    });
    wallAlongZ(frame, segment(side, doors.length + 1, doors.length), cursor, z1, x, parts);
  }

  return parts;
}

function roomView(frame: FloorFrame, room: Room, tag: string): RoomView {
  const prefix = `floor.${tag}.room.${room.id}`;
  const inset = INTERIOR.roomInset;
  const width = room.bounds.x1 - room.bounds.x0 - inset * 2;
  const depth = room.bounds.z1 - room.bounds.z0 - inset * 2;
  const center = centerOf(room.bounds);
  const plateY = frame.base + INTERIOR.floorLevel + INTERIOR.plateThickness + 0.02;
  const label: LabelSpec | null =
    room.planNumber || room.name
      ? {
          name: `${prefix}.label`,
          title: room.planNumber ?? '',
          subtitle: room.name,
          position: { x: center.x, y: frame.base + INTERIOR.labelHeight, z: center.z },
        }
      : null;

  const view: RoomView = {
    id: room.id,
    name: room.name,
    planNumber: room.planNumber,
    type: room.type,
    floor: room.floor,
    bounds: room.bounds,
    focus: { x: center.x, y: plateY, z: center.z },
    doors: room.doors.map((door) => ({
      id: door.id,
      side: door.side,
      x: door.x,
      z: door.z,
      width: door.width,
    })),
    plate: { center: { x: center.x, y: plateY, z: center.z }, width, depth },
    parts: roomParts(frame, room, prefix),
    label,
  };
  if (room.area !== undefined) view.area = room.area;
  if (room.seats !== undefined) view.seats = room.seats;
  if (room.description !== undefined) view.description = room.description;
  return view;
}

/** Двухмаршевая лестница: колодец глубже, чем шире. */
function switchbackStairs(frame: FloorFrame, link: VerticalLink, prefix: string): Part[] {
  const parts: Part[] = [];
  const { x0, x1, z0, z1 } = link.bounds;
  const width = x1 - x0;
  const depth = z1 - z0;
  const half = width / 2;
  const steps = Math.max(2, Math.round((depth / 2 - INTERIOR.tread) / INTERIOR.tread));
  const run = steps * INTERIOR.tread;
  const margin = Math.max(0, (depth - 2 * run) / 2);
  const rise = frame.floorHeight / (2 * steps);
  const startZ = z1 - margin;

  for (let i = 1; i <= steps; i += 1) {
    const height = i * rise;
    // Восходящий марш: половина ширины у восточного края, идёт на север.
    parts.push(
      box(`${prefix}.flight.up.${i}`, 'stair', half, height, INTERIOR.tread, {
        x: x0 + half * 1.5,
        y: frame.base + height / 2,
        z: startZ - (i - 0.5) * INTERIOR.tread,
      }),
    );
    // Нисходящий марш на этаж ниже: вторая половина ширины, идёт на юг.
    parts.push(
      box(`${prefix}.flight.down.${i}`, 'stair', half, height, INTERIOR.tread, {
        x: x0 + half * 0.5,
        y: frame.base - height / 2,
        z: startZ - run + (i - 0.5) * INTERIOR.tread,
      }),
    );
  }
  parts.push(
    box(`${prefix}.landing`, 'stair', width, 0.18, 0.9, {
      x: (x0 + x1) / 2,
      y: frame.base + frame.floorHeight / 2,
      z: startZ - run - 0.45,
    }),
  );
  wallAlongZ(frame, `${prefix}.wall.west`, z0, z1, x0, parts);
  wallAlongZ(frame, `${prefix}.wall.east`, z0, z1, x1, parts);
  wallAlongX(frame, `${prefix}.wall.south`, x0, x1, z1, parts);
  return parts;
}

/** Одномаршевая лестница: марш идёт поперёк, колодец шире, чем глубже. */
function straightStairs(frame: FloorFrame, link: VerticalLink, prefix: string): Part[] {
  const parts: Part[] = [];
  const { x0, x1, z0, z1 } = link.bounds;
  const steps = INTERIOR.straightSteps;
  const step = (x1 - x0) / steps;
  const depth = z1 - z0;
  const center = centerOf(link.bounds);
  for (let i = 1; i <= steps; i += 1) {
    const height = (i * frame.floorHeight) / (2 * steps);
    parts.push(
      box(`${prefix}.step.${i}`, 'stair', step, height, depth, {
        x: x0 + (i - 0.5) * step,
        y: frame.base + INTERIOR.floorLevel + height / 2,
        z: center.z,
      }),
    );
  }
  return parts;
}

function liftParts(frame: FloorFrame, link: VerticalLink, prefix: string): Part[] {
  const parts: Part[] = [];
  const { x0, x1, z0, z1 } = link.bounds;
  const center = centerOf(link.bounds);
  wallAlongZ(frame, `${prefix}.wall.west`, z0, z1, x0, parts);
  wallAlongZ(frame, `${prefix}.wall.east`, z0, z1, x1, parts);
  // Глухая стенка с той стороны, что смотрит наружу здания; проём — в сторону коридора.
  const outerNorth = center.z < frame.cz;
  const backZ = outerNorth ? z0 + 0.05 : z1 - 0.05;
  wallAlongX(frame, `${prefix}.wall.back`, x0, x1, backZ, parts);
  const cabinHeight = frame.wallHeight - 0.3;
  parts.push(
    box(`${prefix}.cabin`, 'lift', x1 - x0 - 0.25, cabinHeight, z1 - z0 - 0.25, {
      x: center.x,
      y: frame.base + INTERIOR.floorLevel + cabinHeight / 2,
      z: center.z,
    }),
  );
  return parts;
}

function verticalView(frame: FloorFrame, link: VerticalLink, tag: string): VerticalView {
  const prefix = `floor.${tag}.vertical.${link.id}`;
  const center = centerOf(link.bounds);
  const width = link.bounds.x1 - link.bounds.x0;
  const depth = link.bounds.z1 - link.bounds.z0;
  let parts: Part[];
  if (link.kind === 'lift') parts = liftParts(frame, link, prefix);
  else if (depth > width) parts = switchbackStairs(frame, link, prefix);
  else parts = straightStairs(frame, link, prefix);

  // Пандус движок пока показывает как марш: отдельной формы у него нет, а в
  // легенде интерфейса два вида связи. Данные вид сохраняют, геометрия догонит.
  const kind: VerticalView['kind'] = link.kind === 'lift' ? 'lift' : 'stairs';

  return {
    id: link.id,
    kind,
    name: link.name,
    bounds: link.bounds,
    accessible: link.accessible,
    parts,
    label: {
      name: `${prefix}.label`,
      title: '',
      subtitle: link.name,
      position: { x: center.x, y: frame.base + INTERIOR.labelHeight, z: center.z },
    },
  };
}

/**
 * Постоянные элементы этажа. Сейчас это только плита перекрытия.
 *
 * Несущих опор здесь нет намеренно: их положение снимается с чертежа и
 * приходит готовой геометрией вместе с моделью здания. Параметрическая сетка,
 * подобранная по пропорциям, часть опор ставит в стены, а часть — посреди
 * помещений, то есть показывает человеку то, чего в здании нет.
 */
function structureParts(frame: FloorFrame, tag: string): Part[] {
  return [
    box(
      `floor.${tag}.slab`,
      'slab',
      frame.width - INTERIOR.slabInset,
      INTERIOR.slabThickness,
      frame.depth - INTERIOR.slabInset,
      { x: frame.cx, y: frame.base + INTERIOR.slabRise, z: frame.cz },
      true,
    ),
  ];
}

function corridorView(
  frame: FloorFrame,
  corridor: Floor['corridors'][number],
  tag: string,
): CorridorView {
  const center = centerOf(corridor.bounds);
  return {
    id: corridor.id,
    name: corridor.name ?? null,
    bounds: corridor.bounds,
    part: box(
      `floor.${tag}.corridor.${corridor.id}`,
      'corridor',
      corridor.bounds.x1 - corridor.bounds.x0,
      INTERIOR.corridorThickness,
      corridor.bounds.z1 - corridor.bounds.z0,
      {
        x: center.x,
        y: frame.base + INTERIOR.floorLevel + INTERIOR.corridorThickness + 0.01,
        z: center.z,
      },
    ),
  };
}

/** Собрать этаж целиком. Для этажа с неизвестной планировкой вернётся пустой набор. */
export function buildFloorView(floor: Floor, footprint: Bounds, floorHeight: number): FloorView {
  const tag = levelTag(floor.level);
  const frame: FloorFrame = {
    x0: footprint.x0,
    x1: footprint.x1,
    z0: footprint.z0,
    z1: footprint.z1,
    cx: (footprint.x0 + footprint.x1) / 2,
    cz: (footprint.z0 + footprint.z1) / 2,
    width: footprint.x1 - footprint.x0,
    depth: footprint.z1 - footprint.z0,
    base: floor.elevation,
    floorHeight,
    wallHeight: floorHeight - INTERIOR.wallDrop,
  };

  if (!floor.layoutKnown) {
    return {
      level: floor.level,
      name: floor.name,
      elevation: floor.elevation,
      height: floor.height,
      layoutKnown: false,
      parts: [],
      rooms: [],
      corridors: [],
      vertical: [],
    };
  }

  return {
    level: floor.level,
    name: floor.name,
    elevation: floor.elevation,
    height: floor.height,
    layoutKnown: true,
    parts: structureParts(frame, tag),
    rooms: floor.rooms.map((room) => roomView(frame, room, tag)),
    corridors: floor.corridors.map((corridor) => corridorView(frame, corridor, tag)),
    vertical: floor.vertical.map((link) => verticalView(frame, link, tag)),
  };
}
