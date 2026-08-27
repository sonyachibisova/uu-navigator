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
/** Короткие звенья не превращаются в отдельный шаг: это шум, а не указание. */
const MIN_STEP_LENGTH = 4;

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
}

export interface Route {
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

/** Найти цепочку узлов от `from` к `to`. Пустой массив — пути нет. */
export function findPath(graph: RouteGraph, from: number, to: number): number[] {
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

/** Собрать маршрут между помещениями. `undefined` — пути нет. */
export function buildRoute(graph: RouteGraph, fromId: string, toId: string): Route | undefined {
  const from = graph.roomNode(fromId);
  const to = graph.roomNode(toId);
  if (from === undefined || to === undefined || from === to) return undefined;
  const path = findPath(graph, from, to);
  if (path.length < 2) return undefined;

  const nodes = path.map((index) => graph.nodes[index]).filter((node): node is GraphNode => !!node);
  if (nodes.length < 2) return undefined;

  const legs: RouteLeg[] = [];
  const steps: RouteStep[] = [];
  let meters = 0;
  let leg: RouteLeg | undefined;
  let pending = 0;
  let pendingName = '';
  let pendingOwner = '';

  /** Слить накопленную длину в шаг: короткие звенья не заслуживают строки. */
  const flush = (level: number): void => {
    if (pending >= MIN_STEP_LENGTH) {
      const where = pendingName ? `по «${pendingName}»` : 'по коридору';
      steps.push({ text: `Идите ${where} — ${Math.round(pending)} м`, level });
    }
    pending = 0;
    pendingName = '';
    pendingOwner = '';
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (!node) continue;
    if (!leg || leg.level !== node.level) {
      leg = { level: node.level, points: [] };
      legs.push(leg);
    }
    leg.points.push({ x: node.x, z: node.z });

    const next = nodes[i + 1];
    if (!next) continue;

    if (next.level !== node.level) {
      flush(node.level);
      const up = next.level > node.level;
      const verb = up ? 'Поднимитесь' : 'Спуститесь';
      // Лифтом «поднимаются на», лестницей — «по»: предлог разный, и на нём
      // человек понимает, что его ждёт, ещё до того, как дочитает название.
      const lift = node.ownerId.startsWith('lift');
      const where = lift ? `на лифте «${node.ownerName}»` : `по «${node.ownerName}»`;
      steps.push({ text: `${verb} ${where} на ${next.level} этаж`, level: node.level });
      continue;
    }

    // Смена коридора — это поворот, и человеку он нужен отдельной строкой:
    // «идите по главному коридору, потом по лифтовому холлу» читается,
    // а одна строка с именем последнего коридора врёт про весь путь.
    if (next.kind === 'corridor' && next.ownerId !== pendingOwner && pendingOwner) {
      flush(node.level);
    }
    const span = Math.hypot(next.x - node.x, next.z - node.z);
    meters += span;
    pending += span;
    if (next.kind === 'corridor' && next.ownerName) {
      pendingName = next.ownerName;
      pendingOwner = next.ownerId;
    }
    if (next.kind === 'door' && i + 2 >= nodes.length) flush(node.level);
  }

  const last = nodes[nodes.length - 1];
  if (last) flush(last.level);

  const fromName = nodes[0]?.ownerName ?? '';
  const toName = last?.ownerName ?? '';
  if (toName) steps.push({ text: `Вы на месте: ${toName}`, level: last?.level ?? 0 });

  return {
    legs,
    steps,
    meters,
    minutes: Math.max(1, Math.ceil(meters / WALK_SPEED / 60)),
    fromName,
    toName,
  };
}
