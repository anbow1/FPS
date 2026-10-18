# Photoscanned models

Scanned models from [Poly Haven](https://polyhaven.com), released under the
[Creative Commons CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
public domain dedication. Attribution is not required; it is given here as a
courtesy. Cut down for the game offline: the meshes simplified with
meshoptimizer (to ~2400 triangles for boulders, ~900 for stones), normalised
to a horizontal half-extent of 1 with the base at y = 0 and stored as
`mesh.bin` (format in `render/scanModels.ts`); the textures resized and
re-encoded as JPEG (colour and normal 1024 px for boulders, 512 px for stones;
ORM, Poly Haven's arm map, at half that).

| Folder                    | Source                                           | Scanned by                          | Used for                 |
| ------------------------- | ------------------------------------------------ | ----------------------------------- | ------------------------ |
| `boulder_01/`             | https://polyhaven.com/a/boulder_01               | Rico Cilliers                       | boulders                 |
| `namaqualand_boulder_02/` | https://polyhaven.com/a/namaqualand_boulder_02   | Greg Zaal, Rico Cilliers            | boulder clusters         |
| `namaqualand_boulder_04/` | https://polyhaven.com/a/namaqualand_boulder_04   | Jenelle van Heerden                 | lichened boulders        |
| `namaqualand_boulder_05/` | https://polyhaven.com/a/namaqualand_boulder_05   | Jenelle van Heerden, Dario Barresi  | flat stones              |
| `rock_07/`                | https://polyhaven.com/a/rock_07                  | Jenelle van Heerden                 | standing stones          |
| `rock_09/`                | https://polyhaven.com/a/rock_09                  | Jenelle van Heerden                 | stones                   |

Plants, kept at their scanned size (ferns whole, ~800–2400 triangles; the
others cut to ~1500–1800), one texture set per species at 1024 px:

| Folder       | Source                                          | Scanned by                  | Used for                         |
| ------------ | ----------------------------------------------- | --------------------------- | -------------------------------- |
| `fern/`      | https://polyhaven.com/a/fern_02                 | Rob Tuytel, Rico Cilliers   | ferns round the camp, four plants |
| `calathea/`  | https://polyhaven.com/a/calathea_orbifolia_01   | Rob Tuytel, Rico Cilliers   | broad-leaved ground plants       |
| `anthurium/` | https://polyhaven.com/a/anthurium_botany_01     | Rob Tuytel, Rico Cilliers   | broad-leaved ground plants       |
