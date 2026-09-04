/**
 * Сборка здания из `BuildingSource` и реакция на состояние приложения.
 *
 * В сцену кладутся ровно четыре группы здания (инвариант 1 правил проекта):
 * `shellGroup`, `facadeGroup`, `roofGroup`, `floorsGroup`. Ни один меш здания
 * не создаётся вне них. Окружение (небо, свет, земля) к зданию не относится
 * и живёт отдельной группой `environment` — см. `src/core/environment.ts`.
 *
 * Наружу модуль отдаёт только `applyState` и `update`: сцену снаружи никто
 * не дёргает напрямую, всё идёт через стор состояния.
 */
import { Vector3 } from 'three';
import type { InstancedMesh, Object3D, Scene } from 'three';
import { FadeRegistry } from '@core/fade';
import { createDollhouse } from '@core/dollhouse';
import { prefersReducedMotion } from '@core/motion';
import type { SceneState } from '@core/state';
import { createPalette } from '@building/materials';
import { acquireSharedResources } from '@building/resources';
import { createShell } from '@building/shell';
import { ROOF_CHANNEL, createRoof } from '@building/roof';
import { createFloors } from '@building/floors';
import type { VerticalPlace } from '@building/floors';
import type {
  BuildingPassport,
  BuildingSource,
  EntranceView,
  FloorView,
  RoomView,
} from '@building/source';
import { passportCenter, passportRadius } from '@building/source';

/**
 * Кликабельный слой одного этажа: плита помещений и сами помещения в порядке
 * `instanceId`. Слой отдаётся наружу уже собранным, потому что raycasting идёт
 * на каждое движение указателя и не должен ничего собирать заново.
 */
export interface PickLayer {
  mesh: InstancedMesh;
  rooms: readonly RoomView[];
}

/** Пустой набор слоёв: константа, чтобы не создавать массив на каждый промах. */
const NO_LAYERS: readonly PickLayer[] = [];

export interface BuildingHandle {
  passport: BuildingPassport;
  /** Этажи так, как их видит интерфейс: номер, название, известна ли планировка. */
  floors: FloorView[];
  /** Вход в здание, если источник его знает: с него начинается путь с улицы. */
  entrance: EntranceView | undefined;
  center: Vector3;
  radius: number;
  /**
   * Применить состояние: срез по этажу, подсветка, выбранное помещение.
   * `immediate` — без анимации: стартовый кадр не должен начинаться с того,
   * что верхние кольца и кровля полсекунды растворяются на глазах.
   */
  applyState: (state: SceneState, immediate?: boolean) => void;
  /**
   * Шаг кадра: кукольный дом пересчитывается по положению камеры и текущей
   * дистанции обзора, после чего идёт шаг анимации переходов. Возвращает `true`, если видимость или
   * прозрачность в этом кадре менялись, — по этому признаку пересчитывается
   * теневая карта.
   */
  update: (dt: number, cameraPosition: Vector3, overviewDistance: number) => boolean;
  roomById: (id: string) => RoomView | undefined;
  /** Лестница или лифт по идентификатору: их ищут наравне с помещениями. */
  verticalById: (id: string) => VerticalPlace | undefined;
  /** Все лестницы и лифты здания. */
  verticalPlaces: () => VerticalPlace[];
  /**
   * Кликабельные слои для raycasting. `level` — выбранный этаж; `null` означает
   * «здание целиком», и тогда кликабельны все этажи с известной планировкой:
   * в этом ракурсе интерьеры видны, и клик по ним обязан работать.
   */
  pickTargets: (level: number | null) => readonly PickLayer[];
  /**
   * Степень раскрытия кукольного дома `t ∈ [0,1]`. Нужна взаимодействию как
   * условие «интерьер проявился, клик разрешён»: пока оболочка цела, помещений
   * за ней не видно и попадать по ним нельзя.
   */
  openness: () => number;
  /**
   * Непрозрачные группы, которые могут закрывать помещение от курсора:
   * оболочка, навесной фасад и кровля. Нужны, чтобы клик не проходил сквозь стену.
   */
  occluders: () => Object3D[];
  dispose: () => void;
}

