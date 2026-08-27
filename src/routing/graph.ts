/**
 * Граф путей по зданию: помещения ↔ двери ↔ коридоры ↔ лестницы и лифты.
 *
 * Граф строится один раз при сборке здания и ничего не знает ни про сцену,
 * ни про интерфейс: на входе — этажи так, как их отдаёт источник, на выходе —
 * узлы с координатами и рёбра с длиной в метрах. Поиск пути живёт отдельно
 * (`@routing/path`), отрисовка — тоже (`@building/route`).
 *
 * Устройство, и почему именно так:
 *
 *  — коридор в данных задан прямоугольником, а не осевой линией. Осевая
 *    строится по длинной стороне: люди ходят вдоль коридора, а не поперёк,
 *    и путь по осевой отличается от настоящего на полширины коридора —
 *    меньше, чем погрешность самих планов;
 *  — узлы на осевой ставятся не через равные шаги, а там, где к коридору
 *    что-то примыкает: дверь, лестница, другой коридор. Между соседними
 *    узлами кладётся ребро длиной в расстояние между ними. Равномерная сетка
 *    дала бы те же пути и вдесятеро больше узлов;
 *  — коридоры соединяются там, где пересекаются их прямоугольники: точка
 *    стыка — середина пересечения. Без этого этаж распадается на несвязные
 *    куски, и путь из южного крыла в северное не находится вовсе;
 *  — дверь — отдельный узел, потому что войти в помещение можно только через
 *    неё. Путь «помещение → дверь → коридор» и есть причина, по которой
 *    маршрут огибает стены, а не идёт напрямую сквозь них;
 *  — этажи связаны лестницами и лифтами по полю `connects`. Стоимость подъёма
 *    задана в метрах пути, чтобы её можно было складывать с горизонтальными
 *    рёбрами: она выведена из высоты этажа и разная у лестницы и лифта.
 */
import type { Bounds, FloorView, RoomView, VerticalView } from '@building/source';

/** Во сколько раз этаж по лестнице «длиннее» своей высоты. */
const STAIR_FACTOR = 2.6;
/**
 * То же для лифта. Больше, чем у лестницы, намеренно: в стоимость входит
 * ожидание кабины. Человеку, которому лифт не нужен, лестница ближе.
 */
const LIFT_FACTOR = 3.4;
/** Зазор, в пределах которого прямоугольники коридоров считаются стыкующимися. */
const JOIN_GAP = 0.6;

export type NodeKind = 'room' | 'door' | 'corridor' | 'vertical';

export interface GraphNode {
  kind: NodeKind;
  /** Этаж, на котором лежит узел. */
  level: number;
  x: number;
  z: number;
  /** Идентификатор помещения, двери, коридора или связи — смотря по виду. */
  ownerId: string;
  /** Человекочитаемое имя владельца: из него собираются шаги маршрута. */
  ownerName: string;
}

export interface GraphEdge {
  to: number;
  cost: number;
}

export interface RouteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[][];
  /** Узел помещения по его идентификатору. */
  roomNode: (id: string) => number | undefined;
  /** Узел лестницы или лифта на конкретном этаже. */
  verticalNode: (id: string, level: number) => number | undefined;
  /** Все узлы связей: по ним интерфейс предлагает «ближайшую лестницу». */
  verticalIds: () => string[];
}

interface Point {
  x: number;
  z: number;
}

interface Segment {
  a: Point;
  b: Point;
}

function centerOf(bounds: Bounds): Point {
  return { x: (bounds.x0 + bounds.x1) / 2, z: (bounds.z0 + bounds.z1) / 2 };
}

