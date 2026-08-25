/**
 * Рендерер, его подгонка под размер окна и аварийное понижение качества.
 *
 * Качество зависит от платформы: на мобильном сглаживание выключено, карта
 * теней проще, плотность пикселей ограничена (бюджет проекта). Если кадр всё
 * равно не держится, включается аварийный режим — тени снимаются, плотность
 * пикселей опускается до 1.0. Обратно качество не поднимается: мигание
 * настройками хуже, чем стабильно простая картинка.
 */
import { PCFShadowMap, PCFSoftShadowMap, WebGLRenderer } from 'three';
import type { PerspectiveCamera } from 'three';

/** Больше 1.5 не берём: производительность важнее ретины. */
const MAX_PIXEL_RATIO = 1.5;
/** Плотность пикселей в аварийном режиме. */
const FALLBACK_PIXEL_RATIO = 1;
/** Ниже этого FPS кадр считается провальным (бюджет проекта). */
const FPS_FLOOR = 45;
/**
 * Доля от того, что экран вообще способен дать. Частоту кадра ограничивает не
 * только сцена: телефон в режиме энергосбережения режет экран до 30 Гц, и
 * сравнивать в этом случае с 45 бессмысленно — навигатор снял бы тени и
 * плотность пикселей на исправном кадре, просто потому что человек экономит
 * батарею. Провальным считается кадр, заметно отставший от достижимого.
 */
const FLOOR_RATIO = 0.75;
/**
 * Абсолютный низ: хуже этого кадр плох на любом экране. Нужен потому, что
 * потолок экрана оценивается по лучшему показанному кадру, а сцена, которая
 * ни разу не шла быстро, оценку занижает — без этого числа устройство, где
 * всё плохо всегда, аварийного режима не дождалось бы вовсе.
 */
const HARD_FLOOR = 24;
/** Сколько секунд подряд нужно продержаться ниже порога, чтобы понизить качество. */
const SLOW_SECONDS = 3;

export interface RendererHandle {
  renderer: WebGLRenderer;
  /** Пересчитать размеры под контейнер и камеру. Вызывается при resize. */
  resize: () => void;
  /**
   * Отметить кадр. Возвращает `true` ровно один раз — в тот кадр, когда
   * включился аварийный режим: вызывающий обязан снять тени со сцены.
   */
  sampleFrame: (dt: number) => boolean;
  /** Включён ли аварийный режим. */
  degraded: () => boolean;
  dispose: () => void;
}

/** Мобильная платформа: грубая проверка по возможностям ввода и ширине экрана. */
export function isMobileLike(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  return coarse && Math.min(window.innerWidth, window.innerHeight) <= 900;
}

export function createRenderer(container: HTMLElement, camera: PerspectiveCamera): RendererHandle {
  const mobile = isMobileLike();
  // Сглаживание — самая дорогая из «бесплатных на десктопе» настроек: на телефоне
  // оно съедает больше, чем даёт, поэтому включается только вне мобильной платформы.
  const renderer = new WebGLRenderer({ antialias: !mobile, powerPreference: 'high-performance' });
  const maxRatio = mobile ? Math.min(MAX_PIXEL_RATIO, 1.25) : MAX_PIXEL_RATIO;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = mobile ? PCFShadowMap : PCFSoftShadowMap;
  // Солнце и геометрия статичны, поэтому полный теневой проход каждый кадр не нужен:
  // карта пересчитывается точечно, по запросу сцены (см. `@core/environment`).
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  container.appendChild(renderer.domElement);

  let degraded = false;
  let slowFor = 0;
  /** Лучшая частота кадра, которую экран показал: оценка его потолка. */
  let bestFps = 0;

  function resize(): void {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
    // Кадр после смены размера рисуется заново вместе с тенью.
    renderer.shadowMap.needsUpdate = true;
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    renderer,
    resize,
    sampleFrame(dt: number): boolean {
      if (degraded || dt <= 0) return false;
      const fps = 1 / dt;
      if (fps > bestFps) bestFps = fps;
      // Порог — минимум из бюджета и доли от достижимого на этом экране.
      // На экране 30 Гц порогом становится 22, а не 45.
      const floor = Math.max(HARD_FLOOR, Math.min(FPS_FLOOR, bestFps * FLOOR_RATIO));
      // Одиночные провалы (загрузка текстуры, смена этажа) не считаются: нужен
      // устойчивый провал в течение нескольких секунд подряд.
      if (fps < floor) slowFor += dt;
      else slowFor = 0;
      if (slowFor < SLOW_SECONDS) return false;
      degraded = true;
      renderer.shadowMap.enabled = false;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, FALLBACK_PIXEL_RATIO));
      resize();
      return true;
    },
    degraded: () => degraded,
    dispose(): void {
      window.removeEventListener('resize', resize);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
