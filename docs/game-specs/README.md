# Game specs — templates for testing how well a model builds a game

Three self-contained build specs, one per game in this repository, written so
the same task can be handed to any coding model and the results compared on
the same yardstick:

| Game | Give the model | Keep for yourself |
|---|---|---|
| Military FPS — range, city block, forest ridge with a lake | [field-line/BRIEF.md](field-line/BRIEF.md) + [field-line/target-look/](field-line/target-look/) | [field-line/GRADING.md](field-line/GRADING.md) |
| First-person tropical lagoon with a survival outpost | [castaway-lagoon/BRIEF.md](castaway-lagoon/BRIEF.md) + [castaway-lagoon/target-look/](castaway-lagoon/target-look/) | [castaway-lagoon/GRADING.md](castaway-lagoon/GRADING.md) |
| Third-person tank combat over open countryside | [tanks/BRIEF.md](tanks/BRIEF.md) + [tanks/target-look/](tanks/target-look/) | [tanks/GRADING.md](tanks/GRADING.md) |

Shared input sheets (the numbers every spec refers to) are in
[reference-sheets/](reference-sheets/): lighting, PBR materials, scale, HUD
layout, ballistics and the performance budget.

Each game has two files:

- **`BRIEF.md`** (§1–§6) — the task. Give it to the model under test exactly
  as written, with the game's `target-look/` PNGs and the shared
  `reference-sheets/`. It says what to build, the hard rules, the features
  with their acceptance criteria, the budgets and the build order.
- **`GRADING.md`** (§7–§9) — for you. How to verify each item, the 100-point
  rubric, the automatic fails and the report the model must hand back. Never
  give it to the model; it would build to the test.

## What to hand over (example: Castaway Lagoon)

Put these in an otherwise empty repository (or attach them), keeping the
folder layout so the relative links in the brief work:

```
castaway-lagoon/BRIEF.md
castaway-lagoon/target-look/*.png      (12 images + contact-sheet.png)
reference-sheets/*.png                 (6 sheets, shared by all three games)
```

and start with one line, for example: *"Build the game described in
castaway-lagoon/BRIEF.md. Follow it exactly, use the images it references,
and stop to report after each milestone of §6."* Swap the folder name for
`field-line/` or `tanks/` to run the other two.

The reference implementations live in this repository (`field-line/`,
`castaway-lagoon/`, and `anbow1/tanks`). They are what the target-look images
were captured from, and what a candidate is compared with. Never show the model
the code.

## Running a fair comparison

1. **Same inputs.** The brief unchanged, the same PNGs, an empty repository with
   only those files, the same tool access (shell, browser for headless
   checks, no internet assets).
2. **Same budget.** Fix the wall-clock or token budget in advance (for
   example 8 hours or N turns) and the number of human nudges allowed (zero is
   the cleanest). Note any intervention in the scoring sheet.
3. **Milestones are checkpoints.** Each brief's §6 build order asks the model to
   stop and report after every milestone. Score the state at each checkpoint
   as well as at the end: a model that ships milestone 5 working beats one that
   ships milestone 9 broken.
4. **Grade on the device class you care about.** The specs target desktop
   Chromium (WebGPU) *and* a mid-range Android phone. If you can only test one,
   say which in the sheet.
5. **Blind the screenshots.** For the "matches the target look" items, have a
   second person rank anonymised screenshots taken at the spec's fixed views
   (`GRADING.md` §7) against `target-look/`.

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
