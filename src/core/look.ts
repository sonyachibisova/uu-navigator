/**
 * Облик сцены: единственное место, где выбираются варианты внешнего вида.
 *
 * Здесь нет ни одного цвета и ни одной формулы — только выбор. Сами варианты
 * живут там, где им место: палитра пола — в `@building/materials`, подпись
 * помещения — в `@building/labels`, лента маршрута — в `@building/route`,
 * фон и земля — в `@core/environment`.
 *
 * Смысл файла: варианты, которые смотрит владелец, не должны требовать
 * переписывания кода. Выбрали — поменяли значение в `LOOK`, и всё.
 *
 * Ничего специфичного для конкретного здания тут быть не может: это набор
 * оформительских решений движка, одинаковый для любого заказчика. Что именно
 * выбрал заказчик — это уже конфиг здания, и когда конфиг появится, `LOOK`
 * станет его значением по умолчанию.
 */

/** Палитра плит пола. */
export type FloorPaletteKind =
  /** А — четыре ступени серого: назначения, которые не соседствуют, делят ступень. */
  | 'greyA'
  /** Б — одиннадцать оттенков серого, по своему на каждое назначение. */
  | 'greyB'
  /** Прежняя цветная палитра: оставлена для сравнения, по умолчанию не берётся. */
  | 'color';

/** Оформление номера помещения на плите. */
export type RoomNumberKind =
  /** 1 — без плашки: цифра прямо на плите, цвет считается от ступени серого под ней. */
  | 'bare'
  /** 2 — прямоугольная светлая плашка с острыми углами. */
  | 'sharp'
  /** 3 — номер и название одной строкой, тонкая линия снизу, без плашки. */
  | 'underline'
  /** 4 — тёмная стеклянная плашка со светлой цифрой: язык интерфейса, перенесённый в план. */
  | 'glass';

/** Лента маршрута. */
export type RouteLineKind =
  /** Ровное неоновое свечение: яркая сердцевина, тёмная кромка, без штриха вдоль пути. */
  | 'glow'
  /** Мягкая направленная волна: та же неоновая лента с бегущей подсветкой. */
  | 'wave';

/** Фон сцены и земля. */
export type BackdropKind =
  /** 1 «Графит» — ровный тёмный сине-серый, земля чуть светлее фона. */
  | 'graphite'
  /** 2 «Сумерки» — вертикальный градиент от почти чёрного к синему, холодный свет. */
  | 'dusk'
  /** 3 «Бумага» — светлый нейтральный, без неба и без оливы: студийная подложка. */
  | 'paper';

export interface Look {
  floorPalette: FloorPaletteKind;
  roomNumber: RoomNumberKind;
  routeLine: RouteLineKind;
  backdrop: BackdropKind;
}

/**
 * Действующий облик. Значения по умолчанию — то, что рекомендуется к показу;
 * владелец выбирает, и правится ровно этот объект.
 */
export const LOOK: Look = {
  floorPalette: 'greyA',
  roomNumber: 'glass',
  routeLine: 'glow',
  backdrop: 'graphite',
};

/**
 * Разрешённые значения по каждому полю: и для проверки строки из адреса,
 * и как список того, между чем вообще идёт выбор.
 */
const ALLOWED: { [K in keyof Look]: readonly Look[K][] } = {
  floorPalette: ['greyA', 'greyB', 'color'],
  roomNumber: ['bare', 'sharp', 'underline', 'glass'],
  routeLine: ['glow', 'wave'],
  backdrop: ['graphite', 'dusk', 'paper'],
};

/**
 * Временная подмена облика из адреса: `?pol=greyB&nomer=sharp&liniya=wave&fon=dusk`.
 *
 * Нужна ровно для одного — показать варианты рядом, не пересобирая приложение.
 * Посетитель этих параметров не знает и не увидит: без них берётся `LOOK`.
 * Значение, которого нет в списке разрешённых, молча игнорируется.
 */
export function applyLookFromUrl(search: string): void {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return;
  }
  /** Взять одно поле облика из адреса, если значение есть в списке разрешённых. */
  function pick<K extends keyof Look>(param: string, field: K): void {
    const value = params.get(param);
    if (!value) return;
    const allowed: readonly string[] = ALLOWED[field];
    if (!allowed.includes(value)) return;
    LOOK[field] = value as Look[K];
  }
  pick('pol', 'floorPalette');
  pick('nomer', 'roomNumber');
  pick('liniya', 'routeLine');
  pick('fon', 'backdrop');
}
