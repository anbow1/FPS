import { abs, attribute, cos, float, floor, fract, Fn, fwidth, int, ivec2, length, max, min, mix, mod, normalWorld, positionWorld, property, select, sin, smoothstep, step, textureLoad, uniform, varying, vec2, vec3 } from 'three/tsl';
import * as THREE from 'three/webgpu';
import { CITY } from '../config';
import { WINDOWS } from '../world/cityPlan';
import { facade, heightBump, type SurfaceKind } from './buildingMaterial';
import { kelvinToLinear } from './lighting';
import { addThermalConst, G, hash13, vnoise3 } from './nodes';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** Surfaces of the town's buildings: the village's facade kinds plus tarred flat roofs. */
export type CityKind = SurfaceKind | 'roof';

/** Night lights of the town, pre-exposed; set with the lighting preset (game.ts). */
export const CITY_LIGHT = {
  /** Lit room seen through glass (cd/m² × exposure, after the display ceiling). */
  window: uniform(0),
  /** A street lamp's light-emitting face (cd/m² × exposure, after the display ceiling). */
  lamp: uniform(0),
  /** A lamp's intensity straight down (cd × exposure), for the light pools on the paving. */
  lampCd: uniform(0),
};

/**
 * Per-building data the facade shader reads by the building's index (vertex attribute aId):
 *   texel 0: centre x, centre z, yaw, floor level (m)
 *   texel 1: seed, storey height, ground-floor height, window bay (m)
 *   texel 2: window scheme (cityPlan WINDOWS), left gable open, right gable open, —
 * aId is index + 1 on walls that carry windows and −(index + 1) on trims (cornices, parapets,
 * gables, balconies), which take the wall's pattern without windows.
 */
export const BUILDING_TEXELS = 3;

