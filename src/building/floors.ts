/**
 * Этажи и интерьеры: четвёртая группа верхнего уровня (`floorsGroup`),
 * внутри — по группе на этаж.
 *
 * У этажа три состояния (инвариант 7 правил проекта): активный — полная
 * непрозрачность, приглушённый — низкая, скрытый — срез по потолку выбранного
 * этажа и явный режим «изолировать этаж». Приглушение — для этажей ниже
 * выбранного: они не мешают взгляду сверху, а без них здание перестаёт
 * читаться как здание. Этажи выше выбранного снимаются вместе с кольцами
 * оболочки над срезом: полупрозрачный верхний этаж ложится плёнкой на план,
 * ради которого этаж и выбрали. Ни одно из состояний не делается
 * через `group.visible`: состояние ведёт `FadeRegistry`, поэтому оно
 * анимируется по времени кадра и не даёт скачков.
 *
 * Материалы всех фейдящихся мешей — клоны (инвариант 3): реестр клонирует их
 * при регистрации, общая палитра не мутируется ни на одном этаже.
 *
 * Кликабельные плиты помещений собраны в один `InstancedMesh` на этаж: цвет
 * назначения приходит per-instance, подсветка — тоже, поэтому тридцать
 * помещений стоят один draw call, а не тридцать (известная ловушка: один меш на помещение давал их тридцать).
 */
