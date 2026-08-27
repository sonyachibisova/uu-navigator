/**
 * Минимальный интерфейс: поиск, панель этажей, карточка помещения, легенда,
 * подсказка.
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
#ui-root button, #ui-root input { pointer-events: auto; touch-action: manipulation; }
#ui-root button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
#ui-root [hidden] { display: none; }

/* Поиск — первое, что видит человек: он приходит с вопросом «где 4.09»,
   а не разглядывать здание. Поэтому он вверху, над подсказкой. */
#ui-search { position: absolute; z-index: 5; top: var(--gap-t);
  left: var(--gap-l); right: var(--gap-r); }
#ui-search .field { pointer-events: auto; display: flex; align-items: center; gap: 8px;
  box-sizing: border-box; height: 44px; padding: 0 6px 0 12px; border-radius: 12px;
  background: rgba(255,255,255,.95); box-shadow: 0 6px 22px rgba(0,0,0,.28); }
#ui-search input { flex: 1; min-width: 0; height: 40px; border: 0; background: none; color: #111;
  font: 400 15px system-ui, sans-serif; }
#ui-search input::placeholder { color: #8a8a8a; }
#ui-search input:focus { outline: none; }
#ui-search .clear { width: 36px; height: 36px; border: 0; border-radius: 10px; background: none;
  color: #6b6b6b; font: 400 18px/1 system-ui, sans-serif; cursor: pointer; }
#ui-search .list { pointer-events: auto; margin-top: 6px; overflow-y: auto; border-radius: 12px;
  max-height: min(44vh, 320px); background: rgba(255,255,255,.97);
  box-shadow: 0 6px 22px rgba(0,0,0,.28); }
#ui-search .list button { display: block; width: 100%; box-sizing: border-box; text-align: left;
  padding: 9px 12px; border: 0; border-bottom: 1px solid rgba(0,0,0,.07); border-radius: 0;
  background: none; color: #111; font: 400 14px system-ui, sans-serif; cursor: pointer; }
#ui-search .list button:last-child { border-bottom: 0; }
#ui-search .list button b { margin-right: 6px; color: #143a8a; }
#ui-search .list button .where { display: block; color: #6b6b6b; font-size: 12px; }
#ui-search .empty { padding: 10px 12px; color: #6b6b6b; font-size: 13px; }

