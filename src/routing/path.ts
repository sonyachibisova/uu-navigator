/**
 * Поиск пути по графу здания и превращение его в маршрут для человека.
 *
 * Алгоритм — Дейкстра: рёбра неотрицательные (длина в метрах), граф маленький
 * (сотни узлов), и предсказуемость здесь важнее скорости. Очередь — двоичная
 * куча: без неё на каждом шаге пришлось бы просматривать все узлы, и это
 * единственное место, где сложность вообще заметна.
 *
 * Наружу отдаётся не цепочка узлов, а маршрут: ломаные по этажам (их рисует
 * сцена), шаги словами (их читает человек), длина и оценка времени.
 */
import type { GraphNode, RouteGraph } from '@routing/graph';

/** Скорость шага в здании, м/с: медленнее улицы — двери, повороты, люди. */
const WALK_SPEED = 1.1;
/**
 * Короткий отрезок не становится отдельным шагом: это шум, а не указание.
 * Его длина не теряется — она переносится в следующий шаг, иначе сумма
 * шагов не сходилась бы с длиной маршрута. Семь метров — примерно два
 * шага в сторону и обратно: меньше этого человек и не считает поворотом.
 */
const MIN_STEP_LENGTH = 7;

export interface RoutePoint {
  x: number;
  z: number;
}

export interface RouteLeg {
  level: number;
  points: RoutePoint[];
}

export interface RouteStep {
  /** Текст шага для человека. */
  text: string;
  /** Этаж, на котором выполняется шаг. */
  level: number;
  /**
   * Где этот шаг начинается. По этой точке камера подводится к шагу,
   * когда человек листает указания на ходу: читать «поверните налево»,
   * не видя, где именно, — то же, что не читать вовсе.
   */
  at: RoutePoint;
}

export interface Route {
  /** Построен ли маршрут в режиме «без лестниц». */
  stepFree: boolean;
  /** Ломаные по этажам в порядке прохождения. */
  legs: RouteLeg[];
  steps: RouteStep[];
  /** Длина пути в метрах: только горизонтальные звенья. */
  meters: number;
  /** Оценка времени в минутах, округлённая вверх. */
  minutes: number;
  fromName: string;
  toName: string;
}

/** Двоичная куча по стоимости: минимум сверху. */
class MinHeap {
  private readonly items: { node: number; cost: number }[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: number, cost: number): void {
    this.items.push({ node, cost });
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const current = this.items[index];
      const above = this.items[parent];
      if (!current || !above || above.cost <= current.cost) break;
      this.items[parent] = current;
      this.items[index] = above;
      index = parent;
    }
  }

  pop(): { node: number; cost: number } | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      let index = 0;
      for (;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        const atSmallest = this.items[smallest];
        const atLeft = this.items[left];
        const atRight = this.items[right];
        if (atLeft && atSmallest && atLeft.cost < atSmallest.cost) smallest = left;
        const best = this.items[smallest];
        if (atRight && best && atRight.cost < best.cost) smallest = right;
        if (smallest === index) break;
        const current = this.items[index];
        const other = this.items[smallest];
        if (!current || !other) break;
        this.items[index] = other;
        this.items[smallest] = current;
        index = smallest;
      }
    }
    return top;
  }
}

export interface PathOptions {
  /** Обходить лестницы: маршрут только по лифтам и ровному полу. */
  stepFree?: boolean;
}

/** Найти цепочку узлов от `from` к `to`. Пустой массив — пути нет. */
export function findPath(
  graph: RouteGraph,
  from: number,
  to: number,
  options: PathOptions = {},
): number[] {
  const count = graph.nodes.length;
  if (from < 0 || to < 0 || from >= count || to >= count) return [];
  const best = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const previous = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const queue = new MinHeap();
  best[from] = 0;
  queue.push(from, 0);

  while (queue.size > 0) {
    const top = queue.pop();
    if (!top) break;
    if (done[top.node]) continue;
    done[top.node] = 1;
    if (top.node === to) break;
    for (const edge of graph.edges[top.node] ?? []) {
      if (done[edge.to]) continue;
      if (options.stepFree === true && edge.stairs === true) continue;
      const candidate = top.cost + edge.cost;
      if (candidate >= (best[edge.to] ?? Number.POSITIVE_INFINITY)) continue;
      best[edge.to] = candidate;
      previous[edge.to] = top.node;
      queue.push(edge.to, candidate);
    }
  }

  if (!done[to]) return [];
  const path: number[] = [];
  for (let at = to; at >= 0; at = previous[at] ?? -1) {
    path.push(at);
    if (at === from) break;
  }
  path.reverse();
  return path[0] === from ? path : [];
}

