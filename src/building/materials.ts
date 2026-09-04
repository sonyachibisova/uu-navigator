/**
 * Палитра поверхностей. Значения перенесены из прототипа без изменений:
 * палитра поверхностей вынесена сюда целиком, чтобы её можно было заменить темой здания.
 *
 * Палитра описывает роли поверхностей («кирпич», «панель», «перегородка»),
 * а не конкретное здание: какое здание какой ролью пользуется — решают данные.
 *
 * Все материалы здесь — общие инстансы. Фейдящиеся меши получают клоны
 * через `FadeRegistry` (инвариант 3), общий инстанс никогда не мутируется.
 */
import {
  CanvasTexture,
  Color,
  MeshLambertMaterial,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import type { Material, Texture, WebGLProgramParametersWithUniforms } from 'three';
import type { RoomPurpose, SurfaceKey } from '@building/source';
import { LOOK } from '@core/look';

/** Текстуры генерируются один раз на приложение (иначе они пересоздаются на каждый меш). */
let brickTexture: CanvasTexture | undefined;
let panelTexture: CanvasTexture | undefined;

function makeBrickTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#9c8b7a';
    ctx.fillRect(0, 0, 256, 256);
    const bw = 32;
    const bh = 16;
    for (let row = 0; row < 256 / bh; row += 1) {
      const offset = (row % 2) * (bw / 2);
      for (let col = -1; col <= 256 / bw; col += 1) {
        const t = 0.85 + Math.random() * 0.3;
        ctx.fillStyle = `rgb(${(127 * t) | 0},${(107 * t) | 0},${(90 * t) | 0})`;
        ctx.fillRect(col * bw + offset + 1, row * bh + 1, bw - 2, bh - 2);
      }
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(16, 4);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makePanelTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#e9e7e2';
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = '#c6c4bd';
    ctx.lineWidth = 4;
    for (let y = 0; y <= 512; y += 64) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(512, y);
      ctx.stroke();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(3, 3);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * Цвет плиты пола по назначению помещения. Ключи — словарь `data/schema.ts`.
 *
 * Цвета разведены по различимости, а не подобраны на глаз. Мерой служит
 * ΔE00: у прежнего набора худшая пара «Администрация ↔ Лифт» давала 4.9,
 * то есть один и тот же жёлтый для человека, который сверяет план с
 * легендой; «Компьютерные классы ↔ Санузлы» — 8.0, один и тот же голубой.
 * Здесь худшая пара — 10.3, и это при сохранённом языке палитры: оттенки
 * сдвинуты, а не заменены, лифт остался золотым (к нему привязаны наклейки),
 * контраст подписи на плите нигде не ниже 4.6:1.
 *
 * Полностью развести двенадцать приглушённых цветов до ΔE00 ≥ 12 подкруткой
 * нельзя — это пересборка палитры, и она за художником. То же про
 * дейтеранопию: там худшая пара по-прежнему 4.3, помечено в бэклоге.
 */
const PURPOSE_COLOR: Record<RoomPurpose, number> = {
  studio: 0xc98a4b,
  workshop: 0xb5654a,
  lecture: 0x7fa98c,
  class: 0xa9c07f,
  lab: 0x5a7fa8,
  gallery: 0xe0cd9c,
  library: 0x3e8f86,
  cowork: 0xa9bcc0,
  office: 0x8e7ba8,
  admin: 0xb2a465,
  lobby: 0xe8e4dc,
  cafe: 0x8f4636,
  shop: 0x6f5f92,
  wc: 0x6e9aaa,
  storage: 0xadaca3,
  tech: 0xadaca3,
};
/**
 * Серая шкала, вариант А — четыре ступени.
 *
 * Ступени разведены по светлоте, а не по оттенку: у нейтральных серых разница
 * светлоты и есть весь контраст целиком. Назначения, которые в данных нигде
 * не стоят стена в стену, делят одну ступень — разводить их не за чем.
 * Минимальная разница светлоты у соседей — ΔL* 17; у цветной палитры худшая
 * пара давала 10, то есть шкала не ухудшает разборчивость, а улучшает её.
 *
 * Назначения, которых в данных здания нет (лекторий, коворкинг, вестибюль,
 * кафе, магазин), поставлены на ступень по роду занятия: как только они
 * появятся в данных, ступень проверяется заново перебором по соседям.
 */
const GREY_A: Record<RoomPurpose, number> = {
  // L* 34
  studio: 0x505050,
  library: 0x505050,
  gallery: 0x505050,
  cafe: 0x505050,
  // L* 51
  class: 0x797979,
  office: 0x797979,
  tech: 0x797979,
  admin: 0x797979,
  lecture: 0x797979,
  // L* 68
  lab: 0xa6a6a6,
  wc: 0xa6a6a6,
  workshop: 0xa6a6a6,
  cowork: 0xa6a6a6,
  shop: 0xa6a6a6,
  // L* 85
  storage: 0xd4d4d4,
  lobby: 0xd4d4d4,
};

/**
 * Серая шкала, вариант Б — свой оттенок каждому назначению.
 *
 * Одиннадцать серых, собранных в те же четыре ступени по три-четыре близких
 * значения: внутри ступени разница ΔL* 1–2 (различима, когда плиты рядом),
 * между ступенями — те же 17. Плюс варианта в том, что легенда однозначна;
 * минус — соседние оттенки одной ступени сами по себе почти не различаются.
 */
const GREY_B: Record<RoomPurpose, number> = {
  studio: 0x505050,
  library: 0x525252,
  gallery: 0x555555,
  cafe: 0x575757,
  class: 0x797979,
  tech: 0x7c7c7c,
  admin: 0x7f7f7f,
  lecture: 0x818181,
  lab: 0xa6a6a6,
  wc: 0xa8a8a8,
  workshop: 0xababab,
  cowork: 0xaeaeae,
  shop: 0xb0b0b0,
  office: 0xd4d4d4,
  storage: 0xd7d7d7,
  lobby: 0xdadada,
};

/** Действующий набор цветов плит — по выбору облика. */
function plateColors(): Record<RoomPurpose, number> {
  if (LOOK.floorPalette === 'greyA') return GREY_A;
  if (LOOK.floorPalette === 'greyB') return GREY_B;
  return PURPOSE_COLOR;
}

/**
 * Разделительная линия между плитами, метры.
 *
 * Две плиты одного назначения стена в стену сливаются в одно пятно — на серой
 * шкале это видно резче, чем на цветной, потому что оттенок больше не выдаёт
 * границу. Линия рисуется по краю самой плиты и ничего не стоит: ни меша,
 * ни треугольника, ни draw call — только несколько строк во фрагментном шейдере.
 */
const PLATE_LINE_WIDTH = 0.1;
/** Насколько кромка темнее плиты. Ноль — линии нет. */
const PLATE_LINE_DEPTH = 0.55;
/** Цвет, к которому уводится кромка: почти чёрный, одинаково работает на всех ступенях. */
const PLATE_LINE_COLOR = { r: 0.09, g: 0.1, b: 0.11 };

/**
 * Материал плиты помещения с разделительной кромкой.
 *
 * Подкласс, а не `onBeforeCompile` на готовом инстансе: `FadeRegistry`
 * клонирует материал при регистрации, а `Material.clone()` не переносит
 * собственные свойства объекта — метод же живёт в прототипе и клонирование
 * переживает. Тот же приём, что у подписей.
 *
 * Размер плиты берётся из матрицы экземпляра, а не из отдельного атрибута:
 * геометрия у плит общая (unit-куб на всё здание), и класть в неё
 * поэкземплярные данные нельзя — её делят с оболочкой и перегородками.
 */
class PlateMaterial extends MeshLambertMaterial {
  override onBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
    const width = LOOK.floorPalette === 'color' ? 0 : PLATE_LINE_WIDTH;
    if (width <= 0) return;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlateEdge;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
// Расстояние от точки до ближайшего края плиты, в метрах. Габарит плиты —
// длина базисных векторов матрицы экземпляра: unit-куб масштабирован ею.
vec2 plateSize = vec2( 1.0 );
#ifdef USE_INSTANCING
  plateSize = vec2( length( instanceMatrix[ 0 ].xyz ), length( instanceMatrix[ 2 ].xyz ) );
#endif
vPlateEdge = ( vec2( 0.5 ) - abs( position.xz ) ) * plateSize;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vPlateEdge;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float edgeDistance = min( vPlateEdge.x, vPlateEdge.y );
  float onLine = 1.0 - smoothstep( ${(width * 0.55).toFixed(3)}, ${width.toFixed(3)}, edgeDistance );
  diffuseColor.rgb = mix(
    diffuseColor.rgb,
    vec3( ${PLATE_LINE_COLOR.r}, ${PLATE_LINE_COLOR.g}, ${PLATE_LINE_COLOR.b} ),
    onLine * ${PLATE_LINE_DEPTH}
  );
}`,
      );
  }

  override customProgramCacheKey(): string {
    return `plate-divider-${LOOK.floorPalette}`;
  }
}

export interface Palette {
  surface: (key: SurfaceKey) => Material;
  /** Базовый материал кликабельных плит: цвет приходит per-instance. */
  plate: Material;
  purposeColor: (purpose: RoomPurpose) => Color;
  /**
   * Цвет поверхности строкой `#rrggbb`. Нужен подписям: в варианте без плашки
   * цвет цифры считается от того, что под ней, а под подписью лестницы лежит
   * не плита помещения, а сама лестница.
   */
  surfaceHex: (key: SurfaceKey) => string;
  dispose: () => void;
}

export function createPalette(): Palette {
  brickTexture ??= makeBrickTexture();
  panelTexture ??= makePanelTexture();

  // Матовые интерьерные поверхности — `MeshLambertMaterial`: у них нет ни
  // карты, ни металличности, ни отражений, и физически корректное освещение
  // считать для них не за что. На мобильной видеокарте оно стоит примерно
  // вдвое дороже ламбертова при неотличимой картинке, а интерьеры занимают
  // почти весь экран в режиме этажа. `MeshStandardMaterial` остаётся там,
  // где виден его смысл: кирпич и панель с картой, стекло и металл.
  const surfaces: Record<SurfaceKey, Material> = {
    brick: new MeshStandardMaterial({ map: brickTexture, roughness: 0.95 }),
    panel: new MeshStandardMaterial({ map: panelTexture, roughness: 0.85 }),
    plaster: new MeshLambertMaterial({ color: 0xeceae4 }),
    glassTinted: new MeshStandardMaterial({ color: 0x2c3e50, roughness: 0.18, metalness: 0.6 }),
    glassDark: new MeshStandardMaterial({ color: 0x0e1216, roughness: 0.25, metalness: 0.5 }),
    glassClear: new MeshStandardMaterial({
      color: 0x9fc5d8,
      transparent: true,
      opacity: 0.35,
      roughness: 0.1,
      metalness: 0.3,
    }),
    accent: new MeshLambertMaterial({ color: 0x5c2430 }),
    trim: new MeshLambertMaterial({ color: 0x2a2d31 }),
    slab: new MeshLambertMaterial({ color: 0xb8b6b0 }),
    partition: new MeshLambertMaterial({ color: 0xe8e6e0 }),
    door: new MeshLambertMaterial({ color: 0xb0703a }),
    corridor: new MeshLambertMaterial({ color: 0xeae6dc }),
    lift: new MeshStandardMaterial({ color: 0xe6c05c, roughness: 0.5, metalness: 0.3 }),
    stair: new MeshLambertMaterial({ color: 0xdac4ad }),
  };
  for (const [key, material] of Object.entries(surfaces)) material.name = `surface.${key}`;

  const plate = new PlateMaterial({ color: 0xffffff });
  plate.name = 'surface.plate';

  const colorCache = new Map<RoomPurpose, Color>();

  const FALLBACK_HEX = '#cccccc';

  return {
    surface: (key) => surfaces[key],
    plate,
    surfaceHex(key) {
      const material = surfaces[key] as { color?: Color };
      return material.color ? `#${material.color.getHexString()}` : FALLBACK_HEX;
    },
    purposeColor(purpose) {
      let color = colorCache.get(purpose);
      if (!color) {
        color = new Color(plateColors()[purpose] ?? 0xcccccc);
        colorCache.set(purpose, color);
      }
      return color;
    },
    dispose(): void {
      for (const material of Object.values(surfaces)) material.dispose();
      plate.dispose();
    },
  };
}

/** Освободить общие текстуры (переживают отдельные палитры). */
export function disposeSharedTextures(): void {
  const textures: (Texture | undefined)[] = [brickTexture, panelTexture];
  for (const texture of textures) texture?.dispose();
  brickTexture = undefined;
  panelTexture = undefined;
}

/** Цвет назначения в виде CSS-строки — для легенды интерфейса. */
export function purposeCss(purpose: RoomPurpose): string {
  return `#${(plateColors()[purpose] ?? 0xcccccc).toString(16).padStart(6, '0')}`;
}

/** Цвета вертикальных связей в легенде. */
export const VERTICAL_CSS: Record<'stairs' | 'lift', string> = {
  lift: '#d9a93a',
  stairs: '#c9b39a',
};