import { Color, Group, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { PartBatcher, disposeBatched } from '@building/batch';
import { unitBox } from '@building/geometry';
import { buildLabelLayer } from '@building/labels';
import type { LabelLayer } from '@building/labels';
import type { Palette } from '@building/materials';
import type { FloorView, LabelSpec, RoomView, Vec3 } from '@building/source';
import type { FadeRegistry } from '@core/fade';

/** Насколько высветляется плита под курсором и у выбранного помещения. */
const HOVER_LIFT = 0.28;
const SELECT_LIFT = 0.45;
/**
 * На сколько метров выбранная плита поднимается над планом.
 *
 * Одного осветления мало: человек, пришедший из поиска, не разглядывал план
 * до этого и не знает, какой оттенок был у помещения секунду назад. Подъём
 * читается сразу и в движении — плита выходит из плоскости, как клавиша.
 * Величина взята заметно больше толщины плиты (0.06 м) и заметно меньше
 * высоты перегородок (3.6 м), чтобы помещение не выглядело оторванным от
 * этажа. Меньше метра с высоты птичьего полёта не читается вовсе: подъём
 * в треть метра на дистанции в сотню метров — это два пикселя.
 */
export const SELECT_RAISE = 1.2;
/** Непрозрачность приглушённого этажа. */
const DIMMED = 0.25;
/**
 * Доля раскрытия, с которой имеет смысл готовить подписи этажа. Ноль был
 * плохим порогом: подписи всех этажей строились в тот самый кадр, когда
 * раскрытие только тронулось с места, — сотня холстов и два атласа
 * посреди подлёта камеры.
 */
const LABELS_FROM = 0.35;
/** Белый для подсветки: константа модуля, а не аллокация на каждое помещение. */
const WHITE = new Color(0xffffff);

export interface FloorInteriors {
  level: number;
  layoutKnown: boolean;
  group: Group;
  /** Кликабельный слой этажа: плиты помещений. */
  plates: InstancedMesh | undefined;
  /** Помещения в порядке `instanceId`. */
  rooms: RoomView[];
}

/**
 * Лестница или лифт так, как их видит поиск: где искать и куда смотреть.
 * Помещением такая связь не является — карточки у неё нет, — но человеку,
 * который ищет «лестницу», это ровно то же действие, что и поиск аудитории.
 */
export interface VerticalPlace {
  id: string;
  name: string;
  /** Этаж, к которому ведём камеру: нижний из известных. */
  level: number;
  /** Все этажи, на которых связь есть: лестница живёт сразу на нескольких. */
  levels: number[];
  focus: Vec3;
}

export interface FloorsHandle {
  floorsGroup: Group;
  floors: FloorInteriors[];
  byLevel: (level: number) => FloorInteriors | undefined;
  roomById: (id: string) => RoomView | undefined;
  /** Лестницы и лифты по идентификатору: их ищут наравне с помещениями. */
  verticalById: (id: string) => VerticalPlace | undefined;
  /** Все лестницы и лифты здания: список для поиска строится один раз. */
  verticalPlaces: () => VerticalPlace[];
  /**
   * Расставить состояния этажей. `active` — выбранный этаж (`null` — здание
   * целиком), `isolate` — явный режим «показать только выбранный».
   * `immediate` применяет состояние без анимации: стартовый кадр не должен
   * начинаться с полусекундного растворения. `openness` — степень раскрытия
   * кукольного дома: в режиме «здание целиком» интерьеры проявляются вместе
   * с растворением оболочки и других хозяев у их прозрачности нет.
   */
  setStates: (
    active: number | null,
    isolate: boolean,
    immediate?: boolean,
    openness?: number,
  ) => void;
  /** Подсветить помещения: под курсором и выбранное. */
  highlight: (hoveredId: string | null, selectedId: string | null) => void;
  dispose: () => void;
}

interface PlateLayer {
  mesh: InstancedMesh;
  base: Color[];
  /** Плиты в порядке `instanceId`: по ним пересчитывается матрица при подъёме. */
  plates: RoomView['plate'][];
}

interface FloorLayer {
  level: number;
  layoutKnown: boolean;
  group: Group;
  /** Канал растворения этажа и отдельный канал его подписей. */
  channel: string;
  labelChannel: string;
  plates: PlateLayer | undefined;
  /** Подписи создаются лениво — только когда этаж впервые становится активным. */
  labelSpecs: LabelSpec[];
  labelsBuilt: boolean;
}

/** Канал растворения этажа: один на этаж. */
function channelOf(level: number): string {
  return `floor.${String(level).padStart(2, '0')}`;
}

function buildPlates(floor: FloorView, palette: Palette, target: Group): PlateLayer | undefined {
  if (floor.rooms.length === 0) return undefined;
  const mesh = new InstancedMesh(unitBox(), palette.plate, floor.rooms.length);
  mesh.name = `${channelOf(floor.level)}.rooms.plates`;
  mesh.receiveShadow = true;
  mesh.castShadow = false;

  const matrix = new Matrix4();
  const position = new Vector3();
  const scale = new Vector3();
  const rotation = new Quaternion();
  const base: Color[] = [];
  const plates: RoomView['plate'][] = [];

  floor.rooms.forEach((room, index) => {
    plates.push(room.plate);
    position.set(room.plate.center.x, room.plate.center.y, room.plate.center.z);
    scale.set(room.plate.width, 0.06, room.plate.depth);
    matrix.compose(position, rotation, scale);
    mesh.setMatrixAt(index, matrix);
    const color = palette.purposeColor(room.type).clone();
    base.push(color);
    mesh.setColorAt(index, color);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingBox();
  mesh.computeBoundingSphere();
  target.add(mesh);
  return { mesh, base, plates };
}

export function createFloors(
  views: readonly FloorView[],
  palette: Palette,
  fade: FadeRegistry,
): FloorsHandle {
  const floorsGroup = new Group();
  floorsGroup.name = 'floorsGroup';

  const layers: FloorLayer[] = [];
  const floors: FloorInteriors[] = [];
  const batched: InstancedMesh[] = [];
  const labelLayers: LabelLayer[] = [];
  const roomIndex = new Map<string, RoomView>();
  const verticalIndex = new Map<string, VerticalPlace>();
  const slots = new Map<string, { layer: PlateLayer; index: number }>();

  for (const view of views) {
    const channel = channelOf(view.level);
    const group = new Group();
    group.name = channel;
    floorsGroup.add(group);

    let plates: PlateLayer | undefined;
    const labelSpecs: LabelSpec[] = [];

    if (view.layoutKnown) {
      const batcher = new PartBatcher();
      batcher.addAll(`${channel}.structure`, view.parts);
      for (const corridor of view.corridors) batcher.add(`${channel}.corridors`, corridor.part);
      for (const room of view.rooms) batcher.addAll(`${channel}.partitions`, room.parts);
      for (const link of view.vertical) batcher.addAll(`${channel}.vertical`, link.parts);
      const meshes = batcher.build(group, palette.surface);
      batched.push(...meshes);
      // Этаж начинает жизнь скрытым: стартовое состояние сцены расставит его сам.
      for (const mesh of meshes) fade.add(mesh, channel, 0);

      plates = buildPlates(view, palette, group);
      if (plates) {
        fade.add(plates.mesh, channel, 0);
        view.rooms.forEach((room, index) => {
          if (plates) slots.set(room.id, { layer: plates, index });
        });
      }

      for (const room of view.rooms) {
        roomIndex.set(room.id, room);
        // Подписи достаётся цвет плиты, на которой она лежит: вариант без
        // плашки считает от него цвет цифры. Палитру знает сцена, а не
        // источник данных, поэтому поле заполняется здесь.
        if (room.label) {
          labelSpecs.push({
            ...room.label,
            underColor: `#${palette.purposeColor(room.type).getHexString()}`,
          });
        }
      }
      for (const link of view.vertical) {
        if (link.label) {
          labelSpecs.push({
            ...link.label,
            underColor: palette.surfaceHex(link.kind === 'lift' ? 'lift' : 'stair'),
          });
        }
        // Точка, к которой ведём камеру: подпись связи, а если её нет —
        // середина габарита на высоте роста над полом этажа.
        const focus = link.label?.position ?? {
          x: (link.bounds.x0 + link.bounds.x1) / 2,
          y: view.elevation + 1.6,
          z: (link.bounds.z0 + link.bounds.z1) / 2,
        };
        // Одна и та же лестница объявлена на каждом своём этаже. В поиске она
        // одна: запоминаем нижний известный этаж и туда же ведём камеру,
        // а остальные этажи копим, чтобы показать человеку размах связи.
        const seen = verticalIndex.get(link.id);
        if (seen) {
          if (!seen.levels.includes(view.level)) seen.levels.push(view.level);
        } else {
          verticalIndex.set(link.id, {
            id: link.id,
            name: link.name,
            level: view.level,
            levels: [view.level],
            focus,
          });
        }
      }
    }

    layers.push({
      level: view.level,
      layoutKnown: view.layoutKnown,
      group,
      channel,
      labelChannel: `${channel}.labels`,
      plates,
      labelSpecs,
      labelsBuilt: false,
    });
    floors.push({
      level: view.level,
      layoutKnown: view.layoutKnown,
      group,
      plates: plates?.mesh,
      rooms: view.rooms,
    });
  }

  /**
   * Создать подписи этажа. Делается при первом показе: до первого кадра не
   * растеризуется ни один атлас, который человек ещё не увидел. Весь этаж —
   * один меш и один draw call, поэтому подписи можно держать включёнными
   * не только на выбранном этаже.
   */
  function ensureLabels(layer: FloorLayer): void {
    if (layer.labelsBuilt) return;
    layer.labelsBuilt = true;
    const built = buildLabelLayer(layer.labelSpecs, layer.labelChannel, layer.group);
    if (!built) return;
    labelLayers.push(built);
    fade.add(built.mesh, layer.labelChannel, 0);
  }

  function setStates(
    active: number | null,
    isolate: boolean,
    immediate = false,
    openness = 0,
  ): void {
    // За один вызов готовится не больше одного этажа: растеризация атласа
    // стоит десятки миллисекунд, и два подряд — это заметный подвис.
    let builtNow = false;
    for (const layer of layers) {
      if (!layer.layoutKnown) continue;
      let target: number;
      if (active === null) {
        // Здание целиком: пока оболочка цела, интерьер за ней всё равно не виден,
        // а по мере раскрытия кукольного дома он проявляется вместе с ней.
        target = openness;
      } else if (layer.level === active) {
        target = 1;
      } else if (isolate || layer.level > active) {
        // Выше среза не остаётся ничего: кольца оболочки над выбранным этажом
        // уже сняты, и интерьер верхнего этажа обязан уйти вместе с ними.
        // Приглушённый, но не снятый верхний этаж ложится полупрозрачной
        // плёнкой ровно на тот план, ради которого этаж и выбрали: смотреть
        // на четвёртый этаж приходится сквозь пятый. Полное скрытие здесь —
        // это срез, а не режим «изолировать этаж» (инвариант 7 правил проекта):
        // здание по-прежнему читается снизу, нижние этажи остаются.
        target = 0;
      } else if (layer.level === active - 1) {
        // Приглушается ровно один этаж под выбранным: он даёт зданию глубину
        // и не мешает взгляду сверху. Все приглушённые этажи разом — это
        // столько же прозрачных планов друг под другом, сколько этажей
        // в здании, и каждый рисуется поверх уже нарисованного.
        target = DIMMED;
      } else {
        target = 0;
      }

      // Подписи этажа стоят один draw call на этаж, поэтому включаются везде,
      // где человек видит план: на выбранном этаже — целиком, в режиме
      // «здание целиком» — вместе с раскрытием, как и сами интерьеры.
      // На приглушённом этаже подписей нет: там они читались бы как шум.
      const labelTarget = active === null ? openness : layer.level === active ? 1 : 0;
      if (labelTarget >= LABELS_FROM && !layer.labelsBuilt && !builtNow) {
        ensureLabels(layer);
        builtNow = true;
      }

      if (immediate) {
        fade.setChannelImmediate(layer.channel, target);
        if (fade.hasChannel(layer.labelChannel)) {
          fade.setChannelImmediate(layer.labelChannel, labelTarget);
        }
      } else {
        fade.setChannelTarget(layer.channel, target);
        fade.setChannelTarget(layer.labelChannel, labelTarget);
      }
    }
  }

  const tint = new Color();
  const raiseMatrix = new Matrix4();
  const raisePosition = new Vector3();
  const raiseScale = new Vector3();
  const raiseRotation = new Quaternion();
  let lastHovered: string | null = null;
  let lastSelected: string | null = null;

  /** Поднять или вернуть плиту на место. Возвращает слой, чтобы пометить его. */
  function raise(id: string | null, height: number): PlateLayer | undefined {
    if (!id) return undefined;
    const slot = slots.get(id);
    if (!slot) return undefined;
    const plate = slot.layer.plates[slot.index];
    if (!plate) return undefined;
    raisePosition.set(plate.center.x, plate.center.y + height, plate.center.z);
    raiseScale.set(plate.width, 0.06, plate.depth);
    raiseMatrix.compose(raisePosition, raiseRotation, raiseScale);
    slot.layer.mesh.setMatrixAt(slot.index, raiseMatrix);
    return slot.layer;
  }

  /** Перекрасить одну плиту. Возвращает слой, чтобы пометить его изменившимся. */
  function paint(id: string | null, lift: number): PlateLayer | undefined {
    if (!id) return undefined;
    const slot = slots.get(id);
    if (!slot) return undefined;
    const base = slot.layer.base[slot.index];
    if (!base) return undefined;
    tint.copy(base);
    if (lift > 0) tint.lerp(WHITE, lift);
    slot.layer.mesh.setColorAt(slot.index, tint);
    return slot.layer;
  }

  function highlight(hoveredId: string | null, selectedId: string | null): void {
    if (hoveredId === lastHovered && selectedId === lastSelected) return;
    const touched = new Set<PlateLayer>();
    // Трогаем только те помещения, чья подсветка изменилась: перекраска всех
    // помещений всех этажей помечала весь instanceColor изменившимся.
    for (const id of [lastHovered, lastSelected]) {
      if (id && id !== hoveredId && id !== selectedId) {
        const layer = paint(id, 0);
        if (layer) touched.add(layer);
      }
    }
    if (lastSelected && lastSelected !== selectedId) {
      const dropped = raise(lastSelected, 0);
      if (dropped) touched.add(dropped);
    }
    const selectedLayer = paint(selectedId, SELECT_LIFT);
    if (selectedLayer) touched.add(selectedLayer);
    const raisedLayer = raise(selectedId, SELECT_RAISE);
    if (raisedLayer) touched.add(raisedLayer);
    if (hoveredId && hoveredId !== selectedId) {
      const hoveredLayer = paint(hoveredId, HOVER_LIFT);
      if (hoveredLayer) touched.add(hoveredLayer);
    }
    lastHovered = hoveredId;
    lastSelected = selectedId;
    for (const layer of touched) {
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
      layer.mesh.instanceMatrix.needsUpdate = true;
    }
  }

  return {
    floorsGroup,
    floors,
    byLevel: (level) => floors.find((floor) => floor.level === level),
    roomById: (id) => roomIndex.get(id),
    verticalById: (id) => verticalIndex.get(id),
    verticalPlaces: () => [...verticalIndex.values()],
    setStates,
    highlight,
    dispose(): void {
      for (const layer of labelLayers) layer.dispose();
      labelLayers.length = 0;
      disposeBatched(batched);
      batched.length = 0;
      for (const layer of layers) {
        if (!layer.plates) continue;
        layer.plates.mesh.removeFromParent();
        layer.plates.mesh.dispose();
      }
      layers.length = 0;
      slots.clear();
      roomIndex.clear();
      verticalIndex.clear();
      floors.length = 0;
      floorsGroup.removeFromParent();
      floorsGroup.clear();
    },
  };
}
