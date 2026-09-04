/**
 * Подписи помещений — один слой на этаж.
 *
 * Подпись раньше была отдельным `Sprite`, то есть отдельным draw call: этаж
 * стоил 23–29 вызовов из ста пятидесяти, а показать подписи сразу на всех
 * этажах было нельзя вовсе — бюджет не выдерживал. Здесь все подписи этажа
 * растеризуются в один атлас и рисуются одним `InstancedMesh`: этаж стоит
 * один draw call, и это открывает режим «здание целиком» с названиями.
 *
 * Разворот к камере (то, ради чего был `Sprite`) делает вершинный шейдер:
 * центр экземпляра переводится в пространство камеры, а углы четырёхугольника
 * добавляются уже там — поэтому подпись всегда смотрит в экран и сохраняет
 * размер в метрах, как раньше.
 *
 * Подпись живёт в двух видах, и это главное, ради чего затевался атлас.
 * Стометровый корпус целиком не помещается в кадр так, чтобы подпись высотой
 * 1.7 м была читаемой: на плане этажа она выходит около двенадцати пикселей.
 * Поэтому у каждой подписи два экземпляра — крупный номер и номер с названием,
 * — и они сменяют друг друга по экранному размеру: издалека не показывается
 * ничего, ближе проступают номера, вплотную — номера с названиями. Человек,
 * который ищет 4.09, видит именно номера тогда, когда они ещё читаются.
 * Экземпляры ничего не стоят: draw call у слоя по-прежнему один.
 *
 * Материал — подкласс `MeshBasicMaterial`, а не `onBeforeCompile` на готовом
 * инстансе, намеренно: `FadeRegistry` клонирует материал при регистрации,
 * а `Material.clone()` не переносит собственные свойства объекта. Метод
 * подкласса живёт в прототипе и клонирование переживает.
 */
