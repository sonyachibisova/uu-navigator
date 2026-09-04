/// <reference types="vite/client" />
/**
 * `ProceduralSource` — реализация `BuildingSource`, которая собирает здание из
 * `data/building.json` и `data/floors/*.json`.
 *
 * Данные проверяются схемами Zod при создании источника. При несоответствии
 * бросается `BuildingDataError` со списком правок: какой объект чинить и что
 * в нём не так, — а не стек ошибок и не пустой экран.
 *
 * Файлы этажей подхватываются по маске: добавить этаж или помещение — правка
 * данных, а не кода.
 */
import { z } from 'zod';
import { BuildingSchema, floorSchemaFor } from '@data/schema';
import type { Building, Envelope, Floor } from '@data/schema';
import type {
  BuildingPassport,
  BuildingSource,
  EntranceView,
  FloorView,
  RoofView,
  ShellBand,
} from '@building/source';
import { DEFAULT_ENVELOPE_PROFILE, type EnvelopeProfile } from '@building/sources/envelope-profile';
import { buildBands, buildEntrance, buildRoof } from '@building/sources/envelope';
import { buildFloorView } from '@building/sources/interior';

import buildingRaw from '../../../data/building.json';

const floorModules = import.meta.glob<{ default: unknown }>('../../../data/floors/*.json', {
  eager: true,
});

/** Ошибка данных: сообщение — готовый список правок. */
export class BuildingDataError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Данные здания не прошли проверку:\n${issues.map((s) => `  — ${s}`).join('\n')}`);
    this.name = 'BuildingDataError';
    this.issues = issues;
  }
}

function formatIssues(source: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(корень)';
    return `${source}: ${path} — ${issue.message}`;
  });
}

function readFloors(building: Building, issues: string[]): Floor[] {
  const schema = floorSchemaFor(building);
  const byLevel = new Map<number, Floor>();
  const entries = Object.entries(floorModules).sort(([a], [b]) => a.localeCompare(b));

  for (const [path, module] of entries) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const parsed = schema.safeParse(module.default);
    if (!parsed.success) {
      issues.push(...formatIssues(`floors/${file}`, parsed.error));
      continue;
    }
    if (byLevel.has(parsed.data.level)) {
      issues.push(`floors/${file}: этаж ${parsed.data.level} описан дважды`);
      continue;
    }
    byLevel.set(parsed.data.level, parsed.data);
  }

  const floors: Floor[] = [];
  for (const ref of building.floors) {
    const floor = byLevel.get(ref.level);
    if (!floor) {
      issues.push(
        `building.json: этаж ${ref.level} перечислен в паспорте, но файла «${ref.file}» нет`,
      );
      continue;
    }
    if (floor.layoutKnown !== ref.layoutKnown) {
      issues.push(
        `floors/${ref.file}: layoutKnown = ${String(floor.layoutKnown)}, а в паспорте здания ${String(ref.layoutKnown)}`,
      );
    }
    floors.push(floor);
  }
  return floors.sort((a, b) => a.level - b.level);
}

export class ProceduralSource implements BuildingSource {
  readonly passport: BuildingPassport;
  /** Пропорции наружной композиции: доли габарита, общие для любого здания. */
  private readonly profile: EnvelopeProfile;
  /** Габариты оболочки этого здания из данных; блока может не быть вовсе. */
  private readonly envelope: Envelope | undefined;
  private readonly floorData: Floor[];
  private bandsCache: ShellBand[] | undefined;
  private roofCache: RoofView | undefined;
  private floorsCache: FloorView[] | undefined;
  private entranceCache: EntranceView | undefined;
  private entranceRead = false;

  constructor() {
    const issues: string[] = [];
    const parsed = BuildingSchema.safeParse(buildingRaw);
    if (!parsed.success) {
      throw new BuildingDataError(formatIssues('building.json', parsed.error));
    }
    const building = parsed.data;
    this.profile = DEFAULT_ENVELOPE_PROFILE;
    this.envelope = building.envelope;
    this.floorData = readFloors(building, issues);
    if (issues.length > 0) throw new BuildingDataError(issues);

    this.passport = {
      id: building.id,
      name: building.name,
      shortName: building.shortName,
      size: building.size,
      floorCount: building.floorCount,
      floorHeight: building.floorHeight,
      footprint: building.footprint,
    };
  }

  bands(): ShellBand[] {
    this.bandsCache ??= buildBands(this.passport, this.profile, this.envelope);
    return this.bandsCache;
  }

  roof(): RoofView {
    this.roofCache ??= buildRoof(this.passport, this.profile);
    return this.roofCache;
  }

  floors(): FloorView[] {
    this.floorsCache ??= this.floorData.map((floor) =>
      buildFloorView(floor, this.passport.footprint, this.passport.floorHeight),
    );
    return this.floorsCache;
  }

  entrance(): EntranceView | undefined {
    if (!this.entranceRead) {
      this.entranceRead = true;
      this.entranceCache = buildEntrance(this.passport, this.profile);
    }
    return this.entranceCache;
  }
}
