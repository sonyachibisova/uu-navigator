/**
 * Проверка данных здания. Запуск: `npm run check-data` или `npx tsx scripts/check-data.ts`.
 *
 * Отчёт — список правок с именами объектов, а не стек ошибок: каждая строка
 * говорит, какой объект чинить и что именно в нём не так.
 *
 * Код возврата: 1 — есть ошибки, 0 — чисто или только предупреждения.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  BuildingSchema,
  doorOutside,
  floorSchemaFor,
  inside,
  joined,
  overlapArea,
  overlapRect,
  outsideFootprint,
  PASSAGE_MIN,
  VERTICAL_TOLERANCE,
  WALL_TOLERANCE,
  type Building,
  type Bounds,
  type Floor,
} from '../data/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');

/* ================= накопитель находок ================= */

type Level = 'error' | 'warn';
interface Finding {
  level: Level;
  /** Что чинить: имя объекта или файла. */
  object: string;
  /** Что не так и что сделать. */
  message: string;
}

const findings: Finding[] = [];
/** Строки сводки, которые набираются по ходу проверок и печатаются в конце. */
const summary: string[] = [];
/** Разобранные этажи и те, чей файл не прошёл схему: нужны отчёту с самого начала. */
const floors: Floor[] = [];
const brokenLevels = new Set<number>();
const error = (object: string, message: string) => findings.push({ level: 'error', object, message });
const warn = (object: string, message: string) => findings.push({ level: 'warn', object, message });

/* ================= вспомогательное ================= */

/** Человеческое имя объекта для отчёта. */
const label = (o: { id: string; name?: string; planNumber?: string | null }) =>
  o.planNumber ? `${o.id} · ${o.planNumber} «${o.name ?? ''}»` : o.name ? `${o.id} «${o.name}»` : o.id;

/**
 * Собирает по пути цепочку объектов с id — чтобы строка отчёта называла
 * и помещение, и вложенный объект: «f05-library-01 «…» → дверь d01».
 */
function anchorFor(raw: unknown, path: readonly PropertyKey[]): string | null {
  const chain: string[] = [];
  const note = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const rec = v as Record<string, unknown>;
    if (typeof rec['id'] !== 'string') return;
    const name = typeof rec['name'] === 'string' ? ` «${rec['name']}»` : '';
    const num = typeof rec['planNumber'] === 'string' ? ` · ${rec['planNumber']}` : '';
    const text = `${rec['id']}${num}${name}`;
    if (chain[chain.length - 1] !== text) chain.push(text);
  };
  let node: unknown = raw;
  note(node);
  for (const key of path) {
    if (!node || typeof node !== 'object') break;
    node = (node as Record<PropertyKey, unknown>)[key];
    note(node);
  }
  return chain.length ? chain.slice(-2).join(' → ') : null;
}

/** Переводит типовые сообщения Zod: отчёт читают по-русски. */
function translate(issue: z.ZodIssue): string {
  // наши собственные сообщения уже по-русски — их не трогаем
  if (/[а-яё]/i.test(issue.message)) return issue.message;
  const code = issue.code as string;
  const any = issue as unknown as Record<string, unknown>;
  switch (code) {
    case 'invalid_type':
      return any['received'] === 'undefined' || any['input'] === undefined
        ? 'поле обязательно, а его нет'
        : `ожидается ${String(any['expected'])}, а лежит ${String(any['received'] ?? typeof any['input'])}`;
    case 'invalid_enum_value':
    case 'invalid_literal':
    case 'invalid_value': {
      const got = any['received'] ?? any['input'];
      const options = (any['options'] ?? any['values']) as unknown[] | undefined;
      return (
        `значение «${String(got)}» вне словаря` +
        (options ? `; допустимо: ${options.join(', ')}` : '')
      );
    }
    case 'unrecognized_keys':
      return `лишние поля: ${((any['keys'] as string[]) ?? []).join(', ')} — схема их не знает`;
    case 'invalid_string':
    case 'invalid_format':
      return `значение не соответствует формату: ${issue.message}`;
    case 'too_small':
      return `значение или список меньше допустимого: ${issue.message}`;
    case 'too_big':
      return `значение или список больше допустимого: ${issue.message}`;
    default:
      return issue.message;
  }
}

