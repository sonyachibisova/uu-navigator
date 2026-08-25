/**
 * Оболочка здания: несущие грани (`shellGroup`) и всё навесное (`facadeGroup`).
 *
 * Две группы верхнего уровня из четырёх (инвариант 1 правил проекта). Внутри каждой —
 * по группе на кольцо этажа, внутри кольца — по мешу на пару (грань, материал).
 * Поэтому `shell.floor.03.wall.north` остаётся самостоятельным мешем: срез по
 * этажу управляет кольцом целиком, а растворение по направлению взгляда
 * сможет управлять отдельной гранью, ничего здесь не меняя.
 */
import { Group } from 'three';
import type { InstancedMesh, Mesh } from 'three';
import { PartBatcher, disposeBatched } from '@building/batch';
import { SignFactory } from '@building/signs';
import type { Palette } from '@building/materials';
import type { ShellBand } from '@building/source';
import type { FadeRegistry } from '@core/fade';

export interface ShellHandle {
  shellGroup: Group;
  facadeGroup: Group;
  /** Имя канала `FadeRegistry` для кольца этажа. */
  bandChannel: (level: number) => string;
  dispose: () => void;
}

/** Канал растворения кольца: один на этаж. */
function channelOf(level: number): string {
  return `band.${String(level).padStart(2, '0')}`;
}

export function createShell(
  bands: readonly ShellBand[],
  palette: Palette,
  fade: FadeRegistry,
): ShellHandle {
  const shellGroup = new Group();
  shellGroup.name = 'shellGroup';
  const facadeGroup = new Group();
  facadeGroup.name = 'facadeGroup';

  const built: InstancedMesh[] = [];
  const signs = new SignFactory();
  const signMeshes: Mesh[] = [];

  for (const band of bands) {
    const channel = channelOf(band.level);

    const shellBand = new Group();
    shellBand.name = `shell.${band.name}`;
    shellGroup.add(shellBand);
    const shellBatcher = new PartBatcher();
    for (const face of band.shell) shellBatcher.addAll(face.name, face.parts);
    const shellMeshes = shellBatcher.build(shellBand, palette.surface);

    const facadeBand = new Group();
    facadeBand.name = `facade.${band.name}`;
    facadeGroup.add(facadeBand);
    const facadeBatcher = new PartBatcher();
    for (const face of band.facade) facadeBatcher.addAll(face.name, face.parts);
    const facadeMeshes = facadeBatcher.build(facadeBand, palette.surface);

    built.push(...shellMeshes, ...facadeMeshes);
    for (const mesh of [...shellMeshes, ...facadeMeshes]) fade.add(mesh, channel);

    for (const sign of band.signs) {
      const mesh = signs.create(sign, facadeBand);
      signMeshes.push(mesh);
      fade.add(mesh, channel);
    }
  }

  return {
    shellGroup,
    facadeGroup,
    bandChannel: channelOf,
    dispose(): void {
      disposeBatched(built);
      built.length = 0;
      for (const mesh of signMeshes) mesh.removeFromParent();
      signMeshes.length = 0;
      signs.dispose();
      shellGroup.removeFromParent();
      facadeGroup.removeFromParent();
      shellGroup.clear();
      facadeGroup.clear();
    },
  };
}
