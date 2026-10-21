import { abs, attribute, cameraPosition, cross, dot, float, floor, fract, max, min, mix, normalize, normalWorld, positionWorld, pow, select, sin, smoothstep, step, uv, vec2, vec3 } from 'three/tsl';
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu';
import { hash12, linearRgb, SCENE, vnoise2 } from './nodes.ts';
import { PAINTS, pick } from './architecture.ts';

// Glass with rooms behind it (interior mapping, van Dongen 2008) and the
// joinery drawn over it, for the French windows, the dormers and the shops.
//
// Every pane is a near-black, glossy dielectric: the sky and the facades
// opposite come from the environment as a reflection that grows toward
// grazing (Schlick), and the room shows through face-on as emitted light
// (what the daylight inside scatters back out), weighted by 1 − F. The room
// is a box one bay wide, a storey high and ~5 m deep: the view ray from the
// pane hits a wall, the floor or the ceiling, coloured by a hash of the
// window; most have sheer curtains just inside the glass, some heavy drapes
// at the sides, and a few rooms have their lamps on at this hour.

type F = Node<'float'>;
type V3 = Node<'vec3'>;

const FRAME_PAINTS: [number, number, number][] = [0xe9e3d6, 0xd9d6cc, 0xbfc2bd, 0xe4dccb].map(linearRgb);
const WALLS: [number, number, number][] = [0xe8e0cf, 0xd9cdb6, 0xc9cbbf, 0xe6d6c0, 0xb9a98e, 0xd4c2a0].map(linearRgb);
const DRAPES: [number, number, number][] = [0x6a1f24, 0x2a3b55, 0xb59d6a, 0x5b5f3a].map(linearRgb);

/** A pane line: 1 within `half` of `d` (metres), soft over a pixel so TRAA resolves it. */
function bar(d: F, half: number): F {
  return float(1).sub(smoothstep(half * 0.7, half * 1.3, abs(d)));
}

/** View ray in the room's frame (x along the front, y up, z into the building), from the pane's normal. */
function roomRay(): { vx: F; vy: F; vz: F } {
  const v = normalize(positionWorld.sub(cameraPosition));
  const n = normalWorld;
  const right = normalize(cross(vec3(0, 1, 0), n));
  return { vx: dot(v, right), vy: v.y, vz: max(dot(v, n).negate(), 0.02) };
}

/**
 * The room seen through a pane at (px, py) on the glass (m, from the room's centre line and its floor): the
 * radiance (pre-exposed) of the surface the view ray meets.
 */
function room(px: F, py: F, roomW: F, roomH: F, depth: F, seed: F, lit: F): V3 {
  const { vx, vy, vz } = roomRay();
  const tx = select(vx.greaterThan(0), roomW.mul(0.5).sub(px), roomW.mul(-0.5).sub(px)).div(vx);
  const ty = select(vy.greaterThan(0), roomH.sub(py), py.negate()).div(vy);
  const tz = depth.div(vz);
  const t = min(min(abs(tx), abs(ty)), tz);
  const hx = px.add(vx.mul(t));
  const hy = py.add(vy.mul(t));
  const hz = vz.mul(t);
  const wall = pick(floor(seed.mul(WALLS.length)), WALLS);
  const isBack = step(tz, min(abs(tx), abs(ty)));
  const isFloorOrCeil = step(abs(ty), abs(tx)).mul(isBack.oneMinus());
  const isFloor = isFloorOrCeil.mul(step(vy, 0));
  // Oak parquet in boards, the ceiling white, the walls the room's colour; a picture or a bookcase on the back wall.
  const board = hash12(vec2(floor(hx.mul(9)), floor(hz.mul(1.2).add(hx.mul(9).floor().mul(0.37)))));
  const parquet = vec3(...linearRgb(0x6b4a2e)).mul(board.mul(0.4).add(0.7));
  const furniture = step(abs(hx.sub(seed.sub(0.5).mul(roomW).mul(0.5))), roomW.mul(0.18)).mul(step(hy, roomH.mul(0.62))).mul(step(0.3, hy));
  const back = mix(wall, vec3(...linearRgb(0x3a2a1e)).mul(vnoise2(vec2(hx.mul(14), hy.mul(3))).mul(0.6).add(0.5)), furniture.mul(step(0.35, fract(seed.mul(7.3)))));
  let albedo: V3 = mix(wall.mul(0.9), back, isBack);
  albedo = mix(albedo, mix(vec3(0.82, 0.8, 0.76), parquet, isFloor), isFloorOrCeil);
  // Daylight falls off from the window inward; a lit room adds its lamp (warm), brightest on the ceiling.
  const day = SCENE.interiorLux.mul(pow(float(1).div(hz.mul(0.45).add(1)), 2)).mul(1 / Math.PI);
  const lamp = SCENE.roomLampNits.mul(lit).mul(mix(float(0.55), float(1), isFloorOrCeil.mul(step(0, vy))));
  return albedo.mul(day.add(lamp.mul(vec3(1, 0.78, 0.5))));
}

