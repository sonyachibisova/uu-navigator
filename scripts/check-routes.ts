/**
 * Проверки маршрутов на настоящих данных здания.
 *
 * `scripts/test-routing.ts` гоняет выдуманное здание: там один поворот и одно
 * помещение на конце, и ни один дефект указаний такой конфигурацией не ловится.
 * Здесь берутся реальные `data/floors/*.json` и перебираются все пары
 * помещений — 48 × 47 = 2256 маршрутов, доли секунды.
 *
 * `ProceduralSource` под `tsx` не запускается: он читает планы через
 * `import.meta.glob`, а это вещь Vite. Поэтому этажи собираются здесь
 * напрямую через `fs` — ровно те поля, которые нужны графу.
 *
 * Проверяются инварианты, которые человек в здании замечает первыми:
 *  1. маршрут есть между любой парой помещений;
 *  2. названная длина совпадает с длиной нарисованной ленты;
 *  3. каждый поворот ленты сказан словами, и ни один не выдуман;
 *  4. режим «без лестниц» не ведёт по ступеням.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRouteGraph } from '../src/routing/graph';
import { buildRoute } from '../src/routing/path';
import type { Route, RoutePoint } from '../src/routing/path';
import type { FloorView } from '../src/building/source';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(root, 'data');

/* eslint-disable @typescript-eslint/no-explicit-any */

function read(file: string): any {
  return JSON.parse(readFileSync(join(DATA, file), 'utf8'));
}

/** Собрать этажи из данных теми же полями, что читает граф. */
function loadFloors(): FloorView[] {
  const building = read('building.json');
  return building.floors.map((ref: any) => {
    const f = read(ref.file);
    const middle = (b: any) => ({ x: (b.x0 + b.x1) / 2, y: 0, z: (b.z0 + b.z1) / 2 });
    return {
      level: f.level,
      name: f.name,
      elevation: f.elevation,
      height: f.height,
      layoutKnown: f.layoutKnown,
      parts: [],
      rooms: f.rooms.map((r: any) => ({
        id: r.id,
        name: r.name,
        planNumber: r.planNumber,
        type: r.type,
        floor: r.floor,
        bounds: r.bounds,
        area: r.area,
        seats: r.seats,
        description: r.description,
        focus: middle(r.bounds),
        plate: {
          center: middle(r.bounds),
          width: r.bounds.x1 - r.bounds.x0,
          depth: r.bounds.z1 - r.bounds.z0,
        },
        doors: r.doors,
        parts: [],
        label: null,
      })),
      corridors: f.corridors.map((c: any) => ({
        id: c.id,
        name: c.name ?? null,
        bounds: c.bounds,
        part: {
          name: c.id,
          surface: 'corridor',
          shape: { kind: 'box', width: 1, height: 1, depth: 1 },
          center: middle(c.bounds),
        },
      })),
      vertical: f.vertical.map((v: any) => ({
        id: v.id,
        kind: v.kind === 'lift' ? 'lift' : 'stairs',
        name: v.name,
        bounds: v.bounds,
        accessible: v.accessible,
        parts: [],
        label: null,
      })),
    } as unknown as FloorView;
  });
}

/** Длина ломаной ленты — то, что человек видит на полу. */
function ribbonLength(route: Route): number {
  let total = 0;
  for (const leg of route.legs) {
    for (let i = 0; i < leg.points.length - 1; i += 1) {
      const a = leg.points[i] as RoutePoint;
      const b = leg.points[i + 1] as RoutePoint;
      total += Math.hypot(b.x - a.x, b.z - a.z);
    }
  }
  return total;
}

/**
 * Повороты ленты. Порог тот же, что в указаниях: полсинуса тридцати градусов
 * и отрезки не короче двадцати сантиметров.
 */
