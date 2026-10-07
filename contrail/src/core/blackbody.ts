// Colour of thermal emission (afterburner flame, later tracer and flare glow).

/**
 * Linear-sRGB colour of a black body at `kelvin`, normalised to luminance 1 (Tanner Helland's fit of
 * the CIE 1964 data, linearised). Good to a few per cent between 1000 and 12000 K.
 */
export function blackbody(kelvin: number): [number, number, number] {
  const t = kelvin / 100;
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (c: number): number => {
    const v = Math.min(255, Math.max(0, c)) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const out: [number, number, number] = [lin(r), lin(g), lin(b)];
  const y = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
  return [out[0] / y, out[1] / y, out[2] / y];
}
