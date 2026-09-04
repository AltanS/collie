# Voice input and Web Push

Both features are disabled by default. You can enable a microphone button in the composer, and
browser notifications that trigger when an agent is waiting for input.

## Voice input (optional)

A **microphone button in the composer**, and a **hands-free switch** in Settings. Tap the button,
speak, and the transcript lands in the message box for you to read and send. With hands-free on it is
sent for you — down the same guarded reply path a typed message takes, never around it.

The microphone **is** the round button at the end of the row, for as long as the box is empty; the
first character you type turns it back into Send. You dictate a message or you type one, so there is
one primary action rather than two competing for the width of the field.

**It does not exist until you run `collie stt setup`.** No button is drawn, no audio leaves the
phone, no credential is held, no child process runs. Absent, not disabled. Two providers:

| provider | what it is |
| --- | --- |
| **`openai-compatible`** | Any endpoint that speaks `POST /audio/transcriptions` — the public OpenAI API, a cloud Whisper clone, or **a local engine on the same machine, which is the zero-egress choice** ([below](#zero-egress--point-it-at-your-own-engine)). |
| **`codex`** | Borrows the `codex` binary you already trust for a short-lived token. No new account, no new key — and a **private, unsupported** endpoint that carries a consent step you have to type `yes` to ([below](#the-codex-provider--what-you-are-accepting)). |

Setup is a CLI act for the reason [pairing](security.md#pair-a-device--the-write-credential) is one: this
surface accepts a credential, so it belongs on the host's keyboard. There is no web setup form.

```console
$ bin/collie stt setup
Which speech-to-text provider?
  openai-compatible  any endpoint that speaks POST /audio/transcriptions —
                     the public OpenAI API, or a local whisper.cpp / parakeet.cpp
                     server, which is the zero-egress choice and the one to prefer.
  codex              borrow your own `codex` sign-in. No new key, no new account —
                     and a private endpoint that may break without notice.
provider [openai-compatible]:
The API base, INCLUDING its version prefix — the provider appends /audio/transcriptions.
  local  http://127.0.0.1:8080/v1     (whisper.cpp / parakeet.cpp — nothing leaves the host)
  cloud  https://api.openai.com/v1    (room audio leaves this machine)
base URL: http://127.0.0.1:8080/v1
The model the endpoint understands. Empty takes Collie's default, gpt-transcribe.
model [gpt-transcribe]: whisper-1
API key [none]:
The language you speak, as a two-letter ISO-639-1 code — en, de, tr, ja.
LEAVE IT EMPTY to let the model detect it, which is what you want if you mix languages in one
sentence. Name one only if short clips keep coming back in a language you did not speak: a few
seconds of accented audio is too little for the model to detect from, and it guesses.
spoken language [auto-detect]: en
✓ speech-to-text configured — /home/you/.local/state/collie/stt.json (owner-only)
  Live immediately — no restart needed. The bridge re-reads this file per request.
  Check it end to end with `collie stt test`.
```

Every question above has a flag (`--provider` · `--url` · `--model` · `--key` · `--lang`), so a
provisioning run needs no terminal. Leaving the key empty is a supported mode — a keyless endpoint is
dialled with no `Authorization` header at all, rather than an empty one.

**The spoken language is worth setting only for one failure.** Left blank — the default — the model
detects the language itself, which is what someone who mixes two languages in a sentence needs. Set
it if *short* clips keep coming back in a language you did not speak: a few seconds of accented audio
is too little to detect from, and the model guesses. A two-letter code, or a regional tag Collie
narrows for you (`en-GB` → `en`). It rides on the `openai-compatible` provider only; the `codex`
endpoint takes no language, and `collie stt status` says so rather than letting you believe otherwise.

**A long recording gets a long deadline.** The browser's budget for one clip is a function of that
clip's size, not a flat number — it assumes a sustained 256 kb/s uplink and adds the bridge's own
provider deadline on top, so the 8 MiB maximum is allowed a little under six minutes. A clip Collie
was willing to record is a clip it is willing to wait for. While the upload is in flight Collie stops
polling and stops escalating the connection banner: your own audio saturating a phone's uplink is not
an outage, and it must not be reported as one.

**Did it work?** `stt test` sends a fifth of a second of generated silence through the real
provider, once per container a phone can record:

```console
$ bin/collie stt test
provider: openai-compatible (http://127.0.0.1:8080/v1, model whisper-1, language en)
sending:  0.2 s of generated silence as audio/wav (the setup probe) … ✓ 214 ms
  transcript: (empty) — expected from silence, and the empty answer still proves the pipeline.
sending:  0.2 s of generated silence as audio/webm;codecs=opus (Chrome, Android, Firefox) … ✓ 198 ms
sending:  0.2 s of generated silence as audio/mp4 (Safari, iOS) … ✓ 190 ms
```

An **empty transcript is a pass** — silence transcribes to nothing, and the round trip is what was
being proved. If it fails, the error names its kind (auth, endpoint, response shape). Then reload
Collie on the phone: a microphone sits beside the message box. `collie stt status` says what is
configured and *where each setting came from* (the file, or an environment variable that outranks
it); `collie stt off` removes `stt.json` and the button is gone again, no restart either way.

### Container support is provider-specific

The phone never records WAV. It records Opus in a WebM container on Chrome, Android and Firefox, or
AAC in an MP4 container on Safari and iOS, and it sends those bytes as they are. A provider that
transcribes WAV can still answer 400 to both of them, and every dictation then fails with "refused"
while `stt test` looks healthy. That is why `stt test` sends all three clips: the refusal is found at
setup, not on the phone.

One case, verified on 2026-09-01 against OpenRouter's `POST /v1/audio/transcriptions`:

| format      | `mistralai/voxtral-small-24b-2507-stt` | `openai/whisper-large-v3-turbo` |
| ----------- | -------------------------------------- | ------------------------------- |
| wav         | yes                                    | yes                             |
| ogg/opus    | yes                                    | yes                             |
| webm/opus   | no, 400                                | yes                             |
| mp4/m4a AAC | no, 400                                | yes                             |

The workaround is the model, not the key: point the same OpenRouter key at
`openai/whisper-large-v3-turbo`, which takes all four.

```bash
bin/collie stt setup --provider openai-compatible \
  --url https://openrouter.ai/api/v1 --model openai/whisper-large-v3-turbo --key <key>
```

A refused transcription now names the upstream status and the container it was sent as, so the error
on the phone says which format the provider rejected. (#148, thanks @drewbitt)

### Zero-egress — point it at your own engine

The reason `openai-compatible` is the provider to reach for: give it a local base URL and **no room
audio ever leaves the host**. Two engines serve an OpenAI-compatible transcription endpoint —
[**whisper.cpp**](https://github.com/ggml-org/whisper.cpp)'s bundled `server`, and
[**mudler/parakeet.cpp**](https://github.com/mudler/parakeet.cpp) (MIT). Build or install either by
its own instructions, run it on loopback, and point `--url` at it:

```bash
bin/collie stt setup --provider openai-compatible --url http://127.0.0.1:8080/v1
```

That is the whole integration — Collie has no opinion about which engine answers.

**Mistral's Voxtral needs no support of its own**, and neither does anything else that speaks this
contract — that is the point of the seam. vLLM serves the open-weights Voxtral models on
`/v1/audio/transcriptions`, so a local one is the same `--url` as any other engine. The hosted models
are the same request at Mistral's own base:

```bash
bin/collie stt setup --provider openai-compatible \
  --url https://api.mistral.ai/v1 --model voxtral-mini-latest --key <key> --lang en
```

Voxtral Mini Transcribe covers 13 languages and takes the same ISO-639-1 `language` field Collie
already sends. Prove it with `collie stt test` before you trust it — "OpenAI-compatible" is a claim
each endpoint makes for itself, and that verb exists to check it.

### The codex provider — what you are accepting

`collie stt setup --provider codex` prints a consent block and stops until you type `yes`, because
the honest sentence is this: recordings go to an **undocumented, unsupported ChatGPT endpoint**
authorised by *your* sign-in, so your ChatGPT account carries the rate-limit and ban exposure, and it
may break without notice.

Collie asks that endpoint **under its own name first**. Only if the honest identity is refused does
it fall back to the Codex CLI's headers — and that fallback is written into the config, in a word
`collie stt status` reads back to you. Collie never reads or stores `~/.codex/auth.json`; the binary
you already trust stays the only thing that touches it.

The reasoning for all of the above — why this was declined twice, what changed, and why the seam
looks like this — is [ADR 0029](../.adr/0029-speech-to-text-is-a-provider-seam-collie-owns.md).


## Web Push (optional)

Disabled by default. Setup requires three steps. The sender library (`web-push`) is included as an
optional dependency during the build:

```bash
collie push-keys     # 1. generate + write the VAPID keys
collie restart       # 2. Collie reads them at start
#                      3. on your phone: Settings → notifications
```

The `push-keys` command generates the keypair and writes `COLLIE_VAPID_PUBLIC` and
`COLLIE_VAPID_PRIVATE` with file mode 600 to the active `.env`, which is `~/.config/collie/.env` on
a binary install or the one in Herdr's plugin config dir on a Herdr install.

Pass a contact URI as an argument to set the RFC 8292 subject claim:

```bash
collie push-keys mailto:you@example.com
```

On Herdr-managed installs, both steps are available as actions
(`herdr plugin action invoke push-keys --plugin herdr.collie`, and `restart`). Herdr actions do not
accept positional arguments, so setting a subject requires running the command directly in the
shell.

Key handling details:

The command refuses to overwrite existing keys unless you pass `--force`. Replacing keys invalidates
all current subscriptions, requiring every device to resubscribe before it can receive notifications
again. Providing a subject argument on an existing configuration updates only the contact address
and preserves the current keys.

> **On Herdr versions before 0.8.0**, actions remain fixed to the set cached during initial plugin
> installation ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)). The
> `push-keys` and `push-test` actions will not appear until you run `herdr plugin install`. Run
> `bash scripts/collie-ctl.sh push-keys` directly instead. The wrapper script passes the command
> directly to the binary.

Test the delivery path across all subscribed devices:

```bash
collie push-test                     # or: push-test "Title" "Body"
```

Delivery takes one to two seconds. If the command reports push is disabled, restart the service so
it loads the generated keys. If it reports no subscribed devices, complete step 3 in the phone
browser.

Web Push requires a secure context (HTTPS). This is provided by `tailscale serve` (MagicDNS
certificates) or an external reverse proxy terminating TLS
([Variant C](deployment.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)). Plain
HTTP setups (`COLLIE_SERVE_MODE=http`) lack a secure context, and the browser disables the
subscription controls in Settings.

Collie sends notifications when an agent enters the **blocked** or **done** state, placing the agent
message in the body. Selecting the notification navigates directly to that agent in the web UI.

Stale subscriptions can accumulate over time because home-screen reinstalls and service-worker
resets create new endpoints without always returning an HTTP 410. Collie updates the record when a
device re-registers. You can view and delete stored endpoints directly:

```bash
bin/collie push list                 # one line per device: service, since, user agent, endpoint tail
bin/collie push forget <substring>   # or: push forget --all
```


---

[← back to the README](../README.md)
