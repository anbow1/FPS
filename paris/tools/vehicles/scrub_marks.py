"""Paints real insignia and maker's plates out of a downloaded model's texture (the games wear invented
markings only).

    python -I scrub_marks.py in.png out.png --circle 1824,1359,78 --rect 950,1572,1042,1618 ...

(needs numpy and Pillow). Each region, in the texture's pixels, is filled from the paint around it: the
paint's slow variation is the region's surroundings blurred with the region left out (a normalised
convolution), its grain the high frequencies of the same-sized patch just beside it (`--grain-from`
dx,dy; default the patch to its left), so the patch keeps the weathering's texture instead of a smooth
spot. Only the marking's own texels are replaced when --bright is given: those brighter than the paint
around them by that much (stencils on a painted panel); otherwise the whole region.
"""
import argparse

import numpy as np
from PIL import Image, ImageFilter


def box1(a, r, axis):
    """Box mean of half-width r along one axis, the edges clamped (a cumulative sum)."""
    n = a.shape[axis]
    pad = [(0, 0)] * a.ndim
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode='edge'), axis=axis, dtype=np.float64)
    hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
    lo = np.take(c, np.arange(0, n), axis=axis)
    return ((hi - lo) / (2 * r + 1)).astype(np.float32)


def blur(a, sigma):
    """A Gaussian of about `sigma` texels: three box passes each way (Pillow blurs no float images)."""
    r = max(1, int(round(sigma * 0.87)))
    for _ in range(3):
        a = box1(box1(a, r, 0), r, 1)
    return a


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--circle', action='append', default=[], help='x,y,r')
    ap.add_argument('--rect', action='append', default=[], help='x0,y0,x1,y1')
    ap.add_argument('--bright', type=float, default=None, help='replace only texels this much brighter (0-1)')
    ap.add_argument('--grain-from', default=None, help='dx,dy of the patch lending its grain')
    ap.add_argument('--grain-patch', default=None, help='x0,y0,x1,y1 of a clean patch of paint, tiled for the grain')
    a = ap.parse_args()
    im = Image.open(a.src)
    mode = im.mode
    px = np.asarray(im.convert('RGBA')).astype(np.float32) / 255
    rgb = px[..., :3]
    h, w = rgb.shape[:2]
    yy, xx = np.mgrid[0:h, 0:w]
    region = np.zeros((h, w), bool)
    boxes = []
    for c in a.circle:
        x, y, r = (float(v) for v in c.split(','))
        region |= (xx - x) ** 2 + (yy - y) ** 2 <= r * r
        boxes.append((x - r, y - r, x + r, y + r))
    for c in a.rect:
        x0, y0, x1, y1 = (float(v) for v in c.split(','))
        region |= (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
        boxes.append((x0, y0, x1, y1))
    luma = rgb @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    # Seams, rust streaks and window texels around a marking are not its paint: the slow variation is
    # taken from the texels within a quarter of the surroundings' median luminance only.
    ring = np.zeros((h, w), bool)
    for (x0, y0, x1, y1) in boxes:
        g = max(x1 - x0, y1 - y0) * 0.4
        ring[max(0, int(y0 - g)):int(y1 + g) + 1, max(0, int(x0 - g)):int(x1 + g) + 1] = True
    ring &= ~region
    med = float(np.median(luma[ring]))
    keep = (~region & (np.abs(luma - med) < 0.25 * med)).astype(np.float32)
    # The paint's slow variation, from the texels outside the regions only.
    radius = max(max(b[2] - b[0], b[3] - b[1]) for b in boxes) * 0.35
    low = blur(rgb * keep[..., None], radius) / np.maximum(blur(keep[..., None], radius), 1e-4)
    mask = region.copy()
    if a.bright is not None:
        around = low @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        mask &= luma > around + a.bright
        # Grow by a few texels to take the stencil's soft edge too.
        mask = np.asarray(Image.fromarray(mask.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(7))) > 0
        mask &= region
    out = rgb.copy()
    fine = rgb - blur(rgb, 4)
    for (x0, y0, x1, y1) in boxes:
        bw, bh = x1 - x0, y1 - y0
        sl = (slice(max(0, int(y0)), min(h, int(y1) + 1)), slice(max(0, int(x0)), min(w, int(x1) + 1)))
        ph, pw = sl[0].stop - sl[0].start, sl[1].stop - sl[1].start
        if a.grain_patch:
            # A clean patch, mirrored and tiled over the region (no seam where the tiles meet).
            gx0, gy0, gx1, gy1 = (int(v) for v in a.grain_patch.split(','))
            tile = fine[gy0:gy1, gx0:gx1]
            tile = np.concatenate([tile, tile[::-1]], 0)
            tile = np.concatenate([tile, tile[:, ::-1]], 1)
            grain = np.tile(tile, (ph // tile.shape[0] + 1, pw // tile.shape[1] + 1, 1))[:ph, :pw]
        else:
            dx, dy = (int(v) for v in a.grain_from.split(',')) if a.grain_from else (-int(bw * 1.1), 0)
            grain = fine[sl[0].start + dy:sl[0].stop + dy, sl[1].start + dx:sl[1].stop + dx]
        m = mask[sl]
        out[sl][m] = np.clip(low[sl][m] + grain[m], 0, 1)
    px[..., :3] = out
    Image.fromarray((px * 255 + 0.5).astype(np.uint8), 'RGBA').convert(mode).save(a.dst)
    print(f'{a.dst}: {int(mask.sum())} texels repainted')


if __name__ == '__main__':
    main()
