# 0096: Speech can stay on the phone: one vendored engine for phone and host, a model the host fetches on a tap

- **Status:** Accepted
- **Date:** 2026-10-11
- **Amended in scope by:** [ADR 0097](./0097-codex-speech-can-be-chosen-from-settings.md): a second
  exception to the setup-is-a-CLI-act rule, switching the host between Whistle, Codex and Off from
  Settings.
- **Amends in scope:** [ADR 0029](./0029-speech-to-text-is-a-provider-seam-collie-owns.md), whose
  *What would justify revisiting* names this case: "an on-device transcription path good enough on
  a phone". The provider seam, the lead-only rule and the hands-free rule all stand. Two things
  change: the seam gains a fourth provider, `whistle`, which is Collie's own code and not an
  operator's command, and **the setup-is-a-CLI-act rule gains one named exception**: Whistle may be
  set up from Settings, for the reasons in Decision 3. On acceptance, 0029 gains the `Amended in
  scope by 0096` pointer.
- **Relates to:** [ADR 0033](./0033-the-app-face-is-a-device-preference.md) (the engine is a
  per-device preference, stored the way the typeface is) ·
  [ADR 0034](./0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) (the phone calls no third
  party) · [ADR 0086](./0086-reads-need-the-pairing-token.md) (the model is a read, so it needs the
  token) · [ADR 0019](./0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md) (vendored code is
  re-pinned by a person who reads the diff) · [ADR 0052](./0052-one-build-serves-any-mount.md) (the
  worker finds its files relative to itself) · [ADR 0087](./0087-the-on-device-store-is-one-thing.md)
  (the model is an asset, not session content, so it does not go in `collie-store`) ·
  [ADR 0095](./0095-one-off-commands-and-their-history.md) (what a write token can already do).
- **Trail:** ADR 0029 § *What would justify revisiting* · `docs/voice-and-push.md` → *Quick start:
  Cactus Whistle on this machine* (e99ad833, replaced by this) · the 2026-10-11 measurements (below) ·
  the 2026-10-11 design review (the WAV cap, the child process, the CSP argument corrected) · planned
  reach: `web/public/stt/needle-<version>/` (vendored `needle.js`, `needle.wasm`, `LICENSE`,
  `PROVENANCE.md`) · `web/src/stt/worker.ts` · `web/src/lib/stt-engine.ts` · `web/src/lib/stt-pcm.ts` ·
  `web/src/lib/stt-model.ts` · `web/src/lib/stt.ts` · `web/src/hooks/use-stt-recorder.ts` ·
  `web/src/sw.ts` · `web/src/lib/pwa.ts` · `web/vite.config.ts` · `bridge/server.ts`
  (`STT_WORKER_CSP`, `serveStatic`, the whistle routes, `/api/config`) · `bridge/stt/whistle-model.ts`
  · `bridge/stt/whistle.ts` (the provider) · `cli/stt.ts` (`stt whistle`) · `cli/main.ts`
  (`_whistle-transcribe`) · `CLAUDE.md` → *Security posture*

## Context

ADR 0029 let speech in through the host. The phone records webm/opus (Chrome) or mp4/AAC (Safari),
uploads it to `POST /api/stt`, and the bridge hands it to a provider the operator configured: a cloud
endpoint, the operator's Codex login, or a local command. Each one costs something: a key in the
state dir, room audio leaving the host, or a child process running a command the operator chose.
Since e99ad833 the docs walk an operator to Cactus Whistle behind `local-cli` in four steps, with a
native runner, `ffmpeg` and `jq`, on Linux and macOS only.

What changed is that one small engine now runs well **on the phone and on the host, from the same
bytes**. Measured 2026-10-11:

- **The model.** Whistle (`Cactus-Compute/whistle`), one file, `whistle.cact`, 16,919,407 bytes,
  sha256 `b6e02f04…1dffeb`. Apache-2.0 per its model card and the `LICENSE` file beside it. No
  `NOTICE` file. Its training data is not disclosed. Seven languages: en, de, fr, es, it, nl, pl.
- **The engine.** `needle` (`Cactus-Compute/needle3`, folder `wasm/`): `needle.js`, 63 KB of
  Emscripten glue, and `needle.wasm`, 929 KB (340 KB gzipped). Single-threaded, so no
  `SharedArrayBuffer` and no COOP/COEP. The glue is a classic script that defines one global,
  `createNeedle`. A static read of it at commit `93e88ede` finds no `eval` and no `new Function`;
  its only network use is a `fetch` of the `.wasm` when no `wasmBinary` is passed, and a synchronous
  XHR for lazy files, which nothing here asks for. The wasm imports sixteen functions: C++ throw,
  abort, file, clock, environment and heap calls, nothing else.
