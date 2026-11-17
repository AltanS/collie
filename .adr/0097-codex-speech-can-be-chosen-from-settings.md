# 0097: Codex speech can be chosen from Settings, after the same consent, with a tap

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amends in scope:** [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md) and
  [ADR 0096](./0096-speech-can-stay-on-the-phone.md). 0029 made setup a CLI act; 0096 named one
  exception, Whistle. This record names a second, narrower one: a write device may switch the host
  between Whistle, Codex and Off. The provider seam, the honest-first probe, the recorded identity and
  the lead-only rule all stand. On acceptance, 0029 and 0096 gain the `Amended in scope by 0097`
  pointer.
- **Relates to:** [ADR 0086](./0086-reads-need-the-pairing-token.md) (the status is a read, so it
  needs the token) · [ADR 0095](./0095-one-off-commands-and-their-history.md) (what a write token can
  already do) · [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (opt-in is the
  ceiling)
- **Trail:** the operator's decision of 2026-10-11 · `bridge/stt/host-http.ts` (`GET` and
  `PUT /api/stt/host`) · `bridge/stt/codex-setup.ts` (the consent's words, its id and the probe, shared
  by the CLI and the route) · `bridge/stt/codex-detect.ts` (`codex login status`) · `cli/stt.ts`
  (`setupCodex`) · `web/src/lib/stt-consent.ts` · `web/src/components/speech-control.tsx` (the Host
  speech provider card and the consent sheet) · `CLAUDE.md` → *Security posture*

## Context

ADR 0029 let speech in through the host and kept setup in the terminal, "for the reason pairing is":
setup can store a credential, name a command the bridge will spawn, or open a path that carries room
audio off the host, and a page loaded over the front door should not decide any of those. For the
codex provider it added two things that make borrowing the operator's ChatGPT sign-in acceptable at
all: a consent step that names the risk in words, and an identity probe that asks the endpoint under
Collie's own name first and records the fallback, if it is needed, in `stt.json`.

ADR 0096 made the first exception. Whistle holds no credential, runs Collie's own binary with
arguments Collie wrote, and keeps the audio on the host, so a write device may set it up from
Settings. That left a page that could turn Whistle on and say nothing about any other provider: an
operator with Codex on the host saw no trace of it in the app, and one who wanted to move between
Whistle and Codex had to walk to a terminal for a choice that holds no key and names no command.

Codex is not Whistle. Its audio leaves the host, for a private endpoint, under the operator's ChatGPT
account, so it carries real consent weight. What it does not carry is a credential Collie stores or a
command the operator wrote: the token belongs to the operator's own `codex`, is fetched per use and
never written, and the binary is the one the operator already runs.

## Decision

**The Voice page shows the host's speech provider whatever it is, and a write device may switch the
host between Whistle, Codex and Off. Codex is chosen only after the full consent, in the same words
the CLI prints, accepted with an explicit tap; then the bridge runs the same probe the CLI runs and
records the same verdict. A provider set up with a key or a command, or named by the environment, is
shown and never changed from the app.**