/** Schlick's Fresnel for glass (F0 = 0.04) at the pixel's view angle. */
function fresnel(): F {
  const v = normalize(cameraPosition.sub(positionWorld));
  const c = max(dot(v, normalWorld), 0);
  return float(0.04).add(float(0.96).mul(pow(float(1).sub(c), 5)));
}

/** French windows, entresol windows, dormers and the tall barred windows of a bank. */
export function windowMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'window', metalness: 0 });
  const p = uv();
  const win = attribute('win', 'vec4');
  const w = win.x;
  const h = win.y;
  const seed = win.z;
  const kind = win.w;
  const ao = attribute('ao', 'float');
  const fx = p.x.mul(w);
  const fy = p.y.mul(h);
  const isDormer = step(1.5, kind).mul(step(kind, 2.5));
  const isTall = step(2.5, kind);
  // Joinery: the outer frame, the two leaves meeting in the middle, glazing bars (three panes a leaf), a
  // transom light above on the taller windows, a wooden panel at the foot of a French window.
  const edge = min(min(fx, w.sub(fx)), min(fy, h.sub(fy)));
  const outer = step(edge, 0.065);
  const meeting = bar(fx.sub(w.mul(0.5)), 0.045);
  const transomY = h.sub(0.52);
  const hasTransom = step(2.2, h).mul(isDormer.oneMinus());
  const transom = bar(fy.sub(transomY), 0.04).mul(hasTransom);
  const leafTop = mix(h, transomY, hasTransom);
  const panel = step(fy, 0.36).mul(step(kind, 0.5));
  const rows = mix(float(3), float(2), isDormer);
  const paneY = fract(fy.sub(mix(0.06, 0.36, step(kind, 0.5))).div(leafTop.sub(mix(0.06, 0.36, step(kind, 0.5)))).mul(rows));
  const glazing = bar(paneY.sub(0.5).abs().sub(0.5), 0.018 * 3).mul(step(fy, leafTop)).mul(step(fy, h.sub(0.05)));
  const grille = isTall.mul(bar(fract(fx.div(0.13)).sub(0.5), 0.07));
  const frame = max(max(max(outer, meeting), max(transom, panel)), max(glazing.mul(0.85), grille));
  // Closed iron shutters (persiennes) on a few: slats every 6 cm.
  const shut = step(seed, 0.07).mul(isTall.oneMinus());
  const slats = fract(fy.div(0.06));
  // Sheer curtains on most, drapes at the sides on some.
  const sheer = step(0.35, fract(seed.mul(13.1)));
  const folds = sin(fx.mul(38).add(seed.mul(20))).mul(0.5).add(0.5);
  const drape = step(0.6, fract(seed.mul(5.7))).mul(max(step(fx, w.mul(0.2)), step(w.mul(0.8), fx)));
  const lit = step(fract(seed.mul(31.7)), 0.13);
  const roomW = w.add(1.7);
  const floorAt = mix(mix(float(-0.05), float(-0.62), step(0.5, kind)), float(-0.9), isDormer);
  const interior = room(fx.sub(w.mul(0.5)), fy.sub(floorAt), roomW, mix(float(3), float(2.5), isDormer), float(5), seed, lit);
  const curtainLight = SCENE.interiorLux.mul(3.2 / Math.PI).add(SCENE.roomLampNits.mul(lit).mul(0.5));
  const curtain = vec3(0.86, 0.84, 0.8).mul(curtainLight).mul(folds.mul(0.25).add(0.75));
  let seen: V3 = mix(interior, curtain, sheer.mul(0.78));
  seen = mix(seen, pick(floor(fract(seed.mul(3.3)).mul(DRAPES.length)), DRAPES).mul(curtainLight).mul(folds.mul(0.4).add(0.5)), drape);
  const glass = float(1).sub(frame).mul(shut.oneMinus());
  const paint = pick(floor(seed.mul(FRAME_PAINTS.length)), FRAME_PAINTS);
  const shutterPaint = vec3(...linearRgb(0x6d706c)).mul(step(0.2, slats).mul(0.3).add(0.7));
  m.colorNode = mix(mix(paint, shutterPaint, shut), vec3(0.0), glass).mul(mix(float(0.6), float(1), ao));
  m.roughnessNode = mix(float(0.45), float(0.03), glass);
  m.emissiveNode = seen.mul(glass).mul(float(1).sub(fresnel()));
  m.aoNode = ao;
  return m;
}

