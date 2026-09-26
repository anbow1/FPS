# AGENT.md

Rules for any coding agent working in this repo. These are defaults. A file in
`rules/` may override them for its own project type — nothing else may.

**Load order**

1. This file — always.
2. `rules/finance-python-html.md` — Python / HTML work on market data, pricing, dashboards.
3. `rules/games-ts-threejs.md` — TypeScript / Three.js real-time 3D work.

If you are unsure which set applies, look at the language and the folder, not at
the request wording.

---

## 1. How you work

- **Read before you write.** Open the files you are about to change, plus their
  tests and their callers. Never patch a file you have not read in this session.
- **Plan out loud for anything over ~50 lines.** Short numbered plan, then the
  code. For one-line fixes, skip the plan.
- **Smallest diff that does the job.** Do not reformat, rename, re-order imports
  or "tidy up" code you were not asked to touch. Unrelated changes hide real ones.
- **Finish the job.** No `TODO`, no `pass  # implement later`, no stub that
  returns a hard-coded value, unless the user asked for a stub. If you cannot
  finish, say which part is missing and why — do not fake it.
- **One concern per commit.** If a task needs a refactor first, do the refactor
  as its own step and say so.
- **Ask when the spec is ambiguous and the cost of guessing wrong is high**
  (schema changes, deleting data, a pricing convention, a physics unit). Do not
  ask when a reasonable default exists — pick it, and write the choice in a
  comment.

## 2. Correctness over cleverness

- Prefer boring code. A junior should follow it in one pass.
- No clever one-liners that need a comment to explain the syntax.
- No "just in case" abstraction. Write the second copy before you write the
  shared helper. Three copies is the real trigger.
- No new dependency for something the standard library does in 20 lines. If you
  do add one, say what it costs (size, licence, maintenance) in the message.
- Delete dead code instead of commenting it out. Version control remembers.

## 3. Naming and structure

- Names say what the thing *is*, not what type it is: `settlement_date`, not
  `date2`; `muzzleVelocityMs`, not `mv`.
- **Units live in the name.** `timeoutSeconds`, `distanceMeters`, `spreadBps`,
  `angleRad`. This rule has caught more bugs than any test we have.
- Functions do one thing. If the name needs "and", split it.
- Keep modules under ~400 lines. Over that, split on the seam that already exists.
- Public API at the top of the file, helpers below.

## 4. Errors and edge cases

- Fail loudly and early. Validate inputs at the boundary of your module, then
  trust them inside.
- Never swallow an exception. No bare `except:` in Python, no empty `catch {}`
  in TypeScript. If you catch, you either handle it, enrich it, or re-raise.
- Error messages name the value and the expectation:
  `"tenor '13M' not in curve grid; valid: 1M 3M 6M 1Y 2Y"`.
- Explicitly handle: empty collection, single element, `None` / `undefined`,
  zero, negative, and the very first frame or first tick. These are where real
  bugs live.

## 5. Types and comments

- Python: type hints on every public function. Run `mypy` or `pyright` clean.
- TypeScript: `strict: true`. **`any` is banned** — use `unknown` and narrow.
  No `@ts-ignore` without a one-line reason on the same line.
- Comments explain **why**, never what. `# 30/360 because the ISDA definition
  the desk quotes against uses it` is useful. `# loop over items` is noise.
- Every non-obvious constant gets a source: a link, a spec name, or "tuned by
  hand, feels right at 60 fps".

## 6. Tests

- New logic gets a test. Bug fixes get a test that fails before the fix.
- Test the behaviour, not the implementation. If a refactor breaks a test that
  should still pass, the test was wrong.
- Name tests as sentences: `test_zero_coupon_price_falls_when_yield_rises`.
- Always include one edge case and one known-good value from an outside source.
- Do not mock what you own. Mock the network, the clock, and the market feed —
  nothing else.
- Tests must not need a live connection, a real API key or a specific machine.

## 7. Performance

- Measure first. No optimisation without a number before and a number after.
- Fix the algorithm before the constant factor.
- State the budget in the code when one exists (a frame budget, a refresh
  interval, a max payload). Then assert against it in a test if you can.

## 8. Security and data

- No secrets in code, in tests, or in git — ever. Read from environment or a
  local config file that is in `.gitignore`.
- No API key, token, password, licence key or internal URL in a log line, an
  error message, a commit message or a screenshot.
- Treat every external input as hostile: user text, file contents, market feed
  payloads, and anything a model returns.
- Never write to a path outside the repo unless the user asked for it by name.
- Destructive operations (drop, truncate, delete, force-push, overwrite) need an
  explicit go-ahead in the conversation first. Say exactly what will be lost.

## 9. Windows-first environment

The developer works on Windows. Assume that unless told otherwise.

- Build paths with `pathlib.Path` / `path.join`. Never hand-glue `"a/" + "b"`.
- Watch case-insensitive filenames — `Curve.py` and `curve.py` collide locally
  but not in CI.
- Line endings: keep a `.gitattributes` with `* text=auto eol=lf`.
- Shell commands you suggest should run in PowerShell. If a command is
  bash-only, say so and give the PowerShell form too.
- Long-path issues are real. Keep nesting shallow.

## 10. Git

- Commit message: short imperative subject under 60 chars, blank line, then
  *why*. `fix: clamp turret rate so hull yaw cannot outrun it`.
- Never commit generated artefacts, model binaries, large textures or data
  dumps. Add them to `.gitignore` and note where they really live.
- Never rewrite published history.

## 11. When you report back

Every reply that changed code ends with:

- **What changed** — files touched, one line each.
- **How to run it** — the exact command.
- **What I could not do** — anything skipped, guessed, or left broken.

Do not claim something works unless you ran it. "Should work" is not a result.

## 12. Hard no

- Do not invent an API, a field name, a library function or a market convention.
  If you are not sure it exists, check or say you are unsure.
- Do not silently change a numeric convention (day count, units, coordinate
  handedness, angle units). Flag it.
- Do not disable a test, a lint rule or a type check to make something pass.
- Do not commit code you have not at least imported or built once.
