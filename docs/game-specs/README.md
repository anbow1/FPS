# Game specs — templates for testing how well a model builds a game

Three self-contained build specs, one per game in this repository, written so
the same task can be handed to any coding model and the results compared on
the same yardstick:

| Spec | Game | Reference look |
|---|---|---|
| [field-line/SPEC.md](field-line/SPEC.md) | Military FPS — range, city block, forest ridge with a lake | [field-line/target-look/](field-line/target-look/) |
| [castaway-lagoon/SPEC.md](castaway-lagoon/SPEC.md) | First-person tropical lagoon with a survival outpost | [castaway-lagoon/target-look/](castaway-lagoon/target-look/) |
| [tanks/SPEC.md](tanks/SPEC.md) | Third-person tank combat over open countryside | [tanks/target-look/](tanks/target-look/) |

Shared input sheets (the numbers every spec refers to) are in
[reference-sheets/](reference-sheets/): lighting, PBR materials, scale, HUD
layout, ballistics and the performance budget.

Each spec is split in two:

- **Part A — the brief** (§1–§6): give it to the model under test exactly as
  written, together with the `reference-sheets/` and the game's
  `target-look/` PNGs. It says what to build, the hard rules, the features
  with their acceptance criteria, the budgets and the build order.
- **Part B — evaluation** (§7–§9): for the person grading. How to verify each
  item, the 100-point rubric, the automatic fails and the report the model must
  hand back. Do not give Part B to the model; it would teach to the test.

The reference implementations live in this repository (`field-line/`,
`castaway-lagoon/`, and `anbow1/tanks`). They are what the target-look images
were captured from, and what a candidate is compared with. Never show the model
the code.

## Running a fair comparison

1. **Same inputs.** Part A unchanged, the same PNGs, an empty repository with
   only those files, the same tool access (shell, browser for headless
   checks, no internet assets).
2. **Same budget.** Fix the wall-clock or token budget in advance (for
   example 8 hours or N turns) and the number of human nudges allowed (zero is
   the cleanest). Note any intervention in the scoring sheet.
3. **Milestones are checkpoints.** Each spec's §6 build order asks the model to
   stop and report after every milestone. Score the state at each checkpoint
   as well as at the end: a model that ships milestone 5 working beats one that
   ships milestone 9 broken.
4. **Grade on the device class you care about.** The specs target desktop
   Chromium (WebGPU) *and* a mid-range Android phone. If you can only test one,
   say which in the sheet.
5. **Blind the screenshots.** For the "matches the target look" items, have a
   second person rank anonymised screenshots taken at the spec's fixed views
   (§7) against `target-look/`.

## Scoring sheet (copy per run)

| | Model A | Model B | Model C |
|---|---|---|---|
| Spec / game | | | |
| Budget used (time · turns · nudges) | | | |
| Automatic fail? (which) | | | |
| §8.1 Builds, runs, stays up (10) | | | |
| §8.2 Architecture and code (10) | | | |
| §8.3 Gameplay features (25) | | | |
| §8.4 Graphics vs target look (25) | | | |
| §8.5 Performance and budgets (15) | | | |
| §8.6 Tests and tooling (10) | | | |
| §8.7 Phone build and touch (5) | | | |
| **Total (100)** | | | |
| Milestones reached working | | | |
| Notes | | | |

## Why these three

They stress different things, so a model's profile shows:

- **Field Line** — systems depth: ballistics to a sheet, a second render
  target (the scope), AI squads, damage model, three maps, exposure.
- **Castaway Lagoon** — rendering depth: water optics, shore waves, caustics,
  underwater, vegetation, time of day and weather, plus many small interactive
  systems that must not break each other (swimming, boat, jeep, fire, lamp).
- **Tanks** — scale and simulation: kilometre sight lines, vehicle physics,
  armour and modules, impostors and terrain LOD, a gunner sight and thermal
  view, and an enemy AI that fights back.
