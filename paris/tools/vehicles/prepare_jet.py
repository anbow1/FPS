"""Turns a downloaded fighter model into Contrail's parts.

    python -I prepare_jet.py -- scene.gltf --out out/jet_wraith --length 15.7 --forward=-y --preview

(or blender -b --python prepare_jet.py -- ...). The model is oriented (metres, Y up, nose toward -Z,
standing on its wheels on y = 0), split into its loose pieces, and those sorted geometrically:

  stab_L/R      the all-moving tailplanes: flat pieces aft, outboard of the booms;
  flaperon_L/R  the wing's trailing-edge surfaces: flat pieces behind the wing box, mid-span;
  rudder_L/R    the fins' trailing-edge surfaces: tall thin pieces at the fins' trailing edges;
  glass         the canopy (its own material, the one on top of the forward fuselage);
  body          the rest, less the landing gear (the game draws its own retractable gear) and the
                squadron's badges on the fins (no real insignia in the games).

Each moving surface is written about the inboard (or lower) end of its hinge line, with the line's other
end in <out>.json, together with the nozzle exit, the wingtips, the pilot's eye, the belly under each
gear leg, the size and the colour textures' mean albedo. The hinge line of a flaperon or rudder runs along
its leading edge; a tailplane pivots about the span at 30 % of its root chord.
"""
import argparse
import json
import os
import sys

import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import prepare_vehicle as pv  # noqa: E402
import prepare_tank as pt  # noqa: E402


def args_of():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('--out', required=True)
    ap.add_argument('--length', type=float, required=True)
    ap.add_argument('--forward', default='-y')
    ap.add_argument('--up', default='z')
    ap.add_argument('--triangles', type=int, default=90000)
    ap.add_argument('--tex', type=int, default=2048)
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--cpu', action='store_true')
    return ap.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])


def box(p):
    lo, hi = pv.bounds([p])
    return lo, hi, (lo + hi) / 2, hi - lo


def mat_name(p):
    return (p.data.materials[0].name if p.data.materials else '').lower()


def world_verts(p):
    return [v.co.copy() for v in p.data.vertices]


def edge_line(pieces, along, lead):
    """The leading edge of a control surface as a hinge line: at each end of its extent `along` ('x' span
    or 'y' height), the point furthest forward (least z)."""
    verts = [v for p in pieces for v in world_verts(p)]
    lo = min(getattr(v, along) for v in verts)
    hi = max(getattr(v, along) for v in verts)
    span = hi - lo
    ends = []
    for target in (lo, hi):
        near = [v for v in verts if abs(getattr(v, along) - target) < 0.06 * span]
        ends.append(min(near, key=lambda v: v.z).copy())
    return ends


