/**
 * Схемы данных здания (Zod) — единый источник правды для движка, валидатора и бэкенда.
 *
 * Соглашения (правила проекта, раздел «Конвенции»):
 *   — единицы сцены: метры, ось Y вверх, начало координат — центр здания на уровне земли;
 *   — X растёт на восток, Z растёт на юг (север здания — минимальный Z);
 *   — в данных нет ничего про рендер: ни цветов, ни материалов, ни порядка отрисовки.
 *
 * Числовые инварианты выражены схемой, а не комментарием: где написано `x0 < x1`,
 * там стоит `.refine`, и файл с нарушением не пройдёт валидацию.
 */
import { z } from 'zod';

/* ================= допуски ================= */

/** Толщина перегородки: на столько помещения могут «залезать» друг в друга и в габарит. */
export const WALL_TOLERANCE = 0.15;
/** Насколько точка двери может отстоять от грани своего помещения. */
export const DOOR_EDGE_TOLERANCE = 0.15;
/** Совпадение координат вертикальных связей между этажами. */
export const VERTICAL_TOLERANCE = 0.01;
/**
 * Минимальная ширина прохода. Две зоны считаются состыкованными, только если
 * общий участок не уже этого: касание углом или полоской в палец — не проход.
 */
export const PASSAGE_MIN = 0.9;
/** Насколько дверь «заглядывает» наружу, чтобы попасть в соседнюю зону. */
export const DOOR_REACH = 0.6;

/* ================= словарь назначений ================= */

/**
 * Назначения помещений — строго по словарю `ROOM_PURPOSES` ниже.
 * Порядок совпадает со словарём. Новое назначение сначала добавляется
 * в документ, потом сюда — иначе поиск и фильтры расходятся с планом.
 */
export const ROOM_PURPOSES = [
  'studio',
  'workshop',
  'lecture',
  'class',
  'lab',
  'gallery',
  'library',
  'cowork',
  'office',
  'admin',
  'lobby',
  'cafe',
  'shop',
  'wc',
  'storage',
  'tech',
] as const;

export const RoomPurposeSchema = z.enum(ROOM_PURPOSES);
export type RoomPurpose = z.infer<typeof RoomPurposeSchema>;

/**
 * Доступность для маломобильного посетителя. Три состояния, а не флаг:
 * `unknown` — по данным не выведено и школой не подтверждено; это честное
 * состояние по умолчанию, и оно не то же самое, что `no`.
 */
export const AccessibilitySchema = z.enum(['yes', 'no', 'unknown']);
export type Accessibility = z.infer<typeof AccessibilitySchema>;

/* ================= примитивы ================= */

/** Конечное число: отсекает NaN и Infinity, которые иначе проходят как `number`. */
const finite = () => z.number().finite();

/** Прямоугольник в плане, метры сцены. */
export const BoundsSchema = z
  .object({
    x0: finite(),
    x1: finite(),
    z0: finite(),
    z1: finite(),
  })
  .strict()
  .refine((b) => b.x0 < b.x1, { message: 'x0 должен быть меньше x1', path: ['x1'] })
  .refine((b) => b.z0 < b.z1, { message: 'z0 должен быть меньше z1', path: ['z1'] });

export type Bounds = z.infer<typeof BoundsSchema>;

/** Габариты в метрах: все три измерения строго положительны. */
export const SizeSchema = z
  .object({
    width: finite().positive(),
    depth: finite().positive(),
    height: finite().positive(),
  })
  .strict();

export type Size = z.infer<typeof SizeSchema>;

/** Сторона света в системе сцены: north — минимальный Z, south — максимальный. */
export const SideSchema = z.enum(['north', 'south', 'east', 'west']);
export type Side = z.infer<typeof SideSchema>;

/** Формула id помещения: `f<NN>-<purpose>-<nn>`. */
export const ROOM_ID_RE = /^f\d{2}-[a-z]+-\d{2}$/;
/** Номер по плану — то, что напечатано на двери: «5.01», «4.14», «5.06a». */
export const PLAN_NUMBER_RE = /^\d+\.\d+[a-z]?$/;

/* ================= дверь ================= */

