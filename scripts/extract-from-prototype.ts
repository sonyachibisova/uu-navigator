/**
 * ВНИМАНИЕ: скрипт разовый, его результат уже перекрыт правками по чертежу.
 * Данные в `data/` правятся руками и проверяются `npm run check-data`;
 * повторный запуск этого скрипта затрёт разметку коридоров, положение лифта 1,
 * площади и названия, снятые с чертежа. Оставлен как след происхождения чисел.
 */
/**
 * Сборка `data/` из чисел, снятых с рабочего чертежа.
 *
 * Источники:
 *   — рабочий прототип `legacy/bhshd_4.html` (хранится вне репозитория) —
 *     в нём с чертежа уже сняты габариты,
 *     границы помещений, двери, коридоры и вертикальные связи;
 *   — `корпус 3 (1).pdf` — план этажей 4 и 5: номера, названия, площади.
 *
 * Скрипт разбирает константы прототипа прямо из файла, а не хранит их копию:
 * когда чертёж уточнят и числа в прототипе поправят, данные пересобираются
 * прогоном скрипта, а не ручной правкой JSON.
 *
 * Запуск:  npx tsx scripts/extract-from-prototype.ts --force
 *
 * Без `--force` скрипт ничего не пишет и объясняет почему: предупреждение
 * в комментарии не останавливает того, кто запустил файл не читая.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Защита от затирания. Данные в `data/` после первой сборки правились руками
 * по чертежу: размечены коридоры, переставлен лифт, уточнены площади и
 * названия, связан граф проходимости. Повторный прогон вернёт их к состоянию
 * прототипа и молча уничтожит эту работу — так уже случалось.
 */
if (!process.argv.includes('--force')) {
  console.error(
    [
      'Скрипт остановлен: он перезапишет data/ данными из прототипа.',
      '',
      'Данные в data/ правились руками по чертежу после первой сборки:',
      'разметка коридоров, положение лифта, площади, названия, связность',
      'графа. Прогон вернёт их к состоянию прототипа и эту работу потеряет.',
      '',
      'Если вы уверены — запустите с флагом --force и сразу проверьте',
      'результат: npm run check-data, затем git diff data/.',
    ].join('\n'),
  );
  process.exit(1);
}
import {
  ROOM_PURPOSES,
  type Building,
  type Corridor,
  type Door,
  type Floor,
  type Room,
  type RoomPurpose,
  type Side,
  type VerticalLink,
} from '../data/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PROTOTYPE = join(ROOT, 'legacy', 'bhshd_4.html');
const DATA = join(ROOT, 'data');

/* ================= разбор прототипа ================= */

const src = readFileSync(PROTOTYPE, 'utf8');

/**
 * Достаёт литерал константы прототипа по имени и вычисляет его.
 * Массивы разбираются со счётом скобок: вложенные `[...]` и строки с кавычками
 * регулярным выражением не берутся.
 */
function constant<T>(name: string): T {
  // объявление может быть и `const W = …`, и `…, D = …` в общем списке
  const head = new RegExp(`(?:^|[\\s,(])${name}\\s*=\\s*`, 'm').exec(src);
  if (!head) throw new Error(`в прототипе не найдена константа ${name} — формат файла изменился`);
  let i = head.index + head[0].length;
  let literal: string;
  if (src[i] === '[') {
    let depth = 0;
    let quote: string | null = null;
    const start = i;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']' && --depth === 0) {
        i++;
        break;
      }
    }
    literal = src.slice(start, i);
  } else {
    const num = /^-?[\d.]+/.exec(src.slice(i));
    if (!num) throw new Error(`константа ${name} не число и не массив — формат файла изменился`);
    literal = num[0];
  }
  const clean = literal.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return new Function(`return (${clean});`)() as T;
}

/** Строка прототипа: [номер, название, тип, x0, x1, y0, y1, сторона, позиция, ширина?] */
type ProtoRoom = [string, string, string, number, number, number, number, string, number, number?];

const W = constant<number>('W');
const D = constant<number>('D');
const FLOORS = constant<number>('FLOORS');
const FH = constant<number>('FH');
const OX = constant<number>('OX');
const OYC = constant<number>('OYC');
const ROOMS5 = constant<ProtoRoom[]>('ROOMS5');
const ROOMS4 = constant<ProtoRoom[]>('ROOMS4');
/** Полоса коридора и габарит лифта: [x0, x1, y0, y1] в мм плана. */
type ProtoRect = [number, number, number, number];
/** Лестничный марш: [x0, x1] в мм плана. */
type ProtoSpan = [number, number];

const CORR5 = constant<ProtoRect[]>('CORR5');
const CORR4 = constant<ProtoRect[]>('CORR4');
const STAIRS_S = constant<ProtoSpan[]>('STAIRS_S');
const STAIRS_N = constant<ProtoSpan[]>('STAIRS_N');
const LIFTS = constant<ProtoRect[]>('LIFTS');

