import { velocity } from 'three/tsl';
import { type Camera, FloatType, InstancedMesh, type Material, Matrix4, type Object3D, type PassNode, type Scene, type WebGPURenderer } from 'three/webgpu';

// Shader warm-up behind the loading screen (rules §9: no hitch the first time
// something is seen). renderer.compileAsync() cannot do this on its own: it
// skips hidden objects and anything outside the camera's view, and it
// compiles for the plain framebuffer, not for the post-processing scene pass
// (half-float colour plus a velocity target) the game actually draws into.
// So every pipeline the player could meet later — a weapon still holstered,
// the first muzzle flash, the first enemy, rain, a scenery object behind the
// spawn point, a distant level of detail — used to compile mid-game, which on
// a phone is a visible stutter. Here the real pipeline renders one frame in
// which one object per distinct shader build (see pipelineKey) is forced
// visible, un-culled and with at least one instance; then everything is put
// back. One per build, not every hidden object, keeps that frame cheap.

/**
 * Mirrors what three r186 builds a shader per (RenderObject.getMaterialCacheKey
 * plus the pass): the material, the vertex layout, the shadow flags, and —
 * for instanced meshes — the mesh itself, since each InstancedMesh gets its
 * own build.
 */
function pipelineKey(o: Object3D & { material?: Material | Material[]; geometry?: { attributes: Record<string, { itemSize?: number; normalized?: boolean }> } }): string | null {
  if (!o.material || !o.geometry) return null;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const attrs = Object.entries(o.geometry.attributes)
    .map(([name, a]) => `${name}${a.itemSize ?? ''}${a.normalized ? 'n' : ''}`)
    .sort()
    .join(',');
  const own = o instanceof InstancedMesh || ((o as { count?: number }).count ?? 1) > 1 ? o.uuid : '';
  return `${o.type}|${mats.map((m) => m.uuid).join('+')}|${attrs}|${o.receiveShadow}|${o.castShadow}|${own}`;
}

/**
 * Forces one object per shader build visible, un-culled and with at least one
 * instance; returns the function that puts everything back.
 */
export function revealOnePerPipeline(scene: Object3D, shown: Object3D[] = []): () => void {
  const restore: (() => void)[] = [];
  const seen = new Set<string>();
  const reveal = (o: Object3D): void => {
    for (let a: Object3D | null = o; a; a = a.parent) {
      if (a.visible) continue;
      const hidden = a;
      hidden.visible = true;
      restore.push(() => {
        hidden.visible = false;
      });
    }
    if (o.frustumCulled) {
      o.frustumCulled = false;
      restore.push(() => {
        o.frustumCulled = true;
      });
    }
    if (o instanceof InstancedMesh && o.count === 0) {
      o.count = 1;
      restore.push(() => {
        o.count = 0;
      });
    }
  };
  scene.traverse((o) => {
    // Objects hidden for good (a body the loaded models replaced) are never drawn: nothing to warm.
    if (o.userData['noWarmup'] === true) return;
    const key = pipelineKey(o);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    reveal(o);
    shown.push(o);
  });
  // Undo in reverse, so an ancestor revealed for two objects ends hidden again.
  return () => {
    for (let i = restore.length - 1; i >= 0; i--) (restore[i] as () => void)();
  };
}

export function warmAllPipelines(scene: Object3D, render: () => void): void {
  const restore = revealOnePerPipeline(scene);
  try {
    render();
  } finally {
    restore();
  }
}

const unjittered = new Matrix4();

/**
 * Builds `objects`' shaders for the pass the game draws them in, asynchronously (the loading screen's
 * pre-compile). renderer.compileAsync builds for whatever target is set, and with none set that is the plain
 * framebuffer: other outputs (no velocity), tone mapping in the material, another format, so none of those
 * builds was the one the game used, and the first frame built every material again, synchronously, the main
 * thread blocked. Three more things had to match (three r186):
 * - the target and MRT stay set until every build has settled: compileAsync gathers its objects at the call
 *   but generates their shaders later, and shaders generated after the MRT was put back had one output for
 *   a pipeline with two targets (a validation error, and nothing the game could use);
 * - TRAA hands the velocity node its unjittered projection while it renders (a per-object uniform in the
 *   shader) and takes it back after; built without it the shaders read the camera's (a shared uniform);
 * - one compileAsync per object, all started at once: over the whole scene it builds its objects one after
 *   another, waiting on each pipeline and yielding between them, and one pipeline that never became ready
 *   held up the rest (one pipeline in twenty seconds, every time). Started together the browser builds them
 *   in parallel off the main thread, and a stuck one only times out alone.
 * Nothing else may render meanwhile. The shadow and post passes are not covered: the warm-up frame builds those.
 */
export async function compileForPass(renderer: WebGPURenderer, scene: Scene, camera: Camera, scenePass: PassNode | null, objects: readonly Object3D[], timeoutMs: number): Promise<void> {
  const prevTarget = renderer.getRenderTarget();
  const prevMrt = renderer.getMRT();
  if (scenePass) {
    const target = scenePass.renderTarget;
    // What PassNode.setup sets on the pipeline's first frame; until then the target holds its defaults, and
    // the samples and the formats are part of every build.
    target.samples = scenePass.options.samples ?? renderer.samples;
    target.texture.type = renderer.getOutputBufferType();
    if (renderer.reversedDepthBuffer && target.depthTexture) target.depthTexture.type = FloatType;
    renderer.setRenderTarget(target);
    renderer.setMRT(scenePass.getMRT());
    velocity.setProjectionMatrix(unjittered.copy(camera.projectionMatrix));
  }
  try {
    await Promise.allSettled(
      objects.map((o) => {
        let timer = 0;
        const timeout = new Promise<void>((resolve) => {
          timer = window.setTimeout(resolve, timeoutMs);
        });
        return Promise.race([renderer.compileAsync(o, camera, scene), timeout]).finally(() => window.clearTimeout(timer));
      }),
    );
  } finally {
    if (scenePass) {
      velocity.setProjectionMatrix(null);
      renderer.setRenderTarget(prevTarget);
      renderer.setMRT(prevMrt);
    }
  }
}