def main():
    a = args_of()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    print('Cycles device:', pv.use_gpu(a.cpu))
    pv.import_model(a.model)
    pv.flatten_hierarchy()
    pv.orient_and_scale(a.forward, a.up, a.length)
    parts = []
    for o in list(pv.meshes()):
        parts += pv.split_loose(o)
    print(f'{len(parts)} pieces; {pv.outward_normals(parts)} faced inward, turned')
    lo, hi = pv.bounds(parts)
    size = hi - lo

    # The landing gear: the wheels are the pieces touching the ground; around each, everything hanging below
    # the belly (struts, wheels, the open doors) goes. The game retracts its own.
    ground = [p for p in parts if box(p)[0].y < 0.03 * size.y]
    legs = []
    for p in ground:
        c = box(p)[2]
        for leg in legs:
            if abs(leg['x'] - c.x) < 0.5 and abs(leg['z'] - c.z) < 0.8:
                leg['pieces'].append(p)
                break
        else:
            legs.append({'x': c.x, 'z': c.z, 'pieces': [p]})
    gear = set()
    bellies = []
    for leg in legs:
        glo, ghi = pv.bounds(leg['pieces'])
        lx, lz = (glo.x + ghi.x) / 2, (glo.z + ghi.z) / 2
        # The belly: the lowest underside of the big skin pieces over the leg.
        skin = [p for p in parts if box(p)[3].z > 1.5 and box(p)[0].x - 0.05 < lx < box(p)[1].x + 0.05 and box(p)[0].z < lz < box(p)[1].z and box(p)[0].y > 0.4]
        belly = min((box(p)[0].y for p in skin), default=0.5 * size.y)
        bellies.append({'x': round(lx, 3), 'z': round(lz, 3), 'belly': round(belly, 3)})
        for p in parts:
            l, h, c, d = box(p)
            if abs(c.x - lx) < 0.6 and abs(c.z - lz) < 1.1 and c.y < belly - 0.03:
                gear.add(p)
    # Badges on the fins: the palette-coloured decorations standing on their outer faces.
    fin_zone = lambda c: 0.1 * size.x < abs(c.x) < 0.25 * size.x and c.y > 0.65 * size.y and 0.28 * size.z < c.z
    badges = {p for p in parts if 'palette' in mat_name(p) and fin_zone(box(p)[2])}
    for p in gear | badges:
        parts.remove(p)
        bpy.data.objects.remove(p)
    print(f'gear legs {len(legs)} ({len(gear)} pieces), fin badges {len(badges)} removed')

    def flat(p):
        return box(p)[3].y < 0.18 * max(box(p)[3].x, box(p)[3].z)

    # Everything aft of this is tail: the tailplanes and rudders (the flaperons end ahead of it).
    tail_z = lo.z + 0.78 * size.z
    # Tailplanes: flat, aft, wholly outboard of the booms (their root rib is the inboard edge).
    stabs = {s: [p for p in parts if box(p)[2].x * s > 0 and box(p)[2].z > tail_z and flat(p)
                 and 0.11 * size.y < box(p)[2].y < 0.62 * size.y and min(abs(box(p)[0].x), abs(box(p)[1].x)) > 0.09 * size.x]
             for s in (1, -1)}
    # Flaperons: flat, well outboard, short in chord but long in span, ahead of the tail.
    flaps = {s: [p for p in parts if box(p)[2].x * s > 0.25 * size.x and box(p)[2].z < tail_z and flat(p)
                 and box(p)[3].z < 0.13 * size.z and box(p)[3].x > 0.2 * size.x]
             for s in (1, -1)}
    # Rudders: tall, short in chord, high on the fins, at the tail.
    rudders = {s: [p for p in parts if box(p)[2].x * s > 0.1 * size.x and box(p)[2].y > 0.6 * size.y and box(p)[3].y > 0.25 * size.y
                   and box(p)[3].z < 0.12 * size.z and box(p)[2].z > tail_z]
               for s in (1, -1)}
    for name, groups in (('stab', stabs), ('flaperon', flaps), ('rudder', rudders)):
        print(name, {('L' if s < 0 else 'R'): len(g) for s, g in groups.items()})

    hinge_info = []
    moving = []
    for name, groups in (('stab', stabs), ('flaperon', flaps), ('rudder', rudders)):
        for s, ps in groups.items():
            if not ps:
                continue
            tag = f'{name}_{"L" if s < 0 else "R"}'
            if name == 'stab':
                l, h = pv.bounds(ps)
                root_x = l.x if s > 0 else h.x
                root = [v for p in ps for v in world_verts(p) if abs(v.x - root_x) < 0.05]
                zl, zh = min(v.z for v in root), max(v.z for v in root)
                yc = sum(v.y for v in root) / len(root)
                a_pt = Vector((root_x, yc, zl + 0.3 * (zh - zl)))
                b_pt = a_pt + Vector((s * 1.0, 0, 0))
            else:
                a_pt, b_pt = edge_line(ps, 'x' if name == 'flaperon' else 'y', True)
                if (name == 'flaperon' and abs(a_pt.x) > abs(b_pt.x)) or (name == 'rudder' and a_pt.y > b_pt.y):
                    a_pt, b_pt = b_pt, a_pt
            ob = pv.join(ps, tag)
            moving.append((ob, a_pt))
            hinge_info.append({'name': tag, 'kind': name, 'side': s, 'a': [round(v, 4) for v in a_pt], 'b': [round(v, 4) for v in b_pt]})
            for p in ps:
                if p in parts:
                    parts.remove(p)

    glass = [p for p in parts if 'palettematerial002' in mat_name(p)]
    body = [p for p in parts if p not in glass]
    glass_ob = pv.join(glass, 'glass') if glass else None
    body_ob = pv.join(body, 'body')
    obs = [o for o in (body_ob, glass_ob) if o] + [o for o, _ in moving]
    tris = [sum(len(f.vertices) - 2 for f in o.data.polygons) for o in obs]
    total = sum(tris)
    if total > a.triangles:
        pv.decimate(body_ob, max(5000, tris[0] - (total - a.triangles)))
    pv.downscale_textures(a.tex)
    albedo = pt.mean_albedo(obs)
    pv.ray_ao(obs)
    if a.preview:
        preview(obs, a.out + '_preview.png')

    # The nozzle exit: the rearmost ring of the body near the centre line.
    bverts = [v for v in world_verts(body_ob) if abs(v.x) < 0.9]
    zmax = max(v.z for v in bverts)
    ring = [v for v in bverts if v.z > zmax - 0.15]
    nozzle = [0.0, round(sum(v.y for v in ring) / len(ring), 3), round(zmax, 3)]
    allv = [v for o in obs for v in world_verts(o)]
    tip = max(allv, key=lambda v: v.x)
    eye = None
    if glass_ob:
        gl, gh = pv.bounds([glass_ob])
        eye = [0.0, round(gh.y - 0.32, 3), round(gl.z + 0.62 * (gh.z - gl.z), 3)]
    for o, pivot in moving:
        o.data.transform(Matrix.Translation(-pivot))
    pv.export(a.out + '.glb', obs)
    info = {
        'source': os.path.basename(a.model),
        'size': [round(v, 3) for v in size],
        'hinges': hinge_info,
        'nozzle': nozzle,
        'wingtips': [[round(tip.x, 3), round(tip.y, 3), round(tip.z, 3)], [round(-tip.x, 3), round(tip.y, 3), round(tip.z, 3)]],
        'eye': eye,
        'gear': bellies,
        'albedo': round(albedo, 4),
        'triangles': sum(sum(len(f.vertices) - 2 for f in o.data.polygons) for o in obs),
    }
    with open(a.out + '.json', 'w') as f:
        json.dump(info, f, indent=1)
    print(json.dumps(info, indent=1))


