# mend

[![hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DinishKawaii/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/DinishKawaii/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/c/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in
four formats, to a tree of text files — to the specification in `SPEC.md`.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- **Formats:** unified diffs (even with wrong line numbers), SEARCH/REPLACE
  blocks, V4A patches, and JSON text-editor tool calls. `--format=auto`
  (the default) detects the format; `--format=unified`,
  `--format=search-replace`, `--format=v4a` or `--format=json` forces one.
- **Patch source:** the `PATCH` file, or standard input when `PATCH` is
  absent or `-`.
- **Matching:** each edit's old lines are found at the first of three tiers
  — exact, ignoring trailing whitespace, ignoring leading and trailing
  whitespace (and re-indenting the new lines to match). `--strict` matches
  exactly only.
- **All or nothing:** every file changes, or none does. A failed edit is
  reported (`error: <code> <path>`) and the edits after it still run.
- **`--check`** does everything but write: same output and exit code, no
  file created, changed or deleted.
- **Output:** one line per changed file (`A`, `D`, `M`, or `R old -> new`
  for a move), then `ok: <n> files`. Exit 0 on success, 1 when an edit
  failed, 2 for usage, missing patch, unknown format, or parse errors.

Node 22 and its standard library alone — nothing is installed, no network
is used while it runs.

## The files

- `main.ts`: the CLI, written from scratch to `SPEC.md`.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the
  checks from the environment and runs `main.ts` on each one.
- `check.ts`: the practice set on your own machine:
  `node check.ts <practice.json>`.
- `SPEC.md`: the specification — the whole contract.
- `LICENSE`: MIT.

## Practice score

100 of 100 practice checks pass (practice score 1000), plus 59 extra
edge-case checks written from `SPEC.md` sentences the practice set does
not show (no-newline handling, empty anchors, move/recreate, overlapping
matches, detection order, and more).