function ribbonTurns(route: Route): number {
  let turns = 0;
  for (const leg of route.legs) {
    for (let i = 1; i < leg.points.length - 1; i += 1) {
      const from = leg.points[i - 1] as RoutePoint;
      const via = leg.points[i] as RoutePoint;
      const to = leg.points[i + 1] as RoutePoint;
      const ax = via.x - from.x;
      const az = via.z - from.z;
      const bx = to.x - via.x;
      const bz = to.z - via.z;
      const la = Math.hypot(ax, az);
      const lb = Math.hypot(bx, bz);
      if (la < 0.2 || lb < 0.2) continue;
      if (Math.abs((ax * bz - az * bx) / (la * lb)) >= 0.5) turns += 1;
    }
  }
  return turns;
}

const floors = loadFloors();
const graph = buildRouteGraph(floors);
const rooms = floors.flatMap((floor) => floor.rooms.map((room) => room.id));

let checks = 0;
const problems: string[] = [];
const fail = (message: string): void => {
  problems.push(message);
};
const check = (condition: boolean, message: string): void => {
  checks += 1;
  if (!condition) fail(message);
};

console.log('\nМаршруты на настоящих данных\n');

check(rooms.length > 0, 'в данных нет ни одного помещения');
check(graph.nodes.length > 0, 'граф пуст');

let pairs = 0;
let worstLength = 0;
let worstLengthPair = '';
let turnMismatch = 0;
const turnExamples: string[] = [];

for (const from of rooms) {
  for (const to of rooms) {
    if (from === to) continue;
    pairs += 1;
    const route = buildRoute(graph, from, to);
    if (!route) {
      fail(`нет маршрута ${from} → ${to}`);
      continue;
    }
    // 2. Названная длина — это длина ленты. Расхождение значит, что слова
    // обещают пройти дальше, чем нарисовано, и человек проходит мимо двери.
    const drift = Math.abs(ribbonLength(route) - route.meters);
    if (drift > worstLength) {
      worstLength = drift;
      worstLengthPair = `${from} → ${to}`;
    }
    // 3. Повороты: сколько их на ленте, столько и в словах.
    const said = route.steps.filter((step) => step.text.startsWith('Поверните')).length;
    const drawn = ribbonTurns(route);
    if (said !== drawn) {
      turnMismatch += 1;
      if (turnExamples.length < 5) turnExamples.push(`${from} → ${to}: лента ${drawn}, слов ${said}`);
    }
    // 4. Без лестниц — значит без лестниц. Лифт в указаниях звучит как
    // «на лифте «…»», лестница — как «по «…»».
    const free = buildRoute(graph, from, to, { stepFree: true });
    if (free?.stepFree) {
      const stairs = free.steps.find((step) => /^(Поднимитесь|Спуститесь) по «/.test(step.text));
      if (stairs) fail(`«без лестниц» ведёт по ступеням ${from} → ${to}: ${stairs.text}`);
    }
  }
}

check(pairs > 0, 'не проверено ни одной пары');
check(
  worstLength < 0.05,
  `длина расходится с лентой: худший случай ${worstLength.toFixed(1)} м (${worstLengthPair})`,
);
check(
  turnMismatch === 0,
  `повороты расходятся со словами в ${turnMismatch} маршрутах из ${pairs}${
    turnExamples.length ? ': ' + turnExamples.join('; ') : ''
  }`,
);

console.log(`  пар помещений: ${pairs}`);
console.log(`  узлов графа: ${graph.nodes.length}`);
console.log(`  расхождение длины с лентой: не больше ${worstLength.toFixed(2)} м`);
console.log(`  маршрутов с расхождением поворотов: ${turnMismatch}`);

if (problems.length > 0) {
  console.log(`\nОШИБКИ (${problems.length}):`);
  for (const problem of problems.slice(0, 20)) console.log(`  ✗ ${problem}`);
  if (problems.length > 20) console.log(`  … и ещё ${problems.length - 20}`);
  process.exit(1);
}
console.log(`\nПРОВЕРКИ ПРОЙДЕНЫ: ${checks} проверок, ошибок нет\n`);
