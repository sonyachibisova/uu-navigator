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
/**
 * Тот же порог для пальца. Палец на тапе смещается заметно больше мыши,
 * и на шести пикселях вращение то и дело читалось как выбор.
 */
const TOUCH_DRAG_THRESHOLD = 12;
/**
 * Степень раскрытия, начиная с которой клик по помещению разрешён в режиме
 * «здание целиком». Пока оболочка цела, интерьера за ней не видно, и попадание
 * по плите означало бы выбор помещения сквозь глухую стену.
 */
const PICKABLE_OPENNESS = 0.35;

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
  /** Сколько указателей сейчас на экране: по двум пальцам выбор не делается. */
  let activePointers = 0;
  /** Был ли за время касания второй палец — пинч не должен выбирать помещение. */
  let multiTouch = false;

  function pickAt(event: PointerEvent | MouseEvent): string | null {
    const state = store.state;
    // Режим больше не решает, есть ли кликабельный слой: в «здании целиком»
    // интерьеры видны сквозь растворённые грани, и клик по ним обязан работать.
    // Он решает только, чем ограничен выбор — одним этажом или всеми сразу.
    const level = state.mode === 'floor' ? state.activeFloor : null;
    if (level === null && building.openness() < PICKABLE_OPENNESS) return null;
    const rect = canvas.getBoundingClientRect();
    const hit = picker.pick(
      event.clientX - rect.left,
      event.clientY - rect.top,
      rect.width,
      rect.height,
      camera,
      building.pickTargets(level),
      occluders,
    );
    return hit ? hit.room.id : null;
  }

  /**
   * Наведение обрабатывается не чаще кадра. Мышь шлёт события сотнями в
   * секунду, а каждое из них — это принудительный пересчёт раскладки
   * (`getBoundingClientRect`) и полный луч по плитам и оболочке. На телефоне
   * это незаметно (при касании обработчик выходит сразу), на ноутбуке —
   * сотня лишних лучей в секунду просто за движение мышью.
   */
  let hoverPending: PointerEvent | undefined;
  let hoverFrame = 0;

  function handleHover(): void {
    hoverFrame = 0;
    const event = hoverPending;
    hoverPending = undefined;
    if (!event) return;
    const id = pickAt(event);
    store.set({ hoveredRoomId: id });
    canvas.style.cursor = id ? 'pointer' : '';
  }

  function onPointerMove(event: PointerEvent): void {
    if (event.buttons !== 0 || event.target !== canvas) {
      hoverPending = undefined;
      if (store.state.hoveredRoomId !== null) store.set({ hoveredRoomId: null });
      return;
    }
    hoverPending = event;
    if (hoverFrame === 0) hoverFrame = requestAnimationFrame(handleHover);
  }

  function onPointerDown(event: PointerEvent): void {
    activePointers += 1;
    if (activePointers > 1) multiTouch = true;
    if (activePointers > 1) return;
    multiTouch = false;
    startedOnCanvas = event.target === canvas;
    downX = event.clientX;
    downY = event.clientY;
  }

  /** Указатель ушёл с экрана — как обычным отпусканием, так и отменой. */
  function releasePointer(): void {
    activePointers = Math.max(0, activePointers - 1);
  }

  function onPointerUp(event: PointerEvent): void {
    releasePointer();
    // Приближение двумя пальцами — основной жест разглядывания: один из них
    // почти не двигается и раньше открывал карточку случайного помещения.
    if (multiTouch) {
      if (activePointers === 0) multiTouch = false;
      startedOnCanvas = false;
      return;
    }
    if (!startedOnCanvas) return;
    startedOnCanvas = false;
    // Орбитальные контролы захватывают указатель, поэтому pointerup приходит не
    // в канвас, а в элемент захвата: слушаем на окне и сами отличаем клик от вращения.
    const threshold = event.pointerType === 'touch' ? TOUCH_DRAG_THRESHOLD : DRAG_THRESHOLD;
    const dragged =
      Math.abs(event.clientX - downX) > threshold || Math.abs(event.clientY - downY) > threshold;
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

  /** Набирают текст: клавиши принадлежат полю, а не сцене. */
  function typingInField(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  function onKeyDown(event: KeyboardEvent): void {
    // Человек набирает «4.09» в поиске: «4» переключала этаж, «0» сбрасывала
    // вид к общему и уводила камеру домой. Ровно тот сценарий, ради которого
    // поиск и делался, ломал сцену под пальцем.
    if (typingInField(event.target)) return;
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
  window.addEventListener('pointercancel', releasePointer);
  window.addEventListener('keydown', onKeyDown);

  return {
    dispose(): void {
      if (hoverFrame !== 0) cancelAnimationFrame(hoverFrame);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', releasePointer);
      window.removeEventListener('keydown', onKeyDown);
    },
  };
}