def preview(obs, path):
    """The split at a glance: body grey, glass cyan, tailplanes blue, flaperons green, rudders red."""
    tint = {'body': (0.5, 0.5, 0.5, 1), 'glass': (0.2, 0.8, 0.9, 1), 'stab': (0.15, 0.35, 0.9, 1), 'flaperon': (0.2, 0.75, 0.2, 1), 'rudder': (0.9, 0.15, 0.1, 1)}
    saved = {}
    for o in obs:
        m = bpy.data.materials.new(o.name + '_flat')
        m.use_nodes = True
        m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = tint.get(o.name.split('_')[0], (1, 0.5, 0.1, 1))
        saved[o.name] = list(o.data.materials)
        o.data.materials.clear()
        o.data.materials.append(m)
    lo, hi = pv.bounds(obs)
    c = (lo + hi) / 2
    size = max(hi - lo)
    scene = bpy.context.scene
    scene.render.engine = 'CYCLES'
    scene.cycles.samples = 16
    scene.render.resolution_x, scene.render.resolution_y = 1000, 900
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.data.type = 'ORTHO'
    cam.data.ortho_scale = size * 1.05
    cam.data.clip_end = size * 20
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 4
    scene.collection.objects.link(sun)
    world = bpy.data.worlds.new('w')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs[0].default_value = (0.8, 0.8, 0.8, 1)
    base = path[:-4] if path.endswith('.png') else path
    for name, loc, look, up in (
        ('side', Vector((c.x - size * 3, c.y, c.z)), Vector((1, 0, 0)), Vector((0, 1, 0))),
        ('top', Vector((c.x, c.y + size * 3, c.z)), Vector((0, -1, 0)), Vector((0, 0, -1))),
    ):
        cam.location = loc
        right = look.cross(up)
        cam.rotation_euler = Matrix((right, up, -look)).transposed().to_euler()
        sun.rotation_euler = cam.rotation_euler
        scene.render.filepath = f'{base}_{name}.png'
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    bpy.data.objects.remove(sun)
    for o in obs:
        o.data.materials.clear()
        for m in saved[o.name]:
            o.data.materials.append(m)


if __name__ == '__main__':
    main()