/** Shopfronts: fascia with lettering, pilasters, stall riser, the lit shop behind; a carriage door in the door bay. */
export function shopMaterial(): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ name: 'shopfront', metalness: 0 });
  const p = uv();
  const s = attribute('shop', 'vec4');
  const w = s.x;
  const h = s.y;
  const seed = s.z;
  const kind = s.w;
  const fx = p.x.mul(w);
  const fy = p.y.mul(h);
  const paint = pick(attribute('paint', 'float'), PAINTS);
  const isDoor = step(1.5, kind);
  const fasciaY = h.sub(0.78);
  const fascia = step(fasciaY, fy);
  const pilaster = max(step(fx, 0.14), step(w.sub(0.14), fx));
  const riser = step(fy, 0.42);
  const transom = bar(fy.sub(fasciaY.sub(0.05)), 0.05);
  // The shop door, glazed, at one side; its frame and the shop window's mullion.
  const doorLeft = step(0.5, seed);
  const doorX = mix(w.sub(1.15), float(0.14), doorLeft);
  const inDoor = step(doorX, fx).mul(step(fx, doorX.add(1.0)));
  const doorFrame = max(bar(fx.sub(doorX), 0.05), bar(fx.sub(doorX.add(1.0)), 0.05)).mul(step(fy, fasciaY));
  const mullion = bar(fx.sub(mix(doorX.sub(0.0), doorX.add(1.0), doorLeft).add(w.sub(1.15).mul(0.5).mul(mix(float(-1), float(1), doorLeft)))), 0.03).mul(step(fy, fasciaY));
  const frame = max(max(max(fascia, pilaster), max(riser.mul(inDoor.oneMinus()), transom)), max(doorFrame, mullion));
  // Lettering on the fascia: strokes on a 3 × 5 grid per glyph, gilt.
  const gx = fx.sub(w.mul(0.15)).div(0.21);
  const inText = step(0, gx).mul(step(gx, w.mul(0.7).div(0.21))).mul(step(fasciaY.add(0.22), fy)).mul(step(fy, h.sub(0.2)));
  const cell = vec2(floor(gx.mul(3)), floor(fy.sub(fasciaY.add(0.22)).div(0.072)));
  const ink = step(hash12(cell.add(seed.mul(57))), 0.5).mul(step(0.18, fract(gx))).mul(inText);
  const gilt = vec3(...linearRgb(0xc9a45a));
  // The shop inside: deep, brightly lit, shelves of goods along the back wall; a café's warmer and darker.
  const { vx, vy, vz } = roomRay();
  const depth = float(7);
  const tz = depth.div(vz);
  const hy = fy.add(vy.mul(tz));
  const hx = fx.add(vx.mul(tz));
  const floorHit = step(hy, 0);
  const tf = fy.div(max(vy.negate(), 1e-3));
  const shelves = step(0.55, fract(hy.div(0.5))).mul(step(hy, 2.2));
  const goods = vec3(hash12(vec2(floor(hx.mul(6)), floor(hy.div(0.5)))), hash12(vec2(floor(hx.mul(6)).add(7), floor(hy.div(0.5)))), hash12(vec2(floor(hx.mul(6)).add(3), 1))).mul(0.6).add(0.2);
  const backWall = mix(vec3(...linearRgb(0xe6e0d4)), goods, shelves);
  const tiles = step(0.5, fract(fx.add(vx.mul(tf)).mul(2.5)).add(fract(vz.mul(tf).mul(2.5))).fract()).mul(0.25).add(0.5);
  const cafe = step(0.5, kind).mul(isDoor.oneMinus());
  const albedo = mix(backWall, vec3(tiles), floorHit.mul(step(tf, tz)));
  const shopLight = SCENE.shopNits.mul(mix(float(1), float(0.55), cafe));
  const warm = mix(vec3(1, 0.93, 0.82), vec3(1, 0.72, 0.42), cafe);
  const interior = albedo.mul(shopLight).mul(warm).mul(float(1).div(tz.mul(0.04).add(1)));
  // The carriage door: varnished oak panels in a frame, a fanlight with an iron grille over it.
  const fan = step(h.sub(0.95), fy);
  const doorPanels = max(bar(fract(fx.div(w.mul(0.5))).sub(0.03), 0.02), bar(fract(fy.div(0.9)).sub(0.5), 0.04));
  const oak = vec3(...linearRgb(0x3b2716)).mul(vnoise2(vec2(fx.mul(2), fy.mul(40))).mul(0.4).add(0.8)).mul(doorPanels.mul(-0.35).add(1));
  const doorGlass = fan.mul(float(1).sub(bar(fract(fx.div(0.16)).sub(0.5), 0.12)));
  const glass = mix(float(1).sub(frame), doorGlass, isDoor);
  let colour: V3 = mix(paint, gilt, ink);
  colour = mix(colour, mix(oak, vec3(0.02), fan), isDoor);
  m.colorNode = mix(colour, vec3(0), glass);
  m.roughnessNode = mix(mix(float(0.42), float(0.3), ink), float(0.03), glass);
  m.metalnessNode = ink.mul(0.8).mul(isDoor.oneMinus());
  m.emissiveNode = interior.mul(glass).mul(isDoor.oneMinus()).mul(float(1).sub(fresnel())).add(vec3(0.6, 0.45, 0.3).mul(SCENE.roomLampNits).mul(doorGlass).mul(isDoor).mul(0.3));
  return m;
}
