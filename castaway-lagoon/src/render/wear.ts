import { float, max, mix, mx_noise_float, smoothstep, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';

// Paint on a machine left on a tropical beach, after the expedition jeep and
// the skiff in an island shooter we compared against (playbook §6n): what
// makes them read as real is the wear, not the shape — rust blooming from the
// lowest edges and the wheel arches, paint chipped to grey primer and bright
// metal in small flakes, dirt run down the sides by the rain, salt bleaching
// the tops. One function for every painted vehicle, in its own frame (y up,
// metres), so each wears in place and nothing slides as it moves.

type F = Node<'float'>;
type V3 = Node<'vec3'>;

export interface Wear {
  colour: V3;
  roughness: F;
  metalness: F;
}

export interface WearOptions {
  /** Height (m, the model's frame) below which rust and splash dirt gather. */
  lowY: number;
  /** 0…1: how far gone the machine is. */
  amount: number;
  /** What blooms low down (dark, light): rust on steel by default; grey-green scum on an aluminium hull. */
  bloom?: [[number, number, number], [number, number, number]];
}

/** `p` is the position in the model's own frame; `paint` its clean paint colour and roughness. */
export function paintWear(pos: V3, paint: V3, paintRough: number, o: WearOptions): Wear {
  const low = smoothstep(o.lowY + 0.45, o.lowY - 0.1, pos.y);
  // Rust: broad blooms where water stands (low down), with a ragged edge from finer noise.
  const bloom = mx_noise_float(pos.mul(3.1)).mul(0.6).add(mx_noise_float(pos.mul(11.7)).mul(0.4));
  const rust = smoothstep(0.55, 0.75, bloom.add(low.mul(0.45)).add(o.amount * 0.15 - 0.15));
  const [dark, light] = o.bloom ?? [
    [0.16, 0.06, 0.025],
    [0.3, 0.12, 0.045],
  ];
  const rustCol = mix(vec3(...dark), vec3(...light), mx_noise_float(pos.mul(23)).mul(0.5).add(0.5));
  // Chips: small flakes through to grey primer, a few to bright metal at their centres.
  const flake = mx_noise_float(pos.mul(41));
  const chip = smoothstep(0.62, 0.68, flake.add(mx_noise_float(pos.mul(5.3)).mul(0.25))).mul(o.amount);
  const bare = smoothstep(0.74, 0.8, flake).mul(chip);
  // Rain-run dirt: streaks long in y, darker toward the bottom.
  const streak = smoothstep(0.35, 0.8, mx_noise_float(vec3(pos.x.mul(9), pos.y.mul(0.9), pos.z.mul(9)))).mul(0.25).add(low.mul(0.15));
  let colour: V3 = paint.mul(float(1).sub(streak));
  colour = mix(colour, vec3(0.33, 0.33, 0.31), chip.mul(float(1).sub(bare)));
  colour = mix(colour, vec3(0.5, 0.5, 0.48), bare);
  colour = mix(colour, rustCol, rust);
  const roughness = mix(mix(float(paintRough), float(0.62), chip), float(0.92), rust);
  const metalness = max(bare.mul(0.9), float(0)).mul(float(1).sub(rust));
  return { colour, roughness, metalness };
}
