/**
 * Построение оболочки и кровли по паспорту здания и профилю фасада.
 *
 * Оболочка разложена на кольца по этажам, кольцо — на именованные грани
 * (`shell.floor.03.wall.north`), грань — на элементы. Срез по этажу гасит
 * кольца выше выбранного; растворение отдельной грани по направлению взгляда
 * станет возможным без единой правки этой сборки, потому что
 * грань уже самостоятельная единица.
 */
import type {
  BuildingPassport,
  Envelope,
  Face,
  Part,
  RoofView,
  ShellBand,
  SignPart,
  Side,
  SurfaceKey,
  Vec3,
} from '@building/source';
import type { EnvelopeProfile, FaceGlazing } from '@building/sources/envelope-profile';

/** Двузначный номер этажа для точечных имён: `floor.04`. */
export function levelTag(level: number): string {
  return String(level).padStart(2, '0');
}

/**
 * Запасные пропорции входной группы и вывесок. Работают, только если в данных
 * здания нет блока `envelope`: тогда движок берёт их и ничего не ломает.
 * Высоты заданы долями высоты этажа, ширины вывесок — долей длины грани,
 * а абсолютные метры оставлены там, где размер задаёт человек, а не здание
 * (толщина импоста, ручка двери, шаг полки витрины).
 */
const ENTRANCE_FALLBACK = {
  portal: { y: 0.5, depth: 0.25 },
  glazing: { y: 0.4583, height: 0.9167, depth: 0.06, inset: 0.4 },
  transom: { y: 0.8194, height: 0.05, depth: 0.1, inset: 0.4 },
  mullions: { count: 5, width: 0.14, depth: 0.1 },
  handles: { offsets: [-0.35, 0.35], y: 0.4167, width: 0.07, height: 1.1, depth: 0.07 },
  pylon: { y: 0.4444, height: 0.8889, depth: 0.3 },
  showcase: { y: 0.4722, height: 0.9444, depth: 0.18 },
  showcaseGlass: { y: 0.4444, width: 1.6, height: 0.7222, depth: 0.06 },
  showcaseShelf: { height: 0.12, depth: 0.08, count: 5, step: 0.5, base: 0.7 },
  band: { y: 0.4444, height: 0.7222, depth: 0.15 },
} as const;

const SIGN_FALLBACK = {
  number: { y: 0.7222, zOffset: 0.37, width: 2.4, height: 4.4 },
  title: { x: -0.042, y: 1, zOffset: 0.4, width: 0.1724, height: 0.8 },
} as const;

/** Вынос элементов входной группы от плоскости фасада, метры. Это сборка, а не габарит. */
const ENTRANCE_Z = {
  portal: 0.04,
  glazing: 0.14,
  transom: 0.18,
  mullion: 0.18,
  handle: 0.26,
  pylon: 0.05,
  showcase: 0.06,
  showcaseGlass: 0.16,
  showcaseShelf: 0.2,
  band: 0.06,
} as const;

interface Frame {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  width: number;
  depth: number;
  cx: number;
  cz: number;
  height: number;
  floorHeight: number;
}

function frameOf(passport: BuildingPassport): Frame {
  const { x0, x1, z0, z1 } = passport.footprint;
  return {
    x0,
    x1,
    z0,
    z1,
    width: x1 - x0,
    depth: z1 - z0,
    cx: (x0 + x1) / 2,
    cz: (z0 + z1) / 2,
    height: passport.size.height,
    floorHeight: passport.floorHeight,
  };
}

function box(
  name: string,
  surface: SurfaceKey,
  width: number,
  height: number,
  depth: number,
  center: Vec3,
  shadow = true,
): Part {
  return { name, surface, shape: { kind: 'box', width, height, depth }, center, shadow };
}

function disc(
  name: string,
  surface: SurfaceKey,
  radius: number,
  thickness: number,
  center: Vec3,
): Part {
  return { name, surface, shape: { kind: 'disc', radius, thickness }, center, shadow: true };
}

/**
 * Снять тень с навесной декорации. Силуэт здания дают несущие грани и кровля,
 * а стёкла, импосты, транцы и подоконные пояса толщиной 6–18 см рисуют в
 * теневую карту то, чего в тени всё равно не видно, — и стоят до двух третей
 * теневого прохода при бюджете проекта в 150 draw calls.
 */
function cladding(parts: Part[]): Part[] {
  for (const part of parts) part.shadow = false;
  return parts;
}

