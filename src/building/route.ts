/**
 * Отрисовка маршрута: лента по полу вдоль ломаной.
 *
 * Это пятая группа верхнего уровня — `routeGroup`. Инвариант 1 правил проекта
 * говорит про геометрию здания: её четыре группы, и маршрут в них не входит,
 * как не входят небо и земля (`@core/environment`). Маршрут — это ответ на
 * вопрос человека, а не часть корпуса: он появляется и исчезает, живёт своей
 * жизнью и пересобирается целиком при каждом изменении.
 *
 * Показывается только та часть маршрута, которая лежит на видимом сейчас
 * этаже. Иначе лента с пятого этажа висела бы в воздухе над четвёртым:
 * срез по этажу снимает всё выше, а маршрут об этом ничего не знал бы.
 */
import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  Mesh,
  MeshBasicMaterial,
} from 'three';
import type { Route } from '@routing/path';

/** Ширина ленты, метры: заметно, но не перекрывает подписи помещений. */
const WIDTH = 0.7;
/**
 * Высота ленты над полом этажа, метры. Плита помещения лежит на 0.28 —
 * лента обязана быть выше, иначе она уходит под плиту и не видна вовсе
 * (проверено кадром: маршрут считался, а на экране его не было).
 * Подписи начинаются с 2.5, так что места достаточно.
 */
const LIFT = 0.36;
/**
 * Шаг между стрелками вдоль ленты, метры, и размер стрелки. Направление
 * иначе не читается вовсе: лента одинаковая с обоих концов, и человек,
 * посмотревший на неё без карточки, не знает, куда идти.
 */
const ARROW_STEP = 9;
const ARROW_LENGTH = 1.6;
const ARROW_HALF_WIDTH = 0.62;

/** Порядок отрисовки: поверх плит, под подписями. */
const RENDER_ORDER = 2;
/**
 * Цвет ленты — тот же кислотный лайм, что у главных кнопок и выбранного этажа:
 * в интерфейсе он значит «путь» и больше ничего, а в интерьере таких тонов нет.
 * Читается лента не яркостью цвета, а полосами: см. волну ниже.
 */
const COLOR = 0xd8ff3e;
/**
 * Длина волны и скорость бегущей подсветки: метры и метры в секунду.
 * Стрелки говорят, куда идти, стоя на месте; движение говорит то же самое
 * боковым зрением, и человеку не приходится вглядываться в ленту.
 */
const WAVE_LENGTH = 6;
const WAVE_SPEED = 3.5;

export interface RouteHandle {
  group: Group;
  /** Шаг анимации: по ленте бежит волна в сторону движения. */
  update: (dt: number) => void;
  /**
   * Показать маршрут. `activeLevel` — этаж, срез по которому включён сейчас;
   * `null` означает «здание целиком», и тогда видны все части маршрута.
   */
  show: (route: Route | undefined, activeLevel: number | null) => void;
  dispose: () => void;
}

/**
 * Высота пола этажа. Передаётся снаружи, потому что маршрут не должен знать
 * ни про паспорт здания, ни про источник данных.
 */
export type FloorElevation = (level: number) => number;

