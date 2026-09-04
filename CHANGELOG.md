# Changelog

This file tracks all notable changes to Collie, ordered newest version first. The project follows
[Semantic Versioning](https://semver.org/). Each version contains a single flat list of changes
in landing order, oldest first. Every entry links to its commit and credits the contributor where
there is one. The `## [Unreleased]` section contains merged work waiting for release. The release
commit renames this heading to `## [x.y.z] - YYYY-MM-DD`, adds the commit hashes, and adds a new
empty `## [Unreleased]` section above it. The newest numbered `## [x.y.z]` heading (excluding the
Unreleased heading) **must** match the `version` field in `herdr-plugin.toml`, `package.json`,
and `web/package.json`, which `scripts/check-version.sh` checks. See [`CLAUDE.md`](./CLAUDE.md) →
*Versioning* for the bump policy.

## Upgrading

**Already on 1.x?** Run `collie update`, or run
`herdr plugin action invoke update --plugin herdr.collie`. Check the result with
`bin/collie version` (or `herdr plugin action invoke version --plugin herdr.collie`). It shows the
newest tag. The phone PWA updates itself within about a minute; no reload needed.

**Coming from 0.x?** Upgrade with one command. Do not use `collie update`. From the Herdr
plugin: `herdr plugin action invoke update-major --plugin herdr.collie`. From a checkout you can
reach: `bin/collie update --major`. Fresh install:
`curl -fsSL https://colliepwa.dev/install.sh | sh`. Neither upgrade path assumes a `collie` on your
PATH. Details and rollback: [`docs/upgrading.md`](./docs/upgrading.md) → *Upgrading from 0.x to
1.0*.

## [Unreleased]

- Docs carry phone screenshots of the update flow.
- The refusal and `collie doctor` now spell the fix as `COLLIE_MUX=<mux> collie start`, and name the file it lands in.
- `COLLIE_MUX=tmux collie start` now writes the choice to `.env`, so the next plain `start` and the supervised unit both see it.
- The installed app no longer locks to portrait, so a tablet can run Collie in landscape, thanks @edwinhu (#162); the pane and history screens sit in a centred column above phone width, like every other screen.
- Release pages link to the version's changelog section instead of copying it, and carry GitHub's generated list of pull requests, contributors and the compare link.

## [1.5.0] - 2026-09-04

- Pane detail: dragging the status line strip above the switcher handle no longer scrolls the composer out of view. ([7b77d7c](https://github.com/AltanS/collie/commit/7b77d7c))
- Tapping a push notification opens the app again on Android; the tap no longer waits on a discarded tab before it may open a window (regression since 1.2.0). ([ecee7c2](https://github.com/AltanS/collie/commit/ecee7c2))
- Updates page at `/settings/updates`: the check, the update card, a read-only line per pack member, and one action button. ([9ab65bc](https://github.com/AltanS/collie/commit/9ab65bc))
- Settings keeps one "Updates" row with a status line and a chevron; the footer update chip and the update card left the page. ([9ab65bc](https://github.com/AltanS/collie/commit/9ab65bc))
- An update push now opens the Updates page. The wire value is unchanged, so an old service worker still lands on Settings. ([9ab65bc](https://github.com/AltanS/collie/commit/9ab65bc))
- Every pack member reports its own update preflight over the link, and `GET /api/update/check` answers with a dated `pack` row per member. ([4667c8a](https://github.com/AltanS/collie/commit/4667c8a))
- `collie pack update` prints each member's peer-reported verdict beside its SSH one and names a disagreement. ([9913b5a](https://github.com/AltanS/collie/commit/9913b5a))
- `collie update --to-tag v<x.y.z>` pins an update to one exact release; it refuses a prerelease, a downgrade and a major crossing. Plumbing, not an operator verb. ([7c42d2f](https://github.com/AltanS/collie/commit/7c42d2f))
- One top-of-app update band, replacing the self-update row: release on offer, confirm just tapped, run in flight, new bridge, and peers following. ([ff4bf25](https://github.com/AltanS/collie/commit/ff4bf25))
- A peer follows its lead: it levels itself to the release its lead is running, taking the exact tag from GitHub over anonymous HTTPS, behind its own preflight, health gate and rollback. The lead grants one turn at a time and states nothing while it is mid-run. ([0f8c337](https://github.com/AltanS/collie/commit/0f8c337))
- The Updates page and the band report each peer's leg of a pack-wide run: waiting, updating, updated, rolled back or unreachable. ([07d305e](https://github.com/AltanS/collie/commit/07d305e))
- `POST /api/update` accepts `peersOnly: true`, the Updates page's "Retry pack update": a new run whose only legs are the peers. ([bbfa7c1](https://github.com/AltanS/collie/commit/bbfa7c1))
- Known gap: a lead rolled back by hand after its peers have levelled leaves them ahead of it. No peer is ever stepped down over the pack link; the remedy is `collie pack update <member>` from the lead. ([f61a246](https://github.com/AltanS/collie/commit/f61a246))
- The snapshot and `GET /api/update/check` compose the update status from one place, so the band and the Updates page can never disagree about a run. ([dcaa51d](https://github.com/AltanS/collie/commit/dcaa51d))
- One confirm on the phone updates a whole pack: the lead first under its own health gate, then each peer, one at a time. ([e4d12af](https://github.com/AltanS/collie/commit/e4d12af))
- Every pack member reports its running version on the sweep, so the lead no longer shows a peer's version as blank and a peer that finished updating is marked done and hands on its turn. ([94308d9](https://github.com/AltanS/collie/commit/94308d9))

## [1.4.1] - 2026-09-03

- Update card says "Up to date. Nothing to do." at the top and folds the preflight details unless a check is red or an update is available. ([235ab1b](https://github.com/AltanS/collie/commit/235ab1b))
- The phone's update preflight checks this instance only (`update --check --local`), so an unreachable pack peer no longer turns the lead's card red. ([fd4be21](https://github.com/AltanS/collie/commit/fd4be21))
- The preflight lists release tags over anonymous HTTPS when `origin` is a GitHub SSH URL, and quotes git's own error, so a missing SSH agent no longer reads as a dead remote. ([fd4be21](https://github.com/AltanS/collie/commit/fd4be21))
- The update card no longer says "the newest release isn't known yet" right after a restart, its first read now waits briefly for the delayed startup poll instead of answering with a stale null. ([203dd07](https://github.com/AltanS/collie/commit/203dd07))

## [1.4.0] - 2026-09-03

- Operator launchers: your own commands, declared in `launchers.toml`, tapped to start. They live on the dashboard and in the "Switch pane" sheet, not in a pane or Space header. (#125) ([12dd5e8](https://github.com/AltanS/collie/commit/12dd5e8))
- Update notifications are a digest: at most one push a day, naming every release it folded, never before 09:00. A patch-only delta rides a weekly digest instead, or a minor that arrives first. ([f05b4de](https://github.com/AltanS/collie/commit/f05b4de))
- `POST /api/update/snooze` dismisses the current update digest until a newer release and a fresh window. ([f05b4de](https://github.com/AltanS/collie/commit/f05b4de))
- `pack update --path '~/…'` expands the tilde on the remote's own `$HOME`, not this machine's. ([f05b4de](https://github.com/AltanS/collie/commit/f05b4de))
- `pack update --host` remembers the ssh route as soon as the probe proves it, not only after a
  fully successful run. ([f05b4de](https://github.com/AltanS/collie/commit/f05b4de))
- `collie update --check [--json]`, a read-only preflight over doctor, disk, bun, the tracked-file tree, upstream and the service unit, plus every pack member on a lead. ([8c9e5d4](https://github.com/AltanS/collie/commit/8c9e5d4))
- A linked checkout updates by staging: `collie update` builds a release into a `versions/vX.Y.Z` git worktree and flips the `current` symlink, so a failed build never touches the running install and `collie update --rollback` works on a checkout (ADR 0006, amended) ([7845c87](https://github.com/AltanS/collie/commit/7845c87))
- `bun run test` no longer exits 0 when a test fails: a probe script called process.exit on import. ([b2a86cf](https://github.com/AltanS/collie/commit/b2a86cf))
- `collie update` stages, then hands the swap to a detached updater: it flips `current`, restarts, polls `/api/health` for 30 s (`COLLIE_UPDATE_HEALTH_TIMEOUT_MS`), and rolls back once by itself if the new version does not answer. Watch it with `collie update --status`. ([d569ffc](https://github.com/AltanS/collie/commit/d569ffc))
- `collie pack update` is one sequence: preflight every machine, update the lead first, then each peer in turn, health-gated. The first failure stops the run and leaves the rest untouched, with the recovery command named. ([fa57012](https://github.com/AltanS/collie/commit/fa57012))
- Update Collie from the phone: a settings card with the version, the newest release, the preflight per check and its state, behind `POST /api/update`: same gate as a send, one confirm, and its own confirm for a major. ([3f4caf9](https://github.com/AltanS/collie/commit/3f4caf9))
- `collie update --check` no longer turns red, and the phone's Update button no longer disables, on a lead whose peer has no ssh record: that fact still shows red on the member, but updating the lead needs no route to a peer, so the top verdict is amber. ([08c0b0b](https://github.com/AltanS/collie/commit/08c0b0b))
- A table in the mirror pans in its own scroller while the prose around it keeps wrapping, so Wrap no longer has to be turned off to read one. A box-drawn table pans as one unit; a framed row outside a table still does not wrap. (#5, #158) ([8d079ff](https://github.com/AltanS/collie/commit/8d079ff))
- Codex on a phone: submitted-message rows no longer render as solid black bars in the light theme, and a labelled `─ Worked for … ───` separator stays on one line. (#144) ([0104d27](https://github.com/AltanS/collie/commit/0104d27))
- A launcher's `cwd` is optional: pin one and it wins everywhere, leave it out and it means "here", your home dir from the dashboard, that pane's own folder from the switcher. ([7efad18](https://github.com/AltanS/collie/commit/7efad18))
- Tapped from a pane, a launcher opens a tab beside it instead of a new Space; tapped from the dashboard, a Space, as before. ([7efad18](https://github.com/AltanS/collie/commit/7efad18))
- Launcher rows read live per host, so on a pack they come from the machine whose row you tapped, never the lead's own file. ([7efad18](https://github.com/AltanS/collie/commit/7efad18))
- The new-tab and new-Space controls show a spinner and ignore a second tap while the create is in flight; the pane list catches up within a poll burst after any create or close. ([d03ccd7](https://github.com/AltanS/collie/commit/d03ccd7))
- The "Switch pane" sheet rises from its handle and follows the thumb as you drag, instead of appearing at the screen's bottom edge only on release, and it opens with a haptic tick. ([5bfa631](https://github.com/AltanS/collie/commit/5bfa631))
- On the pane screen a status now shows in the header title instead of floating over the tab strip's own controls. ([5bfa631](https://github.com/AltanS/collie/commit/5bfa631))

## [1.3.0] - 2026-09-03

- Mirror no longer freezes when the soft keyboard or Keys dock shrinks the pane: a scroll that arrives with a changed container height is layout, not the user leaving the bottom (#155) ([1862276](https://github.com/AltanS/collie/commit/1862276))
- Boxed TUI rows (a `/model` picker, a panel border) stay on one line on a narrow phone mirror instead of wrapping into a scrambled frame; `tree` output and prose still wrap, thanks @alexlee2046 (#156) ([d7a4276](https://github.com/AltanS/collie/commit/d7a4276))
- Releases publish a linux-arm64 build, so a Raspberry Pi installs instead of 404ing; the from-source docs call the bootstrap script with bash, which it is (#157) ([64c7d7e](https://github.com/AltanS/collie/commit/64c7d7e))
- Mirror polling follows what you do: 300ms bursts after a key or a message while the screen keeps changing, 1.5s while you follow a working agent, 4s on the home screen while an agent works, 6s when nothing says you are watching (#156) ([d2cb8a3](https://github.com/AltanS/collie/commit/d2cb8a3))
- Pairing no longer logs `could not stamp lastSeenAt: ENOENT` once a minute: concurrent stamps from one poll tick raced on a shared temp file; writes are serialized and temp names are unique now (#159) ([d4bd3f9](https://github.com/AltanS/collie/commit/d4bd3f9))

## [1.2.0] - 2026-09-02

- oh-my-pi panes show omp's own π mark, painted with its official three-stop gradient, instead of the initials tile; the brand table now says every mark must be painted, thanks @enieuwy (#151) ([17386ef](https://github.com/AltanS/collie/commit/17386ef))
- The OMP adapter recognises the open-ended `╰─ <draft>` composer row and standalone status row that OMP 18.1.2 paints on a wide pane; the closed OMP 17 box and the corner-to-corner modal rule are unchanged, thanks @ImArtisann (#149, #150) ([6081520](https://github.com/AltanS/collie/commit/6081520))
- A notification tap on Android opens the deep-linked pane again when the Collie tab had been discarded; navigate before focus, and fall through to a new window when no tab survives. (#147) ([18cd9cb](https://github.com/AltanS/collie/commit/18cd9cb))
- A functional commit now records one line under `## [Unreleased]` instead of bumping the version; the pre-commit hook enforces both halves, and only the `chore(release):` commit bumps and dates the heading. ([f6805cb](https://github.com/AltanS/collie/commit/f6805cb))
- `collie stt test` now sends the two containers a phone actually records, webm/opus and mp4, after the wav probe, and fails with guidance when the provider refuses one; Voxtral on OpenRouter refuses both, whisper-large-v3-turbo accepts them (#148) ([d6d7a1c](https://github.com/AltanS/collie/commit/d6d7a1c))
- A refused transcription names the upstream status and the container it was sent as, so the phone's error says which format the provider rejected (#148) ([d6d7a1c](https://github.com/AltanS/collie/commit/d6d7a1c))
- The mirror's default font size is 10px, down from 12; a device that already picked a size keeps it ([4b005aa](https://github.com/AltanS/collie/commit/4b005aa))
- Android push notifications show a proper small badge glyph and a full-size Collie mark; the maskable home-screen tile was doing both jobs and rendered as a grey block on the notification ([177a8a9](https://github.com/AltanS/collie/commit/177a8a9))
- Renaming a tab or pane from its sheet works on the phone again; the rename field's own keyboard used to fold the strip band and unmount the sheet mid-edit ([93373ce](https://github.com/AltanS/collie/commit/93373ce))
- Dashboard rows lead with the pane title beside a small agent tile, with the space and tab as the address beneath; the big tile, the bold space name and its truncation are gone ([c442429](https://github.com/AltanS/collie/commit/c442429))

## [1.1.0] - 2026-09-01

- The "Side by side" instructions moved out of `docs/upgrading.md` into their own `docs/deployment.md` section. ([0231500](https://github.com/AltanS/collie/commit/0231500))
- The read-only strip links to Settings → Paired devices. ([defec91](https://github.com/AltanS/collie/commit/defec91))
- Per-host colour on the server glyph in pack mode, ten stable hues. ([e3db22d](https://github.com/AltanS/collie/commit/e3db22d))
- Pull-to-refresh; polling already keeps the view fresh. ([86e8d78](https://github.com/AltanS/collie/commit/86e8d78))
- The new-space sheet picks the host in pack mode; unreachable or incompatible members are shown but disabled. ([af22f6d](https://github.com/AltanS/collie/commit/af22f6d))
- **Claude's slash-command autocomplete no longer hides the input box.** The completion list is taller than the statusline window the chrome walk allows, so the box went undetected: the pane fell back to the raw mirror and every send stalled with "Message didn't reach the input box". The popup is now read as its own block and rendered as a list. ([c265d3e](https://github.com/AltanS/collie/commit/c265d3e))

## [1.0.2] - 2026-09-01

- `docs/deployment.md` ends with one footer instead of two. A plain-text `← back to the README` line sat above the real link, and the site footer strip matches only the link, leaving the plain line as a dangling sentence. ([e880281](https://github.com/AltanS/collie/commit/e880281))
- **The working status dot no longer pings; it breathes.** It uses a 2.4 s opacity cycle without a ring or scaling, applied only to the pane chip and the pane header. The dot stays static on the tab, space, card and overview chips, where several at once would read as a strobe rather than as "alive". `prefers-reduced-motion` still disables it. ([a2ee186](https://github.com/AltanS/collie/commit/a2ee186))
- **A lead is no longer deposed by unprovable claims.** At boot, only a warrant signed and verified by this lead can depose it. If a peer reports a higher warrant generation or refuses with no warrant, the lead logs the event once and ignores it. Stale fields from an old pack no longer take down the new lead's front door. ([bd7e3b5](https://github.com/AltanS/collie/commit/bd7e3b5))
- `collie pack leave` clears the deputy designation, warrant, standby roster, and `standby-devices.json`, preventing old pack state from leaking into the next pack. ([bd7e3b5](https://github.com/AltanS/collie/commit/bd7e3b5))
- `collie pack remove <member>` drops the deputy designation if it names that member, keeping `pack status` and `pack deputy --revoke` in agreement. ([bd7e3b5](https://github.com/AltanS/collie/commit/bd7e3b5))
- Stored warrants stamped with another pack's id are discarded at boot, logging the source pack name. ([bd7e3b5](https://github.com/AltanS/collie/commit/bd7e3b5))

## [1.0.1] - 2026-09-01

- **`collie pack join bluefin` works in a terminal**: an address without a scheme or port uses port 8787, the command prompts for the token, and a lead answering over plain HTTP requests confirmation instead of requiring `--insecure` ([6e3dfca](https://github.com/AltanS/collie/commit/6e3dfca))
- `collie pack invite` prints the short join command first, followed by the stdin form for scripts ([6e3dfca](https://github.com/AltanS/collie/commit/6e3dfca))
- `--label` defaults to the local hostname, so a joining peer uses its host name instead of `collie-8f3a2b1c` ([6e3dfca](https://github.com/AltanS/collie/commit/6e3dfca))
- `collie pack join` and `collie pack leave` are the canonical commands; `collie join` and `collie leave` remain as aliases ([6e3dfca](https://github.com/AltanS/collie/commit/6e3dfca))
- **The install and update docs lead with the two shapes an install actually has**, and neither assumes a bare `collie` on your PATH: a Herdr-managed install spells every verb as a plugin action, a standalone one as `bin/collie <verb>`. `docs/install.md` is two ways in rather than four, and ends with the update command it never carried; `docs/upgrading.md` opens on the update instead of the uninstall, folds the two 0.x sections into one crossing, and drops the finished v1 beta train.
- **`DEPLOYMENT.md` is now [`docs/deployment.md`](./docs/deployment.md), and colliepwa.dev publishes it.** The site serves the files the README's documentation table lists, so every link to a front door other than the default used to leave the site. Each variant keeps its anchor; in-code pointers name the new path, including the `COLLIE_SKIP_SERVE` warning and `collie doctor`'s serve finding.
- The post-update hooks nudge swallows a spawn failure of the new binary (ENOEXEC/EACCES) instead of failing an update that already succeeded — the silence its own comment promised.
- `collie restart` decides the multiplexer before it stops the bridge, so a refusal no longer leaves the bridge down.
- The refusal lists each multiplexer on its own line, points at the one the environment already names, and prints the exact line to append.
- `collie join` with only a lead address says that the token is missing and shows how to pass it, instead of a bare usage line.

## [1.0.0] - 2026-09-01

**This release is the whole `1.0.0-alpha` / `1.0.0-beta` line in one entry**, grouped once; the
per-release detail lives in the linked commits and the git history. Coming from 0.x, read
[`docs/upgrading.md`](./docs/upgrading.md) → *Upgrading from 0.x to 1.0* first.

**Upgrading, in one line each.** From the Herdr plugin:
`herdr plugin action invoke update-major --plugin herdr.collie`. From a checkout you can reach:
`bin/collie update --major`. Fresh install: `curl -fsSL https://colliepwa.dev/install.sh | sh`.
Neither upgrade path assumes a `collie` on your PATH. Details and rollback:
[`docs/upgrading.md`](./docs/upgrading.md).

- **A pack brings several machines to one phone.** A lead merges its peers' spaces, tabs and panes and proxies every read and write byte for byte; `collie pack invite | join | add | update | leave | status | rotate | remove | promote | reconnect | set-address` are the verbs ([9f5d91e](https://github.com/AltanS/collie/commit/9f5d91e), [c5a810f](https://github.com/AltanS/collie/commit/c5a810f))
- **A lead is demoted only against a live approval minted on itself: `collie pack approve-promote <member>`.** Ten minutes, single use, `--cancel`, fingerprint-bound; `pack rotate` still has no grace window and now warns that it has none ([5667c8f](https://github.com/AltanS/collie/commit/5667c8f))
- **`scripts/collie-ctl.sh` is a bootstrap shim and nothing else.** Every verb is spelled `bin/collie <verb>` and the shim no longer sources `.env`, so a `BUN_INSTALL` set only there must move to the environment ([cfc09d5](https://github.com/AltanS/collie/commit/cfc09d5))
- **`collie doctor` — one read-only pass over the traps that fail silently.** Bind, ACL, front door, `web/dist`, the multiplexer, the beacon hooks and pack health, each finding naming the verb that fixes it, warnings exiting 0 and `--json` making the report scriptable ([8590086](https://github.com/AltanS/collie/commit/8590086), [3e5b4c1](https://github.com/AltanS/collie/commit/3e5b4c1))
- **Device pairing.** `collie pair` mints a one-time code the phone spends for a bearer token, every write needs that token while any device is paired, and `collie devices list | revoke <label>` are the other half ([506be94](https://github.com/AltanS/collie/commit/506be94))
- **Collie drives tmux and zellij, not only Herdr.** `COLLIE_MUX=tmux` or `COLLIE_MUX=zellij` picks the multiplexer behind one Collie-owned port, where each adapter declares its capabilities and the UI reads them from `GET /api/config` rather than from a name ([2feb1aa](https://github.com/AltanS/collie/commit/2feb1aa), [4d6787f](https://github.com/AltanS/collie/commit/4d6787f))
- **A peer's panes render on the phone again.** The lead no longer re-declares `Content-Encoding: gzip` over a body Bun already decompressed; the saving came back as a transform on the lead→phone hop ([9a17dda](https://github.com/AltanS/collie/commit/9a17dda))
- **Agents name themselves through their own hooks.** `collie hooks install claude` writes the guarded Claude emitter and `collie beacon emit` gives a pane its agent's name, status and session ref ([b17e8c5](https://github.com/AltanS/collie/commit/b17e8c5), [cb7eb7b](https://github.com/AltanS/collie/commit/cb7eb7b))
- **A deputy takes over when the lead goes dark, on the operator's tap.** `collie pack deputy <member>` mints a signed, generational warrant and arms a standby door on `COLLIE_STANDBY_PORT`; there is no automatic election ([86c4510](https://github.com/AltanS/collie/commit/86c4510), [a696e94](https://github.com/AltanS/collie/commit/a696e94))
- **`url`, `status`, `serve` and `qr` defer to `COLLIE_PUBLIC_URL`** wherever it is set, instead of printing the bare tailnet name (#122) ([d1e671e](https://github.com/AltanS/collie/commit/d1e671e))
- **Voice input — a microphone in the composer, and hands-free.** Off until `collie stt setup`, round-tripped by `collie stt test | status | off`, served by the `openai-compatible` or `codex` provider, with `--lang` / `COLLIE_STT_LANG` for the spoken language ([14575b3](https://github.com/AltanS/collie/commit/14575b3), [ca5564a](https://github.com/AltanS/collie/commit/ca5564a))
- **The loopback gates fail closed.** Host validation is on, `COLLIE_TRUSTED_USER` rejects an absent login as well as a wrong one, a non-loopback bind refuses to start behind the opt-outs `COLLIE_ALLOW_ANY_HOST=1`, `COLLIE_TRUSTED_USER_OPTIONAL=1` and `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`, uploads are typed by magic bytes, and `.env` is held to owner-only and announces every variable it shadows ([b0f6711](https://github.com/AltanS/collie/commit/b0f6711), [d941de1](https://github.com/AltanS/collie/commit/d941de1))
- **Collie's UI in six languages.** English, Deutsch, Español, 한국어, 日本語 and 中文, picked in Settings per device from a typed dictionary, with every bridge refusal carrying a stable `code` and named `detail` ([42949cf](https://github.com/AltanS/collie/commit/42949cf))
- **A pack overview page at `/pack`.** One read-only card per machine — health, version, secret pickup, deputy — fed by `GET /api/pack` and hidden unless this collie is in a pack ([0634d4b](https://github.com/AltanS/collie/commit/0634d4b))
- **A new mark and a new icon family, and they move.** The mark drifts at rest and turns one full round whenever the app has something to tell you, `prefers-reduced-motion` stops it, the favicons and tiles were redrawn to match — the 16px tab favicon refilled and its eye held open, so it no longer reads as a horse — and every mutating call must name the channel that acknowledges it (`lib/ack-manifest.ts`) ([526c313](https://github.com/AltanS/collie/commit/526c313), [e0aeb7b](https://github.com/AltanS/collie/commit/e0aeb7b), [1b248af](https://github.com/AltanS/collie/commit/1b248af), [b836958](https://github.com/AltanS/collie/commit/b836958))
- **Zen mode, and chrome that gets out of the way.** Settings → Zen mode takes every Collie surface off the screen and leaves the mirror alone, and short of that a chevron folds the tab and pane strips into one 24px bar of beads (#139 — thanks @abosnjakovic) ([a8bf60a](https://github.com/AltanS/collie/commit/a8bf60a), [f60d009](https://github.com/AltanS/collie/commit/f60d009))
- **Four agent-parser fixes carried over from the 0.x line.** Codex's one-dim-segment status row, a Codex draft wrapped onto an indented line, oh-my-posh 18's ghost suggestion read as your text, and the Windows bridge now running under `conhost.exe --headless` ([c6ba534](https://github.com/AltanS/collie/commit/c6ba534), [89cbbe0](https://github.com/AltanS/collie/commit/89cbbe0), [d4a9030](https://github.com/AltanS/collie/commit/d4a9030), [baf04ac](https://github.com/AltanS/collie/commit/baf04ac))
- **Work you used to walk back to the desk for.** Worktrees created through the multiplexer (#135 — thanks @broven), "All sessions" as one triage list, "Show in terminal" on your tap, and `quick-replies.toml` for your own Quick dock (#131 — thanks @fucx) ([50e0e42](https://github.com/AltanS/collie/commit/50e0e42), [0296391](https://github.com/AltanS/collie/commit/0296391))
- **The app's typeface is yours — Settings → Typeface, per device.** System, Space Grotesk or Aldrich, applied before first paint; `theme.toml` adds your own faces, and Settings → Terminal font (13–16, default 14) sizes the draft field separately ([edfe042](https://github.com/AltanS/collie/commit/edfe042), [e6e9142](https://github.com/AltanS/collie/commit/e6e9142))
- **Aldrich is the shipped default face, and no face is faked bold any more.** Every default mechanism moved with it, and `font-synthesis-weight: none` stops the engine inventing weights a face does not ship ([a960f1f](https://github.com/AltanS/collie/commit/a960f1f))
- **`collie join` refuses an `http://` lead address unless `--insecure` is passed**, and an invite without the lead's certificate fingerprint is refused outright ([0029881](https://github.com/AltanS/collie/commit/0029881))
- **A peer can reach its own lead.** The lead is dialled unpinned, because its front door terminates TLS and the pinned certificate can never be on the wire, while a witness stays pinned ([33fa455](https://github.com/AltanS/collie/commit/33fa455))
- **Two upgrade guides that did not exist before.** `docs/upgrading.md` gains *Upgrading from 0.x to 1.x* for an operator and *You run a fork* for a checkout whose `origin` is not this repo, which `collie update` now refuses instead of force-detaching ([e9e4f85](https://github.com/AltanS/collie/commit/e9e4f85), [05a4b23](https://github.com/AltanS/collie/commit/05a4b23))
- **Collie ships binaries, and installs with one command.** Every `v*` tag publishes checksummed per-platform tarballs, `install.sh` verifies one and links it onto PATH without sudo, and `collie update` fetch-verify-swaps with auto-rollback (`--rollback`, `--major`, `COLLIE_TAG` to pin one release) ([73402b5](https://github.com/AltanS/collie/commit/73402b5), [d2706d9](https://github.com/AltanS/collie/commit/d2706d9))
- **Collie introduces itself as its own product, CLI-first.** The tagline, descriptions and manifest call it a phone UI for the agents in your terminal, the README became a hub plus nine `docs/` pages, and `collie start` probes for a multiplexer instead of assuming Herdr ([4261c03](https://github.com/AltanS/collie/commit/4261c03), [4fc83ec](https://github.com/AltanS/collie/commit/4fc83ec))
- **tmux is parsed and driven correctly on the versions people run.** tmux 3.4's escaped field separator is un-escaped, a listing that parses to zero rows on non-empty output is refused as an error, and a create under a `manual` `window-size` refuses rather than segfault tmux < 3.7 ([30add9a](https://github.com/AltanS/collie/commit/30add9a), [b58cb61](https://github.com/AltanS/collie/commit/b58cb61))
- **The five non-English translations read like native product copy.** 1851 German, Spanish, Japanese, Korean and Chinese strings were rewritten in an idiomatic register with placeholders verified key by key, English untouched, and the docs went through the same pass ([c516276](https://github.com/AltanS/collie/commit/c516276), [f7c38f7](https://github.com/AltanS/collie/commit/f7c38f7))
- **Collie collects nothing, and that is written down.** No install events, usage statistics, crash reporting or analytics; the one unprompted outbound call is the anonymous update check, recorded in `docs/security.md` and [ADR 0034](.adr/0034-collie-collects-nothing-and-opt-in-is-the-ceiling.md) ([31d18dc](https://github.com/AltanS/collie/commit/31d18dc))

## [0.36.0] - 2026-08-28

- **AGY: a bare `>` transcript row is never taken for the composer** — only the boxed composer counts, so an echoed message cannot authorise a reply into a running turn (530057f)
- **Sign-in banner instead of "Can't reach Collie" behind a forward-auth proxy** — an expired session answered with a 3xx is read as a 401, and Authentik's `/outpost.goauthentik.io/` start/callback paths bypass the PWA cache — thanks @lekoOwO (#130) (e59135e)
- **AGY (Antigravity CLI) first-class harness adapter** — `ask_question` menus, permission, plan and trust dialogs lifted into native buttons, the boxed composer stripped with its status row re-surfaced, a slash-command palette and the brand icon — thanks @Kryvonis (#99) (b9a14e2)
- **Codex CLI 0.150.1 is recognised again, on both of its status rows** — the `Context`-bearing shape with `Context` directly after the model (thanks @fbserg, #134, 75a865a), and the two-field default that carries no `Context` field at all, now keyed on the row's renderer paint (dim ` · ` separators between coloured fields) and never on field names (ddf7272); pinned by five byte-faithful 0.150.1 captures (52cf214)
- **Codex: a large send is verified through `[Pasted Content N chars]`** — the exact character count is the evidence Enter waits for, per ADR 0010 — thanks @memset0 (#132) (1b76371)
- **Codex: the dim `Ask Codex to do anything` placeholder is empty; the same words typed are a draft** — thanks @memset0 (#132) (d3a0c53)
- **Codex: destructive writes bind to the whole wrapped draft**, not only the first `›` row — a message that wraps past the bridge's tail window no longer 409s every pre-clear sweep — thanks @memset0 (#132) (35a5e33)
- Known limit: Codex keeps only the first 1,024 characters of one send: a longer message shows as `[Pasted Content 1024 chars]` and the guard refuses to press Enter rather than submit a cut message. Herdr delivers every byte (probe in `HERDR_API.md`, b227ba5), so the limit is Codex's own, and a send is never chunked (ADR 0010)
- Known limit: While a Codex turn runs, the composer paints a `»` marker the adapter does not yet recognise, so a mid-turn reply is refused, never mis-sent; a byte-faithful capture of that state is wanted (see the #132 thread)

## [0.35.0] - 2026-08-26

**BREAKING — read before updating.**

- `COLLIE_PUBLIC_HOSTS` is now **required** on every reverse-proxy or tunnel install (Variant C/E) — Host validation fails closed.
- With `COLLIE_TRUSTED_USER` set, a request carrying no `Tailscale-User-Login` is now rejected; tagged nodes used to pass.
- A non-loopback `COLLIE_HOST` refuses to start.
- Opt-outs, one per gate: `COLLIE_ALLOW_ANY_HOST=1`, `COLLIE_TRUSTED_USER_OPTIONAL=1`, `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`.

- Uploads are typed by magic bytes, not the client-supplied Content-Type — `__proto__` and `constructor` used to pass the MIME lookup (b0f6711)
- `collie-ctl.sh` parses `.env` as key=value instead of sourcing it — a `.env` with `$(…)` or backticks ran as the operator on every verb; an unquoted trailing `# comment` is now stripped (b0f6711, 743218f)
- An unversioned managed checkout pins `update` to the newest release tag, never origin HEAD (b0f6711, 4440c05)
- Host-header validation is on by default and fails closed; `collie-ctl.sh` injects the tailnet name and IPs, `COLLIE_ALLOW_ANY_HOST=1` opts out (b0f6711) — thanks @bartholomewtj (#129)
- `COLLIE_TRUSTED_USER` rejects a missing `Tailscale-User-Login` as well as a mismatch; `COLLIE_TRUSTED_USER_OPTIONAL=1` restores the old pass (b0f6711)
- A non-loopback `COLLIE_HOST` refuses to start unless `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`; non-loopback TCP peers are rejected (b0f6711)
- **`quick-replies.toml`: your own Quick-dock groups** (title + items + optional `scope`), live-reloaded, replacing the shipped phrases on the panes they address per ADR 0018, shell panes reachable via `scope = "shell"` (0296391) — thanks @fucx (#131)
- A failed `tailscale status` no longer writes an empty host allowlist into the unit — the unit keeps the hosts it had, and says so (743218f)

## [0.34.0] - 2026-08-24

- `COLLIE_SERVE_PORT`: publish the https front door on a chosen tailnet port — several Collies per host (#98) (f008b75)

## [0.33.0] - 2026-08-24

- **Codex CLI first-class harness adapter** — boxless composer chrome stripped with the status row re-surfaced, folder-trust prompt, exec approvals and `request_user_input` question cards lifted into native buttons (by @kennymcavoy) (801c5a3)
- **omp replies no longer stall on an inline completion suggestion** — the ghost omp paints after the typed text is dropped from the draft the send guard verifies (by @enieuwy) (024a63b)
- **Codex adapter review fixes** — drafts wrapping past 8 rows keep the composer, and the persistent "don't ask again" approval row stays visible in the mirror (375f5b1)
- **`journal-probe` checks each root on its own** — a populated healthy root can no longer hide a broken sibling (by @kennymcavoy) (12b65e6)
- **Grok Build first-class harness adapter** — composer chrome stripped with the status strip re-surfaced, permission cards, `ask_user_question` radios/wizards and plan approval lifted into native buttons, plus a Grok session-journal adapter (by @kennymcavoy) (6f6b9e5)

## [0.32.1] - 2026-08-23

- **`url` (and `status`/`qr`) honour `COLLIE_PUBLIC_URL`** instead of always inferring the bare tailnet name with no port (#122) (d4e7380)

## [0.32.0] - 2026-08-19

- **The update banner says which kind of behind you are** — an in-major release, or a pending new major with the consent command (ce9dcd8)
- **F1–F12 in the Keys tray, behind an "F keys" disclosure** — chords with armed modifiers included (#119 by @martin-tahli) (f3d5845)
- **A cold boot with no network renders the cached last screen**, dated "last seen HH:MM" — never a false "No agents" (0f4c651, c473aa0)
- **A stale pane mirror is dated by its own stamp, not the herd's** (20cc1e1)
- **The update gate (ADR 0020)**: a routine `update` follows release tags within the installed major; crossing a major takes explicit consent — `update --major`, wired as the `update-major` plugin action (1b7ccfb)
- **The linked-clone major gate judges the branch's own upstream (`@{u}`), not the remote default branch** (142d2aa)
- **`keys.toml`: your own Keys-tray preset rows** (label + chords + optional `danger`), live-reloaded, replacing the shipped presets on the panes they address per ADR 0018 (a22da1a)

## [0.31.1] - 2026-08-18

- **A long request survives socket backpressure** — Bun's socket accepts fewer bytes than it is handed under pressure and queues nothing; the dialer now parks the tail and resumes from `drain`, so a big request can no longer silently truncate and die on the timeout (55274e7). Probed while fixing: herdr drops any request line of 1 MiB or more — now in `HERDR_API.md`
- In-code pointers name `DEPLOYMENT.md` now that variants B–E live there (ab182f7); `COLLIE_MULTI_SESSION` spelled `on`/`off` everywhere; `push-keys`/`push-test` listed in the Commands table (6948a0f)

## [0.31.0] - 2026-08-18

- **Your own slash commands in the palette, declared in `commands.toml`** — on a pane your rows address they replace the shipped catalog (ADR 0018); `confirm = true` adds a two-tap; edits are live, no restart (#109, 35da673, 28bdf5a) — thanks @enieuwy
- **Direct typing no longer owes a "mode stopped" notice to the next pane**, and the blur it schedules is settled by cancellation instead of racing a re-arm (#108, 452da20, 1a2ca49) — thanks @enieuwy
- **`COLLIE_AUDIT_CONTENT=none` keeps the audit trail and drops the bodies** — a fail-closed allowlist keeps action parameters legible while anything operator- or screen-originated redacts (#107, 5dda876, cdad445) — thanks @shuangwangnyc
- **`push-keys` generates the VAPID keypair and writes it into the right `.env`** — Web Push setup is now three plugin actions (`push-keys` → `restart` → subscribe), no manual key wrangling (84abe28)
- **"Tap to type" can be turned off** — a display setting stops the mirror volunteering the keyboard on a tap; on by default (1fbba59)
- **⚠ A paste too big to persist no longer restores an older, shorter draft after a remount** — oversize drafts now ride an in-memory tier whole, never truncated and never swapped for stale text; they survive pane switches but not closing the app, and the composer says so (7830c80)
- **A half-arrived long send is no longer accepted as send evidence** — when the input box ends in literal text it must be the end of what was sent, or the guard refuses to press Enter (#110, 27f4cdf)
- **README cut to ~60% of its length, how-first** — deployment variants B–E now live in `DEPLOYMENT.md`, and troubleshooting entries are findable by the words you'd actually search (9464c14, c52d4af)

## [0.30.0] - 2026-08-16

- **A password prompt says what it is and offers the control that works.** `sudo`, an SSH passphrase and `gpg` echo nothing, so Send's verification can never arrive — the refusal now names that and hands off to **Type** in one tap, instead of "a menu or dialog is probably up" (#103, 1334540)
- **A password typed into the composer is no longer kept for 48 hours** — recognising the prompt drops the stored draft and stops persisting keystrokes; the write-through had stored it before any send was attempted (#103, 1334540)

## [0.29.0] - 2026-08-16

- **The plan dialog's feedback row has a route from the phone.** Row 3/4 is a text input, not an option: Collie now models it, locks the other buttons while the terminal owns it, and sends feedback through the guarded choreography — digit, verified paste, bound Enter (#95, c0ce09e, 967e94d, 64de1d4) — thanks @navidkashani
- **A pane is named by what its process says it is doing** — its OSC title, glyph-stripped and dropped when it only repeats the agent or project — so a project's herd stops reading as N identical rows (#100, 9dbc0fe) — thanks @praneetrohida
- **A long plan-feedback value re-flows across lines instead of windowing** — the value is rebuilt from continuation lines and the footer gap widened, so a 355-char value no longer makes the whole dialog vanish (#95, 64de1d4)
- **A shell's `user@host:cwd` title is a locator, not a name** — it no longer replaces the row's cwd with a longer restatement of it (#100, 982b8e1)
- **A push re-subscribe replaces the row it supersedes**, and each row records when and from which browser it was made — Apple keeps answering 201 for an orphaned endpoint, so this is what stops `push-subscriptions.json` growing forever (#104, 0021300)

## [0.28.0] - 2026-08-12

- **omp gets a harness adapter (Tier 1)** — read-only blocks by construction, its own composer chrome stripped, a slash palette sourced from its captures — a reply stops confirming its pickers (#93, b98b90d) — thanks @qaz74107410
- **The destructive pre-clear sweep now fires only after a live read positively sees the composer**, bound to the prompt it saw — a dialog opening in the gap can no longer eat the burst (#93, 6c8332f)
- **Update-available pushes to Apple devices never arrived — broken since 0.11.0.** The Web Push topic was an impossible base64 length and APNs refused it; herd alerts were unaffected (#90, 19572d7) — thanks @ojulean
- **Every `COLLIE_*_ROOT` (including `COLLIE_TRANSCRIPT_ROOT`) takes a comma-separated list**, so pane history works across multiple `CLAUDE_CONFIG_DIR` profiles (#92, b549101)
- **`contrib/windows/`** — a community-maintained Task Scheduler lifecycle for Windows (#71, 8572e49) — thanks @Pimpmuckl

## [0.27.0] - 2026-08-10

- **Idle Claude panes no longer scroll up and snap back on every poll** — the session-name sniffer read `recent`, which on a pane shorter than the read makes Herdr scroll a full-screen agent to reach the rows above it; it reads the visible grid now (#85, dab122e) — thanks @OowhitecatoO
- **A lapsed session behind a redirecting identity proxy shows the Sign-in banner** rather than "can't reach Collie" — API requests now carry `X-Requested-With`, so a proxy answers 401 instead of a 302 that `fetch` follows into an opaque CORS failure with no status to classify (#86, 0dc852e) — thanks @ojulean
- **`start` and `status` say when this node's packet filter admits no peer**, instead of printing the tailnet URL under a green ✓ that no other device can open — the local probe only ever sees loopback, which never touches the filter. Best-effort and deliberately unsure: it speaks up only on a total deny, and stays silent whenever it can't tell (#87, 82bbe0e) — thanks @adrgarcha
- **`collie-ctl.sh qr` prints the tailnet URL as a scannable code**, so a phone doesn't have to type a MagicDNS name — opt-in as its own subcommand, since a PWA only needs the URL once. Corrects two defects in the renderer it uses: its filled glyph is a *light* module, so the compact output inverts on a light terminal, and its quiet zone is 1–2 modules where the spec asks 4 (#88, ff84538) — thanks @adrgarcha

## [0.26.0] - 2026-08-10

- **GFM tables render as tables** in Conversation history instead of collapsing into one run-on paragraph — recognised by their delimiter row, alignment and ragged rows included. A table nested in a list or blockquote still collapses: the block parser is flat, and agents put tables at the top level (#72, d82ef1b)
- **Nerd Font symbol glyphs stop rendering as tofu** — two subset woff2 faces ship with the app, fetched only when a pane actually paints a private-use glyph (`unicode-range`) and deliberately kept out of the precache (#70, d31d97d)
- **The ctl test suite re-initialised the repository it was run from** — git exports `GIT_DIR` into hooks, which overrides discovery for every git command including `-C`, so the sandbox's `git init` landed on the developer's own checkout (d12b522)
- **The ctl suite failed on a Homebrew Mac** — `resolve_bun`'s absolute-path fallback escaped the sandbox PATH and brought the real `tailscale` back with it, defeating the missing-CLI case (b9cf620) — thanks @tyamanak
- **A quick Ctrl+C in the nav tray's Esc/Up gap** — one tap, without opening Presets (#75, d139b1b) — thanks @Jarva
- **Sends stalled on a narrow pane with "Message didn't reach the input box"** — the guard located Claude's input box by a run of 20 rule glyphs, which is a hidden assumption that the pane is at least 20 columns wide; it now measures display cells, and the wrapped-draft scan reaches past a long CJK draft (#76, de88b38) — thanks @tyamanak
- **A long terminal rule clips at the mirror edge** instead of wrapping into several rows; its full text stays in the DOM, and ordinary output keeps wrapping normally (#79, 4480019) — thanks @en-ver
- **Type into terminal** — a toggle beside Keys in the Controls row sends what you type straight to the pane as keystrokes, no trailing Enter, so a TUI that wants bare letters (`b`, `q`) can be driven from a phone. Ordered and batched, so a slow tailnet grows the next batch instead of scrambling characters; it never survives a pane switch, a lock, a hidden page or a failed batch (#74, 7dea503) — thanks @aspiers
- **The composer row reads its own state** — an open dock or an armed mode carries a light-sky tint instead of a grey surface, the attach button moves inside the text field, and the "Controls" tag floats above the row so four labelled toggles fit a 390px phone unclipped (5f9d5ee)

## [0.25.0] - 2026-08-07

- **A subscription that keeps failing is retired** after 5 consecutive failures, so stale duplicates (PWA reinstalls) stop accumulating and re-logging every cycle — counted only when a sibling on the same push service succeeded that round, so a service-wide rejection never costs a live device (#68, dcc4f48) — thanks @alshedivat
- **Push failures log the status and the service's reason** instead of web-push's constant "Received unexpected response code", which named neither (dcc4f48)

## [0.24.2] - 2026-08-06

- **A wrapped CJK reply stalled unsubmitted** — the input box folds its wrapped lines with a space, fabricating one the send never had (CJK has no spaces to wrap at), so the guard's slice check could never match; each seam is now judged on its own, and only a gap the fold itself could have made is loosened (#66, 6def208) — thanks @tyamanak
- **The guard feature-detects `Intl.Segmenter`** and falls back to code points, so an engine without it (Firefox < 125, Safari < 14.1) loses grapheme precision instead of white-screening the app at boot (1a37e29)

## [0.24.1] - 2026-08-06

- **Long/multi-line replies to Claude panes stalled unrecoverably** — the send guard now reads Claude's `[Pasted text #N +M lines]` placeholder as send evidence when consistent with the sent message (ADR 0010) (29bca11)
- **Stranded-draft preview withdraws "Take over" when the line holds only Claude's paste placeholder** (29bca11)

## [0.24.0] - 2026-08-05

- **Buttons for Claude's `/model` picker, and any modal like it** — a last-resort grammar reads the footer's `<key> to <verb>` hints and renders them, with the arrows the screen advertised, over the mirrored region (dfff364)
- **A generically-detected menu never synthesises a digit** — in the `/model` picker a digit confirms *and* saves your default for new sessions; [ADR 0009](.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) records why (dfff364)
- **A send is refused before it types when the agent's input box isn't on screen** — the draft is kept, and a second Send is a deliberate "Type anyway?" that still never fires the submit key blind (bf7ea38)
- **A reply is no longer typed into a full-screen picker** — the original `/model` bug: no grammar claimed the screen, so the message fed the picker and came back "stalled" (bf7ea38, dfff364)
- **The stalled message says a key answer probably landed** — the part that made the original report confusing (bf7ea38)
- **A half-written reply survives leaving the pane** — drafts are kept per pane (48h, localStorage, so an OS-killed PWA doesn't lose one) instead of dying with the composer when you step over to another tab (50dccc0)
- **The ←/→ pair says what it adjusts** — the picker's live value ("◐ Medium effort") sits between the arrows and in their accessible names (4d23e63)
- **Modal menus are a documented harness contract** — the model and its footer/key grammar are harness-neutral, so a future codex/pi/opencode adapter implements them from types plus a conformance leg, not from Claude's internals (a3e0820)
- **Every dialog model is a harness contract, not a Claude internal** — the prompt-select, wizard, preview and multi-select payloads join menus in harness-neutral modules, so the AST and the renderers no longer point at one agent's grammar (a7d45f4)
- **One race guard for every dialog, run through the pane's own adapter** — no more re-deriving through Claude's detectors; an adapter that emits a block kind gets the guard for free, and no adapter fails closed (211cd07)
- **The conformance suite pins the signature + identity contract for every block kind** — not just menus: a constant signature, or a comparator that passes a screen that changed, now fails CI (3385193)

## [0.23.3] - 2026-08-04

- **The idle lock no longer ambushes you on the way back in** — a hidden page never locks and returning to the foreground auto-resumes, so it can only appear when Collie is left open, visible and untouched (799ece0)
- **A pause no longer eats an in-progress reply** — the cover sits over a still-mounted router instead of replacing it, so draft, scroll position and open sheets survive it (799ece0)
- **The lock screen is glass, marked, and honestly worded** — the herd stays legible underneath, the Collie mark says whose screen it is, and there's no lock glyph or "for safety": it gates nothing, and [ADR 0007](.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md) records why (799ece0, c7430a7)
- **`ARCHITECTURE.md` no longer lists the idle timeout as a security measure** — it never implemented one (799ece0)
- **Resuming shows the catch-up instead of handing back a frozen screen** — the cover holds through the refetch, badge swapped for the gallop, and releases when it settles (c7430a7)

## [0.23.2] - 2026-08-04

- **Agent alerts now send at high urgency** — at web-push's default (`normal`) Android was free to defer them by Doze / App Standby bucket, so pushes were accepted by FCM and never delivered (90e42af)

## [0.23.1] - 2026-08-03

- `update` now works in a `herdr plugin install` checkout — it is detached and shallow, so `git pull --ff-only` could never run there (#63) (00fd82c)
- `update` no longer re-links a Herdr-managed checkout, which would re-register it as local and block `herdr plugin install` (00fd82c)

### Upgrading — `herdr plugin install` users must reinstall once

The fix ships *inside* the checkout it repairs, so `invoke update` still can't run on an install made
before 0.23.1. Take the fix with one reinstall (config and serve state live outside the checkout and
survive), after which `invoke update` works normally:

```bash
herdr plugin install AltanS/collie --yes
herdr plugin action invoke restart --plugin herdr.collie
```

Installs from a `git clone` + `herdr plugin link` were never affected — use `invoke update` as usual.

## [0.23.0] - 2026-08-03

- **Every key press and quick reply now answers you.** A nav-tray press was silent on success and deferred to a mirror that can be ~2s behind, so tapping Enter felt like nothing happened; the pressed button now fills on the tap (synchronous, no network wait) and shows a ✓ once the bridge accepts it. Quick replies echo on the tapped button and the dock outlives the send, closing after the ✓ instead of on the tap (79682b5)
- **The pane's two control rows are now one.** Wrap, raw terminal and text size moved behind a ⚙ into a labelled panel — the raw-terminal escape hatch had been a bare `>_` glyph whose only explanation was a `title` attribute no phone ever shows, and it now says what it does. Find moved to the header, where its find bar already takes over the row. The mirror gets ~85px back (79682b5) — general direction from @simonallfrey in #49, whose "consolidate the terminal toolbar" proposal is what started this; thank you
- A single key press revalidates on the leading edge instead of sitting out the full 300ms burst window before its refetch even started; bursts still coalesce into one trailing refetch (79682b5)
- **Hold an arrow key to repeat it** — driving a long TUI menu no longer means tapping ↓ fifteen times. Repeats accumulate locally and flush as one batched `send_keys` array with exactly one call in flight, because ordering across two concurrent one-shot RPCs is unguaranteed. Arrows only, by whitelist; a hold while composing stages one chip, not fifteen (df40373)
- **Haptics** — a short buzz on press, toggleable in Settings, silently absent where the platform has no `vibrate` (df40373)
- **Quick replies follow the pane kind:** a shell gets `y`/`n` instead of "commit and push" and "skip", which mean nothing at a bash prompt (df40373)
- Closing the Keys dock on a composed key queue takes a second tap. The queue is still discarded rather than persisted — one surviving into a later open would let Send fire yesterday's chord into today's TUI state — and the guard sits on the drawer transition, since the Keys toggle and the Quick/Agent/Display buttons unmount the tray just as effectively as the ✕ (df40373)

## [0.22.0] - 2026-08-03

- **A multiselect question inside a wizard is now a tappable dialog**, not raw terminal text. It was owned by no grammar — wizards refuse checkboxes (a wizard digit selects *and* advances; a checkbox digit only toggles) and multi-select only knew the single-question form. It now carries the wizard's step chips, navigates with the wizard's own Left/Right keys, and reads the advance row's label ("Next" / "Submit") from the pane by position, never by assumption (#51, bdf4c26) — thanks @konpyl
- **A preview dialog whose option label wraps no longer falls to the raw mirror.** The grammar required numbered rows on consecutive lines, but the ~30-column gutter wraps longer labels onto continuation rows; a contiguity walk anchored on the label column replaces adjacency (#51, bdf4c26) — thanks @konpyl
- `multi-select-action.ts` no longer carries a literal NUL byte (git classified it binary and hid its diffs from review); `.gitattributes` keeps any future stray byte from costing reviewability (#51, bdf4c26)
- `ReadSource`'s unwrapped variant matches the wire: `recent_unwrapped`, snake_case — the kebab spelling was rejected by Herdr and nothing had ever called it. HERDR_API.md records the probed contract, including that the source is a byte-identical no-op for Claude panes (alt screen + renderer-hard-wrapped prose), which is what closed #53 part 2 by measurement (45cc23e)
- **OpenCode panes get Conversation history.** OpenCode ≥1.x keeps every session in one SQLite database (no per-session log), so its journal adapter reads `opencode.db` readonly with bound parameters, touches only the three transcript tables (the same file holds auth tokens), and serves all sessions through a per-session cache key. Needs `herdr integration install opencode` once, then restart OpenCode in the pane (#61, 539cdf4) — reported by @xabilarra

## [0.21.0] - 2026-07-31

- **Sending no longer stalls under a tall statusline** (the run may be 8 rows, was 3). A taller run made `locateInputBox` miss the input box, so a send typed the text and then withheld Enter — with no stranded-draft preview and no pre-clear sweep, so retries stacked duplicates in the pane. Reproduced on a 3-row statusline sitting one wrapped line from the cliff (#54, #56, fe8e548) — thanks @stekman08
- The pi journal fixture is portable to macOS, where `containedRealpath` resolves `/var` → `/private/var` by design and the backend suite couldn't run at all (7e99645)
- ADR 0004 records that the statusline-run bound guards less than it looks: a dialog below the input box is refused by the border checks and by the blank line above its footer hint, never by the row count (48b3ede)
- **macOS supervises the bridge with launchd.** `start` installs a LaunchAgent (`~/Library/LaunchAgents/herdr.collie.plist`), so the bridge comes back at login and restarts on failure — the parity with the `systemd --user` unit that macOS never actually had (#55, #57, a0be73d) — thanks @darieldatoon
- `launchctl bootstrap` is retried across launchd's teardown window, so `restart` — and therefore `update` — can't end with the bridge down (3776845)
- **The mirror wraps by default.** Herdr spawns panes at the desktop terminal's width against a phone's ~45–50 columns, so panning was the common case, not the exception; column-faithful no-wrap stays one tap away in View. Display prefs reset to defaults on first load (storage key v4), so a pinned font size needs setting again (#53, 273d886, 73cc7da) — reported by @waynehoover
- **The statusline strip shows every row of the run, in the agent's own colour.** Model, cwd, git branch and permission mode live on rows 2+ and were surfaced nowhere; the strip renders them stacked, in the mirror's colour space (#60, 61db7a5, ac3c62d)
- A Mac that can't bootstrap (no console login, so no `gui/<uid>`) keeps an unsupervised bridge instead of exiting with nothing running; `status` reports that degraded tier (05f8f48)
- **macOS installs migrate on the next `update` or `start`**: the old unsupervised bridge is stopped and replaced by the LaunchAgent. It's a *LaunchAgent*, so it starts at **login**, not at boot — and a Mac administered purely over SSH has no `gui/<uid>` to bootstrap into, so it stays on the unsupervised bridge with a warning until someone logs in at the console once.

## [0.20.2] - 2026-07-30

- `herdr plugin action invoke update` no longer dies with `bun not found on PATH` — Herdr spawns actions with no login shell, so Bun is now found in its install locations too, not just on `PATH`. A failed run had already fast-forwarded the checkout, leaving the old `web/dist` being served (#52, 08f44f6) — thanks @konpyl
- Only an absolute Bun path is prepended to `PATH`, so a `bun` shell function in the plugin `.env` can't put the CWD in front of `git` / `systemctl` / `tailscale`; the control script's Bun resolution now has test coverage (a50240a)

## [0.20.1] - 2026-07-29

- Journal rotation-following re-checks containment, so a sibling symlinked out of the Claude projects root can no longer be served as a pane's history (389618c)
- Dependency versions must be 7 days old before they install, via `bunfig.toml` (`.npmrc` for npm users) (3a16f31)

## [0.20.0] - 2026-07-29

Three contributions from @konpyl carry this release — light and system themes (#41), the triaged
dashboard (#42) and tappable URLs in the mirror (#45), landed via #46/#47/#48 with review fixes on
top. Thank you: measured rather than estimated, with the reasoning written down where it will be
argued about again.

- **The space and tab chip rows overlapped each other on the space screen** — both strips were missing `shrink-0` inside the route's flex scroller, so they collapsed to 16px around 32px chips and the tab row painted over the space row. Pre-dates this release (5e10bb0)
- **Light and system themes.** Collie follows your phone's appearance by default; pin Light or Dark from **Settings → Appearance**. Per device, and documented under [Dark mode / light mode](./docs/configure.md#dark-mode--light-mode) (#41, cd47bba, df47112)
- ANSI slots 0–15 are now CSS variables (`--ansi-*`), so indexed terminal colour is defined in one place and reaches the mirror through both `31m` and `38;5;1` spellings (cd47bba)
- Three `role="alert"` warnings (incomplete multi-select, wizard, preview) used a hardcoded yellow that measured ~2:1 on white; they use the status palette now (cd47bba)
- An off notification switch was unreadable in light — a white thumb on a 1.09:1 track, legible only by its shadow. It carries an outline now (cd47bba)
- Focus rings were drawn at half strength, 1.77:1 in light and 1.87:1 in dark; both are full strength now (cd47bba)
- Small muted text (section labels, the build stamp, the terminal status line, the `(n)` counts) fell under 3:1 in light — light `--muted-foreground` had no headroom left for the `/70` and `opacity-60` modifiers stacked on it, so it was darkened and the modifiers dropped (cd47bba)
- Header controls had 20px touch targets; the Settings gear and the Settings back button are both 44px now, with no change to how they look (cd47bba)
- In light, the page is a step off white with cards staying white, so the dashboard's hierarchy no longer rests on a single hairline — and the mirror's edge stops showing a seam (cd47bba)
- The pane mirror renders in dark space under every theme and light mode inverts it, because agents emit truecolor almost exclusively and no palette can re-theme an absolute colour — [ADR 0002](.adr/0002-invert-the-light-terminal-mirror.md) (26db8f1)
- **Ready · unseen** — agents that finished while you weren't looking. Opening one clears it, on every device (4a03951)
- The bridge keeps two timestamps per pane (`activeAt`, `seenAt`) in `activity.json`, because Herdr reports none (4a03951)
- **The dashboard is triaged, not listed.** Needs you → Ready · unseen → Working → Recent; the first three are pinned, Recent sorts by when you last used each pane (#42, 2c5f971)
- Recent and Spaces fold and remember it; fold both and the page is the triaged herd and nothing else (2c5f971)
- Spaces are ordered by last used and filterable — 45 of them are now three keystrokes, not a scroll (2c5f971)
- **Agent rows are titled `project · tab`, not "claude".** The pane's own name moves to the second line; the agent stays in the avatar (2c5f971)
- Spaces moved BELOW every agent section — it's a navigator, not a work queue (2c5f971)
- Only Collie's own reads count as seeing a pane; a Herdr focus at the desk does not — [ADR 0003](.adr/0003-one-shared-seen.md) (659c9d4)
- Marking a pane seen had made a read-level GET mutate state, so a cross-site `<img>` at a guessed pane id could silently clear your unseen agents. Only a request carrying the app's own header counts now — caught in this release's security review, never shipped (336c4c6)
- The swipe-up **Switch pane** sheet folds its long tails too — Recent, and the bare **Shells** group that buried the agents underneath it (90e1894)
- Titles truncated away the tab — the only part that identifies a row — leaving several panes rendering the same `moonward_os · t…` (f5e1e77)
- Section headings rendered at two different sizes and cases, because a `<button>` doesn't inherit `text-transform` from its `<h2>` (f5e1e77)
- A hollow status ring on the avatar's corner read as a notch cut out of the logo (16b01c8)
- **Light `--accent` was byte-identical to `--background`**, so "this is the current one" showed nothing in light mode — the open pane in the switcher, the current session, every `hover:bg-accent`. Predates this release; found by the UX sweep (b6850b4)
- **Tab and space chips carry a status dot** — blocked / ready / working / idle, in the herd list's own palette. They only ever showed a dot for blocked before, so every other state read the same as every other (bddf4cc)
- **URLs in the pane mirror are tappable** — `http(s)://` text becomes a link that opens in a new tab, keeping the colour the agent printed and marked by an underline (#45, e231ab4)
- Trailing prose punctuation is trimmed with paren balance respected, so `Fetch(https://x.dev/a)` links the URL and not the paren; a find hit inside a URL still highlights, and a URL that changes colour mid-way stays one link (e231ab4)
- The boot splash stepped from white to the page colour when React took over, and its caption measured 3.45:1 — it used `#ffffff`/`#8a8a8a` under a comment claiming they matched `--background`/`--muted-foreground`, which rasterize to `#f5f5f5`/`#5d5d5d`. Same fix for the light `theme-color` meta, so Android's URL bar matches the page (b02b800)
- Inverse-video segments in the mirror emitted theme tokens while the muted glyphs beside them used literals; the mirror keeps one spelling now (identical pixels — the literals are those tokens' dark halves) (b02b800)
- A space row and its chip could disagree about what a colour meant — the row still ranked by `STATUS_RANK` while the chip used the triage classifier, so a space holding one working agent and one unseen-done agent showed "working" on the dashboard and "ready" in the strip. Both route through `bucketOf` now, in one pass rather than spaces x agents per render (35c7f90)
- `aria-controls` on a collapsed section pointed at an element that isn't rendered — exactly when a screen-reader user is deciding whether to expand it (35c7f90)
- A status dot passed a smaller size only resized its wrapper, so chip dots rendered at the wrong size (35c7f90)
- The Settings page rearranged itself a frame after opening — Notify-when and Snooze mounted only once push state resolved, inserting ~400px into the middle of the page, and Notify-when then grew another ~180px waiting on its own prefs. Both render from the first frame now, switches disabled until their values land (87b875d)
- Herd and space rows had a border radius with no border to own it, so a rounded hover fill sat under a straight `divide-y` hairline. Rows without a border are square; the ones with a real border keep their radius (87b875d)
- The pane row ran straight into terminal output with no edge between them, so the chrome and the mirror read as one surface (e791330)
- Only a request that will actually be served marks a pane seen — one falling through to 405 no longer clears an alert (6b89899)
- MINOR, not MAJOR: pre-1.0, purely additive, no config or API break. Defaulting to your phone's appearance is the feature working as designed and Settings pins it either way; an older bridge reports no activity timestamps and simply renders the previous dashboard, minus the one section that would be empty

## [0.19.0] - 2026-07-29

- **Journal (pane history) is now per-harness, with Codex and pi support.** Reading an agent's own session log is an adapter keyed on the pane's agent (`bridge/journal/`), so a new harness is an adapter rather than a fork of the reader — Codex reads its date-partitioned `rollout-*.jsonl`, pi its per-cwd session log. Raised in #40 by @simonallfrey, who asked where to implement journaling for Codex (1bccb8e)
- **`scripts/journal-probe.ts`** probes every adapter against the real logs on the host — the format-drift check unit tests can't make. It caught Codex 0.145 adding a `developer` message role the parser would have rendered as operator speech (1bccb8e)
- **pi could never have had history.** pi reports its session as a kind-`path` ref (an absolute path) and the bridge kept only kind-`id` refs, so a pi pane arrived with no session at all. Both kinds are kept now; a path ref is confined to that harness's root after symlink resolution (1bccb8e)
- **A pane relaunched as a different agent served the previous agent's session ref.** Herdr keeps reporting the last session announced for a pane — a pane running pi still advertised a `herdr:claude` id. The ref is dropped unless its own `agent` matches the pane's (1bccb8e)
- **A pane's session reference no longer goes to the browser.** `/api/snapshot` sends `hasSession` instead — for pi the reference is a filesystem path, and the History affordance only ever needed "may this pane have history?". It is now also gated on the harness actually having an adapter (1bccb8e)

## [0.18.0] - 2026-07-28

- **Approvals are bound server-side to the prompt they were decided against.** `/keys` and `/reply` accept an optional `expected_prompt`; the bridge re-reads the pane immediately before writing and refuses with `409 prompt_changed` if the dialog moved. Shrinks the guard window from human latency to two local RPCs — a mitigation, not a guarantee, until herdr gains a conditional-input primitive (#29) — thanks @Optic00 (7ae589c)
- **`/auth/` is reserved for a fronting proxy's sign-in page**, and the service worker always passes it to the network. An installed PWA could not reach a proxy page at all before — the precache answered every navigation, reload included — so operators had to squat a page inside `/api/`. The refusal banner now links there (#31) — thanks @Optic00 (ee246d3)

## [0.17.0] - 2026-07-27

- **A reply sent while an agent dialog was focused answered the dialog instead.** The submit key approved whatever option was highlighted (Claude defaults to "Yes") and the message was destroyed, while the bridge reported success. Sending now refuses outright while a dialog is up, and otherwise types first and only submits once the text is verified in the input box (#34) — thanks @maikschuheida-spec
- Free-text replies on harnesses with a block grammar (Claude) are two steps — type, verify, submit — so "Sent ✓" now means the text was seen in the input box. Harnesses without an adapter keep the previous one-shot send

## [0.16.1] - 2026-07-27

- `/api/config` is now gated like every other endpoint — it was the one route that skipped the same-origin check and `COLLIE_PUBLIC_HOSTS`, noted by @Optic00 in #32 (629348e)

## [0.16.0] - 2026-07-27

- `scripts/collie-ctl.test.sh` — first lifecycle coverage for the control script, wired into the pre-push hook (a004449, c323610)
- `unserve`/`uninstall` no longer remove a `tailscale serve` mapping Collie didn't create, and `start` no longer replaces one (a004449, thanks @iamtimmy)
- A front door that fails to publish no longer aborts `start` before the status banner (c323610)
- Bring-your-own-tunnel deployment path documented as **Variant E** — NetBird, ZeroTier, Cloudflare Tunnel (7488e7a)

## [0.15.0] - 2026-07-26

- **Breaking, only if `COLLIE_DEVICE_HEADER` is set:** a request arriving *without* the device header is now read-only. It previously got full write access, which let any tailnet client reach the bridge's own URL and skip the proxy that injects the header. Front doors that inject it on every request are unaffected; direct loopback/MagicDNS access now needs the header sent by hand (#28) — thanks @Optic00 (f88f1d6)
- A 401/403 no longer renders as an endless "reconnecting" banner — an access refusal now says so and offers Reload (#30) — thanks @Optic00 (787b193)
- Pane conversation history read from the agent's own transcript — scroll back past the live mirror (465c485)
- `COLLIE_HERDR_DIAL=auto|net|bun` forces the dialer; `net` exercises the Windows path on Linux/macOS (4da4f03)
- Windows support for the bridge: dials herdr's named pipe through `node:net`, one code path for both platforms (#25, #27) — thanks @mikebenner and @bwright2810 (120f829)

## [0.14.2] - 2026-07-23

- Paste an image straight from the clipboard into the composer, same upload path as the picker (#24) (ffceb0f)

## [0.14.1] - 2026-07-22

- `collie-ctl.sh self_dnsname` shelled out to `node`, which Collie never requires — now uses `bun` (#22) — thanks @jz-wilson (6664ced)

## [0.14.0] - 2026-07-21

- HERDR_API.md: multi-modifier chords live-verified in any order against Herdr 0.7.3, cross-confirmed on 0.7.4 by @bnivanov (0d1472b)
- Alt modifier in the nav tray — `alt+<key>` chords now reachable from the phone (#19) — thanks @bnivanov (38e05cf)
- Modifiers combine (checkbox, not radio): `ctrl+shift+p`, `alt+shift+p`, even triple chords (#20) (38e05cf)
- Modifier lock — tap an armed modifier again to keep it armed across presses and Sends; Clear or a third tap releases (#20) (38e05cf)

## [0.13.2] - 2026-07-20

- Tabs render in Herdr's reported order instead of stable-number order, so a reorder in Herdr survives to the screen — thanks @iFwu (6a8e0f7)
- Tapping raw terminal output focuses the composer synchronously, keeping iOS's user-activation window so the software keyboard opens — thanks @iFwu (8ca41ca)

## [0.13.1] - 2026-07-20

- Taking over or sending a draft no longer permanently mutes the preview for that same text — the handled key resets once the host line clears (730f6c6)
- Send's pre-clear sweep overshoot widened 8 → 32 so host typing inside the poll gap can't leave a remnant (730f6c6)
- A scrollback line starting with `❯` can no longer pin a bogus session name — only the live (bottommost) prompt decides (d8744f4)

## [0.13.0] - 2026-07-19

- Pane rename end-to-end: `pane.rename` RPC, bridge route, label threading (317ec72)
- Long-press a pane pill for a pane actions sheet — rename + two-tap close (5b50941, c713551, 90210ce, ea20df0)
- Busy strip on genuinely hung loads: navigations >500ms, background polls >6s (e886541, 3bfaa1c, 06516c4)
- Own in-flight reply no longer flagged as a stranded terminal draft (15c1830)
- Gallop sprite re-centered; the dog never freezes mid-stride (rest state is the static icon) (3c7174a, 394e6fe)
- Offline banner no longer overlaps the sticky header (2e988f3)
- Sustained outages escalate everywhere — boot splash, header, banner — with Retry/Reload (0cbbac1, 4d89588, 4494cf5)
- `-dev` marker in the build stamp for non-release builds (32d76d6)
- Wrapped multi-line drafts and the new background-agents footer no longer break input-box detection (829fc7e, d9521e3)
- Claude's own `/rename` session name surfaced on cards, headers, and the switcher (7c6606c)
- Tab rename + tab close (blast-radius confirm) via the same long-press sheet on tab chips (a9664b5, 37a470e)
- `navigator.onLine` never gates polling or liveness — lying flags can't wedge the app or fake outages (d31ffb8, 394e6fe)
- Self-update without the service worker: `X-Collie-Build` on polled responses, auto-reload or tap-to-update banner (b83185a)
- `assets/*` served immutable, everything else `no-cache` — proxy caches can no longer starve `/sw.js` updates (b83185a)
- Read-only "Draft in terminal" preview with explicit Take over — the composer input is exclusively phone-owned (4b6f0ac, 10fa28d)
- Connection status is a single animated top bar — amber "reconnecting…" after 4s of trouble, red with Retry at 15s, green flash on recovery; no header pill (394e6fe, b2dd50e)
- One shared connection-lost clock; escalation survives route changes and app switches until a poll succeeds (1486e07, 5949885)
- One shared `AppHeader` for dashboard, space, and pane — same components underneath, stale status badges dim during outages (bc60ea6)
- Instant offline navigation — during a known outage, routes serve the last good snapshot instead of hanging on a dead fetch (6ba7dea)
- Switcher sections carry status-colored bullets; per-row close removed (switching is the only action there) (724bce3)

## [0.12.0] - 2026-07-17

- `COLLIE_SKIP_SERVE=1` env var to disable tailscale serve entirely — bridge stays on loopback only, ideal for deployments behind a reverse proxy (Caddy, Nginx, etc.) — thanks @diogenesc (791dfcc)
- `COLLIE_PUBLIC_URL` — `collie-ctl.sh status` banner shows your real reverse-proxy URL instead of a placeholder (ec01d66)
- Bridge startup warning when `COLLIE_TRUSTED_USER` is set under `COLLIE_SKIP_SERVE=1` — the identity gate is inert without tailscale serve injecting `Tailscale-User-Login`; use `COLLIE_DEVICE_HEADER` (ec01d66)
- README Variant C — reverse proxy as the only front door (no Tailscale), with Caddy example and required env (c5c3533)
- `collie-ctl.sh unserve`/`uninstall` always attempt serve teardown, even under `COLLIE_SKIP_SERVE=1` — a stale mapping from before the flag flip would keep publishing the app (ec01d66)
- Security posture docs: "tailscale serve is the sole ingress" → "exactly one hardened front door" (tailscale serve or a conforming reverse proxy) across README, ARCHITECTURE, CLAUDE.md (c5c3533)

## [0.11.1] - 2026-07-16

- Opening a tab/pane lands on the live tail — terminal `<pre>` no longer steals vertical scroll from the message list; stickiness also re-pins when content grows (8576152)

## [0.11.0] - 2026-07-15

- Pluggable harness-adapter architecture: a `HarnessAdapter` registry replaces the single Claude-only gate, Claude's detectors move to `lib/harness/claude/`, and a core race-guard engine (`lib/harness/guard.ts`) is the only module that may touch the network — an import fence (enforced by `fence.test.ts` under `bun run test`) + a conformance suite let contributors add codex/pi/opencode (see `HARNESS_CONTRIBUTING.md`)
- multiSelect AskUserQuestion support: checkbox options up-level to tappable checkbox rows (terminal is source of truth), with a closed-loop Submit that navigates the pointer to Submit and verifies before Enter (never blind-sends), plus the review/confirm screen
- Prompt overlay: interactive prompts render in a bordered `bg-card` panel that lifts the whole dialog off the terminal mirror, with elevated option rows, leading key-digit badges, and a family-aware caption
- Update notifications: a footer banner (linking to the GitHub release) and an opt-out web-push when a newer release is published upstream or the running bridge is behind the on-disk code — checks the repo's tags over anonymous HTTPS, stamps its own sources for the restart signal, a Settings "check for updates" button forces an immediate check, an `updates` notify pref is the off-switch, and update/restart are surfaced as location-independent Herdr plugin actions
- Prompt-select + wizard grammars: a numbered list in a dialog body (e.g. a plan's steps) no longer breaks menu detection — the menu is taken as the trailing `1..m` run, so plan-approval prompts up-level correctly
- Keys and Quick menus dock in-flow above the controls row instead of a fixed overlay, so the terminal mirror shrinks and re-pins to the bottom (ResizeObserver) — the prompt/cursor stays visible; both buttons are toggles
- Prompt option rows compacted (tighter padding, snug line-height) so a multi-option dialog fits the phone viewport
- "Sent" status toast moved from a bottom overlay (which covered the terminal tail) to a slim in-flow row below the header
- Build stamp marks a dirty working tree (`<sha>-dirty`), so the footer no longer claims HEAD when the build carries uncommitted work
- multiSelect Submit is ~2s instead of ~15s: the pointer walk re-reads the actual position each step and stops on "Submit", instead of polling for the bottom row after every key (which timed out ~2.8s per step)

## [0.10.3] - 2026-07-12

- `collie-ctl.sh build` installs the root dependency tree (not just `web/`) before typechecking, so a fresh Herdr install no longer fails with TS2688 "Cannot find type definition file for 'bun'" (03f409f, #9)

## [0.10.2] - 2026-07-12

- Composer Send clears a stranded draft off the terminal `❯` line (ctrl+k + Backspace) before typing so replies no longer accumulate on the prompt; a clean prompt skips the clear (412378f)
- Bridge settles ~350ms between typing and Enter so the TUI reliably accepts the submit key (412378f)

## [0.10.1] - 2026-07-11

- Terminal mirror defaults to no-wrap for table alignment like desktop Herdr; clearer borders/typography (font 12, muted-foreground box-drawing); pane stays viewport-width — toggle Wrap on in View for prose (85f777b)

## [0.10.0] - 2026-07-10

- Herdr session switcher: one bridge fronts every named herdr session — `?session=` on the API, `?s=` in the app, a sessions summary in the snapshot, per-session notification slots, and a `COLLIE_MULTI_SESSION` kill-switch (8fa1f20)
- Session switcher and the session chip are dashboard-only, keeping the in-space and pane headers clean (bb0048d, ba56ba9)
- Header polish: consistent compact height across the dashboard and inside a space, zinc-800 nav chrome, a ringed Collie mark, a smaller pane-header agent logo, and the keyboard-only quick-keys strip removed (6250e0c, 9da7195, 35db0e5, ba56ba9)
- Terminal-draft recovery: a queued-then-recalled message stranded on the "❯" input line surfaces as a composer chip, with "Edit here" to clear the line and adopt the text cleanly (46dcf35)
- Dashboard, space, and settings scroll inside a viewport-clipped region instead of the whole document (2aa9272)
- Space detail is a deep-linkable route (`/space/:spaceId`) with a working browser Back button, replacing the in-home drill-in state (0e5f9c8)
- Deep-linking a space that never existed shows "Space not found" rather than "Space closed" (fcb0b7d)
- Security posture documents that `COLLIE_MULTI_SESSION` (default on) fronts every named session under the config root (fcb0b7d)
- Dashboard leads with "Needs you" — agents awaiting your input sit at the top, above the spaces overview (1d92592)

## [0.9.1] - 2026-07-09

- Removed one-tap yes/no reply buttons from push notifications — they POSTed to the terminal without opening the app, i.e. approving blind. Notifications now only deep-link to the pane (cb26ee0)
- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)

## [0.9.0] - 2026-07-07

- Quick keys mimic a physical keyboard on both surfaces: Esc top-left, Tab below it, inverted-T arrows, Enter top-right; Keys sheet gains a full-width spacebar (2f70662)
- Attach image lives in the reply row (usable without the phone keyboard open); digits leave the inline strip — the 123 tab remains (2f70662)
- Header collie logo is transparent like the gallop sprite — removed favicon.svg's baked-in gray backing rect (3f05da8)

## [0.8.0] - 2026-07-07

- Poll herdr 0.7.2's `session.snapshot` — one RPC per tick instead of three list calls; permanent fallback to the list trio on older servers (5687bbf)
- Event-poked polling: `events.subscribe` stream triggers immediate debounced re-polls; interval relaxes to `COLLIE_POLL_IDLE_MS` (default 12s) while the stream is healthy (5687bbf)
- HERDR_API.md re-verified against herdr 0.7.2 / protocol 16; terminal observe/control filed under ARCHITECTURE.md Future ideas (aad94b3)

## [0.7.0] - 2026-07-06

- Notification type prefs: Settings "Notify when" toggles per agent status, bridge-wide; default pushes only "Needs input" (blocked) — "Finished" (done) is off (98cf5d2)
- Push sends carry a `collie-herd` topic + 6h TTL: an offline device now gets one current summary on reconnect instead of replaying every queued update (98cf5d2)
- Disabling a notification kind retracts its pending/outstanding alerts immediately (98cf5d2)

## [0.6.0] - 2026-07-06

- First-paint PWA splash: the galloping collie shows before React mounts (299f632)
- Option taps no longer pop the phone keyboard or steal the note editor's focus (11385ee)
- Header Collie mark matches the agent logo (2rem, aligned across screens); Find lives in the composer View row; placeholder is just "Type a reply…" (11385ee)
- Keys sheet: `Ctrl` modifier + visible key queue — compose chords/sequences, review, Send as one call; dialer-size digits on a `123` tab (515f795)
- Stalled connections no longer zombify the app: fetch timeouts (10s/20s/60s), polls supersede a wedged revalidation at 12s, and the collie gallops within 2.5s of a stalled load or pane-tap navigation (e6ad939)

## [0.5.0] - 2026-07-05

- **Preview-variant question notes.** Claude Code's *preview* AskUserQuestion — a single-select
  question whose options carry a `preview` field (the mockup/snippet pane, footer hint
  `n to add notes`) — is lifted into a native block that surfaces the per-question note affordance.
  A note (attach / edit / remove) is driven from the native option UI and applies **per question**,
  not per option row. Delivery uses the verified staged keystroke choreography
  (`n` → confirm the input focused → clear → paste the text via the reply path → `Escape` to blur,
  each stage verified rendered before the next fires; `Enter` is never sent, since it would submit
  the dialog — see `web/src/lib/grammar/NOTES_NOTES.md`), and option selection is the two-step
  digit → verify-pointer → `Enter` recipe. Race-guarded like the other dialog blocks (a stale tap on
  a drifted dialog aborts before anything irreversible is sent). Claude-scoped (`hasBlockGrammar`)
  and web-only; the standard non-preview select and wizard steps are unaffected (pressing `n` there
  is a no-op, so no notes UI is shown).
- **Preview-note tap guard hardened to region-signature parity.** The preview dialog's race guard now
  carries a pointer- and note-independent **core signature** (the subject/question/stepper above the
  options joined with the option rows' left column, `❯` normalised) — matching the 0.4.0 `signature`
  parity the prompt/wizard guards already had. It is enforced at entry AND on **every** mid-flight
  acceptance/drift check, so a same-shaped successor dialog (identical question + labels, different
  subject) can no longer be answered by a stale tap: no digit-then-`Enter` or `Enter` is sent unless
  the fresh read's core signature byte-matches what the user saw. The blur poll is now three-valued
  (ok / drifted / timeout) so the Escape-retry fires only on a genuine swallowed key — never after the
  dialog drifted or vanished (which a blind second Escape could cancel / interrupt). Pasted note text
  is stripped of C0/C1 control bytes (ESC, BEL, …) before it can reach the focused input.
- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)

## [0.4.0] - 2026-07-05

- **Block-based terminal renderer.** Pane rendering now flows through a semantic Block AST (styled
  lines → typed blocks → React components) instead of a flat span mirror. The raw-block foundation is
  byte-for-byte identical to the old mirror, but it's the seam every feature below builds on —
  detected regions are lifted into native blocks in place, and anything unrecognized falls back to
  the raw mirror. Scoped to Claude Code (`hasBlockGrammar`); every other agent renders the plain
  mirror, since their TUIs are unverified.
- **Native prompt buttons.** A Claude single-choice dialog at the buffer tail (select, permission,
  trust, plan approval) is lifted out of the mirror and rendered as tappable buttons; a tap sends the
  per-family keystrokes (digit, or digit+Enter for AskUserQuestion), guarded so a stale tap on a
  scrolled-up menu can't fire. The agent's own input box/statusline are stripped so they don't
  duplicate the composer.
- **Status strip.** The stripped statusline (model · ctx% · cwd · branch · tokens) is re-surfaced as
  a slim line above the composer, so the branch/context stays visible instead of vanishing with the
  input-box chrome.
- **Submission progress bar.** A slim indeterminate bar across the top of the app while any mutation
  (reply, keys, prompt tap, upload, tab/space create, close, snooze) is in flight; background polling
  never triggers it, and a 120ms delay means a fast action never flashes it.
- **Raw-terminal escape hatch.** A View toggle (terminal icon) that turns off the block renderer —
  native prompt buttons, chrome stripping, status strip — and shows the plain mirror, so a
  mis-detected/mis-rendered dialog can always be driven by hand with the keys pad. Persisted.
- **Multi-question wizard.** A multi-question AskUserQuestion (the `☒ Focus area ☐ Scope ✔ Submit`
  stepper) now renders as a native step-by-step wizard instead of bailing to the raw mirror: the
  stepper chips (answered/current per question), the current question's options as tappable buttons
  (one digit each — verified: a wizard digit instant-selects and advances), back/next step
  navigation, and the final Submit review step (answers echoed, submit/cancel). Incremental
  round-trip: every tap is a single race-guarded keystroke re-derived against a fresh read; the TUI
  stays the source of truth. Choreography + fixtures documented in
  `web/src/lib/grammar/WIZARD_NOTES.md`.
- **Galloping Collie loader.** The mascot now doubles as the app's activity indicator: a 6-frame
  gallop sprite (`web/public/dog-gallop.png`, a 768×128 transparent strip) stepped through with a
  pure-CSS `steps(6)` animation (no JS timers). At rest it's the familiar static app icon
  (`favicon.svg`); it springs into the gallop on the boot splash while the first snapshot loads and
  whenever the connection isn't live (connecting / reconnecting / offline), settling back to the
  static icon once live. Honours `prefers-reduced-motion`. New `DogGallop` component; rough
  first-pass art to be replaced with higher-quality frames.
- **Multi-question AskUserQuestion no longer mis-parsed.** A multi-step AskUserQuestion (the
  `☒ Focus area  ☐ Scope  ✔ Submit` stepper) was detected as a single-question select and answered
  with one digit+Enter — submitting a half-filled form. It's now recognized as a wizard and left as
  the raw mirror (drive it with the keys pad, or via the new escape hatch) rather than mis-sending.
- **One consistent top-left mark on every screen.** The Collie is now the brand + home button +
  connection loader in a single shared `CollieHome` component, rendered identically on the dashboard
  and inside a pane — so the header's top-left always means the same thing (previously a "stacks"
  icon inside a pane vs. the Collie logo on the dashboard). Inside a pane the Collie gallops on
  reconnect from the same global connection state as the dashboard (shared `isConnecting` predicate).
- **The pane's Nav-hub drawer** (the left "stacks" drawer). It was redundant now that the Collie
  handles Home, the swipe-up switcher already covers pane switching/closing, and the breadcrumb
  covers cross-space jumps — removed along with its `SpaceList` component. The swipe-up switcher now
  appears whenever a pane is open, so even the last pane stays closable.
- **Prompt/wizard taps are guarded against same-shaped successor dialogs.** The tap race guard now
  compares a byte-signature of the whole dialog region — including the subject above the options (the
  diff/command being approved), not just the question and option labels. So a tap on a frozen mirror
  can no longer approve a *different* action that happens to render an identical-looking prompt (e.g.
  a second edit to the same file after the first was answered elsewhere). Herdr's `revision` is a
  stub, so this content signature is the load-bearing freshness check.
- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)

## [0.3.0] - 2026-07-03

A full-codebase review pass: four audit agents (backend, frontend, security, ops/product) swept the
tree; everything they found was verified, fixed, and the top feature gaps were built.

- **Reply from the notification.** Needs-you pushes now carry up to two quick-reply action buttons
  (agent-aware: codex gets `yes`/`no`, others `yes`/`continue`; bridge sends `quickReplies` in the
  payload). Tapping one POSTs the reply straight from the service worker and confirms with a silent
  "Sent ✓" — no app open needed. Body tap still deep-links as before.
- **Find in output.** A magnifier in the pane header opens a find bar: case-insensitive match over
  the visible buffer, match count, prev/next that cooperates with the scroll-freeze, highlights
  rendered through the same React-text-node path (XSS boundary untouched).
- **Load older scrollback.** A "load older" row at the top of the mirror grows the fetched window
  600 lines at a time (up to 5000; the bridge clamps reads at 10000), preserving your scroll
  position across the refetch.
- **Destructive-input confirm.** Replies matching a reviewed pattern list (`rm -rf`, `sudo`,
  `git push --force`, `dd if=`, `mkfs`, redirects to system paths, …) flip Send into a two-tap
  "Really send?" state for ~3s — same pattern the `/clear` palette action already used.
- **Audit log.** Every write action (reply, keys, upload, tab/workspace create, pane close) appends
  a single JSONL line — timestamp, action, pane, device, truncated params — to
  `<state-dir>/audit.log` (mode 0600). Audit failures never block the action itself.
- `COLLIE_PUBLIC_HOSTS` env var — an explicit Host-header allowlist. When set, requests addressed
  to any other Host are rejected before origin logic, defeating DNS rebinding. Strongly
  recommended (set it to your MagicDNS name); effectively mandatory with `COLLIE_SERVE_MODE=http`.
- Startup warnings when `COLLIE_TRUSTED_USER` or `COLLIE_PUBLIC_HOSTS` is unset — parity with the
  existing bind/allowlist warnings, since an empty trusted-user means any tailnet device has write
  access.
- Uploaded images are now swept after 48h (was: kept forever).
- **Socket leak on RPC timeout** — a stalled Herdr left the Unix-socket FD open on every timed-out
  request; under the 1.5s poll cadence this exhausted file descriptors and wedged the bridge. Every
  terminal path now closes the socket.
- **UTF-8 corruption across socket chunks** — multi-byte characters (box drawing, emoji) straddling
  a socket-read boundary rendered as `�`; replies are now stream-decoded.
- **Overlapping polls** — a slow Herdr let 1.5s ticks pile up 3-4 concurrent polls; a tick is now
  skipped while the previous poll is in flight.
- **Upload buffering** — a too-large upload was buffered fully into RAM before the 10MB check;
  oversized `Content-Length` is now rejected up front and `Bun.serve` caps request bodies at 12MB.
- Push subscription saves are serialized and written atomically (temp+rename); concurrent
  add/prune can no longer drop a subscription. State files are written 0600 in 0700 dirs.
- First PWA load no longer flashes an immediate reload (service-worker `controllerchange` on
  initial claim was treated as an update).
- A rotated VAPID key now unsubscribes the stale push subscription and re-subscribes fresh instead
  of silently dead-ending pushes.
- Superseded loader revalidations are aborted (`request.signal` threaded through); raw key presses
  debounce their revalidate (one refetch per burst instead of one per keystroke).
- Slash-command insert appends to the draft instead of overwriting it; tap-to-focus no longer
  collapses an active text selection (copying pane output works now).
- `envInt` config parsing rejects garbage and out-of-range values (negative poll/debounce
  intervals, invalid ports) with a warning instead of silently accepting them.
- Static-file path guard now checks the directory boundary (`dist` vs `dist-*`); `?lines=` is
  clamped; API/static responses carry `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; graceful shutdown drains in-flight requests.
- Pre-commit version guard now also covers `web/vite.config.ts`, `web/index.html`,
  `web/package.json`, `web/public/`, `systemd/`, and root `package.json`, and requires the new
  version to sort strictly above the old one.
- **Builds are gated.** `bun run build` (root) and `collie-ctl.sh build` now typecheck bridge and
  web before building, and build into `dist-staging` with an atomic swap — a failed build can no
  longer leave an empty `web/dist` serving 503s. The pre-push hook typechecks both sides too
  (`SKIP_TYPECHECK=1` to bypass once). Root tsconfig now enforces `noUnusedLocals/Parameters`.
- **Write requests without an `Origin` header are rejected** unless they arrive on loopback
  (browsers always send Origin on POST; curl-on-host keeps working).
- Idle lock is now timestamp-based: backgrounding/foregrounding the app no longer resets the
  countdown, and returning past the deadline locks immediately.
- The composer moved into its own `<Composer>` component; `agent-chat.tsx` slimmed by ~230 lines.
- A reply whose text lands but whose submit keystroke fails now reports "typed into the pane but
  not submitted — check the pane before resending" (and `textDelivered: true`) instead of a generic
  error that invited double-sends.
- systemd unit hardened (`NoNewPrivileges`, `PrivateTmp`) and made persistent
  (`StartLimitIntervalSec=0`, `RestartSec=5`) so a crash-loop can't leave the service permanently
  down while you're phone-only.
- Notification deep links URL-encode the pane id; sheets manage focus (focus in on open, restore on
  close, `aria-labelledby`); space status dots gained screen-reader text; pinch-zoom re-enabled
  (removed `maximum-scale=1`).

## [0.2.0] - 2026-06-30

- **Do Not Disturb / snooze** (Settings → *Do not disturb*): pause all push for 30m / 1h / 4h, or
  resume early. Server-enforced and self-expiring, so it quiets every device — and it clears whatever
  is already on the lock screen the moment you snooze. The current deadline rides the snapshot, so it
  stays in sync across devices.
- `COLLIE_NOTIFY_DELAY_MS` env var — the push debounce window in ms (default `30000`; `0` notifies on
  the next tick with no debounce).
- `POST /api/notifications/snooze` — set/clear the global snooze (`{ snoozedUntil: number | null }`);
  the active deadline is reported on the snapshot as `notifications.snoozedUntil`.
- **Smarter push notifications.** A blocked/done alert is no longer fire-and-forget. Each one now
  waits a short **debounce window** (`COLLIE_NOTIFY_DELAY_MS`, default 30s) before it sends; an agent
  you clear at your desk within that window never reaches your phone. Alerts that *do* fire are
  **retracted** automatically once the agent resolves (or its pane closes), so handled work stops
  piling up on your lock screen. The service worker also **suppresses** the system notification when a
  Collie tab is already open and visible (the in-app status surfaces it instead).
- **Coalesced into one notification.** The whole herd shares a single notification slot: one agent
  shows the named, deep-linked alert; several collapse into a *"N agents need you"* digest (tap → the
  triage home) that updates in place as agents come and go, instead of stacking N separate alerts.

## [0.1.0] - 2026-06-30

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

- **Mobile-first PWA** (Vite + React + TypeScript + Tailwind v4 + shadcn): a triage dashboard
  (Spaces overview + Needs-you / Working / Idle agent groups), a per-agent colored terminal mirror,
  an agent-aware slash-command palette (Claude Code, Codex, pi, opencode), a special-keys pad with
  inline arrows/Tab, per-agent brand icons, image upload, and animated view transitions. Installable,
  with an auto-updating service worker and a build-stamp footer.
- **Bun/TypeScript bridge** over Herdr's Unix socket: a polled live snapshot (adaptive cadence,
  gzip + `ETag`/`304`) plus reply / keys / upload endpoints, and space/tab/pane management (create
  shell panes, switch, kill) through a unified nav hub.
- **Runs as a `systemd --user` service** supervised independently of Herdr, with a `tailscale serve`
  launcher (`scripts/collie-ctl.sh`) and a thin Herdr plugin (`herdr.collie`) exposing
  start / stop / restart / status / url / version / update / uninstall actions. One-command update
  (pull → rebuild → restart → re-link) for the linked checkout.
- **Optional Web Push (VAPID) notifications** when an agent needs you, with a custom service-worker
  push handler that renders the real message and deep-links the tap to the agent's pane.
- **Security posture:** loopback-only bind, `tailscale serve` as the sole ingress (never `funnel`),
  a same-origin gate, an optional `COLLIE_TRUSTED_USER` identity check, optional per-device
  authorisation via a trusted upstream header, a strict CSP, and terminal output rendered as React
  text nodes (the XSS boundary).
