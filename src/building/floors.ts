/**
 * Этажи и интерьеры: четвёртая группа верхнего уровня (`floorsGroup`),
 * внутри — по группе на этаж.
 *
 * У этажа три состояния (инвариант 7 правил проекта): активный — полная
 * непрозрачность, приглушённый — низкая, скрытый — только в явном режиме
 * «изолировать этаж» и выше плоскости среза. Ни одно из них не делается
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
import { LabelFactory } from '@building/labels';
import type { Palette } from '@building/materials';
import type { FloorView, LabelSpec, RoomView } from '@building/source';
import type { FadeRegistry } from '@core/fade';

/** Насколько высветляется плита под курсором и у выбранного помещения. */
const HOVER_LIFT = 0.28;
const SELECT_LIFT = 0.45;
/** Непрозрачность приглушённого этажа. */
const DIMMED = 0.25;
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

export interface FloorsHandle {
  floorsGroup: Group;
  floors: FloorInteriors[];
  byLevel: (level: number) => FloorInteriors | undefined;
  roomById: (id: string) => RoomView | undefined;
  /**
   * Расставить состояния этажей. `active` — выбранный этаж (`null` — здание
   * целиком), `isolate` — явный режим «показать только выбранный».
   * `immediate` применяет состояние без анимации: стартовый кадр не должен
   * начинаться с полусекундного растворения.
   */
  setStates: (active: number | null, isolate: boolean, immediate?: boolean) => void;
  /** Подсветить помещения: под курсором и выбранное. */
  highlight: (hoveredId: string | null, selectedId: string | null) => void;
  dispose: () => void;
}

interface PlateLayer {
  mesh: InstancedMesh;
  base: Color[];
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

  floor.rooms.forEach((room, index) => {
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
  return { mesh, base };
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
  const labels = new LabelFactory();
  const roomIndex = new Map<string, RoomView>();
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
        if (room.label) labelSpecs.push(room.label);
      }
      for (const link of view.vertical) {
        if (link.label) labelSpecs.push(link.label);
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
   * Создать подписи этажа. Делается при первом показе этажа: до первого кадра
   * не растеризуется ни одна текстура подписи, которую человек ещё не увидел.
   */
  function ensureLabels(layer: FloorLayer): void {
    if (layer.labelsBuilt) return;
    layer.labelsBuilt = true;
    for (const spec of layer.labelSpecs) {
      const sprite = labels.create(spec, layer.group);
      if (sprite) fade.add(sprite, layer.labelChannel, 0);
    }
  }

  function setStates(active: number | null, isolate: boolean, immediate = false): void {
    for (const layer of layers) {
      if (!layer.layoutKnown) continue;
      let target: number;
      if (active === null) {
        // Здание целиком: оболочка непрозрачна, интерьер за ней всё равно не виден.
        target = 0;
      } else if (layer.level === active) {
        target = 1;
      } else if (isolate || layer.level > active) {
        // Выше плоскости среза этажа нет так же, как нет кольца оболочки над ним.
        target = 0;
      } else {
        target = DIMMED;
      }

      if (target > 0) ensureLabels(layer);
      // Подписи читаются только на выбранном этаже: на приглушённом они
      // превращаются в шум и стоят по draw call каждая.
      const labelTarget = layer.level === active ? 1 : 0;

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
  let lastHovered: string | null = null;
  let lastSelected: string | null = null;

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
    const selectedLayer = paint(selectedId, SELECT_LIFT);
    if (selectedLayer) touched.add(selectedLayer);
    if (hoveredId && hoveredId !== selectedId) {
      const hoveredLayer = paint(hoveredId, HOVER_LIFT);
      if (hoveredLayer) touched.add(hoveredLayer);
    }
    lastHovered = hoveredId;
    lastSelected = selectedId;
    for (const layer of touched) {
      if (layer.mesh.instanceColor) layer.mesh.instanceColor.needsUpdate = true;
    }
  }

  return {
    floorsGroup,
    floors,
    byLevel: (level) => floors.find((floor) => floor.level === level),
    roomById: (id) => roomIndex.get(id),
    setStates,
    highlight,
    dispose(): void {
      labels.dispose();
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
      floors.length = 0;
      floorsGroup.removeFromParent();
      floorsGroup.clear();
    },
  };
}