/** Центры и ширина проёмов ряда остекления вдоль грани. */
function glazingBays(frame: Frame, spec: FaceGlazing): { center: number; width: number }[] {
  const span = (spec.end - spec.start) * frame.width;
  const pitch = span / (spec.bays - 1 + spec.fill);
  const width = pitch * spec.fill;
  const start = frame.x0 + spec.start * frame.width;
  const bays: { center: number; width: number }[] = [];
  for (let i = 0; i < spec.bays; i += 1)
    bays.push({ center: start + width / 2 + i * pitch, width });
  return bays;
}

/** Несущие грани кольца: четыре стены без навесных элементов. */
function shellFaces(frame: Frame, profile: EnvelopeProfile, level: number, yc: number): Face[] {
  const tag = levelTag(level);
  const prefix = `shell.floor.${tag}.wall`;
  const face = (side: Side, part: Part): Face => ({
    name: `${prefix}.${side}`,
    side,
    parts: [part],
  });
  return [
    face(
      'south',
      box(`${prefix}.south`, 'brick', frame.width, frame.floorHeight, profile.wall.south, {
        x: frame.cx,
        y: yc,
        z: frame.z1 - profile.wall.south / 2,
      }),
    ),
    face(
      'north',
      box(`${prefix}.north`, 'brick', frame.width, frame.floorHeight, profile.wall.north, {
        x: frame.cx,
        y: yc,
        z: frame.z0 + profile.wall.north / 2,
      }),
    ),
    face(
      'west',
      box(`${prefix}.west`, 'panel', profile.wall.west, frame.floorHeight, frame.depth, {
        x: frame.x0 - profile.wall.westOverhang,
        y: yc,
        z: frame.cz,
      }),
    ),
    face(
      'east',
      box(`${prefix}.east`, 'brick', profile.wall.east, frame.floorHeight, frame.depth, {
        x: frame.x1 - profile.wall.east / 2,
        y: yc,
        z: frame.cz,
      }),
    ),
  ];
}

/** Навесные элементы северной грани: ленты окон с подоконным поясом. */
function northFacade(frame: Frame, profile: EnvelopeProfile, level: number, yc: number): Part[] {
  if (level <= 1) return [];
  const tag = levelTag(level);
  const prefix = `facade.floor.${tag}.wall.north`;
  const fh = frame.floorHeight;
  const parts: Part[] = [];
  glazingBays(frame, profile.glazing.north).forEach((bay, i) => {
    const n = String(i + 1).padStart(2, '0');
    parts.push(
      box(
        `${prefix}.window.${n}.glass`,
        'glassTinted',
        bay.width,
        fh * profile.window.height,
        0.12,
        {
          x: bay.center,
          y: yc,
          z: frame.z0 - 0.07,
        },
      ),
    );
    parts.push(
      box(
        `${prefix}.window.${n}.sill`,
        'plaster',
        bay.width,
        fh * profile.window.sillHeight,
        0.18,
        { x: bay.center, y: yc - fh * profile.window.sillDrop, z: frame.z0 - 0.09 },
      ),
    );
  });
  return cladding(parts);
}

/** Навесные элементы западной грани: квадратные окна в обрамлении. */
function westFacade(frame: Frame, profile: EnvelopeProfile, level: number, yc: number): Part[] {
  if (level <= 1) return [];
  const tag = levelTag(level);
  const prefix = `facade.floor.${tag}.wall.west`;
  const fh = frame.floorHeight;
  const frameSize = fh * profile.westWindows.frame;
  const glassSize = fh * profile.westWindows.glass;
  const parts: Part[] = [];
  profile.westWindows.offsets.forEach((offset, i) => {
    const n = String(i + 1).padStart(2, '0');
    const z = frame.cz + offset * frame.depth;
    parts.push(
      box(`${prefix}.window.${n}.frame`, 'plaster', 0.22, frameSize, frameSize, {
        x: frame.x0 - 0.28,
        y: yc,
        z,
      }),
    );
    parts.push(
      box(`${prefix}.window.${n}.glass`, 'glassTinted', 0.14, glassSize, glassSize, {
        x: frame.x0 - 0.4,
        y: yc,
        z,
      }),
    );
  });
  return cladding(parts);
}

