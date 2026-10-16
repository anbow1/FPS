import { float, Fn, normalize, positionWorld, texture, uniform, uv, vec3, vec4 } from 'three/tsl';
import { HalfFloatType, LinearFilter, MeshBasicNodeMaterial, type Node, QuadMesh, RenderTarget, type Texture, UnsignedByteType, Vector2, type Vector3, type WebGPURenderer } from 'three/webgpu';
import { TERRAIN } from '../sim/terrain.ts';
import { contactOcclusion, vehicleSunShadow } from './contactShadow.ts';
import { GrassField } from './grassField.ts';
import { landSurface } from './landCover.ts';
import { meshHeightNode } from './terrainMesh.ts';
import type { TerrainTextures } from './terrainTextures.ts';

// Grass blades round the camera while it is near the ground — on the pad,
// hovering low, in the pilot's seat — from the shared field (grassField.ts,
// docs/graphics-playbook.md §5.6): rooted on the rendered terrain's own
// triangles, grown where the land cover says meadow, stubble, heath or sedge
// (landCover.ts, the function the terrain paints with), coloured by the field
// each blade stands in, and laid out flat and thrashing by the rotor's
// downwash. Above ~90 m it is switched off: a blade is under a pixel there.
//
// The land cover is twenty noise lookups and the mesh height nine texture
// loads: per blade vertex (half a million a frame) that lost the GPU device in
// testing. So both are baked into two small maps round the camera — 105 m at
// 0.5 m texels, one full-screen pass each — whenever the camera has moved a
// few metres, and the blades read two texels each.

/** Camera height above the ground under it (m) below which the field is drawn. */
const VISIBLE_BELOW_M = 90;
const BAKE_RES = 210;
const BAKE_TEXEL_M = 0.5;
const BAKE_SPAN_M = BAKE_RES * BAKE_TEXEL_M;
/** Re-centre the maps when the camera has moved this far from their centre (m). */
const REBAKE_M = 4;

export interface GrassSetup {
  field: GrassField;
  /** Per frame: the camera, the rotor hub's ground point and the downwash strength 0…1. */
  update(camera: Vector3, cameraAglM: number, groundY: number, dtS: number, timeS: number, fovDeg: number, viewportHeightPx: number, rotor: { x: number; z: number; radiusM: number; strength: number }): void;
}

