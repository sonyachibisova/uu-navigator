/**
 * Минимальный интерфейс: панель этажей, карточка помещения, легенда, подсказка.
 *
 * Верстается от телефона в портрете: важное — в нижней трети экрана, куда
 * достаёт большой палец, панели не перекрывают друг друга и не перехватывают
 * жест вращения. Порядок наложения задан `z-index`, а не порядком в разметке.
 *
 * Это временная оболочка ровно того объёма, что был в прототипе.
 * React подключается позже, отдельным шагом. Модуль общается со сценой
 * только через стор.
 *
 * Этажи с неизвестной планировкой (`layoutKnown: false`) не превращаются в
 * пустую серую плиту: их кнопка неактивна и подписана состоянием.
 */
import type { Store, SceneState } from '@core/state';
import type { BuildingHandle } from '@building/building';
import { VERTICAL_CSS, purposeCss } from '@building/materials';
import type { RoomPurpose } from '@building/source';

/** Человекочитаемые названия назначений. Словарь общий, не про одно здание. */
const PURPOSE_LABEL: Record<RoomPurpose, string> = {
  studio: 'Студии и базерумы',
  workshop: 'Мастерские',
  lecture: 'Лекционные',
  class: 'Семинарские',
  lab: 'Компьютерные классы',
  gallery: 'Галерея',
  library: 'Библиотека',
  cowork: 'Коворкинг',
  office: 'Офисы',
  admin: 'Администрация',
  lobby: 'Холл',
  cafe: 'Кафе',
  shop: 'Магазин',
  wc: 'Санузлы',
  storage: 'Склад и тех.',
  tech: 'Склад и тех.',
};

/**
 * Раскладка. Базовая — портрет телефона: подсказка сверху во всю ширину,
 * этажи колонкой у правого края по центру высоты, карточка помещения внизу,
 * над кнопкой легенды. Ландшафт и десктоп — отдельным правилом ниже.
 *
 * Отступы считаются от безопасной зоны: в ландшафте на телефонах с вырезом
 * `10px` от края экрана оказываются под вырезом и под индикатором.
 */