/* ================= пересчёт координат ================= */

/** План (мм) → сцена (м) по оси X. */
const px = (x: number) => (x - OX) / 1000;
/** План (мм) → сцена (м) по оси Z. Ось плана направлена на север, Z — на юг. */
const pz = (y: number) => (OYC - y) / 1000;
/** Округление до 0.1 мм: длинные хвосты float в данных читать невозможно. */
const r = (v: number) => Math.round(v * 1e4) / 1e4;

/** Габарит здания в плане — по крайним осям чертежа. */
const PLAN_X0 = -736;
const PLAN_X1 = 97868;
const FOOTPRINT = {
  x0: r(px(PLAN_X0)),
  x1: r(px(PLAN_X1)),
  z0: r(-D / 2),
  z1: r(D / 2),
};

/* ================= названия ================= */

/**
 * Названия с чертежа, приведённые к виду, читаемому студентом.
 * Названия направлений (FAD, GD, PD & IAD, CA, Fashion & Textiles, Illustration)
 * сохраняются: по ним студент и ищет. Служебные английские названия переводятся.
 * `src: 'assumed'` — название на чертеже отсутствует и заполнено осмысленно.
 */
type NameEntry = { name: string; area?: number; seats?: number; src?: 'plan' | 'assumed' };

/** Ключ — название из прототипа (оно же с чертежа). */
const NAME_BY_SOURCE: Record<string, NameEntry> = {
  Администрация: { name: 'Администрация (южный блок)' },
  Administration: { name: 'Администрация (северный блок)' },
  'Learning Resource Centre': { name: 'Learning Resource Centre' },
  "Tutor's room": { name: 'Преподавательская' },
  'Fashion & Textiles Baseroom': { name: 'Базерум Fashion & Textiles' },
  'Art Studio · 292 м²': { name: 'Художественная студия', area: 292 },
  'Fashion Workshop': { name: 'Мастерская Fashion' },
  'Fashion Workshop · 60 м²': { name: 'Мастерская Fashion', area: 60 },
  'Jewellery Workshop': { name: 'Ювелирная мастерская' },
  '3D Workshop': { name: 'Мастерская 3D' },
  'Тех.': { name: 'Техническое помещение', src: 'assumed' },
  'Тех. помещения': { name: 'Технические помещения', src: 'assumed' },
  Кладовая: { name: 'Кладовая', src: 'assumed' },
  'Apple Suite 28+1': { name: 'Класс Apple', seats: 28 },
  'PC Suite 28+1': { name: 'Компьютерный класс', seats: 28 },
  'Project Space Baseroom': { name: 'Базерум Project Space' },
  'Seminar Room · 30 м²': { name: 'Семинарская', area: 30 },
  'Seminar Room · 50 м²': { name: 'Семинарская', area: 50 },
  'Contemporary Art Baseroom': { name: 'Базерум Contemporary Art' },
  'CA Baseroom': { name: 'Базерум CA' },
  'Print Office': { name: 'Офис печати' },
  'FAD Baseroom': { name: 'Базерум FAD' },
  'Illustration Baseroom': { name: 'Базерум Illustration' },
  'GD Baseroom': { name: 'Базерум GD' },
  UContemporary: { name: 'Галерея UContemporary' },
  'Storage Room': { name: 'Кладовая' },
  'Dark Room': { name: 'Тёмная комната' },
  'Multifunctional Room': { name: 'Многофункциональный зал' },
  'PD & IAD Baseroom': { name: 'Базерум PD и IAD' },
  'Textile Workshop': { name: 'Текстильная мастерская' },
};

/**
 * Помещения, у которых на чертеже названия нет. Ключ — `<этаж>.<тип>@<x0 плана>`,
 * то есть привязка к месту: помещение опознаётся однозначно и не путается с соседним.
 */
const NAME_BY_PLACE: Record<string, NameEntry> = {
  '5.wc@26180': { name: 'Санузел', src: 'assumed' },
  '5.wc@30186': { name: 'Санузел', src: 'assumed' },
  '4.wc@26180': { name: 'Санузел', src: 'assumed' },
  '4.wc@92718': { name: 'Санузел', src: 'assumed' },
  // 4.20 — на плане только номер; в прототипе помещение подписано как кухня
  '4.tech@66996': { name: 'Кухня', src: 'assumed' },
};

function resolveName(floor: number, proto: ProtoRoom): NameEntry {
  const [, sourceName, type, x0] = proto;
  const place = `${floor}.${type}@${x0}`;
  const entry = NAME_BY_PLACE[place] ?? (sourceName ? NAME_BY_SOURCE[sourceName] : undefined);
  if (!entry) {
    throw new Error(
      `нет названия для помещения ${place} («${sourceName}») — добавьте строку в таблицу названий, ` +
        'выдумывать название на ходу нельзя',
    );
  }
  return entry;
}