/**
 * Допуск спрямления, метры. Узлы графа стоят там, где к коридору что-то
 * примыкает, поэтому вдоль прямого коридора их несколько и лежат они не
 * ровно на одной линии: без спрямления человек получал бы «поверните
 * направо — 16 м, поверните налево — 8 м» посреди прямого прохода.
 */
const SIMPLIFY_TOLERANCE = 0.9;

/** Отклонение точки от прямой между соседями. */
function deviation(from: GraphNode, via: GraphNode, to: GraphNode): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz);
  if (length < 1e-6) return Math.hypot(via.x - from.x, via.z - from.z);
  return Math.abs((via.x - from.x) * dz - (via.z - from.z) * dx) / length;
}

/**
 * Убрать узлы, которые не меняют геометрию пути. Остаются концы, переходы
 * между этажами, связи, двери и настоящие повороты: именно из них потом
 * собираются указания и лента.
 */
function simplify(nodes: readonly GraphNode[]): GraphNode[] {
  if (nodes.length < 3) return [...nodes];
  const kept: GraphNode[] = [];
  const first = nodes[0];
  if (first) kept.push(first);
  for (let i = 1; i < nodes.length - 1; i += 1) {
    const node = nodes[i];
    const previous = kept[kept.length - 1];
    const next = nodes[i + 1];
    if (!node || !previous || !next) continue;
    const mandatory =
      node.kind !== 'corridor' || node.level !== previous.level || node.level !== next.level;
    if (mandatory || deviation(previous, node, next) > SIMPLIFY_TOLERANCE) kept.push(node);
  }
  const last = nodes[nodes.length - 1];
  if (last) kept.push(last);
  return kept;
}

/**
 * Сторона поворота в плане. Север здания — минимальный `z`, поэтому на плане
 * с севером вверх ось `x` идёт вправо, а `z` — вниз. Векторное произведение
 * в этих осях положительно, когда второй отрезок уходит по часовой стрелке,
 * то есть направо.
 */
function turnOf(from: GraphNode, via: GraphNode, to: GraphNode): 'left' | 'right' | 'straight' {
  const ax = via.x - from.x;
  const az = via.z - from.z;
  const bx = to.x - via.x;
  const bz = to.z - via.z;
  const lengthA = Math.hypot(ax, az);
  const lengthB = Math.hypot(bx, bz);
  if (lengthA < 0.2 || lengthB < 0.2) return 'straight';
  const cross = (ax * bz - az * bx) / (lengthA * lengthB);
  // Порог в полсинуса тридцати градусов: мелкие изломы осевой линии —
  // это погрешность плана, а не поворот, и указывать их нельзя.
  if (Math.abs(cross) < 0.5) return 'straight';
  return cross > 0 ? 'right' : 'left';
}

const TURN_WORD: Record<'left' | 'right', string> = {
  left: 'налево',
  right: 'направо',
};

/**
 * Превратить цепочку узлов в указания для человека.
 *
 * Здесь сознательно не используются имена коридоров из данных: «Проход
 * к 4.21» и «Северный проход перед 4.09» — это имена рёбер графа, которых
 * нет ни на одной стене. Человек идёт по поворотам и расстояниям, а имя
 * коридора называется только тогда, когда оно и правда написано в здании, —
 * то есть у главных коридоров этажа.
 */
