/**
 * Точка входа: собирает источник данных, сцену, взаимодействие и интерфейс.
 *
 * Здесь нет ни одного числа про конкретное здание: всё приходит из
 * `ProceduralSource`, который читает `data/`.
 *
 * Заглушка загрузки `#boot` из разметки живёт до первого отрисованного кадра.
 * Если сцена не запустилась, она же превращается в объяснение — чёрный экран
 * человеку не показывается ни при какой ошибке.
 */
import { Scene, Vector3 } from 'three';
import { createCamera } from '@core/camera';
import { createRenderer } from '@core/renderer';
import type { RendererHandle } from '@core/renderer';
import { createEnvironment } from '@core/environment';
import { createLoop } from '@core/loop';
import { createSceneStore } from '@core/state';
import { initDebugOverlay } from '@core/debug-overlay';
import { createBuilding } from '@building/building';
import { BuildingDataError, ProceduralSource } from '@building/sources/procedural';
import { createInteraction } from '@interaction/controller';
import { createUi } from '@ui/minimal';

/**
 * Полуразмер окна вокруг найденного помещения, метры. Взято около половины
 * ширины корпуса: в кадр попадает само помещение, оба соседних и коридор —
 * то есть человек видит, откуда в него заходить, а не только его самого.
 */
const ROOM_WINDOW = 16;

/** Текст для человека, у которого не запустилась 3D-графика. */
const NO_WEBGL_TEXT =
  'Ваш браузер не показывает 3D-графику. ' +
  'Откройте ссылку в другом браузере или на другом устройстве.';
/** Текст для человека, у которого не сошлись данные здания. */
const NO_DATA_TEXT = 'Не удалось загрузить план, обновите страницу.';

/** Подробности показываются только при ?debug=1: посетителю они не нужны. */
function isDebug(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

/** Перевести заглушку загрузки в состояние ошибки и положить в неё объяснение. */
function showBootError(message: string): void {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.classList.add('boot--error');
  boot.removeAttribute('hidden');
  const text = boot.querySelector('.boot-text');
  if (text) {
    text.textContent = message;
    return;
  }
  const paragraph = document.createElement('p');
  paragraph.textContent = message;
  boot.appendChild(paragraph);
}

/** Показать список правок по данным — отладочный экран, не для посетителя. */
function renderDataError(root: HTMLElement, error: BuildingDataError): void {
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'inset:24px',
    'overflow:auto',
    'padding:20px 24px',
    'background:#1b1b1e',
    'color:#f2e9e4',
    'border-radius:12px',
    'font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace',
    'z-index:10',
  ].join(';');
  const title = document.createElement('div');
  title.style.cssText = 'font-size:16px;margin-bottom:12px;color:#ff9c8a';
  title.textContent = 'Данные здания не прошли проверку. Список правок:';
  panel.appendChild(title);
  const list = document.createElement('ul');
  for (const issue of error.issues) {
    const item = document.createElement('li');
    item.textContent = issue;
    list.appendChild(item);
  }
  panel.appendChild(list);
  root.appendChild(panel);
}