#ui-hint { position: absolute; z-index: 1; top: calc(var(--gap-t) + 54px); left: var(--gap-l); right: var(--gap-r);
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
  #ui-search { right: auto; width: min(380px, 44vw); }
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
  /**
   * Показать помещение: выбрать его этаж, подсветить и подвести камеру.
   * Интерфейс знает только идентификатор — что делать со сценой и камерой,
   * решает точка сборки.
   */
  showRoom: (id: string) => void;
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
  const debugPanel = new URLSearchParams(window.location.search).get('debug') === '1';
  if (debugPanel) hint.style.top = 'calc(var(--gap-t) + 226px)';
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
    closeSearch();
  };
  window.addEventListener('pointerdown', onScenePointer, true);

  /* ---------- поиск помещения ---------- */

  /**
   * Список для поиска строится один раз: помещений полсотни, и перебирать их
   * на каждое нажатие клавиши дешевле, чем строить индекс. Нормализованная
   * строка хранится рядом, чтобы не пересчитывать её в цикле.
   */
  interface SearchItem {
    id: string;
    number: string;
    name: string;
    level: number;
    haystackNumber: string;
    haystackName: string;
  }

  /** Одна форма записи: регистр, ё и лишние пробелы не должны мешать найти. */
  const normalize = (text: string): string =>
    text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

  const searchItems: SearchItem[] = [];
  for (const floor of known) {
    for (const room of floor.rooms) {
      const number = room.planNumber ?? '';
      searchItems.push({
        id: room.id,
        number,
        name: room.name,
        level: floor.level,
        haystackNumber: normalize(number),
        haystackName: normalize(room.name),
      });
    }
  }

  /** Сколько находок показываем: больше — это уже не список, а простыня. */
  const SEARCH_LIMIT = 8;

  /**
   * Найти помещения. Порядок ответа — от точного к далёкому: номер с начала,
   * название с начала, вхождение в середину. Человек, набравший «4.0»,
   * ждёт сначала номера, а не помещение со словом «4.0» в описании.
   */
  function findRooms(query: string): SearchItem[] {
    const needle = normalize(query);
    if (needle.length === 0) return [];
    const ranked: { item: SearchItem; rank: number }[] = [];
    for (const item of searchItems) {
      let rank = -1;
      if (item.haystackNumber.startsWith(needle)) rank = 0;
      else if (item.haystackName.startsWith(needle)) rank = 1;
      else if (item.haystackNumber.includes(needle)) rank = 2;
      else if (item.haystackName.includes(needle)) rank = 3;
      if (rank >= 0) ranked.push({ item, rank });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.item.number.localeCompare(b.item.number, 'ru'));
    return ranked.slice(0, SEARCH_LIMIT).map((entry) => entry.item);
  }

  const search = document.createElement('div');
  search.id = 'ui-search';
  const searchField = document.createElement('div');
  searchField.className = 'field';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = 'Номер или название';
  searchInput.setAttribute('aria-label', 'Поиск помещения по номеру или названию');
  const searchClear = document.createElement('button');
  searchClear.type = 'button';
  searchClear.className = 'clear';
  searchClear.textContent = '✕';
  searchClear.hidden = true;
  searchClear.setAttribute('aria-label', 'Очистить поиск');
  searchField.append(searchInput, searchClear);

  const searchList = document.createElement('div');
  searchList.className = 'list';
  searchList.id = 'ui-search-list';
  searchList.hidden = true;
  searchList.setAttribute('role', 'listbox');
  // Отладочный оверлей занимает тот же угол: при ?debug=1 поиск уходит ниже.
  if (debugPanel) search.style.top = 'calc(var(--gap-t) + 172px)';
  search.append(searchField, searchList);
  container.appendChild(search);

  // Планировок нет ни у одного этажа — искать нечего, и поле только мешает.
  if (searchItems.length === 0) search.hidden = true;

  function closeSearch(): void {
    if (!searchList.hidden) {
      searchList.hidden = true;
      searchList.replaceChildren();
    }
  }

  function chooseRoom(id: string): void {
    dismissHint();
    closeLegend();
    closeSearch();
    // Клавиатура на телефоне закрывает половину экрана: показать помещение
    // и оставить её открытой — значит показать его в щёлку.
    searchInput.blur();
    actions.showRoom(id);
  }

  function renderSearch(): void {
    const found = findRooms(searchInput.value);
    searchClear.hidden = searchInput.value.length === 0;
    if (searchInput.value.trim().length === 0) {
      closeSearch();
      return;
    }
    searchList.replaceChildren();
    if (found.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Ничего не нашлось';
      searchList.appendChild(empty);
      searchList.hidden = false;
      return;
    }
    for (const item of found) {
      const line = document.createElement('button');
      line.type = 'button';
      const title = document.createElement('span');
      if (item.number) {
        const number = document.createElement('b');
        number.textContent = item.number;
        title.appendChild(number);
      }
      title.append(item.name);
      const where = document.createElement('span');
      where.className = 'where';
      where.textContent = `${item.level} этаж, ${building.passport.shortName}`;
      line.append(title, where);
      line.addEventListener('click', () => chooseRoom(item.id));
      searchList.appendChild(line);
    }
    searchList.hidden = false;
  }

  searchInput.addEventListener('input', renderSearch);
  searchInput.addEventListener('focus', renderSearch);
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      // Ввод выбирает первую находку: на телефоне это единственный способ
      // ответить с клавиатуры, не целясь пальцем в список.
      const first = findRooms(searchInput.value)[0];
      if (first) chooseRoom(first.id);
      return;
    }
    if (event.key === 'Escape') {
      closeSearch();
      searchInput.blur();
    }
  });
  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    renderSearch();
    searchInput.focus();
  });

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
