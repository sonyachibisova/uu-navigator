/**
 * Цикл анимации. Единственное место, где меряется время кадра: всё сглаживание
 * в движке идёт по `dt`, а не по числу кадров (инвариант 6 правил проекта).
 */
import type { WebGLRenderer } from 'three';

export type FrameCallback = (dt: number) => void;

export interface LoopHandle {
  start: () => void;
  stop: () => void;
}

/** Ограничение шага: после возврата на вкладку `dt` не должен «прыгать». */
const MAX_DT = 0.1;

export function createLoop(renderer: WebGLRenderer, onFrame: FrameCallback): LoopHandle {
  let last = 0;
  let running = false;

  function tick(now: number): void {
    const dt = last === 0 ? 1 / 60 : Math.min((now - last) / 1000, MAX_DT);
    last = now;
    onFrame(dt);
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      last = 0;
      renderer.setAnimationLoop(tick);
    },
    stop(): void {
      running = false;
      renderer.setAnimationLoop(null);
    },
  };
}