/** Разбирает файл схемой и выкладывает issue-шки как строки правок. */
function parseFile<S extends z.ZodTypeAny>(file: string, schema: S, raw: unknown): z.infer<S> | null {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  for (const issue of result.error.issues) {
    const anchor = anchorFor(raw, issue.path as PropertyKey[]);
    const where = issue.path.length ? issue.path.join('.') : 'корень файла';
    error(anchor ?? `${file} → ${where}`, `${translate(issue)} (поле ${where})`);
  }
  return null;
}

function readJson(file: string): unknown | null {
  const path = join(DATA, file);
  if (!existsSync(path)) {
    error(file, 'файла нет — восстановите его из истории: данные правятся руками по чертежу');
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    error(file, `файл не читается как JSON: ${(e as Error).message}`);
    return null;
  }
}

const fmt = (b: Bounds) => `x ${b.x0}…${b.x1}, z ${b.z0}…${b.z1}`;

/* ================= 1. паспорт здания ================= */

const BUILDING_FILE = 'building.json';
const rawBuilding = readJson(BUILDING_FILE);
const building: Building | null = rawBuilding
  ? parseFile(BUILDING_FILE, BuildingSchema, rawBuilding)
  : null;
if (!building) {
  // без паспорта здания проверять нечего: ни диапазона этажей, ни габарита
  report();
  process.exit(1);
}

/* ================= 2. этажи ================= */

const FloorSchemaForBuilding = floorSchemaFor(building);

for (const ref of building.floors) {
  const raw = readJson(ref.file);
  if (!raw) continue;
  const floor: Floor | null = parseFile(ref.file, FloorSchemaForBuilding, raw);
  if (!floor) {
    brokenLevels.add(ref.level);
    error(
      `этаж ${ref.level}`,
      'файл не прошёл схему — сначала правки выше, остальные проверки по этому этажу пропущены',
    );
    continue;
  }
  if (floor.level !== ref.level) {
    error(ref.file, `в паспорте здания этаж ${ref.level}, а в файле level = ${floor.level}`);
  }
  if (floor.layoutKnown !== ref.layoutKnown) {
    error(
      ref.file,
      `layoutKnown в паспорте здания (${ref.layoutKnown}) не совпадает с файлом (${floor.layoutKnown})`,
    );
  }
  floors.push(floor);
}

/* ================= 3. глобальная уникальность id ================= */

const seenIds = new Map<string, string>();
function claim(id: string, owner: string): void {
  const prev = seenIds.get(id);
  if (prev) error(id, `id занят дважды: ${prev} и ${owner} — id уникален глобально`);
  else seenIds.set(id, owner);
}

for (const floor of floors) {
  for (const room of floor.rooms) {
    claim(room.id, `помещение «${room.name}» на этаже ${floor.level}`);
    for (const door of room.doors) claim(door.id, `дверь помещения ${room.id}`);
  }
  for (const corr of floor.corridors) claim(corr.id, `коридорная полоса на этаже ${floor.level}`);
}

/* ================= 4. этаж с известной планировкой ================= */

for (const floor of floors) {
  if (!floor.layoutKnown) {
    warn(
      `этаж ${floor.level}`,
      'планировка неизвестна: помещений нет, заведены только оболочка и вертикальные связи',
    );
    continue;
  }
  if (floor.rooms.length === 0) {
    error(`этаж ${floor.level}`, 'layoutKnown: true, но список помещений пуст');
  }
  if (floor.corridors.length === 0) {
    error(`этаж ${floor.level}`, 'layoutKnown: true, но нет ни одной коридорной полосы');
  }
}

/* ================= 5. пересечения помещений ================= */

for (const floor of floors) {
  floor.rooms.forEach((a, i) => {
    for (const b of floor.rooms.slice(i + 1)) {
      const area = overlapArea(a.bounds, b.bounds);
      if (area > 0) {
        error(
          label(a),
          `перекрывается с ${label(b)} на ${area.toFixed(2)} м² (допуск на стену ${WALL_TOLERANCE} м) — ` +
            'сдвиньте границу одного из помещений',
        );
      }
    }
  });
}