/**
 * Дверь — точка входа маршрута в помещение, а не геометрия полотна.
 * Лежит на границе своего помещения; проверку даёт схема помещения,
 * потому что только там известны границы.
 */
export const DoorSchema = z
  .object({
    id: z.string().min(1),
    /** Сторона помещения, на которой стоит дверь. */
    side: SideSchema,
    x: finite(),
    z: finite(),
    /** Ширина проёма в метрах. */
    width: finite().positive().max(12),
  })
  .strict();

export type Door = z.infer<typeof DoorSchema>;

/* ================= помещение ================= */

const RoomBaseSchema = z
  .object({
    id: z.string().regex(ROOM_ID_RE, 'id помещения по формуле f<NN>-<purpose>-<nn>'),
    /** Номер по плану — отдельно от id: его видит студент и печатают на дверях. */
    planNumber: z.string().regex(PLAN_NUMBER_RE, 'номер по плану вида «5.01»').nullable(),
    /** Рабочее название по-русски. */
    name: z.string().min(1),
    /**
     * Название снято с источника, а не придумано: `true` — подпись есть на чертеже
     * (дословно или прямым переводом), `false` — рабочее название по назначению
     * помещения. Официальные названия аудиторий приходят от школы отдельно.
     */
    nameConfirmed: z.boolean(),
    /** Откуда взято название: с чертежа или заполнено осмысленным допущением. */
    nameSource: z.enum(['plan', 'assumed', 'school']),
    type: RoomPurposeSchema,
    floor: z.number().int().min(1).max(99),
    bounds: BoundsSchema,
    /** Площадь по чертежу, м². Не считается из границ: там габарит по осям. */
    area: finite().positive().optional(),
    /** Посадочных мест по чертежу («Apple Suite 28+1»). */
    seats: z.number().int().positive().optional(),
    /**
     * Антресоль над помещением: на чертеже она подписана отдельно и объясняет,
     * почему площадь по чертежу больше габарита по осям.
     */
    mezzanine: z
      .object({ area: finite().positive().optional() })
      .strict()
      .optional(),
    /** Доступность для маломобильного посетителя; по умолчанию — «неизвестно». */
    accessible: AccessibilitySchema.default('unknown'),
    /** Минимум одна дверь: помещение без двери недостижимо для маршрута. */
    doors: z.array(DoorSchema).min(1, 'у помещения должна быть хотя бы одна дверь'),
    description: z.string().optional(),
  })
  .strict();

/** Лежит ли точка двери на своей грани помещения. */
export function doorEdgeDistance(bounds: Bounds, door: Door): number {
  const { x0, x1, z0, z1 } = bounds;
  switch (door.side) {
    case 'north':
      return Math.abs(door.z - z0) + outside(door.x, x0, x1);
    case 'south':
      return Math.abs(door.z - z1) + outside(door.x, x0, x1);
    case 'west':
      return Math.abs(door.x - x0) + outside(door.z, z0, z1);
    case 'east':
      return Math.abs(door.x - x1) + outside(door.z, z0, z1);
  }
}

/** Насколько значение вышло за отрезок (0, если внутри). */
function outside(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - v;
  if (v > hi) return v - hi;
  return 0;
}

export const RoomSchema = RoomBaseSchema.superRefine((room, ctx) => {
  // назначение в id обязано совпадать с типом — иначе id врёт о помещении
  const purposeInId = room.id.split('-')[1] ?? '';
  if (purposeInId !== room.type) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: `назначение в id («${purposeInId}») не совпадает с типом «${room.type}»`,
    });
  }
  // номер этажа в id обязан совпадать с полем floor
  const floorInId = Number(room.id.slice(1, 3));
  if (floorInId !== room.floor) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['id'],
      message: `этаж в id (${floorInId}) не совпадает с полем floor (${room.floor})`,
    });
  }
  room.doors.forEach((door, i) => {
    const d = doorEdgeDistance(room.bounds, door);
    if (d > DOOR_EDGE_TOLERANCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['doors', i],
        message: `дверь «${door.id}» не лежит на грани ${door.side}: отклонение ${d.toFixed(2)} м`,
      });
    }
  });
});

export type Room = z.infer<typeof RoomSchema>;

/* ================= коридор ================= */