/** Навесные элементы восточной грани: витраж во всю высоту и междуэтажный пояс. */
function eastFacade(
  frame: Frame,
  profile: EnvelopeProfile,
  level: number,
  y0: number,
  yc: number,
): Part[] {
  const tag = levelTag(level);
  const prefix = `facade.floor.${tag}.wall.east`;
  const glazingDepth = profile.east.glazing * frame.depth;
  const parts: Part[] = [
    box(`${prefix}.glazing`, 'glassTinted', 0.18, frame.floorHeight, glazingDepth, {
      x: frame.x1 + 0.09,
      y: yc,
      z: frame.cz,
    }),
  ];
  if (level > 1) {
    parts.push(
      box(`${prefix}.belt`, 'plaster', 0.25, profile.east.belt, glazingDepth, {
        x: frame.x1 + 0.12,
        y: y0,
        z: frame.cz,
      }),
    );
  }
  return cladding(parts);
}

/** Навесные элементы лицевой (южной) грани — самая насыщенная сторона. */
function southFacade(
  frame: Frame,
  profile: EnvelopeProfile,
  level: number,
  y0: number,
  yc: number,
  entranceSpec: Envelope['entrance'],
): Part[] {
  const tag = levelTag(level);
  const prefix = `facade.floor.${tag}.wall.south`;
  const fh = frame.floorHeight;
  const z1 = frame.z1;
  const parts: Part[] = [];
  const at = (fraction: number): number => frame.cx + fraction * frame.width;

  if (level > 1) {
    glazingBays(frame, profile.glazing.south).forEach((bay, i) => {
      const n = String(i + 1).padStart(2, '0');
      const winHeight = fh * profile.window.height;
      parts.push(
        box(`${prefix}.window.${n}.frame`, 'trim', bay.width + 0.3, winHeight, 0.1, {
          x: bay.center,
          y: yc,
          z: z1 + 0.02,
        }),
      );
      parts.push(
        box(`${prefix}.window.${n}.glass`, 'glassTinted', bay.width, winHeight, 0.12, {
          x: bay.center,
          y: yc,
          z: z1 + 0.08,
        }),
      );
      const mullions = Math.max(1, Math.round(bay.width / profile.window.mullionStep));
      for (let m = 1; m < mullions; m += 1) {
        parts.push(
          box(`${prefix}.window.${n}.mullion.${m}`, 'trim', 0.1, winHeight - 0.2, 0.05, {
            x: bay.center - bay.width / 2 + (m * bay.width) / mullions,
            y: yc,
            z: z1 + 0.15,
          }),
        );
      }
      parts.push(
        box(`${prefix}.window.${n}.transom`, 'trim', bay.width, 0.1, 0.05, {
          x: bay.center,
          y: yc,
          z: z1 + 0.15,
        }),
      );
    });
    parts.push(
      box(
        `${prefix}.cornice`,
        'plaster',
        profile.cornice.width * frame.width,
        profile.cornice.height,
        0.25,
        { x: at(profile.cornice.center), y: y0, z: z1 + 0.1 },
      ),
    );
  }

  // Панельная вставка и чёрная башня входной группы идут сквозь все этажи.
  parts.push(
    box(`${prefix}.insert`, 'panel', profile.insert.width * frame.width, fh, 0.3, {
      x: at(profile.insert.center),
      y: yc,
      z: z1 - 0.05,
    }),
  );
  const towerX = at(profile.tower.center);
  parts.push(
    box(`${prefix}.tower.glazing`, 'glassDark', profile.tower.width, fh, 0.2, {
      x: towerX,
      y: yc,
      z: z1 + 0.15,
    }),
  );
  for (const sign of [-1, 1]) {
    parts.push(
      box(
        `${prefix}.tower.jamb.${sign < 0 ? 'west' : 'east'}`,
        'plaster',
        profile.tower.jambWidth,
        fh,
        0.3,
        { x: towerX + sign * profile.tower.jambOffset, y: yc, z: z1 + 0.1 },
      ),
    );
  }
  if (level > 1) {
    parts.push(
      box(`${prefix}.tower.lintel`, 'trim', profile.tower.width + 0.4, 0.2, 0.1, {
        x: towerX,
        y: y0,
        z: z1 + 0.27,
      }),
    );
  }

  if (level > 1 && profile.porthole) {
    const x = at(profile.porthole.center);
    parts.push(
      disc(`${prefix}.porthole.ring`, 'plaster', profile.porthole.ring, 0.12, {
        x,
        y: yc,
        z: z1 + 0.1,
      }),
    );
    parts.push(
      disc(`${prefix}.porthole.glass`, 'glassTinted', profile.porthole.glass, 0.14, {
        x,
        y: yc,
        z: z1 + 0.12,
      }),
    );
  }

  if (level === 1 && profile.entrance) {
    parts.push(...entranceGroup(frame, profile, prefix, entranceSpec));
  }
  return cladding(parts);
}

