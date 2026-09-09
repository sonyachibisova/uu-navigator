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
import type { Route, RouteStep } from '@routing/path';
import type { BuildingHandle } from '@building/building';
import { setLabelEdge } from '@building/labels';
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
  font-family: Univers, system-ui, -apple-system, 'Segoe UI', sans-serif;
  /* Язык оболочки: тёмное стекло поверх светлой сцены. Сцена не затемняется —
     панели держатся собственной подложкой, рамкой и тенью. */
  --glass: rgba(20,22,25,.82);
  --glass-soft: rgba(255,255,255,.11);
  --line: rgba(255,255,255,.16);
  --ink: #f1f2ef;
  --ink-dim: rgba(241,242,239,.62);
  --accent: #d8ff3e;
  --accent-ink: #14160f;
  --r: 16px;
  --blur: blur(20px);
  --shadow: 0 10px 34px rgba(0,0,0,.34);
  --gap-t: max(10px, env(safe-area-inset-top, 0px));
  --gap-r: max(10px, env(safe-area-inset-right, 0px));
  --gap-b: max(10px, env(safe-area-inset-bottom, 0px));
  --gap-l: max(10px, env(safe-area-inset-left, 0px)); }

/* Жест принадлежит сцене: перехватывают его только кнопки и раскрытая легенда. */
#ui-root button, #ui-root input { pointer-events: auto; touch-action: manipulation; }
/* Кольцо одно на все панели: они теперь одного тона, и белого хватает. */
#ui-root button:focus-visible, #ui-root input:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 2px; box-shadow: 0 0 0 4px rgba(20,22,25,.55); }
/* На телефоне нет наведения: отклик на касание — единственное подтверждение,
   что палец попал. */
#ui-root button:active { filter: brightness(1.25); }
/* Скрытие сильнее любой раскладки: у панелей ниже задан свой «display»
   с более высокой специфичностью, и без «!important» спрятанный блок —
   например, ходовая строка без маршрута — продолжал показываться. */
#ui-root [hidden] { display: none !important; }

/* Поиск. В начальном состоянии он не строка вверху, а лист снизу с вопросом:
   человек приходит с вопросом «где 4.09», и первое, что он видит, — вопрос
   и поле. Как только место выбрано, лист сжимается в строку у верхнего края
   и отдаёт экран плану. */
#ui-search { position: absolute; z-index: 5; top: var(--gap-t);
  left: var(--gap-l); right: var(--gap-r); }
#ui-search .ask { display: none; margin: 2px 2px 14px; color: var(--ink);
  font: 700 30px/1.05 Univers, system-ui, sans-serif; letter-spacing: -.02em; }
#ui-search .chips { display: none; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
#ui-search .tip { display: none; margin: 14px 2px 0; color: var(--ink-dim); font-size: 13px; line-height: 1.4; }
#ui-root.start #ui-search .tip { display: block; }
#ui-search .me { display: none; margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--line);
  color: var(--ink-dim); font-size: 14px; }
#ui-search .me b { color: var(--ink); font-weight: 700; }
#ui-root.start #ui-search .me.on { display: block; }
#ui-search .chips button { height: 44px; padding: 0 14px; border: 0; border-radius: 22px;
  background: var(--glass-soft); color: var(--ink); font: 400 14px Univers, sans-serif; cursor: pointer; }
/* «Все помещения» — не такая же подсказка, как остальные: она открывает весь
   дом, а не одно назначение, и стоит первой строкой. */
#ui-search .chips button.wide { flex: 1 0 100%; border: 1px solid var(--line); font-weight: 700; }
#ui-search .field { pointer-events: auto; display: flex; align-items: center; gap: 8px;
  box-sizing: border-box; height: 52px; padding: 0 4px 0 14px; border-radius: 14px;
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur); box-shadow: var(--shadow); }
/* Кегль ровно 16: Safari на iPhone увеличивает страницу при фокусе поля
   меньше шестнадцати, и человек остаётся в зуме поверх сцены. */
#ui-search input { flex: 1; min-width: 0; height: 44px; border: 0; background: none; color: var(--ink);
  font: 400 16px Univers, system-ui, sans-serif; }
/* Свой крестик уже есть — нативный рядом с ним читается как второй. */
#ui-search input::-webkit-search-cancel-button { -webkit-appearance: none; appearance: none; }
#ui-search input::placeholder { color: rgba(241,242,239,.66); }
#ui-search input:focus { outline: none; }
#ui-search .clear { width: 44px; height: 44px; border: 0; border-radius: 10px; background: none;
  color: var(--ink-dim); font: 400 18px/1 Univers, sans-serif; cursor: pointer; }
#ui-search .list { pointer-events: auto; margin-top: 8px; overflow-y: auto; border-radius: var(--r);
  max-height: min(44vh, 320px); border: 1px solid var(--line); background: var(--glass);
  backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur); box-shadow: var(--shadow); }
#ui-search .list button { display: block; width: 100%; min-height: 48px; box-sizing: border-box;
  text-align: left; padding: 9px 14px; border: 0; border-bottom: 1px solid rgba(255,255,255,.09);
  border-radius: 0; background: none; color: var(--ink); font: 400 15px Univers, sans-serif;
  cursor: pointer; }
#ui-search .count { padding: 8px 14px; border-top: 1px solid rgba(255,255,255,.09);
  color: var(--ink-dim); font-size: 13px; }
/* Заголовок этажа в каталоге: прилипает к верху, пока листаешь его помещения. */
#ui-search .list .group { position: sticky; top: 0; z-index: 1; padding: 9px 14px;
  background: rgba(20,22,25,.94); border-bottom: 1px solid rgba(255,255,255,.09);
  color: var(--ink); font: 700 13px Univers, sans-serif; }
#ui-search .list button:last-child { border-bottom: 0; }
#ui-search .list button b { margin-right: 6px; color: var(--ink); }
#ui-search .list button .where { display: block; color: var(--ink-dim); font-size: 13px; }
#ui-search .empty { padding: 12px 14px; color: var(--ink-dim); font-size: 13px; }

/* Начальное состояние: лист снизу. Здание при этом остаётся светлым —
   затемняется не сцена, а только собственная подложка панели. */
#ui-root.start #ui-search { top: auto; bottom: var(--gap-b);
  padding: 18px 16px 18px; border-radius: 22px; border: 1px solid var(--line);
  background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
  box-shadow: var(--shadow); }
#ui-root.start #ui-search .ask { display: block; }
#ui-root.start #ui-search .chips { display: flex; }
#ui-root.start #ui-search .field { border-color: rgba(255,255,255,.2);
  background: var(--glass-soft); backdrop-filter: none; -webkit-backdrop-filter: none; box-shadow: none; }
#ui-root.start #ui-search .list { max-height: min(38vh, 280px); }
/* Колонна этажей стоит над листом, а не на нём: полоса начинается у самого
   верха экрана, а кнопки в этом состоянии компактнее — на коротком телефоне
   лист с вопросом и колонна вместе занимают почти всю высоту. */
#ui-root.start #ui-floors { z-index: 6; top: var(--gap-t); bottom: calc(var(--gap-b) + var(--start-h, 320px) + 10px); gap: 6px; }
#ui-root.start #ui-floors .row { gap: 6px; }
#ui-root.start #ui-floors button { min-width: 44px; height: 44px; }
#ui-root.start #ui-legend { display: none; }

