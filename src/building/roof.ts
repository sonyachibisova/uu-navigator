/**
 * Кровля: плита, парапет, надстройки. Третья группа верхнего уровня.
 *
 * Кровля растворяется отдельным каналом, потому что в срезе по этажу она
 * уходит вместе с кольцами выше выбранного, а в кукольном доме будет уходить
 * по углу взгляда к горизонту (привязка к одной точке фокуса разваливается при облёте).
 */
import { Group } from 'three';
import type { InstancedMesh } from 'three';
import { PartBatcher, disposeBatched } from '@building/batch';
import type { Palette } from '@building/materials';
import type { RoofView } from '@building/source';
import type { FadeRegistry } from '@core/fade';

export const ROOF_CHANNEL = 'roof';

export interface RoofHandle {
  roofGroup: Group;
  dispose: () => void;
}

export function createRoof(roof: RoofView, palette: Palette, fade: FadeRegistry): RoofHandle {
  const roofGroup = new Group();
  roofGroup.name = 'roofGroup';

  const batcher = new PartBatcher();
  for (const part of roof.parts) {
    // Владелец батча — сам элемент: плита, парапет и надстройка растворяются порознь.
    batcher.add(part.name, part);
  }
  const meshes: InstancedMesh[] = batcher.build(roofGroup, palette.surface);
  for (const mesh of meshes) fade.add(mesh, ROOF_CHANNEL);

  return {
    roofGroup,
    dispose(): void {
      disposeBatched(meshes);
      meshes.length = 0;
      roofGroup.removeFromParent();
      roofGroup.clear();
    },
  };
}
