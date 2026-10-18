# Photoscanned models

Scanned models from [Poly Haven](https://polyhaven.com), released under the
[Creative Commons CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
public domain dedication. Attribution is not required; it is given here as a
courtesy. Cut down for the game offline: the meshes simplified with
meshoptimizer (rocks to ~1500 triangles, stumps ~2500, the trunk ~2000) and
stored as `mesh*.bin` (format in `render/scanModels.ts`); rocks normalised to a
horizontal half-extent of 1 with the base at y = 0, stumps and the trunk kept
in metres; the textures resized and re-encoded as JPEG (colour and normal
1024 px, ORM, Poly Haven's arm map, 512 px).

| Folder             | Source                                       | Scanned by     | Used for                           |
| ------------------ | -------------------------------------------- | -------------- | ---------------------------------- |
| `rock_moss/`       | https://polyhaven.com/a/rock_moss_set_01     | Kless Gyzen    | the forest's rocks, six of the set |
| `tree_stump_01/`   | https://polyhaven.com/a/tree_stump_01        | Rob Tuytel     | stumps                             |
| `tree_stump_02/`   | https://polyhaven.com/a/tree_stump_02        | Rob Tuytel     | stumps                             |
| `dead_tree_trunk/` | https://polyhaven.com/a/dead_tree_trunk      | Rob Tuytel     | fallen trunks                      |
