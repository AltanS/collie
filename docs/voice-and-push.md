# Voice input and Web Push

Both features are disabled by default. You can enable a microphone button in the composer, and
browser notifications that trigger when an agent is waiting for input.

## Voice input (optional)

A **microphone button in the composer**, and a **hands-free switch** in **Settings → Voice**. Tap the button,
speak, and the transcript lands in the message box for you to read and send. With hands-free on it is
sent for you — down the same guarded reply path a typed message takes, never around it. The
microphone **is** the round button at the end of the row, for as long as the box is empty; the first
character you type turns it back into Send. You dictate a message or you type one, so there is one
primary action rather than two competing for the width of the field.

While you speak, a recorder covers the whole composer, belt and box, and adds no height, so the
screen above never moves. **OK** stands where the mic was and finishes the clip. The **bin** at the far
end throws it away, and still cancels while the clip is being transcribed. Once you have spoken, two
seconds of quiet finish the clip for you; a ring closes round OK to show it, and speaking again
starts the count over. Before the first word nothing finishes it on its own.

**It does not exist until you set up a provider.** Run `collie stt setup`, or set up Whistle (below).
No button is drawn, no audio leaves the phone, no credential is held, no child process runs. Absent,
not disabled. Four providers:

| provider | what it is |
| --- | --- |
| **`openai-compatible`** | Any endpoint that speaks `POST /audio/transcriptions` — the public OpenAI API, a cloud Whisper clone, or **a local engine on the same machine, which is the zero-egress choice** ([below](#zero-egress--point-it-at-your-own-engine)). |
| **`codex`** | Borrows the `codex` binary you already trust for a short-lived token. No new account and no new key, but a **private, unsupported** endpoint that carries a consent step: you type `yes` in the terminal, or tap **I accept** in Settings ([below](#the-codex-provider--what-you-are-accepting)). |
| **`local-cli`** | Runs a transcription command already on the host, such as `whisper-cli` or `muesli-cli`, once per recording, and reads the transcript from its stdout. No HTTP server needed ([below](#run-your-own-command-the-local-cli-provider)). |
| **`whistle`** | Collie's own engine, [Whistle](#whistle-speech-to-text-on-your-phone-or-your-host). No key and no command to configure. A recording of up to 4 minutes goes to it as a WAV file, and the audio stays on the host. A phone can also run Whistle on itself, with no upload. |

Setup is a CLI act for the reason [pairing](security.md#pair-a-device--the-write-credential) is one: this
surface accepts a credential, so it belongs on the host's keyboard. There is no web form for a key, an
endpoint or a command. **Two exceptions take none of those.** Whistle holds no credential, runs no
command you chose and sends no audio off the host, so a device with write access may set it up from
Settings ([why](security.md#the-speech-engine-whistle)). And in **Settings → Voice → Host speech**,
a device with write access may switch the host between Whistle, the ChatGPT subscription (the
`codex` provider) and Off. ChatGPT comes only after the same consent the terminal prints and a tap
on **I accept** ([below](#the-codex-provider--what-you-are-accepting)). A provider you set up in the
terminal with a key or a command, or one your environment names, is shown there and never changed
from the app. For those two, the page shows the commands to run on the host, with **Copy** and
**Check again**, and no form.

```console
$ bin/collie stt setup
Which speech-to-text provider?
  openai-compatible  any endpoint that speaks POST /audio/transcriptions —
                     the public OpenAI API, or a local whisper.cpp / parakeet.cpp
                     server, which is the zero-egress choice and the one to prefer.
  codex              borrow your own `codex` sign-in. No new key, no new account —
                     and a private endpoint that may break without notice.
  local-cli          run a transcription command already on this machine, such as
                     whisper-cli or muesli-cli. Its stdout is the transcript.
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

A recording stops at five minutes. A host that runs Whistle takes four, because the phone sends it a
WAV file, which is about four times the size of the compressed clip. The recorder shows the cap that
applies.

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

With Whistle on the host, `stt test` sends one clip, a 16 kHz WAV, and says that webm and mp4 are
skipped, because the phone converts its recording to 16 kHz WAV before it sends it to that provider.

An **empty transcript is a pass** — silence transcribes to nothing, and the round trip is what was
being proved. If it fails, the error names its kind (auth, endpoint, response shape). Then reload
Collie on the phone: a microphone sits beside the message box. `collie stt status` says what is
configured and *where each setting came from* (the file, or an environment variable that outranks
it); `collie stt off` removes `stt.json` and the button is gone again, no restart either way.

<a id="quick-start-cactus-whistle-on-this-machine"></a>
### Whistle: speech to text on your phone or your host

[Whistle](https://huggingface.co/Cactus-Compute/whistle) is a small speech model by Cactus Compute.
The file is 16.9 MB and the licence is Apache-2.0. It knows English, German, French, Spanish,
Italian, Dutch and Polish, and finds the language itself. It needs no account, no key and no extra
program. Collie carries the engine that runs it, so it works on Linux, macOS, Windows and NixOS.

Whistle can run in two places. You choose per phone.

| Engine | Where the words are made | Pick it when |
| --- | --- | --- |
| **Host** | On the computer that runs Collie, in a short-lived child process of Collie's own binary. | The phone is weak or old. A recording goes up as a WAV file, and a clip takes a second or two. |
| **This phone** | In the phone's browser, in a worker. | The phone is recent. There is no upload, so the audio never leaves the phone, and it works offline once the model is on the phone. |

Both engines read the same model. The host keeps one copy. A phone that wants to run Whistle itself
copies it from the host, never from the internet. A clip takes about a second on a recent phone.

**Set it up from Settings.** You need a device with write access (a device that has
[paired](security.md#pair-a-device--the-write-credential)). A read-only device sees "A device with
write access can set this up." and cannot start the download.

**Settings → Voice** is one page with two pages below it:

- **Voice** puts what is in use first. The top card is titled with what is configured: the
  command your host runs, such as `whisper-cli` with **Model ggml-base.bin** and **Your own command
  on your host** under it; a speech service's model, such as `whisper-large-v3` with **A speech
  service at api.groq.com**; **Whistle by Cactus Compute** with **Model ca52876** and **On this
  phone** or **On your host**; or **ChatGPT subscription (OpenAI)** with **Through Codex on your
  host**. If the command is the old `whistle-stt` wrapper, the card says so and offers **Switch to
  built-in Whistle**, which opens Host speech. Then the status, which says what it rests on, for example "Ready. Whistle
  ca52876 is on this phone." or "Not ready. Codex is signed out on your host.", where the **Audio**
  goes, and how it was **Set up** (from Settings by which device and when, or in a terminal on the
  host). Under the card is the hands-free switch. Everything else sits behind one row, **Change how
  speech works**. While speech works, that row is closed on every visit. While it does not (nothing
  set up, a paused phone, a host option that does not answer), it stands open, and the top card
  carries the one action: **Set up speech on this phone**, **Restore** or **Fix**. Opened, it shows
  this phone's own choice, **On this phone** (marked **Recommended**) or **On your host** (the
  computer running your agents), which is kept per device. The choice in use has a bold edge, a tint
  and an **In use** badge, and switching between the two moves nothing on the page. Then one row for
  what the host uses, a row that opens all five options, and one row for the model. Each choice has
  an info button that lists five facts about it: where the audio goes, whether it works offline,
  what it costs, what setup it needs, and how fast it is. A tap on the info button chooses nothing.
- **Host speech** lists the host's five options. Whistle and your own command keep the audio on
  your machines. A speech service and the ChatGPT subscription send it off your host. Off stands on
  its own below them. A change here is for every device paired to the host. A choice that sends
  audio further than the one it replaces asks first; a step back is sent on the tap. Every option
  has **How to set up**: numbered steps, the commands to copy, and the app's own buttons where the
  app may act. The step to take next is marked **Next**. It is open by itself only for the option in
  use when it does not work. The option in use also says what is configured, for example
  "Configured: whisper-cli, model ggml-base.bin".
- **Whistle model** names the maker, Cactus Compute, the licence, and links to the model page on
  Hugging Face. It shows the copy on the host and the copy on this phone, each with its own state.

To set Whistle up:

1. On a phone where speech does not work yet, tap **Set up speech on this phone** in the top card
   on **Voice**. One tap does the whole way: the host downloads the model if it lacks it, this phone
   copies it from the host, and **On this phone** is chosen. One bar shows the progress and says
   which step runs, "Downloading to your host…" or "Copying to this phone…". If a step fails, it
   stops there, says why, and offers **Try again**. A read-only device may copy, because copying is a
   read, but it cannot ask the host for the download. The same two steps are also under **Change how
   speech works**: **Set up (16.9 MB)** on a phone with no copy, or **Copy to this phone** when the
   host already has the model.
2. Or open **Whistle model** and tap **Download to host (16.9 MB)**. A bar shows the progress. If it
   fails, the page says why. Tap **Try again**. When the model is there, the page lists its version
   (the first seven characters of the Hugging Face revision, a link to that revision) and its size.
   **Details** shows a short checksum and when the host downloaded it.
3. For dictation through the host, open **Host speech** and choose **Whistle on your host**, then
   **Change for every device**. Or open **How to set up** under it and tap **Use on host**. If you
   set up another provider in the terminal, with a key or a command, the page shows it and offers no
   choice. Whistle's steps then start with `collie stt off` on the host, then
   `collie stt whistle --host`.
4. On this phone's copy, **Whistle model** names the version, and offers **Remove from this phone**.
   It also says whether the browser agreed to keep the copy ("Kept") or may clear it when space runs
   low. If the host later gets a newer model, the copy says so and offers **Update**.
5. On **Voice**, open **Change how speech works** and choose **On this phone** or **On your host**. **On this phone** is off until the
   phone has a copy. **On your host** is off while the host has no speech option. The line under
   the choice says what the host uses.
6. To remove the model from the host, tap **Remove from host** on **Whistle model** and confirm. If
   Whistle was the host engine, speech on the host stops until you download it again.

**Who changed it.** When a paired device changes the host's option from Settings, the host writes
that device's name and the time. **Voice** and **Host speech** then say "Last changed by Pixel 8",
with the time. A change in the terminal clears it.

**Or set it up in the terminal.**

```console
$ bin/collie stt whistle                 # fetch the model once
$ bin/collie stt whistle --host          # also make Whistle this host's engine
$ bin/collie stt whistle --from <path>   # use a copy you already have, same hash check
$ bin/collie stt whistle --remove        # remove the model, and the host engine if it is Whistle
$ bin/collie stt status                  # shows the model line
```

`--host` asks before it replaces a provider you set up on purpose. `--yes` answers that question for
a run with no terminal. The question comes before the download, so a refused run fetches nothing.
`--remove` leaves a provider of another kind alone. `collie stt off` removes the provider and says the
model stays. `collie doctor` warns when the model on the host is not the one this release accepts.
The engine is live at once, with no restart. Check it with `collie stt test`.

**What is downloaded, and from where.** The host fetches `whistle.cact` from one pinned Hugging Face
address, follows the redirect to its CDN (at most five, HTTPS only, and never to a local or private
address), and keeps the file only when its sha256 equals a hash that this release carries. A mismatch deletes the file and reports both hashes. The download is capped at
32 MiB and has a 10-minute deadline. The file sits in the `whistle` folder of the state folder. The
engine code (about 1 MB) is part of every Collie release and comes from Collie's own files.

**Nothing downloads on its own.** Not on install, not on an update, not when you pick an engine. The
model arrives when a person taps **Download to host**, **Set up**, or runs `collie stt whistle`. A
phone copies it from the host when its owner taps **Set up**, **Copy to this phone** or **Restore**,
and from no other place. The host sends
the model to at most two phones at once. A third gets "try again in a moment".

**Limits.** The host engine takes a recording of up to 4 minutes, because a WAV is about four times
the size of the compressed clip and the upload cap stays 8 MiB. The recorder shows that cap. The
phone engine takes up to 5 minutes. The host child has a deadline of half the clip's length, at
least 60 seconds and at most 3 minutes, and at most two clips run on the host at the same time. A phone needs free space for the model (it asks for twice the file
size) and a secure connection (HTTPS, as `tailscale serve` gives).

**When the phone cannot do it.** If *On this phone* fails on a clip, the voice screen says why and
offers **Send to host**, only while the host has a working speech provider. The clip stays in memory,
in the failed state, until you tap Send to host or discard it. Collie never sends it by itself,
because you chose an engine whose point is that the audio stays put. Two engine crashes in one
session turn *On this phone* off until you reload the app.

**When the phone's copy is gone.** A browser may clear the copy to free space. The choice stays on
this phone, and dictation is paused: **Voice** says "Dictation is paused" and offers **Restore**,
which copies the model from the host again. The mic still records, and the clip stays on the phone
with **Send to host** as above. Collie does not switch to the host by itself. To use the host, choose
**On your host**.

**Browsers.** *This phone* needs a browser that gives the speech worker its own security policy.
Chrome on Android is tested. WebKit is tested in a WebKit build. Safari on an iPhone is not verified
on a device yet. A browser that cannot run it shows *On this phone* as off with the reason, and
*On your host* stays available.

**If you used the old wrapper.** Earlier versions of this page showed a `local-cli` wrapper around a
native runner, `ffmpeg` and `jq`. That setup is retired, but nothing touches one you already have, and
it keeps working. To move to the built-in engine, run `bin/collie stt whistle --host --yes`, or run
`collie stt off` first and then `bin/collie stt whistle --host`. You can also keep the wrapper. Its
model file is not reused on its own. Pass it with `--from <path>` to skip the download.

The security side of this engine, and why setup from Settings is allowed, is in
[Security](security.md#the-speech-engine-whistle) and
[ADR 0096](../.adr/0096-speech-can-stay-on-the-phone.md).

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

**You can also choose it in Settings.** Open **Settings → Voice → Host speech** on a device with
write access. The page shows what the host uses now. For the ChatGPT subscription it also shows the
recorded identity: `honest`, or `codex-cli` when the fallback was needed. The **ChatGPT
subscription** row is open only when `codex` is installed on the host and signed in with ChatGPT.
Collie asks `codex login status` to find out. Otherwise the row says why in one sentence, and its
**How to set up** marks the next step: install Codex on the host, sign in with `codex login`, then
tap **Use ChatGPT subscription**. Tap the row, and a sheet shows the same consent, word for word, under a line that says
the change is for every device paired to the host. Nothing is sent to the host until you tap
**I accept**. Then the host runs the same probe as `collie stt setup`, honest identity first, and
writes the same config. If the probe fails, nothing is written and the sheet says why. **Off** on the
same page removes the provider. The terminal still works the same way.

### Run your own command: the local-cli provider

`local-cli` runs a transcription command you already have, once per recording, with no HTTP server
in between:

```bash
bin/collie stt setup --provider local-cli \
  --command /Applications/Muesli.app/Contents/MacOS/muesli-cli --args transcribe
bin/collie stt test
```

Collie writes the recording to a private temp file and runs `<command> [args…] <file>`. The file's
path is always the last argument. The command's stdout, trimmed, is the transcript.

| setting | flag | env | what it is |
| --- | --- | --- | --- |
| `command` | `--command` | `COLLIE_STT_COMMAND` | An absolute path, or a name on `PATH`. |
| `args` | `--args` | none | The arguments before the file's path. |

A bare name is looked up when you run `setup`, and the full path is saved. The service runs with a
short `PATH`, so a name your shell finds may not resolve there. A relative path such as
`./whisper-cli` is refused.

`--args` takes words separated by spaces. No shell reads them, so quotes are kept as typed. An
argument with a space in it needs the JSON form instead:

```bash
bin/collie stt setup --provider local-cli --command whisper-cli \
  --args '["-m", "/srv/my models/ggml-base.bin", "-nt"]'
```

What the command must do:

- Be a regular file your user can execute. A symlink to one is fine, because Collie follows it.
  `collie stt setup` refuses anything else, and `collie stt status` says what is wrong.
- Exit with status 0 and print the transcript to stdout. Anything else fails the dictation.
- Finish within 60 seconds. Collie then kills it, and every process it started, with SIGKILL.
- Print at most 256 KiB to stdout. Collie kills it as soon as it prints more.
- Leave nothing running. When the command exits, Collie kills any process it started that is still
  there. A helper that must stay up has to start its own session, for example with `setsid`.

On Windows, Collie ends the command's whole process tree at the same moments, and after a clean exit
it ends any process the command started that is still running. One case is left: a process
started by a helper that has already exited can outlive the command.

At most two dictations run the command at the same time. A third gets the same "busy" answer the
phone already knows, and Collie starts nothing for it.

An empty stdout is a failure on the phone, because there is nothing to put in the box.
`collie stt test` counts it as a pass, since its clips are silence.

> **Note.** The command runs as the bridge's own user, with that user's rights, once per dictation.
> It gets no shell, no stdin, and no `COLLIE_*` environment variable. Its stderr is never read, and
> the phone never sees the command line or a path, only that the command failed and its exit status.

The temp file sits in a folder only your user can open, and Collie deletes it after every run. If
the bridge itself was killed mid-run, the next bridge start removes such folders once they are an
hour old. Where
the audio goes next is up to the command: a local engine keeps it on the host.

The reasoning for all of the above — why this was declined twice, what changed, and why the seam
looks like this — is [ADR 0029](../.adr/0029-speech-to-text-is-a-provider-seam-collie-owns.md).


## Web Push (optional)

Disabled by default. Setup requires three steps. The sender library (`web-push`) is included as an
optional dependency during the build:

```bash
collie push-keys     # 1. generate + write the VAPID keys
collie restart       # 2. Collie reads them at start
#                      3. on your phone: Settings → Alerts
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

> **Note.** On Herdr versions before 0.8.0, actions remain fixed to the set cached during initial plugin
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

### Which alerts Collie sends

Five kinds, each with its own switch under **Settings → Alerts → Notify when**.

| Alert | Fires when | Default |
| --- | --- | --- |
| Needs input | an agent is waiting on you | on |
| Finished | an agent completes its task | off |
| App updates | a newer Collie release is available | on |
| Machine load stays high | a machine's CPU, memory or fullest disk stays above a rule you set for it | on |
| Cache about to go cold | a pane's prompt cache expires in about five minutes | off |

Finished fires when an agent goes from working to idle, so an agent you interrupt also counts as finished.

Machine load sends nothing until you set a rule on a machine's page. The switch turns off every rule at
once. One alert is sent each time a value climbs and stays high, and a tap opens that machine's Status view. See
[Machines](crew.md#machines).

Each device shows an alert's title in its own [language](configure.md#language), and English on a
device that has not opened Collie since it was updated. The body stays as the bridge wrote it.

Every switch is bridge-wide. A push fans out to every subscribed device, so there is nothing
per-device to set.

The cache warning can also be switched on for **one pane at a time**, from that pane's own settings:
open the pane, tap the ⋮, then **Pane settings**. Those panes are listed under the global switch in
Settings, with a Remove button each.

The two states add up rather than override. A pane is warned when the global switch is on **or** the
pane is on that list, so turning the global switch off does not silence a pane you watched by hand.

A watched pane is warned **once per warm cycle**. The agent's next request moves the deadline, and
only then can the same pane warn again. The quiet hours apply: a snoozed bridge sends nothing, and a
snooze that ends inside the window still warns. A pane that is already cold is never warned, and that
includes one a `/model` switch made cold with time still left.

`COLLIE_CACHE_WARN_SECONDS` moves the window, default 300 seconds
([configure.md](configure.md#the-prompt-cache-countdown)).

> **Note.** This alert needs the prompt-cache reading, so it covers the panes that show a cache
> countdown and no others: the harness has to keep a transcript Collie can read, and the agent has to
> have taken at least one turn. The window a pane actually warns at is the configured seconds, or half
> that pane's own cache lifetime, whichever is shorter. A one-hour Claude cache keeps the full 300
> second window. A five-minute cache, Codex, OpenCode, pi and omp, warns about two and a half minutes
> before it goes cold instead.

### The count on the app icon

The installed app's icon shows how many alerts are waiting on you: every pane blocked on you, and,
with Finished switched on, every finished pane you have not opened yet. It follows the same switches
as the pushes, so it counts exactly what notifies you.

Opening a finished pane in Collie retracts its alert, from the lock screen and from the count. A
blocked pane's alert stays until you answer it.

Each herd push carries the count for its session, and the phone adds up every session and machine in
the crew. Opening the dashboard sets it again from what is on screen when it shows every session, and
unpairing the device clears it. A dashboard that shows one session of several leaves the count to the
pushes, because it cannot see the others.

> **Note.** The count needs a browser with the Badging API and an installed app: on an iPhone,
> iOS 16.4 or later, Collie added to the Home Screen, and notifications allowed. With every kind of
> agent alert switched off, no push carries a count, so the icon changes only when you open the
> dashboard.

Stale subscriptions can accumulate over time because home-screen reinstalls and service-worker
resets create new endpoints without always returning an HTTP 410. Collie updates the record when a
device re-registers. You can view and delete stored endpoints directly:

```bash
# one line per device: service, since, user agent, endpoint tail
bin/collie push list
bin/collie push forget <substring>   # or: push forget --all
```

### iPhone and iPad

**Why does Settings say "This browser doesn't support push notifications"?** iOS and iPadOS 16.4
and newer allow Web Push only for a web app that you added to the home screen and opened from its
icon. In a Safari tab, **Settings → Alerts** shows that line. See
[Put it on your phone](install.md#iphone-and-ipad) for the steps to add Collie.

**I added the icon. Do I set up again?** Yes. The home screen app keeps its own storage, separate
from Safari. Pair it again in the app (`collie pair` on the host, then **Settings → System → Paired
devices**, see [Pair a device](security.md#pair-a-device--the-write-credential)). Then turn on push in
**Settings → Alerts** in that app.

**Why does the switch say "Unavailable over plain HTTP"?** Push needs HTTPS. Over plain HTTP, for
example with `COLLIE_SERVE_MODE=http` or a Headscale tailnet without certificates, the switch stays
off with "Serve Collie over HTTPS to enable push." See the secure-context paragraph above and
[Front doors](deployment.md#front-doors-one-product-at-a-time).

**Why does Settings say "Notifications are blocked for this site"?** The browser reports that
notifications are denied for the app. Allow notifications for Collie in iOS **Settings → Notifications**, under the name of
the home screen app. That list is Apple's, not Collie's. Then open Collie again.

**The switch is on, but nothing arrives.** Run `collie push-test` on the host. If it says it
sent to a device, look at Focus and Do Not Disturb on the phone. If it reports no subscribed devices,
turn push on again in the app. `collie push list` shows one line for each device that has a
subscription.

**I removed the icon and added it again. What now?** iOS treats it as a new app, so it has new
storage and a new subscription. Pair it again if Collie asks, and turn push on again. The old
subscription stays in the list until a send to it fails. Remove it sooner with
`collie push forget <substring>`.

These answers follow Apple's rules for home screen web apps. Collie's maintainers have not checked
every step on an iPhone yet.

### Pushes from a durable agent

A durable agent's question card can push to your phone, and Collie caps how many pushes one durable agent makes.

The push says "Permission needed in" and the name you gave the pane. It never carries the durable agent's
own title for the question. A durable agent may choose its words: its title (60 characters at most)
follows your pane name after a colon, and its line (120 at most) is the body. The words change what
the push says, and never how often it is sent.

| Cap | Limit | Past it |
| --- | --- | --- |
| One pane | 3 pushes a minute | The question shows on the phone and sends no push |
| One durable agent on one machine | 10 pushes a minute | The same |
| One durable agent on one machine | 30 pushes an hour | One summary push, then no push from that durable agent for an hour |

The summary reads "A durable agent on {host} is raising many asks", with the machine's name for host. In a
crew it names the member. The Needs input switch and the snooze hold the summary
back too. A cap never hides a question: every open question stays on the phone.

Collie pushes a question once. It remembers each one by machine, durable agent and tool call, so a durable agent
that restarts and asks the same question again shows it on the phone and sends no second push. A
question is forgotten an hour after it closes. The memory is `durable-asks.json` in the state
folder. In a crew the lead runs these rules and keeps that file, and the member sends no push for
its own questions ([ADR 0100](../.adr/0100-an-ask-travels-as-data-and-is-answered-by-id.md)).


---

[← back to the README](../README.md)
