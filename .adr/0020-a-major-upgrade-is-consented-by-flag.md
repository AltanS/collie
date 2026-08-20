# 0020 — A major upgrade is consented by flag; routine update follows tags within the installed major

Status: **Accepted** (2026-08-19)

Related: [ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md) — extended, not superseded:
`update` still advances the checkout in place, in whichever of the two shapes it was installed. Only
the **target** it advances to, and the gate in front of it, change here.

## Context

`cmdUpdate` (`cli/update.ts`) advances the checkout to **origin HEAD** — `git pull --ff-only` on a
linked clone, `fetch origin HEAD` + `checkout --detach --force FETCH_HEAD` on a Herdr-managed one.
The target is "whatever the default branch says right now". That was harmless while the default
branch only ever carried `0.x`.

It stops being harmless the moment `v1` merges to `main`. Every 0.x install in the field runs
`update` on a banner tap or a Herdr action, and lands on a **new major** without being asked.
`CLAUDE.md` defines MAJOR as *"the operator must change something"* — a config key renamed, a
contract broken, a workflow that used to work and now doesn't. A silent major is therefore a
contradiction in terms: the release says "you must act", and the mechanism gives the operator no
moment in which to act.

Nothing in the pipeline slows this down; it is fully automatic by design. Pushing a `v*` tag
auto-creates the GitHub Release (`.github/workflows/release.yml`), and the in-app banner reads the
repo's tags over anonymous HTTPS and compares the newest **strict** `vX.Y.Z` to the running version
(`bridge/update.ts`: `SEMVER_TAG = /^v(\d+)\.(\d+)\.(\d+)$/`, so `v1.0.0-beta.5` and every other
prerelease is already invisible to it). Tag `v1.0.0`, and within hours every 0.x phone shows an
update prompt whose one-tap remedy is the major crossing.

## Decision

**Routine `update` stays inside the installed major. Crossing a major is a separate, explicitly
flagged act.**

1. **`update` compares majors and refuses to cross one.** The installed major is read from
   `herdr-plugin.toml` — the canonical version file, the one Herdr reads and the one
   `scripts/check-version.sh` gates on. Same major as the target ⇒ proceed exactly as ADR 0006
   describes. Higher major ⇒ **refuse**, print what the new major is, and name the command that
   consents to it: `update --major`.
2. **The flag is the consent. There is no interactive prompt.** A Herdr plugin action runs with **no
   TTY** — and that is not an edge case, it is the documented path: every user-facing update
   instruction in this repo is `herdr plugin action invoke update --plugin herdr.collie`, and the
   phone banner has no terminal at all. A confirm that only a shell can answer would make the major
   upgrade unreachable from the surface that announces it. A flag is answerable from both.
   *Deliberate contrast with `pack update`, which has an interactive-only confirm and no `--yes`
   ([ADR 0016](./0016-updates-ride-the-operators-ssh.md)): that verb rebuilds **another** machine, so
   a human at a terminal is the whole point. This one upgrades the operator's **own** install, from a
   banner, over a non-TTY action. Same word, opposite constraint.*
