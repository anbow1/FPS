import { InstancedMesh, type Material, type Object3D } from 'three/webgpu';

// Shader warm-up behind the loading screen (rules §9: no hitch the first time
// something is seen). renderer.compileAsync() cannot do this on its own: it
// skips hidden objects and anything outside the camera's view, and it
// compiles for the plain framebuffer, not for the post-processing scene pass
// (half-float colour plus a velocity target) the game actually draws into.
// So every pipeline the player could meet later — a weapon still holstered,
// the first muzzle flash, the first enemy, rain, a scenery object behind the
// spawn point, a distant level of detail — used to compile mid-game, which on
// a phone is a visible stutter. Here the real pipeline renders one frame in
// which one object per distinct pipeline (material × vertex layout × object
// kind) is forced visible, un-culled and with at least one instance; then
// everything is put back. One per pipeline, not every hidden object, keeps
// that frame cheap in a scene with hundreds of hidden level-of-detail chunks.

function pipelineKey(o: Object3D & { material?: Material | Material[]; geometry?: { attributes: Record<string, unknown> } }): string | null {
  if (!o.material || !o.geometry) return null;
  const mats = Array.isArray(o.material) ? o.material : [o.material];
  const attrs = Object.keys(o.geometry.attributes).sort().join(',');
  const instanced = o instanceof InstancedMesh ? `i${o.instanceColor ? 'c' : ''}` : '';
  return `${o.type}|${mats.map((m) => m.uuid).join('+')}|${attrs}|${instanced}`;
}

export function warmAllPipelines(scene: Object3D, render: () => void): void {
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
    const key = pipelineKey(o);
    if (key === null || seen.has(key)) return;
    seen.add(key);
    reveal(o);
  });
  try {
    render();
  } finally {
    // Undo in reverse, so an ancestor revealed for two objects ends hidden again.
    for (let i = restore.length - 1; i >= 0; i--) (restore[i] as () => void)();
  }
}