import {
  CanvasTexture,
  InstancedBufferAttribute,
  InstancedMesh,
  LinearFilter,
  Matrix4,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { Object3D, WebGLProgramParametersWithUniforms } from 'three';
import type { LabelSpec } from '@building/source';
import { LOOK } from '@core/look';

/**
 * Кегль растеризации. Подпись выводится высотой 1.7 м на экране телефона —
 * при кегле 84/40 полсотни подписей стоили 13 МБ видеопамяти, две трети всей
 * текстурной памяти сцены. 42/24 дают ту же читаемость и втрое меньше.
 */
const TITLE_SIZE = 42;
const SUBTITLE_SIZE = 24;
/**
 * Чернила подписи. Тёмные — почти чистый чёрный намеренно: на средней ступени
 * серого (L* 51) любой смягчённый чёрный не дотягивает до 4.5:1, а чистый
 * даёт 4.60. Светлые — тот же тон, что у текста интерфейса.
 */
const INK_DARK = '#07080a';
const INK_LIGHT = '#f4f4f1';
/** Мелкая строка чуть мягче крупной: на светлом — серее, на тёмном — тусклее. */
const INK_DARK_SOFT = '#33383c';
const INK_LIGHT_SOFT = 'rgba(244,244,241,0.78)';
/**
 * Цвет якорей — лестниц и лифтов. Он другой намеренно: это единственные
 * подписи, которым соответствует что-то видимое глазами, и по ним человек
 * сопоставляет план с тем, где стоит. Второе значение — для тёмной подложки.
 */
const ANCHOR_COLOR = '#1d4f3c';
const ANCHOR_COLOR_LIGHT = '#9fe3c1';
/** Светлая подложка подписи (варианты «прямоугольная плашка»). */
const PLATE_LIGHT = 'rgba(246,244,239,0.92)';
/** Тёмная стеклянная подложка и её кромка — те же значения, что у панелей интерфейса. */
const PLATE_GLASS = 'rgba(20,22,25,0.86)';
const PLATE_GLASS_EDGE = 'rgba(255,255,255,0.20)';
const FONT = 'Univers, Arial, Helvetica, sans-serif';

/** Ширина атласа: дальше плитки переносятся на новую полку. */
const ATLAS_WIDTH = 1024;
/** Зазор между плитками: без него соседняя подпись подмешивается по краю. */
const GAP = 2;
/** Порядок отрисовки: подписи поверх плит и перегородок. */
const RENDER_ORDER = 3;

/**
 * Высота подписи в метрах. Крупная — только номер: он обязан читаться на плане
 * этажа целиком, поэтому берётся заметно больше прежнего. Полная — номер плюс
 * название, размер прежний, как в прототипе; однострочная — всё остальное.
 */
const NUMBER_HEIGHT = 2.3;
const FULL_HEIGHT = 1.45;
const SINGLE_HEIGHT = 1.05;
/** Высота подписи якоря: лестницы и лифта. */
const ANCHOR_HEIGHT = 1.8;

/**
 * Пороги смены вида, в долях высоты экрана. Порог задан долей экрана, а не
 * пикселями, — тогда он одинаков на телефоне и на мониторе и не требует
 * уносить в шейдер размер окна (а заодно переживает клонирование материала
 * в `FadeRegistry`). Ниже нижнего порога не показывается ничего: мелкие
 * названия наезжают друг на друга и читаются как сор.
 */
const NUMBER_IN = [0.014, 0.02] as const;
/**
 * Порог полной подписи задан в её собственных долях экрана. Номер крупнее,
 * значит на том же расстоянии его доля больше — его порог ухода пересчитывается
 * отношением высот, иначе виды разъезжаются: номер уходит не там, где название
 * приходит, и на переходе не остаётся ни того, ни другого.
 */
const FULL_IN = [0.028, 0.036] as const;
/** Порог якорей — ниже, чем у номеров: они нужны раньше всего остального. */
const ANCHOR_IN = [0.01, 0.016] as const;

/**
 * Доля габарита помещения, которую подпись имеет право занять.
 *
 * Подпись развёрнута к камере, то есть в плане она поворачивается вместе
 * с облётом: сегодня длинная сторона таблички лежит вдоль X, через секунду —
 * вдоль Z. Поэтому рамкой служит меньшая сторона помещения, а не та, вдоль
 * которой подпись стоит сейчас, — иначе табличка, помещавшаяся в кадре
 * сверху, вылезала бы в стену при повороте на девяносто градусов.
 */
const FIT_SHARE = 0.9;
/**
 * Ниже этой высоты подпись не показывается вовсе, метры. Меряется одноярусная
 * табличка: ужать «Технические помещения (5 этаж, западный блок)» до кладовой
 * шириной два метра можно, но читать там будет нечего — лучше показать один
 * номер, чем сор.
 */
const MIN_HEIGHT = 0.5;
/**
 * Во сколько строк разрешено переносить название. Перенос — половина починки
 * «подписи в стенах»: одна строка из сорока знаков не влезает никуда, три
 * строки по тринадцать влезают в любое помещение, где подпись вообще уместна.
 * Строк ровно столько, сколько нужно: где хватает одной, переноса нет.
 */
const MAX_LINES = 3;

/**
 * Полоса интерфейса у правого края экрана, доля ширины кадра. Подписи под
 * ней гасятся: колонна кнопок этажей непрозрачна, и номера помещений
 * уезжали под неё наполовину — читалось это как сор, а не как план.
 *
 * Значение живёт в одном объекте на весь модуль и передаётся в шейдер
 * как ссылка: `FadeRegistry` клонирует материалы, и общий объект — это
 * единственный способ, которым один слайдер достаёт до всех клонов.
 */
const edgeUniform = { value: 1 };

/**
 * Потолок экранного размера подписи, доля высоты кадра. Размер подписи задан
 * в метрах и ничем не был ограничен сверху: у самого пола «4.09» вырастал
 * на полэкрана и накрывал соседние помещения вместе с их номерами. Дальше
 * этой доли подпись перестаёт расти — она держит размер, как надпись
 * на указателе, а не как объект сцены.
 *
 * Величина выбрана так, чтобы полная подпись оставалась заметно крупнее
 * порога своего появления (`FULL_IN`) и при этом две подписи по вертикали
 * не могли занять экран целиком.
 */
const MAX_SCREEN_FRACTION = 0.055;

/** Сообщить движку, какую долю ширины кадра занимает интерфейс справа. */
export function setLabelEdge(fraction: number): void {
  edgeUniform.value = Math.min(Math.max(1 - fraction * 2, 0), 1);
}

interface Entry {
  canvas: HTMLCanvasElement;
  /** Высота подписи в метрах — уже с учётом габарита помещения. */
  height: number;
  position: { x: number; y: number; z: number };
  /** Пороги проявления и ухода: `[появиться от, до, уйти от, до]`, ноль — не уходит. */
  range: [number, number, number, number];
}

/** Относительная яркость цвета `#rrggbb` по формуле контраста. */
function luminance(hex: string): number {
  const value = hex.replace('#', '');
  const channel = (at: number): number => {
    const raw = parseInt(value.slice(at, at + 2), 16) / 255;
    return raw <= 0.04045 ? raw / 12.92 : Math.pow((raw + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/**
 * Светлые ли чернила брать на этом фоне. Считается контраст с обоими
 * вариантами и берётся больший — то самое, ради чего серая шкала пола
 * известна заранее: цвет цифры выводится из ступени, а не назначается.
 */
function inkIsLight(under: string): boolean {
  const base = luminance(under);
  const withLight = (luminance(INK_LIGHT) + 0.05) / (base + 0.05);
  const withDark = (base + 0.05) / (luminance(INK_DARK) + 0.05);
  return withLight >= withDark;
}

/** Измерительный контекст: один на модуль, а не по холсту на каждую подпись. */
let measureContext: CanvasRenderingContext2D | null | undefined;

function measurer(): CanvasRenderingContext2D | null {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  return measureContext;
}

/**
 * Оформление подписи. Четыре набора значений — четыре варианта из `LOOK`,
 * ничего кроме цветов, отступов и признаков «есть плашка», «есть линия».
 * Вся разница между вариантами живёт здесь и больше нигде.
 */
interface TileStyle {
  /** Заливка плашки или `null`, если плашки нет. */
  plate: string | null;
  /** Кромка плашки или `null`. */
  border: string | null;
  radius: number;
  padX: number;
  padY: number;
  ink: string;
  inkSoft: string;
  anchorInk: string;
  /** Тонкая линия под строкой вместо плашки. */
  underline: boolean;
  /** Номер и название стоят одной строкой, а не в два яруса. */
  inline: boolean;
}

/**
 * Набор оформления для подписи, лежащей на цвете `under`.
 *
 * Варианты без плашки считают цвет чернил от того, что под ними: серая шкала
 * пола известна заранее и состоит из четырёх ступеней, поэтому контраст
 * цифры выводится, а не назначается. Худшая ступень (L* 51) даёт 4.60:1
 * с чистым чёрным — норма 4.5 выполняется на всех ступенях обеих шкал.
 */
function tileStyle(under: string | undefined): TileStyle {
  const light = under ? inkIsLight(under) : false;
  const autoInk = light ? INK_LIGHT : INK_DARK;
  const autoSoft = light ? INK_LIGHT_SOFT : INK_DARK_SOFT;
  const autoAnchor = light ? ANCHOR_COLOR_LIGHT : ANCHOR_COLOR;
  switch (LOOK.roomNumber) {
    case 'bare':
      return {
        plate: null,
        border: null,
        radius: 0,
        padX: 6,
        padY: 4,
        ink: autoInk,
        inkSoft: autoSoft,
        anchorInk: autoAnchor,
        underline: false,
        inline: false,
      };
    case 'sharp':
      return {
        plate: PLATE_LIGHT,
        border: null,
        radius: 0,
        padX: 10,
        padY: 6,
        ink: INK_DARK,
        inkSoft: INK_DARK_SOFT,
        anchorInk: ANCHOR_COLOR,
        underline: false,
        inline: false,
      };
    case 'underline':
      return {
        plate: null,
        border: null,
        radius: 0,
        padX: 6,
        padY: 4,
        ink: autoInk,
        inkSoft: autoSoft,
        anchorInk: autoAnchor,
        underline: true,
        inline: true,
      };
    default:
      return {
        plate: PLATE_GLASS,
        border: PLATE_GLASS_EDGE,
        radius: 6,
        padX: 11,
        padY: 7,
        ink: INK_LIGHT,
        inkSoft: INK_LIGHT_SOFT,
        anchorInk: ANCHOR_COLOR_LIGHT,
        underline: false,
        inline: false,
      };
  }
}

/** Жадный перенос строки по словам. Слово длиннее строки не режется. */
function wrapText(measure: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (line && measure.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

/** Разметка одной таблички: строки и размер холста под них. */
interface TileLayout {
  lines: string[];
  /** Размер холста, пиксели. */
  width: number;
  height: number;
  /**
   * Высота холста, какой она была бы с одной строкой названия. По ней
   * подпись переводится в метры: строка обязана быть одного кегля независимо
   * от того, во сколько строк сложилось название.
   */
  unitHeight: number;
  /** Ширина номера и высота его яруса, пиксели: нужны отрисовке. */
  titleWidth: number;
  titleSize: number;
  lineHeight: number;
  inline: boolean;
}

/** Разложить подпись на `lineCount` строк названия и посчитать размер холста. */
function layoutTile(
  title: string,
  subtitle: string,
  anchor: boolean,
  style: TileStyle,
  lineCount: number,
): TileLayout {
  const measure = measurer();
  const inline = style.inline && Boolean(title) && Boolean(subtitle);
  // В строчном варианте номер стоит рядом с названием, поэтому он мельче:
  // иначе строка получается лентой, которая не влезает ни в одно помещение.
  const titleSize = inline ? Math.round(SUBTITLE_SIZE * 1.25) : TITLE_SIZE;
  const lineHeight = SUBTITLE_SIZE + 4;
  const titleFont = `700 ${titleSize}px ${FONT}`;
  const subtitleFont = `${anchor ? 700 : 400} ${SUBTITLE_SIZE}px ${FONT}`;

  let titleWidth = 0;
  let lines: string[] = [];
  let linesWidth = 0;
  if (measure) {
    measure.font = titleFont;
    titleWidth = title ? measure.measureText(title).width : 0;
    if (subtitle) {
      measure.font = subtitleFont;
      const single = measure.measureText(subtitle).width;
      lines = wrapText(measure, subtitle, single / lineCount + lineHeight * 0.6);
      for (const line of lines) linesWidth = Math.max(linesWidth, measure.measureText(line).width);
    }
  }

  const gap = inline ? Math.round(SUBTITLE_SIZE * 0.42) : 0;
  const titleHeight = title ? titleSize : 0;
  const rows = lines.length;
  // В строчном варианте первая строка названия стоит справа от номера,
  // остальные — под ним; в остальных вариантах номер занимает свой ярус.
  const contentWidth = inline
    ? Math.max(titleWidth + gap + linesWidth, linesWidth)
    : Math.max(titleWidth, linesWidth);
  const contentHeight = inline
    ? Math.max(titleHeight, lineHeight) + Math.max(0, rows - 1) * lineHeight
    : titleHeight + (title && rows ? 4 : 0) + rows * lineHeight;
  const underlineSpace = style.underline ? 7 : 0;
  const height = Math.ceil(contentHeight) + style.padY * 2 + underlineSpace;

  return {
    lines,
    width: Math.ceil(contentWidth) + style.padX * 2,
    height,
    unitHeight: height - Math.max(0, rows - 1) * lineHeight,
    titleWidth,
    titleSize,
    lineHeight,
    inline,
  };
}

/** Нарисовать табличку по готовой разметке. */
function paintTile(
  title: string,
  anchor: boolean,
  style: TileStyle,
  layout: TileLayout,
): HTMLCanvasElement | undefined {
  if (layout.width < 2 || layout.height < 2) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;

  if (style.plate) {
    // Плашка: скруглённая — только у стеклянной, у остальных углы острые.
    const r = style.radius;
    ctx.beginPath();
    if (r > 0) {
      ctx.moveTo(r, 0);
      ctx.arcTo(canvas.width, 0, canvas.width, canvas.height, r);
      ctx.arcTo(canvas.width, canvas.height, 0, canvas.height, r);
      ctx.arcTo(0, canvas.height, 0, 0, r);
      ctx.arcTo(0, 0, canvas.width, 0, r);
    } else {
      ctx.rect(0, 0, canvas.width, canvas.height);
    }
    ctx.closePath();
    ctx.fillStyle = style.plate;
    ctx.fill();
    if (style.border) {
      ctx.strokeStyle = style.border;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  ctx.textBaseline = 'top';
  const subtitleInk = anchor ? style.anchorInk : style.inkSoft;
  const titleFont = `700 ${layout.titleSize}px ${FONT}`;
  const subtitleFont = `${anchor ? 700 : 400} ${SUBTITLE_SIZE}px ${FONT}`;

  if (layout.inline) {
    // Номер и название одной строкой, слева направо.
    const rowTop = style.padY;
    const gap = Math.round(SUBTITLE_SIZE * 0.42);
    ctx.textAlign = 'left';
    ctx.font = titleFont;
    ctx.fillStyle = style.ink;
    ctx.fillText(title, style.padX, rowTop + (layout.lineHeight - layout.titleSize) / 2);
    ctx.font = subtitleFont;
    ctx.fillStyle = subtitleInk;
    layout.lines.forEach((line, index) => {
      const top = rowTop + index * layout.lineHeight + (layout.lineHeight - SUBTITLE_SIZE) / 2;
      ctx.fillText(line, index === 0 ? style.padX + layout.titleWidth + gap : style.padX, top);
    });
  } else {
    ctx.textAlign = 'center';
    const centreX = canvas.width / 2;
    let y = style.padY;
    if (title) {
      ctx.font = titleFont;
      ctx.fillStyle = style.ink;
      ctx.fillText(title, centreX, y);
      y += layout.titleSize + 4;
    }
    if (layout.lines.length) {
      // Начертаний у Univers два, 400 и 700: просить 600 значит получить 700.
      ctx.font = subtitleFont;
      ctx.fillStyle = subtitleInk;
      for (const line of layout.lines) {
        ctx.fillText(line, centreX, y);
        y += layout.lineHeight;
      }
    }
  }

  if (style.underline) {
    // Тонкая линия снизу вместо плашки: она отделяет подпись от плана и
    // задаёт ей ширину, не закрывая пол.
    ctx.strokeStyle = style.ink;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 2;
    ctx.beginPath();
    const lineY = canvas.height - 3;
    ctx.moveTo(style.padX, lineY);
    ctx.lineTo(canvas.width - style.padX, lineY);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  return canvas;
}

/** Готовая табличка: холст и её высота в метрах. */
interface Tile {
  canvas: HTMLCanvasElement;
  height: number;
}

/**
 * Собрать табличку, которая помещается в габарит помещения.
 *
 * Это и есть починка «названия и номера застревают в стенах», и она не про
 * один случай, а про правило. Работает так:
 *
 *  1. Рамка — меньшая сторона помещения. Подпись развёрнута к камере и в плане
 *     поворачивается вместе с облётом, поэтому мерить по той стороне, вдоль
 *     которой она стоит сейчас, нельзя.
 *  2. Название складывается в столько строк, во сколько нужно, чтобы табличка
 *     влезла целиком — от одной до трёх. Кегль строки при этом не меняется:
 *     высота таблички растёт вместе с числом строк.
 *  3. Если не влезает и в три строки — табличка ужимается, а если после этого
 *     строка становится нечитаемой, подпись не показывается вовсе. Номер
 *     помещения при этом остаётся: лучше один номер, чем нечитаемый сор.
 */
function buildTile(
  title: string,
  subtitle: string,
  anchor: boolean,
  under: string | undefined,
  wanted: number,
  fit: LabelSpec['fit'],
): Tile | undefined {
  const style = tileStyle(under);
  const room = Math.min(fit.width, fit.depth) * FIT_SHARE;
  const maxLines = subtitle ? MAX_LINES : 1;

  let chosen = layoutTile(title, subtitle, anchor, style, 1);
  let height = 0;
  for (let lineCount = 1; lineCount <= maxLines; lineCount += 1) {
    const layout = lineCount === 1 ? chosen : layoutTile(title, subtitle, anchor, style, lineCount);
    chosen = layout;
    // Метры на пиксель считаются по одноярусной табличке: две строки — это
    // вдвое более высокая подпись, а не вдвое более мелкий шрифт.
    height = (wanted * layout.height) / Math.max(layout.unitHeight, 1);
    const span = Math.max((height * layout.width) / Math.max(layout.height, 1), height);
    if (!(room > 0) || span <= room) break;
    // Больше строк не поможет, если перенос уже ничего не изменил.
    if (layout.lines.length < lineCount) break;
  }

  const aspect = chosen.width / Math.max(chosen.height, 1);
  const span = Math.max(height * aspect, height);
  if (room > 0 && span > room) height = (height * room) / span;
  // Читаемость меряется по строке, а не по всей табличке: три строки высотой
  // в полметра — это три нормальные строки, а не одна мелкая.
  const lineShare = chosen.unitHeight / Math.max(chosen.height, 1);
  if (height * lineShare < MIN_HEIGHT) return undefined;

  const canvas = paintTile(title, anchor, style, chosen);
  return canvas ? { canvas, height } : undefined;
}

/** Развернуть одну подпись в экземпляры: крупный номер и номер с названием. */
function entriesOf(spec: LabelSpec): Entry[] {
  const out: Entry[] = [];
  const both = Boolean(spec.title) && Boolean(spec.subtitle);
  const anchor = spec.kind === 'vertical';

  const number = spec.title
    ? buildTile(spec.title, '', false, spec.underColor, both ? NUMBER_HEIGHT : SINGLE_HEIGHT, spec.fit)
    : undefined;
  const fullWanted = both ? FULL_HEIGHT : anchor ? ANCHOR_HEIGHT : SINGLE_HEIGHT;
  const full = spec.subtitle
    ? buildTile(spec.title, spec.subtitle, anchor, spec.underColor, fullWanted, spec.fit)
    : undefined;

  if (number) {
    // Номер уходит только там, где его сменяет полная подпись. Порог ухода
    // считается по настоящим высотам обеих табличек, а не по задуманным:
    // после посадки в помещение они уже не те, и разъехавшийся переход
    // оставил бы человека без обеих подписей разом.
    const vanish: [number, number] = full
      ? [(FULL_IN[0] * number.height) / full.height, (FULL_IN[1] * number.height) / full.height]
      : [0, 0];
    out.push({
      canvas: number.canvas,
      height: number.height,
      position: spec.position,
      range: [NUMBER_IN[0], NUMBER_IN[1], vanish[0], vanish[1]],
    });
  }

  if (full) {
    out.push({
      canvas: full.canvas,
      // Якорь крупнее обычной однострочной подписи и проступает раньше:
      // лестницу человек ищет глазами до того, как разберёт номера.
      height: full.height,
      position: spec.position,
      range: both
        ? [FULL_IN[0], FULL_IN[1], 0, 0]
        : anchor
          ? [ANCHOR_IN[0], ANCHOR_IN[1], 0, 0]
          : [NUMBER_IN[0], NUMBER_IN[1], 0, 0],
    });
  }

  return out;
}

/**
 * Материал подписей: разворот к камере, выборка из атласа и смена вида
 * по экранному размеру.
 *
 * Куски шейдера маленькие, но заменяют собой `Sprite`: именно из-за него
 * подпись была отдельным мешем. `customProgramCacheKey` обязателен — иначе
 * рендерер переиспользует программу обычного `MeshBasicMaterial`.
 */
class LabelMaterial extends MeshBasicMaterial {
  override onBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
    shader.uniforms['uEdge'] = edgeUniform;
    shader.uniforms['uMaxFraction'] = { value: MAX_SCREEN_FRACTION };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSize;
attribute vec4 aUvRect;
attribute vec4 aRange;
uniform float uEdge;
uniform float uMaxFraction;
varying vec2 vAtlasUv;
varying float vLabelAlpha;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( 0.0, 0.0, 0.0, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
// Какую долю высоты экрана займёт подпись: по ней она и проявляется.
float screenFraction = 0.5 * aSize.y * projectionMatrix[1][1] / max( -mvPosition.z, 1e-4 );
float appear = smoothstep( aRange.x, aRange.y, screenFraction );
float vanish = aRange.z > 0.0 ? 1.0 - smoothstep( aRange.z, aRange.w, screenFraction ) : 1.0;
// Полоса интерфейса справа: подпись под кнопками этажей не показывается.
// Проверяется центр экземпляра, а не угол четырёхугольника: иначе подпись
// гасла бы неравномерно, краем.
vec4 clipCenter = projectionMatrix * mvPosition;
float ndcX = clipCenter.x / max( clipCenter.w, 1e-4 );
float edge = 1.0 - smoothstep( uEdge - 0.08, uEdge, ndcX );
vLabelAlpha = appear * vanish * edge;
// Углы прибавляются уже в пространстве камеры: четырёхугольник всегда
// параллелен экрану, а его размер остаётся размером в метрах. Погашенная
// подпись схлопывается в точку — она не доходит до растеризации вовсе.
// Потолок размера. Пороги появления и ухода считаются по настоящей доле
// экрана, а зажимается только сам четырёхугольник: иначе подпись, упёршаяся
// в потолок, перестала бы сменять вид с номера на название.
float sizeLimit = screenFraction > uMaxFraction ? uMaxFraction / screenFraction : 1.0;
mvPosition.xy += position.xy * aSize * sizeLimit * step( 0.001, vLabelAlpha );
gl_Position = projectionMatrix * mvPosition;
vAtlasUv = aUvRect.xy + uv * aUvRect.zw;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\nvarying vec2 vAtlasUv;\nvarying float vLabelAlpha;`,
      )
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  diffuseColor *= texture2D( map, vAtlasUv );
  diffuseColor.a *= vLabelAlpha;
#endif`,
      );
  }

  override customProgramCacheKey(): string {
    return 'label-atlas-billboard-lod';
  }
}

export interface LabelLayer {
  mesh: InstancedMesh;
  /** Сколько экземпляров в слое: нужно замеру и тестам. */
  count: number;
  dispose: () => void;
}

/**
 * Собрать слой подписей этажа: один атлас, один меш, один draw call.
 * Возвращает `undefined`, если подписывать нечего.
 */
export function buildLabelLayer(
  specs: readonly LabelSpec[],
  name: string,
  target: Object3D,
): LabelLayer | undefined {
  const entries: Entry[] = [];
  for (const spec of specs) {
    if (!spec.title && !spec.subtitle) continue;
    entries.push(...entriesOf(spec));
  }
  if (entries.length === 0) return undefined;

  // Раскладка полками: плитки идут слева направо, пока помещаются в ширину
  // атласа, потом переносятся на новую полку высотой в самую высокую плитку.
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  let penX = GAP;
  let penY = GAP;
  let shelfHeight = 0;
  for (const entry of entries) {
    const w = entry.canvas.width;
    const h = entry.canvas.height;
    if (penX + w + GAP > ATLAS_WIDTH && penX > GAP) {
      penX = GAP;
      penY += shelfHeight + GAP;
      shelfHeight = 0;
    }
    placed.push({ x: penX, y: penY, w, h });
    penX += w + GAP;
    if (h > shelfHeight) shelfHeight = h;
  }

  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_WIDTH;
  atlas.height = penY + shelfHeight + GAP;
  const ctx = atlas.getContext('2d');
  if (ctx) {
    entries.forEach((entry, index) => {
      const box = placed[index];
      if (box) ctx.drawImage(entry.canvas, box.x, box.y);
    });
  }

  const texture = new CanvasTexture(atlas);
  texture.colorSpace = SRGBColorSpace;
  // Подписи всегда близко к камере, мипы им не нужны и стоят трети памяти.
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;

  const material = new LabelMaterial({ map: texture, transparent: true, depthWrite: false });
  const geometry = new PlaneGeometry(1, 1);
  const mesh = new InstancedMesh(geometry, material, entries.length);
  mesh.name = name;
  mesh.renderOrder = RENDER_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Габарит меша ничего не значит: положение углов считает шейдер, а не
  // геометрия, и отсечение по пирамиде видимости выбросило бы слой целиком.
  mesh.frustumCulled = false;

  const sizes = new Float32Array(entries.length * 2);
  const rects = new Float32Array(entries.length * 4);
  const ranges = new Float32Array(entries.length * 4);
  const matrix = new Matrix4();

  entries.forEach((entry, index) => {
    const box = placed[index];
    if (!box) return;
    matrix.makeTranslation(entry.position.x, entry.position.y, entry.position.z);
    mesh.setMatrixAt(index, matrix);

    const aspect = box.w / Math.max(box.h, 1);
    sizes[index * 2] = entry.height * aspect;
    sizes[index * 2 + 1] = entry.height;

    rects[index * 4] = box.x / atlas.width;
    rects[index * 4 + 1] = 1 - (box.y + box.h) / atlas.height;
    rects[index * 4 + 2] = box.w / atlas.width;
    rects[index * 4 + 3] = box.h / atlas.height;

    ranges.set(entry.range, index * 4);
  });
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aSize', new InstancedBufferAttribute(sizes, 2));
  geometry.setAttribute('aUvRect', new InstancedBufferAttribute(rects, 4));
  geometry.setAttribute('aRange', new InstancedBufferAttribute(ranges, 4));

  target.add(mesh);

  return {
    mesh,
    count: entries.length,
    dispose(): void {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      // Материал мог быть подменён клоном в `FadeRegistry` — освобождаем оба:
      // исходный принадлежит слою, клон освобождает реестр, повторный вызов
      // `dispose()` на уже освобождённом материале безвреден.
      material.dispose();
      texture.dispose();
    },
  };
}
