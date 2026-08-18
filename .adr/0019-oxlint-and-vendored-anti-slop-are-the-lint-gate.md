# 0019 — oxlint + vendored anti-slop is the lint gate; one linter; TypeScript 7

Status: **Accepted** (2026-08-18)

## Context

Collie has never had a linter. Not ESLint, not biome, not oxlint — from the first commit to
`1.0.0-beta.4` the only static gate was `tsc --noEmit` on both sides, plus tests. That was a
deliberate-feeling absence rather than a decision, and it held for a while: the tree is small, the
reviewer is attentive, and style lint is mostly noise.

It stopped holding because of *who writes the code*. Most of this repo is written by agents, and
agent-written TypeScript fails in a shape `tsc` cannot see: it type-checks while carrying no
evidence. `(value: unknown)` parameters, a `typeof` chain standing in for a parsed contract,
`as unknown as Foo` to silence a mismatch, `Record<string, unknown>` as a universal payload type.
Every one of those compiles. In a repo whose bridge parses a Unix socket, third-party agent session
logs off disk, `commands.toml`, `pairing.json`, and cross-machine pack payloads, "well-typed but
unparsed" is not a style problem — it is the bug class.

[dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) is 15 oxlint rules aimed at exactly that
failure mode. They are deliberately blunt: they reject the *shape* of low-evidence code rather than
trying to prove it wrong. `no-runtime-typeof` bans `typeof` outright, on the grounds that a `typeof`
check narrows a representation without establishing a contract. Bluntness is the point — a rule an
agent can argue its way around is not a gate.

Turning it on measured the debt honestly: **2,851 findings** on the full tree (`web/` 1,859 ·
`bridge/` 831 · `cli/` 149 · `scripts/` 12).

The TypeScript 7 upgrade rode along in the same milestone. That bundling is **timing, not
causality** — worth stating because the obvious upstream precedent reads the other way. In
`ts-factory-stack` (ADR-0007 there) TypeScript 7 was blocked by ESLint: typescript-eslint refuses
TS7, so dropping ESLint is what unblocked the compiler. Collie had no ESLint to drop. Here the two
land together only because pre-1.0 is when you take a compiler generation and a new gate in one
breath, not because either needed the other.

## Decision

**oxlint is Collie's linter — the only one — and `bun run lint` is how you run it.** All 15
anti-slop rules run at `error`, alongside oxlint's own `correctness` / `suspicious` / `perf`
catalog and the typescript, react, import, promise, node, unicorn, oxc and jsx-a11y plugins, in one
pass.

**ESLint and biome are refused, not deferred.** Neither was ever installed, and adding one now
would buy nothing oxlint lacks while re-taking a coupling Collie doesn't have: typescript-eslint
gates on the compiler version, so an ESLint in this tree would own the TypeScript upgrade schedule.
If a future rule has no oxlint equivalent, write it as an oxlint JS plugin — that path is proven
here, it is how anti-slop itself loads.

**There is exactly one config, and every surface shells out to it.** `.oxlintrc.json` at the repo
root is oxlint's default path, so a bare `oxlint`, the editor extension, `--fix`, and any ad-hoc
run all pick up the whole gate with no flags. `web/` deliberately has no oxlint dependency and no
lint script of its own — the root config already covers `web/src`. There is no second, weaker
configuration to run by accident.

**The gate runs on five surfaces, in a stated authority order.** In order of latency:

| surface | scope | what it is |
| --- | --- | --- |
| editor (`.vscode/`, oxc extension) | file | on type, fix on save |
| agent edit loop (`.claude/hooks/lint-edited-file.sh`, PostToolUse) | file | exit 2, diagnostic to the model |
| pre-commit (`scripts/git-hooks/pre-commit`) | staged files | independent of the version guard |
| `collie build` (`cli/build.ts`) | full tree | after installs, before the typechecks |
| CI (`.github/workflows/ci.yml`) | full tree | after version consistency, before typecheck/test |

**Only the full-tree runs define "passing".** The three narrower surfaces are convenience — a
single-file run can miss a cross-file finding, and none of them may declare the tree green. Each
wiring point states this at the line that does it.

