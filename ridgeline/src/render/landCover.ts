import { abs, cameraPosition, cos, dot, length, float, floor, fract, hash, max, min, mix, mx_noise_float, sin, smoothstep, step, vec2, vec3, vec4 } from 'three/tsl';
import { Color, type Node } from 'three/webgpu';

// What covers the land at a point, as the terrain shader paints it from the
// air and as the grass field (grassField.ts) grows it up close: one function,
// evaluated per fragment by the terrain and per blade by the grass, so the
// blades stand where the ground is a meadow, take the colour of the field they
// grow in, and stop at the edge of a ploughed strip or a track.
//
// Look: seen from a helicopter at tens of metres — meadows, pastures and hay
// fields in small irregular plots with hedgerows on the valley floors, rough
// grass and heath on the slopes, the forest belt, rock on the steepest ground,
// the river.

type F = Node<'float'>;
type V3 = Node<'vec3'>;

function lin(hex: number): V3 {
  const c = new Color(hex);
  return vec3(c.r, c.g, c.b);
}

export interface LandSurface {
  /** Albedo as seen from the air (linear), before the close-range texture. */
  albedo: V3;
  /** Close-range texture layer weights: meadow, soil, rock, litter (sum 1 on land). */
  layers: Node<'vec4'>;
  /** Grass blades: tall meadow, short dry sward (hay stubble, heath), sedge at the water, canopy shade. */
  grass: Node<'vec4'>;
  water: F;
  rock: F;
  snow: F;
  /** Valley floor (farmland) 1, slopes and heights (heath) 0. */
  lowland: F;
  /** Forest cover 0…1 (the canopy colour from the air). */
  forest: F;
  /** Worn bare patches in the grass (0…1), soil in their own colour. */
  bare: F;
  /** 0…1 low-frequency brightness (for the roughness and the far tone). */
  macro: F;
}

/**
 * `P` world position (y = height), `nrm` the baked world normal, `cov` the cover map (forest, rock, snow,
 * water/river). Pure ALU besides the inputs, so it runs in either stage.
 */
