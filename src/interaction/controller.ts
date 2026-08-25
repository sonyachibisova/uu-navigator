/**
 * Взаимодействие: наведение, выбор помещения, переключение этажа, возврат
 * к общему виду.
 *
 * Модуль ничего не рисует и не трогает сцену напрямую — он меняет состояние
 * в сторе. Сцена подписана на стор и реагирует сама (`описание архитектуры проекта`).
 */
import { Vector3 } from 'three';
import type { Camera } from 'three';
import type { Store, SceneState } from '@core/state';
import type { BuildingHandle } from '@building/building';
import type { RoomView } from '@building/source';
import { RoomPicker } from '@interaction/picker';

export interface InteractionHandle {
  dispose: () => void;
}

export interface InteractionOptions {
  canvas: HTMLCanvasElement;
  camera: Camera;
  store: Store<SceneState>;
  building: BuildingHandle;
  /** Куда вести точку интереса камеры при выборе помещения. */
  focus: (point: Vector3) => void;
  /** Вернуть камеру к стартовой рамке: то же действие, что и кнопка «корпус целиком». */
  home: () => void;
}

/** Порог, за которым движение указателя считается вращением камеры, а не кликом. */
const DRAG_THRESHOLD = 6;

export function createInteraction(options: InteractionOptions): InteractionHandle {
  const { canvas, camera, store, building, focus, home } = options;
  const picker = new RoomPicker();
  const point = new Vector3();
  // Группы оболочки не меняются за жизнь здания: список считается один раз,
  // а не на каждое движение указателя.
  const occluders = building.occluders();
  let downX = 0;
  let downY = 0;
  let startedOnCanvas = false;

  function roomsOfActiveFloor(): readonly RoomView[] {
    const level = store.state.activeFloor;
    if (level === null) return [];
    return building.floors.find((floor) => floor.level === level)?.rooms ?? [];
  }

  function pickAt(event: PointerEvent | MouseEvent): string | null {
    const state = store.state;
    if (state.mode !== 'floor' || state.activeFloor === null) return null;
    const rect = canvas.getBoundingClientRect();
    const hit = picker.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      camera,
      building.pickTarget(state.activeFloor),
      roomsOfActiveFloor(),
      occluders,
    );
    return hit ? hit.room.id : null;
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.buttons !== 0 || event.target !== canvas) {
      if (store.state.hoveredRoomId !== null) store.set({ hoveredRoomId: null });
      return;
    }
    const id = pickAt(event);
    store.set({ hoveredRoomId: id });
    canvas.style.cursor = id ? 'pointer' : '';
  }

  function onPointerDown(event: PointerEvent): void {
    startedOnCanvas = event.target === canvas;
    downX = event.clientX;
    downY = event.clientY;
  }

  function onPointerUp(event: PointerEvent): void {
    if (!startedOnCanvas) return;
    startedOnCanvas = false;
    // Орбитальные контролы захватывают указатель, поэтому pointerup приходит не
    // в канвас, а в элемент захвата: слушаем на окне и сами отличаем клик от вращения.
    const dragged =
      Math.abs(event.clientX - downX) > DRAG_THRESHOLD ||
      Math.abs(event.clientY - downY) > DRAG_THRESHOLD;
    if (dragged) return;
    const id = pickAt(event);
    store.set({ selectedRoomId: id });
    if (id) {
      const room = building.roomById(id);
      if (room) {
        point.set(room.focus.x, room.focus.y, room.focus.z);
        focus(point);
      }
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape' || event.key === '0') {
      store.set({
        mode: 'whole',
        activeFloor: null,
        selectedRoomId: null,
        hoveredRoomId: null,
        isolate: false,
      });
      // Возврат ракурса — часть того же действия: состояние может не измениться,
      // а камера всё равно должна вернуться из-под земли или из-за километра.
      home();
      return;
    }
    if (event.key === 'i' || event.key === 'I' || event.key === 'ш' || event.key === 'Ш') {
      // Явный режим «изолировать этаж»: по умолчанию невыбранные приглушены.
      if (store.state.activeFloor !== null) store.set({ isolate: !store.state.isolate });
      return;
    }
    const level = Number.parseInt(event.key, 10);
    if (!Number.isNaN(level)) {
      const floor = building.floors.find((item) => item.level === level);
      if (floor && floor.layoutKnown) {
        store.set({ mode: 'floor', activeFloor: level, selectedRoomId: null, hoveredRoomId: null });
      }
    }
  }

  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('keydown', onKeyDown);

  return {
    dispose(): void {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
