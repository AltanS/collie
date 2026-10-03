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
[ADR 0001](./0001-one-managed-front-door.md) (nothing new is published) · a third provider,
`local-cli`, is recorded in the
[Addendum — 2026-10-03](#addendum--2026-10-03-a-third-provider-runs-the-operators-own-command)
below ([#227](https://github.com/AltanS/collie/issues/227))

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
  [`PACK_PROTOCOL.md`](../CREW_PROTOCOL.md) is untouched, `PACK_PROTOCOL_VERSION` does not move, and
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

## Addendum — 2026-10-03: a third provider runs the operator's own command

Status is unchanged: **Accepted**. Nothing above this line is rewritten. This addendum records the
third provider the seam was built to take, and the one cost it adds.

[#227](https://github.com/AltanS/collie/issues/227) (@SubodhDahal) asked for an operator who already
runs an on-device engine behind a command line (Muesli's `muesli-cli transcribe <file>`, a
`whisper-cli` build) not to have to stand up an HTTP server just to reach `openai-compatible`.
`local-cli` is that provider: `bridge/stt/local-cli.ts`, one arm in `bridge/stt/index.ts`, and
nothing in the composer, the route or the wire moved. That is the "a file, not a fork" sentence
above, kept.

**The cost: on this provider the bridge spawns a child as the bridge user for every dictation.**
It is short-lived, one per recording, unlike the `codex app-server` above, and it runs whatever the
operator named, so it runs with everything that user can do. The bounds that make it acceptable sit
in the module header, and in short:

- **argv, never a shell.** `Bun.spawn([command, ...args, tempPath])`. Nothing is expanded or globbed.
- **The operator's words only.** `command` and `args` come from `stt.json` (0600, written by
  `collie stt setup`) or the deployment's environment (`COLLIE_STT_COMMAND`; `args` is file-only). A
  request contributes the recording's bytes and nothing else. The temp file's name and extension are
  Collie's, and the extension is narrowed again before it becomes part of a path.
- **A private temp dir** (0700, the file 0600), removed in `finally` whatever happened.
- **The same 60 s deadline** as `openai-compatible`, enforced with SIGKILL, a 256 KiB stdout cap,
  and **no stderr, command line or path ever reaches the phone**: an `SttStatus.reason` or a
  refusal is Collie's own sentence and, at most, an exit status.
- **No `COLLIE_*` variable is passed to the child**, so the push keys and another provider's key do
  not ride along. Everything else in the bridge's environment IS passed: `PATH`, `HOME`, the locale,
  and any other key the service runs with. That is deliberate, because it is the operator's own
  command and it may need them to find its model, but it means a non-`COLLIE_` secret in the
  bridge's environment reaches the command too.
- **The whole process tree dies, not just the child.** On Linux and macOS the child is spawned
  `detached`, so it leads a process group of its own, and every kill is `kill(-pgid, SIGKILL)`: at
  the deadline, at the stdout cap (at once, not at the deadline), on a cancelled caller, and after a
  clean exit, so a grandchild cannot outlive the call. A helper that must stay up has to leave the
  group itself (`setsid`). Windows has no group to kill by a negative pid; there the child alone is
  killed, and a grandchild it started may outlive it. The code says so where it branches on the
  `Host`.
- **At most two children in flight per bridge**, the same number the route's admission already
  allows, and the number the phone's catalogued busy sentence says in every language. The provider
  holds its own count because the route frees a slot when the caller disconnects, while the child
  may still be dying: the provider frees its slot only when the child has exited. A request over the
  cap gets the route's `429 stt.busy` before any temp file or spawn.
- **The command must be a regular, executable file.** Symlinks are followed, so the check is on the
  target. `collie stt setup` refuses anything else and `collie stt status` says which check failed,
  on the host; the phone's capability only ever reads "cannot be run".
- **Stale temp dirs are swept** once per process when the provider loads: only directories named
  `collie-stt-…` directly under the OS temp dir, not symlinks, owned by this user, and more than an
  hour old, which no live call can be. Not on Windows, which has no uid to check ownership by.

**Where `command` and `args` can come from, confirmed 2026-10-03.** Only `stt.json` in the state dir
(0600, written by `collie stt setup` on the host's own keyboard) and the bridge's environment
(`COLLIE_STT_COMMAND`, which a `config.toml` `[stt]` key also feeds, under the environment). `args`
has no environment spelling. A grep of `bridge/server.ts` finds exactly two STT touch points, and
neither writes: `POST /api/stt`, which reads the settings through the gate and transcribes, and
`GET /api/config`, which reports the capability. No route writes `stt.json`, `config.toml` or any
STT setting. The one file write in `server.ts` is `/upload`, into `<stateDir>/uploads/` under a name
the bridge generates, which cannot be `stt.json`. So no request, and no route a paired phone can
reach, can name the command or its arguments; the phone contributes the recording's bytes only.

Egress is the operator's command's business: a local engine keeps the audio on the host, which is
the configuration this ADR already leads with. Setup stays a CLI act, and nothing about the
lead-only rule, the hands-free rule or the absent-until-configured rule changes.