#ui-hint { position: absolute; z-index: 1; top: calc(var(--gap-t) + 58px); left: var(--gap-l); right: var(--gap-r);
  box-sizing: border-box; min-height: 44px; padding: 10px 52px 10px 14px; border-radius: var(--r);
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur); color: var(--ink); font-size: 14px; line-height: 1.45; }
#ui-hint .close { position: absolute; top: 0; right: 0; width: 44px; height: 44px;
  border: 0; border-radius: 10px; background: none; color: var(--ink); font: 400 20px/1 Univers, sans-serif;
  cursor: pointer; }
/* На первом экране подсказка молчит: её работу делает сам вопрос,
   а про здание сказано строкой в листе. */
#ui-root.start #ui-hint { display: none; }

/* Карточка помещения и маршрут. Пока маршрут идёт, карточка живёт свёрнутой:
   одна строка текущего шага и стрелки. Всё остальное — по кнопке разворота. */
#ui-card { position: absolute; z-index: 3; left: var(--gap-l); right: var(--gap-r);
  bottom: calc(var(--gap-b) + 54px); box-sizing: border-box; padding: 12px 16px;
  max-height: 46vh; overflow-y: auto; border-radius: var(--r);
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur); color: var(--ink); font-size: 14px; line-height: 1.4;
  box-shadow: var(--shadow); }
#ui-card .close { position: absolute; top: 2px; right: 2px; width: 44px; height: 44px; border: 0;
  border-radius: 10px; background: none; color: var(--ink-dim); font: 400 20px/1 Univers, sans-serif;
  cursor: pointer; }
/* Язычок карточки. Тач-цель заметно больше стрелки: свернуть и развернуть
   блок с шагами приходится на ходу, одной рукой, и промах по значку 15×15
   означал, что человек остаётся с закрытым планом. */
#ui-card .grip { position: absolute; top: 0; right: 44px; width: 60px; height: 48px; border: 0;
  border-radius: 10px; background: none; color: var(--ink-dim); font: 400 15px/1 Univers, sans-serif;
  cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px; }
/* Полоска-язычок: она и говорит, что блок тянется. */
#ui-card .grip i { display: block; width: 26px; height: 3px; border-radius: 2px;
  background: rgba(241,242,239,.5); }
#ui-card .title { padding-right: 112px; font-size: 15px; }
#ui-card .title b { margin-right: 6px; font-size: 17px; color: var(--ink); }
#ui-card .where { padding-right: 112px; color: var(--ink-dim); font-size: 13px; }
/* Почему главное действие не нажимается. Строка стоит под кнопками и живёт
   ровно столько, сколько живёт причина. */
#ui-card .why { margin-top: 8px; color: var(--ink-dim); font-size: 13px; line-height: 1.35; }
#ui-card .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
#ui-card .actions button { height: 44px; padding: 0 16px; border: 0; border-radius: 12px;
  background: var(--accent); color: var(--accent-ink); font: 700 14px Univers, sans-serif; cursor: pointer; }
#ui-card .actions button.ghost { background: var(--glass-soft); color: var(--ink); font-weight: 400; }
/* Неактивное главное действие: видно, что кнопка есть и что она сейчас
   не работает. Причина — строкой ниже, а не в подсказке при наведении. */
#ui-card .actions button:disabled { cursor: default; }
#ui-card .actions button.ghost:disabled { opacity: 1; background: rgba(216,255,62,.16);
  color: var(--ink); }
#ui-card .actions button:disabled:not(.ghost) { background: rgba(216,255,62,.28);
  color: rgba(20,22,15,.66); }
#ui-card .route { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--line); }
#ui-card .route .head { font-size: 13px; color: var(--ink-dim); }
/* Предупреждение о неподтверждённой доступности: заметное, но не тревожное. */
#ui-card .route .warn { margin-top: 8px; padding: 8px 10px; border-radius: 10px;
  background: rgba(216,255,62,.14); border: 1px solid rgba(216,255,62,.35);
  color: var(--ink); font-size: 13px; line-height: 1.35; }
#ui-card .route .mode { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
#ui-card .route .mode .note { color: var(--ink-dim); font-size: 13px; }
#ui-card .route .mode button { height: 44px; padding: 0 14px; border: 0; border-radius: 12px;
  background: var(--glass-soft); color: var(--ink); font: 400 13px Univers, sans-serif; cursor: pointer; }
#ui-card .route .mode button.on { background: var(--accent); color: var(--accent-ink); font-weight: 700; }
#ui-card .route ol { margin: 8px 0 0; padding-left: 18px; color: var(--ink); font-size: 14px;
  line-height: 1.5; max-height: 148px; overflow-y: auto; }
#ui-card .route ol li.on { color: var(--accent); }
/* Ходовая строка: один текущий шаг и стрелки. Полный список — по кнопке,
   на ходу он не нужен и съедает половину экрана. */
#ui-card .step { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
#ui-card .step button { flex: 0 0 44px; height: 44px; border: 0; border-radius: 12px;
  background: var(--glass-soft); color: var(--ink); font: 700 18px/1 Univers, sans-serif; cursor: pointer; }
#ui-card .step button:disabled { opacity: .4; cursor: default; }
#ui-card .step .text { flex: 1; min-width: 0; font-size: 15px; line-height: 1.35; }
#ui-card .step .of { display: block; color: var(--ink-dim); font-size: 13px; }
#ui-card .route .tools { display: flex; flex-wrap: wrap; gap: 4px; }
#ui-card .route .all { margin-top: 8px; height: 44px; padding: 0 12px; border: 0; border-radius: 12px;
  background: none; color: var(--accent); font: 700 13px Univers, sans-serif; cursor: pointer; }
/* Выход из дошедшего маршрута. Стоит на месте стрелки «вперёд», которой
   на последнем шаге всё равно некуда вести. */
#ui-card .step button.done { flex: 0 0 auto; padding: 0 14px; background: var(--accent);
  color: var(--accent-ink); font: 700 14px Univers, sans-serif; }

/* Свёрнутый вид на время ходьбы: остаются название цели и текущий шаг.
   Карточка занимает нижнюю пятую часть экрана, план виден. */
#ui-card.compact { padding-bottom: 10px; max-height: 22vh; }
#ui-card.compact .where,
#ui-card.compact .why,
#ui-card.compact .actions,
#ui-card.compact .route .head,
#ui-card.compact .route .warn,
#ui-card.compact .route .mode,
#ui-card.compact .route .tools,
#ui-card.compact .route ol { display: none; }
#ui-card.compact .route { margin-top: 8px; padding-top: 8px; }
#ui-card.compact .title { font-size: 14px; color: var(--ink-dim); }
#ui-card.compact .title b { font-size: 15px; }

/* Колонна этажей живёт в полосе между подсказкой и карточкой: заданы и top,
   и bottom, поэтому она не наезжает ни на ту, ни на другую даже на коротком экране. */
#ui-floors { position: absolute; z-index: 2; right: var(--gap-r);
  top: calc(var(--gap-t) + 96px); bottom: calc(var(--gap-b) + var(--card-h, 150px) + 16px);
  display: flex; flex-direction: column; align-items: flex-end; justify-content: center; gap: 8px; }
#ui-floors .row { display: flex; flex-direction: column; gap: 8px; }
#ui-floors button { min-width: 46px; height: 46px; padding: 0 8px; border: 1px solid var(--line);
  border-radius: 12px; background: var(--glass); backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur); color: var(--ink); font: 700 16px Univers, sans-serif; cursor: pointer; }
#ui-floors button.on { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
/* Прозрачность на полупрозрачной подложке давала контраст около 2:1 —
   цифры неактивных этажей не читались. Состояние задано цветом. */
#ui-floors button:disabled, #ui-floors button.off { background: rgba(20,22,25,.72); color: rgba(241,242,239,.74); }
#ui-floors .note { max-width: 170px; padding: 7px 9px; border-radius: 10px; border: 1px solid var(--line);
  background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
  color: var(--ink); font-size: 13px; line-height: 1.3; text-align: right; }

