"""Gives the first-person hand (src/assets/hand/hand.bin) the MakeHuman base mesh's own UVs, so the
photographed MakeHuman skins (CC0) can dress it.

    python -I tools/hand_skin_uv.py <mpfb data dir> src/assets/hand

(needs numpy). hand.bin was cut from that base mesh, moved into the viewmodel's hand frame, its forearm
stretched to 27 cm and smoothed once. Here the base mesh is brought into the same frame by the joints both
carry (the similarity that best maps the default rig's finger and metacarpal joints onto hand.json's), the
hand's forearm is pressed back to the base mesh's length, and each of its vertices takes the UV of the
closest point on the base mesh's skin there. Writes hand_skinuv.bin: u16 u, v per vertex, in hand.bin's order.
"""
import json
import struct
import sys

import numpy as np


def load_obj(path):
    vs, vts, faces = [], [], []
    cubes = {}
    group = ''
    for line in open(path):
        if line.startswith('g '):
            group = line.split()[1]
        elif line.startswith('f ') and group.startswith('joint-'):
            cubes.setdefault(group, set()).update(int(c.split('/')[0]) - 1 for c in line.split()[1:])
        elif line.startswith('v '):
            vs.append([float(t) for t in line.split()[1:4]])
        elif line.startswith('vt '):
            vts.append([float(t) for t in line.split()[1:3]])
        elif line.startswith('f ') and group == 'body':
            # The skin only: not the clothes' helper surfaces nor the joints' marker cubes.
            corners = [c.split('/') for c in line.split()[1:]]
            vi = [int(c[0]) - 1 for c in corners]
            ti = [int(c[1]) - 1 if len(c) > 1 and c[1] else -1 for c in corners]
            for k in range(1, len(vi) - 1):
                faces.append((vi[0], vi[k], vi[k + 1], ti[0], ti[k], ti[k + 1]))
    vs = np.array(vs)
    return vs, np.array(vts), np.array(faces), {g: vs[sorted(ix)].mean(0) for g, ix in cubes.items()}


def umeyama(src, dst):
    """Scale s, rotation R, translation t with dst ≈ s R src + t (least squares)."""
    ms, md = src.mean(0), dst.mean(0)
    a, b = src - ms, dst - md
    u, d, vt = np.linalg.svd(b.T @ a / len(src))
    e = np.eye(3)
    if np.linalg.det(u) * np.linalg.det(vt) < 0:
        e[2, 2] = -1
    r = u @ e @ vt
    s = np.trace(np.diag(d) @ e) / (a ** 2).sum(1).mean()
    return s, r, md - s * r @ ms


def closest_on_triangles(p, a, b, c):
    """Closest point on each triangle to p (Ericson's method, vectorised); returns barycentrics and distance²."""
    ab, ac, ap = b - a, c - a, p - a
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = p - b
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = p - c
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    va = d3 * d6 - d5 * d4
    vb = d5 * d2 - d1 * d6
    vc = d1 * d4 - d3 * d2
    den = np.where(np.abs(va + vb + vc) < 1e-12, 1e-12, va + vb + vc)
    v = vb / den
    w = vc / den
    v = np.clip(v, 0, 1)
    w = np.clip(w, 0, 1)
    over = v + w > 1
    v = np.where(over, v / np.maximum(v + w, 1e-12), v)
    w = np.where(over, 1 - v, w)
    q = a + ab * v[:, None] + ac * w[:, None]
    return np.stack([1 - v - w, v, w], 1), ((q - p) ** 2).sum(1)


def main():
    data, out = sys.argv[1], sys.argv[2]
    rig = json.load(open(f'{data}/rigs/standard/rig.default.json'))
    hand = json.load(open(f'{out}/hand.json'))
    names = [b['name'] for b in hand['bones'] if b['name'] not in ('forearm', 'hand')]
    vs, vts, faces, cubes = load_obj(f'{data}/3dobjs/base.obj')

    # The joints on the base mesh itself, as the rig places them (the rig's default positions are for a
    # shaped default human, not the neutral base mesh the hand was cut from).
    def joint(spec):
        if spec.get('strategy') == 'CUBE':
            return cubes[spec['cube_name']]
        if 'vertex_indices' in spec:
            return vs[spec['vertex_indices']].mean(0)
        return vs[spec['vertex_index']]

    src = np.array([joint(rig[n][k]) for n in names for k in ('head', 'tail')])
    dst = np.array([b[k] for b in hand['bones'] if b['name'] in names for k in ('head', 'tail')])
    s, r, t = umeyama(src, dst)
    err = np.linalg.norm((s * (r @ src.T)).T + t - dst, axis=1)
    print(f'joints fitted: scale {s:.4f}, rms {np.sqrt((err ** 2).mean()) * 1000:.1f} mm, max {err.max() * 1000:.1f} mm')
    v_hand = (s * (r @ vs.T)).T + t
    elbow = (s * (r @ joint(rig['lowerarm01.R']['head']))) + t
    base_len = float(np.linalg.norm(elbow))
    axis = np.array(hand['forearmAxis'], float)
    axis /= np.linalg.norm(axis)
    fore = hand['bones'][0]
    game_len = float(np.linalg.norm(np.array(fore['tail'])))
    print(f'forearm: base {base_len * 100:.1f} cm, game {game_len * 100:.1f} cm')

    buf = open(f'{out}/hand.bin', 'rb').read()
    n = struct.unpack_from('<I', buf, 4)[0]
    pos = np.frombuffer(buf, '<f4', n * 3, 16).reshape(n, 3).astype(np.float64)
    along = pos @ axis
    press = np.where(along > 0, along * (base_len / game_len - 1), 0)
    pos_base = pos + axis[None, :] * press[:, None]

    # Triangles of the base mesh near the hand and forearm (skin only: those with UVs).
    tri = faces[(faces[:, 3:] >= 0).all(1)]
    a, b, c = v_hand[tri[:, 0]], v_hand[tri[:, 1]], v_hand[tri[:, 2]]
    centre = (a + b + c) / 3
    lo, hi = pos_base.min(0) - 0.03, pos_base.max(0) + 0.03
    keep = ((centre > lo) & (centre < hi)).all(1)
    tri, a, b, c, centre = tri[keep], a[keep], b[keep], c[keep], centre[keep]
    print(f'{len(tri)} base triangles round the hand')
    uv = np.zeros((n, 2))
    dist = np.zeros(n)
    for i in range(n):
        p = pos_base[i]
        near = np.argsort(((centre - p) ** 2).sum(1))[:40]
        bary, d2 = closest_on_triangles(p, a[near], b[near], c[near])
        k = int(np.argmin(d2))
        f = tri[near[k]]
        uv[i] = bary[k] @ vts[f[3:6]]
        dist[i] = np.sqrt(d2[k])
    print(f'{n} hand vertices off the base skin: median {np.median(dist) * 1000:.1f} mm, '
          f'95 % within {np.percentile(dist, 95) * 1000:.1f} mm, worst {dist.max() * 1000:.1f} mm')
    q = np.clip(np.round(uv * 65535), 0, 65535).astype('<u2')
    open(f'{out}/hand_skinuv.bin', 'wb').write(q.tobytes())
    print('uv range', uv.min(0).round(3), uv.max(0).round(3))


if __name__ == '__main__':
    main()