/* ================= сборка помещений ================= */

/** Сторона двери в прототипе (стороны плана) → сторона сцены. */
const SIDE: Record<string, Side> = { N: 'north', S: 'south', E: 'east', W: 'west' };

const DEFAULT_DOOR_WIDTH_MM = 1400;

function isPurpose(t: string): t is RoomPurpose {
  return (ROOM_PURPOSES as readonly string[]).includes(t);
}

function buildRooms(level: number, protoRooms: ProtoRoom[]): Room[] {
  const counters = new Map<string, number>();
  return protoRooms.map((proto) => {
    const [num, , type, X0, X1, Y0, Y1, side, pos, widthMm] = proto;
    if (!isPurpose(type)) {
      throw new Error(
        `тип «${type}» отсутствует в словаре назначений ROOM_PURPOSES — ` +
          'добавьте строку в словарь и в enum, а не подменяйте тип',
      );
    }
    const n = (counters.get(type) ?? 0) + 1;
    counters.set(type, n);
    const id = `f${String(level).padStart(2, '0')}-${type}-${String(n).padStart(2, '0')}`;

    const bounds = { x0: r(px(X0)), x1: r(px(X1)), z0: r(pz(Y1)), z1: r(pz(Y0)) };
    const entry = resolveName(level, proto);
    const planNumber = /^\d+\.\d+[a-z]?$/.test(num) ? num : null;

    const doorSide = SIDE[side];
    if (!doorSide) throw new Error(`неизвестная сторона двери «${side}» у помещения ${id}`);
    const width = (widthMm ?? DEFAULT_DOOR_WIDTH_MM) / 1000;
    // сторона задаёт одну координату, позиция — вторую
    const door: Door = {
      id: `${id}-d01`,
      side: doorSide,
      x: r(doorSide === 'east' ? bounds.x1 : doorSide === 'west' ? bounds.x0 : px(pos)),
      z: r(doorSide === 'north' ? bounds.z0 : doorSide === 'south' ? bounds.z1 : pz(pos)),
      width: r(width),
    };

    const room: Room = {
      id,
      planNumber,
      name: entry.name,
      nameConfirmed: false, // школа названия ещё не подтвердила
      nameSource: entry.src ?? 'plan',
      type,
      floor: level,
      bounds,
      // сведений о доступной среде от школы нет — схема ждёт явного значения
      accessible: 'unknown',
      doors: [door],
    };
    if (entry.area !== undefined) room.area = entry.area;
    if (entry.seats !== undefined) room.seats = entry.seats;
    return room;
  });
}

function buildCorridors(level: number, strips: ProtoRect[]): Corridor[] {
  return strips.map(([x0, x1, y0, y1], i) => ({
    id: `f${String(level).padStart(2, '0')}-corr-${String(i + 1).padStart(2, '0')}`,
    floor: level,
    bounds: { x0: r(px(x0)), x1: r(px(x1)), z0: r(pz(y1)), z1: r(pz(y0)) },
  }));
}

/* ================= вертикальные связи ================= */

/**
 * Лестницы и лифты одинаковы на всех этажах: id и координаты общие,
 * поэтому связь между этажами устанавливается по совпадению.
 *
 * ДОПУЩЕНИЕ: сведений о доступной среде от школы нет. Лифт помечен доступным,
 * лестница — нет; `accessibilityConfirmed: false` у всех.
 */
const ALL_LEVELS = Array.from({ length: FLOORS }, (_, i) => i + 1);

/** Габарит южной лестничной клетки по плану: стены клетки идут по y 1000…7600. */
const STAIR_S_Y = [1000, 7600] as const;
/** Северная внутренняя лестница: марш шириной 1.2 м вокруг оси y = 21200. */
const STAIR_N_Y = [20600, 21800] as const;