/* Главное действие: живёт в том же слоте, что и карточка помещения, и они
   не встречаются — кнопка видна, только пока не выбран этаж. */
#ui-reveal { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
  bottom: calc(var(--gap-b) + 54px); height: 46px; padding: 0 20px; border: 0; border-radius: 23px;
  background: var(--accent); color: var(--accent-ink); font: 700 15px Univers, sans-serif; cursor: pointer;
  box-shadow: var(--shadow); }
/* В начальном состоянии кнопка «внутрь» ушла бы под лист поиска. */
#ui-root.start #ui-reveal { display: none; }

#ui-legend { position: absolute; z-index: 4; left: var(--gap-l); bottom: var(--gap-b);
  display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
#ui-legend .toggle { height: 44px; padding: 0 14px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--glass); backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
  color: var(--ink); font: 400 13px Univers, sans-serif; cursor: pointer; }
/* Список обозначений открывается над карточкой, а не поверх неё: иначе
   он закрывал текущий шаг маршрута и кнопку закрытия. */
#ui-legend .list { margin-bottom: var(--card-over, 0px); pointer-events: auto; box-sizing: border-box;
  width: min(260px, calc(100vw - var(--gap-l) - var(--gap-r)));
  max-height: min(46vh, 340px); overflow-y: auto; padding: 12px 14px; border-radius: var(--r);
  border: 1px solid var(--line); background: var(--glass); backdrop-filter: var(--blur);
  -webkit-backdrop-filter: var(--blur); color: var(--ink); font-size: 13px; line-height: 1.6; }
#ui-legend .list i { display: inline-block; width: 12px; height: 12px; border-radius: 3px;
  margin-right: 8px; vertical-align: -1px; }
/* В начальном состоянии обозначения прячутся: экран занят вопросом. */
#ui-root.start #ui-legend { display: none; }

@media (orientation: landscape) {
  #ui-search { right: auto; width: min(380px, 44vw); }
  #ui-root.start #ui-search { bottom: var(--gap-b); }
  #ui-hint { right: auto; max-width: min(380px, 44vw); }
  #ui-floors { top: var(--gap-t); bottom: auto; }
  #ui-floors .row { flex-direction: row-reverse; gap: 8px; }
  #ui-card { left: 50%; right: auto; transform: translateX(-50%); bottom: var(--gap-b);
    width: min(420px, calc(100vw - var(--gap-l) - var(--gap-r) - 180px)); }
  #ui-card.compact { max-height: 30vh; }
}

/* Короткий портретный экран: тач-цели остаются в норме, колонна становится ниже. */
/* Короткий экран: строка «или покрутите здание» — приятность, а не смысл,
   и она уступает место кнопкам этажей. */
@media (orientation: portrait) and (max-height: 740px) {
  #ui-root.start #ui-search .tip { display: none; }
}

