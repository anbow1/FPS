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
cp "$repo/docs/nowa-gra-AAA/NOWA-GRA-AAA.md" "$kit/dla-modelu/NOWA-GRA-AAA.md"
cp "$repo"/references/*.png "$repo/references/_generate_references.py" "$kit/dla-modelu/reference-sheets/"

# From here on every removal names a path relative to the repository's root, never a bare variable.
cd "$repo"

# The tools a new game is measured and fed with: the headless probes (tools/measure) and the Blender
# scripts that turn a downloaded model, a MakeHuman figure or a motion clip into a game asset.
tools="docs/model-kit/dla-modelu/tools"
rm -rf docs/model-kit/dla-modelu/tools
mkdir -p "$tools/measure" "$tools/assets/vehicles" "$tools/assets/people" "$tools/assets/mocap"
cp tools/measure/*.mjs tools/measure/README.md "$tools/measure/"
cp paris/tools/vehicles/*.py paris/tools/vehicles/README.md "$tools/assets/vehicles/"
cp paris/tools/people/*.py paris/tools/people/README.md "$tools/assets/people/"
cp tools/mocap/*.py "$tools/assets/mocap/"
# The KTX2 baker for the characters' atlases (playbook §8.4); it imports ../measure/lib.mjs, copied above.
cp tools/assets/*.mjs "$tools/assets/"

# The shared source files a new game copies instead of rewriting (playbook §0b), from the game that
# carries the newest copy of each.
shared="docs/model-kit/dla-modelu/shared-src"
rm -rf docs/model-kit/dla-modelu/shared-src
mkdir -p "$shared/render" "$shared/core"
for f in warmup instancing perf benchRecorder webgpuCompat instanceStream; do
  cp "field-line/src/render/$f.ts" "$shared/render/"
done
cp field-line/src/core/noise.ts "$shared/core/"

# docs/nowa-gra-AAA (Polish) and docs/new-game-AAA (English): everything for starting a new game from
# nothing, in one folder to copy. The guide, the README, the first message and the run sheet (and the
# English folder's ROUTINE-WORK.md) are written by hand; the rest is regenerated here from the kit.
starter() { # <folder in docs> <guide file> <game folder> <description file> <line for references/README.md>
  local part
  for part in AGENT.md START.md rules reference-sheets tools shared-src docs games; do
    rm -rf "docs/${1:?}/${part:?}"
  done
  for part in AGENT.md START.md rules reference-sheets tools shared-src docs; do
    cp -r "docs/model-kit/dla-modelu/$part" "docs/$1/$part"
  done
  mkdir -p "docs/$1/games/$3/references"
  # The user's form is the block in the guide's part A, cut out so the two cannot drift.
  awk '/^```markdown$/ { on = 1; next } /^```$/ { on = 0 } on' "docs/$1/$2" > "docs/$1/games/$3/$4"
  [ -s "docs/$1/games/$3/$4" ] || { echo "no description form found in docs/$1/$2" >&2; exit 1; }
  printf '%s\n' "$5" > "docs/$1/games/$3/references/README.md"
}

starter nowa-gra-AAA NOWA-GRA-AAA.md nowa-gra OPIS.md 'Zdjęcia miejsca, światła i nastroju: własne albo z licencją pozwalającą na użycie (CC0, CC BY z autorem w nazwie pliku). Bez kadrów z gier i filmów.'
cp docs/wytyczne-prace-rutynowe.md docs/nowa-gra-AAA/docs/

starter new-game-AAA NEW-GAME-AAA.md new-game DESCRIPTION.md 'Photographs of the place, the light and the mood: your own, or under a licence that allows the use (CC0, or CC BY with the author in the file name). No stills from games or films.'
# English only: no Polish rules template, the tools' English READMEs, and a START.md that does not list the template.
rm -f docs/new-game-AAA/docs/graphics-rules-template.md
cp paris/tools/vehicles/README.en.md docs/new-game-AAA/tools/assets/vehicles/README.md
cp paris/tools/people/README.en.md docs/new-game-AAA/tools/assets/people/README.md
grep -v 'graphics-rules-template.md' docs/model-kit/dla-modelu/START.md > docs/new-game-AAA/START.md

# docs/new-game-AAA-lite: the same goal on a small context. GUIDE.md, NUMBERS.md, README.md and
# FIRST-MESSAGE.md are written by hand; the tools, shared source, sheets, playbook and form are copied.
for part in reference-sheets tools shared-src docs games; do
  rm -rf "docs/new-game-AAA-lite/${part:?}"
  cp -r "docs/new-game-AAA/$part" "docs/new-game-AAA-lite/$part"
done

echo "kit, docs/nowa-gra-AAA and docs/new-game-AAA synced from $repo"
