/**
 * Оболочка здания: несущие грани (`shellGroup`) и всё навесное (`facadeGroup`).
 *
 * Две группы верхнего уровня из четырёх (инвариант 1 правил проекта). Внутри каждой —
 * по группе на кольцо этажа, внутри кольца — по мешу на пару (грань, материал).
 *
 * Единица растворения — грань кольца, а не кольцо целиком: `wall.north`
 * третьего этажа получает собственный канал `FadeRegistry` и растворяется
 * независимо от остальных трёх стен (инвариант 2). Несущая стена, её остекление
 * и вывески на ней лежат в одном канале намеренно: если растворять их порознь,
 * окна и буквы повисают в воздухе там, где стена уже исчезла.
 */
import { Group, Vector3 } from 'three';
import type { InstancedMesh, Mesh } from 'three';
import { PartBatcher, disposeBatched } from '@building/batch';
import { SignFactory } from '@building/signs';
import type { Palette } from '@building/materials';
import type { Part, ShellBand, Side, Vec3 } from '@building/source';
import type { FadeRegistry } from '@core/fade';

/** Внешняя нормаль грани в плане: `[x, z]`. Север здания — минимальный Z. */
const SIDE_NORMAL: Record<Side, readonly [number, number]> = {
  north: [0, -1],
  south: [0, 1],
  west: [-1, 0],
  east: [1, 0],
};

/** Фрагмент оболочки: одна грань кольца со своим каналом растворения. */
export interface ShellFragment {
  /** Канал `FadeRegistry`, которым управляется вся грань. */
  channel: string;
  /** Кольцо этажа, к которому принадлежит грань: по нему работает срез по этажу. */
  level: number;
  /** Центр грани: середина её элементов. */
  center: Vector3;
  /** Внешняя нормаль грани: горизонтальная, единичной длины. */
  normal: Vector3;
}

export interface ShellHandle {
  shellGroup: Group;
  facadeGroup: Group;
  /** Фрагменты оболочки: по одному на грань каждого кольца. */
  fragments: ShellFragment[];
  dispose: () => void;
}

/** Канал растворения грани кольца. */
function channelOf(level: number, side: Side): string {
  return `band.${String(level).padStart(2, '0')}.${side}`;
}

/** Копилка одной грани кольца: центр набирается по мере добавления элементов. */
interface FaceAccumulator {
  side: Side;
  channel: string;
  sum: Vector3;
  count: number;
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
  const fragments: ShellFragment[] = [];

  for (const band of bands) {
    const shellBand = new Group();
    shellBand.name = `shell.${band.name}`;
    shellGroup.add(shellBand);

    const facadeBand = new Group();
    facadeBand.name = `facade.${band.name}`;
    facadeGroup.add(facadeBand);

    const faces = new Map<Side, FaceAccumulator>();
    const accumulatorOf = (side: Side): FaceAccumulator => {
      let accumulator = faces.get(side);
      if (!accumulator) {
        accumulator = {
          side,
          channel: channelOf(band.level, side),
          sum: new Vector3(),
          count: 0,
        };
        faces.set(side, accumulator);
      }
      return accumulator;
    };
    const collect = (accumulator: FaceAccumulator, center: Vec3): void => {
      accumulator.sum.x += center.x;
      accumulator.sum.y += center.y;
      accumulator.sum.z += center.z;
      accumulator.count += 1;
    };

    // Батчер на грань, а не на кольцо: имя меша остаётся именем грани,
    // и каждая грань уходит в свой канал целиком.
    const build = (target: Group, name: string, parts: readonly Part[], side: Side): void => {
      if (parts.length === 0) return;
      const accumulator = accumulatorOf(side);
      const batcher = new PartBatcher();
      batcher.addAll(name, parts);
      const meshes = batcher.build(target, palette.surface);
      built.push(...meshes);
      for (const mesh of meshes) fade.add(mesh, accumulator.channel);
      for (const part of parts) collect(accumulator, part.center);
    };

    for (const face of band.shell) build(shellBand, face.name, face.parts, face.side);
    for (const face of band.facade) build(facadeBand, face.name, face.parts, face.side);

    for (const sign of band.signs) {
      // Вывеска принадлежит той грани, которую назвал источник: по ней же её
      // плоскость разворачивается наружу. Грани в кольце нет — вывеска не
      // создаётся вовсе. Иначе меш попадал бы в сцену мимо `FadeRegistry`,
      // с общим кэшированным материалом и без канала растворения: он остался бы
      // висеть в воздухе после того, как его стена уже растворилась.
      const accumulator = faces.get(sign.side);
      if (!accumulator) continue;
      const mesh = signs.create(sign, facadeBand);
      signMeshes.push(mesh);
      fade.add(mesh, accumulator.channel);
      collect(accumulator, sign.center);
    }

    for (const accumulator of faces.values()) {
      if (accumulator.count === 0) continue;
      const normal = SIDE_NORMAL[accumulator.side];
      fragments.push({
        channel: accumulator.channel,
        level: band.level,
        center: accumulator.sum.clone().divideScalar(accumulator.count),
        normal: new Vector3(normal[0], 0, normal[1]),
      });
    }
  }

  return {
    shellGroup,
    facadeGroup,
    fragments,
    dispose(): void {
      disposeBatched(built);
      built.length = 0;
      for (const mesh of signMeshes) mesh.removeFromParent();
      signMeshes.length = 0;
      signs.dispose();
      fragments.length = 0;
      shellGroup.removeFromParent();
      facadeGroup.removeFromParent();
      shellGroup.clear();
      facadeGroup.clear();
    },
  };
}
