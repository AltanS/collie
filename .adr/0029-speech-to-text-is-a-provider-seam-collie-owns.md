# 0029 — Speech-to-text is a provider seam Collie owns; Codex auth rides the operator's own binary

Status: **Accepted** (2026-08-23)

Supersedes: the decline reasoning of [#91](https://github.com/AltanS/collie/pull/91) (en-ver,
`openai-compatible` transcription) and [#115](https://github.com/AltanS/collie/pull/115)
(ardaaltinors, Codex-owned auth), and the "what is actually missing" question they were parked
behind in [discussion #118](https://github.com/AltanS/collie/discussions/118). Both PRs are
reinstated as the two providers below; the standing rule they were refused under is traded away
here, deliberately and only for operators who opt in.
Related: [ADR 0011](./0011-the-pack-protocol-is-the-mux-driver-seam.md) and
[ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the phone talks to the lead) ·
[ADR 0001](./0001-one-managed-front-door.md) (nothing new is published).

Note on numbering: #91 carried two ADRs of its own, `0011-one-openai-compatible-transcription-endpoint`
and `0012-synchronous-one-shot-voice`. Neither merged, and **both numbers are long since claimed by
other decisions**. They are not to be revived under those numbers; what survives of them is argued
here.

## Context

Voice input was refused twice, on one rule: **the bridge gains no provider credential, no outbound
network path, and no child process for speech.** That rule was cheap to hold while the ask was
speculative. It stopped being cheap. Two independent contributors shipped working implementations,
and the demand outlived both declines — the phone is a device with a microphone and no keyboard
worth the name, which is the whole premise of the product.

The remaining objection was never "voice is wrong". It was three concrete things: a secret in the
bridge's state, packets leaving the host, and a long-running child. Every one of those is a cost the
operator can decline by doing nothing.

#115 was refused for a fourth thing, and that one was not a cost — it was a lie. It reached
`https://chatgpt.com/backend-api/transcribe` wearing the Codex CLI's identity (`originator:
codex_cli_rs`) and the operator's own ChatGPT token, against a private endpoint, without saying so.
Silent impersonation is not a trade an operator can consent to, because they are never asked.

## Decision

**Collie owns a speech-to-text provider seam in `bridge/stt/`, off by default, switched on by a CLI
act. Two providers ship. The Codex provider borrows the operator's own `codex` binary for auth, and
it says out loud what identity it puts on the wire.**

- **The seam is the contract.** `bridge/stt/provider.ts` (the interface from #115) — audio in,
  transcript out. Providers are registered, not special-cased; a third one is a file, not a fork of
  the composer.
- **`openai-compatible`** (from #91): operator-supplied base URL and optional key. One provider
  covers the public OpenAI API, the cloud Whisper clones, and the local engines — a `whisper.cpp`
  server or `mudler/parakeet.cpp` (MIT) on the same machine is the *zero-egress* configuration, and
  the one to reach for first. **Do not document `badlogic/pibot`'s binaries as an install path: that
  repository carries no licence.**
- **`codex`** (from #115): Collie spawns the operator's own `codex app-server` and obtains a
  short-lived access token over JSON-RPC `getAuthStatus`. It **never reads and never stores
  `~/.codex/auth.json`** — the binary the operator already trusts stays the only thing that touches
  that file.
- **The wire identity is probed, then recorded.** At `collie stt setup` Collie asks the endpoint
  with an **honest User-Agent first**. Only if the endpoint refuses does it fall back to the Codex
  CLI's own headers, and **the fallback is written into the config** where the operator can read it
  later. That, plus a consent step in setup that names the risk in words — *your ChatGPT account
  absorbs the rate-limit and ban exposure; this endpoint is private and may break without notice* —
  is the entire difference between this and the thing #115 was declined for. **Brittle by design,
  and the docs say so.**
- **Onboarding is a CLI act, exactly like pairing.** `collie stt setup | test | status | off`.
  Config and key live in the bridge state dir at mode 0600; an env override is honoured for
  operators who template their config. There is no web setup form: a surface that mints a
  credential belongs on the keyboard, beside `collie pair`.
- **The web record button appears only when the bridge reports a configured provider.** An operator
  who never runs `stt setup` sees no button, ships no audio, spawns no child, and holds no key. The
  feature is absent, not disabled.
- **Lead-only, and the pack wire does not move.** The phone talks to the lead and to nothing else
  (ADR 0011, ADR 0013), and transcription is pane-agnostic — audio is not terminal state. So
  `/api/stt` on the lead serves a reply destined for *any* member's pane.
  [`PACK_PROTOCOL.md`](../PACK_PROTOCOL.md) is untouched, `PACK_PROTOCOL_VERSION` does not move, and
  `scripts/check-pack-wire.sh` (ADR 0025) has nothing to fire on. A peer needs no STT config to
  benefit from the lead's.
- **Hands-free is a toggle *through* the guarded reply path, never around it.** With it off, the
  transcript lands in the composer draft and the operator sends it. With it on, the send takes the
  same route a typed reply takes — the same adapter pre-flight, the same send verification. A
  transcript is text of unusually low confidence going into a real terminal; it is the last input
  that should get a shortcut past the guards.

## Consequences

- **The bridge gains its second class of long-running child process.** `codex app-server` joins the
  multiplexer spawns in `sessions.ts` — precedent, not a first. It is opt-in, it belongs to one
  provider, and an operator on `openai-compatible` never starts one.
- **The bridge gains its first deliberate outbound path, and it carries microphone audio.** This is
  the real cost of this ADR and it should not be softened: a Collie configured for a cloud provider
  sends room audio off the host. The local-engine configuration exists precisely so this is a
  choice, and the docs lead with it.
- **A credential now lives in the bridge state dir.** Same 0600/0700 discipline as pairing, and the
  Codex provider deliberately holds none — its token is short-lived and re-fetched.
- **The Codex provider will break.** A private endpoint owes us nothing. `collie stt test` exists so
  the failure is diagnosable in one command, and `stt status` reports which identity the config
  settled on.
- **The security posture line in [`CLAUDE.md`](../CLAUDE.md) is now conditional.** "The journal is
  the only thing that touches the filesystem" and "the bridge makes no outbound calls" both acquire
  an *unless the operator ran `stt setup`*. Say it that way; do not quietly drop the sentence.

### Alternatives considered

- **Keep declining.** The position was coherent and it lost on evidence: two working PRs and
  sustained demand, against a rule that costs a non-adopter nothing to relax.
- **Browser-native `SpeechRecognition`.** No host credential, no child, no bridge change — and on
  the phones that matter it is either absent, or it ships audio to the *vendor's* cloud anyway,
  which is the same trade with less operator control and no local-engine escape.
- **One provider only, `openai-compatible`, pointed at a local engine.** The clean answer, and it
  would have shipped #91 alone. Rejected because the Codex route needs no new account and no new
  key for an operator who already runs Codex, which is a large fraction of this audience.
- **Read `~/.codex/auth.json` directly** — simpler than spawning an app-server, and rejected: it
  makes Collie a reader of another tool's secret store, and it breaks the moment Codex changes that
  file's shape, silently and with a stolen-looking credential in flight.
- **Impersonate unconditionally, as #115 did.** Rejected. The probe costs one request at setup, and
  it is the difference between a trade the operator accepted and one made on their behalf.
- **A web-based setup flow.** Rejected: minting or pasting a provider key belongs on the same
  surface as `collie pair`, for the same reason.
- **Transcribe on the peer that owns the pane.** Rejected — it would put an STT config, a
  credential and an egress path on every member to serve a phone that only ever talks to the lead,
  and it would need pack wire to carry audio. Neither buys anything.

### What would justify revisiting

- **An on-device transcription path good enough on a phone.** That deletes the credential, the
  egress and the child in one move, and this ADR collapses to "the composer accepts a transcript".
- **Codex publishing a supported transcription interface.** The probe, the fallback and the consent
  paragraph all go away; the provider stays.
- **Evidence that operators enable STT by default.** If the opt-in stops being the thing that makes
  the cost acceptable, the cost has to be re-argued rather than inherited.
