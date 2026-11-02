import { abs, float, max, mix, normalWorld, positionWorld, smoothstep, texture, uniform, uniformArray, vec2, vec3 } from 'three/tsl';
import { DataTexture, DataUtils, HalfFloatType, LinearFilter, type Node, RedFormat, type Scene, SpotLight, Vector3 } from 'three/webgpu';
import { CITY_LIGHTS } from '../config.ts';
import type { MapData } from '../maps/types.ts';
import { lightColour } from './colour.ts';
import { skyVisibilityNode } from './interior.ts';

// The city at night: street lamps, and the light they throw on everything.
//
//   lenses     the lamp heads' undersides glow (physical luminance, so the
//              bloom and the wet street's reflections pick them up);
//   near       the lamps nearest the camera are real spot lights pointing down:
//              they light soldiers, cars and the weapon, and draw the specular
//              highlights on wet asphalt that a baked map cannot;
//   far        every other lamp's light on the ground, baked once at load into
//              an irradiance map over the city (0.5 m texels): each surface
//              adds albedo × E / π from it. The near lamps' share is
//              subtracted analytically in the shader with the same formula
//              the bake used, so no surface is lit twice by one lamp;
//   windows    a share of the façades' windows lit warm, the ground floor's
//              shop windows brighter and cooler (materials.ts, `windowGlow`).
//
// All of it scales with `cityNight` (0 by day), so the shaders are the same
// day and night. Lamp distribution: a cut-off street luminaire, full intensity
// down to ~60° from the nadir, none above ~80° (dark-sky optics).

/** 1 at night in the city, 0 otherwise. */
export const cityNight = uniform(0);
/** The lighting preset's pre-exposure, for emission authored in physical units. */
export const lightPreExposure = uniform(1);

/** The lamps' intensity (cd) and colour on this map: City's cut-off luminaires, or the boulevard's lanterns. */
const lampCd = uniform(CITY_LIGHTS.lampCd);
const lampColourU = uniform(new Vector3(1, 1, 1));
{
  const c = lightColour(CITY_LIGHTS.lampK);
  lampColourU.value.set(c.r, c.g, c.b);
}

/** A map's own lamps: where the light comes from, how strong (cd) and how warm (K). */
export interface LampSet {
  heads: Vector3[];
  cd: number;
  kelvin: number;
}

const MAP_CELL_M = 0.5;
const REACH_M = 34;
const MAX_NEAR = 6;

/** Lamp heads (world) for the map's lamp posts: the lens under the head, at the end of the arm. */
export function lampHeads(map: MapData): Vector3[] {
  return map.props
    .filter((p) => p.kind === 'lampPost')
    .map((p) => {
      const s = p.scale;
      return new Vector3(p.pos.x + Math.sin(p.yawRad) * 1.3 * s, p.pos.y + 6.23 * s, p.pos.z + Math.cos(p.yawRad) * 1.3 * s);
    });
}

/** The luminaire's relative intensity at `cosNadir` (cosine of the angle from straight down). */
export function lampProfile(cosNadir: number): number {
  const t = Math.min(1, Math.max(0, (cosNadir - 0.17) / (0.5 - 0.17)));
  return t * t * (3 - 2 * t);
}

/** Irradiance (lux) on a horizontal surface at (x, y, z) from one lamp of `cd` candela. */
export function lampIrradiance(lamp: Vector3, x: number, y: number, z: number, cd: number = CITY_LIGHTS.lampCd): number {
  const dx = lamp.x - x;
  const dy = lamp.y - y;
  const dz = lamp.z - z;
  if (dy <= 0) return 0;
  const d2 = dx * dx + dy * dy + dz * dz;
  const cos = dy / Math.sqrt(d2);
  return (cd * lampProfile(cos) * cos) / d2;
}

// The far lamps' light map: bound at load (a 1-texel placeholder until then, so every material can be built first).
const empty = new DataTexture(new Uint16Array([0]), 1, 1, RedFormat, HalfFloatType);
empty.needsUpdate = true;
const lampMap = texture(empty);
const mapHalfM = uniform(1);
const nearLamps = uniformArray(
  Array.from({ length: MAX_NEAR }, () => new Vector3(0, -1000, 0)),
  'vec3',
);

/**
 * The lamps' light on this surface (pre-exposed irradiance, lux × pre-exposure): the baked map minus the
 * near lamps (they are real lights), for an up-facing surface fully and for a wall about half — a crude but
 * steady split of the light that keeps walls by the road from going dark. Indoors only what the windows let in.
 */
export function lampLightNode(): Node<'vec3'> {
  const p = positionWorld;
  const uvMap = vec2(p.x.add(mapHalfM), p.z.add(mapHalfM)).div(mapHalfM.mul(2));
  let e: Node<'float'> = lampMap.sample(uvMap).r;
  for (let i = 0; i < MAX_NEAR; i++) {
    const l = nearLamps.element(i) as unknown as Node<'vec3'>;
    const d = l.sub(vec3(p.x, 0, p.z));
    const d2 = d.dot(d);
    const cos = d.y.div(d2.sqrt());
    const profile = smoothstep(0.17, 0.5, cos);
    e = e.sub(profile.mul(cos).mul(lampCd).div(d2.max(1e-3)));
  }
  const up = max(normalWorld.y, 0);
  const facing = mix(float(0.5), float(1), up).mul(float(1).sub(smoothstep(0.3, 1, normalWorld.y.negate())));
  // Light falls off up a wall well before the lamp's height.
  const height = float(1).sub(smoothstep(4, 9, abs(p.y)));
  return lampColourU
    .mul(max(e, 0))
    .mul(facing)
    .mul(height)
    .mul(skyVisibilityNode())
    .mul(lightPreExposure)
    .mul(cityNight);
}