export function makeBuildingData(rows: readonly (readonly number[])[]): THREE.DataTexture {
  const data = new Float32Array(Math.max(1, rows.length) * BUILDING_TEXELS * 4);
  rows.forEach((r, k) => {
    if (r.length !== BUILDING_TEXELS * 4) throw new Error(`building row ${k} has ${r.length} values; expected ${BUILDING_TEXELS * 4}`);
    data.set(r, k * BUILDING_TEXELS * 4);
  });
  const t = new THREE.DataTexture(data, BUILDING_TEXELS, Math.max(1, rows.length), THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

const warm = kelvinToLinear(2900);
const cool = kelvinToLinear(4200);

/**
 * A facade material for the town. The wall's own pattern (brick bond, render, panels, corrugation)
 * comes from the village's facade(); on top of it this draws the windows of the building's scheme in
 * its own frame: recessed glass with frames, mullions and transoms, stone sills, the lintel's shadow
 * in the reveal, curtains, shop fronts with their fascias, panel joints on the prefabs, arched windows
 * and belfry openings on the church. At night a share of the rooms is lit. Everything fades to its
 * average before it aliases, so a street seen from a kilometre is calm.
 */
export function cityMaterial(kind: CityKind, data: THREE.DataTexture): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0 });
  mat.name = `city-${kind}`;
  const id = varying(attribute('aId', 'float'), 'vId');
  const tkRough = property('float', 'tkRough');
  const tkH = property('float', 'tkH');
  const tkGlow = property('vec3', 'tkGlow');
  const windowed = kind === 'plaster' || kind === 'brick' || kind === 'concrete' || kind === 'metal';

  mat.colorNode = Fn(() => {
    const row = int(abs(id).sub(1).add(0.5));
    const t0 = textureLoad(data, ivec2(0, row));
    const t1 = textureLoad(data, ivec2(1, row));
    const t2 = textureLoad(data, ivec2(2, row));
    const cr = cos(t0.z);
    const sr = sin(t0.z);
    const dx = positionWorld.x.sub(t0.x);
    const dz = positionWorld.z.sub(t0.y);
    // world → the building's frame (the inverse of a turn by yaw about +y)
    const local = vec3(dx.mul(cr).sub(dz.mul(sr)), positionWorld.y, dx.mul(sr).add(dz.mul(cr)));
    const nW = normalWorld;
    const nL = vec3(nW.x.mul(cr).sub(nW.z.mul(sr)), nW.y, nW.x.mul(sr).add(nW.z.mul(cr)));
    const seed = t1.x;
    const above = local.y.sub(t0.w);
    tkGlow.assign(vec3(0));
    if (kind === 'roof') {
      // tarred felt under a scatter of gravel, ponding darker in the low spots
      const g = vnoise3(vec3(local.x.mul(9), local.z.mul(9), seed));
      const pond = smoothstep(0.55, 0.8, vnoise3(vec3(local.x.mul(0.4), local.z.mul(0.4), seed.add(2))));
      tkRough.assign(mix(mix(float(0.92), float(0.7), pond), float(0.2), G.uRain));
      tkH.assign(g);
      return vec3(0.05, 0.05, 0.052).mul(g.mul(0.5).add(0.75)).mul(float(1).sub(pond.mul(0.25))).mul(mix(float(1), float(0.7), G.uRain));
    }
    // town walls are kept up better than the village's: render only lost here and there
    const f = facade(kind, local, nL, seed, above, 0.85);
    let col: V3 = f.col;
    if (kind === 'plaster') {
      // the pastel limewash of tenement fronts: cream, ochre, salmon, sage, grey, pale blue
      const pick = hash13(vec3(seed, 11, 5)).mul(6);
      const tint = select(
        pick.lessThan(1),
        vec3(1.0, 0.93, 0.78),
        select(pick.lessThan(2), vec3(1.0, 0.82, 0.55), select(pick.lessThan(3), vec3(1.0, 0.78, 0.68), select(pick.lessThan(4), vec3(0.84, 0.92, 0.78), select(pick.lessThan(5), vec3(0.9, 0.9, 0.9), vec3(0.84, 0.9, 0.97))))),
      );
      col = col.mul(tint);
    }
    let rough: F = f.rough;
    let h: F = f.h;
    if (windowed) {
      const scheme = t2.x;
      const isPrefab = scheme.equal(WINDOWS.prefab);
      const side = abs(nL.x).greaterThan(0.5);
      const faceOpen = select(side, select(nL.x.lessThan(0), t2.y, t2.z), float(1));
      const on = id.greaterThan(0).and(abs(nL.y).lessThan(0.5)).and(scheme.greaterThan(0.5)).and(faceOpen.greaterThan(0.5));
      const floorM = t1.y;
      const groundM = t1.z;
      const bay = t1.w;
      const u = select(side, local.z, local.x);
      const ground = above.lessThan(groundM);
      const level = select(ground, float(0), floor(above.sub(groundM).div(floorM)).add(1));
      const fy = select(ground, above, mod(above.sub(groundM), floorM));
      const bu = u.div(bay);
      const bid = floor(bu);
      const bx = fract(bu).sub(0.5).mul(bay);
      const shopFloor = scheme.equal(WINDOWS.shops).and(ground);
      const church = scheme.equal(WINDOWS.church);
      const belfry = church.and(floorM.greaterThan(20));
      // Opening per scheme: width, sill above the storey's floor, height (m).
      const ww = select(shopFloor, bay.sub(0.6), select(isPrefab, bay.mul(0.62), select(scheme.equal(WINDOWS.industrial), bay.mul(0.75), select(church, float(1.7), min(float(1.35), bay.mul(0.42))))));
      const sill = select(
        shopFloor,
        float(0.5),
        select(belfry, floorM.sub(7), select(church, float(2.5), select(scheme.equal(WINDOWS.industrial), floorM.sub(2.4), select(ground, float(1.3), float(0.9))))),
      );
      const wh = select(
        shopFloor,
        groundM.sub(1.4),
        select(belfry, float(3.5), select(church, floorM.sub(4.5), select(scheme.equal(WINDOWS.industrial), float(1.6), select(isPrefab, float(1.45), select(ground, float(1.5), float(1.65)))))),
      );
      const top = sill.add(wh);
      // arched heads on the church, square elsewhere
      const r = ww.mul(0.5);
      const archY = fy.sub(top.sub(r));
      const inArch = select(church, length(vec2(bx, max(archY, 0))).lessThan(r), abs(bx).lessThan(r));
      const opening = on.and(abs(bx).lessThan(r)).and(fy.greaterThan(sill)).and(fy.lessThan(top)).and(inArch);
      // the entrance between the two middle bays of a house's street front
      const door = on.and(ground).and(nL.z.greaterThan(0.5)).and(scheme.equal(WINDOWS.tenement).or(isPrefab)).and(abs(u).lessThan(0.75)).and(fy.lessThan(2.6));
      const fw = 0.07;
      const pane = abs(bx).lessThan(r.sub(fw)).and(fy.greaterThan(sill.add(fw))).and(fy.lessThan(top.sub(fw)));
      const mullion = abs(bx).lessThan(0.035).and(shopFloor.not());
      const transom = abs(fy.sub(sill.add(wh.mul(0.72)))).lessThan(0.03).and(scheme.equal(WINDOWS.tenement).or(scheme.equal(WINDOWS.shops)).and(shopFloor.not()));
      const glass = pane.and(mullion.not()).and(transom.not());
      const sillStone = on.and(abs(bx).lessThan(r.add(0.08))).and(fy.greaterThan(sill.sub(0.08))).and(fy.lessThan(sill)).and(shopFloor.not());
      const fascia = on.and(shopFloor).and(fy.greaterThan(groundM.sub(0.85))).and(fy.lessThan(groundM.sub(0.3)));
      // one random number per window (and per shop on the ground floor)
      const winKey = vec3(select(shopFloor, floor(bid.div(2)), bid), level.add(select(side, select(nL.x.lessThan(0), float(31), float(57)), select(nL.z.lessThan(0), float(83), float(0)))), seed);
      const hw = hash13(winKey);
      const hw2 = hash13(winKey.add(17.3));
      const frameCol = select(hash13(vec3(seed, 3, 9)).greaterThan(0.4), vec3(0.7, 0.69, 0.66), vec3(0.11, 0.065, 0.04));
      // glass: dark (the room behind it), reflections come from the probe; drawn curtains at the sides
      const curtains = hw2.greaterThan(0.45).and(abs(bx).greaterThan(r.mul(0.45))).and(shopFloor.not());
      const glassCol = select(curtains, vec3(0.3, 0.26, 0.21).mul(hw2.mul(0.6).add(0.5)), select(shopFloor, vec3(0.05, 0.05, 0.048), vec3(0.022, 0.025, 0.028)));
      const shade = select(fy.greaterThan(top.sub(0.22)), float(0.45), select(abs(bx).greaterThan(r.sub(0.12)), float(0.7), float(1)));
      const fasciaCol = mix(vec3(0.12, 0.2, 0.28), vec3(0.42, 0.12, 0.08), hw).mul(hw2.mul(0.6).add(0.5));
      const doorCol = select(hw.greaterThan(0.5), vec3(0.09, 0.055, 0.035), vec3(0.06, 0.1, 0.07));
      let dCol: V3 = select(opening, select(glass, glassCol.mul(shade), frameCol.mul(shade)), col);
      dCol = select(sillStone, vec3(0.42, 0.41, 0.38), dCol);
      dCol = select(fascia, fasciaCol, dCol);
      dCol = select(door, doorCol, dCol);
      const dRough = select(opening.and(glass), select(curtains, float(0.25), float(0.05)), select(opening.or(door), float(0.5), select(sillStone, float(0.75), rough)));
      const dH = select(opening, select(glass, float(0.08), float(0.45)), select(sillStone, float(1.2), select(door, float(0.3), h)));
      // Prefab panels: a joint at every storey and every bay edge.
      const joint = isPrefab.and(fy.lessThan(0.025).or(abs(bx).greaterThan(bay.mul(0.5).sub(0.012))));
      const pCol = select(joint.and(opening.not()), col.mul(0.55), dCol);
      // Lit rooms at night (warm), shops cooler and most of them lit.
      const share = select(shopFloor, float(0.75), float(CITY.windowsLitShare));
      const lit = step(hw, share).mul(select(glass, float(1), float(0))).mul(select(curtains, float(0.55), float(1)));
      const glowCol = select(shopFloor, vec3(cool.r, cool.g, cool.b), vec3(warm.r, warm.g, warm.b).mul(hw2.mul(0.5).add(0.75)));
      const dGlow = glowCol.mul(lit).mul(CITY_LIGHT.window);
      // Far away: the average of wall and windows (the windows are ~22 % of a storey's area).
      const footprint = length(fwidth(vec2(u, local.y)));
      // a window is ~1.4 m: drawn while a pixel covers under ~a third of it, averaged beyond
      const detail = float(1).sub(smoothstep(0.18, 0.55, footprint));
      const share2 = select(on, float(0.22), float(0));
      const avgCol = mix(col, vec3(0.04, 0.042, 0.045), share2);
      col = mix(avgCol, pCol, detail);
      rough = mix(mix(rough, float(0.3), share2), dRough, detail);
      h = mix(float(0.5), dH, detail);
      tkGlow.assign(mix(vec3(warm.r, warm.g, warm.b).mul(CITY_LIGHT.window).mul(share2.mul(CITY.windowsLitShare).mul(0.7)), dGlow, detail));
    }
    tkRough.assign(mix(rough, rough.mul(0.55), G.uRain));
    tkH.assign(h);
    return col.mul(mix(float(1), float(0.72), G.uRain));
  })();
  mat.roughnessNode = tkRough;
  mat.emissiveNode = tkGlow;
  const bump = kind === 'tiles' ? 0.035 : kind === 'roof' ? 0.006 : 0.012;
  mat.normalNode = heightBump(tkH, bump);
  addThermalConst(mat, kind === 'metal' ? 0.14 : kind === 'tiles' || kind === 'roof' ? 0.12 : 0.1);
  return mat;
}
