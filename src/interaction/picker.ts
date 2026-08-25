/**
 * Raycasting по слою кликабельных помещений.
 *
 * Слой один на этаж и собран в `InstancedMesh`, поэтому попадание возвращает
 * `instanceId`, а не отдельный меш: по нему находится помещение активного этажа.
 *
 * Попадание проверяется на перекрытие оболочкой. При стартовом ракурсе луч к
 * плитам южного ряда идёт сквозь южную стену выбранного кольца: без проверки
 * курсор стоит на кирпичной стене, а выбирается помещение за ней.
 */
import { Raycaster, Vector2 } from 'three';
import type { Camera, InstancedMesh, Material, Object3D } from 'three';
import type { RoomView } from '@building/source';

/** Непрозрачность, начиная с которой поверхность считается закрывающей обзор. */
const OPAQUE_ENOUGH = 0.9;
/** Допуск по глубине: элементы фасада стоят вплотную к плите этажа. */
const DEPTH_EPS = 0.02;

export interface PickResult {
  room: RoomView;
  instanceId: number;
}

/** Видно ли сквозь этот меш: растворённая или приглушённая поверхность не мешает. */
function seeThrough(object: Object3D): boolean {
  const holder = object as Object3D & { material?: Material | Material[] };
  const material = holder.material;
  if (!material) return true;
  const list = Array.isArray(material) ? material : [material];
  return list.every((item) => item.transparent && item.opacity < OPAQUE_ENOUGH);
}

export class RoomPicker {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  /**
   * Найти помещение под точкой экрана.
   * @param x, y — координаты в пикселях относительно канваса.
   */
  pick(
    x: number,
    y: number,
    width: number,
    height: number,
    camera: Camera,
    target: InstancedMesh | undefined,
    rooms: readonly RoomView[],
    occluders: readonly Object3D[] = [],
  ): PickResult | null {
    if (!target || !target.visible || width <= 0 || height <= 0) return null;
    this.pointer.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, camera);
    const hit = this.raycaster.intersectObject(target, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const room = rooms[hit.instanceId];
    if (!room) return null;
    if (this.blocked(hit.distance, occluders)) return null;
    return { room, instanceId: hit.instanceId };
  }

  /** Есть ли непрозрачная поверхность оболочки ближе, чем найденная плита. */
  private blocked(distance: number, occluders: readonly Object3D[]): boolean {
    if (occluders.length === 0) return false;
    // Луч уже настроен предыдущим вызовом: пересечения приходят по возрастанию глубины.
    const hits = this.raycaster.intersectObjects([...occluders], true);
    for (const candidate of hits) {
      if (candidate.distance >= distance - DEPTH_EPS) return false;
      if (seeThrough(candidate.object)) continue;
      return true;
    }
    return false;
  }
}