- **The speed on a phone.** Pixel 10a, Chrome 154, inside a Web Worker: a 10.4 s clip in 1.0 to
  1.1 s, a 13.0 s clip in about 0.8 s, 0.1 s to start. The wasm heap is about 67 MB.
- **The speed on a host.** bluefin (16 threads), the same pinned pair in Bun 1.4.1, also from a
  binary made by `bun build --compile` loading the glue from disk: 50 ms to load the model, a 10.4 s
  clip in 1.3 s, a 13.0 s clip in 1.0 s, 165 MB peak resident. The native runner did the same clips in
  about 0.7 s.
- **The cost of the bytes.** 18 MB from the bridge over the tailnet took 29 s.

So the condition 0029 named is met. On a recent phone, speech can become text with no upload. On a
weak phone it cannot, and the host engine is the right answer there. **Both are first-class**, and
neither replaces the other. Because the host can run the same wasm, the host engine no longer needs a
native download, `ffmpeg`, `jq` or a platform list, and it runs wherever Collie runs, Windows and
NixOS included.

Four things make this harder than "add a library":

1. **The engine is third-party code running in Collie's origin**, and on the host as the bridge
   user. The origin holds the pairing token and can type into real terminals (`CLAUDE.md`: treat a
   collie as remote shell access). A wasm binary cannot be reviewed by reading it the way the
   vendored lint plugin can.
2. **WebAssembly needs a CSP grant.** The document's policy is `script-src 'self'`, and Chrome refuses
   to compile wasm under it without `'wasm-unsafe-eval'` (WebKit is treated as refusing too).
   Granting that to the document grants it to every script on every page.
3. **17 MB is real.** Not gigantic, but too much to put on every install, and too much to fetch
   behind anyone's back.
4. **A synchronous wasm call blocks its thread for about a second.** On the bridge's thread, that
   is a second in which no phone and no crew peer gets an answer.

## Decision

**A person may choose, per device, to turn speech into text on the phone or on the host. Both run
the same engine code, vendored at a pinned version inside Collie. On the phone it runs only in a
dedicated worker whose own response carries the one CSP that allows wasm; on the host it runs in a
short-lived child of Collie's own binary. The model reaches the host by one deliberate act, a tap in
Settings or `collie stt whistle`, and a phone by its own tap, always from the host, never from a third
party and never by itself. The transcript lands where every transcript lands.**

1. **Two engines, one device preference.** Settings → Voice gets a *Speech engine* card: *Host* or *This
   phone*. *Host* is whatever provider the host runs, `whistle` included, and is the default. *This
   phone* runs Whistle in the browser. The value lives in `localStorage` per device, like the
   typeface (ADR 0033), because whether a phone is strong enough is a fact about that phone. A wipe
   (lib/wipe.ts) keeps it: it is a preference, not session content.

2. **One model on the host, fetched once, by a deliberate act.** Both engines read the same
   `whistle.cact`, kept at `<stateDir>/whistle/whistle.cact` with a manifest beside it. Two acts
   fetch it, and nothing else does:
   - **A tap:** *Download to host (16.9 MB)* in Settings → Voice → Whistle, on a device with the write grant.
     `POST /api/stt/whistle` starts the download on the bridge and answers `202`. It is idempotent: a
     model whose hash already matches answers "ready", and a download in flight is joined, not
     doubled. `GET /api/stt/whistle` reports `absent`, `downloading` (bytes received of bytes),
     `ready` or `failed` with a reason, and Settings polls it once a second while it downloads.
     `DELETE /api/stt/whistle`, behind a two-tap confirm, removes the model and, when the host
     provider is `whistle`, that provider too.
   - **A command:** `collie stt whistle` does the same from a terminal. `--host` also turns on the
     host engine (Decision 4). `--from <path>` takes a file the operator already has, an air-gapped
     copy or the old quick start's, through the same check. `--remove` undoes it.
   - **The download** goes to a pinned Hugging Face commit URL (`resolve/<commit>/whistle.cact`) with
     an honest `User-Agent: Collie/<version>`, redirects followed by hand (at most 5, each `https:`,
     none to a loopback, private, link-local or unique-local address or a name that resolves to
     one), a 32 MiB cap, a 10-minute deadline, streamed to a part file of that download's own
     (`whistle.cact.<pid>.<seq>.part`, 0600) with a running sha256, renamed only when the hash equals
     a pin compiled into this release. `whistle.lock` keeps a second process from starting a second
     download. A mismatch deletes the part file and reports both hashes.
   - **No phone ever fetches the model unasked**, not on install, not on an update, not when the
     preference is set. After the host holds it, each phone that wants *This phone* taps *Set up on
     this phone*, which copies it from the host (Decision 7).