function buildVertical(): VerticalLink[] {
  const links: VerticalLink[] = [];
  STAIRS_S.forEach(([xa, xb], i) => {
    links.push({
      id: `stair-south-${String(i + 1).padStart(2, '0')}`,
      kind: 'stairs',
      name: `Лестница южная ${i + 1}`,
      bounds: { x0: r(px(xa)), x1: r(px(xb)), z0: r(pz(STAIR_S_Y[1])), z1: r(pz(STAIR_S_Y[0])) },
      connects: ALL_LEVELS,
      accessible: false,
      accessibilityConfirmed: false,
    });
  });
  STAIRS_N.forEach(([xa, xb], i) => {
    links.push({
      id: `stair-north-${String(i + 1).padStart(2, '0')}`,
      kind: 'stairs',
      name: `Лестница северная ${i + 1}`,
      bounds: { x0: r(px(xa)), x1: r(px(xb)), z0: r(pz(STAIR_N_Y[1])), z1: r(pz(STAIR_N_Y[0])) },
      connects: ALL_LEVELS,
      accessible: false,
      accessibilityConfirmed: false,
    });
  });
  LIFTS.forEach(([x0, x1, y0, y1], i) => {
    links.push({
      id: `lift-${String(i + 1).padStart(2, '0')}`,
      kind: 'lift',
      name: `Лифт ${i + 1}`,
      bounds: { x0: r(px(x0)), x1: r(px(x1)), z0: r(pz(y1)), z1: r(pz(y0)) },
      connects: ALL_LEVELS,
      accessible: true,
      accessibilityConfirmed: false,
    });
  });
  return links;
}

/* ================= этажи ================= */

/** Планировки сняты только для 4 и 5 этажей; 1–3 заводятся оболочкой. */
const LAYOUTS: Record<number, { rooms: ProtoRoom[]; corridors: ProtoRect[] } | undefined> = {
  4: { rooms: ROOMS4, corridors: CORR4 },
  5: { rooms: ROOMS5, corridors: CORR5 },
};

function buildFloor(level: number): Floor {
  const layout = LAYOUTS[level];
  return {
    level,
    name: `${level} этаж`,
    elevation: r((level - 1) * FH),
    height: FH,
    layoutKnown: Boolean(layout),
    rooms: layout ? buildRooms(level, layout.rooms) : [],
    corridors: layout ? buildCorridors(level, layout.corridors) : [],
    vertical: buildVertical(),
  };
}

/* ================= запись ================= */

function writeJson(relPath: string, value: unknown): void {
  const path = join(DATA, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
  return;
}

const floors: Floor[] = ALL_LEVELS.map(buildFloor);

const building: Building = {
  id: 'bhsad-korpus-3',
  name: 'Британская высшая школа дизайна, корпус 3',
  shortName: 'Корпус 3',
  units: 'm',
  up: 'y',
  size: { width: W, depth: D, height: r(FLOORS * FH) },
  floorCount: FLOORS,
  floorHeight: FH,
  footprint: FOOTPRINT,
  origin: {
    description:
      'Центр здания на уровне земли. Ось Y вверх, X растёт на восток, Z — на юг ' +
      '(север здания — минимальный Z). Единицы — метры.',
    plan: {
      originMm: { x: OX, y: OYC },
      mmPerUnit: 1000,
      formula: 'x = (план_x - 48500) / 1000; z = (13260 - план_y) / 1000',
    },
  },
  floors: floors.map((f) => ({
    level: f.level,
    file: `floors/${String(f.level).padStart(2, '0')}.json`,
    layoutKnown: f.layoutKnown,
  })),
  sources: [
    'корпус 3 (1).pdf — план этажей 4 и 5: номера, названия, площади',
    'рабочий прототип — координаты, снятые с чертежа (хранится вне репозитория)',
  ],
};

writeJson('building.json', building);
for (const floor of floors) {
  writeJson(`floors/${String(floor.level).padStart(2, '0')}.json`, floor);
}

/* ================= сводная таблица ================= */

/** CSV для сверки с моделью и для отправки в школу на подтверждение названий. */
function toCsv(rooms: Room[]): string {
  const head = ['id', 'planNumber', 'name', 'floor', 'type', 'area', 'nameConfirmed'];
  const cell = (v: string | number | boolean | null | undefined) =>
    v === null || v === undefined ? '' : `"${String(v).replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const room of rooms) {
    lines.push(
      [
        cell(room.id),
        cell(room.planNumber),
        cell(room.name),
        room.floor,
        cell(room.type),
        room.area ?? '',
        room.nameConfirmed,
      ].join(','),
    );
  }
  // BOM: таблицу открывают в Excel, без него кириллица рассыпается
  return '﻿' + lines.join('\n') + '\n';
}

const allRooms = floors.flatMap((f) => f.rooms);
writeFileSync(join(DATA, 'rooms.csv'), toCsv(allRooms), 'utf8');

/* ================= итог ================= */

const doors = allRooms.reduce((n, room) => n + room.doors.length, 0);
const corridors = floors.reduce((n, f) => n + f.corridors.length, 0);
console.log('Данные пересобраны из прототипа:');
for (const f of floors) {
  console.log(
    `  этаж ${f.level}: помещений ${f.rooms.length}, коридоров ${f.corridors.length}, ` +
      `связей ${f.vertical.length}${f.layoutKnown ? '' : ' (планировка неизвестна)'}`,
  );
}
console.log(`  всего: помещений ${allRooms.length}, дверей ${doors}, коридорных полос ${corridors}`);
