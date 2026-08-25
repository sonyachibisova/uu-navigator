// Отладочный оверлей: FPS, draw calls, треугольники, память geometry/texture,
// вес загруженных ресурсов. Включается только при ?debug=1 в адресе.
//
// Счётчики читаются честно. В three.js `renderer.info` обнуляется уже ПОСЛЕ
// теневого прохода, поэтому обычное чтение показывает только цветовой проход,
// а теневой не виден вовсе — при том, что он стоил до 88 draw calls из 150.
// Здесь автосброс выключен, счётчики снимаются и обнуляются вручную после
// каждого кадра, а теневой проход измеряется отдельной строкой: раз в секунду
// панель просит пересчитать тень и берёт разницу с обычным кадром.
// Рядом с каждой цифрой — лимит из таблицы бюджетов проекта; превышение
// подсвечивается красным, чтобы было видно с телефона без чтения кода.
//
// Панель не перехватывает клики (pointer-events: none) и не падает, если
// WebGLRenderer ещё не создан — движок кладёт его позже через setRenderer().

import type { WebGLRenderer } from 'three';

// Бюджеты проекта, раздел «Бюджеты производительности».
const BUDGET = {
  drawCalls: 150, // ≤
  triangles: 300_000, // ≤
  resourcesBytes: 3 * 1024 * 1024, // ≤ 3 МБ до первого кадра
  fps: 45, // ≥ на мобильном при вращении камеры
} as const;

export interface DebugOverlayHandle {
  /** Подключить (или заменить) рендерер, когда движок его создаст. */
  setRenderer: (renderer: WebGLRenderer | undefined) => void;
  /** Вызывается до `render()`: решает, мерить ли в этом кадре теневой проход. */
  beforeFrame: () => void;
  /** Вызывается сразу после `render()`: снимает и обнуляет счётчики кадра. */
  afterFrame: () => void;
  /** Остановить цикл обновления и убрать панель из DOM. */
  dispose: () => void;
}

/** Возвращает true, если в адресе есть ?debug=1. */
function isDebugEnabled(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toFixed(0)} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
}

/** Строка «значение / лимит», красная при превышении. minIsBudget=true — лимит снизу (FPS). */
function renderRow(label: string, value: string, limit: string, exceeded: boolean): string {
  const cls = exceeded ? 'row over' : 'row';
  return `<div class="${cls}"><span class="label">${label}</span><span class="value">${value}</span><span class="limit">${limit}</span></div>`;
}

/**
 * Включает отладочный оверлей (только при ?debug=1). Рендерер можно не
 * передавать — тогда доступен только FPS, остальные строки показывают «—».
 */
