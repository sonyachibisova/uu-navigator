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
import type { Bounds, EntranceView, FloorView, RoomView, VerticalView } from '@building/source';
import { joined } from '@data/schema';

/** Во сколько раз этаж по лестнице «длиннее» своей высоты. */
const STAIR_FACTOR = 2.6;
/**
 * То же для лифта — сама поездка. Кабина едет быстрее шага, но двери
 * открываются и закрываются, поэтому множитель не меньше единицы.
 */
const LIFT_FACTOR = 1.6;
/**
 * Ожидание кабины, метры пути. Это слагаемое, а не множитель на высоту:
 * кабину ждут одинаково долго и на один этаж, и на три. Тридцать метров —
 * это около двадцати семи секунд шагом, то есть половина полного цикла лифта
 * в пятиэтажном корпусе.
 *
 * Раньше ожидание пытались изобразить множителем 3.4 против 2.6 у лестницы:
 * разница выходила 2.9 м, то есть две с половиной секунды, и приложение
 * отправляло к лифту двоих из трёх — включая тех, кому надо на один этаж.
 * В час пик это очередь, которую собирает навигатор.
 */
const LIFT_WAIT = 30;


export type NodeKind = 'room' | 'door' | 'corridor' | 'vertical' | 'entrance';

/**
 * Ссылка на произвольный узел графа: `graph:12`. Так интерфейс отмечает точку,
 * у которой нет собственного идентификатора в данных, — кусок коридора или
 * лестницу на конкретном этаже. Идентификаторы помещений и связей при этом
 * остаются как были: ссылка нужна там, где имени нет.
 */
const NODE_REF = 'graph:';

/** Собрать ссылку на узел по его индексу. */
export function nodeRef(index: number): string {
  return `${NODE_REF}${index}`;
}

