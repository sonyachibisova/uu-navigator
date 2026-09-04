/**
 * Окружение сцены: небо, туман, свет, земля и тротуар вдоль лицевой стороны.
 *
 * Это не здание, поэтому окружение живёт отдельно от четырёх групп здания
 * (`shellGroup`, `facadeGroup`, `roofGroup`, `floorsGroup`) и собрано в свою
 * группу `environment` на уровне сцены. Инвариант «ни одного меша вне четырёх
 * групп» относится к геометрии здания; земля и небо к ней не принадлежат.
 *
 * Все расстояния — доли габарита здания, снятые с прототипа.
 */
import {
  CanvasTexture,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from 'three';
import type { Material, Scene, Texture, WebGLRenderer } from 'three';
import type { CameraFrame } from '@core/camera';
import { isMobileLike } from '@core/renderer';
import { LOOK } from '@core/look';
import type { BackdropKind } from '@core/look';

/**
 * Облик подложки: фон, туман, земля, тротуар и свет.
 *
 * Небо и олива были остатком «уличной» сцены и спорили с тёмным стеклом
 * интерфейса: панели тёмные, а модель стояла в голубом дне. Все три варианта
 * отвечают одному правилу — фон не участвует в разговоре, он подложка,
 * на которой читается здание и лаймовая линия пути.
 */
interface Backdrop {
  /** Сплошной цвет фона или вертикальный градиент: [верх, низ]. */
  sky: number | readonly [number, number];
  fog: number;
  ground: number;
  walk: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  sunColor: number;
  sunIntensity: number;
}

const BACKDROPS: Record<BackdropKind, Backdrop> = {
  // 1 «Графит»: ровный тёмный сине-серый. Здание на нём читается силуэтом,
  // лайм пути горит, панели интерфейса перестают быть чужими на картинке.
  graphite: {
    sky: 0x15191d,
    fog: 0x15191d,
    ground: 0x212629,
    walk: 0x2b3135,
    hemiSky: 0xa8bccb,
    hemiGround: 0x14181c,
    hemiIntensity: 0.8,
    sunColor: 0xe3ecf5,
    sunIntensity: 1.45,
  },
  // 2 «Сумерки»: вертикальный градиент от почти чёрного верха к синему низу,
  // солнце низкое и тёплое. Самый «вечерний» вариант, здание подсвечено сбоку.
  dusk: {
    sky: [0x0b0f14, 0x2d3b47],
    fog: 0x1d262e,
    ground: 0x181d22,
    walk: 0x232b32,
    hemiSky: 0x7f9cb5,
    hemiGround: 0x111418,
    hemiIntensity: 0.75,
    sunColor: 0xffd9b0,
    sunIntensity: 1.35,
  },
  // 3 «Бумага»: светлая нейтральная подложка без неба и без оливы —
  // макет на столе. Здание светлое, тёмные панели интерфейса контрастны.
  paper: {
    sky: 0xe7e6e1,
    fog: 0xe7e6e1,
    ground: 0xd3d2cc,
    walk: 0xdddcd6,
    hemiSky: 0xffffff,
    hemiGround: 0x9c9a92,
    hemiIntensity: 0.95,
    sunColor: 0xfff4e2,
    sunIntensity: 1.5,
  },
};

/**
 * Вертикальный градиент фона одной узкой текстурой. Полоса в четыре пикселя
 * шириной: рендерер растягивает фон на весь кадр, и ширина ни на что
 * не влияет, а память экономит.
 */
function makeSkyGradient(top: number, bottom: number): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createLinearGradient(0, 0, 0, 256);
    gradient.addColorStop(0, `#${top.toString(16).padStart(6, '0')}`);
    gradient.addColorStop(1, `#${bottom.toString(16).padStart(6, '0')}`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 4, 256);
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  return texture;
}

const FOG_NEAR = 5.68;
const FOG_FAR = 12.98;
const GROUND_SIZE = 12.2;
const SUN_DIR = { x: -1.62, y: 2.64, z: 1.62 };
const SHADOW_EXTENT = 1.58;
const SHADOW_NEAR = 0.4;
const SHADOW_FAR = 6.9;
/** Отступ тротуара от лицевой грани и его ширина, метры. */
const WALK_OFFSET = 7;
const WALK_WIDTH = 12;
const WALK_MARGIN = 20;

export interface EnvironmentHandle {
  group: Group;
  /**
   * Пересчитать теневую карту в ближайшем кадре. Полный теневой проход идёт
   * только по этому запросу: солнце неподвижно, геометрия неподвижна, и в
   * установившемся кадре тень просто берётся готовой (бюджет проекта —
   * теневой проход стоил до 88 draw calls из 150).
   */
  requestShadowUpdate: () => void;
  /** Снять или вернуть тени целиком — аварийное понижение качества. */
  setShadowsEnabled: (enabled: boolean) => void;
  dispose: () => void;
}

