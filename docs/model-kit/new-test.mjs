#!/usr/bin/env node
// Lays out a fresh project folder for building one of the kit's games from scratch with a model.
//
//   node docs/model-kit/new-test.mjs <game> <target-dir> [--fair]
//
//   <game>        a folder of dla-modelu/games (run without arguments to list them)
//   <target-dir>  a new or empty folder; nothing is ever overwritten
//   --fair        leave out docs/ (the playbook: finished solutions) and shared-src/ (finished code),
//                 so the test measures what the model works out from the rules alone
//
// Copies the rules, the reference sheets, the tools and that one game's brief, and writes
// FIRST-MESSAGE.md (the text to paste as the first message) and TEST-RUN.md (which variant this is and
// which commit of the kit it came from, for the grading sheet in dla-ciebie/).
// Node only, so it runs the same in PowerShell, Git Bash and Linux. Run sync.sh first if the playbook,
// the rules or the tools changed since the kit was last synced.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const kit = join(dirname(fileURLToPath(import.meta.url)), 'dla-modelu');
const games = readdirSync(join(kit, 'games'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const args = process.argv.slice(2);
const fair = args.includes('--fair');
const [game, targetArg] = args.filter((a) => !a.startsWith('--'));

if (!game || !targetArg) {
  console.log(`usage: node new-test.mjs <game> <target-dir> [--fair]\ngames: ${games.join(', ')}`);
  process.exit(game ? 1 : 0);
}
if (!games.includes(game)) {
  console.error(`no game '${game}' in the kit; there are: ${games.join(', ')}`);
  process.exit(1);
}
const target = resolve(targetArg);
if (existsSync(target) && readdirSync(target).length > 0) {
  console.error(`'${target}' is not empty; give a new folder (nothing is overwritten)`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });

const parts = ['AGENT.md', 'START.md', 'rules', 'reference-sheets', 'tools'];
if (!fair) parts.push('docs', 'shared-src');
for (const part of parts) {
  const from = join(kit, part);
  if (!existsSync(from)) {
    console.error(`the kit has no '${part}': run docs/model-kit/sync.sh first`);
    process.exit(1);
  }
  cpSync(from, join(target, part), { recursive: true });
}
cpSync(join(kit, 'games', game), join(target, 'games', game), { recursive: true });

const hasLook = existsSync(join(kit, 'games', game, 'target-look'));
writeFileSync(
  join(target, 'FIRST-MESSAGE.md'),
  `Build the game described in \`games/${game}/BRIEF.md\`. Before writing code, read \`AGENT.md\`,
\`rules/games-ts-threejs.md\` and \`rules/graphics-quality.md\`, and look at every image in
\`reference-sheets/\`${hasLook ? ` and \`games/${game}/target-look/\`` : ''}. Measure with the scripts in \`tools/measure/\` from the first
milestone (their README states the debug contract your game must keep)${fair ? '' : '; copy the files in `shared-src/` instead of\nrewriting them, and use `docs/graphics-playbook.md` as the record of how each technique was built'}.
Follow the brief's build order. Stop and report after each milestone using the report format in
\`START.md\`. Do not claim anything works unless you ran it.
`,
);

let commit = 'unknown';
try {
  commit = execFileSync('git', ['-C', kit, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  // Not a git checkout (the kit was copied somewhere): the run sheet says so.
}
writeFileSync(
  join(target, 'TEST-RUN.md'),
  `# Test run

| | |
|---|---|
| Game | ${game} |
| Variant | ${fair ? 'fair: rules only (no playbook, no shared source)' : 'recipe: rules + playbook + shared source'} |
| Kit commit | ${commit} |
| Laid out | ${new Date().toISOString().slice(0, 10)} |
| Model | (fill in) |

Grade with \`docs/model-kit/dla-ciebie/grading/${game}/GRADING.md\` from the repository (never copied here).
`,
);
console.log(`${target}\n  ${parts.join(', ')}, games/${game}\n  paste FIRST-MESSAGE.md as the first message${fair ? ' (fair variant)' : ''}`);