1. **One route family, lead-local.** `GET /api/stt/host` (a read: the pairing token) reports the
   provider (`whistle`, `codex`, `openai-compatible`, `local-cli`, `none`), whether it works and why
   not, the recorded identity for codex (`honest` or `codex-cli`), who names it (`file`, `env`,
   `none`), what the settings name, by name only (`setup`: a command's basename, a model file's or a
   service model's name, a service's host; never a path, another argument, a key or a URL's path),
   and for each of the three choices whether it may be made now and why not, as a code the
   phone translates. `PUT /api/stt/host` (a write, gated like `POST /api/stt`) takes
   `{ provider: "whistle" | "codex" | "off", consent?: "<id>" }`. Neither reads `?host=` nor is in
   the crew's forwardable list. The write is one audit line: the choice, the outcome, the recorded
   identity, never a reason's text or a path. It replaces `PUT /api/stt/whistle/host`, which never
   shipped in a release.

2. **Three choices, and only these.** Whistle, when its model is ready. Codex, when the host's
   `codex` is installed and signed in with ChatGPT. Off, which removes `stt.json`. The app **never
   replaces or removes**:
   - a provider set up in a terminal with a key, an endpoint or a command (`openai-compatible`,
     `local-cli`, or a name this build does not know). The card shows it, says it was set up in a
     terminal, and prints the commands that change it (`collie stt setup`, `collie stt off`) to copy;
   - anything the bridge's environment names, because the environment wins over the file field by
     field, and a write would only pretend. The card prints `collie stt status`;
   - an `stt.json` the bridge cannot read, because overwriting it would lose it.

   API keys, endpoints and commands stay terminal-only, with no form for them anywhere. A "Set up
   elsewhere" row says so and prints `collie stt setup`.

3. **The consent is one text, shown in full, accepted with a tap.** The words live once, in
   `bridge/stt/codex-setup.ts`. The CLI prints them; the app shows each paragraph from its message
   catalogue, where they may be translated, and a test reads the English catalogue off disk and fails
   unless each paragraph is exactly the CLI's lines joined by a space. The consent's id is
   `codex-consent-` and twelve hex digits of the sha256 of the template, so it changes whenever a word
   does. Tapping Codex opens a sheet with the whole text and two buttons, *Cancel* and *I accept*;
   nothing is sent to the host before *I accept*. The tap sends the id, and the bridge refuses a codex
   switch with no id or another one (`400 stt.consent_required`) before it runs anything, so a phone
   that showed an older text cannot consent to a newer one.

4. **The probe is the CLI's, not a copy of it.** After the consent, the bridge checks the sign-in
   afresh, then calls `probeCodexSetup`, the function `collie stt setup` calls: honest identity
   first, the Codex CLI's headers only when the endpoint refused, and the verdict written as
   `wireIdentity` through the one `stt.json` writer. A probe that fails writes nothing and says why
   (`502 stt.codex_probe_failed`). A test runs both surfaces with one injected probe and requires the
   same questions and the same file.

5. **"Installed and signed in" is asked of `codex` itself.** `codex login status`, the binary's own
   read-only verb, argv only, no shell, a 5-second deadline with SIGKILL, output capped at 4 KiB and
   classified, never logged or returned: only the line codex prints for a ChatGPT login counts. The
   answer is cached for 30 seconds and one check runs at a time, so a page opened on several devices
   costs one short-lived child. A write that depends on it asks afresh. Collie still never reads
   `~/.codex/auth.json`, and does not start `codex app-server` for a status line. The binary is the
   one `stt.json` names, or `codex` found the way the CLI finds it.

6. **Races.** One switch at a time per bridge (`409 stt.host_busy`). Every write re-reads `stt.json`
   and the environment after its last `await` and refuses when anything changed
   (`409 stt.host_changed`), with no `await` between that read and the write, so a `collie stt setup`
   in a terminal is never overwritten by a tap that began before it.

7. **The page.** Settings → Voice has, in order: the Whistle card (the model, its credit, the host and
   phone steps; its old *Use Whistle on the host* switch is gone), the **Host speech provider** card
   (the status, then the three choices with their reasons and the commands to run on the host), the
   Speech engine card, and hands-free. A read-only device sees the status only.

## Consequences

- **The consent weighs less as a tap than as a typed word.** The CLI asks for `yes`; the app asks for
  a tap on *I accept* under the full text. A tap is easier to give without reading. What keeps it
  honest is that the text is the same and complete, nothing runs before the tap, the id ties the tap
  to the words shown, and the recorded identity is visible on the same card afterwards. That is the
  trade the operator chose.
- **What a stolen write token gains, said plainly.** It can now point the host's speech at the
  operator's ChatGPT account, if `codex` is installed and signed in there, and so spend that
  account's rate limits and risk its standing on a private endpoint, and send any audio it uploads
  there. It cannot add a key, an endpoint or a command, cannot replace one the operator set up, and
  cannot read the token. Measured against what that token already does, it is small: it types into
  terminals, which can run `codex` with the same sign-in directly, it runs one-off commands
  (ADR 0095), and it starts an update that fetches and builds code. The new reach is a narrower
  path to something the token could already reach.
- **The setup-is-a-CLI-act rule has two exceptions now.** It holds for every provider that stores a
  credential or spawns an operator's command. Whistle (ADR 0096) and switching to Codex here are the
  exceptions, and `CLAUDE.md` names both. A future provider that stores a key or runs the operator's
  command may not follow them.
- **A Codex switch can take a while.** The probe is one request to the endpoint, two minutes at most;
  the sheet stays open with its button busy and the app waits up to 150 seconds.
- **The page spends one `codex login status` per 30 seconds** while someone looks at it, and none
  when the provider was set up in a terminal or by the environment.
- **The consent's translations can lag the English.** A word changed in the CLI changes the id and
  fails the drift test until the English catalogue and the app's id are updated; the other languages
  are then retranslated like any changed string.

### Alternatives considered

- **Show the provider, change nothing.** The smallest step and safe. Rejected by Altan on 2026-10-11:
  the operator should not need a terminal to move between two providers that hold no key, once the
  consent has been given in full.
- **Full setup in a form, keys and commands included.** One page for everything. Rejected, as in
  ADR 0029: a key typed into a page loaded over the front door, or a command the bridge will spawn
  named from a phone, is exactly what setup-in-the-terminal exists to prevent.
- **Ask for "yes" typed into a field instead of a tap.** Closer to the CLI. Rejected: on a phone it
  adds friction without adding reading, and the id already binds the tap to the text.
- **Detect the sign-in through `codex app-server` and `getAuthStatus`.** Structured, and the provider
  already speaks it. Rejected for a status line: a long-running child and a handshake per check,
  where `codex login status` is one short process. The provider keeps using the app-server for its
  token.
- **Read `~/.codex/auth.json` to see whether a login exists.** Rejected for 0029's reason: Collie
  does not read another tool's secret store, not even to peek.

### What would justify revisiting

- **Codex publishing a supported transcription interface.** The consent and the probe shrink, and so
  does the weight of the tap.
- **Evidence that the tap is given without reading**, such as a report of a surprise codex-cli
  identity. Then a typed word, or a delay before *I accept* turns on.
- **A provider that holds no key and runs no operator command but sends audio off the host** asking to
  join the three. It would need its own consent text and the same parity test, not a quiet addition.