/** Коридорная полоса — зона прохода, по ней строится граф маршрутов. */
export const CorridorSchema = z
  .object({
    id: z.string().min(1),
    floor: z.number().int().min(1).max(99),
    bounds: BoundsSchema,
    name: z.string().optional(),
  })
  .strict();

export type Corridor = z.infer<typeof CorridorSchema>;

/* ================= вертикальная связь ================= */

/**
 * Лестница или лифт. Связь считается установленной, если объект с тем же id
 * стоит на всех перечисленных этажах и совпадает по координатам.
 */
export const VerticalLinkSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['stairs', 'lift', 'ramp']),
    name: z.string().min(1),
    bounds: BoundsSchema,
    /** Этажи, которые связь соединяет; минимум два, по возрастанию, без повторов. */
    connects: z.array(z.number().int().min(1).max(99)).min(2),
    /** Доступно ли для маломобильных посетителей. */
    accessible: z.boolean(),
    /** Подтверждена ли доступность школой. */
    accessibilityConfirmed: z.boolean(),
  })
  .strict()
  .refine((v) => v.connects.every((f, i, a) => i === 0 || (a[i - 1] ?? -Infinity) < f), {
    message: 'этажи связи должны идти по возрастанию и без повторов',
    path: ['connects'],
  });

export type VerticalLink = z.infer<typeof VerticalLinkSchema>;

/* ================= узел графа навигации ================= */

/**
 * Узел графа маршрутов. Данные этажей узлы не содержат: граф строит `src/nav/`
 * по коридорам, дверям и вертикальным связям. Схема нужна как контракт между
 * генератором графа и его потребителями (маршруты, ассистент, аналитика).
 */
export const NavNodeSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(['door', 'corridor', 'junction', 'vertical']),
    floor: z.number().int().min(1).max(99),
    x: finite(),
    z: finite(),
    /** Идентификатор объекта, к которому привязан узел: помещение, коридор, связь. */
    ref: z.string().min(1).optional(),
    /** Соседние узлы. Рёбра неориентированные: связь должна быть указана с обеих сторон. */
    links: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type NavNode = z.infer<typeof NavNodeSchema>;

/* ================= этаж ================= */

export const FloorSchema = z
  .object({
    level: z.number().int().min(1).max(99),
    name: z.string().min(1),
    /** Отметка пола, метры от уровня земли. */
    elevation: finite(),
    /** Высота этажа в свету + перекрытие, метры. */
    height: finite().positive(),
    /**
     * Известна ли планировка. `false` — этаж заведён оболочкой и вертикальными
     * связями, помещений нет и выдумывать их нельзя.
     */
    layoutKnown: z.boolean(),
    rooms: z.array(RoomSchema),
    corridors: z.array(CorridorSchema),
    vertical: z.array(VerticalLinkSchema),
    navNodes: z.array(NavNodeSchema).optional(),
  })
  .strict()
  .superRefine((floor, ctx) => {
    if (!floor.layoutKnown && floor.rooms.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rooms'],
        message: 'у этажа с layoutKnown: false не может быть помещений',
      });
    }
    floor.rooms.forEach((room, i) => {
      if (room.floor !== floor.level) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rooms', i, 'floor'],
          message: `помещение «${room.id}» лежит в файле этажа ${floor.level}, а floor = ${room.floor}`,
        });
      }
    });
    floor.corridors.forEach((corr, i) => {
      if (corr.floor !== floor.level) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['corridors', i, 'floor'],
          message: `коридор «${corr.id}» лежит в файле этажа ${floor.level}, а floor = ${corr.floor}`,
        });
      }
    });
  });

export type Floor = z.infer<typeof FloorSchema>;

/* ================= здание ================= */

/** Пересчёт координат плана (мм) в метры сцены. */
export const PlanTransformSchema = z
  .object({
    /** Начало координат плана в мм: точка, которая станет x = 0, z = 0. */
    originMm: z.object({ x: finite(), y: finite() }).strict(),
    /** Сколько миллиметров плана в одной единице сцены. */
    mmPerUnit: finite().positive(),
    /** Формулы пересчёта — для человека, который будет снимать новые числа. */
    formula: z.string().min(1),
  })
  .strict();

/* ================= оболочка: числа этого здания ================= */

