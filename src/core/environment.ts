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
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
} from 'three';
import type { Scene, WebGLRenderer } from 'three';
import type { CameraFrame } from '@core/camera';
import { isMobileLike } from '@core/renderer';

const SKY = 0xbfd9e8;
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
  scene.background = new Color(SKY);
  scene.fog = new Fog(SKY, frame.radius * FOG_NEAR, frame.radius * FOG_FAR);

  const group = new Group();
  group.name = 'environment';
  scene.add(group);

  const hemi = new HemisphereLight(0xdfefff, 0x5a5348, 0.95);
  hemi.name = 'environment.light.sky';
  group.add(hemi);

  const sun = new DirectionalLight(0xfff2dd, 1.5);
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
  const groundMaterial = new MeshStandardMaterial({ color: 0x8f8f88, roughness: 1 });
  const ground = new Mesh(groundGeometry, groundMaterial);
  ground.name = 'environment.ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  const { x0, x1, z1 } = frame.footprint;
  const walkGeometry = new PlaneGeometry(x1 - x0 + WALK_MARGIN, WALK_WIDTH);
  const walkMaterial = new MeshStandardMaterial({ color: 0xb5b2aa, roughness: 1 });
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
      scene.remove(group);
      scene.fog = null;
      scene.background = null;
    },
  };
}