**A finding is fixed in the code. A rule is never downgraded to clear one, and nothing is ever
suppressed.** There are zero `oxlint-disable` comments in `bridge/`, `web/src/` and `cli/`, and
that number is the policy, not an accident of the pay-down. If a future case genuinely earns one it
carries a one-line reason held to the same discipline as the rationale table below — an unexplained
suppression is a rule downgrade wearing a costume. The same applies to
`require-safety-comment-for-type-assertion`: a `// SAFETY:` comment must state the invariant that
makes the assertion sound. The rule can enforce that the note exists; it cannot enforce that the
note is true, so a rote "safe, trust me" is a review failure even though it clears the gate. The
PostToolUse hook ships as a **pilot** watching for exactly that gaming — the expectation, and what
to do if it materialises, is written in that hook's own header.

**anti-slop is vendored, and re-vendoring is a maintainer act.** `tools/oxlint/anti-slop/` is
upstream's `src/` copied verbatim at commit
[`446268e`](https://github.com/dmmulroy/anti-slop/commit/446268e5d15baa968eaec669ff65358d36ae6259)
(MIT, `LICENSE` copied alongside; upstream's own package is `private` and unpublished — it ships to
be vendored, and the `oxlint-plugin-anti-slop` name on npm is an unrelated squat). Provenance, the
diff-against-upstream drift check, and the config gotchas live in
[`tools/oxlint/README.md`](../tools/oxlint/README.md).

The consequence worth naming out loud: **vendored code sits outside the 7-day `minimumReleaseAge`
supply-chain gate entirely.** That gate (`bunfig.toml`, `web/bunfig.toml`, `.npmrc`) protects
things Bun *installs*; a copied tree is never installed, so it is never held. The protection is
therefore procedural instead of automatic: **the maintainer re-pins the upstream commit
deliberately, and reads the diff.** Re-vendoring on a schedule, by a bot, or as a side effect of
another change is the failure mode this replaces — nobody but a human reading that diff stands
between upstream and the linter that runs on every edit and every commit.

**TypeScript 7 on both sides** (`7.0.2`, the stable `latest`, cleared the 7-day gate on its own).
The upgrade touched no source file and no `tsconfig` — neither side used the removed `baseUrl`, and
TS7 surfaced zero new diagnostics. Typecheck wall time dropped to ~0.27s (root) / ~0.56s (web).
One thing to know: **TypeScript 7 no longer ships a `tsserver` bin** — only `tsc`. Nothing in-repo
pointed at it, but an editor integration configured against
`node_modules/typescript/bin/tsserver` will not find one.

### Boundary overrides: where `no-runtime-typeof` is scoped off, and why that is not a loophole

The rule is right about internal code and wrong about a parse boundary — at the boundary, `typeof`
*is* the parse rather than a dodge of one. The shape of the exemption is what keeps that honest:

- **Off by file, never globally, never by option.** `allowInTypeGuards` was refused outright: a
  hand-written `x is Foo` guard is precisely the unverified-contract pattern the rule exists to
  eliminate, and taking the option would have kept the shape while losing the point.
- **Every override names files, and every one of those files is a module whose own
  coerce/parse function is where the `typeof` sits** — the Herdr socket and wire modules, journal
  adapters over third-party JSONL, `/pack/v1/*` payloads, HTTP request bodies and disk-backed state
  in the bridge, and the localStorage-backed preference stores in `web/`. Each override carries its
  reasoning as a comment in `.oxlintrc.json`.
- **Non-boundary `typeof` stays at `error` and was paid down.** `bridge/state-engine.ts` is the
  clearest case: it narrowed already-typed Herdr pane fields and carried a hand-written `hasAgent`
  guard, so its checks were fixed, and the `agent_session` shape check moved out to the wire
  boundary where it belongs.
- **The overrides are an admission, not an architecture.** The real fix for all of them is a schema
  validator at each boundary (zod/valibot), decoding into a named domain type — which would delete
  the override list. That is a legitimate future improvement, and it was **explicitly scoped out of
  this milestone**: it is a design change to every parse site, not a lint pay-down.

### The triage pass

Exactly one deliberate triage pass ran (2026-08-18), rule by rule against the code: 2,851 → 1,098,
and the remaining 1,098 were fixed. No category was downgraded, no `ignorePatterns` entry was added
for source, no inline suppression was used. Three rules were added to this table mid-fix under its
own rule — added to the table, never decided ad hoc.

| rule | n | decision | reason |
| --- | --- | --- | --- |
| `react/react-in-jsx-scope` | 1,427 | off | Both tsconfigs are `"jsx": "react-jsx"` and web builds through `@vitejs/plugin-react`; a `React` import is never required, and satisfying it means 1,427 dead imports. |
| `eslint/no-await-in-loop` | 92 | off | Every non-test site is ordered-by-contract, none throughput-bound — pane choreography re-reads the terminal between keystrokes, journal adapters gate each path through `containedRealpath` before the next, pack/CLI loops serialise writes to one JSON store. `Promise.all` here interleaves keystrokes into one shared PTY: a correctness regression, not an optimisation. |
| `eslint/no-underscore-dangle` | 15 | off | Three unrenameable families: tooling-imposed globals (`__WB_MANIFEST`, `__BUILD_INFO__`), a `_x` backing field behind a same-named getter, and the repo-wide `__resetX()` test-seam marker where the dangle *is* the "not public API" signal. |
| `anti-slop/no-runtime-typeof` | 119 | scoped off (88); 31 fixed | See the boundary section above. |
| `unicorn/consistent-function-scoping` | 115 | off in `**/*.test.ts(x)` (109); 6 fixed | A per-suite helper deliberately lives inside the `describe` that owns it; hoisting moves fixtures away from their test and lets one suite's helper leak into its neighbour. The rule's premise (reuse, per-call allocation) is a production concern. |
| `anti-slop/no-module-mocking` | 22 | off in `**/web/src/**/*.test.ts(x)` | `web/` has no DI container by design; the HTTP seam is already faked at the network with MSW, and the residual mocks stage hooks/timers whose only alternative is threading providers through production components for the tests' benefit — the lint rule dictating app architecture. Bridge/CLI tests inject real fakes and stay at `error`. |
| `react/no-array-index-key` | 28 | off | Every keyed list is positional-by-nature — terminal grid rows, ANSI segments, dialog option rows whose ids are literally `opt-${i}`, markdown inline pieces. Position *is* the identity; content keys would remount the mirror's hottest path every poll and break `ansi-output`'s scroll anchor. |
| `jsx-a11y/prefer-tag-over-role` | 8 | off | The four convertible `role="status"` banners became `<output>` first. What remains is deliberate: `role="img"` on inline `<svg>` (an `<img>` needs a `src`), checkbox/radio roles on buttons that *mirror* terminal state and must never own checked state, and sheets where native `<dialog>`/`<fieldset>` semantics collide with gesture handling and ADR 0007's pause-not-gate idle lock. |
| `import/no-unassigned-import` | 3 | off | `./index.css`, `@testing-library/jest-dom/vitest`, `./lib/pwa` — side-effect imports with no assignable form. |
| `anti-slop/no-object-parameters` | 2 | **stays at error** | The assumed conflict with CLAUDE.md's parameter-property convention does not exist — that note is about *constructor* parameter properties, a construct this rule never sees. |
| `unicorn/no-array-sort` | 71 | **stays at error** | In-place `.sort()` on a list derived from a Herdr snapshot or a pack roster is a real aliasing bug class; `toSorted()` is mechanical. |
| everything else (`require-safety-comment-for-type-assertion` 443, `no-known-value-widening` 136, `no-unsafe-dictionary-type` 92, `no-chained-type-assertions` 66, `no-unknown-parameters` 62, …) | 1,027 | **stays at error** | No architectural argument was found against any of them. They are signal, and they were fixed in code. |

### If a rule just blocked you

The fix is almost always one of these. Reach for the rule's name in `.oxlintrc.json` for the
per-rule comment; reach here for the shape.

```ts
// no-unsafe-dictionary-type / no-widen-then-assert — name the shape, don't widen to a bag.
- const row = JSON.parse(line) as Record<string, unknown>;
+ const row: JsonValue = JSON.parse(line);          // bridge/json.ts (web: web/src/lib/json.ts)
+ if (typeof row !== "object" || row === null || Array.isArray(row)) return;

// no-unknown-parameters / no-unknown-returns — take a type parameter, keep the call site's type.
- function send(body: unknown) { … }
+ function send<TBody>(body: TBody) { … }

// no-known-value-widening — an interface (not a type alias) is what the rule accepts as an owner.
- function seed(files: Record<string, string>) { … }
+ interface SeededFiles { readonly [path: string]: string }
+ function seed(files: SeededFiles) { … }

// no-chained-type-assertions — one typed seam instead of a chain.
- const fake = { readPane } as unknown as HerdrClient;
+ // SAFETY: Partial<T> drops privates so the assertion is single, and every method the fake
+ // supplies stays signature-checked against the real class.
+ function stubPart<T>(impl: Partial<T>): T { return impl as T }

// require-safety-comment-for-type-assertion — one comment per assertion, stating the invariant
// that makes it sound. "safe" is not an invariant; naming the enforcing try/catch is.

// unicorn/no-array-sort — a Herdr-derived list is aliased; don't sort it in place.
- panes.sort(byName)
+ panes.toSorted(byName)
```

## Consequences

**The boundary architecture is now load-bearing, not stylistic.** Because the anti-slop rules leave
no other way to handle an external value, `bridge/json.ts` (`JsonValue`/`JsonObject`),
`web/src/lib/json.ts`, `web/src/lib/env.ts` (the one capability-probe module — probes are
`globalThis.X !== undefined`, so a test that stubs a global *to* `undefined` still reads as absent)
and `web/src/test/stub.ts` exist in the shapes they do. Relaxing this ADR would not just loosen a
linter; it would strand those modules without their justification.

**Paying down 2,851 findings surfaced five latent bugs**, every one of them at a parse boundary — a
journal line that is literally `null` threw a `TypeError` out of all four parsers; three bridge
write routes reached Herdr or `.trim()` on a non-string `text` / non-string `workspaceId` /
truthy-`0` `submit` instead of answering 400; and a pairing failure whose refusal string wasn't
recognised rendered a *blank* card. None was found by reading; each was found by a rule refusing an
unparsed value. That is the argument for treating a finding as signal rather than noise, and it is
why every commit touching `bridge/journal/files.ts`, pairing/pack auth, or socket parsing got a
mandatory manual diff review rather than a green-tests wave-through.

**New code has to earn its types.** An agent reaching for `unknown` or a `typeof` check now gets
blocked at edit time with the rule text. Writing a parse at the boundary takes longer than writing
a type guard; that cost is the intended one.

**Vendored code drifts.** `tools/oxlint/anti-slop/` will not pick up upstream fixes or new rules on
its own, and nothing notifies us. The drift check is the manual `diff -r` in
`tools/oxlint/README.md`, run when someone chooses to run it.

**Four operational facts, each measured rather than assumed, that will bite whoever edits this
setup next:**

- **`overrides.files` globs match the full path**, so every glob needs a leading `**/`. A bare
  `bridge/journal/**/*.ts` silently matches nothing — no error, the override just never applies.
  Verify a new override by planting a violation in-scope *and* a negative control out-of-scope.
- **Naming a file on the command line overrides `ignorePatterns`.** That is why the PostToolUse
  hook short-circuits on `tools/oxlint/anti-slop/*` and `contrib/*` paths itself instead of
  trusting the config to ignore them.
- **The escape hatches are named per surface on purpose** — `SKIP_LINT_CHECK` (pre-commit),
  `SKIP_LINT` (`collie build`), `SKIP_VERSION_CHECK` (pre-commit), `SKIP_TYPECHECK`
  (`collie build`), `SKIP_TESTS` (pre-push). One name per guard per surface, so skipping the
  staged-file lint for one commit cannot also disarm the full-tree gate in a build. The
  pre-commit hook's two guards were made **independent** in the same change: `SKIP_VERSION_CHECK=1`
  used to exit 0 out of the whole hook. They are listed together in `CLAUDE.md`.
- **CI lints before it installs `web/`, typechecks or tests**, right after the version-consistency
  step: lint is the cheapest thing that can fail, so it should be what a doomed run burns minutes
  on. `collie build` puts its lint step *after* the installs for the same reason inverted — oxlint
  lives in the root `node_modules`, so there is nothing to run before them.

**oxlint's bin carries a `#!/usr/bin/env node` shebang**, so `bun run lint` executes it under Node
whenever Node is on `PATH`. The Bun-native path was spiked anyway (`bun node_modules/oxlint/bin/oxlint`,
with Node shadowed): the `jsPlugins` loader loads the `.ts` plugin and its rules fire under either
runtime. No shim is needed, and no surface needs to care which runtime it got.

**Revisit** if a schema validator lands at the bridge's parse boundaries — that deletes the
`no-runtime-typeof` override list and is the intended end state, not a relaxation. Revisit the
PostToolUse hook if the pilot shows rote `// SAFETY:` comments (tighten the rule or drop it; do not
leave a gamed rule standing). Reopening "should we add ESLint/biome?" needs a rule oxlint cannot
express *and* cannot be given as a JS plugin — and it means re-taking the linter↔compiler coupling
this repo does not currently pay.