3. **The target is the highest release tag within the installed major, not origin HEAD.** A `0.x`
   install resolves the newest `v0.*`; a `1.x` install the newest `v1.*`; `--major` resolves the
   newest tag of the next major. This kills the class rather than one instance of it: `main` may
   advance freely without shipping itself to anybody, an install deliberately rolled back no longer
   snaps forward to the tip on its next routine update, and prerelease tags stay out of reach — the
   same strictness the banner already applies, now applied by the verb that acts on it.
   **Tag-following is the MANAGED shape's mechanism; the gate covers both.** A detached checkout has
   nothing to keep, so it is pointed straight at the release tag and target selection *is* the gate. A
   linked clone keeps its branch and its `git pull --ff-only`: detaching it onto a tag would undo the
   shape it was installed in and cost it the re-link ADR 0006 reserves for exactly that shape. Its
   gate is therefore a pre-flight — fetch, read `herdr-plugin.toml` at the branch's own upstream
   (`@{u}`, exactly the commit the pull will take — never `FETCH_HEAD` of `fetch origin HEAD`, which
   names the remote's *default* branch and diverges from `@{u}` on any clone kept on another branch),
   compare majors, and refuse before anything is pulled. Two mechanisms, one rule: no install crosses a major
   unasked.
4. **The gate ships in one final 0.x release — 0.32.0, cut from `main` *before* `v1` merges.** Only
   code in the **old** binary can protect an old install; a guard that first exists in 1.0.0 has
   already been crossed by the time it runs. Sequence, in order: ship 0.32.0 → an adoption window
   whose length the operator judges → merge `v1` to `main` → tag `v1.0.0`.
5. **After 1.0, `0.x` is frozen, not maintained.** Critical fixes only, cherry-picked and tagged
   `v0.32.x`. Tag-following installs receive them by the same rule as (3), which is what makes the
   freeze survivable rather than a dead end.

> **Amended (2026-08-20, the v1 beta train).** Two facts follow from the Context's parenthesis about
> `SEMVER_TAG` rejecting prereleases, and are recorded here because they are accepted, not incidental:
>
> - **The betas are invisible to the banner by design.** For the whole `v1.0.0-beta.N` train, no
>   install — 0.x or 1.x — is offered an update. The code stays as it is: a beta is taken by an
>   operator who went looking for it, never by a tap. Nothing is lost, because the crossing this ADR
>   gates is consented to by `--major` anyway; the banner may offer, only the operator crosses.
> - **The `v1.0.0` release notes MUST carry the migration section.** That release is the *first and
>   only* notice a 0.x user ever receives, so the `Upgrading` block named in the first Consequence
>   below is not optional there — it has no earlier notice to lean on.
>
> Two mechanics support this. A prerelease tag is now published as a GitHub **prerelease**
> (`.github/workflows/release.yml`), so it cannot take the Latest badge from the shipped 0.x line; and
> because `releases/latest` therefore keeps answering the old stable tag for the whole train, anything
> resolving "the newest Collie" must read git tags instead — README → *Resolving the newest release
> from a script*.

## Consequences

- **An install that never takes 0.32.0 is not protected.** It is still pointed at origin HEAD and
  will cross the major on its next update. The adoption window is the accepted mitigation, and it is
  the only one available — this is the same shape as ADR 0006's "a fix shipped inside the checkout
  can't repair the checkout that can't update", and it has the same answer: state it in the CHANGELOG
  `Upgrading` block that the release workflow renders onto the page the banner links to.
- **`update` no longer means "the tip of `main`".** It means "the newest release of the major you are
  on". That is a narrowing, and it is the point; `main` becomes a place work can land without
  becoming a rollout.
- **Two ways to be behind now exist** — behind within your major (routine `update` fixes it) and
  behind by a major (only `--major` fixes it). The banner must say which, or the operator taps update,
  sees it succeed, and still sees a banner.
- **0.x users must act once, on purpose, to reach 1.0.** That is exactly what MAJOR is defined to
  mean, so the cost is the feature.

### Alternatives considered

- **Keep `main` on 0.x, or run two long-lived release lines.** Permanent double maintenance — every
  fix judged and possibly backported forever — and `main` stops being the default truth, which is the
  one property that makes every other workflow in this repo cheap.
- **An interactive confirm inside `update`.** Dies on the no-TTY Herdr action path, which is precisely
  the path every update instruction we publish tells the operator to use. It would gate the upgrade
  behind the one interface the announcement can't reach.
- **A channel or pin file** (`stable` / `next`, or a pinned `--ref` recorded on disk). More state than
  the problem has: the installed major *is* the channel, tags already encode it, and a file adds a
  thing that can disagree with `herdr-plugin.toml` — which the version gate then can't see.
- **Consent through the banner UI alone** — have the frontend hide or re-label the prompt across a
  major. The banner is advisory and read-only by construction; the verb is where the mutation happens,
  it is invokable from a shell and a Herdr action with no UI in the loop, and a gate that only exists
  in the UI is not a gate. The banner should get the wording; it must not be the enforcement.

### What would justify revisiting

- **Herdr growing a real refresh verb** (see ADR 0006's revisit note). If the plugin manager learns to
  resolve a version constraint itself, target selection moves there and this ADR keeps only its rule:
  a major is consented to, never inherited.
- **Evidence that operators are stranded on a frozen 0.x** in numbers, rather than by choice — which
  would argue for a real backport policy, not for reopening the silent crossing.
- **A second major crossing** (2.0). Nothing here is 1.0-specific; if the mechanism proves noisy in
  practice, the place to fix it is target resolution, not the gate.

Out of scope: a global-PATH `collie link` — a different problem (where the binary lives), and it gets
its own ADR.
