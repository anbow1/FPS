#!/usr/bin/env bash
# Refreshes the copies in this kit from their sources in the repository, so the
# kit never drifts from what the reference games actually do. Run it after
# changing docs/graphics-playbook.md, docs/graphics-rules-template.md, the
# reference sheets, tools/measure, the asset scripts or a shared source file. Bash only; on Windows run it from Git Bash or WSL.
set -euo pipefail
kit="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$kit/../.." && pwd)"

note='> **Note for a model reading this in the kit:** file paths below point at the
> reference implementation (`field-line/`, `castaway-lagoon/`, `anbow1/tanks`),
> which is not in your folder. The techniques, numbers and traps stand on their
> own; build your own versions to `rules/graphics-quality.md`.
'
{ printf '%s\n' "$note"; cat "$repo/docs/graphics-playbook.md"; } > "$kit/dla-modelu/docs/graphics-playbook.md"
cp "$repo/docs/graphics-rules-template.md" "$kit/dla-modelu/docs/graphics-rules-template.md"
# The guide for a game that has no brief yet: the user describes it, the model writes the brief (new-test.mjs --new).
cp "$repo/docs/nowa-gra-aaa.md" "$kit/dla-modelu/NOWA-GRA-AAA.md"
cp "$repo"/references/*.png "$repo/references/_generate_references.py" "$kit/dla-modelu/reference-sheets/"

# The tools a new game is measured and fed with: the headless probes (tools/measure) and the Blender
# scripts that turn a downloaded model, a MakeHuman figure or a motion clip into a game asset.
tools="$kit/dla-modelu/tools"
rm -rf "$tools"
mkdir -p "$tools/measure" "$tools/assets/vehicles" "$tools/assets/people" "$tools/assets/mocap"
cp "$repo"/tools/measure/*.mjs "$repo/tools/measure/README.md" "$tools/measure/"
cp "$repo"/paris/tools/vehicles/*.py "$repo/paris/tools/vehicles/README.md" "$tools/assets/vehicles/"
cp "$repo"/paris/tools/people/*.py "$repo/paris/tools/people/README.md" "$tools/assets/people/"
cp "$repo"/tools/mocap/*.py "$tools/assets/mocap/"

# The shared source files a new game copies instead of rewriting (playbook §0b), from the game that
# carries the newest copy of each.
shared="$kit/dla-modelu/shared-src"
rm -rf "$shared"
mkdir -p "$shared/render" "$shared/core"
for f in warmup instancing perf benchRecorder webgpuCompat instanceStream; do
  cp "$repo/field-line/src/render/$f.ts" "$shared/render/"
done
cp "$repo/field-line/src/core/noise.ts" "$shared/core/"
echo "kit synced from $repo"
