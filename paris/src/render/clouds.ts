import { float, mix, positionWorld, smoothstep, vec2, vec3, vec4 } from 'three/tsl';
import { DoubleSide, Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu';
import { LIGHT } from '../config.ts';
import { lightColour } from './colour.ts';
import { fbm2, SCENE } from './nodes.ts';

// A thin deck of altocumulus high over the city, lit from below by the low
// sun — the warm, broken evening sky that shows in the slot of sky over a
// boulevard. A flat layer at 3.2 km with its cover from noise, drifting with
// the wind; its radiance is the sun's warm light scattered forward toward the
// camera plus the blue sky's, pre-exposed like everything else. The haze takes
// it near the horizon. (Volumetric cumulus are Field Line's volumeClouds.ts;
// in a 30 m-wide slot of sky a flat layer is enough.)

const HEIGHT_M = 3200;

export function cloudDeck(preExposure: number): Mesh {
  const sunK = lightColour(LIGHT.sunColourK);
  const skyK = lightColour(LIGHT.skyColourK);
  const m = new MeshBasicNodeMaterial({ name: 'cloud deck', transparent: true, depthWrite: false, side: DoubleSide });
  const p = vec2(positionWorld.x, positionWorld.z).div(2600).add(vec2(SCENE.time.mul(0.0006), 0));
  const n = fbm2(p.mul(3)).mul(0.65).add(fbm2(p.mul(11).add(4.2)).mul(0.35));
  const cover = smoothstep(0.52, 0.72, n);
  // Thicker parts are darker underneath; the thin edges glow with the low sun.
  const thick = smoothstep(0.6, 0.85, n);
  const sunLum = (LIGHT.sunIlluminanceLux / Math.PI) * preExposure * 0.55;
  const skyLum = (LIGHT.skyIlluminanceLux / Math.PI) * preExposure * 0.9;
  const warm = vec3(sunK.r, sunK.g * 0.86, sunK.b * 0.72).mul(sunLum);
  const cool = vec3(skyK.r, skyK.g, skyK.b).mul(skyLum);
  const colour = mix(warm.add(cool.mul(0.4)), cool.mul(0.9).add(warm.mul(0.25)), thick);
  m.colorNode = vec4(colour, cover.mul(float(0.85)));
  m.fog = true;
  const mesh = new Mesh(new PlaneGeometry(60000, 60000).rotateX(Math.PI / 2), m);
  mesh.position.y = HEIGHT_M;
  mesh.renderOrder = -999;
  mesh.frustumCulled = false;
  mesh.name = 'cloud deck';
  return mesh;
}