export function createBuilding(scene: Scene, source: BuildingSource): BuildingHandle {
  const palette = createPalette();
  const fade = new FadeRegistry();

  const floorViews = source.floors();

  const releaseShared = acquireSharedResources();
  const shell = createShell(source.bands(), palette, fade);
  const roof = createRoof(source.roof(), palette, fade);
  const floors = createFloors(floorViews, palette, fade);

  scene.add(shell.shellGroup, shell.facadeGroup, roof.roofGroup, floors.floorsGroup);

  const passport = source.passport;
  const center = passportCenter(passport);
  const radius = passportRadius(passport);

  // Анимацию можно выключить настройкой системы: конечная картинка от этого
  // не меняется, меняется только то, доезжает она плавно или сразу.
  const instant = prefersReducedMotion();
  const dollhouse = createDollhouse(
    new Vector3(center.x, passport.size.height / 2, center.z),
    new Vector3(
      (passport.footprint.x1 - passport.footprint.x0) / 2,
      passport.size.height / 2,
      (passport.footprint.z1 - passport.footprint.z0) / 2,
    ),
    radius,
    shell.fragments,
    { instant },
  );

  /** Последнее применённое состояние: из него берётся срез по этажу. */
  let applied: SceneState | undefined;
  /** Применять ли текущую сборку мгновенно. Читается замыканием `set`. */
  let immediateNow = false;

  /**
   * Отдать величину каналу. Замыкание поднято в область фабрики намеренно:
   * `compose()` вызывается каждый кадр, и создавать в нём функцию — единственная
   * аллокация, которая там оставалась.
   */
  function set(channel: string, value: number): void {
    if (immediateNow) fade.setChannelImmediate(channel, value);
    else fade.setChannelTarget(channel, value);
  }

  /**
   * Собрать прозрачность и отдать её в `FadeRegistry`.
   *
   * Здесь единственное место, где срез по этажу и кукольный дом встречаются,
   * и встречаются они произведением, а не двумя записями в один `opacity`:
   * срез решает, какие кольца оболочки и какая кровля видимы вообще (0 или 1),
   * кукольный дом — насколько прозрачна каждая грань в пределах видимых.
   */
  function compose(immediate: boolean): void {
    const state = applied;
    if (!state) return;
    immediateNow = immediate;
    const whole = state.mode === 'whole' || state.activeFloor === null;
    const fragments = shell.fragments;
    for (let index = 0; index < fragments.length; index += 1) {
      const fragment = fragments[index];
      if (!fragment) continue;
      // Срез по потолку выбранного этажа: кольца выше уходят, нижние остаются.
      // Условие вынесено в отдельное имя: `||` вплотную к `?:` читается неоднозначно.
      const cut = state.activeFloor ?? fragment.level;
      const ring = whole || fragment.level <= cut ? 1 : 0;
      // В режиме этажа раскрытие человек уже выбрал кнопкой, и гасить его
      // множителем близости камеры нельзя: иначе ближняя стена выбранного
      // этажа остаётся глухой — не пропускает ни взгляд, ни клик. Грань всё
      // равно растворяется только тогда, когда смотрит на камеру.
      const reveal = whole ? dollhouse.dissolve(index) : dollhouse.facing(index);
      set(fragment.channel, ring * (1 - reveal));
    }
    // Кровля уходит и от среза по этажу, и от взгляда сверху — но опять одним
    // произведением: у её прозрачности один хозяин.
    set(ROOF_CHANNEL, (whole ? 1 : 0) * (1 - dollhouse.roofLift()));
    floors.setStates(
      whole ? null : state.activeFloor,
      state.isolate,
      immediate,
      dollhouse.openness(),
    );
  }

  // Набор окклюдеров не меняется за жизнь здания: массив собирается один раз
  // и отдаётся наружу как есть, без копии на каждый опрос.
  const occluderGroups: Object3D[] = [shell.shellGroup, shell.facadeGroup, roof.roofGroup];

  // Кликабельные слои собираются один раз: raycasting идёт на каждое движение
  // указателя, и собирать наборы в этот момент нельзя.
  const allPickLayers: PickLayer[] = [];
  const pickLayersByLevel = new Map<number, readonly PickLayer[]>();
  for (const floor of floors.floors) {
    if (!floor.plates) continue;
    const layer: PickLayer = { mesh: floor.plates, rooms: floor.rooms };
    allPickLayers.push(layer);
    pickLayersByLevel.set(floor.level, [layer]);
  }

  function applyState(state: SceneState, immediate = false): void {
    applied = state;
    floors.highlight(state.hoveredRoomId, state.selectedRoomId);
    compose(immediate || instant);
  }

  return {
    passport,
    floors: floorViews,
    entrance: source.entrance?.(),
    center: new Vector3(center.x, center.y, center.z),
    radius,
    applyState,
    update(dt: number, cameraPosition: Vector3, overviewDistance: number): boolean {
      dollhouse.update(cameraPosition, dt, overviewDistance);
      compose(instant);
      fade.update(dt);
      return fade.consumeDirty();
    },
    roomById: floors.roomById,
    verticalById: floors.verticalById,
    verticalPlaces: floors.verticalPlaces,
    pickTargets(level): readonly PickLayer[] {
      if (level === null) return allPickLayers;
      return pickLayersByLevel.get(level) ?? NO_LAYERS;
    },
    openness: () => dollhouse.openness(),
    occluders: () => occluderGroups,
    dispose(): void {
      // Ссылки на снятые меши не должны пережить здание: и кликабельные слои,
      // и окклюдеры держат их напрямую.
      allPickLayers.length = 0;
      pickLayersByLevel.clear();
      occluderGroups.length = 0;
      floors.dispose();
      roof.dispose();
      shell.dispose();
      fade.dispose();
      palette.dispose();
      // Общие ресурсы освобождает последний, кто их держал: другое здание на
      // экране кампуса может пользоваться ими прямо сейчас.
      releaseShared();
    },
  };
}
