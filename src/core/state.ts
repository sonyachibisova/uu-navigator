/**
 * Стор состояния приложения — единственный канал связи между интерфейсом,
 * взаимодействием и сценой (`docs/ARCHITECTURE.md`, «Границы модулей»).
 *
 * Правило: снаружи никто не дёргает методы сцены напрямую. Панель этажей
 * меняет состояние, сцена подписана на изменения и реагирует сама.
 *
 * Контейнер намеренно примитивный: типизированный объект, `set` с частичным
 * патчем, подписка с отпиской. Ни реактивности, ни зависимостей.
 */

/** Режим камеры и среза: здание целиком или срез по выбранному этажу. */
export type ViewMode = 'whole' | 'floor';

export interface SceneState {
  /** Что показываем: здание целиком или срез по этажу. */
  mode: ViewMode;
  /** Уровень выбранного этажа (1-based), `null` — этаж не выбран. */
  activeFloor: number | null;
  /** Идентификатор выбранного помещения или `null`. */
  selectedRoomId: string | null;
  /** Идентификатор помещения под курсором или `null`. */
  hoveredRoomId: string | null;
  /**
   * Режим «изолировать этаж»: невыбранные этажи скрываются полностью.
   * По умолчанию выключен — невыбранные этажи приглушаются, а не прячутся
   * (инвариант 7 правил проекта). Это отдельный явный режим, а не поведение.
   */
  isolate: boolean;
}

export type Listener<T> = (next: Readonly<T>, prev: Readonly<T>) => void;

/** Минимальный типизированный стор с подпиской. */
export class Store<T extends object> {
  private current: T;
  private readonly listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.current = initial;
  }

  /** Текущее состояние. Менять только через `set`. */
  get state(): Readonly<T> {
    return this.current;
  }

  /** Применить частичный патч. Слушатели вызываются, только если что-то изменилось. */
  set(patch: Partial<T>): void {
    const prev = this.current;
    let changed = false;
    for (const key of Object.keys(patch) as (keyof T)[]) {
      const value = patch[key];
      if (value !== undefined && !Object.is(prev[key], value)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.current = { ...prev, ...patch };
    for (const listener of [...this.listeners]) listener(this.current, prev);
  }

  /** Подписаться на изменения. Возвращает функцию отписки. */
  subscribe(listener: Listener<T>): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Снять всех слушателей (используется при разборке приложения). */
  dispose(): void {
    this.listeners.clear();
  }
}

/** Стор сцены с состоянием по умолчанию: здание целиком, ничего не выбрано. */
export function createSceneStore(): Store<SceneState> {
  return new Store<SceneState>({
    mode: 'whole',
    activeFloor: null,
    selectedRoomId: null,
    hoveredRoomId: null,
    isolate: false,
  });
}