/**
 * Габариты оболочки, снятые с чертежа именно этого здания. Блок целиком
 * необязателен, и каждое поле в нём необязательно: движок читает то, что есть,
 * а на остальное берёт свои запасные значения. Так конкретные размеры уезжают
 * из кода в данные, не ломая ни старые файлы, ни здания без входной группы.
 *
 * Соглашения блока:
 *   — `y` — отметка центра элемента над полом первого этажа, метры;
 *   — `offsets` — смещения по X от центра входной группы, метры;
 *   — `depth` — вынос от плоскости фасада, `inset` — вычет из ширины проёма;
 *   — `zOffset` у вывески — вынос от наружной грани южной стены.
 */
const PlacedBoxSchema = z
  .object({
    y: finite().optional(),
    width: finite().positive().optional(),
    height: finite().positive().optional(),
    depth: finite().positive().optional(),
    inset: finite().nonnegative().optional(),
  })
  .strict();

const RepeatedBoxSchema = PlacedBoxSchema.extend({
  /** Смещения по X от центра входной группы, метры. */
  offsets: z.array(finite()).optional(),
}).strict();

export const EntranceEnvelopeSchema = z
  .object({
    portal: PlacedBoxSchema.optional(),
    glazing: PlacedBoxSchema.optional(),
    transom: PlacedBoxSchema.optional(),
    /** Импосты витража входной группы. */
    mullions: RepeatedBoxSchema.optional(),
    /** Ручки входных дверей. */
    handles: RepeatedBoxSchema.optional(),
    pylon: PlacedBoxSchema.optional(),
    showcase: PlacedBoxSchema.optional(),
    showcaseGlass: PlacedBoxSchema.optional(),
    showcaseShelf: PlacedBoxSchema.extend({
      count: z.number().int().positive().optional(),
      step: finite().positive().optional(),
      base: finite().optional(),
    })
      .strict()
      .optional(),
    band: PlacedBoxSchema.optional(),
  })
  .strict();

export const SignEnvelopeSchema = z
  .object({
    /** Доля ширины фасада от его центра: 0 — середина, −0.5 — западный торец. */
    x: finite().optional(),
    y: finite().optional(),
    /** Вынос от наружной грани стены, метры. */
    zOffset: finite().optional(),
    width: finite().positive().optional(),
    height: finite().positive().optional(),
  })
  .strict();

export const EnvelopeSchema = z
  .object({
    entrance: EntranceEnvelopeSchema.optional(),
    signs: z
      .object({
        number: SignEnvelopeSchema.optional(),
        title: SignEnvelopeSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Envelope = z.infer<typeof EnvelopeSchema>;

export const BuildingFloorRefSchema = z
  .object({
    level: z.number().int().min(1).max(99),
    file: z.string().min(1),
    layoutKnown: z.boolean(),
  })
  .strict();

export const BuildingSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/, 'идентификатор здания — строчные латиница, цифры, дефис'),
    name: z.string().min(1),
    shortName: z.string().min(1),
    units: z.literal('m'),
    /** Ось Y вверх — инвариант сцены, зафиксирован в данных, чтобы не потеряться при обмене. */
    up: z.literal('y'),
    size: SizeSchema,
    floorCount: z.number().int().min(1).max(99),
    floorHeight: finite().positive(),
    /** Габарит здания в плане: за него не должно выходить ни одно помещение. */
    footprint: BoundsSchema,
    origin: z
      .object({
        description: z.string().min(1),
        plan: PlanTransformSchema,
      })
      .strict(),
    floors: z.array(BuildingFloorRefSchema).min(1),
    sources: z.array(z.string().min(1)).min(1),
    /** Габариты оболочки этого здания; блок необязателен целиком. */
    envelope: EnvelopeSchema.optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.floors.length !== b.floorCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['floors'],
        message: `файлов этажей ${b.floors.length}, а floorCount = ${b.floorCount}`,
      });
    }
    const seen = new Set<number>();
    b.floors.forEach((f, i) => {
      if (f.level < 1 || f.level > b.floorCount) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['floors', i, 'level'],
          message: `этаж ${f.level} вне диапазона здания 1…${b.floorCount}`,
        });
      }
      if (seen.has(f.level)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['floors', i, 'level'],
          message: `этаж ${f.level} перечислен дважды`,
        });
      }
      seen.add(f.level);
    });
    const h = b.floorCount * b.floorHeight;
    if (Math.abs(h - b.size.height) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['size', 'height'],
        message: `высота ${b.size.height} не равна floorCount × floorHeight = ${h.toFixed(3)}`,
      });
    }
  });

