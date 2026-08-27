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
  Vector3,
} from 'three';
import type { Object3D, WebGLProgramParametersWithUniforms } from 'three';
import type { LabelSpec } from '@building/source';

/**
 * Кегль растеризации. Подпись выводится высотой 1.7 м на экране телефона —
 * при кегле 84/40 полсотни подписей стоили 13 МБ видеопамяти, две трети всей
 * текстурной памяти сцены. 42/24 дают ту же читаемость и втрое меньше.
 */
const TITLE_SIZE = 42;
const SUBTITLE_SIZE = 24;
const TITLE_COLOR = '#143a8a';
const SUBTITLE_COLOR = '#3c3c3c';
const FONT = 'Arial, Helvetica, sans-serif';

/** Ширина атласа: дальше плитки переносятся на новую полку. */
const ATLAS_WIDTH = 1024;
/** Зазор между плитками: без него соседняя подпись подмешивается по краю. */
const GAP = 2;
/** Высота подписи в метрах: двухстрочная крупнее однострочной, как в прототипе. */
const TWO_LINE_HEIGHT = 1.7;
const ONE_LINE_HEIGHT = 1.0;
/** Порядок отрисовки: подписи поверх плит и перегородок. */
const RENDER_ORDER = 3;

interface Tile {
  canvas: HTMLCanvasElement;
  height: number;
}

/** Нарисовать одну подпись на отдельном холсте. Размер холста — по тексту. */
function drawTile(title: string, subtitle: string): Tile | undefined {
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
  if (canvas.width <= 14 || canvas.height <= 12) return undefined;

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
  return { canvas, height: title && subtitle ? TWO_LINE_HEIGHT : ONE_LINE_HEIGHT };
}

/**
 * Материал подписей: разворот к камере и выборка из атласа.
 *
 * Оба куска шейдера маленькие, но заменяют собой `Sprite`: именно из-за него
 * подпись была отдельным мешем. `customProgramCacheKey` обязателен — иначе
 * рендерер переиспользует программу обычного `MeshBasicMaterial`.
 */
class LabelMaterial extends MeshBasicMaterial {
  override onBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSize;
attribute vec4 aUvRect;
varying vec2 vAtlasUv;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4( 0.0, 0.0, 0.0, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
mvPosition = modelViewMatrix * mvPosition;
// Углы прибавляются уже в пространстве камеры: четырёхугольник всегда
// параллелен экрану, а его размер остаётся размером в метрах.
mvPosition.xy += position.xy * aSize;
gl_Position = projectionMatrix * mvPosition;
vAtlasUv = aUvRect.xy + uv * aUvRect.zw;`,
      );

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vAtlasUv;`)
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  diffuseColor *= texture2D( map, vAtlasUv );
#endif`,
      );
  }

  override customProgramCacheKey(): string {
    return 'label-atlas-billboard';
  }
}

export interface LabelLayer {
  mesh: InstancedMesh;
  /** Сколько подписей в слое: нужно замеру и тестам. */
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
  const drawn: { spec: LabelSpec; tile: Tile }[] = [];
  for (const spec of specs) {
    if (!spec.title && !spec.subtitle) continue;
    const tile = drawTile(spec.title, spec.subtitle);
    if (tile) drawn.push({ spec, tile });
  }
  if (drawn.length === 0) return undefined;

  // Раскладка полками: плитки идут слева направо, пока помещаются в ширину
  // атласа, потом переносятся на новую полку высотой в самую высокую плитку.
  const placed: { x: number; y: number; w: number; h: number }[] = [];
  let penX = GAP;
  let penY = GAP;
  let shelfHeight = 0;
  for (const item of drawn) {
    const w = item.tile.canvas.width;
    const h = item.tile.canvas.height;
    if (penX + w + GAP > ATLAS_WIDTH && penX > GAP) {
      penX = GAP;
      penY += shelfHeight + GAP;
      shelfHeight = 0;
    }
    placed.push({ x: penX, y: penY, w, h });
    penX += w + GAP;
    if (h > shelfHeight) shelfHeight = h;
  }
  const atlasHeight = penY + shelfHeight + GAP;

  const atlas = document.createElement('canvas');
  atlas.width = ATLAS_WIDTH;
  atlas.height = atlasHeight;
  const ctx = atlas.getContext('2d');
  if (ctx) {
    drawn.forEach((item, index) => {
      const box = placed[index];
      if (box) ctx.drawImage(item.tile.canvas, box.x, box.y);
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
  const mesh = new InstancedMesh(geometry, material, drawn.length);
  mesh.name = name;
  mesh.renderOrder = RENDER_ORDER;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  // Габарит меша ничего не значит: положение углов считает шейдер, а не
  // геометрия, и отсечение по пирамиде видимости выбросило бы слой целиком.
  mesh.frustumCulled = false;

  const sizes = new Float32Array(drawn.length * 2);
  const rects = new Float32Array(drawn.length * 4);
  const matrix = new Matrix4();
  const position = new Vector3();

  drawn.forEach((item, index) => {
    const box = placed[index];
    if (!box) return;
    position.set(item.spec.position.x, item.spec.position.y, item.spec.position.z);
    matrix.makeTranslation(position.x, position.y, position.z);
    mesh.setMatrixAt(index, matrix);

    const aspect = box.w / Math.max(box.h, 1);
    sizes[index * 2] = item.tile.height * aspect;
    sizes[index * 2 + 1] = item.tile.height;

    rects[index * 4] = box.x / atlas.width;
    rects[index * 4 + 1] = 1 - (box.y + box.h) / atlas.height;
    rects[index * 4 + 2] = box.w / atlas.width;
    rects[index * 4 + 3] = box.h / atlas.height;
  });
  mesh.instanceMatrix.needsUpdate = true;
  geometry.setAttribute('aSize', new InstancedBufferAttribute(sizes, 2));
  geometry.setAttribute('aUvRect', new InstancedBufferAttribute(rects, 4));

  target.add(mesh);

  return {
    mesh,
    count: drawn.length,
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