export function createRoute(elevationOf: FloorElevation): RouteHandle {
  const group = new Group();
  group.name = 'routeGroup';

  // Обе стороны видимы намеренно: обход четырёхугольника зависит от того,
  // куда повернуло звено маршрута, и при односторонней грани половина ленты
  // отсекалась бы как «изнанка». Проверено кадром: маршрут считался, шаги
  // печатались, а на экране не было ничего.
  const material = new MeshBasicMaterial({
    color: COLOR,
    transparent: true,
    opacity: 0.92,
    side: DoubleSide,
  });
  material.depthWrite = false;
  // Материал ленты никем не клонируется — она не в `FadeRegistry`, — поэтому
  // здесь достаточно обычного `onBeforeCompile` с собственной униформой.
  const time = { value: 0 };
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uTime'] = time;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aDistance;\nvarying float vDistance;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvDistance = aDistance;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform float uTime;\nvarying float vDistance;',
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
// Бегущая волна вдоль пути: яркость, а не прозрачность, — прозрачная
// лента на светлом полу теряется, а более яркая полоса видна всегда.
float wave = 0.5 + 0.5 * sin( ( vDistance - uTime * ${WAVE_SPEED.toFixed(1)} ) * ${(6.2831853 / WAVE_LENGTH).toFixed(4)} );
// Размах намеренно большой: лайм светлый, и на светлом полу его держит
// не сам тон, а тёмные промежутки между полосами.
gl_FragColor.rgb *= 0.42 + 0.58 * wave;`,
      );
  };
  material.customProgramCacheKey = () => 'route-ribbon-wave';
  // Один буфер на всё время жизни: новый `BufferAttribute` на каждую
  // пересборку оставлял бы прежний VBO в видеопамяти — рендерер удаляет
  // буферы только при разрушении геометрии, а маршрут пересобирается
  // на каждую смену этажа и режима.
  const geometry = new BufferGeometry();
  /**
   * Ёмкость буфера с запасом: маршрут через всё здание — это сотня звеньев,
   * то есть меньше тысячи вершин со стрелками. Буфер выделяется один раз
   * и больше не подменяется: подмена атрибута оставляла бы прежний буфер
   * в видеопамяти — рендерер освобождает их только при разрушении геометрии.
   */
  const CAPACITY = 4096;
  const vertices = new Float32Array(CAPACITY * 3);
  const attribute = new BufferAttribute(vertices, 3);
  attribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  /** Пройденный путь до вершины, метры: по нему бежит волна. */
  const distances = new Float32Array(CAPACITY);
  const distanceAttribute = new BufferAttribute(distances, 1);
  distanceAttribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aDistance', distanceAttribute);

  const mesh = new Mesh(geometry, material);
  mesh.name = 'route.ribbon';
  mesh.renderOrder = RENDER_ORDER;
  mesh.frustumCulled = false;
  mesh.visible = false;
  group.add(mesh);

  function show(route: Route | undefined, activeLevel: number | null): void {
    const legs = route?.legs.filter((leg) => activeLevel === null || leg.level === activeLevel);
    if (!legs || legs.length === 0) {
      mesh.visible = false;
      return;
    }

    // Лента собирается по четырёхугольнику на звено. Стыки не срезаются:
    // на ширине 0.7 м и углах коридоров это меньше сантиметра расхождения,
    // а честное построение стыка стоило бы вдвое больше кода.
    const positions: number[] = [];
    const along: number[] = [];
    for (const leg of legs) {
      const y = elevationOf(leg.level) + LIFT;
      // Стрелки расставляются по пройденному пути, а не по звеньям: иначе
      // на длинном коридоре их не было бы вовсе, а на коротких — сплошняком.
      let travelled = 0;
      let nextArrow = ARROW_STEP / 2;
      for (let i = 1; i < leg.points.length; i += 1) {
        const from = leg.points[i - 1];
        const to = leg.points[i];
        if (!from || !to) continue;
        const dx = to.x - from.x;
        const dz = to.z - from.z;
        const length = Math.hypot(dx, dz);
        if (length < 1e-4) continue;
        // Нормаль в плане: половина ширины ленты влево и вправо от звена.
        const nx = (-dz / length) * (WIDTH / 2);
        const nz = (dx / length) * (WIDTH / 2);
        const ax = from.x + nx;
        const az = from.z + nz;
        const bx = from.x - nx;
        const bz = from.z - nz;
        const cx = to.x - nx;
        const cz = to.z - nz;
        const ex = to.x + nx;
        const ez = to.z + nz;
        positions.push(ax, y, az, bx, y, bz, cx, y, cz);
        positions.push(ax, y, az, cx, y, cz, ex, y, ez);
        const startAt = travelled;
        const endAt = travelled + length;
        along.push(startAt, startAt, endAt, startAt, endAt, endAt);

        const ux = dx / length;
        const uz = dz / length;
        const arrowY = y + 0.01;
        while (nextArrow <= travelled + length) {
          const at = nextArrow - travelled;
          const px = from.x + ux * at;
          const pz = from.z + uz * at;
          // Треугольник остриём вперёд: основание поперёк ленты, вершина
          // на пол-шага дальше по ходу движения.
          positions.push(px + ux * (ARROW_LENGTH / 2), arrowY, pz + uz * (ARROW_LENGTH / 2));
          positions.push(
            px - ux * (ARROW_LENGTH / 2) + -uz * ARROW_HALF_WIDTH,
            arrowY,
            pz - uz * (ARROW_LENGTH / 2) + ux * ARROW_HALF_WIDTH,
          );
          positions.push(
            px - ux * (ARROW_LENGTH / 2) - -uz * ARROW_HALF_WIDTH,
            arrowY,
            pz - uz * (ARROW_LENGTH / 2) - ux * ARROW_HALF_WIDTH,
          );
          // Стрелка светится вместе с тем местом ленты, где стоит.
          along.push(nextArrow, nextArrow, nextArrow);
          nextArrow += ARROW_STEP;
        }
        travelled += length;
      }
    }

    if (positions.length === 0) {
      mesh.visible = false;
      return;
    }
    // Длиннее буфера маршрут быть не может: лента обрезается, а не растёт
    // за пределы выделенного — иначе пришлось бы подменять буфер в кадре.
    const count = Math.min(positions.length / 3, CAPACITY);
    vertices.set(positions.slice(0, count * 3));
    distances.set(along.slice(0, count));
    attribute.needsUpdate = true;
    distanceAttribute.needsUpdate = true;
    // Габарит не считается: меш не отсекается по пирамиде видимости, и
    // проход по всем вершинам ради никем не читаемой сферы был бы лишним.
    geometry.setDrawRange(0, count);
    mesh.visible = true;
  }

  return {
    group,
    update(dt: number): void {
      // Время не растёт бесконечно: волна периодична, и на длинном сеансе
      // большое число потеряло бы точность прямо в шейдере.
      if (mesh.visible) time.value = (time.value + dt) % (WAVE_LENGTH / WAVE_SPEED);
    },
    show,
    dispose(): void {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}