/** Входная группа первого этажа: портал, витраж, пилоны, витрина, цокольная лента. */
function entranceGroup(
  frame: Frame,
  profile: EnvelopeProfile,
  prefix: string,
  spec: Envelope['entrance'],
): Part[] {
  const entrance = profile.entrance;
  if (!entrance) return [];
  const z1 = frame.z1;
  const fh = frame.floorHeight;
  const at = (fraction: number): number => frame.cx + fraction * frame.width;
  const dx = at(entrance.center);
  /** Значение из данных здания или запасная доля высоты этажа. */
  const lift = (value: number | undefined, fallback: number): number => value ?? fh * fallback;
  const size = (value: number | undefined, fallback: number): number => value ?? fallback;

  const portalHeight = Math.min(size(spec?.portal?.height, entrance.height), fh);
  const glazing = spec?.glazing;
  const glazingHeight = lift(glazing?.height, ENTRANCE_FALLBACK.glazing.height);
  const glazingY = lift(glazing?.y, ENTRANCE_FALLBACK.glazing.y);
  const glazingInset = size(glazing?.inset, ENTRANCE_FALLBACK.glazing.inset);
  const transom = spec?.transom;

  const parts: Part[] = [
    box(
      `${prefix}.entrance.portal`,
      'trim',
      size(spec?.portal?.width, entrance.width),
      portalHeight,
      size(spec?.portal?.depth, ENTRANCE_FALLBACK.portal.depth),
      { x: dx, y: lift(spec?.portal?.y, ENTRANCE_FALLBACK.portal.y), z: z1 + ENTRANCE_Z.portal },
    ),
    box(
      `${prefix}.entrance.glazing`,
      'glassClear',
      size(glazing?.width, entrance.width - glazingInset),
      glazingHeight,
      size(glazing?.depth, ENTRANCE_FALLBACK.glazing.depth),
      { x: dx, y: glazingY, z: z1 + ENTRANCE_Z.glazing },
    ),
    box(
      `${prefix}.entrance.transom`,
      'trim',
      size(transom?.width, entrance.width - size(transom?.inset, ENTRANCE_FALLBACK.transom.inset)),
      lift(transom?.height, ENTRANCE_FALLBACK.transom.height),
      size(transom?.depth, ENTRANCE_FALLBACK.transom.depth),
      { x: dx, y: lift(transom?.y, ENTRANCE_FALLBACK.transom.y), z: z1 + ENTRANCE_Z.transom },
    ),
  ];

  // Импосты витража. Без данных раскладка считается сама: столько же стоек,
  // разложенных ровным шагом по ширине витража.
  const mullions = spec?.mullions;
  const mullionCount = mullions?.offsets?.length ?? ENTRANCE_FALLBACK.mullions.count;
  const mullionOffsets =
    mullions?.offsets ??
    Array.from({ length: mullionCount }, (_unused, i) =>
      mullionCount > 1
        ? (i - (mullionCount - 1) / 2) * ((entrance.width - glazingInset) / (mullionCount - 1))
        : 0,
    );
  mullionOffsets.forEach((offset, index) => {
    parts.push(
      box(
        `${prefix}.entrance.mullion.${String(index + 1).padStart(2, '0')}`,
        'trim',
        size(mullions?.width, ENTRANCE_FALLBACK.mullions.width),
        lift(mullions?.height, ENTRANCE_FALLBACK.glazing.height),
        size(mullions?.depth, ENTRANCE_FALLBACK.mullions.depth),
        {
          x: dx + offset,
          y: lift(mullions?.y, ENTRANCE_FALLBACK.glazing.y),
          z: z1 + ENTRANCE_Z.mullion,
        },
      ),
    );
  });

  // Ручки входных дверей: имя по стороне, а не по смещению — точка внутри
  // числа ломает точечную конвенцию имён (правила проекта, раздел «Конвенции»).
  const handles = spec?.handles;
  const handleOffsets = handles?.offsets ?? [...ENTRANCE_FALLBACK.handles.offsets];
  handleOffsets.forEach((offset, index) => {
    const pair = handleOffsets.length === 2;
    const side = pair ? (offset < 0 ? 'west' : 'east') : String(index + 1).padStart(2, '0');
    parts.push(
      box(
        `${prefix}.entrance.handle.${side}`,
        'plaster',
        size(handles?.width, ENTRANCE_FALLBACK.handles.width),
        size(handles?.height, ENTRANCE_FALLBACK.handles.height),
        size(handles?.depth, ENTRANCE_FALLBACK.handles.depth),
        {
          x: dx + offset,
          y: lift(handles?.y, ENTRANCE_FALLBACK.handles.y),
          z: z1 + ENTRANCE_Z.handle,
        },
      ),
    );
  });

  const pylon = spec?.pylon;
  for (const sign of [-1, 1]) {
    parts.push(
      box(
        `${prefix}.entrance.pylon.${sign < 0 ? 'west' : 'east'}`,
        'brick',
        size(pylon?.width, entrance.pylonWidth),
        lift(pylon?.height, ENTRANCE_FALLBACK.pylon.height),
        size(pylon?.depth, ENTRANCE_FALLBACK.pylon.depth),
        {
          x: dx + sign * entrance.pylonOffset,
          y: lift(pylon?.y, ENTRANCE_FALLBACK.pylon.y),
          z: z1 + ENTRANCE_Z.pylon,
        },
      ),
    );
  }

  const showcaseX = at(entrance.showcaseCenter);
  const showcase = spec?.showcase;
  parts.push(
    box(
      `${prefix}.showcase.panel`,
      'accent',
      size(showcase?.width, entrance.showcaseWidth),
      Math.min(lift(showcase?.height, ENTRANCE_FALLBACK.showcase.height), fh),
      size(showcase?.depth, ENTRANCE_FALLBACK.showcase.depth),
      {
        x: showcaseX,
        y: lift(showcase?.y, ENTRANCE_FALLBACK.showcase.y),
        z: z1 + ENTRANCE_Z.showcase,
      },
    ),
  );

  const glass = spec?.showcaseGlass;
  const glassWidth = size(glass?.width, ENTRANCE_FALLBACK.showcaseGlass.width);
  const shelf = spec?.showcaseShelf;
  const shelfCount = shelf?.count ?? ENTRANCE_FALLBACK.showcaseShelf.count;
  for (const sign of [-1, 1]) {
    // Две витрины делят панель на четыре равные части — раскладка, а не габарит.
    const gx = showcaseX + (sign * entrance.showcaseWidth) / 4;
    const label = sign < 0 ? 'west' : 'east';
    parts.push(
      box(
        `${prefix}.showcase.${label}.glass`,
        'trim',
        glassWidth,
        lift(glass?.height, ENTRANCE_FALLBACK.showcaseGlass.height),
        size(glass?.depth, ENTRANCE_FALLBACK.showcaseGlass.depth),
        {
          x: gx,
          y: lift(glass?.y, ENTRANCE_FALLBACK.showcaseGlass.y),
          z: z1 + ENTRANCE_Z.showcaseGlass,
        },
      ),
    );
    for (let i = 0; i < shelfCount; i += 1) {
      parts.push(
        box(
          `${prefix}.showcase.${label}.shelf.${String(i + 1).padStart(2, '0')}`,
          'trim',
          size(shelf?.width, glassWidth),
          size(shelf?.height, ENTRANCE_FALLBACK.showcaseShelf.height),
          size(shelf?.depth, ENTRANCE_FALLBACK.showcaseShelf.depth),
          {
            x: gx,
            y:
              (shelf?.base ?? ENTRANCE_FALLBACK.showcaseShelf.base) +
              i * (shelf?.step ?? ENTRANCE_FALLBACK.showcaseShelf.step),
            z: z1 + ENTRANCE_Z.showcaseShelf,
          },
        ),
      );
    }
  }

  const band = spec?.band;
  parts.push(
    box(
      `${prefix}.plinth.band`,
      'accent',
      size(band?.width, entrance.bandWidth),
      lift(band?.height, ENTRANCE_FALLBACK.band.height),
      size(band?.depth, ENTRANCE_FALLBACK.band.depth),
      {
        x: at(entrance.bandCenter),
        y: lift(band?.y, ENTRANCE_FALLBACK.band.y),
        z: z1 + ENTRANCE_Z.band,
      },
    ),
  );
  return parts;
}

