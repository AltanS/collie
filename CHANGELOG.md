# Changelog

All notable changes to Collie are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml`, `package.json`, and `web/package.json` (enforced by
`scripts/check-version.sh`). See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [Unreleased]

### Fixed

- **tmux 3.4 no longer shows an empty herd.** That tmux prints Collie's invisible field separator as visible text, so every listing line failed to parse and the app sat blind while the bridge said connected. The wire is un-escaped now (only the separator, never a pane title's own text), and a listing that parses to zero rows on non-empty output is refused as an error instead of stored as an empty herd — the same fault can never be silent again (30add9a)
- **Beacon hooks survive updates on a binary install.** `collie hooks install claude` pinned the versioned path `versions/X.Y.Z/bin/collie`, which the updater's cleanup deletes — every hook then dangled. The hook command now resolves through realpath to the published name or `current/bin/collie`, and a re-run replaces a stale pinned entry while keeping the operator's own hooks (885951d)
- **A Herdr binary on PATH no longer hijacks the config dir.** `herdr plugin config-dir`'s answer now wins only when that directory actually holds a `.env`; a binary install's own `~/.config/collie/.env` is read instead of being dismissed as legacy (eee024c)
- **The dashboard header sits on one line.** The brand eyebrow rides above the "on <mux>" line out of flow, so the host and session chips and the gear share that line's centre instead of floating between the two left rows (8528e8b)

### Added

- **iOS learns how to install, inside the app.** The Settings install card only ever existed while the browser offered to install, which on iOS is never — install lives in the share sheet, and the people with the least-known path got nothing. An Apple touch device running in a browser tab now sees one line of prose instead of a button: tap Share, then "Add to Home Screen". Already-installed, desktop Macs and everyone with a real install button see no change (ecf561a)
- **`COLLIE_TAG` pins the installer to one exact release.** An environment variable, not a flag, so it survives `curl … | sh`: it skips the GitHub tags API entirely and, over an existing binary install, lays the pinned version down beside the broken one and flips `current` — the rescue for the day the installed binary cannot run its own `update`. A rate-limited tags call now says so plainly (60 unauthenticated calls an hour, shared per network address) and names the pin as the way around it (4291894)
- **The update banner speaks your install's language.** The bridge now reports its install kind on the snapshot (probed once at startup by the one shared classifier), and the footer banner spells its copyable commands from it: `collie restart` / `collie update --major` on a binary install, a linked clone or an unknown layout, the Herdr plugin actions only on a Herdr-managed checkout. An older bridge that reports no kind keeps the Herdr spelling, so nothing regresses mid-upgrade (ae92260)
- **`collie doctor` introduces itself first.** The first finding is this Collie's own version and platform, so a `doctor --json` block pasted into an issue never needs the follow-up question "which version was this" (38aacaa)
- **A way out when the binary will not run at all.** `docs/upgrading.md` gains "When collie will not run": run the previous version's on-disk binary directly for `update --rollback`, or pin forward with `COLLIE_TAG`. A GitHub bug-report form asks for the `doctor --json` block and, when collie will not start, that previous binary's output (ea8f5e3)

### Fixed

- **The header's right cluster sits on the mux line.** The host and session chips and the gear centred against the identity block's full two-line height, so they floated 8px above "on <mux>" and the row read as three loose shelves. The brand eyebrow now rides above the block out of flow, the block contributes only the mux line, and every centred child of the row shares that one visual line (8528e8b)

## [1.0.0-beta.49] - 2026-08-31

### Added

- **Releases now ship binaries.** Each `v*` tag publishes per-platform payload tarballs (linux-x64, macos-arm64 to start), a checksummed manifest and a `.sha256` sidecar for every asset; `install.sh` downloads and verifies instead of cloning and building, laying versions under `~/.local/share/collie/versions` behind a `current` symlink (73402b5)
- **`collie update` learned the binary install.** It detects the install kind structurally, fetch-verify-swaps with a pre-flip smoke test and post-flip auto-rollback, keeps one previous version for `collie update --rollback`, and on every git install now refuses to update a checkout whose `origin` is not the configured release repo — naming the fork remedy instead of force-checkouting onto foreign tags (73402b5)
- **`scripts/install.sh` — one command installs Collie.** POSIX sh, curl-pipeable and readable in a minute: it checks git and Bun, clones into `${COLLIE_DIR:-~/.local/share/collie}`, checks out the newest stable tag (`--beta` takes the major's prerelease train instead), builds through the shim and links the binary onto PATH. No sudo, ever; an existing checkout is left alone and named `collie update` instead. It ends by printing the three steps that are decisions — seed the config, choose `COLLIE_MUX`, `collie start` — rather than taking them. Interim: M14 swaps the clone-and-build for a binary artifact behind the same contract, which `scripts/install.test.ts` pins (d2706d9)
- **An Install card in Settings, present exactly while the browser offers to install.** Tapping it shows the browser's own install dialog; an already-installed app, iOS Safari and an insecure origin all show nothing rather than a dead button. (104c636)
- **The mark spins while your work is in flight.** A send, an upload, a transcription or a tapped link waiting on its loader now drives the orbit, so the mark says "still going" instead of resting through the wait. It is its own counter, not the busy bar's: the 1.5s background poll is excluded, because an orbit that never comes to rest says nothing. While the connection is given up on the mark stays still — a send fired into a dead link must not look like a retry (e0aeb7b)
- **The header stacks the brand over the multiplexer's name.** One 18px line — "Collie on <mux>" — ran out of room on a phone inside the one word there the reader does not already know; a screenshot had it down to a single letter. The brand is now an 11px eyebrow on the app's existing label tier, the name gets the whole 16px line, and the row still measures 60px on every route. The multiplexer's slot is reserved before its name arrives, so nothing jumps when `/api/config` lands (4db12d1)
- **The composer's draft field has its own text size — Settings → Terminal font, 13–16, default 14.** It was pinned to 16px, which was never a design choice: a focused input under 16px makes iOS Safari zoom the page and never zoom back. That fact is now handled where it belongs — a floor on the platforms that do it, probed for an Apple platform AND a touch digitiser — and everyone else gets a smaller, wider field. Its own number rather than the mirror's, because output you scan and a sentence you are writing want different things (21b1515)

### Changed

- **Collie introduces itself CLI-first.** The README tagline, package descriptions and the PWA manifest now say what it is — a phone UI for the AI agents in your terminal, mirroring Herdr, tmux or zellij — instead of naming it a Herdr plugin (4261c03)
- **`collie start` asks which multiplexer, instead of assuming Herdr.** With no `COLLIE_MUX` it probes for a live Herdr socket, a running tmux server and zellij sessions, asks at a TTY, auto-selects a sole find headless, and refuses on zero or several naming what it saw and the remedy. The answer is written to the config-dir `.env`; an explicit `COLLIE_MUX` is never second-guessed (4fc83ec)
- **The README is a hub and the how-to lives in `docs/`.** Nine scoped pages — install, security, configure, commands, multiplexers, pack, voice-and-push, upgrading, troubleshooting — moved out of a 1715-line README, prose carried across whole; what is left is 262 lines of tagline, demo, security summary, quickstart and a map. `docs/upgrading.md` gains "Upgrading from 0.x to 1.x". Every reference that named a moved heading follows, and `scripts/check-doc-links.ts` is the gate: it resolved seven broken links that predate the split (e9e4f85)
- **`docs/upgrading.md` documents the upgrade path for a fork.** `collie update` talks to the remote named `origin` and never checks its URL, so in a fork it fast-forwards your own branch or force-detaches onto your own tags, discarding uncommitted work — never upstream's release. The new "You run a fork" section says that plainly and gives the supported route instead: add `upstream`, fetch its tags, merge the release tag you want, rebuild, restart. It also states what `COLLIE_UPDATE_REPO` does and does not move — the update banner, not what `update` fetches (05a4b23)
- **Aldrich is the shipped default face.** Every default mechanism moved with it — the preload, the boot splash, the pre-paint class list, the operator-font fallback — so a device that never opens the Typeface setting now dresses in Aldrich at first paint with no layout shift. Space Grotesk stays a shipped choice. (a960f1f)
- **The composer's draft field renders in the terminal font** — the mirror's family, following the Terminal font setting, since what you type there is bound for the terminal. (e8337b2)

### Fixed

- **`pack add --peer-address` takes a bare host, and says so before it touches the far machine.** A `host:port` value was concatenated with `--port` and written into the member's `COLLIE_HOST` as `192.168.77.2:8787` — an address the bridge can never bind — leaving the machine half-enrolled with a dead service and nothing naming the cause. A scheme, a port, a path, a `user@` and brackets are all refused now, at parse time on the lead, before a byte crosses ssh (e950ab4)
- **An `http://` lead address is refused up front, and the refusal names a remedy that exists.** It used to arrive from `collie join` on the far machine — after the bundle push, the remote build, the `.env` write and two lead restarts — and it named `--insecure`, which `pack add` does not accept; re-running with the flag repeated it. `pack add` will not grow that flag: the consent belongs where the token is spent, so the message points at `collie join … --insecure` on the peer (0029881)
- **`collie leave` no longer leaves a `pack add`-installed machine crash-looping.** The wide `COLLIE_HOST` the pack needed is refused by solo mode, so the service failed every five seconds forever under a banner that said "activating" and "yet". Leaving now retires that bind and the machine comes back on loopback; a bind you set yourself (`COLLIE_ALLOW_NON_LOOPBACK_BIND=1`) is untouched, and one Collie cannot reach is explained instead of ignored. ADR 0013 is why the exemption lapses rather than being made permanent (55efea9)
- **`pack remove` prints the `ssh … collie leave` line that finishes the tear-down, and keeps the record it is built from.** It used to delete `pack-ops.json`'s row for the member in the same breath as saying that machine keeps its copy of the pack until someone runs `collie leave` there — throwing away the ssh destination that sentence needs (0aa3007)
- **The start banner prints the address the bridge actually bound.** With `COLLIE_HOST` set the `local` row still said `http://127.0.0.1:8787`, two lines under a readiness probe that had resolved the same bind correctly and reported the machine as running (1b77642)
- **`collie --version` and `collie pack --help` work.** Both answered `error: unknown command` and exited 2 (ac41c48)
- **A peer can reach its own lead again — the peer→lead dial no longer pins a certificate that can never be on the wire.** Every dial carried the same pinned TLS, so a peer dialling its LEAD anchored the lead's own certificate; but a lead's pack surface rides the front door, and `tailscale serve` — or any conforming proxy — terminates TLS before the process, so the certificate presented is the door's. Every peer therefore read its lead as `unreachable · unable to verify the first certificate`, and `collie leave` ALWAYS fell to its could-not-reach branch, leaving the lead still listing a machine that had left. `lead` and `warrant` ride the same direction, so the standby-door failover was on the same broken transport. The lead is now dialled unpinned — decided by its ROLE, never by the shape of its address — and §8.6's signature plus the pack secret keep the link two-factor (33fa455)
- **A deputy's takeover reaches the old lead, so a lead that is still answering keeps its crown.** The takeover dial pinned the old lead's own certificate — the same mismatch as above, in the one verb where it matters most: the takeover's first step is a `hello` at the lead whose ANSWER refuses the whole thing, and a pin that can never match made every lead look dead. A two-machine pack has no witness to catch that. The lead is now dialled unpinned, decided by its role, while a witness is still pinned to the certificate the warrant push carried; the pack secret and the dial attestation ride the unpinned dial, so the link stays two-factor (de62149)
- **The unreachable-lead hint names a verb that works, and stops telling you to break the entry.** A lead's address is its front door, so a scheme there is correct; the hint said otherwise and pointed at `collie pack set-address`, which refuses on a peer. The lead's row now gets the remedy that belongs to that machine — check the door over there, and if it MOVED, `collie reconnect <address>` here, which keeps the pin (4833666)
- **`collie reconnect` on a peer no longer tries to publish a tailnet front door.** It restarted through the generic start path, which published anyway — three lines of failure on a machine that was never supposed to ask, and on a real tailnet node it looks like it would publish the peer's own door, which ADR 0013 forbids. The guard now sits in the one function that publishes, so every restart on a peer is covered; the mapping is still torn down, and the verb reports success rather than a front door that never should have come up (ce73570)
- **A peer's spaces and tabs appear on the phone.** The merged snapshot host-tagged panes and sessions but not workspaces or tabs, and Herdr numbers those per machine — so two default installs both called theirs `w1` and `w1:t1`, the member's space and tab had no row at all, and every count on the surviving row was the lead's. A pack of two machines with one pane each rendered as one space claiming one pane. `(host, workspaceId)` is the identity now; the space navigator follows the host you are pointed at, and a solo snapshot is unchanged to the byte (52721b2)
- **An unreachable member is described in Collie's words, not Bun's.** *"Unable to connect. Is the computer able to access the url?"* — a browser console's sentence — reached `pack status`, the 503 body a phone reads and `collie leave`'s warning. Each failure now says what the far side did: nothing accepted a connection, the address does not resolve, the TLS certificate was not accepted. A message carrying a duration keeps it, and an unrecognised failure is passed through rather than dressed up (7fd6f83)
- **`pack add`'s port probe says what it saw, not what is true.** It reported `✓ port 8787 free` over a service that was crash-looping — true at that instant, and a coin flip against a five-second restart cycle. The negative answer now reads "nothing was listening just now". Whether a port is held by a service that keeps coming back is not knowable from the lead, and the probe says so instead of pretending (68eb045)
- **The v1 beta install command resolves the newest tag instead of pinning one two releases stale**, and `## Install` now says in one line that the bare command tracks the stable line (b7e4e64)
- **PACK_PROTOCOL.md §9.2 and the registry comment call the wire parameter `host=`, which is what the code sends.** Both said `?h=`, which is the browser route's spelling only — and because an absent host means "this collie", a hand-written `?h=member` does not 404, it silently addresses the lead (53bab99)
- **A long upload path can no longer push Send off the screen.** Attaching an image appends the bridge's host path to the draft as one unbroken token, which laid the composer row out 575px wide inside a 378px phone frame and put Send 209px past the right edge (352fc83)
- **The composer's notices slide in instead of shoving the field up.** Six in-flow strips were bare conditionals, so each one teleported the whole composer up by its own height the moment its condition flipped — worst with the keyboard up and the eye in the box. All six now arrive and leave through the app's one collapse surface, and the two armed-mode strips share a single slide rather than fighting for the row. The sort was checked too: every strip left in the footer is a condition carrying its own controls, and the one real event there was already a top pill (32e6ce5)
- **A space row's time sits left of its pane count, like every other list in the app.** The count chip now anchors the right edge whether or not a row has a timestamp, so rows with and without one line up (8f6ca7e)
- **A pane's hint truncates instead of wrapping.** One long sentence made its card taller than every other row in the list, for no reason a glance can see; the full text stays one tap away in the pane view, and a hover away on desktop (556ce58)
- **`pack status` on a peer no longer reports a healthy lead as a starved data link.** It asked every member two questions — `hello`, then a real snapshot read — which is exactly the poll a lead runs. But a peer's one roster entry is its LEAD, and the snapshot route is deliberately not on the closed peer→lead set (PACK_PROTOCOL.md §8.6: `leave`, `lead`, `hello`, the warrant deliveries). So the lead refused, correctly, and the peer rendered the refusal as `data STARVED … not arriving inside the per-poll budget` over a remedy — raise two timeouts — that cannot move an authorization refusal. A peer now asks its lead one question and rests the row on it; `collie doctor`'s `lead-reach` reports what it actually asked (6aab680)
- **`collie leave` ends on the truth about the machine it just fixed.** The closing health banner was built from the environment as this run READ it, not as `leave` had just rewritten it, so a correct tear-down finished with `⚠ Collie isn't answering on 192.168.77.2:8787 yet` about a machine that was healthy on loopback — the same alarm the crash-loop fix used to raise, now false, at the end of the same command. The banner also resolves its probe target once, so it and the `local` row can never name two addresses, and a wildcard bind probes loopback (845de8c)
- **Re-adding a machine that left works without a terminal.** `collie leave` unsets `COLLIE_HOST`, so `pack add` on that machine found nothing and asked `is configured to bind (unset):8787` — a placeholder in operator copy, and self-defeating, since an absent value is precisely what says there is nothing to preserve. Non-interactively it stopped dead, `ssh -tt` included. An unset bind is now written straight through, with the reason said out loud; a bind somebody set, wide ones included, is still confirmed before it is replaced (babc18b)
- **A peer stops offering a front door it does not have.** The start banner still printed a `tailnet` row — a door that is not there, at a loopback URL that is not even a peer's bind — and `collie serve` typed by hand ended on `open: http://127.0.0.1:8787` one line under the sentence saying a peer publishes none. The refusal now stands alone, and the banner names the pack instead, because on a peer the door to point a phone at is the lead's (bb4f11a)