export type Building = z.infer<typeof BuildingSchema>;

/**
 * Схема этажа, привязанная к паспорту конкретного здания: номер этажа обязан
 * лежать в диапазоне 1…floorCount, а отметка пола — соответствовать номеру.
 * Отдельная схема нужна потому, что диапазон этажей — свойство здания, а не типа.
 */
export function floorSchemaFor(building: Building) {
  return FloorSchema.superRefine((floor, ctx) => {
    if (floor.level < 1 || floor.level > building.floorCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['level'],
        message: `этаж ${floor.level} вне диапазона здания 1…${building.floorCount}`,
      });
    }
    const expected = (floor.level - 1) * building.floorHeight;
    if (Math.abs(floor.elevation - expected) > 0.01) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['elevation'],
        message: `отметка пола ${floor.elevation} не совпадает с расчётной ${expected.toFixed(2)}`,
      });
    }
    floor.vertical.forEach((v, i) => {
      if (!v.connects.includes(floor.level)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['vertical', i, 'connects'],
          message: `связь «${v.id}» лежит на этаже ${floor.level}, но его нет в списке connects`,
        });
      }
      v.connects.forEach((lvl) => {
        if (lvl > building.floorCount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['vertical', i, 'connects'],
            message: `связь «${v.id}» ведёт на этаж ${lvl}, которого нет в здании`,
          });
        }
      });
    });
  });
}

/**
 * Общий прямоугольник двух зон: положительные `dx`/`dz` — они накладываются,
 * отрицательные — между ними зазор такой ширины.
 */
export function overlapRect(a: Bounds, b: Bounds): { dx: number; dz: number } {
  return {
    dx: Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
    dz: Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0),
  };
}

/**
 * Площадь наложения двух зон, м². Допуск — не вычет из измерений, а порог
 * глубины проникновения: наложение мельче толщины стены считается стыком
 * (стены соседних помещений заведены в одну линию), а всё, что глубже, —
 * настоящим пересечением и считается целиком, без вычета.
 */
export function overlapArea(a: Bounds, b: Bounds, tolerance = WALL_TOLERANCE): number {
  const { dx, dz } = overlapRect(a, b);
  if (dx <= 0 || dz <= 0) return 0;
  if (Math.min(dx, dz) <= tolerance) return 0;
  return dx * dz;
}

/** Состыкованы ли две зоны: общая грань шириной не меньше прохода. */
export function joined(a: Bounds, b: Bounds, minWidth = PASSAGE_MIN): boolean {
  const { dx, dz } = overlapRect(a, b);
  if (dx >= minWidth && dz >= -WALL_TOLERANCE) return true;
  if (dz >= minWidth && dx >= -WALL_TOLERANCE) return true;
  return false;
}

/** Точка, куда выходит дверь: шаг наружу от грани помещения. */
export function doorOutside(door: Door, step = DOOR_REACH): { x: number; z: number } {
  switch (door.side) {
    case 'north':
      return { x: door.x, z: door.z - step };
    case 'south':
      return { x: door.x, z: door.z + step };
    case 'west':
      return { x: door.x - step, z: door.z };
    case 'east':
      return { x: door.x + step, z: door.z };
  }
}

/** Лежит ли точка внутри зоны с допуском. */
export function inside(zone: Bounds, x: number, z: number, tolerance = 0): boolean {
  return (
    x >= zone.x0 - tolerance &&
    x <= zone.x1 + tolerance &&
    z >= zone.z0 - tolerance &&
    z <= zone.z1 + tolerance
  );
}

/** Насколько прямоугольник вышел за габарит здания, метры (0 — не вышел). */
export function outsideFootprint(inner: Bounds, outer: Bounds): number {
  return Math.max(
    outer.x0 - inner.x0,
    inner.x1 - outer.x1,
    outer.z0 - inner.z0,
    inner.z1 - outer.z1,
    0,
  );
}