export function landSurface(P: V3, nrm: V3, cov: Node<'vec4'>): LandSurface {
  const forest = cov.r;
  const rock = cov.g;
  const snow = cov.b;
  const water = smoothstep(0.35, 0.65, cov.a);
  const macro = mx_noise_float(P.xz.div(1400)).mul(0.5).add(0.5);
  const dist = length(P.sub(cameraPosition));
  const fine = mx_noise_float(P.xz.div(5)).mul(0.5).add(0.5).mul(0.6).add(mx_noise_float(P.xz.div(1.3)).mul(0.2).add(0.2));

  // Farmland as seen from the air: blocks of fields whose grid turns from one district (~6 km) to
  // the next, each block cut into one to four strips of its own crop, desaturated sheet colours with
  // per-field brightness and in-field moisture patches, hedgerows, the odd farm track along a block
  // edge, and small villages of roofs and gardens.
  const district = floor(P.xz.div(1500));
  const dId = hash(district.x.mul(3.17).add(district.y.mul(11.3)));
  const angle = dId.mul(1.4).sub(0.7);
  const ca = cos(angle);
  const sa = sin(angle);
  const r = vec2(P.x.mul(ca).sub(P.z.mul(sa)), P.x.mul(sa).add(P.z.mul(ca)));
  const fieldSize = vec2(mix(float(80), float(160), dId), mix(float(110), float(230), hash(dId.mul(9.1))));
  const row = floor(r.y.div(fieldSize.y));
  const q = vec2(r.x.div(fieldSize.x).add(hash(row.mul(13.7).add(dId)).mul(0.9)), r.y.div(fieldSize.y));
  const cell = floor(q);
  const blockId = hash(cell.x.mul(7.31).add(cell.y.mul(157.7)).add(dId.mul(41)));
  const f0 = fract(q);
  // Strips across the block.
  const strips = floor(blockId.mul(4)).add(1);
  const stripCoord = f0.x.mul(strips);
  const stripIdx = floor(stripCoord);
  const id = hash(blockId.mul(91.7).add(stripIdx.mul(3.3)));
  // Mostly grass: meadow, pasture, fresh-cut hay; a few ploughed and dry plots.
  const ploughed = smoothstep(0.7, 0.74, id).mul(float(1).sub(smoothstep(0.88, 0.92, id))).mul(smoothstep(0.5, 0.54, id));
  const hay = smoothstep(0.88, 0.92, id).mul(smoothstep(0.5, 0.54, id));
  const crop = mix(
    mix(lin(0x56693a), lin(0x46602c), smoothstep(0.25, 0.3, id)),
    mix(mix(lin(0x6f8045), lin(0x6b5a47), smoothstep(0.7, 0.74, id)), lin(0x958d5c), smoothstep(0.88, 0.92, id)),
    smoothstep(0.5, 0.54, id),
  );
  // Satellite colour is greyer than the swatches: pull a quarter of the way to luminance, vary per field.
  const cropGrey = vec3(dot(crop, vec3(0.2126, 0.7152, 0.0722)));
  const moisture = mx_noise_float(P.xz.div(55).add(id.mul(30))).mul(0.5).add(0.5);
  // Mown meadows show the mower's passes from the air: bands a swath wide, alternately lighter and
  // darker as the cut grass lies towards or away from the eye (here simply alternate, along the strip).
  const swath = step(0.5, fract(r.x.div(2.6))).mul(2).sub(1).mul(step(0.25, id)).mul(step(id, 0.5)).mul(step(0.5, hash(id.mul(17.3))));
  const field = mix(crop, cropGrey, 0.12)
    .mul(float(0.82).add(hash(id.mul(5.1)).mul(0.36)))
    .mul(float(0.88).add(moisture.mul(0.24)))
    // (faded out before the stripes fall under a pixel and alias: this is noise, not a texture with mips)
    .mul(swath.mul(float(0.05).mul(float(1).sub(smoothstep(900, 2500, dist)))).add(1));
  const edgeX = min(fract(stripCoord), float(1).sub(fract(stripCoord))).mul(fieldSize.x).div(strips);
  const edgeY = min(f0.y, float(1).sub(f0.y)).mul(fieldSize.y);
  const blockEdge = min(min(f0.x, float(1).sub(f0.x)).mul(fieldSize.x), edgeY);
  const hedge = float(1).sub(smoothstep(3, 7, blockEdge)).mul(step(0.35, hash(cell.x.add(cell.y.mul(5.3)))));
  const furrow = float(1).sub(smoothstep(0.6, 1.6, edgeX)).mul(0.5);
  // A farm track along some block rows.
  const track = float(1).sub(smoothstep(2, 4, edgeY)).mul(step(hash(row.mul(2.9).add(dId)), 0.25));
  // Crop rows: faint stripes along each strip (plough furrows show stronger).
  const rowWave = abs(fract(r.x.div(6).add(id.mul(3))).sub(0.5));
  const rows = rowWave.mul(mix(float(0.08), float(0.3), ploughed)).add(mix(float(0.96), float(0.85), ploughed));
  let farm: V3 = mix(field.mul(rows), lin(0x34472a), max(hedge.mul(0.8), furrow.mul(0.3)));
  // Tracks: two wheel ruts of bare earth and gravel with grass up the middle, not a white line.
  farm = mix(farm, lin(0x857a68), track.mul(0.55));
  // Villages: a few hundred metres of roofs, gardens and lanes where a coarse noise peaks.
  const villageN = mx_noise_float(P.xz.div(2600).add(vec2(31, 7)));
  const village = smoothstep(0.55, 0.62, villageN);
  const plot = floor(P.xz.div(22));
  const plotId = hash(plot.x.mul(1.7).add(plot.y.mul(37.1)));
  const roof = mix(lin(0x8a4a38), lin(0x6e6a66), step(0.55, plotId));
  const garden = float(1).sub(step(0.62, plotId));
  const built = mix(mix(lin(0x55663c), roof, step(0.62, plotId)), lin(0x8d8a84), step(0.9, plotId));
  const farmland = mix(farm, built, village);
  const lowland = float(1).sub(smoothstep(380, 520, P.y)).mul(smoothstep(0.93, 0.98, nrm.y));
  // Heath: rough grass in two tones, patches of heather and dead bracken tens of metres across, and
  // scattered gorse and juniper bushes (dark dots a few metres wide, faded out before they alias).
  const heather = smoothstep(0.55, 0.78, mx_noise_float(P.xz.div(45).add(vec2(11, 5))).mul(0.5).add(0.5));
  const bushes = smoothstep(0.72, 0.86, mx_noise_float(P.xz.div(7).add(vec2(2, 13))).mul(0.5).add(0.5)).mul(float(1).sub(smoothstep(700, 1800, dist)));
  let heath: V3 = mix(mix(lin(0x5d6a3a), lin(0x6d6c46), macro), lin(0x4f5a34), fine.mul(0.5));
  heath = mix(heath, mix(lin(0x5e4c44), lin(0x7a5a3a), macro), heather.mul(0.55));
  heath = mix(heath, lin(0x2c3820), bushes.mul(0.7));
  let albedo: V3 = mix(heath, farmland, lowland);
  // Forest canopy: dark greens with crown-scale variation.
  const canopy = mix(lin(0x2a3820), lin(0x3c4a2a), mx_noise_float(P.xz.div(60)).mul(0.5).add(0.5));
  const forestK = smoothstep(0.3, 0.6, forest);
  albedo = mix(albedo, canopy, forestK);
  // Rock: strata — bands that follow the height, bent by noise as folded beds are — in two greys and
  // a warm iron stain, cut by darker cracks across them.
  const bend = mx_noise_float(P.xz.div(900)).mul(60).add(mx_noise_float(P.xz.div(140)).mul(12));
  // Bed thickness varies too (the height scale is itself bent by noise), so the bands never repeat evenly.
  const bed = fract(P.y.add(bend).div(mx_noise_float(P.xz.div(700)).mul(7).add(19)));
  const beds = smoothstep(0.1, 0.45, bed).mul(float(1).sub(smoothstep(0.7, 0.98, bed))).mul(0.6).add(mx_noise_float(P.xz.div(55)).mul(0.25));
  const stain = smoothstep(0.35, 0.75, mx_noise_float(P.xz.div(320).add(vec2(5, 9))));
  // Beds show only on steep faces: on a gentle slope bands of constant height become contour rings
  // (and in patches: whole outcrops, not every slope).
  const cliff = smoothstep(0.62, 0.45, nrm.y).mul(smoothstep(0.0, 0.3, mx_noise_float(P.xz.div(1100).add(vec2(13, 4)))));
  const tone = mx_noise_float(P.xz.div(180)).mul(0.5).add(0.5);
  let rockColour: V3 = mix(lin(0x5e5a55), lin(0x8a857d), mix(tone, beds, cliff));
  rockColour = mix(rockColour, lin(0x7a6450), stain.mul(0.45));
  const crack = smoothstep(0.82, 0.95, abs(mx_noise_float(vec2(P.x.add(P.z).div(38), P.y.div(9)))));
  rockColour = rockColour.mul(float(1).sub(crack.mul(0.35).mul(cliff)));
  // Exposed rock also where the slope is steep, not only where the baked cover says so.
  const steep = smoothstep(0.82, 0.62, nrm.y).mul(float(1).sub(water));
  const rockMask = max(rock, steep.mul(0.85));
  albedo = mix(albedo, rockColour, rockMask);
  // Snow settles on the flatter ground and slides off the steep faces, whatever the cover map says.
  const snowHere = snow.mul(smoothstep(0.55, 0.78, nrm.y));
  albedo = mix(albedo, lin(0xe8edf2), snowHere);
  albedo = albedo.mul(float(0.85).add(macro.mul(0.3))).mul(float(0.9).add(fine.mul(0.2)));

  // Close-range layers. Bare soil: ploughed strips, tracks, lanes and yards in the villages, and worn
  // patches on the heath; litter under the trees and in tufts through the heath; rock as above.
  const villageSoil = village.mul(float(1).sub(garden)).mul(0.8);
  // Worn spots in the pastures and on the heath: gateways, molehills, where the stock stands.
  const bare = smoothstep(0.8, 0.93, mx_noise_float(P.xz.div(3.3).add(vec2(7, 3))).mul(0.5).add(0.5)).mul(smoothstep(0.3, 0.6, mx_noise_float(P.xz.div(40).add(vec2(1, 9))).mul(0.5).add(0.5)));
  const soil = max(max(max(ploughed, track.mul(0.85)), villageSoil).mul(lowland), bare.mul(0.75)).add(float(1).sub(lowland).mul(smoothstep(0.62, 0.8, fine)).mul(0.5)).clamp(0, 1);
  const heathLitter = float(1).sub(lowland).mul(smoothstep(0.35, 0.7, mx_noise_float(P.xz.div(23).add(vec2(3, 1))).mul(0.5).add(0.5))).mul(0.45);
  const open = vec4(float(1).sub(soil).sub(heathLitter).max(0), soil, 0, heathLitter);
  const layers = mix(mix(open, vec4(0, 0, 0, 1), forestK), vec4(0, 0, 1, 0), rockMask);

  // Blades: tall sward on the meadows and pastures, short and dry on hay stubble and the heath, sedge
  // where the river's cover begins, thin under the canopy; none on soil, rock, snow or water.
  const sward = float(1).sub(soil).mul(float(1).sub(rockMask)).mul(float(1).sub(snowHere)).mul(float(1).sub(water)).mul(float(1).sub(hedge.mul(0.5)));
  const lowlandGrass = lowland.mul(float(1).sub(hay)).mul(float(1).sub(village.mul(garden.oneMinus())));
  const meadowW = sward.mul(lowlandGrass).mul(float(1).sub(forestK.mul(0.75)));
  const shortW = sward.mul(max(lowland.mul(hay), float(1).sub(lowland).mul(float(1).sub(heathLitter)))).mul(float(1).sub(forestK.mul(0.85)));
  const sedge = smoothstep(0.08, 0.3, cov.a).mul(float(1).sub(water)).mul(float(1).sub(rockMask));
  const grass = vec4(meadowW, shortW, sedge, forestK);

  return { albedo, layers, grass, water, rock: rockMask, snow: snowHere, lowland, forest: forestK, bare, macro };
}