const STYLE = `
#ui-root { position: absolute; inset: 0; pointer-events: none;
  font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
  --gap-t: max(10px, env(safe-area-inset-top, 0px));
  --gap-r: max(10px, env(safe-area-inset-right, 0px));
  --gap-b: max(10px, env(safe-area-inset-bottom, 0px));
  --gap-l: max(10px, env(safe-area-inset-left, 0px)); }

/* Жест принадлежит сцене: перехватывают его только кнопки и раскрытая легенда. */
#ui-root button { pointer-events: auto; touch-action: manipulation; }
#ui-root button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
#ui-root [hidden] { display: none; }

#ui-hint { position: absolute; z-index: 1; top: var(--gap-t); left: var(--gap-l); right: var(--gap-r);
  box-sizing: border-box; min-height: 44px; padding: 10px 52px 10px 12px; border-radius: 10px;
  background: rgba(0,0,0,.62); color: #fff; font-size: 13px; line-height: 1.45; }
#ui-hint .close { position: absolute; top: 0; right: 0; width: 44px; height: 44px;
  border: 0; border-radius: 10px; background: none; color: #fff; font: 400 20px/1 system-ui, sans-serif;
  cursor: pointer; }

#ui-card { position: absolute; z-index: 3; left: var(--gap-l); right: var(--gap-r);
  bottom: calc(var(--gap-b) + 54px); box-sizing: border-box; padding: 10px 14px; border-radius: 12px;
  background: rgba(255,255,255,.95); color: #111; font-size: 14px; line-height: 1.4;
  box-shadow: 0 6px 22px rgba(0,0,0,.32); }
#ui-card .title { font-size: 15px; }
#ui-card .title b { margin-right: 6px; font-size: 18px; color: #143a8a; }
#ui-card .where { color: #6b6b6b; font-size: 13px; }

/* Колонна этажей живёт в полосе между подсказкой и карточкой: заданы и top,
   и bottom, поэтому она не наезжает ни на ту, ни на другую даже на коротком экране. */
#ui-floors { position: absolute; z-index: 2; right: var(--gap-r);
  top: calc(var(--gap-t) + 96px); bottom: calc(var(--gap-b) + 150px);
  display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 10px; }
#ui-floors .row { display: flex; flex-direction: column; gap: 10px; }
#ui-floors button { min-width: 46px; height: 46px; padding: 0 8px; border: 0; border-radius: 12px;
  background: rgba(0,0,0,.62); color: #fff; font: 700 16px system-ui, sans-serif; cursor: pointer; }
#ui-floors button.on { background: #2c7a2c; }
#ui-floors button:disabled { opacity: .35; cursor: default; }
#ui-floors .note { max-width: 160px; padding: 5px 8px; border-radius: 8px; background: rgba(0,0,0,.62);
  color: #fff; font-size: 11px; line-height: 1.3; text-align: right; }

/* Главное действие: живёт в том же слоте, что и карточка помещения, и они
   не встречаются — кнопка видна, только пока не выбран этаж. */
#ui-reveal { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
  bottom: calc(var(--gap-b) + 54px); height: 46px; padding: 0 20px; border: 0; border-radius: 23px;
  background: #2c7a2c; color: #fff; font: 600 15px system-ui, sans-serif; cursor: pointer;
  box-shadow: 0 6px 22px rgba(0,0,0,.32); }

#ui-legend { position: absolute; z-index: 4; left: var(--gap-l); bottom: var(--gap-b);
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
#ui-legend .toggle { height: 44px; padding: 0 14px; border: 0; border-radius: 12px;
  background: rgba(0,0,0,.62); color: #fff; font: 600 13px system-ui, sans-serif; cursor: pointer; }
#ui-legend .list { pointer-events: auto; box-sizing: border-box;
  width: min(260px, calc(100vw - var(--gap-l) - var(--gap-r)));
  max-height: min(46vh, 340px); overflow-y: auto; padding: 10px 12px; border-radius: 12px;
  background: rgba(0,0,0,.72); color: #fff; font-size: 12px; line-height: 1.6; }
#ui-legend .list i { display: inline-block; width: 12px; height: 12px; border-radius: 3px;
  margin-right: 8px; vertical-align: -1px; }

@media (orientation: landscape) {
  #ui-hint { right: auto; max-width: min(380px, 44vw); }
  #ui-floors { top: var(--gap-t); bottom: auto; }
  #ui-floors .row { flex-direction: row-reverse; gap: 8px; }
  #ui-card { left: 50%; right: auto; transform: translateX(-50%); bottom: var(--gap-b);
    width: min(420px, calc(100vw - var(--gap-l) - var(--gap-r) - 180px)); }
}

/* Короткий портретный экран: тач-цели остаются в норме, колонна становится ниже. */
@media (orientation: portrait) and (max-height: 700px) {
  #ui-floors { bottom: calc(var(--gap-b) + 160px); gap: 8px; }
  #ui-floors .row { gap: 8px; }
  #ui-floors button { min-width: 44px; height: 44px; }
}
`;

export interface UiHandle {
  dispose: () => void;
}

/** Действия, которые интерфейс просит выполнить у камеры: сцену он не трогает. */
export interface UiActions {
  /**
   * Подвести камеру к зданию. Кукольный дом раскрывается сам, от близости
   * камеры: человеку, открывшему ссылку в холле, не нужно догадываться,
   * что модель надо приближать пальцами.
   */
  reveal: () => void;
  /** Вернуть камеру к общему виду. */
  home: () => void;
}

/** Жирный фрагмент подсказки: текст кладётся через `textContent`, не разметкой. */
function strong(text: string): HTMLElement {
  const element = document.createElement('b');
  element.textContent = text;
  return element;
}