/* ================= 6. выход за габарит здания ================= */

const footprint = building.footprint;

function checkInside(name: string, bounds: Bounds): void {
  const out = outsideFootprint(bounds, footprint);
  if (out > WALL_TOLERANCE) {
    error(name, `выходит за габарит здания на ${out.toFixed(2)} м (${fmt(bounds)})`);
  }
}

for (const floor of floors) {
  for (const room of floor.rooms) checkInside(label(room), room.bounds);
  for (const corr of floor.corridors) checkInside(corr.id, corr.bounds);
  for (const link of floor.vertical) checkInside(`${link.id} «${link.name}»`, link.bounds);
}

/* ================= 7. вертикальные связи между этажами ================= */

const byLink = new Map<string, { floor: number; link: Floor['vertical'][number] }[]>();
for (const floor of floors) {
  const onFloor = new Set<string>();
  for (const link of floor.vertical) {
    if (onFloor.has(link.id)) {
      error(`${link.id} «${link.name}»`, `дважды указана на этаже ${floor.level}`);
    }
    onFloor.add(link.id);
    const list = byLink.get(link.id) ?? [];
    list.push({ floor: floor.level, link });
    byLink.set(link.id, list);
  }
}

const near = (a: number, b: number) => Math.abs(a - b) <= VERTICAL_TOLERANCE;

for (const [id, entries] of byLink) {
  const head = entries[0];
  if (!head) continue;
  const first = head.link;
  const name = `${id} «${first.name}»`;
  for (const { floor, link } of entries.slice(1)) {
    const b = link.bounds;
    const a = first.bounds;
    if (!near(a.x0, b.x0) || !near(a.x1, b.x1) || !near(a.z0, b.z0) || !near(a.z1, b.z1)) {
      error(
        name,
        `координаты на этаже ${floor} (${fmt(b)}) не совпадают с этажом ${head.floor} (${fmt(a)}) — ` +
          'связь между этажами не установится',
      );
    }
    if (link.kind !== first.kind) {
      error(name, `на этаже ${floor} это ${link.kind}, а на этаже ${head.floor} — ${first.kind}`);
    }
    if (link.accessible !== first.accessible) {
      error(name, `признак accessible расходится между этажами ${head.floor} и ${floor}`);
    }
  }
  const present = new Set(entries.map((e) => e.floor));
  for (const lvl of first.connects) {
    if (brokenLevels.has(lvl)) continue; // этаж не разобран, судить о связи нельзя
    if (!present.has(lvl)) {
      error(name, `в connects заявлен этаж ${lvl}, но на этом этаже связи нет`);
    }
  }
  if (!first.accessibilityConfirmed) {
    warn(name, 'доступность не подтверждена школой (accessibilityConfirmed: false)');
  }
}

for (const floor of floors) {
  if (floor.vertical.length === 0) {
    error(`этаж ${floor.level}`, 'нет ни одной вертикальной связи — этаж отрезан от остальных');
  }
}

/* ================= 8. коридор сквозь помещение ================= */

for (const floor of floors) {
  for (const room of floor.rooms) {
    for (const corr of floor.corridors) {
      const area = overlapArea(room.bounds, corr.bounds);
      if (area <= 0) continue;
      error(
        label(room),
        `коридорная полоса ${corr.id} проходит внутри помещения (${area.toFixed(2)} м²) — ` +
          'сверьте по чертежу, где именно идёт проход: маршрут проложится сквозь стену',
      );
    }
  }
}

/* ================= 9. помещение сквозь вертикальную связь ================= */

for (const floor of floors) {
  for (const room of floor.rooms) {
    for (const link of floor.vertical) {
      const area = overlapArea(room.bounds, link.bounds);
      if (area <= 0) continue;
      error(
        label(room),
        `ствол ${link.id} «${link.name}» стоит внутри помещения (${area.toFixed(2)} м²) — ` +
          'вынесите ствол за границу помещения или сдвиньте границу: ' +
          'иначе к лестнице нет входа, а помещение простреливается насквозь',
      );
    }
  }
}

