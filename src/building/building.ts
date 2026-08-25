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
   * Шаг анимации переходов. Возвращает `true`, если видимость или прозрачность
   * в этом кадре менялись, — по этому признаку пересчитывается теневая карта.
   */
  update: (dt: number) => boolean;
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

  const bands = source.bands();
  const floorViews = source.floors();

  const releaseShared = acquireSharedResources();
  const shell = createShell(bands, palette, fade);
  const roof = createRoof(source.roof(), palette, fade);
  const floors = createFloors(floorViews, palette, fade);

  scene.add(shell.shellGroup, shell.facadeGroup, roof.roofGroup, floors.floorsGroup);

  const passport = source.passport;
  const center = passportCenter(passport);

  function applyState(state: SceneState, immediate = false): void {
    const whole = state.mode === 'whole' || state.activeFloor === null;
    const set = (channel: string, value: number): void => {
      if (immediate) fade.setChannelImmediate(channel, value);
      else fade.setChannelTarget(channel, value);
    };
    for (const band of bands) {
      // Срез по потолку выбранного этажа: кольца выше уходят, нижние остаются.
      const visible = whole || band.level <= (state.activeFloor ?? band.level);
      set(shell.bandChannel(band.level), visible ? 1 : 0);
    }
    set(ROOF_CHANNEL, whole ? 1 : 0);
    floors.setStates(whole ? null : state.activeFloor, state.isolate, immediate);
    floors.highlight(state.hoveredRoomId, state.selectedRoomId);
  }

  return {
    passport,
    floors: floorViews,
    center: new Vector3(center.x, center.y, center.z),
    radius: passportRadius(passport),
    applyState,
    update(dt: number): boolean {
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
