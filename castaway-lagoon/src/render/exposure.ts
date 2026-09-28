import { float, luminance, texture, uv, vec2, vec4 } from 'three/tsl';
import { FloatType, NodeMaterial, QuadMesh, RenderTarget, type Texture, type WebGPURenderer } from 'three/webgpu';
import { LAGOON_EXPOSURE as EXPOSURE } from '../config.ts';

// Auto exposure (eye adaptation) from a luminance histogram (rules §2.2).
// Each metering frame, the HDR scene pass is reduced to a small luminance grid
// on the GPU and read back asynchronously; the CPU builds the histogram, keeps
// the 50th–95th percentile band (ignores the darkest half and the sun), and
// the eye adapts toward it: bright → dark slowly (~2 s), dark → bright fast (~0.5 s).
// The EV100 is clamped per preset so an interior never becomes day.

// Every 6th frame: the eye adapts over ~0.5–2 s, and each GPU→CPU readback costs a sync point on phones.
const METER_EVERY_FRAMES = 6;

/** How far the eye may adapt below / above the anchor EV, in stops. */
export interface EvLimits {
  belowStops: number;
  aboveStops: number;
}

const DEFAULT_LIMITS: EvLimits = { belowStops: EXPOSURE.minEvBelowAnchor, aboveStops: EXPOSURE.maxEvAboveAnchor };

export class AutoExposure {
  private readonly target: RenderTarget;
  private readonly quad: QuadMesh;
  private readonly material = new NodeMaterial();
  private source: Texture | null = null;
  private frame = 0;
  private pending = false;
  private meteredEv: number | null = null;
  /** Current adapted EV100 of the eye. */
  adaptedEv: number;

  constructor(
    private readonly renderer: WebGPURenderer,
    presetEv: number,
    private readonly limits: EvLimits = DEFAULT_LIMITS,
  ) {
    this.adaptedEv = presetEv;
    this.target = new RenderTarget(EXPOSURE.histogramWidth, EXPOSURE.histogramHeight, { type: FloatType, depthBuffer: false });
    this.quad = new QuadMesh(this.material);
  }

  reset(presetEv: number): void {
    this.adaptedEv = presetEv;
    this.meteredEv = null;
  }

  private bind(source: Texture): void {
    if (this.source === source) return;
    this.source = source;
    // Four taps per grid cell so a lone bright pixel does not swing the meter.
    const px = vec2(0.25 / EXPOSURE.histogramWidth, 0.25 / EXPOSURE.histogramHeight);
    const at = (dx: number, dy: number) => luminance(texture(source, uv().add(px.mul(vec2(dx, dy)))).rgb);
    const lum = at(-1, -1).add(at(1, -1)).add(at(-1, 1)).add(at(1, 1)).mul(0.25);
    this.material.fragmentNode = vec4(lum, float(0), float(0), float(1));
    this.material.needsUpdate = true;
  }

  /**
   * Call after the frame has rendered. `preExposure` converts the pass's
   * values back to physical luminance (cd/m²). `meterBiasEv` shifts what the
   * eye aims for (the lagoon keeps night about two stops under a grey card).
   */
  update(source: Texture | null, preExposure: number, presetEv: number, dtSeconds: number, meterBiasEv = 0): void {
    if (source && !this.pending && this.frame++ % METER_EVERY_FRAMES === 0) {
      this.bind(source);
      const prev = this.renderer.getRenderTarget();
      this.renderer.setRenderTarget(this.target);
      this.quad.render(this.renderer);
      this.renderer.setRenderTarget(prev);
      this.pending = true;
      this.renderer
        .readRenderTargetPixelsAsync(this.target, 0, 0, EXPOSURE.histogramWidth, EXPOSURE.histogramHeight)
        .then((data) => {
          this.meteredEv = meterEv(data, preExposure);
        })
        .catch((err: unknown) => {
          console.warn('exposure readback failed; holding the last value:', err);
        })
        .finally(() => {
          this.pending = false;
        });
    }
    if (this.meteredEv === null) return;
    this.adaptedEv = adaptEv(this.adaptedEv, this.meteredEv + meterBiasEv, presetEv, dtSeconds, this.limits);
  }
}

/**
 * One frame of eye adaptation toward a metered EV100, clamped per preset.
 * Brighter scenes (EV rising) adapt fast, darker ones slowly; each time
 * constant is the time to cover ~95 % of the gap (1 − e^−3).
 */
export function adaptEv(currentEv: number, meteredEv: number, presetEv: number, dtSeconds: number, limits: EvLimits = DEFAULT_LIMITS): number {
  const lo = presetEv - limits.belowStops;
  const hi = presetEv + limits.aboveStops;
  const target = Math.min(hi, Math.max(lo, meteredEv));
  const tau = target > currentEv ? EXPOSURE.adaptBrightenSeconds : EXPOSURE.adaptDarkenSeconds;
  return currentEv + (target - currentEv) * (1 - Math.exp((-3 * dtSeconds) / tau));
}

/** Histogram mean of log2 luminance within the percentile band → EV100 (K = 12.5). */
export function meterEv(data: ArrayLike<number>, preExposure: number): number {
  const values: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const l = (data[i] as number) / preExposure;
    if (Number.isFinite(l) && l > 0) values.push(Math.log2(l));
  }
  if (values.length === 0) return -4; // pitch black: open up fully, the clamp decides the limit
  values.sort((a, b) => a - b);
  const i0 = Math.floor(values.length * EXPOSURE.histogramLowPercentile);
  const i1 = Math.max(i0 + 1, Math.floor(values.length * EXPOSURE.histogramHighPercentile));
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += values[i] as number;
  const meanLog2 = sum / (i1 - i0);
  // EV100 = log2(L · S / K), S = 100.
  return meanLog2 + Math.log2(100 / EXPOSURE.meterConstantK);
}
