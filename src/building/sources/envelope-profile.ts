/**
 * Профиль оболочки — пропорции наружной композиции здания.
 *
 * Здесь нет ни одного габарита: все положения заданы долями длины грани и
 * долями высоты этажа, а абсолютные метры оставлены только там, где размер
 * задаётся человеком, а не зданием (высота двери, толщина импоста, тротуар).
 * Поэтому один и тот же профиль работает и на здании в сто метров,
 * и на павильоне в двадцать.
 *
 * Профиль описывает композицию, а не здание, поэтому живёт в коде и общий для
 * всех зданий. Габариты конкретного здания — входная группа и вывески — приходят
 * блоком `envelope` из паспорта здания; схема этого блока лежит в `data/schema.ts`.
 * Схема профиля ниже описывает его форму на случай, когда пропорции тоже
 * понадобится задавать данными.
 */
import { z } from 'zod';

const frac = () => z.number().finite();
const positive = () => z.number().finite().positive();

/** Ряд проёмов на грани: где начинается, где кончается, сколько и какой заполненности. */
export const FaceGlazingSchema = z
  .object({
    /** Доля длины грани до первого проёма. */
    start: frac(),
    /** Доля длины грани до конца последнего проёма. */
    end: frac(),
    /** Число проёмов в ряду. */
    bays: z.number().int().positive(),
    /** Доля шага, занятая проёмом (остальное — простенок). */
    fill: frac(),
  })
  .strict();

export const EnvelopeProfileSchema = z
  .object({
    wall: z
      .object({
        north: positive(),
        south: positive(),
        east: positive(),
        west: positive(),
        /** Насколько западная облицовка выступает за габарит. */
        westOverhang: frac(),
      })
      .strict(),
    window: z
      .object({
        /** Высота проёма в долях высоты этажа. */
        height: frac(),
        /** Смещение подоконного пояса вниз от центра этажа, доли высоты этажа. */
        sillDrop: frac(),
        /** Высота подоконного пояса, доли высоты этажа. */
        sillHeight: frac(),
        /** Шаг импостов в метрах. */
        mullionStep: positive(),
      })
      .strict(),
    glazing: z.object({ south: FaceGlazingSchema, north: FaceGlazingSchema }).strict(),
    westWindows: z
      .object({
        /** Положения квадратных окон по глубине, доли глубины от центра. */
        offsets: z.array(frac()),
        /** Размер обрамления и стекла в долях высоты этажа. */
        frame: frac(),
        glass: frac(),
      })
      .strict(),
    east: z
      .object({
        /** Глубина витража в долях глубины здания. */
        glazing: frac(),
        /** Высота междуэтажного пояса, метры. */
        belt: positive(),
      })
      .strict(),
    cornice: z.object({ width: frac(), center: frac(), height: positive() }).strict(),
    insert: z.object({ width: frac(), center: frac() }).strict(),
    tower: z
      .object({
        center: frac(),
        width: positive(),
        jambOffset: positive(),
        jambWidth: positive(),
      })
      .strict(),
    porthole: z.object({ center: frac(), ring: positive(), glass: positive() }).strict().nullable(),
    entrance: z
      .object({
        /** Положение входной группы, доля длины грани от центра. */
        center: frac(),
        width: positive(),
        height: positive(),
        /** Пилоны по краям входа. */
        pylonWidth: positive(),
        pylonOffset: positive(),
        /** Витрина рядом со входом. */
        showcaseCenter: frac(),
        showcaseWidth: positive(),
        /** Цокольная лента. */
        bandCenter: frac(),
        bandWidth: positive(),
      })
      .strict()
      .nullable(),
    roof: z
      .object({
        slab: positive(),
        parapetHeight: positive(),
        parapetMargin: positive(),
        structures: z.array(
          z
            .object({
              width: frac(),
              depth: frac(),
              height: positive(),
              center: frac(),
              offset: frac(),
            })
            .strict(),
        ),
      })
      .strict(),
    columns: z
      .object({
        /** Число осей вдоль длинной стороны. */
        count: z.number().int().positive(),
        /** Доля длины здания от центра до крайней оси. */
        span: frac(),
        /** Поперечные оси, доли глубины от центра. */
        cross: z.array(frac()),
        width: positive(),
        depth: positive(),
      })
      .strict(),
  })
  .strict();

export type EnvelopeProfile = z.infer<typeof EnvelopeProfileSchema>;
export type FaceGlazing = z.infer<typeof FaceGlazingSchema>;

/**
 * Профиль по умолчанию: пропорции, снятые с рабочего прототипа
 *.
 */
export const DEFAULT_ENVELOPE_PROFILE: EnvelopeProfile = {
  wall: { north: 0.4, south: 0.4, east: 0.4, west: 0.3, westOverhang: 0.1 },
  window: { height: 0.806, sillDrop: 0.444, sillHeight: 0.069, mullionStep: 1.6 },
  glazing: {
    south: { start: 0.0748, end: 0.9845, bays: 15, fill: 0.775 },
    north: { start: 0.0142, end: 0.9845, bays: 16, fill: 0.786 },
  },
  westWindows: { offsets: [0.3, -0.3], frame: 1.028, glass: 0.944 },
  east: { glazing: 0.574, belt: 0.7 },
  cornice: { width: 0.683, center: 0.158, height: 0.7 },
  insert: { width: 0.267, center: -0.367 },
  tower: { center: -0.209, width: 3, jambOffset: 1.7, jambWidth: 0.4 },
  porthole: { center: -0.134, ring: 1.18, glass: 1 },
  entrance: {
    center: -0.126,
    width: 5.6,
    height: 3.8,
    pylonWidth: 0.8,
    pylonOffset: 2.9,
    showcaseCenter: -0.039,
    showcaseWidth: 4.2,
    bandCenter: 0.128,
    bandWidth: 15,
  },
  roof: {
    slab: 0.4,
    parapetHeight: 1,
    parapetMargin: 0.5,
    structures: [{ width: 0.076, depth: 0.251, height: 2.2, center: -0.079, offset: -0.1 }],
  },
  columns: {
    count: 18,
    span: 0.4919,
    cross: [0.476, 0.1615, -0.1615, -0.476],
    width: 0.35,
    depth: 0.55,
  },
};