/** Вывески первого этажа: номер и название берутся из паспорта здания. */
function signs(
  frame: Frame,
  profile: EnvelopeProfile,
  passport: BuildingPassport,
  spec: Envelope['signs'],
): SignPart[] {
  const at = (fraction: number): number => frame.cx + fraction * frame.width;
  const fh = frame.floorHeight;
  const result: SignPart[] = [];
  // Этот источник вешает вывески на лицевую грань — она же южная: он ставит их
  // за плоскостью `frame.z1`. Сторона называется явно и уходит в данные, потому
  // что разворачивать плоскость по ней должен движок, а знать про лицевую грань
  // конкретного корпуса он не вправе.
  const side: Side = 'south';
  const number = /\d+/.exec(passport.shortName)?.[0];
  if (number) {
    const plate = spec?.number;
    result.push({
      name: `facade.floor.01.wall.${side}.sign.number`,
      side,
      center: {
        x: at(plate?.x ?? profile.tower.center),
        y: plate?.y ?? fh * SIGN_FALLBACK.number.y,
        z: frame.z1 + (plate?.zOffset ?? SIGN_FALLBACK.number.zOffset),
      },
      width: plate?.width ?? SIGN_FALLBACK.number.width,
      height: plate?.height ?? SIGN_FALLBACK.number.height,
      text: number,
      color: '#ffffff',
      fill: 0.88,
    });
  }
  const title = (passport.name.split(',')[0] ?? passport.name).trim().toLowerCase();
  if (title) {
    const plate = spec?.title;
    result.push({
      name: `facade.floor.01.wall.${side}.sign.title`,
      side,
      center: {
        x: at(plate?.x ?? SIGN_FALLBACK.title.x),
        y: plate?.y ?? fh * SIGN_FALLBACK.title.y,
        z: frame.z1 + (plate?.zOffset ?? SIGN_FALLBACK.title.zOffset),
      },
      width: plate?.width ?? frame.width * SIGN_FALLBACK.title.width,
      height: plate?.height ?? SIGN_FALLBACK.title.height,
      text: title,
      color: '#e8e2d8',
      fill: 0.54,
    });
  }
  return result;
}