function main(): void {
  const container = document.getElementById('scene');
  const overlayRoot = document.getElementById('overlay-root') ?? document.body;
  if (!container) throw new Error('В разметке нет контейнера сцены #scene');

  let source: ProceduralSource;
  try {
    source = new ProceduralSource();
  } catch (error) {
    if (error instanceof BuildingDataError) {
      if (isDebug()) {
        document.getElementById('boot')?.remove();
        renderDataError(overlayRoot, error);
      } else {
        showBootError(NO_DATA_TEXT);
      }
      return;
    }
    throw error;
  }

  const scene = new Scene();
  const passport = source.passport;
  const footprint = passport.footprint;
  const frame = {
    center: new Vector3((footprint.x0 + footprint.x1) / 2, 0, (footprint.z0 + footprint.z1) / 2),
    radius: Math.max(footprint.x1 - footprint.x0, footprint.z1 - footprint.z0) / 2,
    height: passport.size.height,
    width: footprint.x1 - footprint.x0,
    depth: footprint.z1 - footprint.z0,
  };

  const cameraHandle = createCamera(frame, container);

  let rendererHandle: RendererHandle;
  try {
    rendererHandle = createRenderer(container, cameraHandle.camera);
  } catch (error) {
    // WebGL недоступен или заблокирован: вместо чёрного экрана — объяснение.
    console.error(error);
    showBootError(NO_WEBGL_TEXT);
    cameraHandle.dispose();
    return;
  }

  const environment = createEnvironment(scene, { ...frame, footprint }, rendererHandle.renderer);
  const building = createBuilding(scene, source);

  const store = createSceneStore();
  store.subscribe((next, prev) => {
    building.applyState(next);
    // Выбран этаж — камера кадрирует именно его. Рамка общего вида считается
    // по зданию вместе с высотой, и в ней план этажа занимает четверть экрана.
    if (next.activeFloor !== null && next.activeFloor !== prev.activeFloor) {
      const floor = building.floors.find((item) => item.level === next.activeFloor);
      if (floor) cameraHandle.frameFloor(floor.elevation + floor.height / 2, floor.height);
    }
    // Кнопка «корпус целиком» возвращает и состояние, и ракурс: она снимает
    // выбранный этаж, помещение и подсветку разом, и это её единственный признак.
    // Признак опирается только на срез по этажу: снятие выбранного помещения
    // само по себе ракурс не трогает. Иначе клик по пустому месту в общем виде,
    // где помещения теперь кликаются, отбрасывал бы камеру к стартовой рамке.
    const cleared =
      next.mode === 'whole' && next.activeFloor === null && next.selectedRoomId === null;
    const hadSomething = prev.mode !== 'whole' || prev.activeFloor !== null;
    if (cleared && hadSomething) cameraHandle.home();
  });

  // Стартовое состояние — здание целиком: человек по ссылке сначала узнаёт корпус,
  // а срез по этажу выбирает сам. Применяется без анимации: первый кадр не должен
  // начинаться с растворения верхних колец на глазах.
  building.applyState(store.state, true);

  /** Точка, которую передаём камере: одна на весь срок жизни сцены. */
  const focusPoint = new Vector3();
  const ui = createUi(overlayRoot, store, building, {
    // Кнопка «заглянуть внутрь» только подводит камеру. Раскрытие здания —
    // следствие близости камеры, а не отдельная команда сцене.
    reveal(): void {
      store.set({ mode: 'whole', activeFloor: null, selectedRoomId: null, hoveredRoomId: null });
      cameraHandle.approach();
    },
    // Возврат ракурса — часть действия кнопки, а не следствие смены состояния:
    // после подлёта состояние уже «здание целиком», меняться в нём нечему,
    // а камера обязана отъехать — иначе здание останется раскрытым.
    home(): void {
      cameraHandle.home();
    },
    // Найденное помещение показывается целиком: его этаж, подсветка и кадр
    // вокруг него. Раньше выбрать помещение можно было только пальцем по
    // модели — то есть только то, которое человек и так уже нашёл глазами.
    showRoom(id: string): void {
      const room = building.roomById(id);
      // Лестница и лифт помещением не являются: карточки у них нет и
      // подсвечивать нечего — им отдаётся этаж и кадр, и этого достаточно.
      const place = room ? undefined : building.verticalById(id);
      const target = room ?? place;
      if (!target) return;
      store.set({
        mode: 'floor',
        activeFloor: room ? room.floor : (place?.level ?? null),
        selectedRoomId: room ? id : null,
        hoveredRoomId: null,
        isolate: false,
      });
      focusPoint.set(target.focus.x, target.focus.y, target.focus.z);
      cameraHandle.frameRoom(focusPoint, ROOM_WINDOW);
    },
  });
  const interaction = createInteraction({
    canvas: rendererHandle.renderer.domElement,
    camera: cameraHandle.camera,
    store,
    building,
    focus: (point) => cameraHandle.lookAt(point),
    home: () => cameraHandle.home(),
  });

  const debug = initDebugOverlay(rendererHandle.renderer);
  let bootCleared = false;

  const loop = createLoop(rendererHandle.renderer, (dt) => {
    cameraHandle.update(dt);
    // Тень пересчитывается только когда что-то менялось: солнце и геометрия
    // статичны, поэтому в установившемся кадре теневого прохода нет вовсе.
    if (building.update(dt, cameraHandle.camera.position, cameraHandle.overviewDistance())) {
      environment.requestShadowUpdate();
    }
    debug?.beforeFrame();
    rendererHandle.renderer.render(scene, cameraHandle.camera);
    debug?.afterFrame();
    // Кадр не держится три секунды подряд — снимаем тени и плотность пикселей.
    if (rendererHandle.sampleFrame(dt)) environment.setShadowsEnabled(false);
    if (!bootCleared) {
      bootCleared = true;
      document.getElementById('boot')?.remove();
    }
  });
  loop.start();

  window.addEventListener('beforeunload', () => {
    loop.stop();
    interaction.dispose();
    ui.dispose();
    debug?.dispose();
    building.dispose();
    environment.dispose();
    cameraHandle.dispose();
    rendererHandle.dispose();
    store.dispose();
  });
}

main();
