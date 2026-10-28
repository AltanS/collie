# 0125: the browser leg replays recorded model streams

- **Status:** Accepted
- **Date:** 2026-10-26
- **Shipped in:** unreleased (1.25.0 candidate)
- **Trail:** M67 `browser-leg-replay` (counsel of 2026-10-21, specs 03 and 04) · `web/e2e/rig/replay/`
  (`cassette.ts`, `stub.ts`, `tier.ts`, `report.ts`, `check.ts`) · `web/e2e/rig/harnesses.ts` ·
  `web/e2e/rig/rig.ts` · `web/e2e/rig/leg.ts` · `web/e2e/rig/global-setup.ts`, `global-teardown.ts` ·
  `web/e2e/rig/nightly.ts` (the row's `tiers`) · `web/e2e/rig/replay-stub.test.ts` · the recordings under
  `web/e2e/rig/cassettes/` · probes of 2026-10-26 under `~/.cache/collie-lab/m67/`

## Context

The browser leg is the gate before every tag and the proof for a change to a reader, the Surface, the
Send Protocol or the ask code. It proves one thing: a tap on the phone works the first time against the
real harness screen, and the screen shows the result. The model's reasoning is not under test. Yet every
run paid for it: about 11 pi and 9 omp Haiku turns on OpenRouter per solo leg, about $0.65 for a full
nightly run, and the nightly ritual was paused on 2026-10-20 for that cost. A paused gate proves nothing.

The counsel of 2026-10-21 (two advisors, the same answer, Altan accepted) was to fake the model and keep
the agent. Rejected then and still: a PTY recording replayed into Herdr (it cannot react to a keystroke,
so it proves nothing about a tap), a tiny local model (flaky, not deterministic), and prompt caching as
the main lever. Claude Code stays live, because a base URL override changes its auth path and its screen.

Probed on 2026-10-26 with an empty cassette and no key: pi 1.3.0 keeps the catalog's own base URL for a
Claude model over a `models.json` `baseUrl`, but a provider an extension registers wins over both; omp
18.6.1 takes `providers.openrouter.baseUrl` from `models.yml`. Against an HTTP 599, omp sent the same
request 30 times in 90 s. Against a 422, pi and omp each sent one request, ended the turn, and printed the
body's message.

## Decision

**Replace only the model behind pi and omp.** The rig daemon starts a stub on 127.0.0.1 (a free port in
the rig's range) before the first harness and stops it with the rig. pi's base URL goes to it through a
provider extension, omp's through `models.yml`, on a path that names the instance (`/pi-lead/api`,
`/omp-member/api/v1`). The real binaries, the real TUI in a real Herdr pane, the real bridge and the real
Chromium phone stay. Claude Code is not routed through the stub.

**A cassette is a recorded stream, never a request.** One file per (harness, version, case):
`web/e2e/rig/cassettes/<harness>/<version>/<case>.jsonl`, a header line, then one entry per model
request: its kind (`turn` with tools, `side` without), the machine, the ordinal, the request SUMMARY (wire
format, model, stream flag, tool names, the last prompt's text normalised, the kinds of the items after
it) with its digest, and the response: status, content type, and the server-sent events, each with its
delay after the one before. `meta.json` per version names, per leg, the model, the walky talky skill
hash and the cases. No header is stored, so no key and no Authorization header can reach a file, and
`bun run e2e:recordings:check` fails on a key pattern, a bearer token, an Authorization or x-api-key
header, or a home folder path. omp's Responses stream echoes the request's `instructions` and `tools`
in its `response.created`, `response.in_progress` and `response.completed` events (about 30 KB each);
the recorder keeps the events and empties those two fields. The leg tells the stub each case's verdict,
and `meta.json` lists under `failed` every case recorded in a live run where it did not pass, so a
replay that fails on one says to record that case again, alone.

**Matching: case and ordinal first, the digest as the check.** The leg tells the stub which case runs
(`POST /_rig/case`). A turn request is served the first unused turn of its case and machine whose digest
equals the request's. Next it may take an unused turn with the same digest from another case of that
harness (a request that left the harness just across a case boundary). A side request (a title, a
summary) is matched by digest from the leg's pool. Anything else is a cassette mismatch: HTTP 422 with
`cassette_mismatch` and the words "re-record", and the case fails with that note first. It is never a
nearby answer. The digest ignores, as data (`VOLATILE` in `cassette.ts`): walky talky ids, pane
addresses with their tokens, bare pane addresses, uuids, dates and times, wall clock times, 127.0.0.1
ports, and the rig's state root, the checkout and the home folder. A recorded answer names those values
by placeholder (`{{walky:0}}`, `{{lab}}`), ranked by their last place in the request, and a replay puts
the live request's value of the same class and rank back in. The rewrite follows a value across event
boundaries.

**Pacing is recorded.** A replay sends each event after its recorded delay, so streaming and busy
detection see real timing. `COLLIE_RIG_REPLAY_SPEED` divides the delays and is never below 1.

**The version picks the tier.** The global setup reads each harness's `--version` once. A harness with a
recording for (version, leg, model, skill hash) replays: the stub has no upstream path for it, the start
script gets a dummy key and does not open the key file, pi gets no `auth.json` and omp no `agent.db`.
Without one, it runs live through the stub, and with a key file it records, so the next run replays.
`COLLIE_RIG_MODEL=replay` stops the run before anything starts when a recording is missing,
`COLLIE_RIG_MODEL=live` or `COLLIE_RIG_LIVE=pi,omp|all` forces live, and `COLLIE_RIG_RECORD=1` records a
forced live run. A version that cannot be read never records. The leg prints each harness's tier, the
live turn count and the requests sent to OpenRouter, writes them to the run's `model.json`, and the
nightly ledger row keeps the tiers.

## Consequences

- A solo leg on replay costs no OpenRouter turn. It still costs the Claude Code turns on the subscription.
- A harness version bump costs one live run, which records. The first recording run (2026-10-26, pi
  1.3.0 and omp 18.6.1) sent 44 requests to OpenRouter (pi 21, omp 23) and wrote 22 files, 2.3 MB.
  Three of its cases did not pass and are marked: pi case 8 (Haiku refused the walky send under the
  skill's rules), omp case 1 (a probe that failed before any model call) and Claude case 16 (whose omp
  calls were recorded). The recordings are commits like fixtures: a
  person reads the diff and runs the check before committing them.
- What a replay no longer proves: that the model still follows the walky talky skill, and that OpenRouter
  answers. A live run proves those on each new version. Spec 05 owns the guard against a replay that
  keeps passing after a reader breaks.
- Matching on the first unused entry with the same digest, not strictly on the Nth request, departs from
  spec 03. A reorder of two different requests still matches; a changed prompt, tail or tool list does
  not. A mismatch is 422, not the 599 of spec 03, because a 5xx is retried.
- The nightly runner checks out a clean clone each run, so recordings it writes there are lost. Until
  spec 04 hands them back, the nightly replays only what the checked-in recordings cover.
- Revisit when Claude Code can take a base URL without a new auth path or screen, or when a harness
  moves its model calls off a base URL the rig can set.