## [1.0.0-beta.48] - 2026-08-30

### Added

- **Zen mode — one tap takes every Collie surface off the screen and leaves the terminal mirror alone.** Off by default; turn it on in **Settings → Zen mode** (per device, in the browser) and a **Zen mode** row joins the pane's ⋮ menu beside Find and History. It hides the header row, the tab and pane strips, the agent's statusline, the composer and its docks — on a phone that is most of the viewport, and all of it is in the way while you read a long build log or a wide TUI. A floating 44px button in the top-right brings it back, and so does Escape. Deliberately transient: the setting persists, the state does not, so a pane always opens with its chrome. The mirror keeps polling and stays interactive throughout — prompt buttons and the top-of-buffer scrollback affordances are content, not chrome. Ported to v1 and re-expressed in its terms (the entry is a menu row, not a header button; every surface leaves through `ui/collapse.tsx`; the one hoisted header collapses its own row on a new `HeaderClaim.hidden`) — thanks @abosnjakovic (#139) (a8bf60a)
- **Worktrees from the phone — branch off and put an agent on it without walking back to the desk.** The `+` on the spaces list now asks which kind: a plain space, or a **worktree**. Pick the repo (the ones already open, most recently used first), type a branch name, and Collie creates the worktree and opens it as its own space, landing you on its pane ready for the first prompt; *"or open one that already exists"* underneath lists the repo’s checkouts no space is showing yet. A worktree then **nests under the space showing its repo** in the list, the group taking the position of its most recent member — and stays flat when its repo is not open, or when a filter is on. Three declared capabilities (`listWorktrees`, `createWorktree`, `openWorktree`), each cell in `MUX_CONTRACT.md` citing a first-hand probe of herdr 0.8.2; tmux and zellij decline them with their reasons. Herdr opens the checkout, never `git worktree add` + `createSpace` — [ADR 0032](./.adr/0032-a-worktree-is-opened-by-the-multiplexer-not-by-git.md) says why. `worktree.create` is not atomic, so a branch created with nothing opened on it offers **open**, never **create again**. Your own terminal is never moved. Ported to v1 and re-expressed in its terms (both creates run through the space-create flow, so they carry the `freshPane` bootstrap, the revalidate, the write gate and the status line every other create does) — thanks @broven (#135) (50e0e42)
- **The app's typeface is yours now — Settings → Typeface, per device.** **System**, **Space Grotesk** (the default, unchanged for anyone who never opens the card) or **Aldrich**, a new self-hosted 8 KB face; the card sits directly above **Terminal font**, which is a different setting and stays one. Applied *before first paint* as a root class, so a pinned face never flashes the default — `index.css` owns every stack and JavaScript only swaps a class name. Aldrich ships one weight, so its bold is the browser's; the note under the picker says so. Reverses "the app face is the maker's choice", at the maker's request — [ADR 0033](./.adr/0033-the-app-face-is-a-device-preference.md) records why, and what survived: the chosen face dresses chrome and **never** an agent's words (d17d410, 801d25c)
- **Bring your own font — `theme.toml`, the fourth operator file.** `[[font]]` rows put your own faces in that same picker, served read-only from `<config-dir>/fonts` and live on an mtime check like the other three. Unlike them, your rows **ADD** to the shipped list rather than replacing it: a font cannot fire an action, so it shadows nothing (ADR 0033, which leaves ADR 0018 untouched). Only declared files are served, on a bare-name grammar plus the journal's own containment check, and every field is re-validated on the phone before it reaches a stylesheet. Start from `theme.toml.example` (e6e9142)

## [1.0.0-beta.47] - 2026-08-30

### Added

- **A release that is cut but never tagged is now loud.** Betas 33 to 41 were bumped in the version files and the CHANGELOG and never tagged — not even locally — so nine consecutive versions existed that no tester could install, and nothing said a word. `scripts/check-tag.sh` checks the claimed version, or every `chore(release):` commit in a rev-list selector, against the local tag list, reading each version from *that commit's* manifest rather than HEAD's. The pre-push hook runs it over the range being pushed and WARNS last, with the exact `git tag -a` command; skip once with `SKIP_TAG_CHECK=1`. Betas 33 to 41 stay unreachable on purpose — CLAUDE.md records why (b266ffe)

## [1.0.0-beta.46] - 2026-08-30

### Fixed

- **A managed update now STORES the release tag it lands on, so git can say which release a checkout is.** `update` fetched the bare ref (`git fetch origin refs/tags/v1.0.0`), which writes FETCH_HEAD and no local tag, leaving `refs/tags/v<version>` either absent or stale. Absent — a checkout only ever updated this way — makes `web/vite.config.ts` fail its `rev-parse` and take the catch path, so the stamp is clean by accident rather than by evidence. Stale — a checkout carrying an older `v<version>` from an earlier fetch — makes it compare that tag against HEAD, see a difference, and stamp a genuine release `-dev`. Measured in the VM lab as `1.0.0-dev+8d57cc8`. The PWA footer and the `X-Collie-Build` header then called a release a development build, and `pack update` read the `-dev` tail as "not that commit", so a member updated this way looked like it had never taken the push. Fetched with the storing refspec `+refs/tags/<tag>:refs/tags/<tag>` now, which is true in both shapes; the shallow logic and the detach are unchanged (ed0eb7c)
- **An update with nothing to take no longer rebuilds and restarts the bridge.** "already current", "no release of major N yet" and "nothing to cross to" each fell through into two `bun install`s, two typechecks, a Vite build and a service restart, ending on `✓ update complete` — minutes of work and one interruption for a no-op, in a transcript that contradicted its own first line. The verb now returns on the verdict, but only when the install on disk is also intact: `bin/collie` present and the built bundle stamped with the manifest's version. Anything less still builds, because that is the documented recovery from a build that failed mid-update (d2b5b79)
- **The "a new major is out" notice is repeated as the last line of the transcript.** It printed on line 5 of ~70 and the operator reads the tail, so the notice the whole 1.0 migration depends on never reached the eye. The early two-line form stays beside the decision; a one-line form now follows the final status block. Not printed after `--major`, which lands on that release (ab360e7)

## [1.0.0-beta.45] - 2026-08-30

### Changed

- **A beta install now keeps itself moving — `update` walks `beta.N` → `beta.N+1` → … and takes `v1.0.0` the moment it exists.** Every tester recruited onto a beta froze on the beta they installed: the tag anchor rejected prereleases, so `update` answered *"no release of major 1 yet — leaving this checkout where it is"* forever and the banner offered nothing. Prerelease-following is a property of the INSTALLED version, never a flag (c57f2f7)
- **The train is a fallback, not a preference.** A prerelease install takes the highest STRICT release of its major whenever one is newer than it, and drops to that major's prereleases only when none is. So `beta.44` skips `beta.45` and goes straight to `v1.0.0` once `v1.0.0` is cut — the release supersedes every beta that led to it — and a later `v1.1.0-rc.1` is then as invisible to it as to any stable install. The consent taken by installing a beta was to the road *to* its release, not to that major's prereleases forever (c57f2f7)
- **A stable install is unchanged, byte for byte** — strict `vX.Y.Z` tags only, banner and verb both. Nothing can pull it onto a prerelease, and `update --major` still targets the next major's strict release (c57f2f7)
- Prerelease tails now compare by semver §11 instead of as a boolean, so `beta.9` sorts below `beta.10` rather than equal to it — the train would otherwise have frozen at its first two-digit beta (c57f2f7)
- ADR 0020 amended (2026-08-30): the 2026-08-20 "the betas are invisible to the banner by design" bullet is withdrawn. README → *Testing the v1 beta* states the new rule (c57f2f7)

## [1.0.0-beta.44] - 2026-08-30

### Fixed

- **`collie build` no longer runs the lint gate — a gate on the operator's path bricked installs.** `build` is the ONE build every operator path runs: a clean install through Herdr's `[[build]]` step, `update`, and the 0.x→1.0 crossing. oxlint's Rust allocator aborts with SIGABRT (a panic in `oxc_allocator/src/pool/fixed_size.rs`) on a host with less than roughly 7 GB of RAM — bisected on identical VM guests: 4 GB and 6 GB abort, 7, 8 and 12 GB pass. So a clean v1 install ended `Plugin was not installed.`, and an upgrade left a detached checkout with no `bin/collie`. `SKIP_LINT=1` was the workaround, and needing one to install a plugin is the bug. The mux-name check left with the lint step, having ridden the same hatch by design; `SKIP_LINT` is gone, because nothing reads it any more (e321c39)
- Lint is still enforced where a developer can act on it, and nothing about ADR 0019 changes: CI's `Lint` step runs the full tree and remains the authority, the pre-commit hook lints the staged files, and CI covers the mux-name check through `scripts/check-mux-names.test.ts`, which runs the script over the real `web/src`

### Changed

- **Correcting beta.43's notes:** they said each of the three agent-parser fixes "carried a real capture rather than a guess". Two did — [#140](https://github.com/AltanS/collie/pull/140) and [#142](https://github.com/AltanS/collie/pull/142) added capture fixtures. [#141](https://github.com/AltanS/collie/pull/141) used a synthetic test row

## [1.0.0-beta.43] - 2026-08-30

### Fixed

- Merged the four fixes that landed on the 0.x line, so v1 is not behind stable on correctness. Three are agent-parser fixes that every operator hits, and each carried a real capture rather than a guess ([#140](https://github.com/AltanS/collie/pull/140), [#141](https://github.com/AltanS/collie/pull/141), [#142](https://github.com/AltanS/collie/pull/142), [#121](https://github.com/AltanS/collie/pull/121))
- **Codex, one-line draft:** the status-row detector accepted only alternating coloured fields and standalone dim separators, and current Codex paints its final collaboration-mode field together with its separator as ONE dim segment. The row was rejected, `locateComposer` returned nothing, and every reply to the pane was refused with "the input box isn't on screen" while the box was plainly on screen
- **Codex, wrapped draft:** a continuation row was recognised as "exactly two spaces then a non-space", but those two spaces are the composer's gutter and what follows is the operator's own text, which may itself be indented. One shift+enter onto an indented line — a single tap on a phone — stranded the draft, and the stranded draft then failed the NEXT send too. It did not recover on its own
- **oh-my-posh 18:** the ghost-suggestion rule keyed on a trailing coloured run following UNSTYLED text, but omp 18.0.11 paints the draft whenever the agent is working. The anchor vanished, the rule fell back to refusing, and the ghost was read as part of the draft — so every reply to a BUSY omp pane stalled, which is exactly the pane you most want to answer from your phone
- **Windows:** the supervised bridge registered as `powershell.exe` under an Interactive principal, which allocates a console — so a background service appeared as a Windows Terminal tab. Closing the tab killed the bridge, and the restart policy brought both back a minute later. It now runs under `conhost.exe --headless`, on a pseudoconsole with no window

### Changed

- `codex/markers.ts` uses v1's `hasControlChar()` rather than the `CONTROL_CHARS` regex the upstream fix was written against. The two are equivalent, tab exempted on both sides; v1 had already replaced the pattern with a code-unit scan, matching how `links.ts` cuts the same bytes out of an href
- The new oh-my-posh test cases bind `borderRow` rather than `row`, which shadowed this file's own `row(name, i)` helper. `main` has no lint gate and let it through; v1's does not

## [1.0.0-beta.42] - 2026-08-30

### Changed

- The mark's orbit round now throws quickly and coasts down slowly, instead of decelerating exactly as hard as it accelerates. The curve is still a raised cosine; it runs on a warped clock, which moves the peak to 35% of the round and gives the slowdown the other 65%. Nine tenths of the way through, the orbit is five times slower than it used to be at the same instant, and the curvature it stops on is an eighth
- The throw is correspondingly sharper, and that is the same fact rather than a side effect: the round still covers exactly one turn in exactly the same time, so a longer coast has to be paid for by a quicker throw
- The mean is now 1 BY CONSTRUCTION rather than by a derived constant — the warp is a substitution, so the turn is conserved for any skew, and the amount of skew can be retuned by feel without re-deriving anything

## [1.0.0-beta.41] - 2026-08-30

### Changed

- The gap between the tab row and the terminal is 4px instead of 8px. It is the only vertical space on that row that is not the tap target: the row is 45px and 44 of it is the tab, drawn at full size rather than faked over a smaller box, so shrinking the tab would shrink the thumb target one-for-one. The gap cannot close entirely — the active tab's fill and the terminal's ground are byte-identical under both themes on purpose, so with no page between them the open tab loses its floor and the two rules read as one doubled hairline

## [1.0.0-beta.40] - 2026-08-30

### Changed

- The mark's orbit round is thrown rather than switched on: it accelerates from rest, peaks at twice the sprint halfway through, and comes back down to rest, the way a spun wheel behaves. It still covers exactly one turn in exactly the same time — the curve is a raised cosine, whose mean is exactly 1, so the easing redistributes the turn without spending or saving any of it
- Both joins with the resting drift are now at zero speed, so the round no longer starts or ends with a velocity jump
- **Reverted from beta.38:** the tab bar and the pane switcher no longer stand down while the keyboard is up. The operator declined the trade — the tab row is how you know where you are, and losing it the moment you start typing costs more than the 53px is worth. The pane-switch handle and the agent statusline still stand down; those two are unchanged. (Landed inside this release's commit rather than its own; the beta.38 line above is superseded by this one.)

## [1.0.0-beta.39] - 2026-08-30

### Fixed

- Closing the tab you are IN now says so, and the mark's orbit turns with it. That path navigates you to a neighbouring tab, so the ✓ on the button you tapped was being drawn inside a strip that was unmounting, on a screen you were leaving — an acknowledgement nobody could be looking at. Closing any OTHER tab is unchanged: the tab leaving the strip is the outcome, and the echo carries the acceptance

## [1.0.0-beta.38] - 2026-08-30

### Changed

- The read-only notice is a thin strip instead of a wrapping box. It was ~62px on a phone — more than the pane-switch handle and the agent statusline combined — spent on a standing condition that never changes for the life of the device. It uses the short copy that was already written and already translated for the space route, and drops the device-name suffix, which was answering "which device is this?" on the device you are holding
- The tab bar and the pane switcher stand down while the soft keyboard is up, with the pane-switch handle and the agent statusline. 53px, and the largest single block above the mirror. Taken with the keyboard rather than with a tab count on purpose: a second tab can appear with no operator action at all, and a row arriving on its own would push the whole mirror down. The header breadcrumb still names the tab while you type

## [1.0.0-beta.37] - 2026-08-30

### Fixed

- The bottom of a pane no longer falls off the screen when the soft keyboard is up. The route column is one screen tall and the mirror is the row that gives, so once the mirror hit zero the surplus painted past the bottom edge and the send button became unreachable. The bottom region now keeps its size and the two parts of it that GROW are bounded instead
- Both of those bounds are a fraction of the viewport rather than a pixel count, so they follow the device and the keyboard instead of encoding one phone. The draft field caps at `min(10rem,30dvh)` — at rest, on any ordinary screen, that is the 160px it always was — and the agent's statusline at `18dvh`, scrolled rather than clipped so the permission-mode row is never eaten
- The keyboard predicate now has hysteresis: it opens on a 150px drop and closes on a 100px one. One threshold flipped repeatedly on a viewport hovering at the boundary — split screen, a floating keyboard, a predictive-text bar — and each flip now moves a third of the screen. The close number also stops a hidden URL bar stranding the operator in a composing layout with no keyboard

### Changed

- Two rows stand down while the soft keyboard is up: the pane-switch handle and the agent's statusline. Both are read before typing, not during it, and together they hand 55-146px back to the mirror at the one moment it was showing nothing. Both leave through `ui/collapse.tsx` and unmount, so neither is left focusable off screen
- The composer's status band deliberately does NOT stand down with them. It is 14px and it is the only place the pane's state is spelled as a word rather than a coloured dot, read with the thumb over Send
- The composer stops reserving room for the home indicator while the keyboard is covering the home indicator

## [1.0.0-beta.36] - 2026-08-30

### Added

- The Collie mark turns its orbit one full round whenever the app has something to tell you — a send landing, an agent finishing or needing you, a pane closing under you. A burst turns it once, not once each
- `lib/ack-manifest.ts` and its test — every mutating call the app can make must name the channel that acknowledges it, so a new one cannot be added without that decision being written down and reviewed

### Changed

- The pane's status notice floats at the top of the content region instead of holding a row. A "Sent" no longer pushes the tab strip, the pane strip and the whole mirror down 30px and back again 2.5s later
- The status notice is a pill that hugs its text, not a bar across the column — a floating slab read as a standing condition arriving rather than a note passing
- All three screens now mount the shared `ui/toast-viewport.tsx` rather than hand-rolling the same overlay
- The mark's loading orbit turns in 1.8s, was 2.4s, and the header weight keeps both accent beads at any size — the 40px mark used to drop the rose one and show a single violet dot
- A pane header that falls back to naming its tab now carries the pane's own tag as well, but only when the tab holds more than one pane

### Fixed

- A failed notification snooze is reported instead of being swallowed
- A notification preference that fails to save says so, instead of silently flipping the switch back
- Closing a pane or a tab acknowledges the tap at the control, instead of waiting for the row to disappear on the next poll

## [1.0.0-beta.35] - 2026-08-30

### Added

- "All sessions" in the session switcher — one triage list across every Herdr session on a machine, each row tagged with the session it lives in (c250a4f)

### Changed

- A row is opened with its own session as well as its own machine, so a widened list can never point a reply at an identically-numbered pane elsewhere (c250a4f)

## [1.0.0-beta.34] - 2026-08-30

### Added

- Each tab now carries the logo of the agent it runs, when its panes agree on one — a tab with none, or with two, stays unmarked (8aa6b88)

### Changed

- The pane header's agent logo moved onto the name line at 16px, so the working directory gets the block's full width (8aa6b88)
- Sheets and drawers stand on `--card` with a `--rule` edge instead of the page's own colour — the fix for a drawer that was hard to make out in dark (fd88072)
- The pane's swipe handle joined the composer's chrome block, so it sits on chrome rather than on the terminal (fd88072)

### Fixed

- The composer's status row is bounded on both edges, so the box it centres in is the box you see; the stack got 9px shorter with it (3155b63)
- The composer's chrome stands on its own `--chrome` token — rgb(23) in dark instead of `--muted`'s rgb(38), which read as a bright slab under the terminal; light is unchanged (dd02307)

## [1.0.0-beta.33] - 2026-08-28

### Added

- `collie doctor` now says WHY a pane's "Show entire history" link is missing: the Herdr build, the
  `herdr integration status` of every agent this build can journal, `python3`, each pane's reported
  session, and the resolved transcript roots — one remedy per ✗ (#137, b60e22b)
- The pane view now names the same cause in place: an agent that could have a transcript and
  reported no session gets a muted line asking for the Herdr integration and a restart (#137,
  b60e22b)

## [1.0.0-beta.32] - 2026-08-28

### Fixed

- The resting mark's slow drift (48s/turn) now actually advances instead of snapping back to the
  start of its turn every ~1.5s (d1e6468)

## [1.0.0-beta.31] - 2026-08-28

### Added

- New Collie mark: it drifts at rest (48s/turn) and spins fast while loading, both driven by the
  same keyframes so a state change only changes speed; `prefers-reduced-motion` stops it entirely
  (526c313)
- The six favicons and home-screen tiles redrawn to match the new mark (526c313)
- Dev-only states playground at `web/playground.html`, rendering every UI state against real
  components; it never ships (526c313)

### Changed

- Language setting is now a native select; the six-row footer band and its long description are
  gone, keeping the rest of Settings on screen on a phone (526c313)

### Removed

- The header's "synced Ns ago" stamp — the connection banner and the mark now carry stale-link
  state (526c313)

## [1.0.0-beta.30] - 2026-08-28

### Added

- `collie stt setup` takes an optional spoken language (`--lang`, `COLLIE_STT_LANG`) — blank stays auto-detect, which is what a mixed-language speaker needs (b5e2a36)

### Changed

- The microphone IS the primary button while the message box is empty, and becomes Send at the first character; the field regains the width the in-field mic cost it (abdbf45)
- Default transcription model is now `gpt-transcribe` — OpenAI's successor to `gpt-4o-transcribe` on the same request, cheaper and more accurate (b5e2a36)

### Fixed

- A voice upload no longer raises the "Reconnecting…" bar: while one is in flight nothing escalates and nothing polls (77ad3d8)
- The transcription deadline is derived from the clip size instead of a flat 60s, so a long recording survives a slow mobile uplink (77ad3d8)

## [1.0.0-beta.29] - 2026-08-26

### Added

- Pack link in the dashboard footer — one line beside the build stamp, hidden on a solo install (6158f1e)

### Fixed

- Herdr adapter serves Herdr's own ram mark instead of a drawn placeholder (6158f1e)

## [1.0.0-beta.28] - 2026-08-26

### Changed

- Pack overview is now a formation — lead at the apex, deputy below, peers fanned in a V; tap a machine for its detail sheet (5c3478d)

## [1.0.0-beta.27] - 2026-08-26

### Added

- Pack overview page at `/pack` — one read-only card per machine: health, version, secret pickup, deputy; entry points in the machine switcher and Settings, hidden on a solo install (0634d4b)
- `GET /api/pack` — the lead's in-memory pack census for that page; 404 on solo and peer (0634d4b)

## [1.0.0-beta.26] - 2026-08-26

### Fixed

- **A cold zellij start no longer reads as an empty herd for 13 seconds** — a watch that just came up now reconciles, because a stream that was dark cannot report what changed while it was dark (e81e48c)
- **Relaxing the poll cadence is earned by a connected poll, not granted by the event watch's ack** — the ack proves a census answered, never that a snapshot succeeded (d5ce772)
- **A poll that fails before the bridge ever connected now says so** — the warn was gated on being connected, so the first poll's failure, the one that matters most, was the one that logged nothing (d111064)

## [1.0.0-beta.25] - 2026-08-26

**Merges Collie 0.35.0 into the v1 line.** Its two fail-closed gates apply here too — read 0.35.0's
BREAKING note below. One v1-only exemption: a collie **in a pack** may bind off loopback, and
`/pack/v1/*` is not subject to the peer-address check ([ADR 0013](./.adr/0013-a-peer-listens-without-becoming-a-front-door.md)).

### Added

- **`quick-replies.toml`: your own Quick-dock groups** — the third operator file, same reader and
  same scope ladder as `commands.toml` and `keys.toml` (0.35.0, #131 — thanks @fucx)
- **`doctor` reports the multiplexer as a finding of its own** — a missing beacon emitter costs what the adapter says it costs (273a740)
- **`doctor` reports a wide bind on a solo collie as an error** — the bridge now refuses to start on one, so the check says the same thing (d941de1)

### Changed

- **Host validation, identity and bind now fail closed** — `COLLIE_ALLOW_ANY_HOST=1`,
  `COLLIE_TRUSTED_USER_OPTIONAL=1` and `COLLIE_ALLOW_NON_LOOPBACK_BIND=1` are the three opt-outs
  (0.35.0, #129 — thanks @bartholomewtj)
- **`collie start` discovers this node's tailnet hosts into the unit** — a normal tailnet install
  configures nothing; the operator's own `COLLIE_TAILSCALE_HOSTS` wins, and a failed probe keeps the
  allowlist the unit already had rather than locking the phone out (d941de1)
- **`.env` is held to owner-only** — tightened in place on read, warned about either way, never a refusal to start (d941de1)
- **An unversioned managed checkout pins `update` to the newest release tag**, never to `origin HEAD` (d941de1)
- **Uploads are typed by magic bytes**, not the client's Content-Type (0.35.0)
- **The startup log names the multiplexer it drives**, not only the one it cannot reach (d8e909d)

### Fixed

- **A Claude is a Claude from SessionStart** — the pane no longer reads as a shell until its first prompt (f1ef741)
- **Every beacon hook entry carries `timeout 10`** — a hung emit never stalls the agent for Claude's default minute (fc287b0)
- **The sync stamp lives in the header** — the chrome no longer changes height between the dashboard and a space (0551427)

## [1.0.0-beta.24] - 2026-08-25

### Removed

- **"Follow terminal" setting removed** — unnecessary; the phone never follows the terminal, only "Show in terminal" moves it (45611a5)

## [1.0.0-beta.23] - 2026-08-25

### Fixed

- **No second scrollbar beside the dashboard list** — the list and settings scrollers are now the containing block for their `sr-only` labels, which used to escape the clip and stretch the whole page (519b09f)

## [1.0.0-beta.22] - 2026-08-25

### Fixed

- **"Follow terminal" now follows a multi-space server** — the focused space is resolved first, then its one focused pane; every space has an active pane, so the old herd-wide read called a two-session tmux ambiguous and moved nothing (5acf596)
- **"Show in terminal" reaches the screen across tmux sessions** — an attached terminal sitting on another session is carried over with `switch-client`, instead of an `ok` that moved nothing (5acf596)

## [1.0.0-beta.21] - 2026-08-25

**The phone keeps up with the terminal.** Freshness, focus and how many spaces a multiplexer can hold are now declared by each mux adapter and rendered from the declaration — [ADR 0031](./.adr/0031-freshness-is-a-declared-promise.md).

### Added

- **`refresh()` on the mux floor + declared topology latency** — "look now" for every adapter; `/api/config` says `push` or `bounded` (zellij: 12 s) (b025698)
- **Attention-coupled census + `POST /api/refresh`** — zellij checks every 1.5–3 s while a phone watches; every phone-initiated create/rename/close/focus re-reads before it answers (8df0c29)
- **Pull-to-refresh, refresh on foreground, "synced Ns ago"** on a bounded mux (244409c, 2be919d)
- **`setFocus` capability + `POST /api/pane/:id/focus`** — Herdr and tmux; zellij declines (its `focus-pane-id` is a no-op, probed) (034de50, 682bf7d)
- **"Show in terminal"** row in the pane actions and a **"Follow terminal"** setting (off by default; held by a draft, an armed Type, or an open sheet) (8fd0960)
- **`spaces: one | many`** declared per mux — the space strip disappears on zellij (ee32e97, 8fd0960)
- Conformance: `pokeTopologyOutOfBand`, `focusOutOfBand`, and four new read-only live checks (698f006, 77b04e1)

## [1.0.0-beta.20] - 2026-08-25

### Fixed

- **tmux/zellij: a program's terminal title is no longer shown as a name you chose** — both multiplexers have one title slot and any program can write it, so the adapters now report only what Collie's own rename set as `paneLabel` and everything else as the terminal title; a title left behind by an exited program is marked stale, never leads a row, and is never deleted (a2ad9d8)

## [1.0.0-beta.19] - 2026-08-24

### Fixed

- **tmux: a new tab no longer kills the tmux server** — creating a tab or space on tmux < 3.7 while the global `window-size` is `manual` segfaults the whole server (tmux [#4849](https://github.com/tmux/tmux/issues/4849), fixed in 3.7); Collie now reads the option first and refuses with the `tmux set -g window-size latest` that clears it, never setting it itself (b58cb61)
- **tmux: a server that dies mid-call reads as disconnected** — `server exited unexpectedly` / `lost server` now raise the disconnected banner and its retry instead of a red refusal (b58cb61)

## [1.0.0-beta.18] - 2026-08-24

### Added

- **Language setting** — Collie's UI in English, Deutsch, Español, 한국어, 日本語 and 中文, picked in Settings by native name and remembered per device; the terminal mirror, agent output, quick replies and screen-printed menu labels stay untranslated ([ADR 0030](./.adr/0030-the-ui-is-translated-by-a-typed-dictionary-not-a-library.md)) (42949cf)
- **Bridge error codes** — every displayable refusal carries a stable `code` plus named `detail` beside its unchanged English sentence, so the phone renders it in its own language; additive on the pack link (§7.1), version stays 1 (fee9aa5)

## [1.0.0-beta.17] - 2026-08-24

### Added

- **`COLLIE_SERVE_PORT`** — publish the managed https front door on a tailnet port other than 443, so several developers sharing one host get a URL each; unset stays byte-identical to before ([#98](https://github.com/AltanS/collie/issues/98)) (a1f26c9)

## [1.0.0-beta.16] - 2026-08-23

**Voice input** — a microphone in the composer, off until you run `collie stt setup`. Ports the work
of [#91](https://github.com/AltanS/collie/pull/91) (@en-ver) and
[#115](https://github.com/AltanS/collie/pull/115) (@ardaaltinors), both previously declined;
[ADR 0029](./.adr/0029-speech-to-text-is-a-provider-seam-collie-owns.md) records what changed, and
[`docs/voice-and-push.md`](./docs/voice-and-push.md#voice-input-optional) has the setup.

### Added

- **ADR 0029 + the provider seam** — `bridge/stt/`, registered not special-cased, absent until configured; the `openai-compatible` provider covers the public API, the cloud clones and a local whisper.cpp / parakeet.cpp server (the zero-egress choice) (14575b3)
- **The `codex` provider** — a short-lived token from the operator's own `codex app-server` over `getAuthStatus`, never `~/.codex/auth.json`; the wire identity is probed honest-first, the fallback needs typed consent, and whichever won is written into the config (c7eb729)
- **The microphone, and hands-free** — a record button beside the composer's attach control, drawn only when the bridge published a provider *and* the browser can actually record; the hands-free toggle sends through the guarded reply path, never around it (ca5564a)
- `collie stt setup | test | status | off` — interactive or fully by flag, writes `stt.json` at 0600, live with no restart; `test` is one real round trip, `status` names the source of every field (204ede6)

## [1.0.0-beta.15] - 2026-08-23

### Fixed
- `url`/`status`/`serve`/`qr` now defer to `COLLIE_PUBLIC_URL` wherever it's set, instead of printing
  the bare tailnet name when `tailscale serve` isn't on :443 (#122) (d1e671e)

## [1.0.0-beta.14] - 2026-08-20

**The deputy and the takeover** — a pack can now name a standby peer ahead of time and let the
operator promote it, by hand, when the lead goes dark. ADRs
[0026](./.adr/0026-the-operator-is-the-quorum.md), [0027](./.adr/0027-the-deputy-is-named-ahead-of-time.md)
and [0028](./.adr/0028-the-standby-door-is-a-second-listener.md); full protocol in
[`PACK_PROTOCOL.md`](./PACK_PROTOCOL.md) §18; runbook in [`DEPLOYMENT.md`](./DEPLOYMENT.md).

### Added

- **ADR 0026 accepted — the operator is the quorum** — no automatic election, promotion is always a deliberate tap (ce25a15)
- **The warrant** — signed, generational proof the lead grants one peer standing to take over; minted, refreshed each healthy sweep, superseded, expired (`bridge/pack/warrant.ts`) (86c4510)
- **The peer learns its lead** — a warranted peer's trust store widens to two anchors (its lead's, and the deputy's own), `409 lead_conflict` names a conflicting lead by generation, a booting lead probes its roster once before publishing (the boot gate), and a deposed lead self-heals into a peer rather than crash-looping (9ef8d6a)
- `collie pack deputy <member>` / `--revoke` — mints the warrant, pushes it to every peer, then arms them by restarting each over the operator's own SSH under ONE consent for the batch; a peer with no SSH record is reported `warrant stored, anchor INACTIVE — restart <member>`, never skipped; a re-run re-syncs rather than re-minting (c00d1d8)
- **The standby door and the takeover** — a second listener (`COLLIE_STANDBY_PORT`) armed only when a verified warrant names this machine and the lead has gone silent past its threshold; the operator's one tap asks the lead, asks the peers, and takes the crown (RFC §6/§7) (a696e94)
- ADRs 0027/0028, the deputy runbook, and the death-of-a-lead story in `PACK_PROTOCOL.md` (de006b8)
- `pack status` renders the whole arming state: the deputy line on a lead, per-member stored/anchored columns, `lead last called me …` and the stored warrant on a peer, a loud DEPOSED banner naming the new lead, and `pack deputy` refuses a lead with no paired device rather than minting a door nobody can open (49fcca3)
- `collie pack set-address <member> <host:port>` — repairs a peer's row after a takeover leaves it undialable; a healed peer now tears down its own `tailscale serve` mapping instead of leaving the old front door black-holed (c7bdc4c)

### Fixed

- **A two-anchored peer resolves its caller by signature, never by the TLS boolean** — with two anchors, an unsigned dial from the deputy resolved as the lead; every lead-to-member dial now carries a signed, receiver-bound attestation, and the deputy's own route reach stays at zero until spec 4 opts it in (15c4fab)
- **The deputy's push was refused as a stamp replay** — the sweep and the verb signed warrant pushes with the same key and raced the replay floor; the push now carries its own signature, and a refused store can no longer be recorded as an anchor (2bab65b)
- **Four bugs from a live drill (bluefin ↔ minibuch)** — a takeover now exits `EX_TEMPFAIL` (75) so `Restart=on-failure` revives the machine instead of stranding it; the takeover spends the designation and stamps it, so the new lead no longer reports the deposed member as its own deputy; a deputy's anchored state is now derived by matching the warrant's named member, not by presence of a certificate alone, so a witness and a deputy stop reading as the same role; the pairing-device sync is now reported and re-pushed on divergence instead of being lost on restart (1630971)
- **The lead accused an armed deputy of being un-armed** — the lead inferred anchoring solely from whether its own `pack deputy` restarted that machine, so a restart done any other way read as `anchor INACTIVE — restart <member>`; the peer now reports `warrantActiveGeneration` on `hello`/`snapshot`, the lead prefers that report over its `pack-ops.json` record and writes a confirmation back, and a `pack deputy` re-run against an already-armed pack asks nothing (986d425)
- **A device revoked on the lead stayed valid at the deputy's standby door** — the pairing sync was refused outright on a label clash, freezing the deputy's copy for ever, so a revoked credential could still spend a takeover; the sync now always lands (its target is a separate hashes-only file, never the deputy's own registry), the clash is reported on `hello`/`snapshot` as a finding while the takeover keeps refusing it, and a `lastSeenAt` stamp can no longer write a revoked device back (d776f62)

## [1.0.0-beta.13] - 2026-08-20

### Added

- Pre-commit pack-wire guard — a wire-shape change must stage `PACK_PROTOCOL.md` or bump `PACK_PROTOCOL_VERSION` ([ADR 0025](./.adr/0025-the-wire-guard-forces-a-decision-never-a-bump.md), bee6e02)
- Pack diagrams — topology, one poll sweep, and "When the lead dies" in `PACK_PROTOCOL.md` (01782c9)

## [1.0.0-beta.12] - 2026-08-20

### Added

- The header's "Collie on tmux" line carries the multiplexer's own mark — adapter-supplied SVG served sandboxed at `/api/mux/logo.svg`, rendered as an `<img>` so adapter markup never becomes document markup (ee90b06)

## [1.0.0-beta.11] - 2026-08-20

### Added

- **Agent beacons (M11)** — on tmux/zellij, agents identify themselves through their own hooks; a beacon is a hint, never a control channel ([ADR 0024](./.adr/0024-a-beacon-is-a-hint-never-a-control-channel.md), 6585658)
- `collie beacon emit` + `collie hooks install|uninstall|status claude` — the Claude emitter (exit 0 unconditionally, silent, env-gated) and the guarded settings installer: marker merge, symlink refusal, one-time backup, self-heal (b17e8c5)
- `withAgentBeacons` — a decorated tmux/zellij pane carries its agent's name, status (`waiting` surfaces as blocked) and session ref; capabilities lift when hooks are installed, scope checks keep a second server's `%7` out (94c9514)
- Pane history on tmux/zellij rides the beacon's session ref through the unmodified journal; `journal-probe.ts` gains a read-only beacon section (c5e406c)
- `collie doctor` gains `beacon-hooks-claude` + `beacons` (warn, never error), and a pane whose foreground command looks like a harness carries one hint sentence — never an identity (cb7eb7b)

## [1.0.0-beta.10] - 2026-08-20

### Added

- The brand header says which multiplexer this collie drives — "Collie on tmux" — from the config's display name, never a name branch (544361f)
- **Peer panes are gzipped on the lead→phone hop again** — as a stream transform over the peer's identity bytes, ETag untouched, `vary` merged; restores the ~20x cellular saving the beta.9 honesty fix gave up ([ADR 0023](./.adr/0023-compression-is-hop-local-on-the-pack-link.md), 44d8de3)

### Fixed

- **The "unreachable" banner flapped on a healthy watched peer** — the phone's staleness tolerance was measured against a receipt only the lead's 12 s idle sweep refreshed; every landed proxied call now stamps the receipt (successes only, monotone), and the UI splits the facts: staleness is a receipt age, "unreachable" and refusal claims gate on `writable` alone, across banner, host chip and switcher (c5e206d)

## [1.0.0-beta.9] - 2026-08-20

### Fixed

- **Peer panes rendered "(no recent output)" in the app** — the lead re-emitted the peer's `Content-Encoding: gzip` over a body Bun had already decompressed, so the browser failed every peer body read (curl ignored the header, which is why shell checks stayed green); the peer hop is now explicitly identity and the header left the proxied list, with a harness test pinning "the headers describe the bytes" (9a17dda)

## [1.0.0-beta.8] - 2026-08-20

### Fixed

- **A cold pack link now bootstraps on a relayed path** — the first data request per link dials on the patient budget (one credit, spent at issue), so a DERP-relayed TLS handshake no longer aborts at the strict per-poll budget and strands the link cold forever; warm requests stay strict ([PACK_PROTOCOL.md §10.5](./PACK_PROTOCOL.md), e2b52ab)
- `collie doctor` / `pack status` / `reconnect` send one real snapshot after `hello` and name an answered-but-starved link instead of reporting green (e2b52ab)
- The `COLLIE_PACK_TIMEOUT_MS` clamp warns at boot, naming the `COLLIE_POLL_MS` value that would honour the requested budget (e2b52ab)

## [1.0.0-beta.7] - 2026-08-20

### Added

- **The mux contract** — one Collie-owned port for everything a multiplexer must answer (`bridge/mux/`), capabilities declared per adapter and never inferred from a name, the evidence matrix in [`MUX_CONTRACT.md`](./MUX_CONTRACT.md) ([ADR 0022](./.adr/0022-the-mux-seam-is-a-port-collie-owns.md), c516cfd)
- **A conformance suite every mux adapter must pass** — 7 read-only + 10 world checks run against every registered adapter by iterating the registry; live layer in `scripts/mux-probe.ts`; contributor doc [`MUX_CONTRIBUTING.md`](./MUX_CONTRIBUTING.md) (2feb1aa)
- **The tmux adapter** — `COLLIE_MUX=tmux` lists, reads (colour preserved) and types into a tmux server; session→space, window→tab; events via read-only control mode with a bounded census backstop (e5f39e1)
- **The zellij adapter** — `COLLIE_MUX=zellij` drives one zellij session; content streams over `zellij subscribe`, topology polls a bounded 3s→12s census; scrollback via `dump-screen --full`, never called history (a56e030)
- **The UI reads capabilities, never a multiplexer name** — the active adapter's declaration rides `GET /api/config`; absent capabilities hide the meaningless and explain the expected in the adapter's own words; `scripts/check-mux-names.sh` keeps mux-name literals out of `web/src` (4d6787f)

### Changed

- **Herdr is now the reference mux adapter** behind the port — every bridge consumer depends on `MuxAdapter`, construction goes through the registry with Herdr the default, no operator-visible change (76a7bab)

## [1.0.0-beta.6] - 2026-08-19

### Added

- **A routine `update` now stays inside its installed major and follows release tags** — a managed checkout resolves the newest `vX.Y.Z` inside its major and detaches onto it; a linked clone keeps its ff-only pull, gated by a pre-flight read of the manifest. Crossing a major needs `update --major`, also wired as the `update-major` plugin action, because a Herdr action has no TTY to prompt on ([ADR 0020](./.adr/0020-a-major-upgrade-is-consented-by-flag.md), fcb48a9)
- The update banner distinguishes a routine release from a pending major, ranked below it so the operator takes what a plain tap can actually deliver first (9c8bee4)
- **`collie link` / `collie unlink` publish the binary on PATH as a symlink, never a copy** — the pointer is never stale because it is never refreshed, and `link`/`unlink` only ever touch a name Collie itself published; `doctor` gains a `path-link` line ([ADR 0021](./.adr/0021-the-path-name-is-a-pointer-never-a-copy.md), 3287194)

### Fixed

- **The linked-clone major gate judged the wrong commit** — it read the manifest at the remote's default branch while `--ff-only` advances the current branch from its own upstream, so a clone on a maintenance branch judged a major it would never actually pull; it now fetches the configured refspec and reads the manifest at `@{u}` (2522d83)

## [1.0.0-beta.5] - 2026-08-18

Adds a lint gate; changes no operator workflow. Reasoning:
[ADR 0019](./.adr/0019-oxlint-and-vendored-anti-slop-are-the-lint-gate.md).

### Added

- **oxlint + the vendored [anti-slop](./tools/oxlint/README.md) plugin are the lint gate** — one root `.oxlintrc.json`, all 15 anti-slop rules plus oxlint's correctness/suspicious/perf catalog at `error`, run with `bun run lint` (80b17d8)
- The gate runs on five surfaces: the editor (`.vscode/`), the agent edit loop (`.claude/hooks/lint-edited-file.sh`, PostToolUse), pre-commit over staged files (`SKIP_LINT_CHECK=1`), `collie build` full-tree (`SKIP_LINT=1`), and CI before typecheck/test — every one shelling out to the same config with no flags of its own (c5862f7, 5299ece, 864a90c, 0f05edf)
- `.adr/0019` records the decision, the one triage pass's rule-by-rule rationale table, and the fix-shapes for the rules you'll trip most; CLAUDE.md gains the rule and lists every `SKIP_*` escape hatch in one place
- The pre-commit hook's version and lint guards are independently skippable — `SKIP_VERSION_CHECK=1` used to exit 0 out of the whole hook (c5862f7)

### Changed

- **TypeScript 7.0.2 on both sides** — zero new diagnostics, no source or tsconfig edits; typecheck drops to ~0.3s root / ~0.6s web. TS7 ships no `tsserver` bin, only `tsc` (258899c)
- **2,851 lint findings paid down to zero by fixing code** — no suppressions, no rule downgrades outside the one triage pass. Boundaries now parse instead of assert: new `bridge/json.ts` / `web/src/lib/json.ts` (`JsonValue`), `web/src/lib/env.ts` (capability probes), `web/src/test/stub.ts` (1373a02..a3159fd)

### Fixed

- **A journal line that is literally `null` threw a `TypeError` out of all four parsers** instead of being skipped like any other unusable line (a6a4fb7)
- **Three bridge write routes answered on a body they only declared** — a non-string `text` reached `pane.send_text`, `submit: 0` meant "type but don't send", and a non-string `workspaceId` threw a `TypeError` out of the handler; each is a 400 now (ad023d6)
- **An unrecognised pairing refusal rendered a blank card** — the failure name was asserted into a union whose exhaustive switch then returned `undefined`; it falls back to the bridge's own copy (324b5c5)

## [1.0.0-beta.4] - 2026-08-18

### Fixed

- **The audit log is size-capped** — a pack refusal is audited before any factor authenticates, so a caller who can reach the listener could grow it without bound; the appender now rotates to `audit.log.1` at 5 MiB, keeping one generation, and a failed rotation still appends (fca76e5)

## [1.0.0-beta.3] - 2026-08-18

Merges `main` 0.31.0 + 0.31.1 into v1 (entries below). v1-specific on top of them:

### Added

- **`push-keys` is a `bin/collie` verb** (`cli/push-keys.ts`, also spelled `collie push keys`) rather than shell in the bootstrap shim — main implemented it in `collie-ctl.sh` because it has no `cli/`; on v1 every verb is implemented once in `cli/` and the shim only delegates (ADR 0006). Behaviour is main's, unchanged: `--force`, subject-only update, symlink refusal, no placeholder subject, mode 600, `wx` temp file
- **`collie push list|forget`** — the orphaned subscriptions already on disk get a surface: one line per row (service host, first-subscribed day, user agent, enough endpoint to retype) and `forget <substring>` / `--all` to drop them; neither goes through `init()`, so both answer with no VAPID keys configured (64fa3b7)
- `scripts/collie-cli.test.sh` drives `push-keys` through the compiled binary — resolved `.env`, mode, the refusal to replace live keys, the subject-only update, `--force`, and the symlinked-`.env` refusal

### Changed

- `AuditLog`'s options object carries v1's pack `defaults` alongside main's `content`, so scoped pack logs and `COLLIE_AUDIT_CONTENT` redaction compose; every call site passes `{ now }` instead of a positional clock
- `/api/config` reports `operatorCommands` through `bridgeConfigBody()`, so the pack `mode` key and the operator's palette rows share one omit-when-empty body
- Drafts' two tiers key off the `(host, session, paneId)` scope, so the memory tier cannot disagree with disk about which pane is which

### Fixed

- **Re-adding an enrolled peer restarts it there** — `pack add` on a member whose checkout is behind replaced the build and then reported the process it had superseded; a run that changed something on the far machine now runs that machine's own `collie restart` and states what the member reports over the pack link afterwards (208d8ca)

## [1.0.0-beta.2] - 2026-08-15

### Added

- **`collie pack update <member>… | --all`** — level peers to the lead's build from the lead: read-only probe of every target, ONE consent question for the whole batch, then per member push the commit, restart, and verify the new version over the pack link; a failure is recorded and the run continues, ending in a table and a non-zero exit. A bare `pack update` is a usage error listing members and versions, a member with no ssh record is skipped with its remedy, a dirty remote checkout is refused, and there is no `--yes` (87efed3)
- The update rides the operator's own SSH and never the pack wire — over-the-wire updating would add the inbound admission surface ADR 0013 rejects and make a compromised lead a human-free code-execution credential on every peer (ADR 0016, 028e9b3)
- **`pack-ops.json`** beside the trust store — member id → the ssh host, remote checkout and port the operator last used, so `pack update` need not be retaught what `pack add` already knew; operator-local convenience data, never a wire field and never a trust-store field, fails closed on a partial read (09bdfde). `pack add` banks the route on a finished run and `pack remove` forgets it (c16d2aa)

### Changed

- Version-skew warnings in `pack status` and `collie doctor` name `collie pack update <member>` with the member ids already in it, instead of "update the older machine"; `PACK_PROTOCOL.md` §7.1's remedy sentence and the README follow (028e9b3)
- `cli/remote.ts`'s legs are three emit-free step runners plus the failure-family helpers, so a second verb can drive them — `pack add` prints exactly what it printed before, in the same order (c16d2aa)

## [1.0.0-beta.1] - 2026-08-15

### Added

- **`COLLIE_PUBLIC_URL` is the front-door address source** — set the real ingress once and every `pack invite` / `pack add` derives it, instead of handing joiners a derived tailnet name a one-way ACL makes undialable; origin only, a bad value warns and falls through, the peer's `pack-listener` address is untouched (a658a45)
- **`doctor`, `status`, `pack status` and `pack add` render with ink on a TTY** — findings table, boxed banner, roster coloured by reachability, a spinner per `pack add` leg; every verb keeps its plain branch, selected by `isTTY && !CI && !--plain` (24dc52f, 62e2ba5, 7c9958b)
- `collie promote` prints the demoted lead's repair steps and lists every remaining member for re-join — the peer sweep could never land through a peer that pins only its current lead (c9a7373, b02d4a8)
- README: the 0.x → 1.0 migration path — one action, one must-do, a rehearsed way back (c70d0bb)

### Changed

- **Commander owns parsing and dispatch**, built from the existing `COMMANDS` table so the usage line cannot drift from the verb list; it never exits or prints on its own — usage errors stay in this CLI's words and the pack exit codes survive (b44b4ac)
- Herdr action titles say "Collie", not "web bridge" — titles only; action ids and command strings stay frozen (ADR 0006, ADR 0012) (827449b)

### Fixed

- **A non-minimal DER serial made 1 certificate mint in 512 unparseable** — the cert minted and fingerprinted but could never be re-parsed, so every pin re-derived from its PEM failed: in a pack that is a member that cannot be pinned, verified or served. Any member enrolled by an affected run must be re-enrolled (`collie pack remove` + a fresh join); `derInteger` now emits the shortest form and the rule is pinned deterministically (d969d16)
- **`COLLIE_INSTANCE` discovers its own conventional config dir and refuses another instance's** — a second instance's pack verb silently read the default instance's trust store and minted a fresh identity into the live one; an injected `HERDR_PLUGIN_CONFIG_DIR` still wins (226f6c7)
- `collie join`'s enrollment dial gets a 15s budget — an unreachable lead used to hang on the OS's TCP patience (5+ minutes observed); the peer's UNREACHABLE branch now names `--address` as the escape hatch (2b553df)
- `pack add`'s git-bundle legs: `create` bundles HEAD rather than a bare sha it refuses, and `verify` runs in a scratch repo under `$WORK` (27ee624, 80b996f)
- The `status` banner probes the bridge's actual bind instead of assuming loopback (bc49a99)
- `collie build` runs on a bare checkout again — commander is lazy-loaded (4d3cedd); `pack add` renders plain where ink would not fit (cb54208) and surfaces the install leg's own error line (7803169)
- The lead's own roster entry is a machine label, not the pack name (93a631a); the standalone machine chip above the composer input is gone (559183a)
- A composer test's stall no longer outlives its test and lands in the next one (09241a9)

## [1.0.0-alpha.16] - 2026-08-13

### Added

- **Device pairing** — `collie pair` mints a one-time code, the phone spends it in Settings for a bearer token, and from then on every write needs it; enforced exactly while at least one device is paired, so an install that pairs nothing is unchanged (506be94)
- `collie devices list` / `collie devices revoke <label>` — revocation lands on the running service without a restart (506be94)
- `POST /api/pair`, `GET /api/devices`, `POST /api/devices/revoke`, and a paired-devices section in Settings (506be94)

### Changed

- A write refused for want of pairing answers `403 device not paired`, distinct from the header gate's `device not authorised`; the two gates stay independent and compose by AND (506be94)
- Audit lines and the snapshot's `device` field prefer the pairing label over the proxy-asserted header name (506be94)

## [1.0.0-alpha.15] - 2026-08-12

### Fixed

- A hand-typed `collie join` on a default-configured peer no longer records a portless callback address the lead would dial forever at :443 — a derived pack-listener address now always carries this instance's own port; lead/front-door addresses and explicit `--address` values are untouched, and records minted before the fix are repaired with `collie reconnect` (7b7fb62)

### Changed

- Docs retire "bridge" as vocabulary for the instance — "a collie" is the participant, "bridge" stays the component (ADR 0012's landing rule) (4eb36cb)

## [1.0.0-alpha.14] - 2026-08-12

### Added

- **`collie pack add <ssh-host>`** — probe, install, configure, enroll a peer over one multiplexed SSH connection (ADR 0015): pushes the lead's own commit as a `git bundle`, writes the peer's bind from a value read off that machine, and pipes the invite token over stdin only; the last line reports whether the member is non-provisional after first contact (c5a810f)

## [1.0.0-alpha.13] - 2026-08-12

### Added

- **`collie doctor`** — one read-only pass over the traps that fail silently: bind/ACL/front-door/web-dist/herdr-socket/clock locally, drift/rotation/reachability/version-skew in a pack; every finding names the fixing verb, warnings exit 0, `--json` for scripts (8590086)
- A member probe's success now carries the far side's HTTP `Date` (transport metadata, not a wire field) — doctor's clock check reads it against §8.6's ±5m signature window (765c44a)

## [1.0.0-alpha.12] - 2026-08-12

### Added

- **Version-skew policy (§7.1, closes §17's last open item)** — `hello`'s response carries the answering build's version (optional, additive; absent = pre-amendment, rendered honestly); `pack status` shows each member's version and warns on skew naming both versions and the remedy; the protocol integer alone refuses — build skew never does (0119635, 9c9ae3b)
- `bridge/version.ts` — one version resolver shared by CLI and bridge (bare string on the wire, printed form for humans), threaded into the pack router once at boot (9c9ae3b)

### Changed

- Docs teach `bin/collie <verb>` as the operator spelling; `collie-ctl.sh` survives as the bootstrap shim it now is, explained once (27aee0f)
- ADR 0015 — `pack add` will push the lead's own commit over the operator's SSH (own transport, git bundle, no new wire surface); spec groundwork, no behavior yet (322448c)

## [1.0.0-alpha.11] - 2026-08-11

### Added

- `collie qr` — the QR verb is now in the binary, with the tailnet-ACL probe it needs; `collie-ctl.sh qr` keeps working via delegation (cb1c4c5)

### Changed

- **M6/01** — `scripts/collie-ctl.sh` is now a 106-line bootstrap shim: it resolves Bun, builds `bin/collie` from source when absent, and execs it — the CLI is the single implementation of every lifecycle verb. Manifest command strings, action ids and every `collie-ctl.sh <verb>` spelling are byte-identical (frozen per ADR 0006), so nothing operator-facing changes; the script's ignorance of `COLLIE_INSTANCE` goes away with the duplicated logic (cfc09d5, 8268659)
- The shim no longer sources `.env` for Bun resolution — a `BUN_INSTALL` set only there must move to the environment; the CLI still reads `.env` for everything else (cfc09d5)

## [1.0.0-alpha.10] - 2026-08-11

### Security

- **F2 closed** — the lead demotes only against a live operator approval minted on itself: `collie pack approve-promote <member>` (ten minutes, single-use, `--cancel`, restarts the bridge so the running process holds it); an unapproved `POST /pack/v1/lead` gets an honest 403 (`handover_not_approved`), byte-identical whoever is approved, and the demotion additionally requires the claim's fingerprint to match the pinned member's so consent binds the certificate, not just the id (5667c8f)
- **F2** — `collie promote` now surfaces the lead's refusal verbatim and exits without suggesting `--force`; a refusal is proof the lead is reachable, and `--force` stays reserved for a machine known gone (5667c8f)
- **F2 spec** — ADR 0014 + `PACK_PROTOCOL.md` §14 rewrite (promotion is a confirm on the receiver); the peer-side signed handover is relocated to §16 reserved — a peer pins exactly its lead, so the branch it would guard is transport-unreachable in v1 (7fa92f9)

### Added

- `pendingHandover` trust-store field (optional, absent = no live approval, fail-closed; `TRUST_STORE_VERSION` stays 1) and a `pack status` line showing a live approval and its remaining window (f232b1f, 5667c8f)

## [1.0.0-alpha.9] - 2026-08-10

### Security

- **F5** — `collie join` refuses an `http://` lead address unless `--insecure` is passed: over a plaintext hop the token and pack secret cross in the clear, and an on-path attacker who reads the token can self-enroll its own certificate before the honest joiner (the lead admits on the token alone). **Breaking:** an http:// join that used to work now needs `--insecure` to own the trusted-hop assumption (6883ae8)
- **F5** — `PACK_PROTOCOL.md` §8.2/§8.5 corrected: F1's fingerprint pin authenticates the lead to the joiner but does not defend the lead against a token-thief on a plaintext hop (6883ae8)

### Added

- `pack status` flags a never-contacted (provisional) member — an enrolled member the lead has never once reached looks exactly like a half-finished join; it says so and points at `pack remove`, cleared on first successful contact (a976cc7)

### Changed

- `pack rotate` warns it has no grace window — a peer offline at rotation misses the pickup and drops to an `unenrolled` tombstone that must re-join; `pack rotate` is the leaked-secret remedy, at that cost (6883ae8)

## [1.0.0-alpha.8] - 2026-08-08

### Security

- **F2** — `PACK_PROTOCOL.md` §8.5 threat model corrected: a compromised peer can issue a consent-free `POST /pack/v1/lead` self-claim that denies the pack and, after the old lead's next restart, drives the *former lead's* terminals — beyond the "its own machine's terminals" the doc claimed; containment (per-member pinning) and the deferred mitigation (promote-as-confirm) stated honestly; no behavior change (6e06744)
- **F2** — added a `bun test` canary (`bridge/pack/harness.test.ts`) that asserts Bun 1.3.14 still cannot read a presented client certificate per request and that `server.reload({tls})` cannot re-pin live — it fails loudly when either premise breaks, cueing dismantling of `transportPinned` / signing.ts / §8.6 (6e06744)
- **F2** — cross-referenced the "roster of one → boolean attestation" assumption from ADR 0012 into `transport.ts`/§8.6, and noted two inert v2 hazards in comments: the signed string binds neither receiver nor pack id (signing.ts), and the signedAt admission-read vs floor-commit TOCTOU (router.ts) (6e06744)

## [1.0.0-alpha.7] - 2026-08-08

### Fixed

- **F3** — `PACK_PROTOCOL.md` §3 no longer claims a peer binds "loopback plus exactly the join address, no `0.0.0.0`" (never implemented, not expressible — `Bun.serve` takes one hostname): the pack listener binds `COLLIE_HOST` and the operator owns that bind; a peer on a wildcard bind (`0.0.0.0`/`::`/empty) now emits a loud startup warning, and `collie pack status` shows the resolved bind — the two-factor gate is unchanged, only who may attempt it (ADR 0013 amended) (bb7450b)

## [1.0.0-alpha.6] - 2026-08-08

### Security

- **F1** — the enrollment invite now carries the lead's certificate fingerprint (`<token>.<lead-fingerprint>`); `join` sends only the token on the wire but refuses a lead whose certificate does not match the invited fingerprint, and fails closed on an old-format token — closing the MITM/relay on the enrollment path where nothing authenticated the lead to the joiner (ff595ba)

## [1.0.0-alpha.5] - 2026-08-08

### Security

- **F4** — an unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store (private key + pack secret) or appends a spend audit line when the token spends nothing; a no-op `consumeInvite` now returns `null`, while an expiry sweep still persists, and both refuse identically (43b9a17)

## [1.0.0-alpha.4] - 2026-08-07

> v1 integration line. M5 complete: the phone knows about servers. First real pack live (bluefin lead + minibuch peer).

### Added

- **Prerelease bar** — ALPHA/BETA/RC badge on the header, auto from the build version, sky-toned (82657ac, 35a5fbb)
- **COLLIE_INSTANCE side-by-side knob** + enrollment/demotion staleness surfaced in pack status (d593bfc)
- **Host dimension in the web app** — ?h= addressing, (host,session,paneId) cache keys, widened draft keys (5b134c3)
- **Server view** — switcher, host chips on rows/pane/Send, packed dashboard, honest staleness (c47eb15)
- **Two-tier connection health** — per-host live/stale/unknown against the lead's clock; stale panes keep last-good mirror, writes gate with the host named (5d076b3)
- **Host-scoped notification taps + /pack/v1 SW denylist**; unreachable servers navigate to last-good instead of disabled rows (68b093b)

### Fixed

- cli/pack.test.ts flake: test harness raced a real pack timeout against synchronous fakes (5d076b3)

### Known gaps (bridge follow-ups tracked)

- Peer listener binds COLLIE_HOST only (ADR 0013 loopback+join-address bind unimplemented; workaround: COLLIE_HOST=<tailnet IP>)
- A join exiting unreachable can half-enroll (spent token + ghost member on the lead); scheme-less lead addresses fail to dial

## [1.0.0-alpha.3] - 2026-08-07

> v1 integration line. M4 complete: the pack federation engine, end to end.

### Added

- **Instance modes + pack config** — solo/lead/peer derived from enrollment alone; conflict fails toward peer (1db562b)
- **Trust store, enrollment, two-factor admission** — hashed spend-once invites, uniform 401, version negotiation behind the gate (9f5d91e)
- **Lead-side peer client + registry** — verdict classification, clamped timeout budget, last-good state that never vanishes (42cf66a)
- **Merged snapshot + peer sweep on the existing poll** — host-tagged sessions, no second timer, host addressing mounted (67a0682, 58a5c7d)
- **Byte-for-byte per-pane proxy + forwarded writes** — ETag/304 fidelity, refuse-before-attempt, unknown-outcome discipline, dual-sided audit (72b28ad)
- **Push convergence** — the lead notifies for the whole pack; peers mute, alerts resume on leave (c36c4e0)
- **Pack operator verbs** — invite/join/leave/status/rotate/remove/promote/reconnect with role checks and stdin-only secrets (4e91dd7)
- **Real mTLS pinning + signed membership + two-instance e2e harness** — in-repo certificate minting, handshake-enforced pins, ECDSA-signed membership routes, 32 live assertions (f7cdf59)

### Known gaps (tracked for the next spec)

- The lead needs a restart after its first enrollment before it starts merging; promote does not restart the demoted machine (f7cdf59)

## [1.0.0-alpha.2] - 2026-08-07

> v1 integration line. M3 complete: the `collie` CLI fully absorbs `collie-ctl.sh`.

### Added

- **`collie` CLI skeleton** — compiled binary (`bun run build:cli`), verb table, env-stripped context/tool resolution; compile-safe root anchoring replaces `import.meta.dir` (95653a8)
- **Native lifecycle verbs** — start/stop/restart/status/url/logs, `_exec-bridge` as the unit's ExecStart, COLLIE_SUPERVISOR test seam (76b5be9)
- **Native front door + uninstall** — serve/unserve with the managed-handler ownership record (ADR 0001), uninstall (6883255)
- **Native build/update/push-test** — dual atomic swap (binary + dist), ADR 0006 two-shape update re-execing the fetched source, in-process push-test (e2f00e6)

### Changed

- Root `bun run build` now runs the version gate; `collie-ctl.sh` remains intact as fallback (shim-vs-delete deferred to M6) (e2f00e6)

## [1.0.0-alpha.1] - 2026-08-07

> **`1.0.0-alpha.x` is the v1 integration line, not a shipping release.** `0.24.2` remains the
> released line for operators; nothing here changes a running deployment's behaviour.

### Added

- **Pack federation protocol contract** — `PACK_PROTOCOL.md` (wire contract, trust model, solo
  zero-tax §11) plus ADRs 0011–0013 (5ad3173)
- **Solo zero-tax characterization baseline** — `bridge/solo-baseline.test.ts` + committed goldens
  pin today's snapshot bytes, ETag, routes, config/env keys, `<stateDir>` file set, notification tags
  and audit lines before any federation code exists (cebb5df)
- **Client half of the baseline** — `web/src/lib/solo-baseline.test.ts` pins the mirrored wire types (cebb5df)
  and that a solo client emits no host param

### Fixed

- **`PACK_PROTOCOL.md` §11's files-written row omitted `update-state.json`** — the baseline found it;
  the row now lists the real set

## [0.36.0] - 2026-08-28

### Added

- **AGY (Antigravity CLI) first-class harness adapter** — `ask_question` menus, permission, plan and trust dialogs lifted into native buttons, the boxed composer stripped with its status row re-surfaced, a slash-command palette and the brand icon — thanks @Kryvonis (#99) (b9a14e2)
- **Codex: a large send is verified through `[Pasted Content N chars]`** — the exact character count is the evidence Enter waits for, per ADR 0010 — thanks @memset0 (#132) (1b76371)

### Fixed

- **Sign-in banner instead of "Can't reach Collie" behind a forward-auth proxy** — an expired session answered with a 3xx is read as a 401, and Authentik's `/outpost.goauthentik.io/` start/callback paths bypass the PWA cache — thanks @lekoOwO (#130) (e59135e)
- **Codex CLI 0.150.1 is recognised again, on both of its status rows** — the `Context`-bearing shape with `Context` directly after the model (thanks @fbserg, #134, 75a865a), and the two-field default that carries no `Context` field at all, now keyed on the row's renderer paint (dim ` · ` separators between coloured fields) and never on field names (ddf7272); pinned by five byte-faithful 0.150.1 captures (52cf214)
- **Codex: destructive writes bind to the whole wrapped draft**, not only the first `›` row — a message that wraps past the bridge's tail window no longer 409s every pre-clear sweep — thanks @memset0 (#132) (35a5e33)
- **Codex: the dim `Ask Codex to do anything` placeholder is empty; the same words typed are a draft** — thanks @memset0 (#132) (d3a0c53)
- **AGY: a bare `>` transcript row is never taken for the composer** — only the boxed composer counts, so an echoed message cannot authorise a reply into a running turn (530057f)

### Known limits

- Codex keeps only the first 1,024 characters of one send: a longer message shows as `[Pasted Content 1024 chars]` and the guard refuses to press Enter rather than submit a cut message. Herdr delivers every byte (probe in `HERDR_API.md`, b227ba5), so the limit is Codex's own, and a send is never chunked (ADR 0010)
- While a Codex turn runs, the composer paints a `»` marker the adapter does not yet recognise, so a mid-turn reply is refused, never mis-sent; a byte-faithful capture of that state is wanted (see the #132 thread)

## [0.35.0] - 2026-08-26

**BREAKING — read before updating.**

- `COLLIE_PUBLIC_HOSTS` is now **required** on every reverse-proxy or tunnel install (Variant C/E) — Host validation fails closed.
- With `COLLIE_TRUSTED_USER` set, a request carrying no `Tailscale-User-Login` is now rejected; tagged nodes used to pass.
- A non-loopback `COLLIE_HOST` refuses to start.
- Opt-outs, one per gate: `COLLIE_ALLOW_ANY_HOST=1`, `COLLIE_TRUSTED_USER_OPTIONAL=1`, `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`.

### Added

- **`quick-replies.toml`: your own Quick-dock groups** (title + items + optional `scope`), live-reloaded, replacing the shipped phrases on the panes they address per ADR 0018, shell panes reachable via `scope = "shell"` (0296391) — thanks @fucx (#131)

### Changed

- Host-header validation is on by default and fails closed; `collie-ctl.sh` injects the tailnet name and IPs, `COLLIE_ALLOW_ANY_HOST=1` opts out (b0f6711) — thanks @bartholomewtj (#129)
- `COLLIE_TRUSTED_USER` rejects a missing `Tailscale-User-Login` as well as a mismatch; `COLLIE_TRUSTED_USER_OPTIONAL=1` restores the old pass (b0f6711)
- A non-loopback `COLLIE_HOST` refuses to start unless `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`; non-loopback TCP peers are rejected (b0f6711)

### Fixed

- Uploads are typed by magic bytes, not the client-supplied Content-Type — `__proto__` and `constructor` used to pass the MIME lookup (b0f6711)
- `collie-ctl.sh` parses `.env` as key=value instead of sourcing it — a `.env` with `$(…)` or backticks ran as the operator on every verb; an unquoted trailing `# comment` is now stripped (b0f6711, 743218f)
- An unversioned managed checkout pins `update` to the newest release tag, never origin HEAD (b0f6711, 4440c05)
- A failed `tailscale status` no longer writes an empty host allowlist into the unit — the unit keeps the hosts it had, and says so (743218f)

## [0.34.0] - 2026-08-24

### Added

- `COLLIE_SERVE_PORT`: publish the https front door on a chosen tailnet port — several Collies per host (#98) (f008b75)

## [0.33.0] - 2026-08-24

### Added

- **Codex CLI first-class harness adapter** — boxless composer chrome stripped with the status row re-surfaced, folder-trust prompt, exec approvals and `request_user_input` question cards lifted into native buttons (by @kennymcavoy) (801c5a3)
- **Grok Build first-class harness adapter** — composer chrome stripped with the status strip re-surfaced, permission cards, `ask_user_question` radios/wizards and plan approval lifted into native buttons, plus a Grok session-journal adapter (by @kennymcavoy) (6f6b9e5)

### Fixed

- **omp replies no longer stall on an inline completion suggestion** — the ghost omp paints after the typed text is dropped from the draft the send guard verifies (by @enieuwy) (024a63b)
- **Codex adapter review fixes** — drafts wrapping past 8 rows keep the composer, and the persistent "don't ask again" approval row stays visible in the mirror (375f5b1)
- **`journal-probe` checks each root on its own** — a populated healthy root can no longer hide a broken sibling (by @kennymcavoy) (12b65e6)

## [0.32.1] - 2026-08-23

### Fixed

- **`url` (and `status`/`qr`) honour `COLLIE_PUBLIC_URL`** instead of always inferring the bare tailnet name with no port (#122) (d4e7380)

## [0.32.0] - 2026-08-19

### Added

- **F1–F12 in the Keys tray, behind an "F keys" disclosure** — chords with armed modifiers included (#119 by @martin-tahli) (f3d5845)
- **`keys.toml`: your own Keys-tray preset rows** (label + chords + optional `danger`), live-reloaded, replacing the shipped presets on the panes they address per ADR 0018 (a22da1a)
- **The update gate (ADR 0020)**: a routine `update` follows release tags within the installed major; crossing a major takes explicit consent — `update --major`, wired as the `update-major` plugin action (1b7ccfb)
- **The update banner says which kind of behind you are** — an in-major release, or a pending new major with the consent command (ce9dcd8)

### Fixed

- **A cold boot with no network renders the cached last screen**, dated "last seen HH:MM" — never a false "No agents" (0f4c651, c473aa0)
- **A stale pane mirror is dated by its own stamp, not the herd's** (20cc1e1)
- **The linked-clone major gate judges the branch's own upstream (`@{u}`), not the remote default branch** (142d2aa)

## [0.31.1] - 2026-08-18

### Fixed

- **A long request survives socket backpressure** — Bun's socket accepts fewer bytes than it is handed under pressure and queues nothing; the dialer now parks the tail and resumes from `drain`, so a big request can no longer silently truncate and die on the timeout (55274e7). Probed while fixing: herdr drops any request line of 1 MiB or more — now in `HERDR_API.md`

### Changed

- In-code pointers name `DEPLOYMENT.md` now that variants B–E live there (ab182f7); `COLLIE_MULTI_SESSION` spelled `on`/`off` everywhere; `push-keys`/`push-test` listed in the Commands table (6948a0f)

## [0.31.0] - 2026-08-18

### Added

- **`push-keys` generates the VAPID keypair and writes it into the right `.env`** — Web Push setup is now three plugin actions (`push-keys` → `restart` → subscribe), no manual key wrangling (84abe28)
- **"Tap to type" can be turned off** — a display setting stops the mirror volunteering the keyboard on a tap; on by default (1fbba59)
- **`COLLIE_AUDIT_CONTENT=none` keeps the audit trail and drops the bodies** — a fail-closed allowlist keeps action parameters legible while anything operator- or screen-originated redacts (#107, 5dda876, cdad445) — thanks @shuangwangnyc
- **Your own slash commands in the palette, declared in `commands.toml`** — on a pane your rows address they replace the shipped catalog (ADR 0018); `confirm = true` adds a two-tap; edits are live, no restart (#109, 35da673, 28bdf5a) — thanks @enieuwy

### Fixed

- **⚠ A paste too big to persist no longer restores an older, shorter draft after a remount** — oversize drafts now ride an in-memory tier whole, never truncated and never swapped for stale text; they survive pane switches but not closing the app, and the composer says so (7830c80)
- **A half-arrived long send is no longer accepted as send evidence** — when the input box ends in literal text it must be the end of what was sent, or the guard refuses to press Enter (#110, 27f4cdf)
- **Direct typing no longer owes a "mode stopped" notice to the next pane**, and the blur it schedules is settled by cancellation instead of racing a re-arm (#108, 452da20, 1a2ca49) — thanks @enieuwy

### Changed

- **README cut to ~60% of its length, how-first** — deployment variants B–E now live in `DEPLOYMENT.md`, and troubleshooting entries are findable by the words you'd actually search (9464c14, c52d4af)

## [0.30.0] - 2026-08-16

### Added

- **A password prompt says what it is and offers the control that works.** `sudo`, an SSH passphrase and `gpg` echo nothing, so Send's verification can never arrive — the refusal now names that and hands off to **Type** in one tap, instead of "a menu or dialog is probably up" (#103, 1334540)

### Fixed

- **A password typed into the composer is no longer kept for 48 hours** — recognising the prompt drops the stored draft and stops persisting keystrokes; the write-through had stored it before any send was attempted (#103, 1334540)

## [0.29.0] - 2026-08-16

### Added

- **The plan dialog's feedback row has a route from the phone.** Row 3/4 is a text input, not an option: Collie now models it, locks the other buttons while the terminal owns it, and sends feedback through the guarded choreography — digit, verified paste, bound Enter (#95, c0ce09e, 967e94d, 64de1d4) — thanks @navidkashani
- **A pane is named by what its process says it is doing** — its OSC title, glyph-stripped and dropped when it only repeats the agent or project — so a project's herd stops reading as N identical rows (#100, 9dbc0fe) — thanks @praneetrohida

### Fixed

- **A long plan-feedback value re-flows across lines instead of windowing** — the value is rebuilt from continuation lines and the footer gap widened, so a 355-char value no longer makes the whole dialog vanish (#95, 64de1d4)
- **A shell's `user@host:cwd` title is a locator, not a name** — it no longer replaces the row's cwd with a longer restatement of it (#100, 982b8e1)
- **A push re-subscribe replaces the row it supersedes**, and each row records when and from which browser it was made — Apple keeps answering 201 for an orphaned endpoint, so this is what stops `push-subscriptions.json` growing forever (#104, 0021300)

## [0.28.0] - 2026-08-12

### Added

- **omp gets a harness adapter (Tier 1)** — read-only blocks by construction, its own composer chrome stripped, a slash palette sourced from its captures — a reply stops confirming its pickers (#93, b98b90d) — thanks @qaz74107410
- **Every `COLLIE_*_ROOT` (including `COLLIE_TRANSCRIPT_ROOT`) takes a comma-separated list**, so pane history works across multiple `CLAUDE_CONFIG_DIR` profiles (#92, b549101)
- **`contrib/windows/`** — a community-maintained Task Scheduler lifecycle for Windows (#71, 8572e49) — thanks @Pimpmuckl

### Fixed

- **Update-available pushes to Apple devices never arrived — broken since 0.11.0.** The Web Push topic was an impossible base64 length and APNs refused it; herd alerts were unaffected (#90, 19572d7) — thanks @ojulean
- **The destructive pre-clear sweep now fires only after a live read positively sees the composer**, bound to the prompt it saw — a dialog opening in the gap can no longer eat the burst (#93, 6c8332f)

## [0.27.0] - 2026-08-10

### Added

- **`collie-ctl.sh qr` prints the tailnet URL as a scannable code**, so a phone doesn't have to type a MagicDNS name — opt-in as its own subcommand, since a PWA only needs the URL once. Corrects two defects in the renderer it uses: its filled glyph is a *light* module, so the compact output inverts on a light terminal, and its quiet zone is 1–2 modules where the spec asks 4 (#88, ff84538) — thanks @adrgarcha
- **`start` and `status` say when this node's packet filter admits no peer**, instead of printing the tailnet URL under a green ✓ that no other device can open — the local probe only ever sees loopback, which never touches the filter. Best-effort and deliberately unsure: it speaks up only on a total deny, and stays silent whenever it can't tell (#87, 82bbe0e) — thanks @adrgarcha

### Fixed

- **Idle Claude panes no longer scroll up and snap back on every poll** — the session-name sniffer read `recent`, which on a pane shorter than the read makes Herdr scroll a full-screen agent to reach the rows above it; it reads the visible grid now (#85, dab122e) — thanks @OowhitecatoO
- **A lapsed session behind a redirecting identity proxy shows the Sign-in banner** rather than "can't reach Collie" — API requests now carry `X-Requested-With`, so a proxy answers 401 instead of a 302 that `fetch` follows into an opaque CORS failure with no status to classify (#86, 0dc852e) — thanks @ojulean

## [0.26.0] - 2026-08-10

### Added

- **Type into terminal** — a toggle beside Keys in the Controls row sends what you type straight to the pane as keystrokes, no trailing Enter, so a TUI that wants bare letters (`b`, `q`) can be driven from a phone. Ordered and batched, so a slow tailnet grows the next batch instead of scrambling characters; it never survives a pane switch, a lock, a hidden page or a failed batch (#74, 7dea503) — thanks @aspiers
- **GFM tables render as tables** in Conversation history instead of collapsing into one run-on paragraph — recognised by their delimiter row, alignment and ragged rows included. A table nested in a list or blockquote still collapses: the block parser is flat, and agents put tables at the top level (#72, d82ef1b)
- **Nerd Font symbol glyphs stop rendering as tofu** — two subset woff2 faces ship with the app, fetched only when a pane actually paints a private-use glyph (`unicode-range`) and deliberately kept out of the precache (#70, d31d97d)
- **A quick Ctrl+C in the nav tray's Esc/Up gap** — one tap, without opening Presets (#75, d139b1b) — thanks @Jarva

### Changed

- **A long terminal rule clips at the mirror edge** instead of wrapping into several rows; its full text stays in the DOM, and ordinary output keeps wrapping normally (#79, 4480019) — thanks @en-ver
- **The composer row reads its own state** — an open dock or an armed mode carries a light-sky tint instead of a grey surface, the attach button moves inside the text field, and the "Controls" tag floats above the row so four labelled toggles fit a 390px phone unclipped (5f9d5ee)

### Fixed

- **Sends stalled on a narrow pane with "Message didn't reach the input box"** — the guard located Claude's input box by a run of 20 rule glyphs, which is a hidden assumption that the pane is at least 20 columns wide; it now measures display cells, and the wrapped-draft scan reaches past a long CJK draft (#76, de88b38) — thanks @tyamanak
- **The ctl test suite re-initialised the repository it was run from** — git exports `GIT_DIR` into hooks, which overrides discovery for every git command including `-C`, so the sandbox's `git init` landed on the developer's own checkout (d12b522)
- **The ctl suite failed on a Homebrew Mac** — `resolve_bun`'s absolute-path fallback escaped the sandbox PATH and brought the real `tailscale` back with it, defeating the missing-CLI case (b9cf620) — thanks @tyamanak

## [0.25.0] - 2026-08-07

### Added

- **A subscription that keeps failing is retired** after 5 consecutive failures, so stale duplicates (PWA reinstalls) stop accumulating and re-logging every cycle — counted only when a sibling on the same push service succeeded that round, so a service-wide rejection never costs a live device (#68, dcc4f48) — thanks @alshedivat

### Fixed

- **Push failures log the status and the service's reason** instead of web-push's constant "Received unexpected response code", which named neither (dcc4f48)

## [0.24.2] - 2026-08-06

### Fixed

- **A wrapped CJK reply stalled unsubmitted** — the input box folds its wrapped lines with a space, fabricating one the send never had (CJK has no spaces to wrap at), so the guard's slice check could never match; each seam is now judged on its own, and only a gap the fold itself could have made is loosened (#66, 6def208) — thanks @tyamanak
- **The guard feature-detects `Intl.Segmenter`** and falls back to code points, so an engine without it (Firefox < 125, Safari < 14.1) loses grapheme precision instead of white-screening the app at boot (1a37e29)

## [0.24.1] - 2026-08-06

### Fixed

- **Long/multi-line replies to Claude panes stalled unrecoverably** — the send guard now reads Claude's `[Pasted text #N +M lines]` placeholder as send evidence when consistent with the sent message (ADR 0010) (29bca11)
- **Stranded-draft preview withdraws "Take over" when the line holds only Claude's paste placeholder** (29bca11)

## [0.24.0] - 2026-08-05

### Added

- **Buttons for Claude's `/model` picker, and any modal like it** — a last-resort grammar reads the footer's `<key> to <verb>` hints and renders them, with the arrows the screen advertised, over the mirrored region (dfff364)
- **The ←/→ pair says what it adjusts** — the picker's live value ("◐ Medium effort") sits between the arrows and in their accessible names (4d23e63)
- **A send is refused before it types when the agent's input box isn't on screen** — the draft is kept, and a second Send is a deliberate "Type anyway?" that still never fires the submit key blind (bf7ea38)

### Fixed

- **A half-written reply survives leaving the pane** — drafts are kept per pane (48h, localStorage, so an OS-killed PWA doesn't lose one) instead of dying with the composer when you step over to another tab (50dccc0)
- **A reply is no longer typed into a full-screen picker** — the original `/model` bug: no grammar claimed the screen, so the message fed the picker and came back "stalled" (bf7ea38, dfff364)
- **The stalled message says a key answer probably landed** — the part that made the original report confusing (bf7ea38)

### Changed

- **Modal menus are a documented harness contract** — the model and its footer/key grammar are harness-neutral, so a future codex/pi/opencode adapter implements them from types plus a conformance leg, not from Claude's internals (a3e0820)
- **A generically-detected menu never synthesises a digit** — in the `/model` picker a digit confirms *and* saves your default for new sessions; [ADR 0009](.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) records why (dfff364)
- **Every dialog model is a harness contract, not a Claude internal** — the prompt-select, wizard, preview and multi-select payloads join menus in harness-neutral modules, so the AST and the renderers no longer point at one agent's grammar (a7d45f4)
- **One race guard for every dialog, run through the pane's own adapter** — no more re-deriving through Claude's detectors; an adapter that emits a block kind gets the guard for free, and no adapter fails closed (211cd07)
- **The conformance suite pins the signature + identity contract for every block kind** — not just menus: a constant signature, or a comparator that passes a screen that changed, now fails CI (3385193)

## [0.23.3] - 2026-08-04

### Fixed

- **The idle lock no longer ambushes you on the way back in** — a hidden page never locks and returning to the foreground auto-resumes, so it can only appear when Collie is left open, visible and untouched (799ece0)
- **A pause no longer eats an in-progress reply** — the cover sits over a still-mounted router instead of replacing it, so draft, scroll position and open sheets survive it (799ece0)
- **Resuming shows the catch-up instead of handing back a frozen screen** — the cover holds through the refetch, badge swapped for the gallop, and releases when it settles (c7430a7)

### Changed

- **The lock screen is glass, marked, and honestly worded** — the herd stays legible underneath, the Collie mark says whose screen it is, and there's no lock glyph or "for safety": it gates nothing, and [ADR 0007](.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md) records why (799ece0, c7430a7)
- **`ARCHITECTURE.md` no longer lists the idle timeout as a security measure** — it never implemented one (799ece0)

## [0.23.2] - 2026-08-04

### Fixed

- **Agent alerts now send at high urgency** — at web-push's default (`normal`) Android was free to defer them by Doze / App Standby bucket, so pushes were accepted by FCM and never delivered (90e42af)

## [0.23.1] - 2026-08-03

### Fixed

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

### Added

- **Every key press and quick reply now answers you.** A nav-tray press was silent on success and deferred to a mirror that can be ~2s behind, so tapping Enter felt like nothing happened; the pressed button now fills on the tap (synchronous, no network wait) and shows a ✓ once the bridge accepts it. Quick replies echo on the tapped button and the dock outlives the send, closing after the ✓ instead of on the tap (79682b5)
- **Hold an arrow key to repeat it** — driving a long TUI menu no longer means tapping ↓ fifteen times. Repeats accumulate locally and flush as one batched `send_keys` array with exactly one call in flight, because ordering across two concurrent one-shot RPCs is unguaranteed. Arrows only, by whitelist; a hold while composing stages one chip, not fifteen (df40373)
- **Haptics** — a short buzz on press, toggleable in Settings, silently absent where the platform has no `vibrate` (df40373)
- **Quick replies follow the pane kind:** a shell gets `y`/`n` instead of "commit and push" and "skip", which mean nothing at a bash prompt (df40373)

### Changed

- **The pane's two control rows are now one.** Wrap, raw terminal and text size moved behind a ⚙ into a labelled panel — the raw-terminal escape hatch had been a bare `>_` glyph whose only explanation was a `title` attribute no phone ever shows, and it now says what it does. Find moved to the header, where its find bar already takes over the row. The mirror gets ~85px back (79682b5) — general direction from @simonallfrey in #49, whose "consolidate the terminal toolbar" proposal is what started this; thank you
- Closing the Keys dock on a composed key queue takes a second tap. The queue is still discarded rather than persisted — one surviving into a later open would let Send fire yesterday's chord into today's TUI state — and the guard sits on the drawer transition, since the Keys toggle and the Quick/Agent/Display buttons unmount the tray just as effectively as the ✕ (df40373)
- A single key press revalidates on the leading edge instead of sitting out the full 300ms burst window before its refetch even started; bursts still coalesce into one trailing refetch (79682b5)

## [0.22.0] - 2026-08-03

### Added

- **OpenCode panes get Conversation history.** OpenCode ≥1.x keeps every session in one SQLite database (no per-session log), so its journal adapter reads `opencode.db` readonly with bound parameters, touches only the three transcript tables (the same file holds auth tokens), and serves all sessions through a per-session cache key. Needs `herdr integration install opencode` once, then restart OpenCode in the pane (#61, 539cdf4) — reported by @xabilarra
- **A multiselect question inside a wizard is now a tappable dialog**, not raw terminal text. It was owned by no grammar — wizards refuse checkboxes (a wizard digit selects *and* advances; a checkbox digit only toggles) and multi-select only knew the single-question form. It now carries the wizard's step chips, navigates with the wizard's own Left/Right keys, and reads the advance row's label ("Next" / "Submit") from the pane by position, never by assumption (#51, bdf4c26) — thanks @konpyl

### Fixed

- **A preview dialog whose option label wraps no longer falls to the raw mirror.** The grammar required numbered rows on consecutive lines, but the ~30-column gutter wraps longer labels onto continuation rows; a contiguity walk anchored on the label column replaces adjacency (#51, bdf4c26) — thanks @konpyl
- `ReadSource`'s unwrapped variant matches the wire: `recent_unwrapped`, snake_case — the kebab spelling was rejected by Herdr and nothing had ever called it. HERDR_API.md records the probed contract, including that the source is a byte-identical no-op for Claude panes (alt screen + renderer-hard-wrapped prose), which is what closed #53 part 2 by measurement (45cc23e)
- `multi-select-action.ts` no longer carries a literal NUL byte (git classified it binary and hid its diffs from review); `.gitattributes` keeps any future stray byte from costing reviewability (#51, bdf4c26)

## [0.21.0] - 2026-07-31

### Added

- **macOS supervises the bridge with launchd.** `start` installs a LaunchAgent (`~/Library/LaunchAgents/herdr.collie.plist`), so the bridge comes back at login and restarts on failure — the parity with the `systemd --user` unit that macOS never actually had (#55, #57, a0be73d) — thanks @darieldatoon
- **The statusline strip shows every row of the run, in the agent's own colour.** Model, cwd, git branch and permission mode live on rows 2+ and were surfaced nowhere; the strip renders them stacked, in the mirror's colour space (#60, 61db7a5, ac3c62d)

### Fixed

- **Sending no longer stalls under a tall statusline** (the run may be 8 rows, was 3). A taller run made `locateInputBox` miss the input box, so a send typed the text and then withheld Enter — with no stranded-draft preview and no pre-clear sweep, so retries stacked duplicates in the pane. Reproduced on a 3-row statusline sitting one wrapped line from the cliff (#54, #56, fe8e548) — thanks @stekman08
- `launchctl bootstrap` is retried across launchd's teardown window, so `restart` — and therefore `update` — can't end with the bridge down (3776845)
- A Mac that can't bootstrap (no console login, so no `gui/<uid>`) keeps an unsupervised bridge instead of exiting with nothing running; `status` reports that degraded tier (05f8f48)
- The pi journal fixture is portable to macOS, where `containedRealpath` resolves `/var` → `/private/var` by design and the backend suite couldn't run at all (7e99645)

### Changed

- **The mirror wraps by default.** Herdr spawns panes at the desktop terminal's width against a phone's ~45–50 columns, so panning was the common case, not the exception; column-faithful no-wrap stays one tap away in View. Display prefs reset to defaults on first load (storage key v4), so a pinned font size needs setting again (#53, 273d886, 73cc7da) — reported by @waynehoover
- ADR 0004 records that the statusline-run bound guards less than it looks: a dialog below the input box is refused by the border checks and by the blank line above its footer hint, never by the row count (48b3ede)

### Upgrading

- **macOS installs migrate on the next `update` or `start`**: the old unsupervised bridge is stopped and replaced by the LaunchAgent. It's a *LaunchAgent*, so it starts at **login**, not at boot — and a Mac administered purely over SSH has no `gui/<uid>` to bootstrap into, so it stays on the unsupervised bridge with a warning until someone logs in at the console once.

## [0.20.2] - 2026-07-30

### Fixed

- `herdr plugin action invoke update` no longer dies with `bun not found on PATH` — Herdr spawns actions with no login shell, so Bun is now found in its install locations too, not just on `PATH`. A failed run had already fast-forwarded the checkout, leaving the old `web/dist` being served (#52, 08f44f6) — thanks @konpyl
- Only an absolute Bun path is prepended to `PATH`, so a `bun` shell function in the plugin `.env` can't put the CWD in front of `git` / `systemctl` / `tailscale`; the control script's Bun resolution now has test coverage (a50240a)

## [0.20.1] - 2026-07-29

### Fixed

- Journal rotation-following re-checks containment, so a sibling symlinked out of the Claude projects root can no longer be served as a pane's history (389618c)

### Changed

- Dependency versions must be 7 days old before they install, via `bunfig.toml` (`.npmrc` for npm users) (3a16f31)

## [0.20.0] - 2026-07-29

Three contributions from @konpyl carry this release — light and system themes (#41), the triaged
dashboard (#42) and tappable URLs in the mirror (#45), landed via #46/#47/#48 with review fixes on
top. Thank you: measured rather than estimated, with the reasoning written down where it will be
argued about again.

### Added
- **Light and system themes.** Collie follows your phone's appearance by default; pin Light or Dark from **Settings → Appearance**. Per device, and documented under [Dark mode / light mode](./docs/configure.md#dark-mode--light-mode) (#41, cd47bba, df47112)
- ANSI slots 0–15 are now CSS variables (`--ansi-*`), so indexed terminal colour is defined in one place and reaches the mirror through both `31m` and `38;5;1` spellings (cd47bba)
- **The dashboard is triaged, not listed.** Needs you → Ready · unseen → Working → Recent; the first three are pinned, Recent sorts by when you last used each pane (#42, 2c5f971)
- **Ready · unseen** — agents that finished while you weren't looking. Opening one clears it, on every device (4a03951)
- Recent and Spaces fold and remember it; fold both and the page is the triaged herd and nothing else (2c5f971)
- The swipe-up **Switch pane** sheet folds its long tails too — Recent, and the bare **Shells** group that buried the agents underneath it (90e1894)
- Spaces are ordered by last used and filterable — 45 of them are now three keystrokes, not a scroll (2c5f971)
- The bridge keeps two timestamps per pane (`activeAt`, `seenAt`) in `activity.json`, because Herdr reports none (4a03951)
- **Tab and space chips carry a status dot** — blocked / ready / working / idle, in the herd list's own palette. They only ever showed a dot for blocked before, so every other state read the same as every other (bddf4cc)
- **URLs in the pane mirror are tappable** — `http(s)://` text becomes a link that opens in a new tab, keeping the colour the agent printed and marked by an underline (#45, e231ab4)
- Trailing prose punctuation is trimmed with paren balance respected, so `Fetch(https://x.dev/a)` links the URL and not the paren; a find hit inside a URL still highlights, and a URL that changes colour mid-way stays one link (e231ab4)

### Changed
- The pane mirror renders in dark space under every theme and light mode inverts it, because agents emit truecolor almost exclusively and no palette can re-theme an absolute colour — [ADR 0002](.adr/0002-invert-the-light-terminal-mirror.md) (26db8f1)
- In light, the page is a step off white with cards staying white, so the dashboard's hierarchy no longer rests on a single hairline — and the mirror's edge stops showing a seam (cd47bba)
- **Agent rows are titled `project · tab`, not "claude".** The pane's own name moves to the second line; the agent stays in the avatar (2c5f971)
- Spaces moved BELOW every agent section — it's a navigator, not a work queue (2c5f971)
- Only Collie's own reads count as seeing a pane; a Herdr focus at the desk does not — [ADR 0003](.adr/0003-one-shared-seen.md) (659c9d4)
- MINOR, not MAJOR: pre-1.0, purely additive, no config or API break. Defaulting to your phone's appearance is the feature working as designed and Settings pins it either way; an older bridge reports no activity timestamps and simply renders the previous dashboard, minus the one section that would be empty

### Fixed
- **The space and tab chip rows overlapped each other on the space screen** — both strips were missing `shrink-0` inside the route's flex scroller, so they collapsed to 16px around 32px chips and the tab row painted over the space row. Pre-dates this release (5e10bb0)
- Three `role="alert"` warnings (incomplete multi-select, wizard, preview) used a hardcoded yellow that measured ~2:1 on white; they use the status palette now (cd47bba)
- An off notification switch was unreadable in light — a white thumb on a 1.09:1 track, legible only by its shadow. It carries an outline now (cd47bba)
- Focus rings were drawn at half strength, 1.77:1 in light and 1.87:1 in dark; both are full strength now (cd47bba)
- Small muted text (section labels, the build stamp, the terminal status line, the `(n)` counts) fell under 3:1 in light — light `--muted-foreground` had no headroom left for the `/70` and `opacity-60` modifiers stacked on it, so it was darkened and the modifiers dropped (cd47bba)
- Header controls had 20px touch targets; the Settings gear and the Settings back button are both 44px now, with no change to how they look (cd47bba)
- The boot splash stepped from white to the page colour when React took over, and its caption measured 3.45:1 — it used `#ffffff`/`#8a8a8a` under a comment claiming they matched `--background`/`--muted-foreground`, which rasterize to `#f5f5f5`/`#5d5d5d`. Same fix for the light `theme-color` meta, so Android's URL bar matches the page (b02b800)
- Inverse-video segments in the mirror emitted theme tokens while the muted glyphs beside them used literals; the mirror keeps one spelling now (identical pixels — the literals are those tokens' dark halves) (b02b800)
- Marking a pane seen had made a read-level GET mutate state, so a cross-site `<img>` at a guessed pane id could silently clear your unseen agents. Only a request carrying the app's own header counts now — caught in this release's security review, never shipped (336c4c6)
- Only a request that will actually be served marks a pane seen — one falling through to 405 no longer clears an alert (6b89899)
- **Light `--accent` was byte-identical to `--background`**, so "this is the current one" showed nothing in light mode — the open pane in the switcher, the current session, every `hover:bg-accent`. Predates this release; found by the UX sweep (b6850b4)
- Titles truncated away the tab — the only part that identifies a row — leaving several panes rendering the same `moonward_os · t…` (f5e1e77)
- Section headings rendered at two different sizes and cases, because a `<button>` doesn't inherit `text-transform` from its `<h2>` (f5e1e77)
- A hollow status ring on the avatar's corner read as a notch cut out of the logo (16b01c8)
- A space row and its chip could disagree about what a colour meant — the row still ranked by `STATUS_RANK` while the chip used the triage classifier, so a space holding one working agent and one unseen-done agent showed "working" on the dashboard and "ready" in the strip. Both route through `bucketOf` now, in one pass rather than spaces x agents per render (35c7f90)
- `aria-controls` on a collapsed section pointed at an element that isn't rendered — exactly when a screen-reader user is deciding whether to expand it (35c7f90)
- A status dot passed a smaller size only resized its wrapper, so chip dots rendered at the wrong size (35c7f90)
- The Settings page rearranged itself a frame after opening — Notify-when and Snooze mounted only once push state resolved, inserting ~400px into the middle of the page, and Notify-when then grew another ~180px waiting on its own prefs. Both render from the first frame now, switches disabled until their values land (87b875d)
- The pane row ran straight into terminal output with no edge between them, so the chrome and the mirror read as one surface (e791330)
- Herd and space rows had a border radius with no border to own it, so a rounded hover fill sat under a straight `divide-y` hairline. Rows without a border are square; the ones with a real border keep their radius (87b875d)

## [0.19.0] - 2026-07-29

### Added
- **Journal (pane history) is now per-harness, with Codex and pi support.** Reading an agent's own session log is an adapter keyed on the pane's agent (`bridge/journal/`), so a new harness is an adapter rather than a fork of the reader — Codex reads its date-partitioned `rollout-*.jsonl`, pi its per-cwd session log. Raised in #40 by @simonallfrey, who asked where to implement journaling for Codex (1bccb8e)
- **`scripts/journal-probe.ts`** probes every adapter against the real logs on the host — the format-drift check unit tests can't make. It caught Codex 0.145 adding a `developer` message role the parser would have rendered as operator speech (1bccb8e)

### Fixed
- **pi could never have had history.** pi reports its session as a kind-`path` ref (an absolute path) and the bridge kept only kind-`id` refs, so a pi pane arrived with no session at all. Both kinds are kept now; a path ref is confined to that harness's root after symlink resolution (1bccb8e)
- **A pane relaunched as a different agent served the previous agent's session ref.** Herdr keeps reporting the last session announced for a pane — a pane running pi still advertised a `herdr:claude` id. The ref is dropped unless its own `agent` matches the pane's (1bccb8e)

### Changed
- **A pane's session reference no longer goes to the browser.** `/api/snapshot` sends `hasSession` instead — for pi the reference is a filesystem path, and the History affordance only ever needed "may this pane have history?". It is now also gated on the harness actually having an adapter (1bccb8e)

## [0.18.0] - 2026-07-28

### Added
- **Approvals are bound server-side to the prompt they were decided against.** `/keys` and `/reply` accept an optional `expected_prompt`; the bridge re-reads the pane immediately before writing and refuses with `409 prompt_changed` if the dialog moved. Shrinks the guard window from human latency to two local RPCs — a mitigation, not a guarantee, until herdr gains a conditional-input primitive (#29) — thanks @Optic00 (7ae589c)
- **`/auth/` is reserved for a fronting proxy's sign-in page**, and the service worker always passes it to the network. An installed PWA could not reach a proxy page at all before — the precache answered every navigation, reload included — so operators had to squat a page inside `/api/`. The refusal banner now links there (#31) — thanks @Optic00 (ee246d3)

## [0.17.0] - 2026-07-27

### Fixed
- **A reply sent while an agent dialog was focused answered the dialog instead.** The submit key approved whatever option was highlighted (Claude defaults to "Yes") and the message was destroyed, while the bridge reported success. Sending now refuses outright while a dialog is up, and otherwise types first and only submits once the text is verified in the input box (#34) — thanks @maikschuheida-spec

### Changed
- Free-text replies on harnesses with a block grammar (Claude) are two steps — type, verify, submit — so "Sent ✓" now means the text was seen in the input box. Harnesses without an adapter keep the previous one-shot send

## [0.16.1] - 2026-07-27

### Fixed
- `/api/config` is now gated like every other endpoint — it was the one route that skipped the same-origin check and `COLLIE_PUBLIC_HOSTS`, noted by @Optic00 in #32 (629348e)

## [0.16.0] - 2026-07-27

### Added
- Bring-your-own-tunnel deployment path documented as **Variant E** — NetBird, ZeroTier, Cloudflare Tunnel (7488e7a)
- `scripts/collie-ctl.test.sh` — first lifecycle coverage for the control script, wired into the pre-push hook (a004449, c323610)

### Fixed
- `unserve`/`uninstall` no longer remove a `tailscale serve` mapping Collie didn't create, and `start` no longer replaces one (a004449, thanks @iamtimmy)
- A front door that fails to publish no longer aborts `start` before the status banner (c323610)

## [0.15.0] - 2026-07-26

### Added
- Pane conversation history read from the agent's own transcript — scroll back past the live mirror (465c485)
- Windows support for the bridge: dials herdr's named pipe through `node:net`, one code path for both platforms (#25, #27) — thanks @mikebenner and @bwright2810 (120f829)
- `COLLIE_HERDR_DIAL=auto|net|bun` forces the dialer; `net` exercises the Windows path on Linux/macOS (4da4f03)

### Changed
- **Breaking, only if `COLLIE_DEVICE_HEADER` is set:** a request arriving *without* the device header is now read-only. It previously got full write access, which let any tailnet client reach the bridge's own URL and skip the proxy that injects the header. Front doors that inject it on every request are unaffected; direct loopback/MagicDNS access now needs the header sent by hand (#28) — thanks @Optic00 (f88f1d6)

### Fixed
- A 401/403 no longer renders as an endless "reconnecting" banner — an access refusal now says so and offers Reload (#30) — thanks @Optic00 (787b193)

## [0.14.2] - 2026-07-23

### Added
- Paste an image straight from the clipboard into the composer, same upload path as the picker (#24) (ffceb0f)

## [0.14.1] - 2026-07-22

### Fixed
- `collie-ctl.sh self_dnsname` shelled out to `node`, which Collie never requires — now uses `bun` (#22) — thanks @jz-wilson (6664ced)

## [0.14.0] - 2026-07-21

### Added
- Alt modifier in the nav tray — `alt+<key>` chords now reachable from the phone (#19) — thanks @bnivanov (38e05cf)
- Modifiers combine (checkbox, not radio): `ctrl+shift+p`, `alt+shift+p`, even triple chords (#20) (38e05cf)
- Modifier lock — tap an armed modifier again to keep it armed across presses and Sends; Clear or a third tap releases (#20) (38e05cf)

### Changed
- HERDR_API.md: multi-modifier chords live-verified in any order against Herdr 0.7.3, cross-confirmed on 0.7.4 by @bnivanov (0d1472b)

## [0.13.2] - 2026-07-20

### Fixed
- Tabs render in Herdr's reported order instead of stable-number order, so a reorder in Herdr survives to the screen — thanks @iFwu (6a8e0f7)
- Tapping raw terminal output focuses the composer synchronously, keeping iOS's user-activation window so the software keyboard opens — thanks @iFwu (8ca41ca)

## [0.13.1] - 2026-07-20

### Fixed
- Taking over or sending a draft no longer permanently mutes the preview for that same text — the handled key resets once the host line clears (730f6c6)
- Send's pre-clear sweep overshoot widened 8 → 32 so host typing inside the poll gap can't leave a remnant (730f6c6)
- A scrollback line starting with `❯` can no longer pin a bogus session name — only the live (bottommost) prompt decides (d8744f4)

## [0.13.0] - 2026-07-19

### Added
- Long-press a pane pill for a pane actions sheet — rename + two-tap close (5b50941, c713551, 90210ce, ea20df0)
- Pane rename end-to-end: `pane.rename` RPC, bridge route, label threading (317ec72)
- Tab rename + tab close (blast-radius confirm) via the same long-press sheet on tab chips (a9664b5, 37a470e)
- Claude's own `/rename` session name surfaced on cards, headers, and the switcher (7c6606c)
- Read-only "Draft in terminal" preview with explicit Take over — the composer input is exclusively phone-owned (4b6f0ac, 10fa28d)
- Self-update without the service worker: `X-Collie-Build` on polled responses, auto-reload or tap-to-update banner (b83185a)
- Instant offline navigation — during a known outage, routes serve the last good snapshot instead of hanging on a dead fetch (6ba7dea)
- Busy strip on genuinely hung loads: navigations >500ms, background polls >6s (e886541, 3bfaa1c, 06516c4)
- `-dev` marker in the build stamp for non-release builds (32d76d6)

### Changed
- One shared `AppHeader` for dashboard, space, and pane — same components underneath, stale status badges dim during outages (bc60ea6)
- Connection status is a single animated top bar — amber "reconnecting…" after 4s of trouble, red with Retry at 15s, green flash on recovery; no header pill (394e6fe, b2dd50e)
- Switcher sections carry status-colored bullets; per-row close removed (switching is the only action there) (724bce3)
- `assets/*` served immutable, everything else `no-cache` — proxy caches can no longer starve `/sw.js` updates (b83185a)

### Fixed
- Own in-flight reply no longer flagged as a stranded terminal draft (15c1830)
- Wrapped multi-line drafts and the new background-agents footer no longer break input-box detection (829fc7e, d9521e3)
- `navigator.onLine` never gates polling or liveness — lying flags can't wedge the app or fake outages (d31ffb8, 394e6fe)
- One shared connection-lost clock; escalation survives route changes and app switches until a poll succeeds (1486e07, 5949885)
- Sustained outages escalate everywhere — boot splash, header, banner — with Retry/Reload (0cbbac1, 4d89588, 4494cf5)
- Gallop sprite re-centered; the dog never freezes mid-stride (rest state is the static icon) (3c7174a, 394e6fe)
- Offline banner no longer overlaps the sticky header (2e988f3)

## [0.12.0] - 2026-07-17

### Added
- `COLLIE_SKIP_SERVE=1` env var to disable tailscale serve entirely — bridge stays on loopback only, ideal for deployments behind a reverse proxy (Caddy, Nginx, etc.) — thanks @diogenesc (791dfcc)
- `COLLIE_PUBLIC_URL` — `collie-ctl.sh status` banner shows your real reverse-proxy URL instead of a placeholder (ec01d66)
- Bridge startup warning when `COLLIE_TRUSTED_USER` is set under `COLLIE_SKIP_SERVE=1` — the identity gate is inert without tailscale serve injecting `Tailscale-User-Login`; use `COLLIE_DEVICE_HEADER` (ec01d66)
- README Variant C — reverse proxy as the only front door (no Tailscale), with Caddy example and required env (c5c3533)

### Changed
- `collie-ctl.sh unserve`/`uninstall` always attempt serve teardown, even under `COLLIE_SKIP_SERVE=1` — a stale mapping from before the flag flip would keep publishing the app (ec01d66)
- Security posture docs: "tailscale serve is the sole ingress" → "exactly one hardened front door" (tailscale serve or a conforming reverse proxy) across README, ARCHITECTURE, CLAUDE.md (c5c3533)

## [0.11.1] - 2026-07-16

### Fixed
- Opening a tab/pane lands on the live tail — terminal `<pre>` no longer steals vertical scroll from the message list; stickiness also re-pins when content grows (8576152)

## [0.11.0] - 2026-07-15

### Added
- Pluggable harness-adapter architecture: a `HarnessAdapter` registry replaces the single Claude-only gate, Claude's detectors move to `lib/harness/claude/`, and a core race-guard engine (`lib/harness/guard.ts`) is the only module that may touch the network — an import fence (enforced by `fence.test.ts` under `bun run test`) + a conformance suite let contributors add codex/pi/opencode (see `HARNESS_CONTRIBUTING.md`)
- multiSelect AskUserQuestion support: checkbox options up-level to tappable checkbox rows (terminal is source of truth), with a closed-loop Submit that navigates the pointer to Submit and verifies before Enter (never blind-sends), plus the review/confirm screen
- Prompt overlay: interactive prompts render in a bordered `bg-card` panel that lifts the whole dialog off the terminal mirror, with elevated option rows, leading key-digit badges, and a family-aware caption
- Update notifications: a footer banner (linking to the GitHub release) and an opt-out web-push when a newer release is published upstream or the running bridge is behind the on-disk code — checks the repo's tags over anonymous HTTPS, stamps its own sources for the restart signal, a Settings "check for updates" button forces an immediate check, an `updates` notify pref is the off-switch, and update/restart are surfaced as location-independent Herdr plugin actions

### Changed
- Keys and Quick menus dock in-flow above the controls row instead of a fixed overlay, so the terminal mirror shrinks and re-pins to the bottom (ResizeObserver) — the prompt/cursor stays visible; both buttons are toggles
- Prompt option rows compacted (tighter padding, snug line-height) so a multi-option dialog fits the phone viewport
- "Sent" status toast moved from a bottom overlay (which covered the terminal tail) to a slim in-flow row below the header
- Build stamp marks a dirty working tree (`<sha>-dirty`), so the footer no longer claims HEAD when the build carries uncommitted work
- multiSelect Submit is ~2s instead of ~15s: the pointer walk re-reads the actual position each step and stops on "Submit", instead of polling for the bottom row after every key (which timed out ~2.8s per step)

### Fixed
- Prompt-select + wizard grammars: a numbered list in a dialog body (e.g. a plan's steps) no longer breaks menu detection — the menu is taken as the trailing `1..m` run, so plan-approval prompts up-level correctly

## [0.10.3] - 2026-07-12

### Fixed
- `collie-ctl.sh build` installs the root dependency tree (not just `web/`) before typechecking, so a fresh Herdr install no longer fails with TS2688 "Cannot find type definition file for 'bun'" (03f409f, #9)

## [0.10.2] - 2026-07-12

### Fixed
- Composer Send clears a stranded draft off the terminal `❯` line (ctrl+k + Backspace) before typing so replies no longer accumulate on the prompt; a clean prompt skips the clear (412378f)
- Bridge settles ~350ms between typing and Enter so the TUI reliably accepts the submit key (412378f)

## [0.10.1] - 2026-07-11

### Fixed
- Terminal mirror defaults to no-wrap for table alignment like desktop Herdr; clearer borders/typography (font 12, muted-foreground box-drawing); pane stays viewport-width — toggle Wrap on in View for prose (85f777b)

## [0.10.0] - 2026-07-10

### Added
- Herdr session switcher: one bridge fronts every named herdr session — `?session=` on the API, `?s=` in the app, a sessions summary in the snapshot, per-session notification slots, and a `COLLIE_MULTI_SESSION` kill-switch (8fa1f20)
- Space detail is a deep-linkable route (`/space/:spaceId`) with a working browser Back button, replacing the in-home drill-in state (0e5f9c8)
- Terminal-draft recovery: a queued-then-recalled message stranded on the "❯" input line surfaces as a composer chip, with "Edit here" to clear the line and adopt the text cleanly (46dcf35)

### Changed
- Dashboard leads with "Needs you" — agents awaiting your input sit at the top, above the spaces overview (1d92592)
- Dashboard, space, and settings scroll inside a viewport-clipped region instead of the whole document (2aa9272)
- Session switcher and the session chip are dashboard-only, keeping the in-space and pane headers clean (bb0048d, ba56ba9)
- Header polish: consistent compact height across the dashboard and inside a space, zinc-800 nav chrome, a ringed Collie mark, a smaller pane-header agent logo, and the keyboard-only quick-keys strip removed (6250e0c, 9da7195, 35db0e5, ba56ba9)
- Security posture documents that `COLLIE_MULTI_SESSION` (default on) fronts every named session under the config root (fcb0b7d)

### Fixed
- Deep-linking a space that never existed shows "Space not found" rather than "Space closed" (fcb0b7d)

## [0.9.1] - 2026-07-09

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)
- Removed one-tap yes/no reply buttons from push notifications — they POSTed to the terminal without opening the app, i.e. approving blind. Notifications now only deep-link to the pane (cb26ee0)

## [0.9.0] - 2026-07-07

### Changed
- Quick keys mimic a physical keyboard on both surfaces: Esc top-left, Tab below it, inverted-T arrows, Enter top-right; Keys sheet gains a full-width spacebar (2f70662)
- Attach image lives in the reply row (usable without the phone keyboard open); digits leave the inline strip — the 123 tab remains (2f70662)
- Header collie logo is transparent like the gallop sprite — removed favicon.svg's baked-in gray backing rect (3f05da8)

## [0.8.0] - 2026-07-07

### Added
- Poll herdr 0.7.2's `session.snapshot` — one RPC per tick instead of three list calls; permanent fallback to the list trio on older servers (5687bbf)
- Event-poked polling: `events.subscribe` stream triggers immediate debounced re-polls; interval relaxes to `COLLIE_POLL_IDLE_MS` (default 12s) while the stream is healthy (5687bbf)

### Changed
- HERDR_API.md re-verified against herdr 0.7.2 / protocol 16; terminal observe/control filed under ARCHITECTURE.md Future ideas (aad94b3)

## [0.7.0] - 2026-07-06

### Added
- Notification type prefs: Settings "Notify when" toggles per agent status, bridge-wide; default pushes only "Needs input" (blocked) — "Finished" (done) is off (98cf5d2)

### Changed
- Push sends carry a `collie-herd` topic + 6h TTL: an offline device now gets one current summary on reconnect instead of replaying every queued update (98cf5d2)
- Disabling a notification kind retracts its pending/outstanding alerts immediately (98cf5d2)

## [0.6.0] - 2026-07-06

### Added
- First-paint PWA splash: the galloping collie shows before React mounts (299f632)
- Keys sheet: `Ctrl` modifier + visible key queue — compose chords/sequences, review, Send as one call; dialer-size digits on a `123` tab (515f795)

### Changed
- Header Collie mark matches the agent logo (2rem, aligned across screens); Find lives in the composer View row; placeholder is just "Type a reply…" (11385ee)

### Fixed
- Option taps no longer pop the phone keyboard or steal the note editor's focus (11385ee)
- Stalled connections no longer zombify the app: fetch timeouts (10s/20s/60s), polls supersede a wedged revalidation at 12s, and the collie gallops within 2.5s of a stalled load or pane-tap navigation (e6ad939)

## [0.5.0] - 2026-07-05

### Added
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

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)
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

## [0.4.0] - 2026-07-05

### Added
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

### Changed
- **One consistent top-left mark on every screen.** The Collie is now the brand + home button +
  connection loader in a single shared `CollieHome` component, rendered identically on the dashboard
  and inside a pane — so the header's top-left always means the same thing (previously a "stacks"
  icon inside a pane vs. the Collie logo on the dashboard). Inside a pane the Collie gallops on
  reconnect from the same global connection state as the dashboard (shared `isConnecting` predicate).

### Removed
- **The pane's Nav-hub drawer** (the left "stacks" drawer). It was redundant now that the Collie
  handles Home, the swipe-up switcher already covers pane switching/closing, and the breadcrumb
  covers cross-space jumps — removed along with its `SpaceList` component. The swipe-up switcher now
  appears whenever a pane is open, so even the last pane stays closable.

### Fixed
- **Multi-question AskUserQuestion no longer mis-parsed.** A multi-step AskUserQuestion (the
  `☒ Focus area  ☐ Scope  ✔ Submit` stepper) was detected as a single-question select and answered
  with one digit+Enter — submitting a half-filled form. It's now recognized as a wizard and left as
  the raw mirror (drive it with the keys pad, or via the new escape hatch) rather than mis-sending.

### Security

- Unauthenticated `POST /pack/v1/enroll` no longer rewrites the trust store or appends an audit line on a no-op spend — write-amplification against the key/secret file (F4) (43b9a17)
- **Prompt/wizard taps are guarded against same-shaped successor dialogs.** The tap race guard now
  compares a byte-signature of the whole dialog region — including the subject above the options (the
  diff/command being approved), not just the question and option labels. So a tap on a frozen mirror
  can no longer approve a *different* action that happens to render an identical-looking prompt (e.g.
  a second edit to the same file after the first was answered elsewhere). Herdr's `revision` is a
  stub, so this content signature is the load-bearing freshness check.

## [0.3.0] - 2026-07-03

A full-codebase review pass: four audit agents (backend, frontend, security, ops/product) swept the
tree; everything they found was verified, fixed, and the top feature gaps were built.

### Added
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

### Changed
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

### Fixed
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

## [0.2.0] - 2026-06-30

### Changed
- **Smarter push notifications.** A blocked/done alert is no longer fire-and-forget. Each one now
  waits a short **debounce window** (`COLLIE_NOTIFY_DELAY_MS`, default 30s) before it sends; an agent
  you clear at your desk within that window never reaches your phone. Alerts that *do* fire are
  **retracted** automatically once the agent resolves (or its pane closes), so handled work stops
  piling up on your lock screen. The service worker also **suppresses** the system notification when a
  Collie tab is already open and visible (the in-app status surfaces it instead).
- **Coalesced into one notification.** The whole herd shares a single notification slot: one agent
  shows the named, deep-linked alert; several collapse into a *"N agents need you"* digest (tap → the
  triage home) that updates in place as agents come and go, instead of stacking N separate alerts.

### Added
- **Do Not Disturb / snooze** (Settings → *Do not disturb*): pause all push for 30m / 1h / 4h, or
  resume early. Server-enforced and self-expiring, so it quiets every device — and it clears whatever
  is already on the lock screen the moment you snooze. The current deadline rides the snapshot, so it
  stays in sync across devices.
- `COLLIE_NOTIFY_DELAY_MS` env var — the push debounce window in ms (default `30000`; `0` notifies on
  the next tick with no debounce).
- `POST /api/notifications/snooze` — set/clear the global snooze (`{ snoozedUntil: number | null }`);
  the active deadline is reported on the snapshot as `notifications.snoozedUntil`.

## [0.1.0] - 2026-06-30

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

### Added
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