3. **Setting up Whistle from Settings is allowed, and is the one exception to "setup is a CLI act".**
   ADR 0029 kept setup in the terminal because setup can store a credential, name a command the
   bridge will spawn, or open a path that carries room audio off the host. Whistle does none of
   those: it has no credential; its child is Collie's own binary with arguments Collie wrote; and its
   audio stays on the host. What a setup tap adds to the bridge is one outbound download to a fixed,
   hash-pinned address and 17 MB at a fixed path. A stolen write token already types into terminals,
   runs one-off commands (ADR 0095) and starts an update that fetches and builds code, so the tap
   gives it nothing it lacked. The routes are write-gated exactly like `POST /api/stt`, lead-local,
   audited, and allow one download in flight per bridge, so a replayed request cannot hammer the
   upstream. **The sentence in `CLAUDE.md` changes to name this as the second outbound exception,
   beside the update check.** It does not claim "no outbound call" any more, because that was
   already not literal.

4. **The host engine is a provider of Collie's own: `whistle`.** It runs the vendored wasm in a child
   of Collie's binary, one per dictation, through a hidden verb, `collie _whistle-transcribe
   <recording>`. The child reads the glue and the wasm from the served `web/dist/stt/needle-<v>/`
   and the model from the state dir, checks all three against the pins in its own source before it
   compiles anything, transcribes, and prints the text. The provider reuses the `local-cli`
   machinery unchanged: argv only, a private 0700 temp dir, a deadline enforced with SIGKILL (60 s,
   or half the clip's length when that is longer, at most 3 minutes, so a four-minute clip is not
   cut half way; the 2026-10-11 security review) on the process group (the tree on Windows), the 256 KiB stdout cap, the in-flight cap of
   `MAX_CONCURRENT_STT`, no `COLLIE_*` variable of the bridge's passed down (the bridge sets two itself, `COLLIE_STATE_DIR` and `COLLIE_PLUGIN_ROOT`, to paths it resolved), stderr never forwarded. A child, not a
   worker, because a running wasm call stops for certain only when its process dies, because a
   malformed file or a heap grown to 2 GiB dies with the child and not with the bridge, and because
   the compiled binary has one entrypoint.
   - **The phone sends it WAV.** The child has no decoder for webm or mp4, and needs none: the phone
     already turns a recording into 16 kHz mono PCM for its own engine. When the host provider is
     `whistle`, the capability says so (`stt.input: "wav-16k"`), and the phone uploads 16-bit
     little-endian PCM WAV. At 32 KB/s the 8 MiB upload cap holds 4.3 minutes, so this provider
     carries its own recording cap of **4 minutes** (`stt.maxDurationMs`), and the takeover shows that
     cap instead of five. The bridge accepts only `audio/wav` for this provider and checks the header
     (RIFF, PCM, one channel, 16 kHz, 16 bits) before the child starts.
   - **It is turned on deliberately**, by *Use Whistle on the host* in Settings, or by `collie stt whistle
     --host`. From Settings, only when the host has no provider or already has `whistle`: replacing a
     provider the operator configured in the terminal stays a terminal act, and `--host` asks before
     it replaces one. Turning it off from Settings works only when the provider is `whistle`.
   - **It runs wherever Collie runs**: Linux, macOS, Windows, NixOS. In source mode (`bun
     bridge/index.ts` with no compiled binary) the child is `process.execPath` plus the CLI's entry
     file.

5. **The model is never in a release artifact, and Collie publishes no copy.** Altan's call,
   2026-10-11: 17 MB is large for an install that may never use it, and Collie does not know its
   operators' links or disks. No copy goes on Collie's release page either. The engine code (about
   1 MB) does ship in every release, because both engines may load code from Collie's own build and
   nowhere else.

6. **The engine code is vendored, pinned and read.** `web/public/stt/needle-<version>/` holds
   `needle.js` and `needle.wasm` byte for byte as upstream published them at one commit, plus
   upstream's `LICENSE` and a `PROVENANCE.md` (source URL, commit, sha256 of each file, the date).
   A test pins both hashes and the wasm's import list. Re-vendoring is a maintainer's commit, never a
   bot's, and the diff gets a human read (ADR 0019's rule). Because a wasm binary cannot be read, the
   read covers what can be: the glue's diff, the header's diff, and **the import list, which is
   everything the wasm can ask its host to do.** A new import is a reason to stop. The files sit in
   `public/` so Vite copies them untouched and the served bytes are the hashed bytes. The pins live
   in `bridge/stt/whistle-pins.ts`; the web build, which never imports bridge code, keeps a literal
   mirror in `web/src/stt/pins.ts`, and a test fails when the two differ. The wasm's import names are
   minified (`a`.`a` to `a`.`p`); the pin is that list, and the glue's map back to the sixteen
   readable names is recorded beside it.

7. **The phone gets everything from the host, nothing from a third party.** No CDN, no Hugging Face,
   no fallback URL. The engine comes from Collie's own static files, the model from the bridge. The
   reasons, in the order they carry weight:
   - **The phone talks to one origin.** Hugging Face never sees a phone or its address (ADR 0034).
   - **One internet download per host**, not one per phone over whatever link that phone is on.
   - **One place to fix.** The CDN host behind the pinned URL differs by region
     (`us.aws.cdn.hf.co` on 2026-10-11) and has changed before. The bridge follows redirects; a
     phone could only reach the hosts a shipped policy names, so a change would break every phone
     until a Collie release.
   - **The document policy keeps `connect-src 'self'`.** Said honestly: that closes *silent*
     exfiltration only (fetch, beacon, socket, image, form). No CSP directive closes a top-level
     navigation, so a script that ran in the page could still leave with the token in plain sight.
     Keeping the policy closed is a hole not opened, not the wall that decides this.

8. **On the phone, the wasm runs in a dedicated worker, and only the worker's response grants
   wasm.** The document CSP does not change and never gains `'wasm-unsafe-eval'`. The worker script
   is our own code, built by Vite as a classic worker to `stt/worker-<hash>.js`, and it loads the glue
   with `importScripts` relative to its own URL (so a mount works, ADR 0052). The bridge serves every
   `.js` under `stt/` with:

   ```
   Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; base-uri 'none'
   ```

   and `.wasm` as `application/wasm`. Under CSP Level 3 a dedicated worker loaded from a URL runs
   under the policy its own response carries, not its creator's. Chrome has done so since October
   2021 (Chromium "[CSP] Fix dedicated worker inheritance"), and WebKit since January 2016 (bug
   153157, r195948; `Worker.cpp` today takes the response's headers for every worker that is not
   `blob:`, `file:` or opaque). A worker made from a `blob:` URL inherits the document's policy, so the
   worker is never a blob.
   - **The worker has no network.** `default-src 'none'` covers `connect-src`, so the glue cannot
     fetch, XHR or open a socket, and `importScripts` reaches only Collie's origin. The page fetches
     the wasm and the model, checks both hashes, and transfers the bytes in. The glue's own `fetch`
     of the wasm never runs, because `wasmBinary` is always passed.
   - **The worker cannot read the pairing token**, which lives in `localStorage`, which workers do
     not have. It can reach IndexedDB and Cache Storage, which no CSP directive closes. Altan
     accepted that residue on 2026-10-11; it is named under *Consequences*.
   - **Fail closed.** When the worker starts, it compiles an eight-byte wasm module before anything
     else. A browser that does not give the worker its own policy, or does not know
     `'wasm-unsafe-eval'`, refuses that compile, and *This phone* shows as unavailable on that
     browser with a reason. The fallback is the Host engine. The fallback is **never** a wider
     document policy.

9. **The model is a content-addressed read.** `GET /api/stt/model/<sha256>` on the lead. A plain read:
   it needs the pairing token (ADR 0086) and nothing more, because the bytes are public and asking
   for them changes nothing. It answers the file only when the hash in the path equals the hash of
   the file the bridge holds, and `404 stt.model_unknown` otherwise. At most two copies leave at once; a third gets
   `503 stt.model_busy` with `retry-after: 5`. The hash is compared, never joined into a path, so this is not a new
   place where a client value becomes a path. `content-type: application/octet-stream`,
   `content-length`, `etag` set to the hash, `cache-control: no-store` (the phone keeps its own
   copy, and the HTTP cache should not keep a second one), `content-security-policy: default-src
   'none'; sandbox`, no gzip, and no ranges. `/api/config` carries `whistle: { state, sha256, bytes }`
   on a lead that knows this feature, so Settings can offer the setup tap; `sha256` is present only
   while the bridge holds a model whose hash matches a pin this release accepts. Alongside it, while
   the manifest names the held file, the status carries `revision` (the Hugging Face revision) and
   `fetchedAt`, which Settings → Voice shows as the installed version and download time. The bridge hashes
   the file once per change of its size or mtime, not per request.

10. **The phone checks the hash, keeps the copy, and asks to keep it.** The model is stored in Cache
    Storage under a cache of its own, only after its sha256 matched the capability, and only from a
    `200` that was not redirected. The page hashes it again once per page session before the first
    load, and the worker checks the wasm's hash before it compiles. The download asks
    `navigator.storage.persist()` and says what the answer means. The service worker's activate sweep
    spares the model while this build still accepts its hash. The stuck-update recovery in
    `lib/pwa.ts`, which deletes every cache, skips this one by name: a stale model cannot cause a
    stale app. The pairing wipe takes it with everything else in Cache Storage: it was fetched with
    the token, so it leaves with the token. The recorder asks `getUserMedia` for one channel, so a
    five-minute decode is not doubled by a stereo stream.

11. **The transcript lands through `acceptTranscript`.** Same caret insert, same hands-free rules
    (an empty draft, no password prompt, no dialog, online, not locked). On the phone engine the
    audio never leaves the phone, so `POST /api/stt` is not called and nothing is audited on the
    bridge.

12. **No silent switch between engines.** When *This phone* cannot transcribe a clip (no model, a
    hash mismatch, a crash, out of memory, a timeout), the takeover says why and offers *Send to
    host* as one tap, only while the host has an available provider. It never sends the audio to
    the host by itself, because the person chose an engine whose point is that audio stays put. A clip that failed on the phone stays
    in memory, in a `failed` phase, until the person taps *Send to host* or discards it. That relaxes
    ADR 0029's "a failure keeps nothing" for the phone engine only: the host engine still keeps nothing
    after a failure.

## Consequences

- **Third-party code runs in Collie's origin and as the bridge user.** Its reach is bounded, not
  removed. On the phone the worker has no network, no DOM, no token and no way to load code from
  elsewhere; it can still read and write this origin's IndexedDB (`collie-store` holds recent session
  text, ADR 0087) and Cache Storage. On the host the wasm runs in a child with none of the bridge's `COLLIE_*`
  variables and a deadline, and the wasm itself reaches the process only through its sixteen pinned
  imports. On both, it can hand back any text it likes; with hands-free on, that text is sent into a
  terminal through the guarded reply path, the same trust a provider's answer already gets. What
  limits it is the pin, the read of each bump, and the import list.
- **The bridge gains a second outbound path**, beside the update check: one download, on a write
  device's tap or an operator's command, to a pinned address. `CLAUDE.md`'s posture sentence names
  both.
- **The setup-is-a-CLI-act rule is no longer absolute.** It holds for every provider that stores a
  credential, spawns an operator's command, or sends audio off the host. A future provider that does
  none of these may follow Whistle's path; one that does any of them may not.
- **About 1 MB more in every release** (63 KB glue, 929 KB wasm), and about 1 MB more in git per
  engine bump. It is not precached: `stt/**` is in the precache's ignore list, the way the Nerd Font
  subsets are, and the service worker caches it cache-first under its own name only after the
  person downloaded the model, so that the engine also works offline.
- **A host engine dictation costs a child process**: about 165 MB for a second or two, at most two at
  once. A host that cannot spare that should leave *Use Whistle on the host* off.
- **The host engine records for 4 minutes, not 5.** The WAV upload is about four times the size of
  the compressed one, and the 8 MiB cap stays.
- **The phone needs a 17 MB copy per device**, about 30 s over a tailnet, restarted from zero if it
  breaks. No resume: Cache Storage keeps whole responses only, and a resume would need a partial
  store, a second validator and range handling on the bridge, for one file fetched once.
- **Pinned pairs drift.** Upstream replaced `needle.wasm` on 2026-10-10 and left `needle.js` from
  2026-10-05. The pin is the pair, tested together (the 2026-10-11 host and Pixel runs used exactly
  the pinned pair), and a bump that moves one file and not the other is read twice.
- **A host may hold a model that this release no longer accepts.** After an update with a new pin,
  `whistle.sha256` disappears and Settings offers the setup tap again. `collie stt status` and
  `collie doctor` say so in words. A pin bump keeps the previous hash in the accepted list unless the
  engine cannot read the old file.
- **WebKit is checked in a WebKit build, not on an iPhone.** The maintainer has none. The `wk`
  distrobox and CI's WebKit run cover the worker policy, the wasm compile and the decode path. iOS on
  a device stays unverified until someone reports it.
- **The native quick start is retired.** `docs/voice-and-push.md` points at the tap and at
  `collie stt whistle --host`. An operator who kept the `local-cli` wrapper keeps a working provider;
  nothing touches it.

### Alternatives considered

- **Bundle the model in every release.** One step less for the operator, and the phone engine works
  on day one. Rejected by Altan on 2026-10-11: everyone pays 17 MB for a feature some will never
  turn on, on links and disks Collie knows nothing about.
- **The phone fetches the model, or the engine, from Hugging Face.** No host step at all, and it
  works: the pinned URL is stable and answers CORS for our origin. Rejected for Decision 7's reasons:
  every phone becomes a client of a third party, every phone downloads over its own link, and a CDN
  change breaks phones until a release. A downloader worker with a policy of its own could keep the
  document closed, so the CSP is not the reason.
- **`'wasm-unsafe-eval'` in the document CSP.** One line, and the engine could run anywhere. Rejected:
  it widens the policy of the page that holds the token and drives terminals, for code that needs it
  in one place.
- **A `blob:` worker, or the engine on the main thread.** A blob worker inherits the document's
  policy, so it needs the same hole. The main thread would also freeze the UI for a second per clip.
- **A sandboxed iframe around the worker**, so the engine gets an opaque origin with no IndexedDB
  and no Cache Storage. A real gain against the residue named above. Not now: it needs a second
  document, a `frame-src` grant, and a blob worker inside the frame, and the measured design works
  without it. It is the first hardening step to take if the residue starts to matter.
- **The host engine as Cactus's native runner** (the 2026-10-11 first draft, `--host` downloading
  `needle` for the platform plus the quick start's wrapper). Faster, about 0.7 s a clip. Rejected:
  a native executable from a third party, run unsandboxed as the bridge user, three platform pins per
  bump, `ffmpeg` and `jq` on the host, and no Windows or NixOS.
- **The host engine in a Bun worker or on the bridge's thread.** No child to spawn. Rejected: on the
  thread, every dictation stalls every phone and peer for a second; a worker needs a second
  entrypoint in the compiled binary, and `terminate()` during a running wasm call is not a certain
  stop. A child is, and the `local-cli` code that bounds one already exists.
- **Decode webm and mp4 on the host.** The phone could upload what it records today. Rejected: it
  needs a decoder on the host, which is `ffmpeg` again, while the phone already has one.
- **Setup stays a CLI act only.** Rejected by Altan on 2026-10-11 for Whistle: the operator should
  not need a terminal for a feature whose setup carries no credential, no foreign command and no
  egress of audio. `collie stt whistle` stays for those who prefer it.
- **Reuse the quick start's file automatically.** It sits outside the state dir, at a path the
  operator chose, and Collie does not go looking. `--from <path>` takes it on purpose.
- **Browser `SpeechRecognition`.** Still rejected for ADR 0029's reason: on the phones that matter it
  is absent, or it ships the audio to the browser vendor.
- **Silent fallback to the host on failure.** Kinder in the moment, and wrong: it would move audio
  off the phone without the person's word.

### What would justify revisiting

- **A browser that will not give a dedicated worker its own policy**, and matters. Then the
  sandboxed frame above, not the document policy.
- **Evidence that the IndexedDB and Cache Storage reach is being used**, or a bump whose import list
  grows. Then the sandboxed frame, at once.
- **Upstream publishing a signed release** (a tag with signatures, or a package with provenance).
  The pin could then follow a signature as well as a hash.
- **Streaming text.** `needle_stream_transcribe_process` could show words while the person speaks.
  That wants an AudioWorklet tap during recording instead of a decode after stop, and it is the first
  follow-up once the batch path has run on real devices.
- **A host engine that is too slow on small hosts.** A Raspberry-class host may take several seconds
  a clip in wasm. Then a native runner may come back as an opt-in, under the same pins.