export interface SiteFrame extends CameraFrame {
  /** Габарит здания в плане: по нему кладётся тротуар. */
  footprint: { x0: number; x1: number; z0: number; z1: number };
}

export function createEnvironment(
  scene: Scene,
  frame: SiteFrame,
  renderer: WebGLRenderer,
): EnvironmentHandle {
  const backdrop = BACKDROPS[LOOK.backdrop];
  let skyTexture: Texture | undefined;
  if (typeof backdrop.sky === 'number') {
    scene.background = new Color(backdrop.sky);
  } else {
    skyTexture = makeSkyGradient(backdrop.sky[0], backdrop.sky[1]);
    scene.background = skyTexture;
  }
  scene.fog = new Fog(backdrop.fog, frame.radius * FOG_NEAR, frame.radius * FOG_FAR);

  const group = new Group();
  group.name = 'environment';
  scene.add(group);

  const hemi = new HemisphereLight(backdrop.hemiSky, backdrop.hemiGround, backdrop.hemiIntensity);
  hemi.name = 'environment.light.sky';
  group.add(hemi);

  const sun = new DirectionalLight(backdrop.sunColor, backdrop.sunIntensity);
  sun.name = 'environment.light.sun';
  sun.position.set(
    frame.center.x + frame.radius * SUN_DIR.x,
    frame.radius * SUN_DIR.y,
    frame.center.z + frame.radius * SUN_DIR.z,
  );
  sun.castShadow = true;
  // Единственный источник теней в сцене. На мобильном карта вдвое меньше — бюджет проекта.
  const shadowSize = isMobileLike() ? 1024 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  const extent = frame.radius * SHADOW_EXTENT;
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.camera.near = frame.radius * SHADOW_NEAR;
  sun.shadow.camera.far = frame.radius * SHADOW_FAR;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.camera.updateProjectionMatrix();
  group.add(sun);
  group.add(sun.target);

  const groundGeometry = new PlaneGeometry(frame.radius * GROUND_SIZE, frame.radius * GROUND_SIZE);
  const groundMaterial = new MeshStandardMaterial({ color: backdrop.ground, roughness: 1 });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.name = 'environment.ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const { x0, x1, z1 } = frame.footprint;
  const walkGeometry = new PlaneGeometry(x1 - x0 + WALK_MARGIN, WALK_WIDTH);
  const walkMaterial = new MeshStandardMaterial({ color: backdrop.walk, roughness: 1 });
  const walk = new Mesh(walkGeometry, walkMaterial);
  walk.name = 'environment.walk';
  walk.rotation.x = -Math.PI / 2;
  walk.position.set((x0 + x1) / 2, 0.06, z1 + WALK_OFFSET);
  walk.receiveShadow = true;
  group.add(walk);

  function requestShadowUpdate(): void {
    if (!sun.castShadow) return;
    // Оба флага: общий проход выключен по autoUpdate, а внутри него свет
    // пропускается по собственному признаку — нужно снять оба замка.
    renderer.shadowMap.needsUpdate = true;
    sun.shadow.needsUpdate = true;
  }

  // Первый кадр рисуется вместе с тенью.
  requestShadowUpdate();

  return {
    group,
    requestShadowUpdate,
    setShadowsEnabled(enabled: boolean): void {
      if (sun.castShadow === enabled) return;
      sun.castShadow = enabled;
      // Программы материалов собраны с учётом теней. Без пересборки снятая
      // тень не исчезает, а вмерзает: материалы продолжают читать последнюю
      // теневую карту, и на здании остаётся тень того ракурса, на котором
      // включился аварийный режим. Пересобираются только те материалы,
      // которые тень и читают: аварийный режим включается на устройстве,
      // которое уже не держит кадр, и пересборка сотни программ там сама
      // выглядит как поломка.
      scene.traverse((object) => {
        const mesh = object as { material?: Material | Material[]; receiveShadow?: boolean };
        if (!mesh.material || mesh.receiveShadow !== true) return;
        const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of list) material.needsUpdate = true;
      });
      // Карта 1024² держит около четырёх мегабайт видеопамяти и без света
      // никому не нужна.
      if (!enabled) sun.shadow.dispose();
      if (enabled) requestShadowUpdate();
    },
    dispose(): void {
      // Теневая карта 2048×2048 живёт в самом свете и без этого переживёт сцену.
      sun.dispose();
      hemi.dispose();
      sun.target.removeFromParent();
      sun.removeFromParent();
      groundGeometry.dispose();
      groundMaterial.dispose();
      walkGeometry.dispose();
      walkMaterial.dispose();
      skyTexture?.dispose();
      scene.remove(group);
      scene.fog = null;
      scene.background = null;
    },
  };
}