/** Разобрать ссылку на узел; `undefined` — это не ссылка. */
function parseNodeRef(id: string): number | undefined {
  if (!id.startsWith(NODE_REF)) return undefined;
  const index = Number.parseInt(id.slice(NODE_REF.length), 10);
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

export interface GraphNode {
  kind: NodeKind;
  /** Для связей — лестница это или лифт. Шаги маршрута читают отсюда, а не из имени. */
  verticalKind?: 'stairs' | 'lift';
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
  /**
   * Ребро проходимо только по ступеням. Помечены им переходы по лестницам,
   * у которых в данных не подтверждена доступность: человеку на коляске,
   * с коляской или с тяжёлым рулоном такой путь не подходит, и режим
   * «без лестниц» их пропускает.
   */
  stairs?: boolean;
  /**
   * Доступность этой связи школа не подтверждала. Маршрут «без лестниц»
   * такие рёбра проходит — иначе он не построится нигде, — но обязан
   * сказать об этом человеку, а не выдавать за гарантию.
   */
  unconfirmed?: boolean;
  /**
   * Длина ребра посчитана по прямой, потому что планировки этого места нет
   * (вестибюль первого этажа). Указание по такому ребру обязано сказать
   * словами, что расстояние приблизительное, а не называть точную цифру.
   */
  approximate?: boolean;
}

/** Где стоит точка маршрута: как её назвать человеку и куда вести камеру. */
export interface GraphPlace {
  kind: NodeKind;
  name: string;
  level: number;
  x: number;
  z: number;
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
  /**
   * Узел по идентификатору помещения, связи, входа или по ссылке `graph:N`:
   * концом маршрута может быть и лестница, и кусок коридора. Человек в холле
   * не знает номера помещения, из которого выходит, зато видит лестницу,
   * у которой стоит.
   */
  anchorNode: (id: string) => number | undefined;
  /**
   * Ближайший узел, к которому можно привязать произвольную точку плана:
   * коридор, лестница, лифт, вход. Двери и центры помещений пропускаются —
   * по помещению попадают его плитой, а дверь как место человеку не назвать.
   * `limit` — предельное расстояние в метрах: дальше него точка считается
   * промахом, иначе тап по пустому месту выбирал бы что-нибудь на другом
   * конце этажа.
   */
  nearestNode: (level: number, x: number, z: number, limit: number) => number | undefined;
  /** Как назвать точку маршрута и где она лежит. */
  placeOf: (id: string) => GraphPlace | undefined;
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

/** Ближайшая точка прямоугольника: сама точка, если она внутри него. */
function clampToBounds(point: Point, bounds: Bounds): Point {
  return {
    x: Math.min(Math.max(point.x, bounds.x0), bounds.x1),
    z: Math.min(Math.max(point.z, bounds.z0), bounds.z1),
  };
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

/**
 * Место стыка двух коридорных прямоугольников: `undefined`, если стыка нет.
 *
 * Стыком считается общая грань шириной не меньше прохода — тем же правилом
 * `joined()` из `data/schema.ts`, которым проверяются данные. Раньше здесь
 * было своё: оба прямоугольника раздувались на 0.6 м по обеим осям, а ширина
 * общей грани не требовалась вовсе. Простенок в 21 см такая проверка
 * объявляла проходом, и восемь маршрутов шли сквозь стену. Двух правил
 * стыковки в проекте быть не должно.
 */
function overlap(one: Bounds, two: Bounds): Bounds | undefined {
  if (!joined(one, two)) return undefined;
  const x0 = Math.max(one.x0, two.x0);
  const x1 = Math.min(one.x1, two.x1);
  const z0 = Math.max(one.z0, two.z0);
  const z1 = Math.min(one.z1, two.z1);
  // При стыке впритык грань вырождается в линию, а при допустимом зазоре
  // границы меняются местами: середина зазора и есть точка перехода.
  return {
    x0: Math.min(x0, x1),
    x1: Math.max(x0, x1),
    z0: Math.min(z0, z1),
    z1: Math.max(z0, z1),
  };
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

/** Что ещё пришивается к графу, кроме этажей. */
export interface RouteGraphOptions {
  /**
   * Вход в здание. Планировки вестибюля нет ни у одного здания на старте,
   * поэтому вход пришивается к ближайшей лестнице и ближайшему лифту своего
   * этажа по прямой, а рёбра помечаются приблизительными.
   */
  entrance?: EntranceView;
}

export function buildRouteGraph(
  floors: readonly FloorView[],
  options: RouteGraphOptions = {},
): RouteGraph {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[][] = [];
  const roomIndex = new Map<string, number>();
  const verticalIndex = new Map<string, number>();
  /** Связь и этажи, на которых она встретилась: по ним и сшиваются этажи. */
  const verticalSeen = new Map<
    string,
    { kind: VerticalView['kind']; accessible: boolean; confirmed: boolean; levels: number[] }
  >();

  function addNode(node: GraphNode): number {
    nodes.push(node);
    edges.push([]);
    return nodes.length - 1;
  }

  function link(
    from: number,
    to: number,
    cost: number,
    stairs = false,
    unconfirmed = false,
    approximate = false,
  ): void {
    if (from === to) return;
    const value = Math.max(cost, 0.01);
    const edge: Omit<GraphEdge, 'to'> = { cost: value };
    if (stairs) edge.stairs = true;
    if (unconfirmed) edge.unconfirmed = true;
    if (approximate) edge.approximate = true;
    edges[from]?.push({ ...edge, to });
    edges[to]?.push({ ...edge, to: from });
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

    /**
     * Привязать точку к коридорной сети. Возвращает узел, к которому её
     * можно присоединить.
     *
     * Привязка идёт не к осевой линии напрямую, а к ближайшей точке самого
     * прямоугольника коридора, и уже она — к осевой. Прямая привязка давала
     * отрезки до одиннадцати метров наискось через соседние помещения:
     * дверь у дальнего края широкого коридора отстоит от его осевой дальше,
     * чем кажется, и лента шла сквозь стены — ровно то, ради чего дверь
     * и заводилась отдельным узлом.
     */
    const attach = (point: Point): number | undefined => {
      let best: { line: CorridorLine; bounds: Bounds; gap: number } | undefined;
      floorLines.forEach((line, index) => {
        const bounds = floor.corridors[index]?.bounds;
        if (!bounds) return;
        const near = clampToBounds(point, bounds);
        const gap = distance(point, near);
        if (!best || gap < best.gap) best = { line, bounds, gap };
      });
      if (!best) return undefined;

      const edge = clampToBounds(point, best.bounds);
      const hit = project(edge, best.line.segment);
      const onLine = addNode({
        kind: 'corridor',
        level: floor.level,
        x: hit.point.x,
        z: hit.point.z,
        ownerId: best.line.id,
        ownerName: best.line.name,
      });
      best.line.marks.push({ index: onLine, t: hit.t });

      // Если точка уже лежит на осевой, промежуточный узел не нужен.
      if (distance(edge, hit.point) < 0.05) return onLine;
      const onEdge = addNode({
        kind: 'corridor',
        level: floor.level,
        x: edge.x,
        z: edge.z,
        ownerId: best.line.id,
        ownerName: best.line.name,
      });
      link(onEdge, onLine, distance(edge, hit.point));
      return onEdge;
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
        const target = corridorNodeIndex === undefined ? undefined : nodes[corridorNodeIndex];
        if (corridorNodeIndex !== undefined && target) {
          // Путь от двери до коридора идёт углом, а не по диагонали: человек
          // выходит из двери поперёк неё и дальше движется вдоль коридора.
          // На данных, где коридор описан не везде, дверь отстоит от него
          // до девяти метров, и диагональ прошла бы наискось через соседние
          // помещения. Угол хотя бы повторяет то, как ходят на самом деле.
          const alongZ = door.side === 'north' || door.side === 'south';
          const elbow = alongZ ? { x: door.x, z: target.z } : { x: target.x, z: door.z };
          const gapToElbow = distance(door, elbow);
          const gapToLine = distance(elbow, target);
          if (gapToElbow > 0.05 && gapToLine > 0.05) {
            const elbowIndex = addNode({
              kind: 'corridor',
              level: floor.level,
              x: elbow.x,
              z: elbow.z,
              ownerId: target.ownerId,
              ownerName: target.ownerName,
            });
            link(doorNodeIndex, elbowIndex, gapToElbow);
            link(elbowIndex, corridorNodeIndex, gapToLine);
          } else {
            link(doorNodeIndex, corridorNodeIndex, distance(door, target));
          }
        }
      }
    }

    for (const linkView of floor.vertical) {
      const point = centerOf(linkView.bounds);
      const nodeIndex = addNode({
        kind: 'vertical',
        verticalKind: linkView.kind,
        level: floor.level,
        x: point.x,
        z: point.z,
        ownerId: linkView.id,
        ownerName: linkView.name,
      });
      verticalIndex.set(`${linkView.id}@${floor.level}`, nodeIndex);
      const seen = verticalSeen.get(linkView.id);
      if (seen) {
        seen.levels.push(floor.level);
        // Связь доступна, только если доступна на каждом своём этаже:
        // пандус на одном ярусе не отменяет ступеней на другом.
        seen.accessible = seen.accessible && linkView.accessible === true;
        seen.confirmed = seen.confirmed && linkView.accessibilityConfirmed === true;
      } else
        verticalSeen.set(linkView.id, {
          kind: linkView.kind,
          accessible: linkView.accessible === true,
          confirmed: linkView.accessibilityConfirmed === true,
          levels: [floor.level],
        });
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

  /**
   * Этаж входа без планировки. Вестибюль не размечен — ни коридоров, ни
   * дверей, — но стволы лестниц и лифтов в данных доходят до земли, и без
   * их узлов вход не к чему пришить. Узлы ставятся только на этаже входа:
   * на прочих этажах без планировки к ним всё равно не подойти, а лишний
   * пересадочный узел прибавлял бы ожидание кабины на каждом ярусе.
   */
  const entranceLevel = options.entrance?.level;
  if (entranceLevel !== undefined) {
    const floor = floors.find((item) => item.level === entranceLevel);
    if (floor && !floor.layoutKnown) {
      for (const linkView of floor.vertical) {
        const point = centerOf(linkView.bounds);
        const nodeIndex = addNode({
          kind: 'vertical',
          verticalKind: linkView.kind,
          level: floor.level,
          x: point.x,
          z: point.z,
          ownerId: linkView.id,
          ownerName: linkView.name,
        });
        verticalIndex.set(`${linkView.id}@${floor.level}`, nodeIndex);
        const seen = verticalSeen.get(linkView.id);
        if (seen) {
          seen.levels.push(floor.level);
          seen.accessible = seen.accessible && linkView.accessible === true;
          seen.confirmed = seen.confirmed && linkView.accessibilityConfirmed === true;
        } else {
          verticalSeen.set(linkView.id, {
            kind: linkView.kind,
            accessible: linkView.accessible === true,
            confirmed: linkView.accessibilityConfirmed === true,
            levels: [floor.level],
          });
        }
      }
    }
  }

  // Межэтажные рёбра: одна и та же связь на соседних своих этажах.
  const heights = new Map<number, number>();
  const elevations = new Map<number, number>();
  for (const floor of floors) {
    heights.set(floor.level, floor.height);
    elevations.set(floor.level, floor.elevation);
  }
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
      // Подъём — это разница отметок пола, а не сумма высот этажей выше
      // нижнего: с 4-го на 5-й поднимаются на высоту 4-го, а не 5-го. Пока
      // все этажи одной высоты, разницы не видно; как только первый этаж
      // станет выше остальных, стоимость поехала бы.
      const bottom = elevations.get(lower);
      const top = elevations.get(upper);
      let rise = bottom !== undefined && top !== undefined ? top - bottom : 0;
      if (rise <= 0) {
        rise = 0;
        for (let level = lower; level < upper; level += 1) {
          rise += heights.get(level) ?? 3.6;
        }
      }
      // Множитель этажности здесь не нужен: `rise` уже просуммировал высоты
      // всех пройденных этажей. Пока размеченные этажи соседние, ошибка
      // не видна, но связь, пропускающая этаж, удвоила бы стоимость.
      const lift = view.kind === 'lift';
      const factor = lift ? LIFT_FACTOR : STAIR_FACTOR;
      const cost = rise * factor + (lift ? LIFT_WAIT : 0);
      // Лифт считается доступным по своей природе, лестница — только если
      // это и записано, и подтверждено школой. Неподтверждённое `accessible`
      // — чужое обещание: ошибиться в эту сторону значит привести человека
      // к ступеням, которые он не пройдёт.
      const stairs = view.kind !== 'lift' && !(view.accessible && view.confirmed);
      link(from, to, cost, stairs, !view.confirmed);
    }
  }

  /**
   * Вход в здание. Узел ставится ровно в дверь, а рёбра идут к ближайшей
   * лестнице и к ближайшему лифту своего этажа — по прямой, потому что
   * планировки вестибюля нет. Это честнее, чем не иметь входа вовсе:
   * маршрут строится, а приблизительность первого шага говорится словами.
   *
   * Ближайшие берутся по одному на вид связи: только лестница увела бы
   * человека с коляской на ступени, только лифт — заставил бы ждать кабину
   * ради одного этажа.
   */
  let entranceNode: number | undefined;
  const entrance = options.entrance;
  if (entrance) {
    const point = { x: entrance.x, z: entrance.z };
    entranceNode = addNode({
      kind: 'entrance',
      level: entrance.level,
      x: entrance.x,
      z: entrance.z,
      ownerId: entrance.id,
      ownerName: entrance.name,
    });
    const nearestByKind = new Map<VerticalView['kind'], { index: number; gap: number }>();
    for (const index of verticalIndex.values()) {
      const node = nodes[index];
      if (!node || node.level !== entrance.level || !node.verticalKind) continue;
      const gap = distance(point, node);
      const best = nearestByKind.get(node.verticalKind);
      if (!best || gap < best.gap) nearestByKind.set(node.verticalKind, { index, gap });
    }
    for (const best of nearestByKind.values()) {
      link(entranceNode, best.index, best.gap, false, false, true);
    }
  }

  /** Узел по идентификатору места или по ссылке `graph:N`. */
  function resolve(id: string): number | undefined {
    const direct = parseNodeRef(id);
    if (direct !== undefined) return direct < nodes.length ? direct : undefined;
    const room = roomIndex.get(id);
    if (room !== undefined) return room;
    if (entrance && id === entrance.id) return entranceNode;
    const seen = verticalSeen.get(id);
    if (!seen) return undefined;
    const lowest = [...seen.levels].sort((one, two) => one - two)[0];
    return lowest === undefined ? undefined : verticalIndex.get(`${id}@${lowest}`);
  }

  return {
    nodes,
    edges,
    roomNode: (id) => roomIndex.get(id),
    verticalNode: (id, level) => verticalIndex.get(`${id}@${level}`),
    anchorNode: resolve,
    nearestNode(level, x, z, limit) {
      let best: number | undefined;
      let bestGap = limit;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (!node || node.level !== level) continue;
        // Дверь и центр помещения местом не называются: по помещению попадают
        // его плитой, а «дверь такая-то» человеку ничего не говорит.
        if (node.kind === 'door' || node.kind === 'room') continue;
        const gap = Math.hypot(node.x - x, node.z - z);
        if (gap >= bestGap) continue;
        bestGap = gap;
        best = index;
      }
      return best;
    },
    placeOf(id) {
      const index = resolve(id);
      if (index === undefined) return undefined;
      const node = nodes[index];
      if (!node) return undefined;
      return {
        kind: node.kind,
        name: node.kind === 'corridor' ? (node.ownerName ?? 'коридор') : node.ownerName,
        level: node.level,
        x: node.x,
        z: node.z,
      };
    },
    verticalIds: () => [...verticalSeen.keys()],
  };
}

/**
 * Двери помещения. Источник отдаёт их не всегда: у здания без планировки
 * их нет вовсе, и тогда помещение остаётся в графе изолированным узлом —
 * это честнее, чем выдумывать вход.
 */
function doorsOf(room: RoomView): RoomView['doors'] {
  return room.doors ?? [];
}