/** Оболочка по кольцам этажей. */
export function buildBands(
  passport: BuildingPassport,
  profile: EnvelopeProfile,
  envelope?: Envelope,
): ShellBand[] {
  const frame = frameOf(passport);
  const bands: ShellBand[] = [];
  for (let level = 1; level <= passport.floorCount; level += 1) {
    const y0 = (level - 1) * passport.floorHeight;
    const yc = y0 + passport.floorHeight / 2;
    const tag = levelTag(level);
    const facade: Face[] = (
      [
        {
          name: `facade.floor.${tag}.wall.south`,
          side: 'south',
          parts: southFacade(frame, profile, level, y0, yc, envelope?.entrance),
        },
        {
          name: `facade.floor.${tag}.wall.north`,
          side: 'north',
          parts: northFacade(frame, profile, level, yc),
        },
        {
          name: `facade.floor.${tag}.wall.east`,
          side: 'east',
          parts: eastFacade(frame, profile, level, y0, yc),
        },
        {
          name: `facade.floor.${tag}.wall.west`,
          side: 'west',
          parts: westFacade(frame, profile, level, yc),
        },
      ] as Face[]
    ).filter((face) => face.parts.length > 0);

    bands.push({
      level,
      name: `floor.${tag}`,
      elevation: y0,
      height: passport.floorHeight,
      shell: shellFaces(frame, profile, level, yc),
      facade,
      signs: level === 1 ? signs(frame, profile, passport, envelope?.signs) : [],
    });
  }
  return bands;
}

/** Кровля: плита, парапет, надстройки. */
export function buildRoof(passport: BuildingPassport, profile: EnvelopeProfile): RoofView {
  const frame = frameOf(passport);
  const h = frame.height;
  const parts: Part[] = [
    box('roof.slab', 'brick', frame.width, profile.roof.slab, frame.depth, {
      x: frame.cx,
      y: h - profile.roof.slab / 2,
      z: frame.cz,
    }),
    box(
      'roof.parapet',
      'plaster',
      frame.width + profile.roof.parapetMargin,
      profile.roof.parapetHeight,
      frame.depth + profile.roof.parapetMargin,
      { x: frame.cx, y: h + profile.roof.parapetHeight * 0.4, z: frame.cz },
    ),
  ];
  profile.roof.structures.forEach((structure, i) => {
    parts.push(
      box(
        `roof.struct.${String(i + 1).padStart(2, '0')}`,
        'plaster',
        structure.width * frame.width,
        structure.height,
        structure.depth * frame.depth,
        {
          x: frame.cx + structure.center * frame.width,
          y: h + structure.height / 2,
          z: frame.cz + structure.offset * frame.depth,
        },
      ),
    );
  });
  return { parts };
}
