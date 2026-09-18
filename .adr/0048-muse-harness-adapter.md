# 0048 — A harness adapter for Muse panes

- **Status:** Accepted (2026-09-18)
- **Date:** 2026-09-16
- **Amends:** [0047](0047-muse-panes-render-natively.md) — 0047 deliberately registered no
  adapter so the display fix could not smuggle in a reply-path change. This record decides
  whether, and how far, to take that step explicitly.

## Context

Muse panes in Collie sit at Tier 0 (raw mirror) plus 0047's display-only native
rendering: no chrome stripping, no statusline or draft resurfacing, no dialog lifts,
no journal reader, and the legacy one-shot reply path (`reply-action.ts`: no adapter
means type-and-submit in a single call, no composer pre-flight, no draft verification).

Every other agent with an adapter (`registry.ts`: claude, codex, grok, omp, agy,
antigravity) gets, at minimum, Tier 1: `buildBlocks` chrome work,
`extractStatusLines`, `extractInputDraft`, and the type-then-verify reply path with
`composerReady` / `composerPrompt` binding. Registering ANY adapter flips Muse off
one-shot sends — the behavioural change 0047 deferred. That flip is now the explicit
question, not a side effect.

Tier 2 (interactive dialog lifts) needs the full bar per dialog — dated corpus,
choreography notes, conformance run, maintainer live-verification — and Muse's
dialog inventory is not yet surveyed. A journal reader (bridge `journal/`, for the
History view) is a separate bridge-side contribution; Muse session logs exist on
disk (`~/.local/share/muse/sessions/…/*.jsonl`) but their schema is unstudied.

## Decision

- **D1 (Stage-1 scope): Tier 1 only.** A read-only adapter in the omp mould —
  raw-only blocks, chrome/status/draft probes, type-then-verify replies. Tier 2
  dialogs and the journal reader are deferred stages; each returns for its own
  interview before any implementation. (Settled in grilling 2026-09-16.)
- **D2 (Corpus coverage): everything, via scratch captures.** YOLO mode hides
  permission/approval prompts from the working pane, so those screens are captured
  from a scratch non-YOLO pane (fresh herdr tab, stock Muse, closed afterwards).
  The working pane is capture-source only and is never driven. (Settled in
  grilling 2026-09-16.)
- **D3 (Reply hardening): full.** `composerReady` pre-flight plus `composerPrompt`
  binding on top of draft-verified submit, with fail-open fallbacks (a failed
  pre-flight read falls through to type-then-verify; deliberate force retry skips
  the pre-flight). Confirmed after the composer walkthrough. (Settled in grilling
  2026-09-16.)
- **D4 (Scope widening): Tier 1 + Tier 2 in one stage.** Answering Muse questions
  from the phone is the primary pain, so the question UI ships with the adapter
  instead of following it. This supersedes D1's Tier-2 deferral; the journal
  reader stays deferred (bridge-side, separate interview). Consequence accepted:
  nothing merges until the full Tier-2 bar clears (corpus, choreography,
  conformance, maintainer live-verification), and any dialog the corpus shows to
  be unliftable falls back to raw under the fail-closed contract rather than
  blocking the rest. (Settled in grilling 2026-09-16.)
- **D5 (Tier-2 dialog list and build order).** Approval prompt → single-select
  question → multi-select question → trust prompt, all live-captured on Muse
  1.3.0 (`/tmp/muse-corpus/`, scratch pane, since closed) and render-verified in
  the pane view. Out: command palette, `/resume` picker, `/tasks` drawer,
  `/workflows` control room; network/peer approval variants ride along only if
  the corpus shows the same shape; plan approval has no dialog shape to lift.
  (Settled in grilling 2026-09-16.)
- **D6 (Upstream strategy).** Single combined PR: Tier 1 (adapter + rendering)
  and Tier 2 (question UI) review and merge as one unit, matching the one-stage
  build decision (D4). Accepted consequence: any Tier-2 review wrinkle holds up
  the Tier-1 rendering fixes too. (Settled in grilling 2026-09-18.)

## Consequences

- Muse panes leave one-shot sends for the guarded reply path: type-then-verify against the `❯`
  box, with a paste-token supplement for the per-line `[Pasted Content N chars]` collapse
  (probed: N in code points, threshold in (1000, 1200]).
- The four dialogs lift as native phone UI in D5 order; everything else (palette, `/resume`,
  `/tasks`, `/workflows`, plan approval) stays raw, guarded by type-then-verify rather than the
  pre-flight where the pre-flight cannot see.
- Signatures run question → dialog end with no transcript lookback (live spinner timers would churn
  it): two consecutive byte-identical dialogs share one signature, so a tap may land on the
  successor — the same command/answer already consented to. Stated, accepted, tested.
- The neutral multi-select model gains a `digit | pointer` choreography: Muse digits move the
  pointer (verified) where Claude digits toggle. Claude's detector fills `digit`; no behavior
  changes there.
- The journal reader stays a bridge-side follow-up (separate interview); the corpus (18 captures,
  Muse 1.3.0) is the evidence base, and maintainer live-verification against a real pane is the
  merge gate for the send path.

## Open questions

None — all five settled (D1–D6 above).