export function createUi(
  root: HTMLElement,
  store: Store<SceneState>,
  building: BuildingHandle,
  actions: UiActions,
): UiHandle {
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.appendChild(style);

  const container = document.createElement('div');
  container.id = 'ui-root';
  root.appendChild(container);

  const known = building.floors.filter((floor) => floor.layoutKnown);
  const unknown = building.floors.filter((floor) => !floor.layoutKnown);

  /* ---------- подсказка: одноразовая, снимается первым касанием сцены ---------- */

  const hint = document.createElement('div');
  hint.id = 'ui-hint';
  // Отладочный оверлей занимает тот же угол — при ?debug=1 подсказка уходит ниже.
  if (new URLSearchParams(window.location.search).get('debug') === '1') {
    hint.style.top = 'calc(var(--gap-t) + 118px)';
  }
  const hintText = document.createElement('div');
  if (known.length === 0) {
    hintText.append(
      'Планировки этажей пока нет. Здание можно осмотреть снаружи: крути и приближай.',
    );
  } else {
    hintText.append('Нажми ');
    hintText.append(strong('«Заглянуть внутрь»'));
    hintText.append(' — подлечу к зданию, и оно раскроется само. Кнопки ');
    known.forEach((floor, index) => {
      if (index > 0) hintText.append(index === known.length - 1 ? ' и ' : ', ');
      hintText.append(strong(String(floor.level)));
    });
    hintText.append(' справа покажут этаж изнутри, ');
    hintText.append(strong('⌂'));
    hintText.append(' вернёт здание целиком.');
  }
  hint.appendChild(hintText);

  const hintClose = document.createElement('button');
  hintClose.className = 'close';
  hintClose.type = 'button';
  hintClose.textContent = '×';
  hintClose.setAttribute('aria-label', 'Скрыть подсказку');
  hint.appendChild(hintClose);
  container.appendChild(hint);

  let hintGone = false;
  function dismissHint(): void {
    if (hintGone) return;
    hintGone = true;
    hint.hidden = true;
  }
  hintClose.addEventListener('click', dismissHint);
  // Касание мимо панелей — это касание сцены: подсказка своё отработала.
  const onScenePointer = (event: PointerEvent): void => {
    const target = event.target;
    if (target instanceof Node && container.contains(target)) return;
    dismissHint();
    closeLegend();
  };
  window.addEventListener('pointerdown', onScenePointer, true);

  /* ---------- карточка помещения ---------- */

  const card = document.createElement('div');
  card.id = 'ui-card';
  card.hidden = true;
  card.setAttribute('role', 'status');
  card.setAttribute('aria-live', 'polite');
  const cardTitle = document.createElement('div');
  cardTitle.className = 'title';
  const cardNumber = document.createElement('b');
  const cardName = document.createElement('span');
  cardTitle.append(cardNumber, cardName);
  const cardWhere = document.createElement('div');
  cardWhere.className = 'where';
  card.append(cardTitle, cardWhere);
  container.appendChild(card);

  /* ---------- главное действие: подлёт камеры ---------- */

  const revealButton = document.createElement('button');
  revealButton.id = 'ui-reveal';
  revealButton.type = 'button';
  revealButton.textContent = 'Заглянуть внутрь';
  revealButton.setAttribute('aria-label', 'Подлететь к зданию и заглянуть внутрь');
  revealButton.addEventListener('click', () => {
    dismissHint();
    closeLegend();
    actions.reveal();
  });
  container.appendChild(revealButton);

  /* ---------- панель этажей ---------- */

  const floorsPanel = document.createElement('div');
  floorsPanel.id = 'ui-floors';
  floorsPanel.setAttribute('role', 'group');
  floorsPanel.setAttribute('aria-label', 'Этажи');
  container.appendChild(floorsPanel);

  const row = document.createElement('div');
  row.className = 'row';
  floorsPanel.appendChild(row);

  // Сверху вниз — как в здании: верхний этаж выше. В ландшафте строка
  // разворачивается обратно, и слева оказывается кнопка «корпус целиком».
  const floorButtons: { level: number; button: HTMLButtonElement }[] = [];
  for (const floor of [...building.floors].reverse()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = String(floor.level);
    if (floor.layoutKnown) {
      button.title = floor.name;
      button.setAttribute('aria-label', `${floor.name}, показать изнутри`);
      button.addEventListener('click', () => {
        dismissHint();
        store.set({
          mode: 'floor',
          activeFloor: floor.level,
          selectedRoomId: null,
          hoveredRoomId: null,
        });
      });
    } else {
      button.disabled = true;
      button.title = 'Планировка уточняется';
      button.setAttribute('aria-label', `${floor.name}: планировка уточняется`);
    }
    row.appendChild(button);
    floorButtons.push({ level: floor.level, button });
  }

  const homeButton = document.createElement('button');
  homeButton.type = 'button';
  homeButton.textContent = '⌂';
  homeButton.title = 'Корпус целиком';
  homeButton.setAttribute('aria-label', 'Показать корпус целиком');
  homeButton.addEventListener('click', () => {
    dismissHint();
    store.set({ mode: 'whole', activeFloor: null, selectedRoomId: null, hoveredRoomId: null });
    // Состояние могло и не измениться — например, после подлёта к зданию оно
    // и так «здание целиком». Ракурс всё равно возвращаем: раскрытие держится
    // на близости камеры, и свернуть его может только отъезд.
    actions.home();
  });
  row.appendChild(homeButton);

  if (unknown.length > 0) {
    const note = document.createElement('div');
    note.className = 'note';
    const levels = unknown.map((floor) => floor.level);
    const first = levels[0];
    const last = levels[levels.length - 1];
    const range = levels.length > 1 ? `${first}–${last}` : String(first);
    note.textContent = `Этажи ${range}: планировка уточняется`;
    floorsPanel.appendChild(note);
  }

  /* ---------- легенда: одна кнопка, список по нажатию ---------- */

  const legend = document.createElement('div');
  legend.id = 'ui-legend';

  const legendList = document.createElement('div');
  legendList.className = 'list';
  legendList.id = 'ui-legend-list';
  legendList.hidden = true;

  const addLegendRow = (color: string, label: string): void => {
    const line = document.createElement('div');
    const swatch = document.createElement('i');
    swatch.style.background = color;
    line.append(swatch, label);
    legendList.appendChild(line);
  };

  const labelsSeen = new Set<string>();
  for (const floor of building.floors) {
    for (const room of floor.rooms) {
      const label = PURPOSE_LABEL[room.type];
      if (labelsSeen.has(label)) continue;
      labelsSeen.add(label);
      addLegendRow(purposeCss(room.type), label);
    }
  }
  const kinds = new Set<'stairs' | 'lift'>();
  for (const floor of building.floors) for (const link of floor.vertical) kinds.add(link.kind);
  for (const kind of kinds) {
    addLegendRow(VERTICAL_CSS[kind], kind === 'lift' ? 'Лифт' : 'Лестница');
  }

  const legendToggle = document.createElement('button');
  legendToggle.className = 'toggle';
  legendToggle.type = 'button';
  legendToggle.textContent = 'Обозначения';
  legendToggle.setAttribute('aria-expanded', 'false');
  legendToggle.setAttribute('aria-controls', legendList.id);
  legendToggle.addEventListener('click', () => {
    setLegendOpen(legendList.hidden);
  });

  function setLegendOpen(open: boolean): void {
    legendList.hidden = !open;
    legendToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeLegend(): void {
    if (!legendList.hidden) setLegendOpen(false);
  }

  legend.append(legendList, legendToggle);
  container.appendChild(legend);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeLegend();
  };
  window.addEventListener('keydown', onKeyDown);

  /* ---------- отрисовка состояния ---------- */

  // Стор шлёт изменение и на наведение указателя. Карточку трогаем, только
  // когда сменилось выбранное помещение, кнопки — когда сменился этаж.
  let shownRoomId: string | null = null;
  let shownFloorKey = '';

  function render(state: SceneState): void {
    const floorKey = `${state.mode}:${state.activeFloor ?? ''}`;
    if (floorKey !== shownFloorKey) {
      shownFloorKey = floorKey;
      const whole = state.mode === 'whole';
      // Выбран этаж — здание уже раскрыто срезом, и звать внутрь больше некуда.
      revealButton.hidden = !whole;
      homeButton.classList.toggle('on', whole);
      homeButton.setAttribute('aria-pressed', whole ? 'true' : 'false');
      for (const item of floorButtons) {
        const on = state.mode === 'floor' && state.activeFloor === item.level;
        item.button.classList.toggle('on', on);
        item.button.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    if (state.selectedRoomId === shownRoomId) return;
    shownRoomId = state.selectedRoomId;

    const room = shownRoomId ? building.roomById(shownRoomId) : undefined;
    if (!room) {
      card.hidden = true;
      return;
    }
    const number = room.planNumber ?? '';
    cardNumber.textContent = number;
    cardNumber.hidden = number === '';
    cardName.textContent = room.name;
    cardWhere.textContent = `${room.floor} этаж, ${building.passport.shortName}`;
    card.hidden = false;
  }

  render(store.state);
  const unsubscribe = store.subscribe((next) => render(next));

  return {
    dispose(): void {
      unsubscribe();
      window.removeEventListener('pointerdown', onScenePointer, true);
      window.removeEventListener('keydown', onKeyDown);
      container.remove();
      style.remove();
    },
  };
}
