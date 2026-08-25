/**
 * FadeRegistry — единственное место, где меняется прозрачность мешей.
 *
 * Инварианты рендера (правила проекта, пункты 3, 5, 6), которые тут выполняются:
 *
 *  — материал фейдящегося меша всегда клон: реестр клонирует материал при
 *    регистрации, и общий инстанс из палитры никогда не мутируется;
 *  — `transparent: true` живёт только на время перехода: при полной
 *    непрозрачности возвращается `false`, при нуле меш получает `visible = false`;
 *  — `depthWrite` не дёргается по порогу каждый кадр: он выключается один раз
 *    при входе в переход и включается один раз при выходе из него;
 *  — сглаживание идёт по времени кадра (`damp`), а не по числу кадров, поэтому
 *    скорость перехода не зависит от FPS.
 *
 * Единица реестра — один меш («канал» лишь группирует их для управления).
 * Это сделано на вырост: сейчас каналом является кольцо этажа, в следующем
 * будущем каналом станет отдельная грань оболочки в режиме кукольного дома.
 */
import { MathUtils } from 'three';
import type { Material, Object3D } from 'three';

/** Погрешность, ниже которой считаем переход завершённым. */
const EPS = 0.004;
/** Скорость сглаживания: λ в `damp`. 9 ≈ прежний коэффициент 0.14 на кадр при 60 FPS. */
const DEFAULT_LAMBDA = 9;

interface MaterialRecord {
  material: Material;
  /** Непрозрачность материала в «полностью видимом» состоянии. */
  baseOpacity: number;
  /** Материал прозрачен сам по себе (стекло): `transparent` с него снимать нельзя. */
  intrinsic: boolean;
}

interface FadeUnit {
  name: string;
  channel: string;
  object: Object3D;
  materials: MaterialRecord[];
  current: number;
  target: number;
  /** Последнее применённое состояние: чтобы не трогать материалы каждый кадр впустую. */
  applied: number;
  /** В переходе ли мы сейчас — по этому флагу переключается `depthWrite`. */
  inTransition: boolean;
  /** Отбрасывал ли меш тень изначально. */
  castShadow: boolean;
}

function isMeshLike(object: Object3D): object is Object3D & { material: Material | Material[] } {
  return 'material' in object && (object as { material?: unknown }).material !== undefined;
}

export class FadeRegistry {
  private readonly units: FadeUnit[] = [];
  private readonly byChannel = new Map<string, FadeUnit[]>();
  private readonly lambda: number;
  /** Менялось ли что-нибудь с прошлого опроса: по этому флагу пересчитывается тень. */
  private dirty = true;

  constructor(lambda: number = DEFAULT_LAMBDA) {
    this.lambda = lambda;
  }

  /**
   * Забрать признак «в этом кадре видимость или прозрачность менялись» и сбросить его.
   * Теневая карта пересчитывается только по нему: солнце и геометрия статичны,
   * поэтому в установившемся кадре теневого прохода нет вовсе.
   */
  consumeDirty(): boolean {
    const was = this.dirty;
    this.dirty = false;
    return was;
  }

  /**
   * Зарегистрировать меш. Материалы клонируются: с этого момента меш владеет
   * своими материалами и реестр обязан их освободить в `dispose()`.
   */
  add(object: Object3D, channel: string, initial = 1): void {
    if (!isMeshLike(object)) return;
    const source = Array.isArray(object.material) ? object.material : [object.material];
    const clones = source.map((material) => material.clone());
    object.material = Array.isArray(object.material) ? clones : (clones[0] as Material);

    const unit: FadeUnit = {
      name: object.name,
      channel,
      object,
      materials: clones.map((material) => {
        const withOpacity = material as Material & { opacity: number };
        return {
          material,
          baseOpacity: material.transparent ? withOpacity.opacity : 1,
          intrinsic: material.transparent,
        };
      }),
      current: initial,
      target: initial,
      applied: Number.NaN,
      inTransition: false,
      castShadow: object.castShadow,
    };
    // depthWrite ставится один раз здесь: у собственно прозрачных материалов
    // (стекло, вывески) он выключен с самого начала, а не с первого перехода.
    for (const record of unit.materials) record.material.depthWrite = !record.intrinsic;
    this.units.push(unit);
    const list = this.byChannel.get(channel);
    if (list) list.push(unit);
    else this.byChannel.set(channel, [unit]);
    this.apply(unit, initial);
  }

  /** Задать цель прозрачности каналу. Значение 1 — виден, 0 — растворён. */
  setChannelTarget(channel: string, target: number): void {
    const list = this.byChannel.get(channel);
    if (!list) return;
    for (const unit of list) unit.target = MathUtils.clamp(target, 0, 1);
  }

  /** Мгновенно установить состояние канала — при инициализации, без анимации. */
  setChannelImmediate(channel: string, value: number): void {
    const list = this.byChannel.get(channel);
    if (!list) return;
    const v = MathUtils.clamp(value, 0, 1);
    for (const unit of list) {
      unit.target = v;
      unit.current = v;
      this.apply(unit, v);
    }
  }

  /** Известен ли такой канал. */
  hasChannel(channel: string): boolean {
    return this.byChannel.has(channel);
  }

  /** Шаг анимации. `dt` — время кадра в секундах. */
  update(dt: number): void {
    for (const unit of this.units) {
      if (Math.abs(unit.current - unit.target) <= EPS) {
        if (unit.current !== unit.target) {
          unit.current = unit.target;
          this.apply(unit, unit.current);
        }
        continue;
      }
      unit.current = MathUtils.damp(unit.current, unit.target, this.lambda, dt);
      this.apply(unit, unit.current);
    }
  }

  /** Освободить клонированные материалы. Геометрию реестр не трогает — она чужая. */
  dispose(): void {
    for (const unit of this.units) {
      for (const record of unit.materials) record.material.dispose();
    }
    this.units.length = 0;
    this.byChannel.clear();
  }

  /** Применить величину перехода к мешу и его материалам. */
  private apply(unit: FadeUnit, t: number): void {
    if (unit.applied === t) return;
    unit.applied = t;
    this.dirty = true;

    const opaque = t >= 1 - EPS;
    const gone = t <= EPS;

    // Материалы досчитываются всегда, в том числе при полном растворении, и
    // только потом меш гасится. Обратный порядок оставлял бы растворённый меш
    // с `transparent === false` и `opacity === 1`, если канал увели в ноль одним
    // шагом (`setChannelImmediate`): видно его не было, но `Raycaster` не
    // смотрит на `visible`, и такая стена продолжала бы ловить луч и закрывать
    // помещение от курсора.
    const transition = !opaque;
    if (transition !== unit.inTransition) {
      unit.inTransition = transition;
      // depthWrite меняется ровно на границе перехода — один раз, не каждый кадр.
      for (const record of unit.materials) {
        record.material.depthWrite = !transition && !record.intrinsic;
      }
    }

    for (const record of unit.materials) {
      const material = record.material as Material & { opacity: number };
      const wantTransparent = record.intrinsic || !opaque;
      if (material.transparent !== wantTransparent) {
        material.transparent = wantTransparent;
        material.needsUpdate = true;
      }
      material.opacity = opaque ? record.baseOpacity : t * record.baseOpacity;
    }

    unit.object.visible = !gone;
    // Тень от полупрозрачного меша выглядит как тень от сплошного — на время
    // перехода её снимаем, как это делал прототип.
    unit.object.castShadow = unit.castShadow && opaque;
  }
}