@media (orientation: portrait) and (max-height: 700px) {
  #ui-floors { bottom: calc(var(--gap-b) + 160px); gap: 8px; }
  #ui-floors .row { gap: 8px; }
  #ui-floors button { min-width: 44px; height: 44px; }
  #ui-search .ask { font-size: 26px; }
}
`;

/** Что интерфейс должен знать о показанном маршруте, кроме него самого. */
export interface RouteFacts {
  /** Обе точки выбраны, а пути между ними нет. */
  unreachable?: boolean;
  /**
   * У маршрута есть второй вариант: без лестниц там, где сейчас со ступенями,
   * или наоборот. Только в этом случае предлагается выбор.
   */
  alternative?: boolean;
}

export interface UiHandle {
  /** Показать посчитанный маршрут или убрать его. Считает его точка сборки. */
  showRoute: (route: Route | undefined, facts?: RouteFacts) => void;
  /**
   * Сообщить, раскрыто ли здание. Кнопка «заглянуть внутрь» зовёт сделать
   * то, что уже сделано, если её не убрать: раскрытие идёт от близости
   * камеры, а не от режима, и режим о нём ничего не знает.
   */
  setOpened: (opened: boolean) => void;
  /**
   * Сказать человеку, что навигатор уже знает, где он стоит. Так открывается
   * ссылка с наклейки: `?from=<код>` без цели. Раньше в этом случае на экране
   * не менялось ничего — человек снимал код с лестницы и видел обычное здание,
   * то есть наклейка выглядела сломанной.
   */
  announceStart: (placeName: string) => void;
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
  /** Назначить конец маршрута: начало или цель. */
  setRouteEnd: (end: 'from' | 'to', id: string) => void;
  /**
   * Маршрут пройден. Убирает и путь, и выбор, и возвращает камеру к общему
   * виду: последний шаг обязан иметь выход, а не только крестик.
   */
  finishRoute: () => void;
  /** Показать маршрут целиком: камера отъезжает и берёт в кадр весь путь. */
  frameRoute: () => void;
  /** Переключить режим «без лестниц». */
  setStepFree: (value: boolean) => void;
  /**
   * Показать шаг маршрута: подвести к нему камеру. Человек листает указания
   * на ходу, и каждое должно показывать то место, о котором говорит.
   */
  showStep: (step: RouteStep) => void;
  /**
   * Как назвать место по идентификатору. Местом может быть не только
   * помещение: лестница, лифт, вход, кусок коридора — у них нет карточки
   * в данных, но человеку они называются так же.
   */
  placeInfo: (id: string) => PlaceInfo | undefined;
  /**
   * Высота нижней панели изменилась (стартовый лист или карточка места).
   * Точка сборки подводит этим числом кадр камеры — здание центрируется
   * в части экрана, свободной от панели, а не во весь экран целиком.
   */
  onOcclusionChange?: (px: number) => void;
}

/** Строки карточки места: номер, название и где это. */
export interface PlaceInfo {
  number: string;
  name: string;
  where: string;
}

/**
 * Слова, которыми человек спрашивает, и слова, которыми названы помещения, —
 * разные. Никто не ищет «санузел», ищут «туалет»; библиотека в школе
 * называется Learning Resource Centre. Словарь маленький намеренно: он
 * покрывает случаи, где расхождение системное, а не заменяет собой поиск
 * по назначению помещения. Когда школа отдаст официальные названия,
 * ему место в данных, а не здесь.
 */
const SYNONYMS: Record<string, string> = {
  туалет: 'санузел',
  уборная: 'санузел',
  wc: 'санузел',
  сортир: 'санузел',
  библиотека: 'learning resource',
  столовая: 'кафе',
  буфет: 'кафе',
  аудитория: 'базерум',
  кабинет: 'базерум',
  компьютерный: 'класс',
  печать: 'печати',
};

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
    // Первым делом человек спрашивает «куда мне», а не «как повернуть
    // здание». Поэтому подсказка начинается с поиска, а осмотр корпуса
    // предлагается вторым — тому, кто пришёл посмотреть, а не найти.
    hintText.append('Куда вам? Наберите ');
    hintText.append(strong('номер'));
    hintText.append(' или ');
    hintText.append(strong('название'));
    hintText.append(' — 4.09, мастерская, лестница. Или нажмите ');
    hintText.append(strong('«Заглянуть внутрь»'));
    hintText.append(' и осмотрите корпус: кнопки ');
    known.forEach((floor, index) => {
      if (index > 0) hintText.append(index === known.length - 1 ? ' и ' : ', ');
      hintText.append(strong(String(floor.level)));
    });
    hintText.append(' справа покажут этаж изнутри.');
  }
  hint.appendChild(hintText);

  const hintClose = document.createElement('button');
  hintClose.className = 'close';
  hintClose.type = 'button';
  hintClose.textContent = '×';
  hintClose.setAttribute('aria-label', 'Скрыть подсказку');
  hint.appendChild(hintClose);
  container.appendChild(hint);

  /** Подсказка про наклейку: держится до первого касания, как и обычная. */
  function announceStart(placeName: string): void {
    if (hintGone) return;
    hintText.replaceChildren();
    hintText.append('Вы у «');
    hintText.append(strong(placeName));
    hintText.append('». Куда вам? Наберите ');
    hintText.append(strong('номер'));
    hintText.append(' или ');
    hintText.append(strong('название'));
    hintText.append(' — маршрут отсюда построится сам.');
    hint.hidden = false;
  }

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
    // Тап «мимо» списка закрывал его — и тем же касанием выбирал помещение
    // под пальцем: одно действие давало два несвязанных результата. Событие
    // гасится в фазе перехвата, поэтому до сцены оно не доходит.
    const closing = !searchList.hidden || !legendList.hidden;
    dismissHint();
    closeLegend();
    closeSearch();
    searchInput.blur();
    if (closing) event.stopPropagation();
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
    /** Где это: «4 этаж» или «этажи 4–5» у лестницы. */
    where: string;
    haystackNumber: string;
    haystackName: string;
    /** Назначение словами: по нему находится «мастерская» и «библиотека». */
    haystackType: string;
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
        where: `${floor.level} этаж, ${building.passport.shortName}`,
        haystackNumber: normalize(number),
        haystackName: normalize(room.name),
        haystackType: normalize(PURPOSE_LABEL[room.type] ?? ''),
      });
    }
  }
  // Вход ищется словом: человек, стоящий на улице, набирает «вход», а не
  // номер помещения, — и это самая частая точка начала пути.
  const entranceView = building.entrance;
  if (entranceView) {
    searchItems.push({
      id: entranceView.id,
      number: '',
      name: entranceView.name,
      where: `${entranceView.level} этаж, ${building.passport.shortName}`,
      haystackNumber: '',
      haystackName: normalize(entranceView.name),
      haystackType: 'вход вход в здание',
    });
  }
  // Лестницы и лифты ищутся наравне с помещениями: «где лестница» — такой же
  // вопрос, как «где 4.09», и ответ на него человеку нужен чаще.
  for (const place of building.verticalPlaces()) {
    const levels = [...place.levels].sort((a, b) => a - b);
    const first = levels[0] ?? place.level;
    const last = levels[levels.length - 1] ?? place.level;
    const where = levels.length > 1 ? `этажи ${first}–${last}` : `${first} этаж`;
    searchItems.push({
      id: place.id,
      number: '',
      name: place.name,
      where: `${where}, ${building.passport.shortName}`,
      haystackNumber: '',
      haystackName: normalize(place.name),
      haystackType: normalize(place.name.startsWith('Лифт') ? 'лифт' : 'лестница'),
    });
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
    // Запрос ищется и как есть, и через словарь: «туалет» находит санузел,
    // но и слово «санузел» ничего не теряет.
    const needles = [needle];
    for (const [word, canonical] of Object.entries(SYNONYMS)) {
      if (word.startsWith(needle) || needle.startsWith(word)) needles.push(canonical);
    }
    const ranked: { item: SearchItem; rank: number }[] = [];
    for (const item of searchItems) {
      let rank = -1;
      for (const term of needles) {
        let current = -1;
        if (item.haystackNumber.startsWith(term)) current = 0;
        else if (item.haystackName.startsWith(term)) current = 1;
        else if (item.haystackNumber.includes(term)) current = 2;
        else if (item.haystackName.includes(term)) current = 3;
        else if (item.haystackType.includes(term)) current = 4;
        if (current >= 0 && (rank < 0 || current < rank)) rank = current;
      }
      if (rank >= 0) ranked.push({ item, rank });
    }
    // Одна опечатка не должна оставлять человека с пустым списком: на бегу
    // «библеотека» набирается легко. Второй проход идёт только тогда, когда
    // точного совпадения нет вовсе, — иначе он размывает нормальную выдачу.
    if (ranked.length === 0 && needle.length >= 4) {
      // Опечатку прощаем и в самом слове, и в словарном: «библеотека» должна
      // находить библиотеку даже там, где помещение названо иначе, а найдено
      // оно через словарь.
      const repaired: string[] = [];
      for (const [word, canonical] of Object.entries(SYNONYMS)) {
        if (withinOneEdit(word, needle)) repaired.push(canonical);
      }
      for (const item of searchItems) {
        const words = [...item.haystackName.split(' '), ...item.haystackType.split(' ')];
        const near =
          words.some((word) => word.length >= 4 && withinOneEdit(word, needle)) ||
          repaired.some(
            (term) => item.haystackName.includes(term) || item.haystackType.includes(term),
          );
        if (near) ranked.push({ item, rank: 5 });
      }
    }
    ranked.sort((a, b) => a.rank - b.rank || a.item.number.localeCompare(b.item.number, 'ru'));
    lastFoundCount = ranked.length;
    return ranked.slice(0, SEARCH_LIMIT).map((entry) => entry.item);
  }

  /**
   * Отличаются ли слова не больше чем на одну правку: вставку, удаление
   * или замену буквы. Полное расстояние Левенштейна здесь не нужно —
   * достаточно ответа «да или нет», и он считается одним проходом.
   */
  function withinOneEdit(word: string, query: string): boolean {
    if (Math.abs(word.length - query.length) > 1) return false;
    let i = 0;
    let j = 0;
    let mistakes = 0;
    while (i < word.length && j < query.length) {
      if (word[i] === query[j]) {
        i += 1;
        j += 1;
        continue;
      }
      mistakes += 1;
      if (mistakes > 1) return false;
      if (word.length > query.length) i += 1;
      else if (word.length < query.length) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
    return mistakes + (word.length - i) + (query.length - j) <= 1;
  }

  /** Сколько всего нашлось по последнему запросу: для строки «показаны N из M». */
  let lastFoundCount = 0;
  function countRooms(query: string): number {
    findRooms(query);
    return lastFoundCount;
  }

  const search = document.createElement('div');
  search.id = 'ui-search';
  // Первый экран начинается с вопроса, а не со здания: человек приходит
  // с «где 4.09», и первое, что он видит, — вопрос и поле под ним.
  const searchAsk = document.createElement('div');
  searchAsk.className = 'ask';
  searchAsk.textContent = 'Куда вам?';
  const searchField = document.createElement('div');
  searchField.className = 'field';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.placeholder = 'Номер аудитории или название';
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
  // Роль `listbox` без `option` и без стрелок читалась скринридером как
  // пустой список. Пока паттерн combobox не сделан целиком, честнее обычные
  // кнопки и счётчик находок словами.
  searchList.setAttribute('role', 'group');
  searchList.setAttribute('aria-label', 'Найденные помещения');
  // Отладочный оверлей занимает тот же угол: при ?debug=1 поиск уходит ниже.
  if (debugPanel) search.style.top = 'calc(var(--gap-t) + 172px)';
  // Быстрые подсказки: три места, которые спрашивают чаще всего. Они не
  // выдумываются, а берутся из данных здания — если такого назначения в доме
  // нет, подсказки просто не будет.
  const searchChips = document.createElement('div');
  searchChips.className = 'chips';
  // Первая подсказка — не назначение, а весь дом. Три быстрых раздела
  // покрывают девять помещений из полусотни, и человек, которому нужно
  // десятое, до сих пор не мог просто посмотреть список.
  const allRoomsChip = document.createElement('button');
  allRoomsChip.type = 'button';
  allRoomsChip.className = 'wide';
  allRoomsChip.textContent = 'Все помещения';
  allRoomsChip.addEventListener('click', () => {
    if (catalogueOpen) {
      closeSearch();
      return;
    }
    searchInput.value = '';
    searchClear.hidden = true;
    renderCatalogue();
  });
  searchChips.appendChild(allRoomsChip);
  const CHIP_PURPOSES: RoomPurpose[] = ['library', 'cafe', 'wc', 'workshop'];
  for (const purpose of CHIP_PURPOSES) {
    const has = building.floors.some((floor) => floor.rooms.some((room) => room.type === purpose));
    if (!has) continue;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.textContent = PURPOSE_LABEL[purpose];
    chip.addEventListener('click', () => {
      searchInput.value = PURPOSE_LABEL[purpose];
      searchInput.focus();
      renderSearch();
    });
    searchChips.appendChild(chip);
  }
  // Откуда идём: приходит из ссылки на наклейке. Человек это видит на первом
  // же экране и не должен ничего выбирать — остаётся один вопрос, куда.
  const searchMe = document.createElement('div');
  searchMe.className = 'me';
  const searchMeName = document.createElement('b');
  searchMe.append(document.createTextNode('Вы здесь: '), searchMeName);
  const searchTip = document.createElement('div');
  searchTip.className = 'tip';
  searchTip.textContent = 'Или покрутите здание пальцем и выберите этаж справа.';
  search.append(searchAsk, searchField, searchChips, searchMe, searchTip, searchList);
  container.appendChild(search);

  // Планировок нет ни у одного этажа — искать нечего, и поле только мешает.
  if (searchItems.length === 0) search.hidden = true;

  /** Открыт ли сейчас каталог: тот же список, но собранный не поиском. */
  let catalogueOpen = false;

  function closeSearch(): void {
    catalogueOpen = false;
    allRoomsChip.setAttribute('aria-expanded', 'false');
    if (!searchList.hidden) {
      searchList.hidden = true;
      searchList.replaceChildren();
    }
    // Подсказка тёмная и просвечивала сквозь список: пока список открыт,
    // она прячется, а после закрытия возвращается, если ещё не отработала.
    hint.hidden = hintGone;
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

  /**
   * Каталог: все помещения дома, сгруппированные по этажам, без ввода запроса.
   *
   * Три быстрые подсказки покрывают девять помещений из полусотни, и человеку,
   * которому нужно десятое, до сих пор оставался только поиск по слову,
   * которое он должен угадать. Этажи без планировки не пропускаются молча:
   * пустое место в списке читается как «этажей нет», а они есть.
   */
  function renderCatalogue(): void {
    dismissHint();
    catalogueOpen = true;
    allRoomsChip.setAttribute('aria-expanded', 'true');
    searchList.replaceChildren();
    hint.hidden = true;
    let counted = 0;
    for (const floor of building.floors) {
      const group = document.createElement('div');
      group.className = 'group';
      group.textContent = floor.layoutKnown
        ? `${floor.name} — ${floor.rooms.length} помещений`
        : floor.name;
      searchList.appendChild(group);
      if (!floor.layoutKnown) {
        // Вход — единственное, что про первый этаж известно точно, и он же
        // самая нужная точка старта: человек приходит с улицы.
        const entrance = building.entrance;
        if (entrance && entrance.level === floor.level) {
          searchList.appendChild(catalogueLine(entrance.id, '', entrance.name, 'вход в корпус'));
        }
        const note = document.createElement('div');
        note.className = 'empty';
        note.textContent = 'Планировка уточняется';
        searchList.appendChild(note);
        continue;
      }
      const rooms = [...floor.rooms].sort((one, two) =>
        (one.planNumber ?? one.name).localeCompare(two.planNumber ?? two.name, 'ru'),
      );
      for (const room of rooms) {
        counted += 1;
        searchList.appendChild(
          catalogueLine(room.id, room.planNumber ?? '', room.name, PURPOSE_LABEL[room.type] ?? ''),
        );
      }
    }
    const total = document.createElement('div');
    total.className = 'count';
    total.textContent = `Всего ${counted} помещений с известной планировкой`;
    searchList.appendChild(total);
    searchList.hidden = false;
  }

  /** Строка каталога: номер, название и назначение словами. */
  function catalogueLine(id: string, number: string, name: string, purpose: string): HTMLElement {
    const line = document.createElement('button');
    line.type = 'button';
    const title = document.createElement('span');
    if (number) {
      const tag = document.createElement('b');
      tag.textContent = number;
      title.appendChild(tag);
    }
    title.append(name);
    const where = document.createElement('span');
    where.className = 'where';
    where.textContent = purpose;
    line.append(title, where);
    line.addEventListener('click', () => chooseRoom(id));
    return line;
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
    hint.hidden = true;
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
      where.textContent = item.where;
      line.append(title, where);
      line.addEventListener('click', () => chooseRoom(item.id));
      searchList.appendChild(line);
    }
    // Список обрезан — об этом надо сказать: иначе человек, набравший «4.0»
    // и не увидевший 4.09 среди первых восьми, решает, что её не существует.
    const total = countRooms(searchInput.value);
    if (total > found.length) {
      const count = document.createElement('div');
      count.className = 'count';
      count.textContent = `Показаны ${found.length} из ${total} — уточните запрос`;
      searchList.appendChild(count);
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
  const cardClose = document.createElement('button');
  cardClose.type = 'button';
  cardClose.className = 'close';
  cardClose.textContent = '✕';
  cardClose.setAttribute('aria-label', 'Закрыть карточку помещения');
  cardClose.addEventListener('click', () => {
    store.set({ selectedRoomId: null });
  });
  // Пока маршрут идёт, карточка свёрнута: видно название цели и текущий шаг,
  // остальное — по этой кнопке. План при этом не закрыт.
  const cardGrip = document.createElement('button');
  cardGrip.type = 'button';
  cardGrip.className = 'grip';
  cardGrip.hidden = true;
  const cardGripBar = document.createElement('i');
  const cardGripArrow = document.createElement('span');
  cardGripArrow.textContent = '⌃';
  cardGrip.append(cardGripBar, cardGripArrow);
  cardGrip.setAttribute('aria-expanded', 'false');
  cardGrip.setAttribute('aria-label', 'Развернуть карточку маршрута');
  cardGrip.addEventListener('click', () => {
    const compact = card.classList.toggle('compact');
    cardGripArrow.textContent = compact ? '⌃' : '⌄';
    cardGrip.setAttribute('aria-expanded', compact ? 'false' : 'true');
    cardGrip.setAttribute(
      'aria-label',
      compact ? 'Развернуть карточку маршрута' : 'Свернуть карточку маршрута',
    );
    measureCard();
  });
  const cardTitle = document.createElement('div');
  cardTitle.className = 'title';
  // Живая область — только заголовок. Раньше ею была вся карточка, и
  // скринридер зачитывал название, этаж и все шесть шагов маршрута заново
  // на каждое движение указателя по плану.
  cardTitle.setAttribute('role', 'status');
  cardTitle.setAttribute('aria-live', 'polite');
  const cardNumber = document.createElement('b');
  const cardName = document.createElement('span');
  cardTitle.append(cardNumber, cardName);
  const cardWhere = document.createElement('div');
  cardWhere.className = 'where';

  // Маршрут строится в два касания: «отсюда» на одном помещении, потом выбор
  // второго. Отдельного экрана «откуда — куда» нет намеренно: на телефоне это
  // две строки ввода и клавиатура поверх модели, а действий всё равно два.
  const cardActions = document.createElement('div');
  cardActions.className = 'actions';
  const routeFromButton = document.createElement('button');
  routeFromButton.type = 'button';
  routeFromButton.className = 'ghost';
  routeFromButton.textContent = 'Я здесь';
  routeFromButton.setAttribute('aria-label', 'Отметить это место как начало пути');
  const routeToButton = document.createElement('button');
  routeToButton.type = 'button';
  routeToButton.textContent = 'Дойти сюда';
  routeToButton.setAttribute('aria-label', 'Построить маршрут к этому месту');
  // Кнопок на карточке места ровно две. «Сбросить» не нужна: начало
  // переносится тапом по другому месту и той же кнопкой «Я здесь». «Ссылка»
  // ушла отдельно — механика наклеек живёт в адресе, а не в кнопке.
  cardActions.append(routeFromButton, routeToButton);

  /**
   * Почему «Дойти сюда» сейчас не нажимается. Молчащая серая кнопка —
   * это загадка: человек жмёт, ничего не происходит, и он решает, что
   * приложение сломано. Причина говорится словами и стоит под кнопками.
   */
  const cardWhy = document.createElement('div');
  cardWhy.className = 'why';
  cardWhy.hidden = true;
  cardWhy.setAttribute('role', 'status');

  const routeBlock = document.createElement('div');
  routeBlock.className = 'route';
  routeBlock.hidden = true;
  const routeHead = document.createElement('div');
  routeHead.className = 'head';
  /**
   * «Без лестниц» — это шаг маршрута, а не постоянная настройка. Он появляется
   * только тогда, когда путь уже построен и у него есть второй вариант:
   * предлагать выбор там, где выбирать не из чего, — обман.
   */
  const routeMode = document.createElement('div');
  routeMode.className = 'mode';
  routeMode.hidden = true;
  const routeModeNote = document.createElement('span');
  routeModeNote.className = 'note';
  routeModeNote.textContent = 'Есть второй путь:';
  const stepFreeButton = document.createElement('button');
  stepFreeButton.type = 'button';
  stepFreeButton.textContent = 'Без лестниц';
  stepFreeButton.setAttribute('aria-pressed', 'false');
  stepFreeButton.addEventListener('click', () => actions.setStepFree(!store.state.stepFree));
  routeMode.append(routeModeNote, stepFreeButton);

  // Ходовая строка: человек идёт и смотрит один шаг, а не список из шести.
  const stepRow = document.createElement('div');
  stepRow.className = 'step';
  const stepBack = document.createElement('button');
  stepBack.type = 'button';
  stepBack.textContent = '‹';
  stepBack.setAttribute('aria-label', 'Предыдущий шаг');
  const stepText = document.createElement('div');
  stepText.className = 'text';
  const stepCounter = document.createElement('span');
  stepCounter.className = 'of';
  const stepLabel = document.createElement('span');
  stepText.append(stepLabel, stepCounter);
  const stepNext = document.createElement('button');
  stepNext.type = 'button';
  stepNext.textContent = '›';
  stepNext.setAttribute('aria-label', 'Следующий шаг');
  /**
   * Выход из дошедшего маршрута. Без него последний шаг был тупиком: стрелка
   * «вперёд» гасла, крестик закрывал карточку, а следующий тап по плану
   * возвращал в тот же последний шаг.
   */
  const stepDone = document.createElement('button');
  stepDone.type = 'button';
  stepDone.className = 'done';
  stepDone.textContent = 'Готово';
  stepDone.hidden = true;
  stepDone.setAttribute('aria-label', 'Маршрут пройден, вернуться к общему виду');
  stepRow.append(stepBack, stepText, stepNext, stepDone);

  const stepTools = document.createElement('div');
  stepTools.className = 'tools';
  const allStepsButton = document.createElement('button');
  allStepsButton.type = 'button';
  allStepsButton.className = 'all';
  allStepsButton.textContent = 'Все шаги';
  /**
   * Возврат к маршруту целиком. Камера идёт за каждым шагом и оказывается
   * вплотную к повороту; вернуться к общему виду пальцами на телефоне трудно,
   * и это должно быть действием, а не жестом.
   */
  const wholeRouteButton = document.createElement('button');
  wholeRouteButton.type = 'button';
  wholeRouteButton.className = 'all';
  wholeRouteButton.textContent = 'Весь маршрут';
  stepTools.append(allStepsButton, wholeRouteButton);

  // Честность режима «без лестниц»: пока школа не подтвердила доступность,
  // маршрут остаётся предположением, и человек должен знать об этом до того,
  // как доедет до лифта.
  const routeWarn = document.createElement('div');
  routeWarn.className = 'warn';
  routeWarn.hidden = true;

  const routeSteps = document.createElement('ol');
  routeSteps.hidden = true;
  routeBlock.append(routeHead, routeWarn, routeMode, stepRow, stepTools, routeSteps);

  /** Какой шаг маршрута показан сейчас. */
  let stepIndex = 0;

  /**
   * Перерисовать ходовую строку под текущий шаг. Камеру не трогает: карточка
   * перерисовывается и от смены этажа, и от пересборки маршрута, а камера
   * должна идти за шагом только тогда, когда шаг перелистнул человек.
   * Раньше этого разделения не было, и любое действие, двигавшее камеру,
   * тут же отменялось перерисовкой — в том числе «Весь маршрут».
   */
  function paintStep(index: number): void {
    if (!shownRoute) return;
    const steps = shownRoute.steps;
    stepIndex = Math.min(Math.max(index, 0), steps.length - 1);
    const step = steps[stepIndex];
    if (!step) return;
    stepLabel.textContent = step.text;
    stepCounter.textContent = `Шаг ${stepIndex + 1} из ${steps.length}`;
    stepBack.disabled = stepIndex === 0;
    const last = stepIndex === steps.length - 1;
    stepNext.hidden = last;
    stepDone.hidden = !last;
    for (const [index2, item] of [...routeSteps.children].entries()) {
      item.classList.toggle('on', index2 === stepIndex);
    }
  }

  /** Перелистнуть шаг: перерисовать строку и подвести камеру к этому месту. */
  function showStep(index: number): void {
    paintStep(index);
    const step = shownRoute?.steps[stepIndex];
    if (step) actions.showStep(step);
  }

  stepBack.addEventListener('click', () => showStep(stepIndex - 1));
  stepNext.addEventListener('click', () => showStep(stepIndex + 1));
  allStepsButton.addEventListener('click', () => {
    routeSteps.hidden = !routeSteps.hidden;
    allStepsButton.textContent = routeSteps.hidden ? 'Все шаги' : 'Свернуть';
    measureCard();
  });
  wholeRouteButton.addEventListener('click', () => {
    // Карточка при этом разворачивается: человек просил показать маршрут
    // целиком, а не только его линию под свёрнутой полосой.
    setCompact(false);
    measureCard();
    actions.frameRoute();
  });
  stepDone.addEventListener('click', () => actions.finishRoute());

  routeFromButton.addEventListener('click', () => {
    const id = store.state.selectedRoomId;
    if (id) actions.setRouteEnd('from', id);
  });
  routeToButton.addEventListener('click', () => {
    const id = store.state.selectedRoomId;
    if (id) actions.setRouteEnd('to', id);
  });

  card.append(cardClose, cardGrip, cardTitle, cardWhere, cardActions, cardWhy, routeBlock);
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
      // Не `disabled`, а `aria-disabled`: отключённая кнопка не даёт событий,
      // и человек, нажавший на первый этаж, не получал вообще никакого
      // ответа — а ответ у нас есть, просто он словами.
      button.classList.add('off');
      button.setAttribute('aria-disabled', 'true');
      button.title = 'Планировка уточняется';
      button.setAttribute('aria-label', `${floor.name}: планировка уточняется`);
      button.addEventListener('click', () => {
        dismissHint();
        showUnknownNote();
      });
    }
    row.appendChild(button);
    floorButtons.push({ level: floor.level, button });
  }

  const homeButton = document.createElement('button');
  homeButton.type = 'button';
  // Глиф «⌂» есть не во всех системных шрифтах Android: там, где его нет,
  // на кнопке возвращения к общему виду оказывался пустой квадрат.
  homeButton.innerHTML =
    '<svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">' +
    '<path d="M3 9.2 10 3.5l7 5.7V17H12v-4.6H8V17H3z" fill="none" stroke="currentColor" ' +
    'stroke-width="1.8" stroke-linejoin="round"/></svg>';
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

  // Постоянно висящее извинение читается как «продукт недоделан» — и читается
  // непрерывно. Плашка появляется, когда человек нажал на этаж без планировки,
  // то есть ровно тогда, когда ему нужен ответ, и уходит сама.
  const note = document.createElement('div');
  note.className = 'note';
  note.hidden = true;
  note.setAttribute('role', 'status');
  if (unknown.length > 0) {
    const levels = unknown.map((floor) => floor.level);
    const first = levels[0];
    const last = levels[levels.length - 1];
    const range = levels.length > 1 ? `${first}–${last}` : String(first);
    note.textContent = `Этажи ${range}: планировка уточняется. Мы запросили планы у школы`;
    floorsPanel.appendChild(note);
  }

  let noteTimer = 0;
  function showUnknownNote(): void {
    if (unknown.length === 0) return;
    note.hidden = false;
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      note.hidden = true;
    }, 5000);
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

  /**
   * Сообщить сцене, какую долю ширины кадра занимает колонна кнопок справа.
   * Подписи помещений под ней гасятся: кнопки непрозрачны, и номера уезжали
   * под них наполовину. Ширину меряем, а не задаём числом: она разная
   * в портрете и в ландшафте и зависит от безопасных зон.
   */
  function reportInterfaceEdge(): void {
    const width = window.innerWidth || 1;
    const box = floorsPanel.getBoundingClientRect();
    const strip = box.width > 0 ? (width - box.left) / width : 0;
    setLabelEdge(Math.min(Math.max(strip, 0), 0.4));
  }
  reportInterfaceEdge();
  window.addEventListener('resize', reportInterfaceEdge);
  // Поворот экрана меняет и ширину листа, и его высоту.
  window.addEventListener('resize', measureStart);

  /**
   * Экранная клавиатура. На iOS она не меняет вёрстку страницы: лист с полем
   * поиска остаётся прибитым к низу окна и уезжает под клавиатуру вместе
   * с полем, в которое человек печатает. Поднимаем его на высоту клавиатуры
   * сами, по видимой области.
   */
  const viewport = window.visualViewport;
  function liftForKeyboard(): void {
    if (!viewport) return;
    const hidden = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    // Мелкие расхождения — это адресная строка, а не клавиатура.
    search.style.transform = hidden > 80 ? `translateY(${-hidden}px)` : '';
  }
  viewport?.addEventListener('resize', liftForKeyboard);
  viewport?.addEventListener('scroll', liftForKeyboard);

  /* ---------- отрисовка состояния ---------- */

  // Стор шлёт изменение и на наведение указателя. Карточку трогаем, только
  // когда сменилось выбранное помещение, кнопки — когда сменился этаж.
  let shownRoomId: string | null = null;
  let shownFloorKey = '';

  /** Последний показанный маршрут: из него собирается блок в карточке. */
  let shownRoute: Route | undefined;
  /** Какой маршрут уже свёрнут: чтобы разворот руками не схлопывался обратно. */
  let shownRouteId = '';
  const routeKey = (route: Route): string => `${route.fromName}→${route.toName}:${route.steps.length}`;
  /** Раскрыто ли здание сейчас: об этом сообщает сцена, кадрами. */
  let opened = false;
  /** Обе точки выбраны, а пути между ними не нашлось. */
  let routeUnreachable = false;
  /** У показанного маршрута есть второй вариант: только тогда предлагаем выбор. */
  let routeAlternative = false;

  /**
   * Начальное состояние: ничего не выбрано и маршрут не начат. Тогда поиск
   * живёт листом снизу с вопросом «Куда вам?», а здание работает фоном.
   */
  function syncStart(): void {
    const state = store.state;
    // Точка старта из ссылки первый экран не отменяет: человек всё ещё
    // не сказал, куда ему. Отменяет только выбранное помещение или цель.
    const idle = state.selectedRoomId === null && state.routeToId === null;
    container.classList.toggle('start', idle);
    window.requestAnimationFrame(measureStart);
    const from = state.routeFromId;
    const fromPlace = from ? actions.placeInfo(from) : undefined;
    searchMe.classList.toggle('on', Boolean(fromPlace));
    searchMeName.textContent = fromPlace?.name ?? '';
  }

  /** Свернуть или развернуть карточку под текущий маршрут. */
  function setCompact(compact: boolean): void {
    cardGrip.hidden = !compact && !card.classList.contains('compact');
    card.classList.toggle('compact', compact);
    cardGripArrow.textContent = compact ? '⌃' : '⌄';
    cardGrip.setAttribute('aria-expanded', compact ? 'false' : 'true');
  }

  function renderRoute(): void {
    const state = store.state;
    const started = state.routeFromId !== null || state.routeToId !== null;
    const waiting = started && !shownRoute;
    const selected = state.selectedRoomId;
    const isStart = selected !== null && selected === state.routeFromId;
    // Обе кнопки видны всегда: они и есть карточка места. «Я здесь» на самой
    // булавке говорит, что булавка уже тут, — прятать её значило бы отвечать
    // на тап пустотой.
    routeFromButton.classList.toggle('on', isStart);
    routeFromButton.disabled = isStart;
    routeFromButton.textContent = isStart ? 'Вы здесь' : 'Я здесь';
    // Вести неоткуда — вести нельзя, и причина говорится словами.
    const noStart = state.routeFromId === null;
    const toSelf = !noStart && isStart;
    routeToButton.disabled = noStart || toSelf;
    if (noStart) {
      cardWhy.textContent = 'Сначала отметьте, где вы сейчас, — кнопкой «Я здесь»';
      cardWhy.hidden = false;
    } else if (toSelf) {
      cardWhy.textContent = 'Это и есть ваше место. Выберите, куда идти';
      cardWhy.hidden = false;
    } else {
      const startInfo = state.routeFromId ? actions.placeInfo(state.routeFromId) : undefined;
      // Где сейчас булавка — это ответ на «а откуда он меня поведёт»
      // и одновременно подсказка, что её можно перенести.
      cardWhy.textContent = startInfo ? `Идём от «${startInfo.name}»` : '';
      cardWhy.hidden = !startInfo;
    }
    stepFreeButton.classList.toggle('on', state.stepFree);
    stepFreeButton.setAttribute('aria-pressed', state.stepFree ? 'true' : 'false');
    // Выбор появляется только у построенного маршрута и только если второй
    // путь действительно есть.
    routeMode.hidden = !(shownRoute && routeAlternative);

    if (shownRoute) {
      // Минута пути внутри этажа — это сообщение «маршрут тебе не нужен».
      // Время называется только там, где оно что-то значит.
      const length =
        shownRoute.minutes > 1
          ? `${Math.round(shownRoute.meters)} м, ${shownRoute.minutes} мин`
          : `${Math.round(shownRoute.meters)} м`;
      routeHead.textContent = `${shownRoute.fromName} → ${shownRoute.toName}: ${length}`;
      if (state.stepFree && !shownRoute.stepFree) {
        routeHead.textContent += ' (без лестниц пути нет — показан обычный)';
      }
      // Режим «без лестниц» не должен звучать как гарантия там, где школа
      // доступность не подтверждала. Молчать здесь — значит обещать чужое.
      const unconfirmed = shownRoute.unconfirmedLinks;
      routeWarn.hidden = !(shownRoute.stepFree && unconfirmed.length > 0);
      if (!routeWarn.hidden) {
        routeWarn.textContent =
          unconfirmed.length === 1
            ? `Доступность «${unconfirmed[0]}» школа пока не подтвердила`
            : `Доступность связей на пути школа пока не подтвердила: ${unconfirmed.join(', ')}`;
      }
      routeSteps.replaceChildren();
      shownRoute.steps.forEach((step, index) => {
        const item = document.createElement('li');
        item.textContent = step.text;
        item.addEventListener('click', () => showStep(index));
        routeSteps.appendChild(item);
      });
      stepRow.hidden = false;
      stepTools.hidden = false;
      routeBlock.hidden = false;
      // Маршрут построен — человек идёт, а не читает карточку: она сворачивается
      // в полосу с текущим шагом. Развернуть можно кнопкой, состояние держится.
      cardGrip.hidden = false;
      if (shownRouteId !== routeKey(shownRoute)) {
        shownRouteId = routeKey(shownRoute);
        setCompact(true);
      }
      paintStep(stepIndex);
      measureCard();
      syncStart();
      return;
    }

    if (routeUnreachable) {
      // Молчать здесь нельзя: человек уже выбрал обе точки и ждёт ответа.
      routeHead.textContent =
        'Маршрут сюда пока не строится. Выберите другое место или спросите на входе';
      routeSteps.replaceChildren();
      stepRow.hidden = true;
      stepTools.hidden = true;
      routeBlock.hidden = false;
      setCompact(false);
      syncStart();
      return;
    }

    if (waiting) {
      routeHead.textContent =
        state.routeFromId !== null
          ? 'Теперь выберите, куда идти — тапом или поиском'
          : 'Теперь выберите, откуда идти — тапом или поиском';
      routeSteps.replaceChildren();
      stepRow.hidden = true;
      stepTools.hidden = true;
      routeBlock.hidden = false;
      setCompact(false);
      measureCard();
      syncStart();
      return;
    }
    routeBlock.hidden = true;
    shownRouteId = '';
    cardGrip.hidden = true;
    setCompact(false);
    measureCard();
    syncStart();
  }

  function render(state: SceneState): void {
    const floorKey = `${state.mode}:${state.activeFloor ?? ''}`;
    if (floorKey !== shownFloorKey) {
      shownFloorKey = floorKey;
      const whole = state.mode === 'whole';
      // Выбран этаж — здание уже раскрыто срезом, и звать внутрь больше некуда.
      revealButton.hidden = !whole || opened;
      homeButton.classList.toggle('on', whole);
      homeButton.setAttribute('aria-pressed', whole ? 'true' : 'false');
      for (const item of floorButtons) {
        const on = state.mode === 'floor' && state.activeFloor === item.level;
        item.button.classList.toggle('on', on);
        item.button.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    if (state.selectedRoomId === shownRoomId) {
      renderRoute();
      return;
    }
    shownRoomId = state.selectedRoomId;

    // Местом может быть помещение, лестница, лифт, вход или кусок коридора:
    // как его назвать, знает точка сборки — у интерфейса на руках только
    // идентификатор.
    const info = shownRoomId ? actions.placeInfo(shownRoomId) : undefined;
    if (!info) {
      card.hidden = true;
      measureCard();
      syncStart();
      return;
    }
    cardNumber.textContent = info.number;
    cardNumber.hidden = info.number === '';
    cardName.textContent = info.name;
    cardWhere.textContent = info.where;
    renderRoute();
    card.hidden = false;
    measureCard();
  }

  /**
   * Сообщить раскладке фактическую высоту карточки. Колонна этажей отступает
   * снизу именно на неё: постоянное число не спасало — карточка с шестью
   * шагами маршрута закрывала кнопку «корпус целиком».
   */
  let lastCardOcclusion = 0;
  let lastStartOcclusion = 0;

  function measureCard(): void {
    const height = card.hidden ? 0 : card.offsetHeight;
    container.style.setProperty('--card-h', `${Math.max(height, 96)}px`);
    // Отдельная величина без нижней границы: ею список обозначений
    // отодвигается от карточки, а когда карточки нет — не отодвигается вовсе.
    container.style.setProperty('--card-over', `${height > 0 ? height + 8 : 0}px`);
    lastCardOcclusion = height > 0 ? height + gapBottom() : 0;
    reportOcclusion();
  }

  /**
   * Высота листа первого экрана. Колонна этажей стоит над ним, а лист растёт
   * от содержимого — точку старта из ссылки, подсказки, находки поиска, —
   * поэтому высота меряется, а не задаётся числом.
   */
  function measureStart(): void {
    const start = container.classList.contains('start');
    const height = start ? search.offsetHeight : 0;
    container.style.setProperty('--start-h', `${height}px`);
    lastStartOcclusion = height > 0 ? height + gapBottom() : 0;
    reportOcclusion();
  }

  /** Отступ безопасной зоны снизу: та же переменная, что держит панели над краем. */
  function gapBottom(): number {
    const px = parseFloat(getComputedStyle(container).getPropertyValue('--gap-b'));
    return Number.isFinite(px) ? px : 10;
  }

  /**
   * Стартовый лист и карточка места не показываются одновременно — но если
   * когда-нибудь окажутся видны оба, в кадр камеры уходит больший из них,
   * а не сумма: они лежат в одном нижнем углу, а не друг под другом.
   */
  function reportOcclusion(): void {
    actions.onOcclusionChange?.(Math.max(lastCardOcclusion, lastStartOcclusion));
  }

  /**
   * `requestAnimationFrame` на старте иногда обгоняет реальную раскладку
   * (шрифт, первая отрисовка) — высота на этот момент читается нулевой,
   * а обновить её больше нечему до первого resize. `ResizeObserver` не
   * гадает с таймингом: он сообщает и стартовый размер, и каждое
   * дальнейшее изменение панели, откуда бы оно ни пришло.
   */
  const startResize = new ResizeObserver(() => measureStart());
  startResize.observe(search);
  const cardResize = new ResizeObserver(() => measureCard());
  cardResize.observe(card);

  render(store.state);
  const unsubscribe = store.subscribe((next) => render(next));

  return {
    announceStart,
    setOpened(value: boolean): void {
      if (opened === value) return;
      opened = value;
      revealButton.hidden = store.state.mode !== 'whole' || opened;
    },
    showRoute(route: Route | undefined, facts: RouteFacts = {}): void {
      // Шаг сбрасывается только у нового маршрута: тот же маршрут после
      // смены этажа не должен отматывать человека к началу пути.
      if (route !== shownRoute) stepIndex = 0;
      shownRoute = route;
      routeUnreachable = facts.unreachable === true;
      routeAlternative = facts.alternative === true;
      renderRoute();
    },
    dispose(): void {
      unsubscribe();
      window.clearTimeout(noteTimer);
      startResize.disconnect();
      cardResize.disconnect();
      window.removeEventListener('resize', reportInterfaceEdge);
      window.removeEventListener('resize', measureStart);
      viewport?.removeEventListener('resize', liftForKeyboard);
      viewport?.removeEventListener('scroll', liftForKeyboard);
      window.removeEventListener('pointerdown', onScenePointer, true);
      window.removeEventListener('keydown', onKeyDown);
      container.remove();
      style.remove();
    },
  };
}
