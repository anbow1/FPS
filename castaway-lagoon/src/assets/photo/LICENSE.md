# Photographed textures

Scanned PBR texture sets, released under the
[Creative Commons CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
public domain dedication by [ambientCG](https://ambientcg.com) and
[Poly Haven](https://polyhaven.com). Attribution is not required; it is given
here as a courtesy. Resized and re-encoded for the game (JPEG): bark colour
1024 px with normal and roughness 512 px; ground sets 512 px with an ORM map
(AO, roughness, metalness) and a height map; board sets 1024 × 512 px, four
planks cut from the photograph, one per quarter, turned to run along the width.

| Folder     | Source                                 | Used for                              |
| ---------- | -------------------------------------- | ------------------------------------- |
| `bark006/` | https://ambientcg.com/view?id=Bark006  | logs, posts, piles, driftwood         |
| `bark007/` | https://ambientcg.com/view?id=Bark007  | the jungle's broadleaf trunks, vines  |

Fetched from the copies in https://github.com/dgreenheck/ez-tree
(`src/app/public/textures/bark/`, attributed there to ambientCG under CC0).

| Folder                  | Source                                                  | Used for                               |
| ----------------------- | ------------------------------------------------------- | -------------------------------------- |
| `dense_sand/`           | https://polyhaven.com/a/dense_sand                      | the beach and the seabed               |
| `leaves_forest_ground/` | https://polyhaven.com/a/leaves_forest_ground            | the jungle floor's leaf litter         |
| `rock_face_03/`         | https://polyhaven.com/a/rock_face_03                    | cliffs and boulders                    |
| `wood_planks_grey/`     | https://polyhaven.com/a/wood_planks_grey                | the jetty, the skiff's boards          |
| `old_planks_02/`        | https://polyhaven.com/a/old_planks_02                   | the shelter's deck, table, crates      |
| `weathered_planks/`     | https://polyhaven.com/a/weathered_planks                | dark boards                            |
| `rough_linen/`          | https://polyhaven.com/a/rough_linen                     | the weave in the tarp, cot and seats   |

`rough_linen/` is a detail map, 512 px: `weave.jpg` packs the photograph's
linear luminance over its mean (× 0.5) in red, roughness in green and AO in
blue; `normal.jpg` is its OpenGL normal map.