/* ================= 10. стыковка коридорных полос ================= */

for (const floor of floors) {
  const corrs = floor.corridors;
  corrs.forEach((a, i) => {
    for (const b of corrs.slice(i + 1)) {
      const { dx, dz } = overlapRect(a.bounds, b.bounds);
      const touching = dx >= -WALL_TOLERANCE && dz >= -WALL_TOLERANCE;
      if (!touching) continue;
      if (joined(a.bounds, b.bounds)) continue;
      error(
        `${a.id} + ${b.id}`,
        `полосы соприкасаются, но общий участок ${Math.max(dx, dz).toFixed(3)} м — ` +
          `это не проход (нужно от ${PASSAGE_MIN} м): продлите одну из полос до перекрытия`,
      );
    }
  });
  for (const a of corrs) {
    if (corrs.length < 2) continue;
    if (corrs.some((b) => b !== a && joined(a.bounds, b.bounds))) continue;
    const gap = Math.min(
      ...corrs.filter((b) => b !== a).map((b) => gapBetween(a.bounds, b.bounds)),
    );
    warn(
      a.id,
      `полоса не состыкована ни с одной другой на этаже ${floor.level}: ` +
        `до ближайшей ${gap.toFixed(3)} м — либо доведите полосу, либо в неё входят только через помещение`,
    );
  }
}

/** Зазор между зонами, метры (0 — соприкасаются или накладываются). */
function gapBetween(a: Bounds, b: Bounds): number {
  const { dx, dz } = overlapRect(a, b);
  return Math.hypot(Math.max(-dx, 0), Math.max(-dz, 0));
}

/** Расстояние от точки до прямоугольника, метры. */
function rectDistance(zone: Bounds, x: number, z: number): number {
  return Math.hypot(
    Math.max(zone.x0 - x, 0, x - zone.x1),
    Math.max(zone.z0 - z, 0, z - zone.z1),
  );
}

/* ================= 11. граф: узлы и рёбра ================= */

/**
 * Граф проходимости. Узлы — помещения, коридорные полосы и вертикальные связи
 * (связь — по узлу на каждый этаж). Рёбра:
 *   — дверь помещения, шагнув наружу от своей грани, попала в зону;
 *   — две коридорные полосы перекрываются не уже прохода;
 *   — полоса примыкает к стволу не уже прохода;
 *   — ствол соединяет соседние этажи из своего `connects`.
 * Проверяются только этажи с известной планировкой: на остальных судить не о чем.
 */
const roomNode = (id: string) => `room:${id}`;
const corrNode = (id: string) => `corr:${id}`;
const vertNode = (id: string, level: number) => `vert:${id}@${level}`;

const graph = new Map<string, Set<string>>();
const nodeTitle = new Map<string, string>();
function addNode(id: string, title: string): void {
  if (!graph.has(id)) graph.set(id, new Set());
  nodeTitle.set(id, title);
}
function addEdge(a: string, b: string): void {
  graph.get(a)?.add(b);
  graph.get(b)?.add(a);
}

const known = floors.filter((f) => f.layoutKnown);

for (const floor of known) {
  for (const room of floor.rooms) addNode(roomNode(room.id), label(room));
  for (const corr of floor.corridors) addNode(corrNode(corr.id), corr.id);
  for (const link of floor.vertical) {
    addNode(vertNode(link.id, floor.level), `${link.id} «${link.name}» на этаже ${floor.level}`);
  }
}

