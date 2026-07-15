# Adding a harness adapter

Collie up-levels an agent's terminal dialogs (permission prompts, AskUserQuestion menus, plan
approvals, …) into native phone buttons. The per-agent knowledge that makes this safe lives in a
**harness adapter**. Claude Code is the one verified adapter today; this is how you add another
(codex, pi, opencode, …).

Read first: [`ARCHITECTURE.md`](./ARCHITECTURE.md) (the interaction loop + security model),
[`HERDR_API.md`](./HERDR_API.md) (the verified socket + `pane.send_keys` key grammar), and
[`web/src/fixtures/panes/README.md`](./web/src/fixtures/panes/README.md) (the fixture corpus).

## Architecture in one paragraph

An adapter is a [`HarnessAdapter`](./web/src/lib/harness/types.ts) —
`{ agent, buildBlocks, extractStatusLine, extractInputDraft }` — registered by its Herdr `agent`
string in [`web/src/lib/harness/registry.ts`](./web/src/lib/harness/registry.ts). The registry is the
single decision site for "which agents get grammars"; every agent absent from it keeps the universal
raw terminal mirror. Claude is the reference adapter, under
[`web/src/lib/harness/claude/`](./web/src/lib/harness/claude/): its detectors (prompt-select, wizard,
preview-select, chrome, markers) are **pure functions over `StyledLine[]`** — no pane access, no
network. Detection only says "this dialog is on screen"; the keystroke recipes and the race-guard
that actually types live elsewhere. [`guard.ts`](./web/src/lib/harness/guard.ts) is the **only** module
in `harness/` allowed to touch the network (it re-fetches the pane before a guarded keystroke) — a
**capability fence** (see below) enforces that every other harness module stays I/O-pure, because a
socket call types into a live terminal.

## Fixtures-first workflow

Detectors are developed and gated entirely against **byte-faithful pane captures** — never guessed
from screenshots. The loop:

1. In a **sandbox pane** (a scratch agent, never a real work session), drive the agent into the dialog
   state you want to lift.
2. Capture it byte-for-byte:
   ```sh
   scripts/capture-fixture.sh <paneId> <name>   # paneIds: GET /api/snapshot
   ```
   The capture is real terminal output and **this repo is public** — review every file for secrets
   before `git add` (`less -R`), per
   [`web/src/fixtures/panes/README.md`](./web/src/fixtures/panes/README.md).
3. Write a **pure detector** over `StyledLine[]` and test it against the fixture through the real
   `parseAnsi → splitLines` pipeline (copy the shape of
   [`claude/prompt-select.test.ts`](./web/src/lib/harness/claude/prompt-select.test.ts)). Anchor
   detection on the **buffer tail** — a dialog that has scrolled up (real output below it) must not
   match. That tail invariant is the core false-positive guard.

## The capability tier ladder

An adapter earns capability incrementally. Ship a lower tier first; each is independently useful.

- **Tier 0 — raw mirror.** Every agent gets this for free: the colored terminal mirror + slash palette
  + special-keys pad. No adapter needed. It already works.
- **Tier 1 — read-only lift.** Chrome/status/draft extraction (`extractStatusLine`,
  `extractInputDraft`) plus **detection of a NEW, not-yet-wired block kind** — recognised and drawn,
  but with no keystroke recipe behind it, so taps send **no keystrokes**. Mergeable **from fixtures
  alone**: a mis-parse only costs cosmetics because there is no send path to fire into a terminal.
  **Caveat:** this holds only for a brand-new kind. If your adapter emits an EXISTING interactive kind
  (`prompt-select` / `wizard` / `multi-select`), its keystroke recipe is already live, so those taps
  go hot the moment your detector matches — that is automatically **Tier 2** and must clear the full
  Tier-2 bar below (corpus, notes, conformance, live-verification), not the read-only one.
- **Tier 2 — interactive.** Wiring taps to keystrokes (the buttons go hot). This is the bar that types
  into a real shell, so it requires **all** of:
  - a **dated fixture corpus** covering the dialog's states,
  - a **choreography notes file** documenting the verified keystroke recipe (à la
    [`web/src/lib/grammar/WIZARD_NOTES.md`](./web/src/lib/grammar/WIZARD_NOTES.md)),
  - a green **`describeAdapterConformance`** run (the CI gate, below), and
  - **maintainer live-verification against a real pane** before the send path is enabled.

### The fail-closed contract (non-negotiable)

**A detector MUST return `null` on anything it does not confidently recognise.** A partial lift is a
bug, not a nicety — it types a keystroke into a live terminal. When in doubt, fall back to the raw
mirror; the user can always drive Tier 0 by hand. Never up-level a dialog you can't fully model (e.g.
a menu numbered past 9, whose option would need the unsendable key `"10"` — bail to raw instead).

## The two gates

- **CI gate — the conformance suite.**
  [`web/src/lib/harness/conformance.ts`](./web/src/lib/harness/conformance.ts) exports
  `describeAdapterConformance(adapter, { ownFixtures, foreignFixtures, neutralFixtures })`. Call it
  from your adapter's `*.test.ts` (see
  [`conformance.test.ts`](./web/src/lib/harness/conformance.test.ts)). It asserts three invariants:
  conservative detection (raw-only on foreign + neutral buffers), tail-anchoring (a dialog lifts only
  at the tail), and key-grammar validity (every emittable keystroke passes `isValidHerdrKey` — the
  verified `pane.send_keys` grammar: single-digit only, `ctrl+c` not `C-c`, no
  `PageUp`/`Home`/`End`/`Delete`).
- **Safety gate — the capability fence.** The live enforcement is
  [`web/src/lib/harness/fence.test.ts`](./web/src/lib/harness/fence.test.ts): it fails the build if any
  module under `harness/` except `guard.ts` imports the network API (`@/lib/api` or a relative
  `…/api`), matching the specifier anywhere in the file so a Prettier line-wrapped import can't slip
  through. It runs under `bun run test` (which the pre-push hook runs). The `no-restricted-imports`
  rule in [`web/eslint.config.mjs`](./web/eslint.config.mjs) encodes the same fence but is
  **aspirational** — no ESLint runner is wired yet, so it does not execute; the test is the real gate.

Run both — and the full suite — with `cd web && bun run test`; typecheck with `bunx tsc --noEmit`.
