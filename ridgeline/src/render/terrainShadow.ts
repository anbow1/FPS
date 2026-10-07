import { float, Fn, int, ivec2, Loop, max, min, smoothstep, textureLoad, uniform, uv, vec2, vec4 } from 'three/tsl';
import { LinearFilter, MeshBasicNodeMaterial, type Node, QuadMesh, RenderTarget, UnsignedByteType, Vector3, type WebGPURenderer } from 'three/webgpu';
import { TERRAIN } from '../sim/terrain.ts';
import type { TerrainTextures } from './terrainTextures.ts';

// The mountains' own light: where a ridge shades the slope behind it from the
// sun, and how much sky a valley floor sees. Without them the relief is lit
// like a plastic model — every slope facing the sun bright, every gully as open
// to the sky as a summit. Both come from horizon angles over the near height
// grid, computed once on the GPU (one full-screen pass, ~1 M texels × ~150
// height reads — milliseconds on a GPU, minutes on a CPU) and again when the
// sun moves:
//
//   r  sun visibility: march towards the sun with growing steps (to ~20 km here);
//      the sun is up for this texel if it stands above the steepest terrain
//      angle along the way, with a soft edge for its disc and the scattering;
//   g  sky visibility: the horizon angle in eight directions, each direction
//      seeing the sky above it — 1 − sin(horizon), the cosine-weighted share.
//
// The terrain shader multiplies the sun's shadow by r (with the cloud shadow)
// and feeds g to its ambient occlusion. Outside the near grid both are 1.

const RES = 1024;
const SUN_STEPS = 56;
const SKY_DIRS = 8;
const SKY_STEPS = 14;

export interface ShadowReach {
  /** How far the march looks for a ridge between a texel and the sun, and for its sky horizon (m). */
  sunM: number;
  skyM: number;
}

export class TerrainShadow {
  readonly target: RenderTarget;
  private readonly sun = uniform(new Vector3(0, 1, 0));
  private readonly quad: QuadMesh;

  constructor(tex: TerrainTextures, reach: ShadowReach = { sunM: 20_000, skyM: 3000 }) {
    this.target = new RenderTarget(RES, RES, { type: UnsignedByteType, depthBuffer: false });
    this.target.texture.minFilter = LinearFilter;
    this.target.texture.magFilter = LinearFilter;
    this.target.texture.generateMipmaps = false;
    const m = new MeshBasicNodeMaterial({ name: 'terrain shadow bake' });
    const res = TERRAIN.nearRes;
    const size = TERRAIN.nearSizeM;
    const cell = size / res;
    const sun = this.sun;
    m.colorNode = Fn(() => {
      // This texel's world position; heights read with textureLoad (exact, no filtering).
      const p = uv().mul(size).sub(size / 2);
      const heightAt = (xz: Node<'vec2'>): Node<'float'> => {
        const g = xz.add(size / 2).div(cell).sub(0.5);
        const i = ivec2(int(g.x.clamp(0, res - 1)), int(g.y.clamp(0, res - 1)));
        return textureLoad(tex.nearHeight, i).x;
      };
      const h0 = max(heightAt(p), TERRAIN.seaLevelM).add(2);
      // Sun: the steepest rise towards it along the march (as a tangent).
      const dir = vec2(sun.x, sun.z).normalize();
      const tanSun = sun.y.div(max(vec2(sun.x, sun.z).length(), 1e-3));
      const steepest = float(-1e3).toVar();
      // Steps grow geometrically from one cell out to the reach.
      const sunGrowth = Math.pow(reach.sunM / cell, 1 / SUN_STEPS);
      const skyGrowth = Math.pow(reach.skyM / cell, 1 / SKY_STEPS);
      const dist = float(cell).toVar();
      Loop(SUN_STEPS, () => {
        const q = p.add(dir.mul(dist));
        const rise = max(heightAt(q), TERRAIN.seaLevelM).sub(h0).div(dist);
        steepest.assign(max(steepest, rise));
        dist.mulAssign(sunGrowth);
      });
      // Soft edge: the sun's disc plus the haze's forward scattering (and the 100 m texels).
      const sunVis = smoothstep(-0.06, 0.06, tanSun.sub(steepest));
      // Sky: horizon angle in eight directions.
      const sky = float(0).toVar();
      for (let k = 0; k < SKY_DIRS; k++) {
        const a = (k / SKY_DIRS) * Math.PI * 2 + 0.2;
        const d = vec2(Math.cos(a), Math.sin(a));
        const steep = float(0).toVar();
        const s = float(cell).toVar();
        Loop(SKY_STEPS, () => {
          const rise = max(heightAt(p.add(d.mul(s))), TERRAIN.seaLevelM).sub(h0).div(s);
          steep.assign(max(steep, rise));
          s.mulAssign(skyGrowth);
        });
        // sin(atan(t)) = t / √(1 + t²).
        sky.addAssign(float(1).sub(steep.div(steep.mul(steep).add(1).sqrt())));
      }
      return vec4(sunVis, min(sky.div(SKY_DIRS), 1), 0, 1);
    })();
    this.quad = new QuadMesh(m);
  }

  /** Recomputes for a sun direction (world, normalised). */
  bake(renderer: WebGPURenderer, sunDir: Vector3): void {
    this.sun.value.copy(sunDir);
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(prev);
  }
}
