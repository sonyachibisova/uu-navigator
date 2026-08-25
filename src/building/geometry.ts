/**
 * Общие геометрии движка (инвариант 8 правил проекта).
 *
 * В сцене живут ровно две базовые формы: единичный куб и единичный диск.
 * Любой прямоугольный объём — это масштабированный экземпляр куба, поэтому
 * `new BoxGeometry(w, h, d)` в коде здания не встречается ни разу.
 */
import { BoxGeometry, CylinderGeometry } from 'three';
import type { BufferGeometry } from 'three';

let unitBoxGeometry: BoxGeometry | undefined;
let unitDiscGeometry: CylinderGeometry | undefined;

/** Куб 1×1×1 с центром в начале координат. */
export function unitBox(): BufferGeometry {
  if (!unitBoxGeometry) {
    unitBoxGeometry = new BoxGeometry(1, 1, 1);
    unitBoxGeometry.name = 'unit.box';
  }
  return unitBoxGeometry;
}

/** Диск диаметром 1 и толщиной 1, ось — Z (иллюминаторы смотрят «из фасада»). */
export function unitDisc(): BufferGeometry {
  if (!unitDiscGeometry) {
    unitDiscGeometry = new CylinderGeometry(0.5, 0.5, 1, 24);
    unitDiscGeometry.rotateX(Math.PI / 2);
    unitDiscGeometry.name = 'unit.disc';
  }
  return unitDiscGeometry;
}

/** Освободить общие геометрии. Вызывается один раз при разборке приложения. */
export function disposeSharedGeometry(): void {
  unitBoxGeometry?.dispose();
  unitDiscGeometry?.dispose();
  unitBoxGeometry = undefined;
  unitDiscGeometry = undefined;
}
