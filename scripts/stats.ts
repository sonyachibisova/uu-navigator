// Печатает состав прод-сборки: путь, вес на диске и вес gzip для каждого
// файла в dist/, отсортировано по gzip по убыванию, плюс итоги.
// Без интерактивного открытия браузера — только текст в консоль.
// Перед запуском нужен `npm run build`.

import { gzipSync } from 'node:zlib';
import { readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const DIST_DIR = join(process.cwd(), 'dist');

interface FileStat {
  path: string;
  bytes: number;
  gzipBytes: number;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  return `${(bytes / 1024).toFixed(1)} КБ`;
}

function main(): void {
  if (!existsSync(DIST_DIR)) {
    console.error('dist/ не найден. Сначала выполните: npm run build');
    process.exit(1);
  }

  const files = walk(DIST_DIR);
  const stats: FileStat[] = files.map((absPath) => {
    const bytes = statSync(absPath).size;
    const content = readFileSync(absPath);
    const gzipBytes = gzipSync(content).length;
    return { path: relative(DIST_DIR, absPath), bytes, gzipBytes };
  });

  stats.sort((a, b) => b.gzipBytes - a.gzipBytes);

  console.log('Состав сборки dist/ (по убыванию gzip):\n');
  const header = `${'файл'.padEnd(48)}${'диск'.padStart(10)}${'gzip'.padStart(10)}`;
  console.log(header);
  console.log('-'.repeat(header.length));

  let totalBytes = 0;
  let totalGzip = 0;
  let jsBytes = 0;
  let jsGzip = 0;

  for (const file of stats) {
    console.log(
      `${file.path.padEnd(48)}${formatBytes(file.bytes).padStart(10)}${formatBytes(file.gzipBytes).padStart(10)}`,
    );
    totalBytes += file.bytes;
    totalGzip += file.gzipBytes;
    if (extname(file.path) === '.js') {
      jsBytes += file.bytes;
      jsGzip += file.gzipBytes;
    }
  }

  console.log('-'.repeat(header.length));
  console.log(
    `Итого:${' '.repeat(42)}${formatBytes(totalBytes).padStart(10)}${formatBytes(totalGzip).padStart(10)}`,
  );
  console.log(`JS-файлы: ${formatBytes(jsBytes)} на диске, ${formatBytes(jsGzip)} gzip`);
  console.log('\nБюджет проекта: JS-бандл (gzip) ≤ 250 КБ без Three.js, ≤ 600 КБ с ним.');
}

main();