/**
 * All the lamps' light at this point's ground position (pre-exposed lux, the baked map only): what lights
 * the rain falling through the lamps' cones. Unlit geometry (the rain) gets no real light, so nothing is
 * subtracted here.
 */
export function lampAirLightNode(): Node<'vec3'> {
  const p = positionWorld;
  const e = lampMap.sample(vec2(p.x.add(mapHalfM), p.z.add(mapHalfM)).div(mapHalfM.mul(2))).r;
  // Brightest in the cone below the lamp, fading above it.
  const below = float(1).sub(smoothstep(5.5, 7.5, p.y));
  return lampColourU.mul(e).mul(below).mul(lightPreExposure).mul(cityNight);
}

/** Emission of the lamp lenses (pre-exposed). */
export function lensGlowNode(): Node<'vec3'> {
  const c = lightColour(CITY_LIGHTS.lampK);
  return vec3(c.r, c.g, c.b).mul(CITY_LIGHTS.lensLuminance).mul(lightPreExposure).mul(cityNight);
}

export class CityLights {
  readonly heads: Vector3[];
  private readonly spots: SpotLight[] = [];
  private readonly order: number[];
  private readonly scene: Scene;
  private on = false;
  private readonly cd: number;

  /** `lamps`: the map's own lamps (default: its lamp posts, City's luminaires). */
  constructor(map: MapData, scene: Scene, quality: 'high' | 'low', lamps?: LampSet) {
    this.scene = scene;
    this.heads = lamps?.heads ?? lampHeads(map);
    this.cd = lamps?.cd ?? CITY_LIGHTS.lampCd;
    lampCd.value = this.cd;
    const c = lightColour(lamps?.kelvin ?? CITY_LIGHTS.lampK);
    lampColourU.value.set(c.r, c.g, c.b);
    this.order = this.heads.map((_, i) => i);
    this.bake(map);
    const n = Math.min(MAX_NEAR, quality === 'high' ? CITY_LIGHTS.nearLampsHigh : CITY_LIGHTS.nearLampsLow);
    for (let i = 0; i < n; i++) {
      // Cone to ~80° from the nadir, full strength inside ~60°: the bake's profile (penumbra = 1 − 60/80).
      const s = new SpotLight(0xffffff, 0, 0, Math.acos(0.17), 0.25, 2);
      s.color.setRGB(c.r, c.g, c.b);
      s.castShadow = false;
      this.spots.push(s);
    }
  }

  /** The irradiance map of every lamp on the ground (lux), half float for linear filtering everywhere. */
  private bake(map: MapData): void {
    const half = map.halfSizeM + 20;
    const res = Math.ceil((half * 2) / MAP_CELL_M);
    const e = new Float32Array(res * res);
    const reach = Math.ceil(REACH_M / MAP_CELL_M);
    for (const l of this.heads) {
      const ci = Math.floor((l.x + half) / MAP_CELL_M);
      const cj = Math.floor((l.z + half) / MAP_CELL_M);
      for (let j = Math.max(0, cj - reach); j <= Math.min(res - 1, cj + reach); j++) {
        for (let i = Math.max(0, ci - reach); i <= Math.min(res - 1, ci + reach); i++) {
          const x = -half + (i + 0.5) * MAP_CELL_M;
          const z = -half + (j + 0.5) * MAP_CELL_M;
          e[j * res + i] = (e[j * res + i] as number) + lampIrradiance(l, x, 0, z, this.cd);
        }
      }
    }
    const halfData = new Uint16Array(res * res);
    for (let k = 0; k < e.length; k++) halfData[k] = DataUtils.toHalfFloat(e[k] as number);
    const t = new DataTexture(halfData, res, res, RedFormat, HalfFloatType);
    t.minFilter = LinearFilter;
    t.magFilter = LinearFilter;
    t.needsUpdate = true;
    lampMap.value = t;
    mapHalfM.value = half;
  }

  /** Night on or off. The spot lights join the scene only at night (adding lights recompiles, once). */
  setNight(night: boolean, preExposure: number): void {
    cityNight.value = night ? 1 : 0;
    lightPreExposure.value = preExposure;
    if (night === this.on) return;
    this.on = night;
    for (const s of this.spots) {
      if (night) this.scene.add(s, s.target);
      else this.scene.remove(s, s.target);
    }
  }

  /** The nearest lamps become the real spot lights; the shader subtracts their share of the map. */
  update(camera: { position: Vector3 }, preExposure: number): void {
    lightPreExposure.value = preExposure;
    if (!this.on) return;
    const cam = camera.position;
    const d = (i: number): number => (this.heads[i] as Vector3).distanceToSquared(cam);
    this.order.sort((a, b) => d(a) - d(b));
    for (let k = 0; k < MAX_NEAR; k++) {
      const head = k < this.spots.length ? this.heads[this.order[k] as number] : undefined;
      const slot = nearLamps.array[k] as Vector3;
      if (head) slot.copy(head);
      else slot.set(0, -1000, 0);
      const s = this.spots[k];
      if (!s) continue;
      if (head) {
        s.position.copy(head);
        s.target.position.set(head.x, head.y - 5, head.z);
        s.intensity = this.cd * preExposure;
      } else s.intensity = 0;
    }
  }
}
