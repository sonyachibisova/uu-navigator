/**
 * Собрать `data/rooms.csv` из данных этажей — файл, который уходит в школу
 * на сверку названий.
 *
 * Раньше csv рождался внутри разбора прототипа и после любой правки данных
 * устаревал молча: в школу уезжали названия, которых в приложении уже нет.
 * Теперь он собирается из того же источника, что и сцена, и пересобирается
 * одной командой: `npm run rooms-csv`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Room {
  id: string;
  planNumber: string | null;
  name: string;
  floor: number;
  type: string;
  area?: number;
  seats?: number;
  accessible?: string;
  nameConfirmed?: boolean;
  nameSource?: string;
  note?: string;
}

interface FloorFile {
  rooms?: Room[];
}

const HEAD = [
  'id',
  'planNumber',
  'name',
  'floor',
  'type',
  'area',
  'seats',
  'accessible',
  'nameConfirmed',
  'nameSource',
  'note',
];

/** Экранирование по RFC 4180: названия содержат запятые и кавычки. */
function cell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const rows: string[] = [HEAD.join(',')];
for (let level = 1; level <= 9; level += 1) {
  const path = join(root, 'data', 'floors', `${String(level).padStart(2, '0')}.json`);
  let floor: FloorFile;
  try {
    floor = JSON.parse(readFileSync(path, 'utf8')) as FloorFile;
  } catch {
    continue;
  }
  for (const room of floor.rooms ?? []) {
    rows.push(
      [
        room.id,
        room.planNumber,
        room.name,
        room.floor,
        room.type,
        room.area,
        room.seats,
        room.accessible,
        room.nameConfirmed,
        room.nameSource,
        room.note,
      ]
        .map(cell)
        .join(','),
    );
  }
}

writeFileSync(join(root, 'data', 'rooms.csv'), `${rows.join('\n')}\n`, 'utf8');
console.log(`Готово: data/rooms.csv, строк ${rows.length - 1}`);
