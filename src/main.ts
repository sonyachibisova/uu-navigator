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
import type { SceneState } from '@core/state';
import { initDebugOverlay } from '@core/debug-overlay';
import { applyLookFromUrl } from '@core/look';
import { createBuilding } from '@building/building';
import { BuildingDataError, ProceduralSource } from '@building/sources/procedural';
import { createInteraction } from '@interaction/controller';
import { createRoute } from '@building/route';
import { createMarkers } from '@building/markers';
import type { MarkSpot } from '@building/markers';
import { buildRouteGraph, nodeRef } from '@routing/graph';
import { buildRoute } from '@routing/path';
import type { Route } from '@routing/path';
import { createUi } from '@ui/minimal';
import type { PlaceInfo } from '@ui/minimal';

/**
 * Полуразмер окна вокруг найденного помещения, метры. Взято около половины
 * ширины корпуса: в кадр попадает само помещение, оба соседних и коридор —
 * то есть человек видит, откуда в него заходить, а не только его самого.
 */
const ROOM_WINDOW = 16;

/**
 * Полуразмер окна вокруг текущего шага маршрута, метры. Меньше комнатного:
 * шаг — это поворот или отрезок коридора, и человеку нужно видеть его,
 * а не весь этаж.
 */
const STEP_WINDOW = 11;

/**
 * Предельное расстояние от точки касания до узла графа, метры. Дальше него
 * тап считается промахом мимо плана: иначе касание пустого места выбирало бы
 * что-нибудь на другом конце этажа, и снять выбор стало бы нечем.
 */
const ANCHOR_LIMIT = 5;

/** Текст для человека, у которого не запустилась 3D-графика. */
const NO_WEBGL_TEXT =
  'Ваш браузер не показывает 3D-графику. ' +
  'Откройте ссылку в другом браузере или на другом устройстве.';
/** Текст для человека, у которого не сошлись данные здания. */
const NO_DATA_TEXT = 'Не удалось загрузить план, обновите страницу.';

/**
 * Точка отправления из адреса: `?from=stair-south-01`. Так работает наклейка
 * с кодом на лестничной площадке — человек снимает её телефоном и попадает
 * в навигатор, который уже знает, где он стоит. Это единственный способ
 * ответить на «я тут» без планировок первых этажей и без геолокации,
 * которая в здании всё равно не работает.
 */