/** Осевая линия коридора: вдоль длинной стороны прямоугольника. */
function centerline(bounds: Bounds): Segment {
  const width = bounds.x1 - bounds.x0;
  const depth = bounds.z1 - bounds.z0;
  const center = centerOf(bounds);
  return width >= depth
    ? { a: { x: bounds.x0, z: center.z }, b: { x: bounds.x1, z: center.z } }
    : { a: { x: center.x, z: bounds.z0 }, b: { x: center.x, z: bounds.z1 } };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Ближайшая точка отрезка и её положение вдоль него в долях длины. */
function project(point: Point, segment: Segment): { point: Point; t: number } {
  const dx = segment.b.x - segment.a.x;
  const dz = segment.b.z - segment.a.z;
  const lengthSq = dx * dx + dz * dz;
  if (lengthSq < 1e-9) return { point: { ...segment.a }, t: 0 };
  const raw = ((point.x - segment.a.x) * dx + (point.z - segment.a.z) * dz) / lengthSq;
  const t = Math.min(1, Math.max(0, raw));
  return { point: { x: segment.a.x + dx * t, z: segment.a.z + dz * t }, t };
}

/** Пересечение прямоугольников с допуском: `undefined`, если они не стыкуются. */
function overlap(one: Bounds, two: Bounds): Bounds | undefined {
  const x0 = Math.max(one.x0, two.x0) - JOIN_GAP;
  const x1 = Math.min(one.x1, two.x1) + JOIN_GAP;
  const z0 = Math.max(one.z0, two.z0) - JOIN_GAP;
  const z1 = Math.min(one.z1, two.z1) + JOIN_GAP;
  if (x1 < x0 || z1 < z0) return undefined;
  return { x0, x1, z0, z1 };
}

/** Коридор в сборке: осевая линия и узлы на ней, ещё не связанные рёбрами. */
interface CorridorLine {
  id: string;
  name: string;
  level: number;
  segment: Segment;
  /** Узлы на осевой: индекс узла и его положение вдоль линии. */
  marks: { index: number; t: number }[];
}

export function buildRouteGraph(floors: readonly FloorView[]): RouteGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[][] = [];
  const roomIndex = new Map<string, number>();
  const verticalIndex = new Map<string, number>();
  /** Связь и этажи, на которых она встретилась: по ним и сшиваются этажи. */
  const verticalSeen = new Map<string, { kind: VerticalView['kind']; levels: number[] }>();

  function addNode(node: GraphNode): number {
    nodes.push(node);
    edges.push([]);
    return nodes.length - 1;
  }

  function link(from: number, to: number, cost: number): void {
    if (from === to) return;
    const value = Math.max(cost, 0.01);
    edges[from]?.push({ to, cost: value });
    edges[to]?.push({ to: from, cost: value });
  }

  const lines: CorridorLine[] = [];

  for (const floor of floors) {
    if (!floor.layoutKnown) continue;

    const floorLines: CorridorLine[] = [];
    for (const corridor of floor.corridors) {
      floorLines.push({
        id: corridor.id,
        name: corridor.name ?? 'коридор',
        level: floor.level,
        segment: centerline(corridor.bounds),
        marks: [],
      });
    }
    lines.push(...floorLines);
    if (floorLines.length === 0) continue;

    /** Поставить узел на ближайшую осевую и вернуть его индекс. */
    const attach = (point: Point): number | undefined => {
      let best: { line: CorridorLine; point: Point; t: number; gap: number } | undefined;
      for (const line of floorLines) {
        const hit = project(point, line.segment);
        const gap = distance(point, hit.point);
        if (!best || gap < best.gap) best = { line, point: hit.point, t: hit.t, gap };
      }
      if (!best) return undefined;
      const index = addNode({
        kind: 'corridor',
        level: floor.level,
        x: best.point.x,
        z: best.point.z,
        ownerId: best.line.id,
        ownerName: best.line.name,
      });
      best.line.marks.push({ index, t: best.t });
      return index;
    };

    // Стыки коридоров: точка стыка попадает на обе осевые и связывается сама
    // с собой через ребро нулевой длины — иначе крылья этажа не соединены.
    for (let i = 0; i < floor.corridors.length; i += 1) {
      for (let j = i + 1; j < floor.corridors.length; j += 1) {
        const one = floor.corridors[i];
        const two = floor.corridors[j];
        if (!one || !two) continue;
        const shared = overlap(one.bounds, two.bounds);
        if (!shared) continue;
        const joint = centerOf(shared);
        const lineOne = floorLines[i];
        const lineTwo = floorLines[j];
        if (!lineOne || !lineTwo) continue;
        const hitOne = project(joint, lineOne.segment);
        const hitTwo = project(joint, lineTwo.segment);
        const nodeOne = addNode({
          kind: 'corridor',
          level: floor.level,
          x: hitOne.point.x,
          z: hitOne.point.z,
          ownerId: lineOne.id,
          ownerName: lineOne.name,
        });
        lineOne.marks.push({ index: nodeOne, t: hitOne.t });
        const nodeTwo = addNode({
          kind: 'corridor',
          level: floor.level,
          x: hitTwo.point.x,
          z: hitTwo.point.z,
          ownerId: lineTwo.id,
          ownerName: lineTwo.name,
        });
        lineTwo.marks.push({ index: nodeTwo, t: hitTwo.t });
        link(nodeOne, nodeTwo, distance(hitOne.point, hitTwo.point));
      }
    }

    for (const room of floor.rooms) {
      const roomNodeIndex = addNode({
        kind: 'room',
        level: floor.level,
        x: room.plate.center.x,
        z: room.plate.center.z,
        ownerId: room.id,
        ownerName: room.name,
      });
      roomIndex.set(room.id, roomNodeIndex);
      for (const door of doorsOf(room)) {
        const doorNodeIndex = addNode({
          kind: 'door',
          level: floor.level,
          x: door.x,
          z: door.z,
          ownerId: door.id,
          ownerName: room.name,
        });
        link(roomNodeIndex, doorNodeIndex, distance(room.plate.center, door));
        const corridorNodeIndex = attach(door);
        if (corridorNodeIndex !== undefined) {
          const target = nodes[corridorNodeIndex];
          if (target) link(doorNodeIndex, corridorNodeIndex, distance(door, target));
        }
      }
    }

    for (const linkView of floor.vertical) {
      const point = centerOf(linkView.bounds);
      const nodeIndex = addNode({
        kind: 'vertical',
        level: floor.level,
        x: point.x,
        z: point.z,
        ownerId: linkView.id,
        ownerName: linkView.name,
      });
      verticalIndex.set(`${linkView.id}@${floor.level}`, nodeIndex);
      const seen = verticalSeen.get(linkView.id);
      if (seen) seen.levels.push(floor.level);
      else verticalSeen.set(linkView.id, { kind: linkView.kind, levels: [floor.level] });
      const corridorNodeIndex = attach(point);
      if (corridorNodeIndex !== undefined) {
        const target = nodes[corridorNodeIndex];
        if (target) link(nodeIndex, corridorNodeIndex, distance(point, target));
      }
    }
  }

  // Осевые связываются в цепочки только сейчас, когда на них расставлены все
  // узлы: соседние по положению вдоль линии соединяются ребром.
  for (const line of lines) {
    line.marks.sort((one, two) => one.t - two.t);
    for (let i = 1; i < line.marks.length; i += 1) {
      const previous = line.marks[i - 1];
      const current = line.marks[i];
      if (!previous || !current) continue;
      const a = nodes[previous.index];
      const b = nodes[current.index];
      if (a && b) link(previous.index, current.index, distance(a, b));
    }
  }

  // Межэтажные рёбра: одна и та же связь на соседних своих этажах.
  const heights = new Map<number, number>();
  for (const floor of floors) heights.set(floor.level, floor.height);
  for (const [id, view] of verticalSeen) {
    // Сшиваются только те этажи, на которых связь действительно встретилась.
    // В данных лестница объявлена «на этажи 1–5», но у этажей без планировки
    // нет ни коридоров, ни дверей: маршрут туда всё равно не построить,
    // и выдуманное ребро только увело бы путь в пустоту.
    const levels = [...view.levels].sort((one, two) => one - two);
    for (let i = 1; i < levels.length; i += 1) {
      const lower = levels[i - 1];
      const upper = levels[i];
      if (lower === undefined || upper === undefined) continue;
      const from = verticalIndex.get(`${id}@${lower}`);
      const to = verticalIndex.get(`${id}@${upper}`);
      if (from === undefined || to === undefined) continue;
      const rise = heights.get(upper) ?? heights.get(lower) ?? 3.6;
      const factor = view.kind === 'lift' ? LIFT_FACTOR : STAIR_FACTOR;
      link(from, to, rise * factor * (upper - lower));
    }
  }

  return {
    nodes,
    edges,
    roomNode: (id) => roomIndex.get(id),
    verticalNode: (id, level) => verticalIndex.get(`${id}@${level}`),
    verticalIds: () => [...verticalSeen.keys()],
  };
}

/**
 * Двери помещения. Источник отдаёт их не всегда: у здания без планировки
 * их нет вовсе, и тогда помещение остаётся в графе изолированным узлом —
 * это честнее, чем выдумывать вход.
 */
function doorsOf(room: RoomView): { id: string; x: number; z: number }[] {
  return room.doors ?? [];
}