export function buildGrass(renderer: WebGPURenderer, tex: TerrainTextures, shadow: Texture | null, high: boolean): GrassSetup {
  const wind = uniform(new Vector2(2.2, 0.9));
  const time = uniform(0);
  // The maps' corner in the world and the height their heights are measured from (half floats).
  const origin = uniform(new Vector2(1e6, 1e6));
  const refY = uniform(0);
  const target = (type: typeof UnsignedByteType | typeof HalfFloatType): RenderTarget => {
    const t = new RenderTarget(BAKE_RES, BAKE_RES, { type, depthBuffer: false });
    t.texture.minFilter = LinearFilter;
    t.texture.magFilter = LinearFilter;
    t.texture.generateMipmaps = false;
    return t;
  };
  const densityRT = target(UnsignedByteType);
  const surfaceRT = target(HalfFloatType);
  const bake = (out: (xz: Node<'vec2'>, y: Node<'float'>) => Node<'vec4'>): QuadMesh => {
    const m = new MeshBasicNodeMaterial({ name: 'grass bake' });
    // fragmentNode: written as is (the colour path would clamp the heights).
    m.fragmentNode = Fn(() => {
      const xz = origin.add(uv().mul(BAKE_SPAN_M));
      return out(xz, meshHeightNode(tex.nearHeight, xz));
    })();
    return new QuadMesh(m);
  };
  const landAt = (xz: Node<'vec2'>, y: Node<'float'>): ReturnType<typeof landSurface> => {
    const uvN = xz.div(TERRAIN.nearSizeM).add(0.5);
    const cov = texture(tex.nearCover, uvN);
    const nrm = normalize(texture(tex.nearNormal, uvN).xyz.mul(2).sub(1));
    return landSurface(vec3(xz.x, y, xz.y), nrm, cov);
  };
  const densityPass = bake((xz, y) => landAt(xz, y).grass);
  const surfacePass = bake((xz, y) => vec4(landAt(xz, y).albedo, y.sub(refY)));
  const mapUv = (xz: Node<'vec2'>): Node<'vec2'> => xz.sub(origin).div(BAKE_SPAN_M);

  const field = new GrassField(
    (xz) => texture(surfaceRT.texture, mapUv(xz)).level(float(0)).a.add(refY),
    (xz) => {
      const at = mapUv(xz);
      return { density: texture(densityRT.texture, at).level(float(0)), colour: texture(surfaceRT.texture, at).level(float(0)).rgb };
    },
    {
      tileM: 4,
      bladesPerTile: high ? 640 : 280,
      radiusM: high ? 46 : 30,
      wind,
      time,
      // Linear albedo; most of a blade's colour comes from the field under it (groundTint).
      // Tips only a little drier: from a seat 3 m up the upper halves are what shows, and pale tips
      // turned the meadow to frost.
      colours: { meadow: [0.09, 0.16, 0.045], beach: [0.2, 0.19, 0.09], sedge: [0.08, 0.13, 0.05], dry: [0.17, 0.18, 0.07] },
      // Seen from a seat 3 m up or a chase camera 10–25 m up: wider than an infantryman's blades.
      widthScale: 2.6,
      rootShade: 0.85,
      kindHeightsM: [
        [0.12, 0.34],
        [0.05, 0.14],
        [0.4, 0.75],
      ],
      groundTint: 0.8,
      // A 58 m window: the downwash of a 15 m rotor reaches about two diameters.
      trampleCellM: 0.45,
      matte: true,
    },
  );
  // The ridges' shadow (terrainShadow.ts) on the blades as on the ground under them; the cloud shadow
  // multiplies on top (clouds.shadeReceivers reads this).
  field.material.aoNode = contactOcclusion(positionWorld.xz);
  field.material.userData.shadowFactor = shadow
    ? texture(shadow, positionWorld.xz.div(TERRAIN.nearSizeM).add(0.5)).r.mul(vehicleSunShadow(positionWorld.xz))
    : vehicleSunShadow(positionWorld.xz);
  field.group.visible = false;
  const centre = new Vector2(1e9, 1e9);
  return {
    field,
    update(camera, cameraAglM, groundY, dtS, timeS, fovDeg, viewportHeightPx, rotor) {
      const on = cameraAglM < VISIBLE_BELOW_M && Math.max(Math.abs(camera.x), Math.abs(camera.z)) < TERRAIN.blendFromM - 200;
      field.group.visible = on;
      if (!on) {
        centre.set(1e9, 1e9);
        return;
      }
      if (Math.hypot(camera.x - centre.x, camera.z - centre.y) > REBAKE_M) {
        // Whole texels, so a texel's world spot never moves between bakes.
        const ox = Math.round((camera.x - BAKE_SPAN_M / 2) / BAKE_TEXEL_M) * BAKE_TEXEL_M;
        const oz = Math.round((camera.z - BAKE_SPAN_M / 2) / BAKE_TEXEL_M) * BAKE_TEXEL_M;
        origin.value.set(ox, oz);
        refY.value = groundY;
        centre.set(ox + BAKE_SPAN_M / 2, oz + BAKE_SPAN_M / 2);
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(densityRT);
        densityPass.render(renderer);
        renderer.setRenderTarget(surfaceRT);
        surfacePass.render(renderer);
        renderer.setRenderTarget(prev);
      }
      time.value = timeS;
      if (rotor.strength > 0.01) field.blow(rotor.x, rotor.z, rotor.radiusM, rotor.strength);
      field.update(camera, dtS, fovDeg, viewportHeightPx, rotor);
    },
  };
}
