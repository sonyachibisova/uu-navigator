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
import type { BuildingPassport, BuildingSource, FloorView, RoomView } from '@building/source';
import { passportCenter, passportRadius } from '@building/source';

export interface BuildingHandle {
  passport: BuildingPassport;
  /** Этажи так, как их видит интерфейс: номер, название, известна ли планировка. */
  floors: FloorView[];
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
  /** Кликабельный слой активного этажа для raycasting. */
  pickTarget: (level: number | null) => InstancedMesh | undefined;
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
    radius,
    shell.fragments,
    { instant },
  );

  /** Последнее применённое состояние: из него берётся срез по этажу. */
  let applied: SceneState | undefined;

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
    const whole = state.mode === 'whole' || state.activeFloor === null;
    const set = (channel: string, value: number): void => {
      if (immediate) fade.setChannelImmediate(channel, value);
      else fade.setChannelTarget(channel, value);
    };
    shell.fragments.forEach((fragment, index) => {
      // Срез по потолку выбранного этажа: кольца выше уходят, нижние остаются.
      const ring = whole || fragment.level <= (state.activeFloor ?? fragment.level) ? 1 : 0;
      set(fragment.channel, ring * (1 - dollhouse.dissolve(index)));
    });
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

  function applyState(state: SceneState, immediate = false): void {
    applied = state;
    floors.highlight(state.hoveredRoomId, state.selectedRoomId);
    compose(immediate || instant);
  }

  return {
    passport,
    floors: floorViews,
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
    pickTarget(level): InstancedMesh | undefined {
      if (level === null) return undefined;
      return floors.byLevel(level)?.plates;
    },
    occluders: () => [shell.shellGroup, shell.facadeGroup, roof.roofGroup],
    dispose(): void {
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
