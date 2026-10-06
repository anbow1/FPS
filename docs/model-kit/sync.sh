#!/usr/bin/env bash
# Refreshes the copies in this kit from their sources in the repository, so the
# kit never drifts from what the reference games actually do. Run it after
# changing docs/graphics-playbook.md, docs/graphics-rules-template.md or the
# reference sheets. Bash only; on Windows run it from Git Bash or WSL.
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
cp "$repo"/references/*.png "$repo/references/_generate_references.py" "$kit/dla-modelu/reference-sheets/"
echo "kit synced from $repo"