/** Двери: куда именно выходит каждая. */
for (const floor of known) {
  for (const room of floor.rooms) {
    for (const door of room.doors) {
      const out = doorOutside(door);
      let landed = false;
      for (const corr of floor.corridors) {
        if (!inside(corr.bounds, out.x, out.z, WALL_TOLERANCE)) continue;
        addEdge(roomNode(room.id), corrNode(corr.id));
        landed = true;
      }
      for (const link of floor.vertical) {
        if (!inside(link.bounds, out.x, out.z, WALL_TOLERANCE)) continue;
        addEdge(roomNode(room.id), vertNode(link.id, floor.level));
        landed = true;
      }
      for (const other of floor.rooms) {
        if (other.id === room.id) continue;
        if (!inside(other.bounds, out.x, out.z, WALL_TOLERANCE)) continue;
        addEdge(roomNode(room.id), roomNode(other.id));
        landed = true;
      }
      if (landed) continue;
      const zones: Bounds[] = [
        ...floor.corridors.map((c) => c.bounds),
        ...floor.vertical.map((v) => v.bounds),
      ];
      const nearest = zones.length
        ? Math.min(...zones.map((z) => rectDistance(z, out.x, out.z)))
        : Infinity;
      error(
        `${label(room)} → дверь ${door.id}`,
        `дверь на грани ${door.side} не выходит ни в коридор, ни к стволу, ни в соседнее помещение: ` +
          `до ближайшей проходной зоны ${nearest === Infinity ? '—' : `${nearest.toFixed(3)} м`} — ` +
          'перевесьте дверь на другую грань или доведите до неё коридор',
      );
    }
  }
}

/** Полосы между собой и полосы со стволами. */
for (const floor of known) {
  floor.corridors.forEach((a, i) => {
    for (const b of floor.corridors.slice(i + 1)) {
      if (joined(a.bounds, b.bounds)) addEdge(corrNode(a.id), corrNode(b.id));
    }
    for (const link of floor.vertical) {
      if (joined(a.bounds, link.bounds)) addEdge(corrNode(a.id), vertNode(link.id, floor.level));
    }
  });
}

/** Этажи между собой — только через стволы. */
const knownLevels = new Set(known.map((f) => f.level));
for (const [id, entries] of byLink) {
  const levels = entries.map((e) => e.floor).filter((l) => knownLevels.has(l));
  levels.sort((a, b) => a - b);
  for (let i = 1; i < levels.length; i += 1) {
    const lo = levels[i - 1];
    const hi = levels[i];
    if (lo === undefined || hi === undefined) continue;
    addEdge(vertNode(id, lo), vertNode(id, hi));
  }
}

/* ================= 12. связность обходом в ширину ================= */