export function initDebugOverlay(renderer?: WebGLRenderer): DebugOverlayHandle | undefined {
  if (!isDebugEnabled()) return undefined;
  if (typeof document === 'undefined') return undefined;

  let currentRenderer = renderer;

  interface PassStats {
    calls: number;
    triangles: number;
  }
  /** Кадр без теневого прохода: чистая стоимость цветового прохода. */
  let colorPass: PassStats | undefined;
  /** Разница кадра с теневым проходом и кадра без него. */
  let shadowPass: PassStats | undefined;
  /** Меряем ли теневой проход в текущем кадре. */
  let measuringShadow = false;
  let lastShadowProbe = 0;

  function attach(next: WebGLRenderer | undefined): void {
    // Автосброс выключаем: иначе счётчики кадра теряют теневой проход.
    if (next) next.info.autoReset = false;
    currentRenderer = next;
  }
  attach(renderer);

  const panel = document.createElement('div');
  panel.id = 'debug-overlay';
  panel.setAttribute('aria-hidden', 'true');
  panel.style.cssText = [
    'position:fixed',
    'top:8px',
    'left:8px',
    'z-index:99999',
    'pointer-events:none',
    'font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
    'font-size:11px',
    'line-height:1.5',
    'color:#d8f0d8',
    'background:rgba(0,0,0,0.6)',
    'border:1px solid rgba(255,255,255,0.15)',
    'border-radius:6px',
    'padding:6px 8px',
    'white-space:pre',
    'user-select:none',
  ].join(';');

  const style = document.createElement('style');
  style.textContent = `
    #debug-overlay .row { display: flex; gap: 8px; justify-content: space-between; }
    #debug-overlay .label { opacity: 0.7; min-width: 5em; }
    #debug-overlay .value { text-align: right; min-width: 4.5em; }
    #debug-overlay .limit { opacity: 0.5; min-width: 6em; text-align: right; }
    #debug-overlay .over .value, #debug-overlay .over .limit { color: #ff5c5c; opacity: 1; }
  `;

  const root = document.getElementById('overlay-root') ?? document.body;
  root.appendChild(style);
  root.appendChild(panel);

  // Усреднение FPS за последнюю секунду.
  let frameCount = 0;
  let windowStart = performance.now();
  let fps = 0;

  // Вес загруженных ресурсов — из Resource Timing API, не требует рендерера.
  let resourcesBytes = 0;
  let resourcesFallback = false;
  function refreshResourceWeight(): void {
    try {
      const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      let total = 0;
      let sawTransferSize = false;
      for (const entry of entries) {
        if (entry.transferSize > 0) {
          sawTransferSize = true;
          total += entry.transferSize;
        } else if (entry.decodedBodySize > 0) {
          total += entry.decodedBodySize;
        }
      }
      resourcesBytes = total;
      resourcesFallback = !sawTransferSize && total > 0;
    } catch {
      // Resource Timing недоступен (например, старый WebView) — не падаем.
    }
  }
  refreshResourceWeight();
  const resourceTimer = window.setInterval(refreshResourceWeight, 1000);

  let rafId = 0;
  function frame(): void {
    frameCount += 1;
    const now = performance.now();
    const elapsed = now - windowStart;
    if (elapsed >= 1000) {
      fps = (frameCount * 1000) / elapsed;
      frameCount = 0;
      windowStart = now;
      render();
    }
    rafId = requestAnimationFrame(frame);
  }

  function render(): void {
    const rows: string[] = [];

    rows.push(
      renderRow(
        'FPS',
        fps > 0 ? fps.toFixed(0) : '…',
        `≥ ${BUDGET.fps}`,
        fps > 0 && fps < BUDGET.fps,
      ),
    );

    if (currentRenderer) {
      const info = currentRenderer.info;
      const color = colorPass ?? { calls: 0, triangles: 0 };
      const shadow = shadowPass ?? { calls: 0, triangles: 0 };
      const worstCalls = color.calls + shadow.calls;
      const worstTriangles = color.triangles + shadow.triangles;
      rows.push(
        renderRow(
          'draw calls',
          String(color.calls),
          `≤ ${BUDGET.drawCalls}`,
          color.calls > BUDGET.drawCalls,
        ),
      );
      rows.push(renderRow('теневой проход', `+${shadow.calls}`, '—', false));
      rows.push(
        renderRow(
          'кадр с тенью',
          String(worstCalls),
          `≤ ${BUDGET.drawCalls}`,
          worstCalls > BUDGET.drawCalls,
        ),
      );
      rows.push(
        renderRow(
          'треугольники',
          worstTriangles.toLocaleString('ru-RU'),
          `≤ ${BUDGET.triangles.toLocaleString('ru-RU')}`,
          worstTriangles > BUDGET.triangles,
        ),
      );
      rows.push(renderRow('тр. в тени', shadow.triangles.toLocaleString('ru-RU'), '—', false));
      // Для количества геометрий/текстур в памяти отдельного бюджета в правилах проекта нет —
      // лимит через draw calls и вес ресурсов, показываем без подсветки.
      rows.push(renderRow('геометрии', String(info.memory.geometries), '—', false));
      rows.push(renderRow('текстуры', String(info.memory.textures), '—', false));
    } else {
      rows.push(renderRow('draw calls', '—', `≤ ${BUDGET.drawCalls}`, false));
      rows.push(renderRow('теневой проход', '—', '—', false));
      rows.push(renderRow('кадр с тенью', '—', `≤ ${BUDGET.drawCalls}`, false));
      rows.push(
        renderRow('треугольники', '—', `≤ ${BUDGET.triangles.toLocaleString('ru-RU')}`, false),
      );
      rows.push(renderRow('тр. в тени', '—', '—', false));
      rows.push(renderRow('геометрии', '—', '—', false));
      rows.push(renderRow('текстуры', '—', '—', false));
    }

    rows.push(
      renderRow(
        'ресурсы' + (resourcesFallback ? '*' : ''),
        formatBytes(resourcesBytes),
        `≤ ${formatBytes(BUDGET.resourcesBytes)}`,
        resourcesBytes > BUDGET.resourcesBytes,
      ),
    );

    panel.innerHTML = rows.join('');
  }

  render();
  rafId = requestAnimationFrame(frame);

  return {
    setRenderer(next: WebGLRenderer | undefined): void {
      attach(next);
    },
    beforeFrame(): void {
      if (!currentRenderer) return;
      const now = performance.now();
      // Раз в секунду просим пересчитать тень: иначе в установившемся кадре
      // теневого прохода нет вовсе и мерить нечего.
      if (now - lastShadowProbe > 1000) {
        lastShadowProbe = now;
        currentRenderer.shadowMap.needsUpdate = true;
      }
      measuringShadow = currentRenderer.shadowMap.needsUpdate;
    },
    afterFrame(): void {
      if (!currentRenderer) return;
      const info = currentRenderer.info;
      const frame: PassStats = { calls: info.render.calls, triangles: info.render.triangles };
      if (measuringShadow) {
        const base = colorPass ?? frame;
        shadowPass = {
          calls: Math.max(0, frame.calls - base.calls),
          triangles: Math.max(0, frame.triangles - base.triangles),
        };
      } else {
        colorPass = frame;
      }
      info.reset();
    },
    dispose(): void {
      cancelAnimationFrame(rafId);
      window.clearInterval(resourceTimer);
      if (currentRenderer) currentRenderer.info.autoReset = true;
      panel.remove();
      style.remove();
    },
  };
}
