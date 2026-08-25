/**
 * Кровля: плита, парапет, надстройки. Третья группа верхнего уровня.
 *
 * Кровля растворяется отдельным каналом от стен, потому что ведут её разные
 * величины: срез по этажу убирает её вместе с кольцами выше выбранного,
 * а кукольный дом — по углу взгляда к горизонту. При взгляде сбоку кровля
 * остаётся, иначе здание теряет силуэт.
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
    // Владелец батча — сам элемент: у плиты, парапета и надстройки остаются
    // собственные имена, по которым их находят в сцене. Растворяются они при
    // этом вместе, одним каналом `ROOF_CHANNEL`: величина у кровли одна — угол
    // взгляда к горизонту, и делить её между элементами нечем.
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
