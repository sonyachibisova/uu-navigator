/**
 * Сборка элементов в меши.
 *
 * Батчим не по материалу целиком, а по паре (владелец, материал), где владелец —
 * именованная грань оболочки или слой этажа. Тогда `wall.north` третьего этажа
 * остаётся отдельным мешем, который можно растворить независимо (инвариант 2),
 * а число draw calls остаётся низким.
 *
 * Каждый батч — `InstancedMesh` поверх общей unit-геометрии: одна геометрия
 * на всё здание, положение и размер элемента живут в матрице экземпляра.
 */
import { InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import type { Material, Object3D } from 'three';
import { unitBox, unitDisc } from '@building/geometry';
import type { Part, SurfaceKey } from '@building/source';

interface BatchEntry {
  owner: string;
  surface: SurfaceKey;
  kind: Part['shape']['kind'];
  shadow: boolean;
  parts: Part[];
}

const NO_ROTATION = new Quaternion();

/**
 * Копилка элементов. `owner` — имя грани или слоя: он же становится именем
 * меша, когда на грани один материал, и префиксом имени, когда их несколько.
 */
export class PartBatcher {
  private readonly entries = new Map<string, BatchEntry>();

  add(owner: string, part: Part): void {
    const shadow = part.shadow !== false;
    const key = `${owner}|${part.surface}|${part.shape.kind}|${shadow ? 1 : 0}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { owner, surface: part.surface, kind: part.shape.kind, shadow, parts: [] };
      this.entries.set(key, entry);
    }
    entry.parts.push(part);
  }

  addAll(owner: string, parts: readonly Part[]): void {
    for (const part of parts) this.add(owner, part);
  }

  /** Сколько владельцев накопилось (для отладки и подсчёта draw calls). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Собрать меши и положить их в `target`. Возвращает созданные меши,
   * чтобы вызывающий мог зарегистрировать их в `FadeRegistry`.
   */
  build(target: Object3D, material: (surface: SurfaceKey) => Material): InstancedMesh[] {
    const built: InstancedMesh[] = [];
    // Имя меша обязано быть уникальным: по нему сцену ищут через `getObjectByName`.
    // Считаем, на скольких уровнях подробности имя ещё сталкивается: владелец →
    // владелец с материалом → плюс форма → плюс признак тени.
    const perOwner = new Map<string, number>();
    const perSurface = new Map<string, number>();
    const perKind = new Map<string, number>();
    const bump = (map: Map<string, number>, key: string): void => {
      map.set(key, (map.get(key) ?? 0) + 1);
    };
    for (const entry of this.entries.values()) {
      bump(perOwner, entry.owner);
      bump(perSurface, `${entry.owner}|${entry.surface}`);
      bump(perKind, `${entry.owner}|${entry.surface}|${entry.kind}`);
    }

    const nameOf = (entry: BatchEntry): string => {
      if ((perOwner.get(entry.owner) ?? 1) <= 1) return entry.owner;
      const withSurface = `${entry.owner}.${entry.surface}`;
      if ((perSurface.get(`${entry.owner}|${entry.surface}`) ?? 1) <= 1) return withSurface;
      const withKind = `${withSurface}.${entry.kind}`;
      if ((perKind.get(`${entry.owner}|${entry.surface}|${entry.kind}`) ?? 1) <= 1) return withKind;
      return `${withKind}.${entry.shadow ? 'shadow' : 'flat'}`;
    };

    const matrix = new Matrix4();
    const position = new Vector3();
    const scale = new Vector3();

    for (const entry of this.entries.values()) {
      const geometry = entry.kind === 'box' ? unitBox() : unitDisc();
      const mesh = new InstancedMesh(geometry, material(entry.surface), entry.parts.length);
      mesh.name = nameOf(entry);
      mesh.castShadow = entry.shadow;
      mesh.receiveShadow = entry.shadow;
      mesh.userData['parts'] = entry.parts.map((part) => part.name);

      entry.parts.forEach((part, index) => {
        position.set(part.center.x, part.center.y, part.center.z);
        if (part.shape.kind === 'box') {
          scale.set(part.shape.width, part.shape.height, part.shape.depth);
        } else {
          scale.set(part.shape.radius * 2, part.shape.radius * 2, part.shape.thickness);
        }
        matrix.compose(position, NO_ROTATION, scale);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      target.add(mesh);
      built.push(mesh);
    }
    this.entries.clear();
    return built;
  }
}

/**
 * Освободить меши батча. Общая unit-геометрия остаётся жить (её удаляет
 * `disposeSharedGeometry`), материалы принадлежат палитре или `FadeRegistry`
 * и освобождаются ими же — здесь снимаются только буферы экземпляров.
 */
export function disposeBatched(meshes: readonly InstancedMesh[]): void {
  for (const mesh of meshes) {
    mesh.removeFromParent();
    mesh.dispose();
  }
}
