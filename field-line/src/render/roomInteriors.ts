import { abs, attribute, cameraPosition, dot, float, floor, Fn, fract, If, length, max, min, mix, normalWorld, normalWorldGeometry, positionWorld, pow, select, sign, sin, smoothstep, step, uniform, uv, vec2, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { CITY_LIGHTS } from '../config.ts';
import { cityNight, lightPreExposure } from './cityLights.ts';
import { lightColour } from './colour.ts';

// Rooms behind the façade windows, without geometry: interior mapping (van
// Dongen 2008). The façade is one flat box; for a pixel of a window pane the
// view ray carries on into an imaginary room one bay wide, one storey high and
// a few metres deep, and the shader finds the wall, floor or ceiling it meets.
// The room moves with parallax as the camera passes, which is what makes a
// window read as a hole into a building and not as a picture on it.
//
// Each room (per window, per façade face) draws its own wall paint, floor,
// a piece of furniture against the back wall and curtains; at night a share of
// them has the ceiling light on (the old flat window glow, now with depth), by
// day all are lit only through the window, a few per cent of the light outside.
// The ground floor holds deeper, brighter shops.
//
// Far away the room shrinks below a pixel and the hit surface would flicker
// between walls from pixel to pixel: past ~60 m it fades to the room's mean.

/** Daylight in the rooms by the window (pre-exposed lux): set by the view from the lighting preset. */
export const roomDaylight = uniform(0);

const ROOM_DEPTH_M = 4.2;
const SHOP_DEPTH_M = 7;
/** Illuminance of a lit shop's goods by day (lux). */
const SHOP_DAY_LUX = 1500;
/** The pane's opening across a façade tile (patterns.ts `facade`). */
const PANE_U0 = 0.3;
const PANE_U1 = 0.7;

/** 0 … 1 per room: which window, and which face of the block (the geometric normal tells the four apart). */
export function roomHash(): Node<'float'> {
  const cell = floor(uv());
  const key = cell.add(vec2(dot(normalWorldGeometry, vec3(17.1, 0, 31.7)), dot(normalWorldGeometry, vec3(5.3, 0, 11.9))));
  return fract(sin(dot(key, vec2(12.9898, 78.233))).mul(43758.5453));
}

/**
 * Light leaving the room through the pane (pre-exposed radiance) on façade tiles, scaled by `pane`
 * (1 on clear glass, 0 on frame, blind and wall). Needs the façade's `tileSize` attribute (bay, storey in m).
 */
export function roomInteriorNode(pane: Node<'float'>): Node<'vec3'> {
  return Fn(() => {
    // Built from the shared normals before the branch, so they are set on every pixel (see materials.ts `lampLit`).
    const out = normalWorldGeometry.add(normalWorld).mul(0).toVar('room');
    If(pane.greaterThan(0.004), () => {
      const t = uv();
      const cell = floor(t);
      const f = fract(t);
      const size = attribute('tileSize', 'vec2');
      const n = normalWorldGeometry;
      // The face's frame: right = up × normal (worldMesh.ts), into the room = −normal.
      const right = vec3(n.z, 0, n.x.negate());
      const view = positionWorld.sub(cameraPosition).normalize();
      const cosIn = max(dot(view, n).negate(), 1e-3);
      const d = vec3(dot(view, right), view.y, cosIn);
      const h = roomHash();
      const shop = step(cell.y, 0.5).mul(step(-0.5, cell.y));
      const depth = mix(float(ROOM_DEPTH_M), float(SHOP_DEPTH_M), shop);
      const room = vec3(size.x, size.y, depth);
      const p = vec3(f.x.mul(size.x), f.y.mul(size.y), 0);

      // The ray leaves the room's box through the nearest of the three planes it is heading for.
      const ds = vec3(select(abs(d.x).lessThan(1e-4), float(1e-4), d.x), select(abs(d.y).lessThan(1e-4), float(1e-4), d.y), d.z);
      const tAxis = step(vec3(0), ds).mul(room).sub(p).div(ds);
      const tRoom = min(tAxis.x, min(tAxis.y, tAxis.z));
      const isX = step(tAxis.x, min(tAxis.y, tAxis.z));
      const isY = float(1).sub(isX).mul(step(tAxis.y, tAxis.z));
      const isZ = float(1).sub(isX).sub(isY);
      const faceN = vec3(isX.mul(sign(ds.x).negate()), isY.mul(sign(ds.y).negate()), isZ.negate()).toVar('roomN');
      const hit = p.add(d.mul(tRoom)).toVar('roomHit');

      // Paint, floor, ceiling.
      const paint = mix(vec3(0.66, 0.6, 0.5), vec3(0.5, 0.56, 0.6), fract(h.mul(13.7))).mul(mix(float(0.55), float(1.05), fract(h.mul(29.3))));
      const wall = mix(paint, vec3(0.6, 0.6, 0.58), shop);
      const floorCol = mix(vec3(0.3, 0.2, 0.12), vec3(0.42, 0.4, 0.37), fract(h.mul(5.3)));
      const onFloor = isY.mul(step(ds.y, 0));
      const onCeiling = isY.sub(onFloor);
      const albedo = mix(mix(wall.mul(mix(float(1), float(0.88), isZ)), floorCol, onFloor), vec3(0.8), onCeiling).toVar('roomAlbedo');

      // One piece of furniture against the back wall (a sideboard, a wardrobe; shelving in a shop): its
      // front face, a vertical rectangle 0.55 m in front of the wall.
      const zf = depth.sub(0.55);
      const tf = zf.div(d.z);
      const q = p.add(d.mul(tf));
      const fx0 = fract(h.mul(3.1)).mul(size.x.mul(0.5));
      const fw = mix(float(0.9), float(1.6), fract(h.mul(7.7)));
      const fh = mix(mix(float(0.8), float(2.0), fract(h.mul(9.1))), float(1.9), shop);
      const onFurniture = step(tf, tRoom).mul(step(fx0, q.x)).mul(step(q.x, fx0.add(fw))).mul(step(q.y, fh));
      If(onFurniture.greaterThan(0.5), () => {
        hit.assign(q);
        faceN.assign(vec3(0, 0, -1));
        const wood = mix(vec3(0.25, 0.16, 0.1), vec3(0.55, 0.52, 0.48), fract(h.mul(11.3)));
        // Shop shelves: bands of goods and dark gaps.
        const shelf = mix(float(1), step(0.18, fract(q.y.div(0.45))).mul(0.7).add(0.3), shop);
        albedo.assign(wood.mul(shelf));
      });

      // Night: a ceiling light in the middle of the room, Lambert with inverse square, plus bounce.
      const lamp = vec3(size.x.mul(0.5), size.y.sub(0.3), depth.mul(0.45));
      const toLamp = lamp.sub(hit);
      const d2 = dot(toLamp, toLamp);
      const lambert = max(dot(faceN, toLamp.normalize()), 0);
      const lampShape = lambert.mul(2.5).div(d2.add(0.4)).add(0.15);
      // The fitting itself, seen on the ceiling.
      const fitting = onCeiling.mul(smoothstep(0.32, 0.2, length(hit.xz.sub(lamp.xz)))).mul(10);
      const lit = mix(step(h, CITY_LIGHTS.litShare), step(h, 0.8), shop);
      const level = mix(mix(float(0.35), float(1.4), fract(h.mul(7.31))), float(1), shop);
      const roomK = lightColour(CITY_LIGHTS.windowK);
      const shopK = lightColour(CITY_LIGHTS.shopK);
      const lampColour = mix(vec3(roomK.r, roomK.g, roomK.b).mul(CITY_LIGHTS.windowLuminance), vec3(shopK.r, shopK.g, shopK.b).mul(CITY_LIGHTS.shopLuminance), shop);
      const night = lampColour.mul(lit).mul(level).mul(lightPreExposure).mul(cityNight);
      // Day: light through the window, falling off into the room; the floor gets most, the ceiling least.
      const daySpread = mix(float(1), float(0.25), hit.z.div(depth)).mul(mix(float(1), float(1.3), onFloor)).mul(mix(float(1), float(0.5), onCeiling));
      // Shops keep their lights on all day (~1500 lux on the goods), which is what lets a passer-by see in.
      const shopLamps = shop.mul(lit).mul(SHOP_DAY_LUX / Math.PI).mul(lightPreExposure).mul(lampShape);
      const day = roomDaylight.mul(daySpread).div(Math.PI).add(shopLamps);
      let radiance: Node<'vec3'> = albedo.mul(night.mul(lampShape).add(day)).add(night.mul(fitting));

      // Curtains just inside the glass (living rooms only): drawn to the sides, some with a sheer net across.
      const tc = float(0.1).div(d.z);
      const c = p.add(d.mul(tc));
      const x0 = size.x.mul(PANE_U0);
      const x1 = size.x.mul(PANE_U1);
      const cw = fract(h.mul(3.7)).mul(0.45).mul(x1.sub(x0));
      const curtain = float(1).sub(step(x0.add(cw), c.x).mul(step(c.x, x1.sub(cw)))).mul(float(1).sub(shop));
      const cloth = mix(vec3(0.5, 0.18, 0.13), vec3(0.72, 0.68, 0.58), fract(h.mul(17.9)));
      // Backlit at night (light through the cloth), front-lit by day.
      const clothRad = cloth.mul(night.mul(0.9).add(roomDaylight.mul(0.9 / Math.PI)));
      radiance = mix(radiance, clothRad, curtain);
      const sheer = step(0.6, fract(h.mul(11.1))).mul(float(1).sub(shop)).mul(0.45);
      radiance = mix(radiance, vec3(0.8, 0.78, 0.74).mul(night.mul(0.7).add(roomDaylight.mul(0.8 / Math.PI))), sheer);

      // Far: the room's mean, so a sub-pixel room does not sparkle.
      const mean = wall.mul(night.mul(0.9).add(roomDaylight.mul(0.55 / Math.PI)));
      const far = smoothstep(60, 160, length(positionWorld.sub(cameraPosition)));
      radiance = mix(radiance, mean, far);

      // What the pane lets through: 1 − Schlick reflectance (glass F0 0.04); the reflection is the material's.
      const transmit = float(1).sub(float(0.04).add(pow(float(1).sub(cosIn), 5).mul(0.96)));
      out.assign(radiance.mul(transmit).mul(pane));
    });
    return out;
  })();
}
