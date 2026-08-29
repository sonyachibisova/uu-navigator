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
import type { Material, Texture } from 'three';
import type { RoomPurpose, SurfaceKey } from '@building/source';

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

/** Цвет плиты пола по назначению помещения. Ключи — словарь `data/schema.ts`. */
const PURPOSE_COLOR: Record<RoomPurpose, number> = {
  studio: 0xe0bd7e,
  workshop: 0xe09a78,
  lecture: 0x96cf8b,
  class: 0x96cf8b,
  lab: 0x7fb2e0,
  gallery: 0xe6dcb8,
  library: 0x6cc7ba,
  cowork: 0xe6dcb8,
  office: 0xb99fdc,
  admin: 0xd9c45e,
  lobby: 0xeae6dc,
  cafe: 0xe09a78,
  shop: 0xb99fdc,
  wc: 0x7dc0dc,
  storage: 0xbdbdb2,
  tech: 0xaeaea4,
};

export interface Palette {
  surface: (key: SurfaceKey) => Material;
  /** Базовый материал кликабельных плит: цвет приходит per-instance. */
  plate: Material;
  purposeColor: (purpose: RoomPurpose) => Color;
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
    stair: new MeshLambertMaterial({ color: 0xcfc6ae }),
  };
  for (const [key, material] of Object.entries(surfaces)) material.name = `surface.${key}`;

  const plate = new MeshLambertMaterial({ color: 0xffffff });
  plate.name = 'surface.plate';

  const colorCache = new Map<RoomPurpose, Color>();

  return {
    surface: (key) => surfaces[key],
    plate,
    purposeColor(purpose) {
      let color = colorCache.get(purpose);
      if (!color) {
        color = new Color(PURPOSE_COLOR[purpose] ?? 0xcccccc);
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
  return `#${(PURPOSE_COLOR[purpose] ?? 0xcccccc).toString(16).padStart(6, '0')}`;
}

/** Цвета вертикальных связей в легенде. */
export const VERTICAL_CSS: Record<'stairs' | 'lift', string> = {
  lift: '#e6c05c',
  stairs: '#cfc6ae',
};