function describe(nodes: readonly GraphNode[]): RouteStep[] {
  const steps: RouteStep[] = [];
  const first = nodes[0];
  if (first) {
    steps.push({
      text:
        first.kind === 'room'
          ? `Выйдите из «${first.ownerName}»`
          : `Встаньте у «${first.ownerName}»`,
      level: first.level,
      at: { x: first.x, z: first.z },
    });
  }

  let run = 0;
  let runLevel = first?.level ?? 0;
  let runAt: RoutePoint = { x: first?.x ?? 0, z: first?.z ?? 0 };
  let pendingTurn: 'left' | 'right' | 'straight' = 'straight';
  let mainName = '';

  const flush = (): void => {
    // Копим дальше: короткий крюк у двери или у лифта — часть следующего
    // прямого участка, а не отдельная строка «поверните направо — 5 м».
    if (run < MIN_STEP_LENGTH) return;
    const distance = `${Math.round(run)} м`;
    const where = mainName ? ` по «${mainName}»` : '';
    const text =
      pendingTurn === 'straight'
        ? `Идите${where} — ${distance}`
        : `Поверните ${TURN_WORD[pendingTurn]} и идите${where} — ${distance}`;
    steps.push({ text, level: runLevel, at: runAt });
    run = 0;
    pendingTurn = 'straight';
    mainName = '';
  };

  /** Вывести остаток, даже если он короче порога: перед лифтом и в конце. */
  const flushRemainder = (): void => {
    if (run < 1) {
      run = 0;
      pendingTurn = 'straight';
      return;
    }
    const distance = `${Math.round(run)} м`;
    const where = mainName ? ` по «${mainName}»` : '';
    const text =
      pendingTurn === 'straight'
        ? `Идите${where} — ${distance}`
        : `Поверните ${TURN_WORD[pendingTurn]} и идите${where} — ${distance}`;
    steps.push({ text, level: runLevel, at: runAt });
    run = 0;
    pendingTurn = 'straight';
    mainName = '';
  };

  for (let i = 0; i < nodes.length - 1; i += 1) {
    const node = nodes[i];
    const next = nodes[i + 1];
    if (!node || !next) continue;

    if (next.level !== node.level) {
      flushRemainder();
      const up = next.level > node.level;
      const verb = up ? 'Поднимитесь' : 'Спуститесь';
      // Лифтом «поднимаются на», лестницей — «по»: предлог разный, и на нём
      // человек понимает, что его ждёт, ещё до того, как дочитает название.
      const lift = node.verticalKind === 'lift';
      const where = lift ? `на лифте «${node.ownerName}»` : `по «${node.ownerName}»`;
      steps.push({
        text: `${verb} ${where} на ${next.level} этаж`,
        level: node.level,
        at: { x: node.x, z: node.z },
      });
      continue;
    }

    const previous = nodes[i - 1];
    if (previous && previous.level === node.level) {
      const turn = turnOf(previous, node, next);
      if (turn !== 'straight') {
        flush();
        // Поворот, скопившийся до слияния коротких отрезков, важнее
        // последующих: человек делает его первым.
        if (pendingTurn === 'straight') pendingTurn = turn;
      }
    }

    // Имя называется только у главного коридора этажа: оно единственное,
    // которое человек может услышать от вахтёра или увидеть на схеме.
    if (next.kind === 'corridor' && next.ownerName.startsWith('Главный')) {
      mainName = next.ownerName;
    }
    if (run === 0) runAt = { x: node.x, z: node.z };
    run += Math.hypot(next.x - node.x, next.z - node.z);
    runLevel = node.level;
  }
  flushRemainder();

  const last = nodes[nodes.length - 1];
  const beforeLast = nodes[nodes.length - 2];
  if (last) {
    // С какой стороны дверь: человеку это заменяет полкарты.
    let side = '';
    if (beforeLast && nodes.length >= 3) {
      const before = nodes[nodes.length - 3];
      if (before) {
        const turn = turnOf(before, beforeLast, last);
        if (turn !== 'straight') side = `, дверь ${TURN_WORD[turn] === 'налево' ? 'слева' : 'справа'}`;
      }
    }
    steps.push({
      text: `Вы на месте: ${last.ownerName}${side}`,
      level: last.level,
      at: { x: last.x, z: last.z },
    });
  }
  return steps;
}

/**
 * Собрать маршрут между двумя точками здания. Точкой может быть помещение
 * или связь — лестница и лифт: с них человек чаще всего и начинает.
 * `undefined` — пути нет.
 */
export function buildRoute(
  graph: RouteGraph,
  fromId: string,
  toId: string,
  options: PathOptions = {},
): Route | undefined {
  const from = graph.anchorNode(fromId);
  const to = graph.anchorNode(toId);
  if (from === undefined || to === undefined || from === to) return undefined;
  const path = findPath(graph, from, to, options);
  if (path.length < 2) return undefined;

  const raw = path.map((index) => graph.nodes[index]).filter((node): node is GraphNode => !!node);
  if (raw.length < 2) return undefined;
  const nodes = simplify(raw);

  const legs: RouteLeg[] = [];
  let meters = 0;
  let leg: RouteLeg | undefined;

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) continue;
    if (!leg || leg.level !== node.level) {
      leg = { level: node.level, points: [] };
      legs.push(leg);
    }
    // Последняя точка — центр целевого помещения, и его плита в этот момент
    // поднята над планом: отрезок внутри помещения уходил бы под неё и
    // обрывался на полпути. Лента ведёт до двери, а само помещение и так
    // отмечено подъёмом плиты и карточкой.
    const lastRoom = node.kind === 'room' && i === nodes.length - 1;
    if (!lastRoom) leg.points.push({ x: node.x, z: node.z });
    const next = nodes[i + 1];
    if (next && next.level === node.level) {
      meters += Math.hypot(next.x - node.x, next.z - node.z);
    }
  }

  const steps = describe(nodes);
  const fromName = nodes[0]?.ownerName ?? '';
  const last = nodes[nodes.length - 1];
  const toName = last?.ownerName ?? '';

  return {
    stepFree: options.stepFree === true,
    legs,
    steps,
    meters,
    minutes: Math.max(1, Math.ceil(meters / WALK_SPEED / 60)),
    fromName,
    toName,
  };
}
