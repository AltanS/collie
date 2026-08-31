# Voice input and Web Push

Two optional surfaces, each absent until you turn it on: a microphone in the composer, and a
notification the moment an agent is waiting on you.

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
provider:

```console
$ bin/collie stt test
provider: openai-compatible (http://127.0.0.1:8080/v1, model whisper-1, language en)
sending:  0.2 s of generated silence (audio/wav)
✓ round trip in 214 ms
  transcript: (empty) — expected from silence, and the empty answer still proves the pipeline.
```

An **empty transcript is a pass** — silence transcribes to nothing, and the round trip is what was
being proved. If it fails, the error names its kind (auth, endpoint, response shape). Then reload
Collie on the phone: a microphone sits beside the message box. `collie stt status` says what is
configured and *where each setting came from* (the file, or an environment variable that outranks
it); `collie stt off` removes `stt.json` and the button is gone again, no restart either way.

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

Off unless you opt in. Three steps, and nothing to install — the sender (`web-push`) is already an
optional dependency, installed by the build:

```bash
herdr plugin action invoke push-keys --plugin herdr.collie   # 1. generate + write the VAPID keys
herdr plugin action invoke restart   --plugin herdr.collie   # 2. Collie reads them at start
#                                                              3. on your phone: Settings → notifications
```

Step 1 is the one that used to be fiddly. `push-keys` generates the keypair *and* writes
`COLLIE_VAPID_PUBLIC` / `_PRIVATE` into the `.env` the service actually reads, at mode 600.

**Worth one extra keystroke:** pass a *subject* — the contact address RFC 8292 wants, so a push
service has a way to reach whoever is sending. An action carries no arguments, so this form is the
shell one:

```bash
bin/collie push-keys mailto:you@example.com
```

Two behaviours worth knowing. It **refuses to replace keys that are already live** unless you pass
`--force`, because new keys invalidate every existing subscription: each device must re-enable
notifications, and until it does it silently receives nothing. But passing a subject on an
already-configured install is *not* that — it updates the contact address and leaves the keys alone,
so fixing a typo never costs you your subscribers.

> **On a Herdr install older than 0.8.0**, actions are the set cached when the plugin was installed
> ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)), so `push-keys` and
> `push-test` won't appear until the next `herdr plugin install`. Use
> `bash scripts/collie-ctl.sh push-keys` until then — the shim hands the verb to the same binary, so
> it does the identical thing.

**Did it work?** Fire a notification at every subscribed device without waiting for an agent to
block:

```bash
bin/collie push-test                 # or: push-test "Title" "Body"
```

You should get it within a second or two. If it says push is disabled, Collie didn't get the keys
— restart it (step 2). If it says there are no subscribed devices, step 3 hasn't happened on that
phone yet.

Push needs a **secure context (HTTPS)**, which any HTTPS-terminating front door provides — the
default `tailscale serve` (Tailscale manages the MagicDNS cert; nothing to obtain or renew) or a
[Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) proxy that
terminates TLS. Plain-HTTP modes (`COLLIE_SERVE_MODE=http`) are **not** a secure context, so the
browser won't even offer the subscribe button — Settings flags it `insecure`.

Collie pushes when an agent goes **blocked** or **done**, with the agent's message in the body;
**tapping it opens Collie at that agent**.

Subscriptions accumulate — a home-screen reinstall or a service-worker re-registration mints a fresh
endpoint, and the old one stays live-looking rather than 410ing. Collie supersedes the row a device
re-registers over, and the rest are yours to see and drop (both work with push off):

```bash
bin/collie push list                 # one line per device: service, since, user agent, endpoint tail
bin/collie push forget <substring>   # or: push forget --all
```


---

[← back to the README](../README.md)