function walk(from: Iterable<string>, allowed: (node: string) => boolean): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const start of from) {
    if (!graph.has(start) || !allowed(start) || seen.has(start)) continue;
    seen.add(start);
    queue.push(start);
  }
  while (queue.length) {
    const node = queue.shift();
    if (node === undefined) continue;
    for (const next of graph.get(node) ?? []) {
      if (seen.has(next) || !allowed(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

const components: Set<string>[] = [];
const visited = new Set<string>();
for (const node of graph.keys()) {
  if (visited.has(node)) continue;
  const comp = walk([node], () => true);
  for (const n of comp) visited.add(n);
  components.push(comp);
}
components.sort((a, b) => b.size - a.size);

const knownRooms = known.flatMap((f) => f.rooms);
const main = components[0] ?? new Set<string>();
const orphans = knownRooms.filter((r) => !main.has(roomNode(r.id)));

if (components.length > 1) {
  error(
    'граф проходимости',
    `связных кусков ${components.length}, а должен быть один: ` +
      components
        .slice(1)
        .map((c) => `[${[...c].map((n) => nodeTitle.get(n) ?? n).join(', ')}]`)
        .join('; ') +
      ' — оторваны от основной сети',
  );
}
if (orphans.length > 0) {
  error(
    'недостижимые помещения',
    `${orphans.length} из ${knownRooms.length}: ${orphans.map((r) => r.id).join(', ')} — ` +
      'до них не строится ни один маршрут',
  );
}

/* ================= 13. режим «только лифты» ================= */

const liftIds = new Set<string>();
for (const floor of known) {
  for (const link of floor.vertical) if (link.kind !== 'stairs') liftIds.add(link.id);
}
const stepFree = (node: string): boolean => {
  if (!node.startsWith('vert:')) return true;
  const id = node.slice('vert:'.length).split('@')[0] ?? '';
  return liftIds.has(id);
};
const liftStarts = [...graph.keys()].filter((n) => n.startsWith('vert:') && stepFree(n));
const byLifts = walk(liftStarts, stepFree);
const noLift = knownRooms.filter((r) => !byLifts.has(roomNode(r.id)));

summary.push(
  `граф проходимости: узлов ${graph.size}, связных кусков ${components.length}, ` +
    `недостижимых помещений ${orphans.length}, недостижимых без лестниц ${noLift.length}`,
);
const bridges = [...byLink]
  .filter(([id]) => {
    const levels = (byLink.get(id) ?? []).map((e) => e.floor).filter((l) => knownLevels.has(l));
    return levels.length > 1 && levels.every((l) => main.has(vertNode(id, l)));
  })
  .map(([id, e]) => `${id} (${e[0]?.link.kind ?? '?'})`);
summary.push(
  `рабочих вертикальных связей между размеченными этажами: ${bridges.length}` +
    (bridges.length ? ` — ${bridges.join(', ')}` : ''),
);
if (noLift.length > 0) {
  warn(
    'маршрут только на лифтах',
    `${noLift.length} из ${knownRooms.length} помещений недостижимы без лестниц: ` +
      noLift.map((r) => r.id).join(', '),
  );
}

/* ================= 14. неразмеченная площадь этажа ================= */

const rectArea = (b: Bounds) => (b.x1 - b.x0) * (b.z1 - b.z0);
/**
 * Толщина наружной стены, метры. Доля неразмеченного считается от площади
 * внутри стен: от габарита целиком она всегда завышена на периметральную
 * полосу, которую разметить в принципе нечем, и порог «30 %» тогда
 * недостижим снизу.
 */
const OUTER_WALL = 0.5;
const inner = {
  x0: building.footprint.x0 + OUTER_WALL,
  x1: building.footprint.x1 - OUTER_WALL,
  z0: building.footprint.z0 + OUTER_WALL,
  z1: building.footprint.z1 - OUTER_WALL,
};
const footprintArea = rectArea(inner);
const unmarkedShare = new Map<number, number>();

for (const floor of known) {
  const covered =
    floor.rooms.reduce((n, r) => n + rectArea(r.bounds), 0) +
    floor.corridors.reduce((n, c) => n + rectArea(c.bounds), 0) +
    floor.vertical.reduce((n, v) => n + rectArea(v.bounds), 0);
  const share = Math.max(0, 1 - covered / footprintArea);
  unmarkedShare.set(floor.level, share);
  summary.push(`этаж ${floor.level}: не размечено ${(share * 100).toFixed(0)} % площади этажа`);
  if (share > 0.3) {
    warn(
      `этаж ${floor.level}`,
      `не размечено ${(share * 100).toFixed(0)} % площади этажа ` +
        `(${((footprintArea - covered)).toFixed(0)} м² из ${footprintArea.toFixed(0)}) — ` +
        'помещение без границ не найдётся поиском и не даст прохода маршруту',
    );
  }
}

/* ================= 15. площадь с чертежа против габарита ================= */

const AREA_DRIFT = 0.15;
/** Расхождения площади, которые данные объясняют словами: они ждут обмера. */
const awaitingSurvey: string[] = [];

for (const floor of floors) {
  for (const room of floor.rooms) {
    if (room.area === undefined) continue;
    const gross = rectArea(room.bounds);
    const drift = Math.abs(room.area - gross) / room.area;
    if (drift <= AREA_DRIFT) continue;
    // Пустой `mezzanine: {}` данных не несёт и глушить проверку не должен;
    // объяснение в `description` — это отложенный вопрос, а не ответ на него,
    // поэтому такие расхождения выносятся отдельным списком ниже.
    if (room.mezzanine?.area !== undefined) continue;
    if (room.description) {
      awaitingSurvey.push(
        `${label(room)}: по чертежу ${room.area} м², по границам ${gross.toFixed(1)} м² ` +
          `(${(drift * 100).toFixed(0)} %) — ${room.description}`,
      );
      continue;
    }
    warn(
      label(room),
      `площадь по чертежу ${room.area} м² расходится с расчётной по границам ` +
        `${gross.toFixed(1)} м² на ${(drift * 100).toFixed(0)} % — ` +
        'либо поправьте границы, либо объясните расхождение полем description',
    );
  }
}

if (awaitingSurvey.length > 0) {
  warn(
    'площади ждут обмера',
    `${awaitingSurvey.length} помещений расходятся с чертежом и объяснены словами:\n      ` +
      awaitingSurvey.join('\n      '),
  );
}

/* ================= 16. названия ================= */

const allRooms = floors.flatMap((f) => f.rooms);
const unconfirmed = allRooms.filter((r) => !r.nameConfirmed).length;
if (unconfirmed > 0) {
  warn(
    'названия помещений',
    `${unconfirmed} из ${allRooms.length} не сняты с чертежа — отправьте data/rooms.csv на сверку. ` +
      'Ни одно название пока не подтверждено школой: значения nameSource: "school" в данных нет',
  );
}
const assumed = allRooms.filter((r) => r.nameSource === 'assumed');
if (assumed.length > 0) {
  warn(
    'названия помещений',
    `${assumed.length} названий заполнены допущением (nameSource: assumed): ` +
      assumed.map((r) => r.id).join(', '),
  );
}
const byName = new Map<string, string[]>();
for (const room of allRooms) {
  const list = byName.get(room.name) ?? [];
  list.push(room.id);
  byName.set(room.name, list);
}
for (const [name, ids] of byName) {
  if (ids.length < 2) continue;
  // Одинаковое название — не дефект, если помещения различает номер:
  // он показывается рядом с названием и в подписи на плане, и в поиске,
  // и в карточке. Школа сама называет три помещения «Базерум Illustration»,
  // и вычищать это из данных значило бы расходиться с дверными табличками.
  const withoutNumber = ids.filter((id) => {
    const room = allRooms.find((item) => item.id === id);
    return !room?.planNumber;
  });
  if (withoutNumber.length < 2) continue;
  warn(
    `название «${name}»`,
    `носят ${withoutNumber.length} помещений без номера по плану (${withoutNumber.join(', ')}) — ` +
      'различить их нечем, добавьте в название блок или сторону, как на чертеже',
  );
}

/* ================= отчёт ================= */

function report(): void {
  const errors = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');

  if (errors.length) {
    console.log(`\nОШИБКИ — исправить обязательно (${errors.length})`);
    for (const f of errors) console.log(`  ✗ ${f.object}\n      ${f.message}`);
  }
  if (warns.length) {
    console.log(`\nПРЕДУПРЕЖДЕНИЯ — проверить, но не блокирует (${warns.length})`);
    for (const f of warns) console.log(`  ! ${f.object}\n      ${f.message}`);
  }

  console.log('\nСВОДКА');
  if (building) {
    console.log(`  здание: ${building.name} (${building.id}), этажей ${building.floorCount}`);
  }
  let rooms = 0;
  let doors = 0;
  let corridors = 0;
  for (const floor of floors) {
    const d = floor.rooms.reduce((n, r) => n + r.doors.length, 0);
    rooms += floor.rooms.length;
    doors += d;
    corridors += floor.corridors.length;
    console.log(
      `  этаж ${floor.level}: помещений ${floor.rooms.length}, дверей ${d}, ` +
        `коридоров ${floor.corridors.length}, связей ${floor.vertical.length}` +
        (floor.layoutKnown ? '' : ' — планировка неизвестна'),
    );
  }
  console.log(`  всего: помещений ${rooms}, дверей ${doors}, коридорных полос ${corridors}`);
  for (const line of summary) console.log(`  ${line}`);
  console.log(
    errors.length
      ? `\nПРОВЕРКА НЕ ПРОЙДЕНА: ошибок ${errors.length}, предупреждений ${warns.length}`
      : `\nПРОВЕРКА ПРОЙДЕНА: ошибок нет, предупреждений ${warns.length}`,
  );
}

report();
process.exit(findings.some((f) => f.level === 'error') ? 1 : 0);
