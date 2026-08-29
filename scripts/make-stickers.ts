/**
 * Наклейки с кодами для лестничных площадок и лифтовых холлов.
 *
 * Навигатор умеет принимать точку отправления из адреса (`?from=<id>`),
 * и это единственный способ ответить на «я тут» в здании: спутник внутри
 * не работает, а планировок первых этажей ещё нет. Человек наводит камеру
 * на наклейку у лестницы — навигатор открывается уже зная, откуда он идёт,
 * и остаётся только набрать номер аудитории.
 *
 * Скрипт читает вертикальные связи из `data/`, а не перечисляет их сам:
 * появится третья лестница — наклейка на неё выпечатается сама.
 *
 * Запуск: `npm run stickers`. На выходе — `наклейки/index.html`, который
 * печатается из браузера в PDF (Cmd+P → «Сохранить как PDF», поля по умолчанию).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(root, 'наклейки');

/** Адрес живого навигатора: к нему дописывается точка отправления. */
const SITE = 'https://sonyachibisova.github.io/uu-navigator/';

interface VerticalLink {
  id: string;
  kind: 'stairs' | 'lift';
  name: string;
}

interface FloorFile {
  level: number;
  vertical?: VerticalLink[];
}

/** Связи со всех этажей, каждая по одному разу и в порядке появления. */
function collectLinks(): VerticalLink[] {
  const seen = new Map<string, VerticalLink>();
  for (let level = 1; level <= 9; level += 1) {
    const path = join(root, 'data', 'floors', `${String(level).padStart(2, '0')}.json`);
    let floor: FloorFile;
    try {
      floor = JSON.parse(readFileSync(path, 'utf8')) as FloorFile;
    } catch {
      continue;
    }
    for (const link of floor.vertical ?? []) {
      if (!seen.has(link.id)) seen.set(link.id, link);
    }
  }
  return [...seen.values()];
}

const STYLE = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Helvetica Neue', Arial, sans-serif; color: #111; }
  .card { display: flex; gap: 14mm; align-items: center; height: 62mm;
    padding: 8mm; margin-bottom: 6mm; border: 1.2pt dashed #9a9a9a; border-radius: 4mm;
    page-break-inside: avoid; }
  .qr { width: 44mm; flex: 0 0 44mm; }
  .qr svg { width: 100%; height: auto; display: block; }
  .eyebrow { font-size: 9pt; letter-spacing: .12em; text-transform: uppercase; color: #6b6b6b; }
  h2 { margin: 2mm 0 3mm; font-size: 20pt; line-height: 1.15; }
  .lead { margin: 0 0 4mm; font-size: 11pt; line-height: 1.45; max-width: 95mm; }
  .url { margin: 0; font-family: ui-monospace, Menlo, monospace; font-size: 8.5pt; color: #6b6b6b; }
  .note { margin-top: 4mm; font-size: 9pt; color: #6b6b6b; }
`;

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character] ?? character,
  );
}

async function main(): Promise<void> {
  const links = collectLinks();
  if (links.length === 0) throw new Error('В данных нет вертикальных связей — печатать нечего');

  const cards: string[] = [];
  for (const link of links) {
    const url = `${SITE}?from=${encodeURIComponent(link.id)}`;
    // Средний уровень коррекции: наклейку на стене задевают руками и рюкзаками,
    // а размер кода от этого почти не растёт.
    const svg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
    cards.push(`
  <section class="card">
    <div class="qr">${svg}</div>
    <div class="text">
      <div class="eyebrow">Навигатор по корпусу 3</div>
      <h2>Вы здесь: ${escapeHtml(link.name)}</h2>
      <p class="lead">Наведите камеру телефона — навигатор откроется и будет знать,
        откуда вы идёте. Останется набрать номер аудитории.</p>
      <p class="url">${escapeHtml(url)}</p>
    </div>
  </section>`);
  }

  const html = `<!doctype html>
<html lang="ru">
<meta charset="utf-8">
<title>Наклейки с кодами — навигатор по корпусу 3</title>
<style>${STYLE}</style>
<body>
${cards.join('\n')}
<p class="note">Печатать на A4, резать по пунктиру. Клеить на уровне глаз у выхода
с лестничной площадки и у лифтового холла на 4 и 5 этажах — там, где человек
останавливается и оглядывается.</p>
</body>
</html>
`;

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'index.html'), html, 'utf8');
  console.log(`Готово: наклейки/index.html, кодов ${links.length}`);
  console.log('Печать: откройте файл в браузере и сохраните как PDF.');
}

await main();
