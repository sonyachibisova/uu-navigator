/**
 * Подписи помещений — спрайты с текстом, как в прототипе.
 *
 * Текстуры мемоизируются по содержимому: одинаковые подписи (лестница, лифт,
 * повторяющиеся названия) делят одну текстуру и один материал.
 */
import { CanvasTexture, SRGBColorSpace, Sprite, SpriteMaterial } from 'three';
import type { Object3D } from 'three';
import type { LabelSpec } from '@building/source';

/**
 * Кегль растеризации. Подпись выводится высотой 1.7 м на экране телефона —
 * при кегле 84/40 полсотни подписей стоили 13 МБ видеопамяти, две трети всей
 * текстурной памяти сцены. 42/24 дают ту же читаемость и 3.3 МБ.
 */
const TITLE_SIZE = 42;
const SUBTITLE_SIZE = 24;
const TITLE_COLOR = '#143a8a';
const SUBTITLE_COLOR = '#3c3c3c';
const FONT = 'Arial, Helvetica, sans-serif';

interface CachedLabel {
  texture: CanvasTexture;
  material: SpriteMaterial;
  aspect: number;
}

const cache = new Map<string, CachedLabel>();

function buildTexture(title: string, subtitle: string): CachedLabel {
  const measure = document.createElement('canvas').getContext('2d');
  let titleWidth = 0;
  let subtitleWidth = 0;
  if (measure) {
    measure.font = `700 ${TITLE_SIZE}px ${FONT}`;
    titleWidth = title ? measure.measureText(title).width : 0;
    measure.font = `600 ${SUBTITLE_SIZE}px ${FONT}`;
    subtitleWidth = subtitle ? measure.measureText(subtitle).width : 0;
  }

  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(Math.max(titleWidth, subtitleWidth)) + 14;
  canvas.height = (title ? TITLE_SIZE : 0) + (subtitle ? SUBTITLE_SIZE + 7 : 0) + 12;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    let y = 5;
    if (title) {
      ctx.font = `700 ${TITLE_SIZE}px ${FONT}`;
      ctx.fillStyle = TITLE_COLOR;
      ctx.fillText(title, canvas.width / 2, y);
      y += TITLE_SIZE + 4;
    }
    if (subtitle) {
      ctx.font = `600 ${SUBTITLE_SIZE}px ${FONT}`;
      ctx.fillStyle = SUBTITLE_COLOR;
      ctx.fillText(subtitle, canvas.width / 2, y);
    }
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({ map: texture, depthTest: true });
  return { texture, material, aspect: canvas.width / Math.max(canvas.height, 1) };
}

/** Фабрика подписей: создаёт спрайты и снимает их разом при разборке этажа. */
export class LabelFactory {
  private readonly created: Sprite[] = [];

  create(spec: LabelSpec, target: Object3D): Sprite | undefined {
    if (!spec.title && !spec.subtitle) return undefined;
    const key = `${spec.title}\u0000${spec.subtitle}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = buildTexture(spec.title, spec.subtitle);
      cache.set(key, entry);
    }

    const sprite = new Sprite(entry.material);
    sprite.name = spec.name;
    // Высота подписи в метрах: двухстрочная крупнее однострочной, как в прототипе.
    const height = spec.title && spec.subtitle ? 1.7 : 1.0;
    sprite.scale.set(height * entry.aspect, height, 1);
    sprite.position.set(spec.position.x, spec.position.y, spec.position.z);
    sprite.renderOrder = 3;
    target.add(sprite);
    this.created.push(sprite);
    return sprite;
  }

  dispose(): void {
    for (const sprite of this.created) sprite.removeFromParent();
    this.created.length = 0;
  }
}

/** Освободить общий кэш текстур подписей. */
export function disposeLabelCache(): void {
  for (const entry of cache.values()) {
    entry.material.dispose();
    entry.texture.dispose();
  }
  cache.clear();
}
