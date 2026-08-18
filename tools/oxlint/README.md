# Vendored lint tooling

## `anti-slop/`

A **vendored copy** of a third-party oxlint plugin. It is not ours, and it is not an npm
dependency — oxlint loads it from this path via `.oxlintrc.json` → `jsPlugins[].specifier`.

| | |
|---|---|
| **Source** | <https://github.com/dmmulroy/anti-slop> |
| **Author** | Dillon Mulroy ([@dmmulroy](https://github.com/dmmulroy)) |
| **License** | MIT — see [`anti-slop/LICENSE`](anti-slop/LICENSE) |
| **Vendored from** | commit [`446268e`](https://github.com/dmmulroy/anti-slop/commit/446268e5d15baa968eaec669ff65358d36ae6259) (2026-08-14, upstream HEAD as of vendoring) |
| **Vendored on** | 2026-08-18 |
| **Loaded by** | `.oxlintrc.json` → `jsPlugins[].specifier` |

### What was copied

Upstream's `src/` directory, verbatim — 15 rules, three shared modules, and `index.ts`. Two
deliberate deviations:

- **Omitted:** upstream's `*.test.ts` files. They test the rules themselves, not this repo's
  code, and running them is upstream's job.
- **Added:** `LICENSE`, taken from the upstream repository root. MIT requires the copyright and
  permission notice to travel with copies of the software, and the notice does not live inside
  `src/`.

**Do not edit anything under `anti-slop/`.** A local change is invisible at the next re-vendor
and will be silently overwritten. If a rule is wrong, open an issue upstream; if a rule does not
fit this repo, turn it off in `.oxlintrc.json` with a documented reason.

The tree is excluded from linting (`.oxlintrc.json` → `ignorePatterns`) and from typechecking
(the root `tsconfig.json` `include` covers only `bridge`, `cli`, `scripts`).

### Checking for drift

Vendoring buys control and costs automatic updates. Nothing notifies us when upstream changes,
so the check is manual:

```bash
git clone --depth 1 https://github.com/dmmulroy/anti-slop /tmp/anti-slop
diff -r --exclude='*.test.ts' --exclude='LICENSE' \
  /tmp/anti-slop/src tools/oxlint/anti-slop
```

Silence means the copy is current. To re-vendor: copy `src/` over `anti-slop/`, re-copy
`LICENSE`, run `bun run lint`, fix any new findings in *our* code, and update the commit and
date in the table above.

### Do not "fix" this by installing from npm

There is a package named `oxlint-plugin-anti-slop` on the public npm registry. **It is not this
project.** It is a tiny `0.0.0` dependency-free placeholder published by an unrelated account —
the real project's package name, squatted. Upstream's own `package.json` is `"private": true`
and has never been published. There is no dependency to install, so an "upgrade" that adds one
is pulling a stranger's code into the linter that runs on every edit and every commit.

## Config gotchas worth remembering

- **`overrides.files` globs are matched against the FULL path.** A glob must start with `**/` —
  `bridge/journal/**/*.ts` silently matches nothing, `**/bridge/journal/**/*.ts` works. There is
  no error; the override just never applies. Verify any new override by planting a violation
  in-scope and a negative control out-of-scope.
- **`.oxlintrc.json` is parsed as JSONC** — `//` comments are allowed. A `"//"` *key* is not
  (oxlint rejects unknown fields), so per-override rationale is written as a comment.
- **oxlint's `bin/oxlint` is a JS entry with a `#!/usr/bin/env node` shebang**, so `bunx oxlint`
  and `bun run lint` execute it under Node when Node is on `PATH`. The `jsPlugins` loader also
  works under Bun's own runtime (`bun node_modules/oxlint/bin/oxlint …`) with Node absent —
  verified 2026-08-18. Either runtime loads the `.ts` plugin and fires its rules.