function routeFromUrl(): { from: string | null; to: string | null } {
  try {
    const params = new URLSearchParams(window.location.search);
    return { from: params.get('from'), to: params.get('to') };
  } catch {
    return { from: null, to: null };
  }
}

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
  // Облик берётся из `@core/look`; адрес может подменить вариант, пока
  // владелец выбирает. Делается до сборки сцены: палитра, подписи, лента
  // и фон читают выбор один раз при создании.
  applyLookFromUrl(window.location.search);

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

  // Граф путей строится один раз: он зависит только от данных здания.
  // Вход пришивается к нему тем же вызовом: он часть здания, а не интерфейса.
  const routeGraph = buildRouteGraph(building.floors, { entrance: building.entrance });
  const elevations = new Map(building.floors.map((floor) => [floor.level, floor.elevation]));
  const elevationOf = (level: number): number => elevations.get(level) ?? 0;
  const routeView = createRoute(elevationOf);
  const markers = createMarkers(elevationOf);
  scene.add(routeView.group, markers.group);

  /**
   * Интерфейс появляется позже сцены, а маршрут считается уже в подписке:
   * ссылка на него живёт в коробке, которую подписка читает во время вызова,
   * а не при объявлении.
   */
  const uiRef: {
    current?: {
      showRoute: (
        route: Route | undefined,
        facts?: { unreachable?: boolean; alternative?: boolean },
      ) => void;
    };
  } = {};
  let shownRoute: Route | undefined;
  /** Есть ли у показанного маршрута второй вариант: с лестницами и без. */
  let routeAlternative = false;
  /** Точка, которую передаём камере: одна на весь срок жизни сцены. */
  const focusPoint = new Vector3();

  /**
   * Пересчитать маршрут. Считается он в одном месте — здесь, — а показывают
   * его двое: сцена рисует ленту, интерфейс печатает шаги.
   */
  /**
   * Пересчитать и показать маршрут. `recompute` выключается, когда изменился
   * только этаж или режим: маршрут тот же, и пересборка подменяла бы объект,
   * а вместе с ним сбрасывала бы шаг, который человек листает на ходу.
   */
  function updateRoute(state: SceneState, recompute = true): void {
    const from = state.routeFromId;
    const to = state.routeToId;
    // Если человек попросил маршрут без лестниц, а его нет, показывается
    // обычный: молча отдать «пути нет» там, где путь есть, — обман.
    // О подмене говорит карточка.
    if (recompute) {
      shownRoute = undefined;
      routeAlternative = false;
      if (from && to && from !== to) {
        shownRoute =
          buildRoute(routeGraph, from, to, { stepFree: state.stepFree }) ??
          (state.stepFree ? buildRoute(routeGraph, from, to) : undefined);
        // Второй путь предлагается, только если он есть и отличается от
        // показанного. Кнопка «без лестниц» там, где путь один, — это выбор
        // без выбора, и человек справедливо не понимает, зачем она.
        if (shownRoute) {
          const other = buildRoute(routeGraph, from, to, { stepFree: !state.stepFree });
          routeAlternative =
            other !== undefined && Math.abs(other.meters - shownRoute.meters) > 0.5;
        }
      }
    }
    routeView.show(shownRoute, state.mode === 'floor' ? state.activeFloor : null);
    const asked = Boolean(from && to && from !== to);
    uiRef.current?.showRoute(shownRoute, {
      unreachable: asked && !shownRoute,
      alternative: routeAlternative,
    });
  }

  /**
   * Как назвать место по идентификатору. Идентификатором может быть помещение,
   * лестница, лифт, вход или ссылка на узел графа — кусок коридора, у которого
   * своего имени в данных нет. Интерфейс знает только строку; всё остальное
   * собирается здесь, где на руках и здание, и граф.
   */
  function placeInfoOf(id: string): PlaceInfo | undefined {
    const shortName = building.passport.shortName;
    const room = building.roomById(id);
    if (room) {
      return {
        number: room.planNumber ?? '',
        name: room.name,
        where: `${room.floor} этаж, ${shortName}`,
      };
    }
    const vertical = building.verticalById(id);
    if (vertical) {
      const levels = [...vertical.levels].sort((one, two) => one - two);
      const first = levels[0] ?? vertical.level;
      const last = levels[levels.length - 1] ?? vertical.level;
      return {
        number: '',
        name: vertical.name,
        where:
          levels.length > 1
            ? `этажи ${first}–${last}, ${shortName}`
            : `${first} этаж, ${shortName}`,
      };
    }
    const place = routeGraph.placeOf(id);
    if (!place) return undefined;
    return {
      number: '',
      name: place.kind === 'corridor' ? `Коридор: ${place.name}` : place.name,
      where: `${place.level} этаж, ${shortName}`,
    };
  }

  /** Где стоит метка этого места и есть ли у него плита под контур. */
  function spotOf(id: string, raised: boolean): MarkSpot | undefined {
    const room = building.roomById(id);
    if (room) {
      return {
        x: room.plate.center.x,
        z: room.plate.center.z,
        level: room.floor,
        width: room.plate.width,
        depth: room.plate.depth,
        raised,
        // Номер помещения на плане не подписан — он называется здесь, над
        // выбранным местом. Названия без номера достаточно там, где номера
        // по плану нет вовсе.
        caption: room.planNumber ? `${room.name} ${room.planNumber}` : room.name,
      };
    }
    const place = routeGraph.placeOf(id);
    if (!place) return undefined;
    return { x: place.x, z: place.z, level: place.level };
  }

  /** Подвести камеру под весь маршрут на текущем этаже. */
  function frameShownRoute(state: SceneState): void {
    if (!shownRoute) return;
    const level = state.mode === 'floor' ? state.activeFloor : null;
    const legs = shownRoute.legs.filter((leg) => level === null || leg.level === level);
    const points = legs.flatMap((leg) => leg.points);
    if (points.length === 0) return;
    let x0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let z0 = Number.POSITIVE_INFINITY;
    let z1 = Number.NEGATIVE_INFINITY;
    for (const point of points) {
      x0 = Math.min(x0, point.x);
      x1 = Math.max(x1, point.x);
      z0 = Math.min(z0, point.z);
      z1 = Math.max(z1, point.z);
    }
    // Этаж, по высоте которого ставится точка интереса. В режиме «здание
    // целиком» это этаж цели, а не начала: человек смотрит, куда идти.
    const shownLevel = level ?? legs[legs.length - 1]?.level ?? 0;
    focusPoint.set((x0 + x1) / 2, elevations.get(shownLevel) ?? 0, (z0 + z1) / 2);
    cameraHandle.frameArea(focusPoint, (x1 - x0) / 2 + 6, (z1 - z0) / 2 + 6);
  }

  const store = createSceneStore();
  /**
   * Пришёл ли человек по ссылке с наклейки: тогда точка старта уже известна,
   * и первый же выбор помещения означает «веди меня туда». Флаг снимается
   * после первого маршрута — дальше ведёт только кнопка.
   */
  let startFromLink = false;
  store.subscribe((next, prev) => {
    building.applyState(next);
    // Выбран этаж — камера кадрирует именно его. Рамка общего вида считается
    // по зданию вместе с высотой, и в ней план этажа занимает четверть экрана.
    if (next.activeFloor !== null && next.activeFloor !== prev.activeFloor) {
      const floor = building.floors.find((item) => item.level === next.activeFloor);
      if (floor) cameraHandle.frameFloor(floor.elevation + floor.height / 2, floor.height);
    }
    // Маршрут достраивается сам ровно в одном случае: человек пришёл
    // по ссылке с наклейки, точка старта известна из адреса, и ему остаётся
    // сказать только «куда». Во всех остальных случаях ведёт кнопка
    // «Провести меня»: молча строить маршрут к каждому открытому помещению —
    // значит вести человека туда, куда он не просил.
    if (next.selectedRoomId && next.selectedRoomId !== prev.selectedRoomId) {
      const id = next.selectedRoomId;
      if (startFromLink && next.routeFromId && !next.routeToId && next.routeFromId !== id) {
        startFromLink = false;
        store.set({ routeToId: id });
        return;
      }
      if (next.routeToId && !next.routeFromId && next.routeToId !== id) {
        store.set({ routeFromId: id });
        return;
      }
      // Открыли другое место, пока показан маршрут в третье. Раньше карточка
      // оставалась карточкой прошлого маршрута и показывала его последний шаг:
      // выйти было некуда. Цель снимается, булавка остаётся — человек чаще
      // всего идёт дальше от того же места.
      if (next.routeToId && next.routeToId !== id) {
        store.set({ routeToId: null });
        return;
      }
    }
    const endsChanged =
      next.routeFromId !== prev.routeFromId ||
      next.routeToId !== prev.routeToId ||
      next.stepFree !== prev.stepFree;
    const viewChanged = next.activeFloor !== prev.activeFloor || next.mode !== prev.mode;
    if (endsChanged || viewChanged) updateRoute(next, endsChanged);
    // Кнопка «корпус целиком» возвращает и состояние, и ракурс: она снимает
    // выбранный этаж, помещение и подсветку разом, и это её единственный признак.
    // Признак опирается только на срез по этажу: снятие выбранного помещения
    // само по себе ракурс не трогает. Иначе клик по пустому месту в общем виде,
    // где помещения теперь кликаются, отбрасывал бы камеру к стартовой рамке.
    const cleared =
      next.mode === 'whole' && next.activeFloor === null && next.selectedRoomId === null;
    const hadSomething = prev.mode !== 'whole' || prev.activeFloor !== null;
    if (cleared && hadSomething) cameraHandle.home();
    syncMarkers(next, prev);
  });

  /**
   * Метки на плане: булавка старта и выделение выбранного места. Стор шлёт
   * изменение и на наведение указателя — трогаем метки только тогда, когда
   * изменилось то, что они показывают.
   */
  function syncMarkers(next: SceneState, prev: SceneState): void {
    const levelChanged = next.mode !== prev.mode || next.activeFloor !== prev.activeFloor;
    const selectionChanged =
      next.selectedRoomId !== prev.selectedRoomId || next.routeFromId !== prev.routeFromId;
    if (!levelChanged && !selectionChanged) return;
    markers.setVisibleLevel(next.mode === 'floor' ? next.activeFloor : null);
    markers.setSelected(next.selectedRoomId ? spotOf(next.selectedRoomId, true) : undefined);
    markers.setStart(
      next.routeFromId
        ? spotOf(next.routeFromId, next.routeFromId === next.selectedRoomId)
        : undefined,
    );
  }

  // Стартовое состояние — здание целиком: человек по ссылке сначала узнаёт корпус,
  // а срез по этажу выбирает сам. Применяется без анимации: первый кадр не должен
  // начинаться с растворения верхних колец на глазах.
  building.applyState(store.state, true);


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
    // Шапка с поиском сверху, стартовый лист или карточка места снизу —
    // здание должно вписываться в свободную полосу между ними и в ней же
    // центрироваться, а не во весь холст, часть которого не видна.
    onInsetsChange(insets): void {
      cameraHandle.setInsets(insets);
    },
    showStep(step): void {
      // Камера идёт за шагом: окно небольшое — человек читает «поверните
      // налево» и видит именно тот угол, а не весь этаж.
      const known = building.floors.some((f) => f.level === step.level && f.layoutKnown);
      // Шаг на этаже без планировки — это вестибюль. Срез по нему показал бы
      // пустую плиту вместо ответа, поэтому такой шаг смотрится на здании
      // целиком: там видна и входная группа, и куда от неё идти.
      if (!known) {
        if (store.state.mode !== 'whole') store.set({ mode: 'whole', activeFloor: null });
        cameraHandle.home();
        return;
      }
      focusPoint.set(step.at.x, elevationOf(step.level), step.at.z);
      cameraHandle.frameArea(focusPoint, STEP_WINDOW, STEP_WINDOW);
      if (store.state.activeFloor !== step.level) {
        store.set({ mode: 'floor', activeFloor: step.level });
      }
    },
    setStepFree(value: boolean): void {
      store.set({ stepFree: value });
      updateRoute(store.state);
    },
    setRouteEnd(end: 'from' | 'to', id: string): void {
      store.set(end === 'from' ? { routeFromId: id } : { routeToId: id });
      updateRoute(store.state);
      frameShownRoute(store.state);
    },
    // Маршрут пройден: снимаем и путь, и выбор, и возвращаем общий вид.
    // Крестика мало — он закрывал карточку, а маршрут оставался, и следующий
    // тап по плану возвращал в его последний шаг.
    finishRoute(): void {
      store.set({
        routeFromId: null,
        routeToId: null,
        selectedRoomId: null,
        hoveredRoomId: null,
        mode: 'whole',
        activeFloor: null,
        isolate: false,
      });
      updateRoute(store.state);
      cameraHandle.home();
    },
    frameRoute(): void {
      // «Весь маршрут» — это ответ на «где я в нём». В режиме здания целиком
      // многоэтажный путь виден только сквозь перекрытия, поэтому кадр берётся
      // по этажу цели: там конец пути и там же большая его часть.
      const state = store.state;
      const last = shownRoute?.legs[shownRoute.legs.length - 1];
      if (
        state.activeFloor === null &&
        last &&
        building.floors.some((f) => f.level === last.level && f.layoutKnown)
      ) {
        store.set({ mode: 'floor', activeFloor: last.level });
      }
      frameShownRoute(store.state);
    },
    placeInfo: placeInfoOf,
    // Найденное помещение показывается целиком: его этаж, подсветка и кадр
    // вокруг него. Раньше выбрать помещение можно было только пальцем по
    // модели — то есть только то, которое человек и так уже нашёл глазами.
    showRoom(id: string): void {
      const room = building.roomById(id);
      // Лестница, лифт и вход помещением не являются: плиты у них нет,
      // и отмечает их метка, а не подъём плиты.
      const place = room ? undefined : building.verticalById(id);
      const node = room || place ? undefined : routeGraph.placeOf(id);
      const target = room ?? place ?? node;
      if (!target) return;
      const level = room ? room.floor : (place?.level ?? node?.level ?? null);
      // Срез по этажу без планировки — это пустая плита вместо ответа.
      // Вход на первом этаже показывается на здании целиком, где он и виден.
      const known =
        level !== null && building.floors.some((f) => f.level === level && f.layoutKnown);
      store.set({
        mode: known ? 'floor' : 'whole',
        activeFloor: known ? level : null,
        // Лестница тоже выбирается: у неё есть карточка, и от неё строят
        // маршрут — человек в холле знает лестницу, а не номер помещения.
        selectedRoomId: id,
        hoveredRoomId: null,
        isolate: false,
      });
      // Если маршрут собрался, кадрируем его целиком, а не одну точку: иначе
      // человек видит конец пути и не видит, откуда идти.
      if (shownRoute) {
        frameShownRoute(store.state);
        return;
      }
      if (node) focusPoint.set(node.x, elevationOf(node.level), node.z);
      else if (room) focusPoint.set(room.focus.x, room.focus.y, room.focus.z);
      else if (place) focusPoint.set(place.focus.x, place.focus.y, place.focus.z);
      cameraHandle.frameRoom(focusPoint, ROOM_WINDOW);
    },
  });
  uiRef.current = ui;

  // Ссылка знает, откуда и куда: `?from=` приходит с наклейки у лестницы,
  // `?to=` — из письма или расписания, где ссылку прислали на помещение.
  // Вместе они дают готовый маршрут по одному переходу.
  const link = routeFromUrl();
  const startId = link.from && routeGraph.anchorNode(link.from) !== undefined ? link.from : null;
  const endId = link.to && routeGraph.anchorNode(link.to) !== undefined ? link.to : null;
  startFromLink = Boolean(startId && !endId);
  if (startId && !endId) {
    // Наклейка на лестнице ведёт сюда: цель человек ещё не выбрал, и без
    // ответа экран выглядит так же, как без ссылки. Скажем, что точка
    // отправления принята, и назовём место — это единственное подтверждение,
    // что код сработал.
    const place = building.verticalById(startId) ?? building.roomById(startId);
    if (place) ui.announceStart(place.name);
  }
  if (startId || endId) {
    store.set({
      routeFromId: startId,
      routeToId: endId,
      ...(endId ? { selectedRoomId: endId } : {}),
    });
    updateRoute(store.state);
    if (endId) {
      const room = building.roomById(endId);
      const place = room ? undefined : building.verticalById(endId);
      const level = room ? room.floor : place?.level;
      if (level !== undefined) store.set({ mode: 'floor', activeFloor: level });
      if (shownRoute) frameShownRoute(store.state);
      else if (room) {
        focusPoint.set(room.focus.x, room.focus.y, room.focus.z);
        cameraHandle.frameRoom(focusPoint, ROOM_WINDOW);
      }
    }
  }
  const interaction = createInteraction({
    canvas: rendererHandle.renderer.domElement,
    camera: cameraHandle.camera,
    store,
    building,
    focus: (point) => cameraHandle.lookAt(point),
    home: () => cameraHandle.home(),
    // Тап мимо плиты — это коридор, площадка лестницы или место у лифта.
    // Начать путь можно и оттуда: точка привязывается к ближайшему узлу
    // графа, поэтому булавка встаёт там, откуда действительно можно идти,
    // а не в простенке под пальцем.
    anchorAt(level, x, z): string | null {
      const index = routeGraph.nearestNode(level, x, z, ANCHOR_LIMIT);
      return index === undefined ? null : nodeRef(index);
    },
  });

  const debug = initDebugOverlay(rendererHandle.renderer);
  let bootCleared = false;

  /** Порог, с которого здание считается раскрытым для интерфейса. */
  const OPENED_AT = 0.6;
  let openedShown = false;

  const loop = createLoop(rendererHandle.renderer, (dt) => {
    cameraHandle.update(dt);
    // Тень пересчитывается только когда что-то менялось: солнце и геометрия
    // статичны, поэтому в установившемся кадре теневого прохода нет вовсе.
    if (building.update(dt, cameraHandle.camera.position, cameraHandle.overviewDistance())) {
      environment.requestShadowUpdate();
    }
    routeView.update(dt);
    markers.update(dt, cameraHandle.camera);
    // Раскрытие идёт от близости камеры и меняется в кадре, а не в сторе:
    // интерфейс узнаёт о нём отсюда, и только когда признак действительно
    // изменился — иначе это была бы работа с DOM на каждом кадре.
    const opened = building.openness() > OPENED_AT;
    if (opened !== openedShown) {
      openedShown = opened;
      ui.setOpened(opened);
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
    routeView.dispose();
    markers.dispose();
    building.dispose();
    environment.dispose();
    cameraHandle.dispose();
    rendererHandle.dispose();
    store.dispose();
  });
}

/**
 * Подписи на плане растеризуются в канву один раз. Если шрифт брендбука
 * к этому моменту не загружен, они запекутся системным и такими останутся
 * до перезагрузки страницы. Поэтому ждём шрифт — но не дольше секунды:
 * первый кадр не должен зависеть от сети.
 */
function whenFontsReady(): Promise<unknown> {
  const fonts = document.fonts as FontFaceSet | undefined;
  if (!fonts) return Promise.resolve();
  const wait = Promise.all([fonts.load('400 42px Univers'), fonts.load('700 42px Univers')]);
  const limit = new Promise((resolve) => {
    window.setTimeout(resolve, 1000);
  });
  return Promise.race([wait, limit]).catch(() => undefined);
}

void whenFontsReady().then(() => {
  main();
});
