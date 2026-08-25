/**
 * Вывески на фасаде: плоскость с текстовой текстурой.
 *
 * Текст приходит из данных здания (`SignPart.text`) — в коде движка нет ни
 * одного названия. Текстура генерируется один раз на строку и мемоизируется.
 */
import {
  CanvasTexture,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { Object3D } from 'three';
import type { SignPart, Side } from '@building/source';

/**
 * Предел ширины текстуры: одна строка не должна стоить мегабайт. При 2048
 * вывеска на фасаде в 17 м занимала 0.99 МБ видеопамяти ради одной строки —
 * текстура 2048 весит 1 МБ на подпись; 1024 дают 0.26 МБ, и разницы на фасаде не видно.
 */
const MAX_TEXTURE_WIDTH = 1024;
const MAX_TEXTURE_HEIGHT = 128;
const FONT = 'Arial, Helvetica, sans-serif';

/**
 * Поворот плоскости вокруг вертикали, радианы. `PlaneGeometry` смотрит в `+Z`,
 * то есть на юг: это единственная сторона, которую не надо разворачивать.
 * Без поворота вывеска на северной, восточной или западной стене легла бы
 * плашмя поперёк здания — дефект был не виден только потому, что процедурный
 * источник выпускал вывески на одной-единственной грани.
 */
const SIDE_ROTATION: Record<Side, number> = {
  south: 0,
  north: Math.PI,
  east: Math.PI / 2,
  west: -Math.PI / 2,
};

interface CachedSign {
  texture: CanvasTexture;
  material: MeshBasicMaterial;
}

const cache = new Map<string, CachedSign>();

function buildSign(spec: SignPart): CachedSign {
  const aspect = spec.width / spec.height;
  let height = Math.min(MAX_TEXTURE_HEIGHT, Math.floor(MAX_TEXTURE_WIDTH / aspect));
  height = Math.max(16, height);
  const width = Math.min(MAX_TEXTURE_WIDTH, Math.round(height * aspect));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = spec.color;
    ctx.font = `${spec.fill > 0.7 ? 'bold' : '600'} ${Math.round(height * spec.fill)}px ${FONT}`;
    ctx.fillText(spec.text, width / 2, height / 2, width - 4);
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new MeshBasicMaterial({ map: texture, transparent: true, side: DoubleSide });
  return { texture, material };
}

/** Фабрика вывесок. Геометрия плоскостей общая на размер. */
export class SignFactory {
  private readonly geometries = new Map<string, PlaneGeometry>();
  private readonly created: Mesh[] = [];

  create(spec: SignPart, target: Object3D): Mesh {
    const cacheKey = `${spec.text}|${spec.color}|${spec.fill}|${spec.width}x${spec.height}`;
    let entry = cache.get(cacheKey);
    if (!entry) {
      entry = buildSign(spec);
      cache.set(cacheKey, entry);
    }
    const geometryKey = `${spec.width}x${spec.height}`;
    let geometry = this.geometries.get(geometryKey);
    if (!geometry) {
      geometry = new PlaneGeometry(spec.width, spec.height);
      this.geometries.set(geometryKey, geometry);
    }
    const mesh = new Mesh(geometry, entry.material);
    mesh.name = spec.name;
    mesh.position.set(spec.center.x, spec.center.y, spec.center.z);
    mesh.rotation.y = SIDE_ROTATION[spec.side];
    target.add(mesh);
    this.created.push(mesh);
    return mesh;
  }

  dispose(): void {
    for (const mesh of this.created) mesh.removeFromParent();
    this.created.length = 0;
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
  }
}

/** Освободить общий кэш текстур вывесок. */
export function disposeSignCache(): void {
  for (const entry of cache.values()) {
    entry.material.dispose();
    entry.texture.dispose();
  }
  cache.clear();
}
