# 0117: a steer is the person's choice, never the default

- **Status:** Accepted
- **Date:** 2026-10-23
- **Shipped in:** 1.24.0
- **Trail:** issue #579 · `bridge/surface/protocol.ts` (the header rule "Enter never steers a turn by accident", `steerTrusted`, `gateSteer`, `STEER_READS_MS`, `steerWitnessed`) · `web/src/lib/surface/profile.ts` (`keys.steer`, `keys.steerWitness`, `keys.steerDelayMs`) · `web/src/lib/surface/profiles/{pi,codex,omp}.json` · `web/src/lib/surface/send.ts` (`when`, `steered`, `steer_unsupported`, `steer_not_allowed`) · `web/src/lib/send-protocol.ts` (`noteKey`) · `web/src/components/composer.tsx` (the Steer row, `composer-steer-hint`, `AgentView.canSteer`) · `experiments/harnesses/steer-queue-2026-10-23.md` · `web/e2e/rig/steer.spec.ts` · `docs/multiplexers.md` ("Steer or queue") · [ADR 0101](./0101-a-control-on-a-screenless-pane-names-the-turn-it-saw.md) · [ADR 0110](./0110-two-release-lines.md)

## Context

A person can send a line to an agent while the agent works. Two things can happen to that line. A **queue** keeps it for after the turn. A **steer** puts it into the turn that runs now, and the agent reads it after its current tool call.

Collie has always queued. The header of the Send Protocol says it in one rule: Enter never steers a turn by accident. Where a harness steers on Enter, Collie presses another key (Alt+Enter on pi, Tab on Codex, Ctrl+Q on OMP). Where it has no queue key, Collie holds the send until the turn ends.

The harnesses differ, by their own docs (2026-10-23):

- pi, Codex, OMP, Muse, opencode and Devin steer on Enter and queue on a second key.
- Claude Code only queues. Its Ctrl+Enter is "send now" on a queued card, which Collie already offers.
- Grok queues on Enter. Its "send now" cancels the turn, so it is a stop and a send, not a steer.
- Kimi and Kiro toggle what Enter means. Collie cannot read the mode from the screen.

Issue 579 asks for a Steer choice on Codex. The reporter agrees that queueing is the right default. The gap is that a correction which must land in the current turn has no way in.

## Decision

**The plain Send tap keeps queueing on every harness. A steer is the person's explicit choice, made per send through the long-press row of the Send button, and nothing else steers.**

1. **The request.** `POST /api/send` takes `when: "steer"`. Absent, the send is exactly as before. The composer shows the row "Steer: the agent takes it after its current step" in the Send button's long-press menu only while the turn reads running and the pane view says `canSteer`. A short hint under the box says that a tap queues and a hold steers.
2. **The data lives in the profile.** `keys.steer` is the key list that delivers into the running turn. It exists only where `keys.enterWhileRunning` is `steers`, never holds Escape, and is never the queue key. `keys.steerWitness` is required with it: a list of witnesses, each a block, a transcript row or a marker row. A transcript witness counts only when it is new on the read after the key and no queued row holds the text. `keys.steerDelayMs` is the pause between the text and the steer key. Codex needs 1000 ms, because Enter straight after the text reads as one paste.
3. **The keys.** pi, Codex and OMP set `keys.steer: ["Enter"]`. A steer runs the same first read, dialog gate and draft check as a send. It types the text, waits `steerDelayMs`, and reads the screen once more. A dialog on that read (`dialog_open`), no box or a modal it cannot tell (`unreadable`), or the text gone from the box (`mismatch`) ends `typed_not_submitted` with no key. Otherwise it presses `keys.steer`, then reads at 0.4, 1.2 and 2 s for a witness. If the turn ended while the text went in, the keys of the queued path go out instead, and the receipt says `sent`.
4. **The receipts.** `steered` means a witness showed. `sent` with the queued flag means the harness kept the line for later. `typed_not_submitted` means the text is still in the box. `unknown` with `no_evidence` means no sign either way. The phone says each one in plain words.
5. **The refusals.** `steer_unsupported`: the pane has no `keys.steer`, the version is not trusted with a turn, the text is a command, or the pane is a durable one. `steer_not_allowed`: only a send that `POST /api/send` took from the phone sets the caller flag, so walky talky, hooks, the CLI and queued actions never steer. Both refuse before any read.
6. **A steer is never held.** It is for the turn that runs now, and a later turn is the wrong one. It does not wait behind held sends of the pane.

**Measured (2026-10-23, pi 1.3.0, Codex 0.164.0, OMP 18.6.1; 24 captures, `experiments/harnesses/steer-queue-2026-10-23.md`).** Enter steered on all three. None of them interrupted the running tool call. Each took the line after the call, in the same turn. A queued line ran as a second turn. The witnesses are the ones in the profiles: a `Steering:` row on pi, the line in the transcript with no `Queued follow-up inputs` header on Codex, and the line in the transcript with the `Backgrounded early` mark on OMP.

## Consequences

- A person who wants a correction in the current turn can say so, and a person who taps Send gets what they always got.
- An agent's text cannot steer. The walky talky skill and docs say so.
- A new harness gets the row by data: a profile with `keys.steer`, a witness and a capture. No code changes.
- Muse and opencode have the keys in their vendor docs and no capture yet, so they get no `keys.steer`. Claude, Grok, Kiro, Kimi and Hermes get none either: no steer key, or a mode Collie cannot read.
- Known limits. A long or multi-line steer may end `unknown`: no capture shows a long pi `Steering:` row, so the witness may not match a wrapped line. The receipt then says it does not know, and the text is not sent again.
- Known limit: the captures show each harness in its default configuration. If OMP or pi has a setting that makes a steer interrupt the running tool call, a person who turns it on changes what Steer does on that pane. Collie does not read that setting. The row's words promise only "after its current step", which the captures show.
- Known limit: the Codex steer is proven by a live rerun on the dev lane only. The browser leg's rig has no Codex harness yet (claude, pi and omp), so no leg case checks it on each release. A Codex rig harness is a follow-up.
- Steer is a new write path into a running turn. It stays small: one flag, one key list, one witness list, and the same guards as any send.
