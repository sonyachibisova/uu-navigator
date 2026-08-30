/**
 * Проверки маршрутов на выдуманном здании.
 *
 * Граф и поиск пути — самый сложный код проекта и единственный, где ошибка
 * не видна глазом: маршрут построится, просто пойдёт не туда. Проверки идут
 * на маленьком здании, собранном тут же руками, а не на данных корпуса:
 * так видно, что именно сломалось, и проверка не падает от правки данных.
 *
 * Запуск: `npm test`. Никакого фреймворка: сравнение и счётчик, всё
 * остальное — это зависимость, которую пришлось бы обновлять.
 */
import { buildRouteGraph } from '@routing/graph';
import { buildRoute, findPath } from '@routing/path';
import type { FloorView, RoomView, VerticalView } from '@building/source';

let failures = 0;
let checks = 0;

function check(name: string, condition: boolean, detail = ''): void {
  checks += 1;
  if (condition) return;
  failures += 1;
  console.error(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
}

/* ================= выдуманное здание ================= */

/**
 * Два этажа, на каждом коридор вдоль оси X и по два помещения — одно
 * с севера, одно с юга. Лестница у середины коридора, лифт на восточном конце; лестница
 * объявлена недоступной, лифт доступным.
 */
function room(id: string, floor: number, x: number, z: number, name: string): RoomView {
  const half = 3;
  return {
    id,
    name,
    planNumber: null,
    type: 'class',
    floor,
    bounds: { x0: x - half, x1: x + half, z0: z - half, z1: z + half },
    focus: { x, y: 0, z },
    plate: { center: { x, y: 0, z }, width: half * 2, depth: half * 2 },
    // Дверь смотрит в сторону коридора: он лежит на z = 0.
    doors: [
      {
        id: `${id}-d01`,
        side: z < 0 ? 'south' : 'north',
        x,
        z: z < 0 ? z + half : z - half,
        width: 1,
      },
    ],
    parts: [],
    label: null,
  };
}

function vertical(id: string, kind: 'stairs' | 'lift', x: number, accessible: boolean): VerticalView {
  return {
    id,
    kind,
    name: kind === 'lift' ? 'Лифт' : 'Лестница',
    bounds: { x0: x - 1.5, x1: x + 1.5, z0: -1.5, z1: 1.5 },
    accessible,
    parts: [],
    label: null,
  };
}

function floor(level: number): FloorView {
  return {
    level,
    name: `${level} этаж`,
    elevation: (level - 1) * 3.6,
    height: 3.6,
    layoutKnown: true,
    parts: [],
    rooms: [
      room(`f${level}-north`, level, -10, -8, `Север ${level}`),
      room(`f${level}-south`, level, 10, 8, `Юг ${level}`),
    ],
    corridors: [
      {
        id: `f${level}-corr`,
        name: `Главный коридор ${level} этажа`,
        bounds: { x0: -20, x1: 20, z0: -1.2, z1: 1.2 },
        part: {
          name: `f${level}.corr`,
          surface: 'corridor',
          shape: { kind: 'box', width: 40, height: 0.1, depth: 2.4 },
          center: { x: 0, y: 0, z: 0 },
        },
      },
    ],
    vertical: [vertical('stair', 'stairs', -4, false), vertical('lift', 'lift', 18, true)],
  };
}

const floors = [floor(1), floor(2)];
const graph = buildRouteGraph(floors);

/* ================= проверки ================= */

console.log('Маршруты на выдуманном здании');

check('граф собрался', graph.nodes.length > 0, `узлов ${graph.nodes.length}`);
check('помещение находится по идентификатору', graph.roomNode('f1-north') !== undefined);
check('лестница находится как якорь', graph.anchorNode('stair') !== undefined);

const inside = buildRoute(graph, 'f1-north', 'f1-south');
check('путь по этажу найден', inside !== undefined);
if (inside) {
  check('путь по этажу не уходит на другой этаж', inside.legs.length === 1);
  check(
    'длина пути правдоподобна',
    inside.meters > 20 && inside.meters < 60,
    `${inside.meters.toFixed(1)} м`,
  );
  check('маршрут начинается с выхода', inside.steps[0]?.text.startsWith('Выйдите') === true);
  check(
    'маршрут заканчивается прибытием',
    inside.steps[inside.steps.length - 1]?.text.startsWith('Вы на месте') === true,
  );
  check(
    'у каждого шага есть место на плане',
    inside.steps.every((step) => Number.isFinite(step.at.x) && Number.isFinite(step.at.z)),
  );
  check(
    'имя коридора называется только у главного',
    inside.steps.every((step) => !step.text.includes('«f1-corr»')),
  );
}

const between = buildRoute(graph, 'f1-north', 'f2-south');
check('путь между этажами найден', between !== undefined);
if (between) {
  check('путь между этажами идёт двумя частями', between.legs.length === 2);
  check(
    'в шагах есть подъём',
    between.steps.some((step) => step.text.startsWith('Поднимитесь')),
  );
  check(
    'лестница ближе лифта, её и выбирает обычный маршрут',
    between.steps.some((step) => step.text.includes('Лестница')),
  );
}

const stepFree = buildRoute(graph, 'f1-north', 'f2-south', { stepFree: true });
check('путь без лестниц найден', stepFree !== undefined);
if (stepFree) {
  check('режим отмечен в маршруте', stepFree.stepFree === true);
  check(
    'без лестниц маршрут идёт лифтом',
    stepFree.steps.some((step) => step.text.includes('лифте')),
  );
  check(
    'без лестниц лестница не упоминается',
    stepFree.steps.every((step) => !step.text.includes('Лестница')),
  );
  check(
    'обход длиннее прямого пути',
    between !== undefined && stepFree.meters > between.meters,
    `${stepFree.meters.toFixed(1)} против ${between?.meters.toFixed(1)}`,
  );
}

check('маршрут из помещения в него же не строится', buildRoute(graph, 'f1-north', 'f1-north') === undefined);
check('маршрут в несуществующее помещение не строится', buildRoute(graph, 'f1-north', 'нет-такого') === undefined);

const fromStair = buildRoute(graph, 'stair', 'f2-south');
check('маршрут от лестницы строится', fromStair !== undefined);
check(
  'маршрут от лестницы начинается словами про неё',
  fromStair?.steps[0]?.text.startsWith('Встаньте у') === true,
);

const isolated = findPath(graph, 0, graph.nodes.length - 1);
check('поиск пути завершается на любых концах', Array.isArray(isolated));
check('поиск пути с неверным индексом возвращает пусто', findPath(graph, -1, 0).length === 0);

/* ================= отчёт ================= */

if (failures === 0) {
  console.log(`\nПРОВЕРКИ ПРОЙДЕНЫ: ${checks} проверок, ошибок нет`);
} else {
  console.error(`\nПРОВЕРКИ НЕ ПРОЙДЕНЫ: ${failures} из ${checks}`);
  process.exitCode = 1;
}
