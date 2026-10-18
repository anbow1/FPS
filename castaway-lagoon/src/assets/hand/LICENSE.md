# First-person hand and forearm

Cut from the MakeHuman 1.x base mesh (`makehuman/data/3dobjs/base.obj`), with
its default skeleton (`makehuman/data/rigs/default.mhskel`) and skin weights
(`default_weights.mhw`), from https://github.com/makehumancommunity/makehuman.
The MakeHuman assets — the base mesh, skeletons and weights — are released
under [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
("anyone can do whatever they want with it"); credit is given here as a
courtesy.

Baked offline: the right forearm and hand selected by their bones' weights,
moved into the viewmodel's hand frame (wrist at the origin, fingers along −Z,
palm facing −Y), the forearm stretched to 27 cm, one Catmull–Clark step,
weights reduced to four bones per vertex, region masks for the glove and the
nails derived from the weights, and quantised (format in
`render/handMesh.ts`). The left hand is the right one mirrored at load.
