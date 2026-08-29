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
/** Порядок отрисовки: подписи поверх плит и перегородок. */
const RENDER_ORDER = 3;

/**
 * Высота подписи в метрах. Крупная — только номер: он обязан читаться на плане
 * этажа целиком, поэтому берётся заметно больше прежнего. Полная — номер плюс
 * название, размер прежний, как в прототипе; однострочная — всё остальное.
 */
const NUMBER_HEIGHT = 3.6;
const FULL_HEIGHT = 1.7;
const SINGLE_HEIGHT = 1.2;

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

/** Сообщить движку, какую долю ширины кадра занимает интерфейс справа. */
export function setLabelEdge(fraction: number): void {
  edgeUniform.value = Math.min(Math.max(1 - fraction * 2, 0), 1);
}

interface Entry {
  canvas: HTMLCanvasElement;
  /** Высота подписи в метрах. */
  height: number;
  position: { x: number; y: number; z: number };
  /** Пороги проявления и ухода: `[появиться от, до, уйти от, до]`, ноль — не уходит. */
  range: [number, number, number, number];
}

/** Измерительный контекст: один на модуль, а не по холсту на каждую подпись. */
let measureContext: CanvasRenderingContext2D | null | undefined;

/** Нарисовать одну подпись на отдельном холсте. Размер холста — по тексту. */
function drawTile(title: string, subtitle: string): HTMLCanvasElement | undefined {
  if (measureContext === undefined) {
    measureContext = document.createElement('canvas').getContext('2d');
  }
  const measure = measureContext;
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
  return canvas;
}

/** Развернуть одну подпись в экземпляры: крупный номер и номер с названием. */
function entriesOf(spec: LabelSpec): Entry[] {
  const out: Entry[] = [];
  const both = Boolean(spec.title) && Boolean(spec.subtitle);

  if (spec.title) {
    const canvas = drawTile(spec.title, '');
    if (canvas) {
      out.push({
        canvas,
        height: both ? NUMBER_HEIGHT : SINGLE_HEIGHT,
        position: spec.position,
        // Номер уходит только там, где его сменяет полная подпись.
        range: both
          ? [
              NUMBER_IN[0],
              NUMBER_IN[1],
              (FULL_IN[0] * NUMBER_HEIGHT) / FULL_HEIGHT,
              (FULL_IN[1] * NUMBER_HEIGHT) / FULL_HEIGHT,
            ]
          : [NUMBER_IN[0], NUMBER_IN[1], 0, 0],
      });
    }
  }

  if (spec.subtitle) {
    const canvas = drawTile(spec.title, spec.subtitle);
    if (canvas) {
      out.push({
        canvas,
        height: both ? FULL_HEIGHT : SINGLE_HEIGHT,
        position: spec.position,
        range: both ? [FULL_IN[0], FULL_IN[1], 0, 0] : [NUMBER_IN[0], NUMBER_IN[1], 0, 0],
      });
    }
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
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute vec2 aSize;
attribute vec4 aUvRect;
attribute vec4 aRange;
uniform float uEdge;
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
mvPosition.xy += position.xy * aSize * step( 0.001, vLabelAlpha );
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
