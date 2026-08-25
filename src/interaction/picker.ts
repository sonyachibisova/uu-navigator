/**
 * Raycasting по кликабельным слоям помещений.
 *
 * Слой один на этаж и собран в `InstancedMesh`, поэтому попадание возвращает
 * `instanceId`, а не отдельный меш: по нему находится помещение своего этажа.
 * Слоёв может быть несколько сразу — в режиме «здание целиком» кликабельны все
 * этажи с известной планировкой, и побеждает ближайший к камере.
 *
 * Попадание проверяется на перекрытие оболочкой. При стартовом ракурсе луч к
 * плитам южного ряда идёт сквозь южную стену выбранного кольца: без проверки
 * курсор стоит на кирпичной стене, а выбирается помещение за ней.
 */
import { Raycaster, Vector2 } from 'three';
import type { Camera, Intersection, Material, Object3D } from 'three';
import type { PickLayer } from '@building/building';
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
  // `Raycaster` не смотрит на `visible`, поэтому растворённая до нуля стена
  // продолжает ловить луч. Погашенный меш заведомо ничего не закрывает.
  if (!object.visible) return true;
  const holder = object as Object3D & { material?: Material | Material[] };
  const material = holder.material;
  if (!material) return true;
  const list = Array.isArray(material) ? material : [material];
  return list.every((item) => item.transparent && item.opacity < OPAQUE_ENOUGH);
}

export class RoomPicker {
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  /** Приёмник пересечений: один на весь срок жизни, чтобы не плодить массивы. */
  private readonly hits: Intersection[] = [];

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
    layers: readonly PickLayer[],
    occluders: Object3D[],
  ): PickResult | null {
    if (layers.length === 0 || width <= 0 || height <= 0) return null;
    this.pointer.set((x / width) * 2 - 1, -(y / height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, camera);

    let room: RoomView | undefined;
    let instanceId = -1;
    let distance = Number.POSITIVE_INFINITY;

    for (const layer of layers) {
      // Погашенный слой не кликается: луч его всё равно видит, а человек — нет.
      if (!layer.mesh.visible) continue;
      this.hits.length = 0;
      this.raycaster.intersectObject(layer.mesh, false, this.hits);
      const hit = this.hits[0];
      if (!hit || hit.instanceId === undefined || hit.distance >= distance) continue;
      const candidate = layer.rooms[hit.instanceId];
      if (!candidate) continue;
      room = candidate;
      instanceId = hit.instanceId;
      distance = hit.distance;
    }
    this.hits.length = 0;

    if (!room) return null;
    if (this.blocked(distance, occluders)) return null;
    return { room, instanceId };
  }

  /** Есть ли непрозрачная поверхность оболочки ближе, чем найденная плита. */
  private blocked(distance: number, occluders: Object3D[]): boolean {
    if (occluders.length === 0) return false;
    // Луч уже настроен предыдущим вызовом: пересечения приходят по возрастанию глубины.
    this.hits.length = 0;
    const hits = this.raycaster.intersectObjects(occluders, true, this.hits);
    let blocked = false;
    for (const candidate of hits) {
      if (candidate.distance >= distance - DEPTH_EPS) break;
      if (seeThrough(candidate.object)) continue;
      blocked = true;
      break;
    }
    this.hits.length = 0;
    return blocked;
  }
}
