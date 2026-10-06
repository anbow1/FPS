# For the evaluator — how to run and grade a model

Never give this folder to the model. It holds the grading guides (what you
check and how the 100 points split) and this protocol.

| Game | The model gets (`../dla-modelu/`) | You keep |
|---|---|---|
| Military FPS — range, city block, forest ridge with a lake | `games/field-line/BRIEF.md` + `target-look/` | [grading/field-line/GRADING.md](grading/field-line/GRADING.md) |
| First-person tropical lagoon with a survival outpost | `games/castaway-lagoon/BRIEF.md` + `target-look/` | [grading/castaway-lagoon/GRADING.md](grading/castaway-lagoon/GRADING.md) |
| Third-person tank combat over open countryside | `games/tanks/BRIEF.md` + `target-look/` | [grading/tanks/GRADING.md](grading/tanks/GRADING.md) |
| Jet fighter simulator (5th gen vs 4.5 gen) | `games/jet-fighter/BRIEF.md` | [grading/jet-fighter/GRADING.md](grading/jet-fighter/GRADING.md) |
| Attack helicopter simulator | `games/attack-helicopter/BRIEF.md` | [grading/attack-helicopter/GRADING.md](grading/attack-helicopter/GRADING.md) |

Every model also gets the shared part of `../dla-modelu/`: `START.md`,
`AGENT.md`, `rules/`, `reference-sheets/` and (unless you run the fair test
below) `docs/`. A new game? Write a brief in the same shape and copy
[GRADING-template.md](GRADING-template.md).

The reference implementations live in this repository (`field-line/`,
`castaway-lagoon/`, and `anbow1/tanks`); the target-look images were captured
from them. Never show the model the code.

## Running a fair comparison

1. **Same inputs.** The brief unchanged, the same images, an empty repository
   with only the `dla-modelu/` files, the same tool access (shell, a headless
   browser for checks, no internet assets). Decide whether `docs/` is included
   (recipe-following test) or removed (problem-solving test) and note it.
2. **Same budget.** Fix the wall-clock or token budget in advance and the
   number of human nudges allowed (zero is the cleanest). Note every
   intervention in the scoring sheet.
3. **Milestones are checkpoints.** Each brief's build order asks the model to
   stop and report after every milestone. Score the state at each checkpoint as
   well as at the end: milestone 5 working beats milestone 9 broken.
4. **Grade on the device class you care about.** The rules target desktop
   Chromium (WebGPU) and a mid-range Android phone. If you test only one, say
   which.
5. **Blind the screenshots.** For "matches the target look" items, have a
   second person rank anonymised screenshots at the fixed views against
   `target-look/` (or against `rules/graphics-quality.md` §14 where a game has
   no target look).
6. **Check the report against reality.** Run the benchmark and the checks
   yourself; a report that claims what you cannot reproduce loses the
   "reports accurate" points even when the game is good.

## Scoring sheet (copy per run)

| | Model A | Model B | Model C |
|---|---|---|---|
| Game · `docs/` included? | | | |
| Budget used (time · turns · nudges) | | | |
| Automatic fail? (which) | | | |
| §8.1 Builds, runs, stays up (10) | | | |
| §8.2 Architecture and code (10) | | | |
| §8.3 Gameplay / simulation (25) | | | |
| §8.4 Graphics (25) | | | |
| §8.5 Performance and budgets (15) | | | |
| §8.6 Tests and tooling (10) | | | |
| §8.7 Phone build and touch (5) | | | |
| **Total (100)** | | | |
| Milestones reached working | | | |
| Notes | | | |

## Why these five

They stress different things, so a model's profile shows:

- **Field Line** — systems depth: ballistics to a sheet, a second render target
  (the scope), squad AI, damage model, three maps, exposure.
- **Castaway Lagoon** — rendering depth: water optics, shore waves, caustics,
  underwater, vegetation, time of day and weather, plus many small systems that
  must not break each other.
- **Tanks** — scale and simulation: kilometre sight lines, vehicle physics,
  armour, impostors and terrain LOD, a gunner sight and thermal view.
- **Jet fighter** — a real flight model and energy fight, a sky that works from
  the runway to 15 km, volumetric clouds, a collimated HUD and sensors.
- **Attack helicopter** — the hardest flight model (rotor), terrain masking,
  a sensor turret with render targets, downwash and night vision.
