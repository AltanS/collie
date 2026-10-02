# Changelog

This file tracks all notable changes to Collie, ordered newest version first. The project follows
[Semantic Versioning](https://semver.org/). From 1.6.0 on, a version's changes are grouped under
`### Added`, `### Changed`, `### Fixed`, `### Packaging` and `### Docs`, in that order and only
where there is content, and every bullet opens with a short bold lead sentence, which is the line
the GitHub Release page prints. Older versions carry a single flat list. Every entry links to its commit and credits the contributor where there is one. The
`## [Unreleased]` section contains merged work waiting for release. The release
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
Running a crew? Update the lead first; members follow on their own. Details:
`docs/crew.md` → *Updating from 1.7.0*.

**Coming from 0.x?** Upgrade with one command. Do not use `collie update`. From the Herdr
plugin: `herdr plugin action invoke update-major --plugin herdr.collie`. From a checkout you can
reach: `bin/collie update --major`. Fresh install:
`curl -fsSL https://colliepwa.dev/install.sh | sh`. Neither upgrade path assumes a `collie` on your
PATH. Details and rollback: [`docs/upgrading.md`](./docs/upgrading.md) → *Upgrading from 0.x to
1.0*.

## [Unreleased]

### Added

- **Oh My Pi's `/resume` picker is a list of sessions on the phone.** Tap a session and Collie
  moves the pointer to it and presses Enter, in the boxed picker of omp 18.4 and the unboxed one
  before it. On a very large pane the picker stays terminal text with an Escape button. Every other
  Oh My Pi dialog that names its way out, such as `/model`, `/settings`, an Ask question or a tool
  approval, now shows a button for that key. `/tree` names none, so it keeps no button.
- **`collie doctor` checks Oh My Pi's Herdr hook.** An `omp` pane that reported no session had no
  line of its own in `agent-sessions`, so its missing Chat and History went unexplained. The doctor
  now names the pane and the `integration-omp` line, which says to run
  `herdr integration install omp` and restart the agent.
- **Oh My Pi's Ask questions with one answer are buttons on the phone.** Tap an answer and Collie
  moves the pointer to it and presses Enter, so the agent gets the answer at once. `Other (type your
  own)` opens omp's answer box, and the phone's composer types into it. A question where you pick
  several answers, several questions in one call, options with descriptions, or a long list still
  show the terminal text with an Escape button.
- **Oh My Pi's `bash` and `write` approvals are buttons on the phone.** The card names the tool and
  shows the whole command, or the path and all of the file's content, on the Approve button. Approve,
  Deny and Cancel each take one tap, and Deny can never land on Approve, even if the pointer moves at
  the desk. Approvals for other tools, a third choice, a countdown, text omp itself cut short, a file
  of more than thirty rows, hidden or direction-changing characters, or a screen that is not omp
  18.4.10 or 18.1.17 still show the terminal text with an Escape button, which denies.
- **`collie start`, `stop`, `restart`, `status` and `uninstall` supervise the bridge on Windows through Task Scheduler.** (experimental; there is no Windows release asset yet) `start` registers the task `herdr.collie` at your logon with a limited token and runs a launcher Collie owns, which relaunches a bridge that exits with an error. `status` names the task and its state, `restart` restarts the bridge alone, and an install of the community script is taken over under the same task name. The first supervisor was written by @Pimpmuckl in contrib/windows, and the restart path by @mqmalagris (PR 309).
- **`collie status` and `collie doctor` say whose Task Scheduler task runs on Windows.** Status names Collie's launcher or the old script's loop, `doctor` gains a `windows-task` line, and a task that still points at the deleted script is reported as `Task herdr.collie still runs the old script. Run: collie restart`. `start` refuses a task that runs another install and prints `Registered Task Scheduler job herdr.collie (starts at logon)`.
- **Each release now tries to build an experimental Windows zip (unsigned `collie.exe`).** There is no published Windows installer yet, so do not expect a supported install path. Linux and macOS releases are unchanged. If the Windows build fails, the release still ships without it, until one release has carried the zip or until 2026-11-15, whichever comes first.
- **`install.ps1` installs Collie on Windows without a toolchain.** (experimental; it is not on colliepwa.dev yet, and no release carries the Windows zip until the next one) `scripts/install.ps1` needs no Bun, Git or bash, and works in Windows PowerShell 5.1. It downloads a release's Windows zip, checks its sha256 and stops on a mismatch or a missing `.sha256`, lays it into `%LOCALAPPDATA%\collie\versions\<version>`, points the `current` junction at it, and adds `current\bin` to your user PATH. It never asks for admin and never starts Collie: it runs the new `collie.exe version` once to check that Windows lets it run, then prints the next steps. A second run changes nothing and points at `collie update`. `COLLIE_DIR`, `COLLIE_UPDATE_REPO` and `COLLIE_TAG` steer it, as they steer `install.sh`. Windows is not yet a supported host.
- **`collie uninstall` on a Windows binary install prints how to remove the rest.** (experimental) It keeps the install folder and the user PATH entry, as every install keeps its files, and now ends with the two PowerShell lines that remove them: `rmdir /s` for the folder and a registry edit that drops only `current\bin` from your PATH. Linux and macOS print what they printed before.
- **Oh My Pi's model picker is a list of models on the phone.** With omp 18.4.10, `/switch` and Alt+P
  open omp's session-only model picker. The card lists the rows the picker shows right now, not the
  whole catalog. Tap a model and Collie moves the pointer to it and presses Enter, which switches this
  session's model and leaves your role models and config as they are. The current model is named on
  the card but cannot be tapped. To reach a model that is not listed, type a search through Keys or
  Type mode, and the card updates after about a second. A row omp cut short and a model the
  conversation no longer fits (picking it compacts first) are left out. The `@` quick roles, the
  task-model picker, narrow panes and the Nerd Font symbols stay terminal text with an Escape button.
- **Voice input can run a transcription command already on your machine.** The new `local-cli` provider runs a command such as `whisper-cli` or `muesli-cli` once per recording, with the recording's path as its last argument, and takes the transcript from its stdout. Set it up with `collie stt setup --provider local-cli --command <path> --args <list>`, and check it with `collie stt test`. Collie runs it without a shell, as the bridge's user, and kills it after 60 seconds. The phone never sees its command line or its error output. Thanks @SubodhDahal (#227).
- **The `local-cli` provider cleans up after the command it runs.** On Linux and macOS the command starts in its own process group, and Collie kills the whole group with SIGKILL at the 60-second limit, at the 256 KiB stdout cap, and after a clean exit, so a process the command started cannot outlive it. At most two dictations run the command at once, and a third gets the busy answer without starting anything. `collie stt setup` and `collie stt status` refuse a command that is not a regular, executable file and say why. Temp folders left by a bridge that was killed are removed at the next start once they are an hour old (#227).
- **Collie can check the Cloudflare Access token itself.** Set `COLLIE_ACCESS_TEAM` and
  `COLLIE_ACCESS_AUD`, and every request through the tunnel must carry a `Cf-Access-Jwt-Assertion`
  that Cloudflare signed for this application. A deleted Access app, a bypass rule or a policy that
  has not propagated yet then shows the panes to nobody. Half a setting, or keys Collie could not
  fetch, refuse every tunnel request. Unset, nothing changes. Thanks @xbach (#341).
- **With the Access gate on, only a process on the machine itself skips the token.** A request
  that carries a forwarding header (`X-Forwarded-For`, `Forwarded`, `X-Real-Ip` and the like) needs
  the token too, so `tailscale serve` beside the tunnel stops serving browsers. `COLLIE_ACCESS_TEAM`
  must name a `<team>.cloudflareaccess.com` team, so the key fetch cannot be pointed at another host.
  The fetch gives up after 5 seconds, reads at most 64 KiB and follows no redirect. A bad setting or a
  failed first fetch prints one line in the bridge log that names the cause.
  The app's manifest is fetched with the Access cookie, so the phone can install it behind Access.
- **Muse panes have History and Chat.** Collie reads Muse's own `session.jsonl` log, finds the newest
  session whose workspace is the pane's folder, and needs no Herdr hook, so a Muse pane no longer
  answers "no transcript". `collie doctor` reports the hook line as green for that reason.
  Thanks @jpcarranza94 (#333).

### Changed

- **A tap on a dialog card can bind a larger screen region.** The bridge accepted at most 8 KiB of the
  screen a card drew when it checked a tap, which a full-screen picker on a pane wider than about 134
  columns exceeds. The limit is now 32 KiB. A phone newer than its bridge still gets the old refusal on
  such a pane and no key is sent, so update the lead and its crew together.
- **Groundwork for Windows support.** The code that picks path rules or a binary name now reads one host object. Nothing changes on Linux or macOS. Windows is still not a supported host.
- **The community Windows script in `contrib/windows` is gone, and Collie runs the task itself.** Every verb of `collie-ctl.ps1` is a `collie` verb of the same name: `update`, `build`, `version`, `logs`, `url`, `start`, `stop`, `restart`, `status` and `uninstall`. `COLLIE_TASK_NAME` is gone (the task is always `herdr.collie`), and so is the script's crash-log rotation: the bridge log is `collie.log` in the plugin config folder (`%APPDATA%\herdr\plugins\config\herdr.collie\collie.log` by default), appended to and never rotated. One Collie per Windows machine is supported: `start` refuses a task that runs another install, and warns when a second instance registers its own. Run `collie restart` once after updating (and `collie build` before it if the script's own `update` pulled this version). Until then `collie status` and `collie doctor` say `Task herdr.collie still runs the old script. Run: collie restart`.
- **The Spaces section follows the workspace you isolate.** Tap a workspace chip on the dashboard and
  the Spaces list shows that space and the worktrees of its repo. Tap All and every space is back.
  Thanks @dantebarba (#338).

### Fixed

- **Windows no longer prints a false `.env` mode warning, and `collie doctor` checks Herdr's version there.** NTFS has no mode bits, so the line saying `.env` was tightened to 600 was untrue on every command. Collie now reads the file's access list instead (see the owner-only line below). `doctor` warns when Herdr on Windows is older than 0.9.3, the build Collie was checked with.
- **On Windows (experimental): the phone's Update button works.** It used to answer `412 no systemd user unit`, because the update's check looked for a systemd unit; it now asks Task Scheduler for the `herdr.collie` task. `collie doctor` no longer fails a Windows machine that has no Python, which also kept the button off. A source checkout is not updated on Windows: `collie update` and the button say so in one sentence and change nothing.
- **On Windows (experimental): `collie restart` says what it found and stops waiting after 30 seconds.** It says whether the bridge was running, gone, or whether the process list did not answer. It used to wait about 3 minutes for a bridge that did not come back, so a broken update took 221 seconds to roll back; now about 75. A launcher killed by hand comes back within 5 minutes.
- **On Windows (experimental): an old version folder that is still in use no longer fails the next update.** The update prints a note, and a later update removes the folder once nothing uses it.
- **On Windows (experimental): Collie keeps its secret files and folders private to your account, SYSTEM and Administrators.** It repairs loose permissions at start, only in its own folders. `collie doctor` checks this (`secrets-private`). The false `.env mode 666` warning is gone. Linux and macOS are unchanged.

- **A phone reply reaches omp's `ask` answer box.** Picking `Other (type your own)` or adding a note
  opens a box Collie did not recognise, so Send refused with "input box isn't on screen". Send now
  types, checks and submits there. A multi-line message is refused on that box, because a newline
  submits it. Thanks @enieuwy (#336).
- **A refused multi-line reply says when part of it was already typed.** On an input that submits on
  a newline, a long message sent in several parts could be refused after the first part landed, and
  the notice still said nothing was typed. It now says the earlier part is in the pane. Thanks
  @enieuwy (#336).
- **A tapped row is confirmed only after the pointer is seen on it.** A tap on a pointed list now sends the arrow keys first, reads the screen again, and sends Enter only when the pointer stands on the tapped row, bound to that very screen. A keystroke at the terminal in between, or a row that changed under the pointer, refuses the tap instead of confirming the wrong row. This covers every harness with a pointed list: Claude Code, Codex, Oh My Pi and opencode, whose permission buttons are a row and walk sideways. A resume list whose ages tick while the arrows go out still commits. A conformance guard now requires every such grammar to prove, on two real captures with the pointer on different rows, that a moved pointer is still the same dialog.
- **The model picker's Close button says when it clears a search instead.** With a search typed, Oh My Pi's Escape clears the search and keeps the picker open, so the button now reads "Clear search" and only reads "Close" when a tap closes the picker.
- **A tap on an opencode permission chip is bound to the highlighted chip.** The bridge now also checks the colours of the dialog it is about to answer, because opencode marks the chosen chip only by a background colour. A keystroke at the terminal that moved the highlight refuses the tap instead of confirming another chip. A refused tap also writes the reason to the browser console.
- **Sidebar edges and shared-row borders no longer leak into an opencode draft.** With a sidebar open over the composer, a row holding only the sidebar's `│` edge now reads as blank, and a panel's closing border on the same row as your words is cut off, so the Draft card shows what you typed and the reply guard verifies the send. A pasted box row such as `╭─ title ─╮`, a typed rule and a pasted tree keep their glyphs. Thanks @AndiWandHerd (#340, fixes #337).
- **The Escape button on a dialog Collie cannot read now needs a second tap.** The first tap only arms it, and it disarms by itself after four seconds. On an opencode question dialog the button reads "Tap again to dismiss", because Escape there ends the whole question turn. One stray tap no longer does that. Thanks @AndiWandHerd (#339).

## [1.15.3] - 2026-10-02

### Fixed

- **A folder on Windows no longer reads as "no folder".** The Changes view only accepted a path that
  started with `/`, so every Windows folder was refused. It now reads a path the way the host does, and
  the install check, the link check and the update smoke test find `collie.exe` instead of a bare
  `collie`. On macOS a folder reached through `/tmp` or `/var` now maps to its repo. ([f70595f8](https://github.com/AltanS/collie/commit/f70595f8), [20d1e6d5](https://github.com/AltanS/collie/commit/20d1e6d5))
- **A lead behind `tailscale serve` now tells a new member to dial port 443.** `crew add` and
  `crew invite` handed the member the bare tailnet name, and `collie join` reads a bare host as the
  lead's own listener on port 8787. A default HTTPS lead listens on loopback and publishes only 443,
  so the member saw "Unable to connect". Both now give `https://<full-tailnet-name>`, or
  `<name>:<port>` when `COLLIE_SERVE_PORT` moved the front door. With `COLLIE_SERVE_MODE=http`,
  `invite` keeps the short name. Thanks @sbakhour (#334). ([228f65ee](https://github.com/AltanS/collie/commit/228f65ee))
- **`collie crew join --address` now needs a port.** A portless `--address` made the lead dial port 443 on the member, so a member whose
  address had no port stayed unreachable with nothing naming the cause. `join` now refuses it and
  suggests `--address <host>:<port>`. An `https://host:8787` address is still accepted and stored
  as `host:8787`, while `https://host` with no port and any `http://` address are refused. For a
  peer row that cannot be dialled, `crew status` now names `collie crew set-address <member>
  <host:port>`. `crew status` and `doctor` print the exact `set-address` command for a stored
  address without a port. ([228f65ee](https://github.com/AltanS/collie/commit/228f65ee), [58cd66af](https://github.com/AltanS/collie/commit/58cd66af))
- **A failed TLS dial now says which way it failed.** Every TLS failure read "the TLS certificate
  was not accepted". A certificate that is not the pinned one now reads "something other than the
  pinned member answered at this address", which is what a wrong port looks like. A name mismatch
  and an expired or not yet valid certificate each get their own sentence. ([228f65ee](https://github.com/AltanS/collie/commit/228f65ee))
- **A fresh omp session no longer shows a draft in the terminal.** omp 18.4 paints a key hint,
  Shift+Tab to change thinking effort, into an empty editor. The omp reader took the hint's key
  glyphs for a typed draft, so every new session showed "Draft in terminal" with Take over. The
  reader now knows the hint's shape in all three composer layouts and reads the editor as empty.
  Thanks @enieuwy (#320). ([e3887c1d](https://github.com/AltanS/collie/commit/e3887c1d), [487f70b0](https://github.com/AltanS/collie/commit/487f70b0), [73f417cd](https://github.com/AltanS/collie/commit/73f417cd))

## [1.15.2] - 2026-10-02

### Fixed

- **A working Claude pane no longer shows "Collie cannot read this dialog".** Claude Code's default
  footer prints `esc to interrupt` while a turn runs and `↓ to manage` while a background task or
  monitor exists. Collie took both for a modal's key hints, found no input box, and drew the Escape
  card over a live composer, where the reply path then refused to type. A pane with a custom
  statusline never showed it, which is why no capture in the corpus had the footer. Those two hints,
  and their clipped forms on a narrow pane, now read as the composer's own status, and a real
  `Esc to cancel` footer still refuses. Thanks @aryanscaler (#330). ([63bf5b61](https://github.com/AltanS/collie/commit/63bf5b61))

## [1.15.1] - 2026-10-02

### Added

- **The Chat view shows what a question tool asked, with its options.** An opencode `question` call or a Claude Code AskUserQuestion reaches the phone with its questions, their options and, once answered, the labels chosen, instead of a bare tool name, and while it waits the card points at the dialog below the stream (#329). ([10a383c9](https://github.com/AltanS/collie/commit/10a383c9))

### Changed

- **A compaction is one marker line in a session view, and its recap is off by default.** When an
  agent compacts its context it writes a recap of the whole session for itself. Chat drew that as a
  centred wall of text and History as a full card, thousands of characters nobody reads on a phone,
  all built into the page. Both views now draw "Context compacted" and the time, and the text is
  never built. Turn the recap back on under Settings → Appearance → Compaction summaries, or in a
  pane's Display sheet, and it folds behind the marker and opens on a tap. A find on History always
  reaches it. Long machine notes fold behind a System label as well. ([ec93cae6](https://github.com/AltanS/collie/commit/ec93cae6))

### Fixed

- **Updating on Windows works with the community supervisor.** With the community Task Scheduler
  supervisor, `collie restart` stops only the bridge process it recorded and the supervisor
  relaunches it, where it used to fail on a `bin/collie` that Windows names `collie.exe`. The build
  steps the running `collie.exe` aside to `.old` before the swap, because Windows refuses to rename
  onto a running executable, and the bridge finds `bin/collie.exe`, so the phone's Update button can
  run there. Windows stays community-supported and best effort. Thanks @mqmalagris (#309). ([0debdcc4](https://github.com/AltanS/collie/commit/0debdcc4), [c942047b](https://github.com/AltanS/collie/commit/c942047b), [2c96e76b](https://github.com/AltanS/collie/commit/2c96e76b), [039a4b11](https://github.com/AltanS/collie/commit/039a4b11), [eb1fd1ca](https://github.com/AltanS/collie/commit/eb1fd1ca), [a0017871](https://github.com/AltanS/collie/commit/a0017871))
- **Switching a pane to Chat lands with the turns already there.** Choosing Chat from the pane menu
  used to swap the body at once, onto an empty box, and the turns popped in after it. Chat now reads
  the session while the pane menu or the Display sheet is open, so the swap happens as the sheet
  closes. If that read has not come, the terminal stays up for at most a second and a half. ([6ca7b5a4](https://github.com/AltanS/collie/commit/6ca7b5a4))
- **A Windows restart reports it when the bridge never comes back.** On Windows with the community
  supervisor, `collie restart` waits for the bridge to answer, 30 seconds unless
  `COLLIE_UPDATE_HEALTH_TIMEOUT_MS` says longer. If nothing answers, it now exits with an error that
  points to `collie status` and `collie-ctl.ps1 logs`, where it used to report success. An update run
  in a terminal then no longer prints `✓ update complete`, though the new version may already be
  installed, and a slow machine can come up a few seconds after the error. The phone's Update button
  keeps its own health check and its one rollback. Windows stays community-supported and best effort. ([29760622](https://github.com/AltanS/collie/commit/29760622))
- **A quiet tuios shell is named a shell, not an id.** Until a program sets a title, tuios fills the
  window title with `Terminal` and the first eight characters of the window id, and Collie passed
  that on as the terminal title, so every such pane read as "Terminal 6247db65" on the phone. The
  placeholder is now dropped and the pane reads as a shell, as on tmux and zellij. Thanks
  @Gaurav-Gosain (#328). ([20df9596](https://github.com/AltanS/collie/commit/20df9596))
- **An opencode question dialog can be answered from the phone.** A single-select question shows as
  a card with one button per option, and a tap sends that option's digit. A multi-select question
  shows its options as checkboxes: a tap toggles one, a button moves on to the Confirm tab, and
  Confirm lists the answers with a button to submit them and one to dismiss the dialog, which ends the
  turn. A call with several questions shows each question as a step with its tabs, and the same
  Confirm tab ends it. Before, every one of these showed as raw terminal text that no button could
  answer. The card locks while the free-text row is open, because the terminal takes digits as text
  there, and Collie never types into that row. A list of more than nine options stays on the
  terminal mirror, with the Escape card to dismiss it (#329). ([199d31f5](https://github.com/AltanS/collie/commit/199d31f5))

## [1.15.0] - 2026-10-01

### Added

- **The journal now says what a tool call did, not only what it was asked to do.** Every tool part
  carries a structured `call` beside its one-line summary: an edit knows its path, its diff hunks
  and how many lines moved, a command knows its exit code, a read knows its range. A refused call is
  marked `denied` rather than lumped in with a real failure, because "you said no" and "it crashed"
  are not the same thing to read. The shape is additive, so every existing view keeps working, and
  the name table is shared, so `Bash`, `bash`, `shell` and `exec_command` are one kind of thing. ([d5faea94](https://github.com/AltanS/collie/commit/d5faea94))

- **Settings is four sections instead of one long column.** The page was seventeen cards deep on a
  phone with no headings to skim by, so finding one switch meant reading every card above it. It is
  an index now: Appearance, Device, Alerts and System, each short enough to take in at once. No
  setting is removed and none changes what it does. Back from a section returns to the index. The
  QR `collie pair` prints still opens the pairing form, which now lives under System. ([7527b53e](https://github.com/AltanS/collie/commit/7527b53e))

- **Tool calls are off in a session view, and that is the new default.** A working session is
  mostly tool calls: one turn can be forty reads and a grep, which buried the paragraph you opened
  the page for. The History page now draws what the agent SAID, with one muted line per turn saying
  how many steps it took and a tap to bring them back. A find always overrides it, so a search that
  matches inside a command's output still shows what it matched. Turn them back on for good under
  Settings → Appearance → Tool calls. ([b36b7c55](https://github.com/AltanS/collie/commit/b36b7c55))

- **A pane that becomes an agent pane says so.** You are watching a bare shell on your phone, you
  type `opencode` at your desk, and the Collie mark flies out of the header, blooms over the mirror
  and hands the pane to the agent's own mark. It marks a fact the poll has already found, so it
  never reads as progress, it holds no space and moves nothing, a tap ends it, and under reduced
  motion it is a still picture instead. Opening a pane that was already running an agent announces
  nothing: it is the change that is drawn, never the state. ([36063545](https://github.com/AltanS/collie/commit/36063545))

- **The boot splash shows the Collie mark, not the old galloping dog.** The sprite was retired when
  the new mark landed and every screen moved to it, but the first-paint splash in `index.html` kept
  its own hand-written copy, so a cold open still flashed a galloping dog and then swapped it for a
  different animal. It is the brand's own header-weight mark now, in a light and a dark file, so the
  hand-off to React changes nothing but the mark's own motion. ([2dd6ca80](https://github.com/AltanS/collie/commit/2dd6ca80))

- **Every harness now records what a tool call DID, not just that one ran.** Claude already did;
  Codex, opencode, pi, grok and hermes now do too. A command carries its exit code, an edit carries
  its hunks and its added and removed counts, a search carries its hit count, and a call the
  operator refused is marked as refused rather than as an error. Nothing is guessed: each harness
  fills only what its own record actually holds, and the three that write no exit code and no patch
  say so rather than inventing one. This is what a session card will draw, and it is read from one
  place for all six. ([0a143094](https://github.com/AltanS/collie/commit/0a143094))

- **The pane switcher can run by activity instead of by place.** The sheet you open with the layers
  mark keeps every pane in its space and tab, which is the right answer when you know where you are
  going and the wrong one when you just want the pane you were last in. A Place / Activity toggle now
  sits at the top of it, and Activity folds the space headings and the Shells fold into one list,
  newest first, counting both the agent's own last turn and the last time you were in the pane. The
  choice is a standing one and also a row under Settings → Appearance → Pane order. It reads the
  clock once, when the sheet opens, so a pane that finishes a turn while you are reaching for a row
  repaints where it stands and never moves under your thumb. ([cf10b860](https://github.com/AltanS/collie/commit/cf10b860))

- **The journal reads a session one row at a time.** Every harness adapter now folds its log row by
  row instead of only parsing a whole file, and says which earlier turns a row changed as well as
  which turns it added. That second half is the point: a tool result lands rows after the call it
  belongs to, so attaching it edits a turn that is already on screen. A live session that gains one
  row can now cost one row of work instead of re-reading and re-parsing the last 32 MB of a log that
  can be 187 MB long. Nothing you can see changes yet, and the whole-file reading is the same reading
  it always was, proved for all six harnesses against the same bytes arriving in torn random chunks. ([a417a46d](https://github.com/AltanS/collie/commit/a417a46d))

- **Asking a session what is new now costs only what is new.** Every harness can answer that
  question in the language its own storage speaks: the four that write a log file count bytes, and
  the two that keep a SQLite database count a row's own clock or its row id. The reader above them
  learns none of that, so a harness can change how it counts without anything else changing. Three
  things follow. A first read takes a bounded tail instead of a whole session, which starts to matter
  once a log runs to hundreds of megabytes, as a long Claude session does. A row the agent is halfway
  through writing is held back
  until the newline arrives, so it is never shown half and never dropped. And a read that cannot
  simply continue, because a log was truncated or because Claude handed the conversation over to a
  new file, says so in one word and hands back the truth instead of a guess. Nothing you can see
  changes yet. ([7953e9c8](https://github.com/AltanS/collie/commit/7953e9c8))

- **A watching screen asks what is new and is told only that.** A new read answers a pane's session
  the way a poll wants it answered: the turns you have not seen, the turns that changed since you
  last looked, and nothing else. A poll that finds nothing new sends no body at all. The bridge holds
  a bounded tail per session, about two megabytes of it, so a session of any length costs the same
  memory, and older turns come off the disk only when somebody asks for them. It rides the poll
  Collie already has rather than a new socket, so it crosses a crew link exactly as the history read
  does, and a member one release behind simply reports no such read instead of an empty session.
  Nothing you can see changes yet. ([c75ced6e](https://github.com/AltanS/collie/commit/c75ced6e))

- **The pane menu can copy a pane's output.** There was no way to get the terminal text off a
  phone at all: an installed iOS PWA suppresses long-press selection app-wide unless an element asks
  for it back, and the mirror never did. Two ways in now. The mirror opts back into selection, so
  long-press and Copy works. And a Copy output row joins Find and History in the pane menu, which
  copies the whole buffer in one tap, unwrapped, so a paste reads as real lines rather than as the
  phone's own hard wraps. The row copies the screen you are looking at, not a poll that landed under
  your thumb, and it stays hidden where there is no output or no clipboard to write to, which is
  every plain-HTTP deploy. Thanks @jyothyswaroop (#287). ([d5057d23](https://github.com/AltanS/collie/commit/d5057d23))

- **A push notification arrives in the language you picked.** The bridge writes a notification title,
  and the bridge has no idea which language your phone is set to, so a German device still read an
  English line on its lock screen. The bridge now sends a short catalogue code beside the English
  title. The page leaves the active language's templates in Cache Storage, and the service worker
  fills them in there, which is the only place that runs when the app is closed. Any miss falls back
  to the English title, so a phone that has not opened the app since you changed language still gets
  a readable notice instead of a code. Thanks @jaehyun2yo (#310). ([ffd600cb](https://github.com/AltanS/collie/commit/ffd600cb))

- **A canary run now checks what Chat reads, not only what the screen shows.** Each of the six
  journal readers counts the row kinds and content kinds it has no branch for, and `bun run canary`
  reads the session each agent wrote in its own pane: a user item for the prompt the canary sent, a
  tool item for the file read it asked for, a reply below it, and nothing unrecognised. Above zero
  the run fails and NAMES the type, which is a gate against a vendor format change nobody has
  written a test for. Claude Code and Codex both broke reading on the day they shipped, while
  every test stayed green. No session file is saved anywhere, not even under `/tmp`: an
  agent's log carries file contents from every read and environment from every command, so only
  counts and item kinds are kept. `verified-versions.json` records the journal reader's verified
  version beside the screen reader's and `bun run harness:drift` prints a row per reader, because
  the two drift apart: a vendor can change what it paints without changing what it writes. ([160d2fab](https://github.com/AltanS/collie/commit/160d2fab))

- **The phone can now read a working session and hold it correctly.** It asks a pane's session what
  moved and merges the answer by turn, so a turn that changed is written over where it already sits
  and never drawn a second time lower down. An unchanged poll costs nothing and changes nothing. A
  machine still running an older Collie has no such read at all, and it now says so and names the
  remedy instead of looking like a pane with nothing to show. No screen uses this yet. ([a2231ee1](https://github.com/AltanS/collie/commit/a2231ee1))

- **Collie now holds the blocks a session reads as.** A turn from an agent's own record becomes what
  you would expect to see: your own turn, the reply, thinking behind a fold, and a card per step. A
  command carries its output, an edit carries its diff in the same colours the Changes view uses, and
  a run of steps folds to one line you can open. They were drawn and lived with in the session-stream
  prototype first and moved here whole, tests included, so there is one definition of a card and not
  two. No screen mounts them yet. ([c126f4fa](https://github.com/AltanS/collie/commit/c126f4fa))

- **A pane can be read as a chat instead of a terminal.** Turn Chat on under Settings →
  Experiments, and a pane draws the agent's own conversation: your turns, its replies, thinking
  behind a fold and a card per step, with the composer, the belt and the pane menu exactly where
  they were, so you still take the work over by typing. The switch is a row in the pane's ⋮ menu and
  the choice is one standing setting for the whole device. Older turns load on a tap. A pane with no
  session keeps the terminal and the row says why, and a crew member a release behind says to update
  it rather than pretending there is nothing to show. Terminal stays the default; the default flips
  in 2.0 (#316). ([2e46ea22](https://github.com/AltanS/collie/commit/2e46ea22))

- **The pane switcher can sort by which prompt cache dies first.** A third order beside Place and
  Activity, and the one with a deadline in it: the pane you should go to next is often neither the
  one you just left nor the one asking for you, it is the one whose cache you are about to pay to
  rebuild. A pane with no cache left to lose sinks to the bottom in its usual order. Like Activity,
  the order is read once when you open the sheet and held there, so a window ticking down never
  pulls a row out from under your thumb. ([f0e5856f](https://github.com/AltanS/collie/commit/f0e5856f))

- **Chat shows the work a codex pane did, not only the words it said.** Codex runs nearly everything
  through one custom tool, and the journal reader dropped that shape, so every file it read and every
  patch it wrote was missing from Chat. It reads now, with the command, the output and the exit code.
  Claude's pasted images reach the phone too, and an OpenCode patch or attachment shows as itself. ([38a93df6](https://github.com/AltanS/collie/commit/38a93df6))

- **Chat says a turn is still running, and shows what you queued behind it.** A compaction writes no
  row for minutes, so a compacting pane in Chat looked exactly like a finished one, and a message
  typed while the agent was busy appeared nowhere at all. The thread now ends with a working mark, and
  the queue sits under it in your own colour until the agent takes it. ([c906c453](https://github.com/AltanS/collie/commit/c906c453))

- **Collie drives tuios, as an experimental backend.** Set `COLLIE_MUX=tuios` to mirror a tuios
  daemon's sessions as spaces, its workspaces as tabs and its windows as panes, with the agent, its
  state and its conversation read from tuios itself. It needs tuios 0.8.3 or newer. The mux
  contract now also says that an agent name is one of Collie's harness names or `shell`. Thanks
  @Gaurav-Gosain (#321, #322). ([c1928e3d](https://github.com/AltanS/collie/commit/c1928e3d))

### Changed

- **The theme card is called Theme.** It was called Appearance, which is now the name of the
  section it sits in, and a page that says Appearance twice tells you nothing the second time. ([7527b53e](https://github.com/AltanS/collie/commit/7527b53e))

- **The canary runs pi the way an operator runs it.** pi was launched with `--no-session`, so it
  wrote no session file, so the journal check spec 05 added could never see pi at all. The flag is
  gone. pi was also the only agent exempt: Claude, Codex and opencode already write to their own
  stores on every canary run, because the canary isolates Herdr and deliberately leaves an agent's
  own configuration alone. `--thinking off` stays, because that one only makes a run cheaper. ([71cbe684](https://github.com/AltanS/collie/commit/71cbe684))

- **A canary ledger entry is judged per agent, not per run.** One agent failing used to block the
  ledger for every agent in the run. The run on 2026-09-30 showed the cost: a Codex three versions
  behind painted its update picker over the composer and failed one scenario, which blocked the
  entries for Claude 2.1.285 and opencode 1.18.33, both of which had passed all six of their own
  scenarios and were the two versions the drift check was asking about. Another vendor's startup
  prompt is not evidence about our Claude reader. A run with any failure is still a failed run. ([a4dfd913](https://github.com/AltanS/collie/commit/a4dfd913))

- **Claude Code 2.1.285, opencode 1.18.33 and pi 0.87.1 are verified, for both readers.** The canary
  ran all six scenarios against each of them, idle, drafts, sends, journal, narrow and start-exit,
  and every one passed. `journal` is the new scenario: it parses the canary's own session with the
  same adapter Chat uses, and asserts the kinds it finds. The ledger now carries two lines per
  agent, the screen reader's and the journal reader's, so `bun run harness:drift` covers Chat as
  well as the mirror. ([926a03e4](https://github.com/AltanS/collie/commit/926a03e4))

- **The canary's journal prompt cannot be answered without opening the file.** It used to say "read
  README.md, then reply with only OK", and "OK" needs nothing from the file, so an agent was free to
  skip the very tool call the scenario exists to watch. Codex did exactly that, on two versions. The
  canary's own README now carries a token, and the prompt asks for the token it names, which no
  agent can answer without reading. The reply is still one word. ([d0411bef](https://github.com/AltanS/collie/commit/d0411bef))

- **Codex 0.159.2 is verified, for both readers.** The canary ran idle, drafts, sends, journal and
  narrow against it and every one passed. The journal scenario saw Codex's `custom_tool_call` and
  counted no row it does not know, so the ledger now names 0.159.2 for the screen reader and for
  the journal reader, which had been last swept at 0.156.1. ([3bbd7863](https://github.com/AltanS/collie/commit/3bbd7863))

### Fixed

- **A long file name in Changes keeps both ends instead of losing its start.** The tree truncated a
  name from the left, which is correct for a path and wrong for a bare file name, so a folder of
  long names drew every row as `…m_breaks_under_podman_compose.md` with the very prefix that orders
  them cut off. A name now gives up its MIDDLE: the start and the extension both stay, the way a
  file manager does it. Compacted folder rows keep both ends too, so two repos holding the same deep
  folder chain no longer read as the same row. ([fe7015b0](https://github.com/AltanS/collie/commit/fe7015b0))

- **A two-pane box pans on a phone instead of losing its right half.** Claude Code's dynamic-workflow
  view draws the phases in a left pane and the running agents in a right one, and on a phone every row
  of it was cut off at the screen edge: the report showed a band of stacked rules with `· 74…` hanging
  off the side. The mirror only ever panned a box whose divider crossed a rule, `┼`, and a two-pane box
  never draws one, so it was refused and then clipped rather than wrapped. It now pans like any other
  wide table, which also gives back the model names in omp's `/model` picker and the Tips beside omp's
  welcome logo. Thanks @cryptiklemur (discussion #301). ([8c811438](https://github.com/AltanS/collie/commit/8c811438))

- **A pi turn that failed now says so, instead of vanishing.** When a provider call errors, pi
  writes the turn with no content at all, so the failure was not merely unexplained, the turn was
  simply missing from the history. The message pi recorded now shows as a note under the turn, set
  apart from anything the agent said, and an interrupted turn says so too while keeping whatever the
  model got out first. Measured over 44 real sessions before the fix: 37 errored turns, every one of
  them empty, and 15 interrupted ones. ([d2a0dec4](https://github.com/AltanS/collie/commit/d2a0dec4))

- **A pi session you rewound shows the path you are on, not both paths.** pi keeps every branch in
  one file, and Collie was reading all of it, so History showed the turns you had abandoned mixed in
  with the live ones and nothing said which was which. It now follows the branch you are actually on,
  and rewinding back onto a path you left brings it back. Eight of forty-four real sessions had
  forked, so this was the common case rather than the corner. ([d2a0dec4](https://github.com/AltanS/collie/commit/d2a0dec4))

- **pi's compaction, its branch summaries and a desk command all show up now.** Collie read only
  pi's message rows, so a compacted conversation read as though nothing had happened, an extension's
  own note never appeared, and a `!command` you ran at the desk looked like a message you had typed.
  Each now reads as what it is, set apart from anything the agent said. ([d2a0dec4](https://github.com/AltanS/collie/commit/d2a0dec4))

- **A panel drawn over opencode's composer no longer reads as a draft.** When another panel's box
  border crosses the composer bar, the draft walk could land on that border row and hand it back as
  the draft, so the phone showed a Draft in terminal card holding one line of box glyphs, and Take
  over would have typed that junk into the composer. A border row is excluded now, and it takes two
  conditions to be one: a corner or a junction on the row's interior, AND nothing but chrome inside
  it. Either condition on its own gets a real draft wrong. People type a bare rule inside a message,
  and a pasted `tree` carries a junction on every line, which read four typed lines back as the last
  one. The reader also held two glyph sets that disagreed about whether `─` and `│` were border
  glyphs, and there is one set now. Thanks @AndiWandHerd (#319). ([ed705820](https://github.com/AltanS/collie/commit/ed705820))

- **Two Chinese catalogues said a cache had expired when it had only gone cold.** A cold cache still
  works, it only costs more, so the word carries a fact. The Simplified Chinese notification setting
  read 缓存即将失效, which claims the cache became invalid, while the two strings next to it already
  said 变冷. Traditional Chinese said 冷卻 where its own neighbours say 變冷, which was consistency
  rather than fact. Both now use the wording their catalogue already uses everywhere else. ([1f46ffcf](https://github.com/AltanS/collie/commit/1f46ffcf))

- **German, Japanese and Korean said a cache had expired, and German said it was idle.** The same
  wrong fact sat in three strings in each of those catalogues. German is the worst of the three:
  "inaktiv" is German's own word for an IDLE pane, so one word named two different states. Each
  catalogue now uses the word its own cache chip already uses, "kalt" in German, コールド in Japanese
  and 콜드 in Korean. Nothing was newly translated; the word was already in the file. ([89724bc5](https://github.com/AltanS/collie/commit/89724bc5))

- **A notification about a finished agent now uses the same word as the app.** German said "ist
  fertig" and Spanish "ha terminado", while the status chip in the app says "abgeschlossen" and
  "completado". Every other push title matches its chip, so these two were the exception. Both carry
  the chip's word now, with an object, because German "ist abgeschlossen" is wrong for an actor and a
  bare "hat abgeschlossen" can be read as having locked up. ([89724bc5](https://github.com/AltanS/collie/commit/89724bc5))

- **A send on a Muse pane could type your message and then never submit it.** With block grammars
  on, tapping Send typed the text into the composer and stalled, three taps in a row, while the
  words sat in the box. The verify read after typing can catch the terminal's echo one character
  short, and the matcher accepted that prefix, so the phone bound a partial row and the bridge's own
  exact check then refused to submit it. A single-chunk send now waits for the echo's tail before it
  binds, which is what the multi-chunk loop already did. Thanks @jpcarranza94 (#312). ([1791674b](https://github.com/AltanS/collie/commit/1791674b))

- **`collie status` sees a launchd agent that Home Manager put in the user domain.** Collie probed
  only `gui/<uid>`, so an agent declared with `domain = "user"`, which is what a background service
  without a graphical login needs, read as not loaded while it was running. Both domains are probed
  now, the status line names the full target, and both registrations are reported when both exist,
  so a running background agent is not hidden behind a stopped GUI one. The pidfile fallback is
  unchanged. Thanks @mavam (#314). ([623401a6](https://github.com/AltanS/collie/commit/623401a6))

- **A URL an agent typed as itself is now a link you can tap.** Agents write a bare address
  constantly, a server they started or a pull request they opened, and only a `[text](url)` link ever
  became an anchor. A bare `http://`, `https://` or `mailto:` is now one too, in History and in Chat.
  It keeps the sentence punctuation it ended on, so a URL at the end of a sentence does not swallow
  the full stop, and a URL inside backticks stays code. ([8ab22bcc](https://github.com/AltanS/collie/commit/8ab22bcc))

- **Prose reads better: code wears the docs site's blue chip, and your own turns are findable.**
  Inline code was grey ink on a grey wash inside grey prose, with nothing to scan for. It now wears
  the same blue chip `colliepwa.dev` draws around a command, so one command looks like one thing
  wherever you read it. A short hash also stopped splitting mid-word across two lines, `6c` on one
  and `70894d` on the next, and a long token now breaks only when it cannot fit a line of its own.
  Your own turns carry the brand's orange as a wash, so scrolling back for what you asked is a
  glance rather than a read. ([8ab22bcc](https://github.com/AltanS/collie/commit/8ab22bcc))

- **Loading older turns in Chat keeps your place instead of throwing you to the top.** The tap puts
  forty turns in above what you are reading, and the scroller held its offset, so the block you were
  on slid down by the whole height of the new page. It gives that height back once the page paints,
  the way History's own scrollback and the terminal mirror's already did. ([1712ec61](https://github.com/AltanS/collie/commit/1712ec61))

- **A bulleted list now reads at the same pace as a paragraph.** A list took the base line height
  and a paragraph took the relaxed one, so the same prose was set two different ways depending on
  whether it had a bullet in front of it. A list was also the one place a code chip did not fit its
  line: two chips on consecutive wrapped lines touched. Lists and block quotes take the paragraph's
  own leading now, and the chip is a millimetre shorter so it sits inside the line rather than
  pushing it apart. ([30f2ac31](https://github.com/AltanS/collie/commit/30f2ac31))

- **A flag or a branch name in backticks is no longer cut in half at the line end.** A hyphen, a
  slash and a colon are ordinary places for a line to break, so `--force` could come out as `--`
  then `force`, and an address like `http://bluefin:8788` could be split across two lines. Anything
  short enough to fit a column of its own now stays in one piece, and only something genuinely too
  long to fit, a full path, breaks where it must. ([37161551](https://github.com/AltanS/collie/commit/37161551))

- **The belt's Display settings answer for the body you are looking at.** Over a Chat stream you got
  the terminal mirror's six rows, of which one did anything, with no way to tell which. The dock now
  carries the Terminal / Chat switch at the top, the same choice the pane's ⋮ menu writes, and below
  it the rows that apply: text size and tool calls for Chat, the mirror's five for the terminal.
  Text size comes first in both instead of last under five switches, and Chat's size is its own
  number, so a stream you can read does not mean a terminal you cannot. ([299fc465](https://github.com/AltanS/collie/commit/299fc465))

- **The belt's Display settings open as a sheet, so nothing under them moves.** They rode an in-flow
  panel that took its height out of the pane body, so opening the settings pushed the very thing you
  opened them to look at, and the terminal and Chat lists are different lengths, so switching bodies
  pushed it again. It is the pane switcher's own sheet now: it covers, and nothing above it shifts. ([71c096dc](https://github.com/AltanS/collie/commit/71c096dc))

- **Tool calls off now actually hides them in a live session.** The setting folded a run of steps to
  one line, and then a step that was still running opened the run again and kept it open for good.
  In a live session almost every run is running at some point, so the setting looked like it did
  nothing. A running step no longer overrules the choice. Your own tap still opens any run. ([6563ed77](https://github.com/AltanS/collie/commit/6563ed77))

- **The pane switcher gives two rows back to the panes.** The alarm line and the order control each
  took a full row of a phone sheet, above a heading, before the first pane. They now share one row,
  with the order as glyphs. The heading below still names the order in words, so nothing is lost. ([f0e5856f](https://github.com/AltanS/collie/commit/f0e5856f))

- **Chat says when a turn is still running, so a compaction is not an empty screen.** The terminal
  mirror shows the agent's own spinner, but Chat draws the agent's record, and a record gains nothing
  while a session compacts. So a pane that had been busy for minutes looked exactly like a finished
  one. The thread now ends with a working mark until the next turn lands. ([43827305](https://github.com/AltanS/collie/commit/43827305))

- **A phone paired under a name outside ASCII can reach a crew member again.** A header value must
  be plain bytes, so a label like `폰` made every forwarded call fail with a 500 before it left the
  lead. A name like that now travels percent-encoded (RFC 8187) and the member reads it back whole,
  for its allowlist and its audit line. An ASCII name is sent exactly as before. Reported by
  @dmstjd1024 (#324). ([06374508](https://github.com/AltanS/collie/commit/06374508))

- **A Codex pane pursuing a goal keeps its input box.** A Codex `/goal` puts `Pursuing goal (…)`
  at the right end of the status row, and Codex paints the spaces in front of it in the colour of
  the field before. Collie read that as a row it did not know, so it lost the input box: the pane
  showed the unread-dialog card and every reply from the phone was refused. The padding now reads
  as the gap it is. Reported with a capture by @CorrectRoadH (#317). ([ed647185](https://github.com/AltanS/collie/commit/ed647185))

- **The canary judges the read send by its token and starts codex without its update prompt.**
  The `sends` scenario accepted only a bare "OK" as an answer, so a codex that replied with the
  README token the read prompt asks for still timed out. A message can now declare its expected
  reply. Separately, codex's "Update available" prompt (default answer: Update now) took the place
  of the composer at startup, so the canary now launches codex with
  `check_for_update_on_startup=false`. ([9dd96df0](https://github.com/AltanS/collie/commit/9dd96df0))

### Docs

- **The docs have a Guides section, and it opens with an install in five minutes.** Install was
  the only way in, and it answers every system and every front door at once, so a first-time reader
  had to find their own path through it. The new guide walks one path: Tailscale, Herdr and the
  install script on the computer, then the home screen and `collie pair` on the phone. The README's
  documentation table splits into Guides and Reference, and `collie docs five-minute-install` prints
  the guide from the binary. ([9243abd2](https://github.com/AltanS/collie/commit/9243abd2))

- **Every Settings path in the docs names its section.** The settings page became an index of four
  sections, so fifteen instructions across seven pages pointed at a card that had moved. Paired
  devices and Updates are under System, the harness shortcuts, the typeface and the language are
  under Appearance, and zen and Changes are under Device. Two were wrong twice over: one told you
  to open Appearance and pick a theme, which is now the Theme card inside that section, and two
  named a "notifications" section that never existed and is called Alerts. ([95bf1b74](https://github.com/AltanS/collie/commit/95bf1b74))

- **Changes has its own docs page, and the README names it as a feature.** The view was
  documented only as one section of the Configure page, which said it opens from the pane menu and
  never updates on its own. Both had stopped being true. `docs/changes.md` covers both ways in, the
  list, the diff, the last commit, the 5-second refresh, how the folder and nested repos are found,
  the read-only rules and the limits. `collie docs changes` prints it from the binary. ([1948ef6b](https://github.com/AltanS/collie/commit/1948ef6b))

## [1.14.2] - 2026-09-28

### Docs

- **A walkthrough for running Claude Code from your phone.** `docs/claude-code-on-your-phone.md`
  first keeps Claude Code alive in tmux, Herdr or zellij when SSH drops, and shows how to run
  several sessions at once. Then it takes one path end to end, from install to answering an agent
  from the Keys tray. `collie docs claude-code-on-your-phone` prints it. ([2bec9cbd](https://github.com/AltanS/collie/commit/2bec9cbd))

## [1.14.1] - 2026-09-27

### Fixed

- **Grok 1.0.41 panes send from the phone again.** Grok 1.0.41 adds `Shift+Enter/Opt+Enter:newline` to the key-hint row under its input box while a draft is in it. Collie did not know a hint with two keys joined by `/`, so it lost the input box as soon as the phone typed the message: the send stopped with "Message didn't reach the input box", and the unread-dialog card covered the pane. Collie now reads that hint, and the `Alt` spelling a Linux Grok may print. Every other saved pane reads as before. Thanks @CorrectRoadH for the pane capture (#294). ([7c9f6497](https://github.com/AltanS/collie/commit/7c9f6497))

## [1.14.0] - 2026-09-27

### Added
- **The canary opens real dialogs and sends to a busy agent.** `bun run canary --dialogs` asks Claude for a Bash command, a WebFetch, an AskUserQuestion and a plan, and Codex for a command and a file edit, then checks the card, the labels and the free-text lock with Collie's readers, presses the declining key where it was measured live and checks the file was not written. It also sends to each agent while Herdr says it is working. Run against the 1.13.1 readers, it fails on the Claude permission pointer on row 2, the amend note, WebFetch and the Codex patch approval.
- **A picture pi shows reaches the live mirror.** pi draws a picture by direct placement, which leaves nothing on the screen Collie reads, so until now its pictures reached the phone only through History. When a pi or Oh My Pi turn finishes, the pane reads the agent's log once and shows that turn's newest picture as one card right after the mirror, where the view already sits. A later turn without a picture removes the card, and older pictures stay in History. A picture a placeholder already shows is not shown twice, and other agents pay no extra read. This closes the gap from #292. Thanks @leiyangyou.
- **A pane can be pinned to the top of the dashboard and the switcher.** Hold a dashboard row or a pane pill, or open the pane's ⋮ menu, and tap Pin to top. Pinned panes lead the Panes, Focus and Changes lists and the switcher, under the summary line, in the dashboard's own order, and a status change never moves them. Each pane is still listed once, and its workspace still counts it. Pins stay on this device, and closing the pane from Collie removes its pin. Thanks @wwilson1017 for the idea (#286).
- **A crew's dashboard can hide a machine.** Open the Machines sheet and turn off Show on the dashboard beside a machine, and its workspaces leave the Panes, Focus and Changes lists. One dimmed chip in the workspace strip stands in for the machine, keeps its most urgent status dot, and shows the machine again on a tap. The machine you are on always shows, a tap on a machine's row still goes there, and pinned panes still lead the list. The summary line, the Focus badge and notifications still count every machine. The choice stays on this device. Thanks @dantebarba for the idea (#288).
- **Each workspace heading on the dashboard opens a new tab.** A "+" now ends every workspace heading on Panes and Focus, after its counts. A tap opens a new tab in that workspace, in the workspace's own folder, and steps into its fresh shell, as the tab strip's "+" does, so a new tab no longer means opening a pane first. In a crew the tab opens on the machine the heading belongs to. A machine whose multiplexer cannot open tabs shows no "+", and a machine that is not taking writes says why when tapped. Each heading is 8px taller to make room. Thanks @dantebarba (#290).
- **OpenCode panes get their own reader.** Collie now finds OpenCode's input box, so a reply is typed, checked on screen and only then submitted, and a draft left in the box shows on the phone. A permission dialog for a shell command, a file edit or a web fetch shows as buttons, Allow once, Allow always and Reject, and the Always allow confirmation that follows it is a second card with Confirm and Cancel. Each button walks OpenCode's own pointer with the arrow key and then presses Enter, and never types a digit. A picker such as the agent list or the command palette gets the one Escape button. Checked on OpenCode 1.18.32 at full width and at 50 columns. Thanks @Gabrielribeiroic (#255).
- **An X on the actions belt empties the text box.** While the phone's text box holds text or an attachment, an X stands at the belt's right end, left of the Changes button, or left of the Switch button on a pane without one. One tap clears the text, the attachments and that pane's saved draft, keeps the keyboard up, and sends nothing to the pane. The X then becomes Undo, which puts all of it back, until the next keystroke, attachment, send, tap on another belt button or pane change. Undo has no timer, so the belt never shifts under a tap on its own. Thanks @dantebarba (#291).
- **The new-space sheet offers the folders you opened before.** Under the Directory field, the sheet lists Favourites, then Recent, for the machine the space goes to. Recent holds the last 8 folders a space was created in, counting only creates that worked and named a folder, and never home. A tap on a row fills the field and creates nothing. The star beside a row moves it to Favourites, up to 12, and a second tap moves it back. Each machine keeps its own list in `folders.json` in its state directory, so every phone and tablet sees the same folders, and a machine on an older version shows no list. Thanks @dantebarba (#289).
- **A hold now shows while you press.** A dashboard row, a pane pill, a workspace chip or a tab starts to press in and tint a moment after your finger lands, and the look fills until the hold opens its menu half a second in, so a hold in progress no longer looks like nothing is happening. A quick tap changes nothing. The look ends as the menu opens, with one short buzz where the phone supports it. With reduced motion, only the tint shows.
- **The dashboard says once that a hold pins a pane.** On the Panes tab, while nothing is pinned and at least three panes show, one quiet line under the summary line reads "Hold a pane to pin it here.", or "Right-click a pane to pin it here." on a device with a mouse. Its X, or your first pin from any screen, removes it for good on that device, also after you unpin everything.

### Fixed
- **Starting an update no longer shows the previous update as finished.** On a lead that had updated before, "Start update" showed "Update finished" at once, with the clock at 0:00 and the old versions on every row. The real update then showed as "started on another device", and this phone's own step never came. The bridge now sends the new update's id with its answer, and the phone stays on "Checking" until that update reports its first state. If none comes within three minutes, the phone gives the app back. The Updates card also stops showing the previous result, such as "Updated to 1.13.2.", while it waits. The update to this version still runs the old phone code, so it can show the old screen one last time.
- **A busy Codex pane keeps its input box on the phone.** While Codex 0.156.1 writes the first reply of a new conversation, its status row ends in a small spinner until the conversation gets its title. Collie painted that spinner over as starfield decoration, then read the row as no status row, found no input box, and showed the unread-dialog card over the working pane. A message sent in that time was refused as blocked. The spinner now counts as the end of the status row, but only as the very last mark and only after a complete status row. Found by the harness canary.
- **`collie update` on Windows gets through the build and the binary swap.** The build child keeps the `Path` a Windows environment carries, and the swap renames the `collie.new.exe` that Bun writes. Windows stays best effort: only the community lifecycle in `contrib/windows/` is maintained. Thanks @mqmalagris (#296, #297, #298).
- **The phone can update a Claude plugin marketplace.** The Marketplaces tab of Claude Code's `/plugin` screen, and the page one marketplace opens, showed only the unread-dialog card with Escape, so the phone could not press `u`. Their footers say "Enter to select", which Collie took for a question it could not read. Collie now reads both screens by their own words and shows Select, Update, Go back and the arrows, and after `u` it shows Apply changes and Cancel. Remove is never a button, on the tab or on the page, because its confirm is not a screen the phone can read. In the full-screen renderer, a marketplace page taller than the pane hides its footer, and the phone still shows no buttons there. Checked on Claude Code 2.1.283 in the classic and full-screen renderers, at 40, 82 and 120 columns.
- **A Muse pane with background tasks keeps its input box.** While a background task exists, Muse draws a small task list between its input box and its status line. Collie did not expect a row there, found no input box, and drew the unread-dialog card over a live pane, and an approval asked while a task ran lost its buttons the same way. Collie now reads the task list as part of Muse's own frame and leaves it off the phone, so replies, drafts and the status line work again, and an approval over one or two tasks shows its buttons. An approval over three or more tasks, or a question over any, keeps the card and its Escape, because the phone could not tie a tap to it there. While the task list has the keyboard and offers x to stop a task, the phone does not type into the pane. Checked on Muse Code 1.4.0. Thanks @jpcarranza94 (#304, #305).
- **History no longer shows Claude's injected text as your messages.** Claude Code marks the rows it writes itself with `isMeta`: a skill's instructions after a slash command or a Skill call, the source path of an attached image, the caveat before a local command. History showed them as your turns, and the jump between your messages stopped on each. They are now left out. A prompt Claude sends on its own, such as another session's message, a scheduled or `/loop` wake-up, or the go-on after a usage limit, stays as a System note, because the reply after it answers it. Thanks @GGGODLIN (#306).
- **Codex 0.157 panes keep their input box on the phone.** Codex 0.157.0 turned on its full-screen layout by default. That layout puts one more row under the status row, `? for shortcuts`, `tab to queue message`, or `← for agents · ? for shortcuts` when Codex runs through its background server. Collie expected the status row to be the last row, so it found no input box on any such pane, showed the unread-dialog card over it, and refused every send. Collie now takes that one row under the status row as part of the input box. Checked on Codex 0.157.1 with the harness canary, dialogs and a busy send included. Thanks @CorrectRoadH for the pane capture (#294).
- **A rewrapped row no longer leaves one word alone on its last line.** An agent writes each paragraph as one row as wide as its pane, and the phone breaks that row again at its own width, which often left a single word, such as "form.", on a line of its own. The mirror now asks the browser to balance those lines, so a word moves down to keep it company. The text itself does not change, so find, links and copy work as before, and no row gets taller. Chrome and other Chromium browsers do this on every screen. Safari 26 skips it on a screen that holds a row too wide to break, such as a rule or a table, which is most screens, and older Safari breaks lines as before. Thanks @jpcarranza94 (#302, #303).

## [1.13.3] - 2026-09-26

### Fixed
- **Codex panes started with no Herdr client attached show their input box again.** A Codex started while no Herdr client was attached gets no answer to its colour queries, and 0.156.1 then paints the ` · ` between its status fields with no colour at all. Collie read that row as no status row, found no input box, and showed the unread-dialog card over every idle pane. The status row now accepts a separator with no paint, with the rest of the rule unchanged: coloured fields, one paint for every separator, and the row at the bottom under the `›` prompt (#294). ([764300f0](https://github.com/AltanS/collie/commit/764300f0))
- **A new Codex pane no longer blames the Herdr integration for its missing history.** Codex reports its session to Herdr only when its first prompt is sent, not when it starts, so every fresh Codex pane showed "has not reported a session" and told you to reinstall a hook that was fine. The phone now says Codex reports its session after its first message, and names the remedy only for a note that stays after a reply: review its hooks with `/hooks` in Codex (declining to trust changed hooks turns the Herdr hook off while `herdr integration status` still says current), or update the integration. `collie doctor` lists such a pane under `agent-sessions` and `integration-codex` as not reported yet, not as a fault (#294). ([2a3594bf](https://github.com/AltanS/collie/commit/2a3594bf))

### Docs
- **A misread screen is reported with the pane's raw text.** The bug report form and the troubleshooting page ask for `herdr pane read <pane-id> --source recent --lines 200 --format ansi`, which shows the colours and dim text a screenshot cannot. ([d017c327](https://github.com/AltanS/collie/commit/d017c327))

### Added
- **A ledger records which agent version each reader was last verified on.** `verified-versions.json` carries claude, codex, grok, omp, agy, antigravity and muse's last-verified version and date, plus opencode and pi's installed one (no reader yet, so `how: "unverified"`). `bun run harness:drift` (`scripts/harness-drift.ts`) compares the ledger against what's actually installed and prints `same`, `NEWER, run the canary`, `older` or `not installed` per agent. It is read-only: it only runs `<agent> --version`. ([6fcf98b0](https://github.com/AltanS/collie/commit/6fcf98b0))
- **A canary drives real agents and checks what the phone would read.** `bun run canary` starts claude, codex, opencode and pi in a Herdr session of its own (`collie-canary`), types 15 kinds of draft and three real sends, and judges each screen with Collie's own readers and each send with the client's reply guard over the bridge's reply handler, in process. It never touches another session's panes, a port or a paired device, and it tears everything down. `--readers` points it at an older checkout, `--record` writes a clean agent into the ledger. See `scripts/harness-canary/README.md`. ([0852cc7b](https://github.com/AltanS/collie/commit/0852cc7b))

## [1.13.2] - 2026-09-26

### Fixed
- **Codex 0.156 panes take your messages again.** Codex 0.156 paints its status row in a new way, so Collie found no input box on a default Codex pane and showed "Collie cannot read this dialog" over an idle prompt, and a draft with line breaks never read either. Its rewritten folder-trust prompt, its file-edit approval, a command approval with only two options, and approval options that wrap on a narrow pane now show as buttons; each of their keys was tried live on Codex 0.156.1. The update prompt and the /model and /permissions pickers keep the Esc card. ([100bf7e3](https://github.com/AltanS/collie/commit/100bf7e3))
- **Claude permission dialogs show their buttons in every state.** Collie knew a permission dialog only by its "Tab to amend" hint, which Claude hides once the pointer leaves the Yes and No rows, and the web-fetch dialog has no hint at all. All of these showed "Collie cannot read this dialog". Collie now reads the dialog's own question and options. A note opened with Tab shows as text being written in the terminal, and the other buttons wait while it has the keyboard, because a digit there is typed into the note. The reject button stays a button on a narrow pane, where its "(esc)" wraps onto a row of its own. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e), [c71085e7](https://github.com/AltanS/collie/commit/c71085e7))
- **A tapped answer no longer types into the "Type something" field.** With the pointer on a question's "Type something" row, tapping another answer typed its digit into that field, and the Enter after it submitted the wrong answer. Typed text also showed as an answer button. The row is now read as a field: the buttons wait while it has the keyboard, and typed text shows as text. On a multi-select or multi-question step with the pointer on the field, the Esc card shows instead. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))
- **A draft with a pasted rule or prompt line no longer blocks sending.** A message with a `────` line or a `❯` line in it, as in pasted terminal output, hid Claude's input box from Collie, so Send stalled with "Message didn't reach the input box" and the pane showed the Esc card. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))
- **Claude's slash-command screens show their keys.** Newer Claude opens /mcp, /hooks, /memory, /rewind, /effort, /status, /usage, /export and /login with a new top edge, so they showed the Esc card. They show their own keys again. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))
- **Plan approval reads with a custom Claude config folder.** When the plan file lived outside `~/.claude`, the plan approval showed the Esc card. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))
- **Questions show in full.** A question that wrapped, or that Claude wrote on two lines, kept only one of its lines and a stray `│`. Permission options that wrap on a narrow pane keep their whole label. ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))
- **Starting or quitting Claude no longer flashes the Esc card.** For a moment before Claude draws its screen, and after it exits, the shell prompt showed "Collie cannot read this dialog". ([71b28a1e](https://github.com/AltanS/collie/commit/71b28a1e))

## [1.13.1] - 2026-09-24

### Fixed
- **An update started from the phone on a Mac installs again.** The updater the phone starts inherits the service's install folder, so the new version's start-up check read the old version and gave up silently, and its build and restart would have used the old folder too. The same held on Linux without a systemd user manager, and on a Mac crew member following its lead. Each of those steps now finds its own folder, as a `collie update` typed in a terminal always did. An update that gives up before the switch now ends on "The update failed on <machine>" with the reason, instead of the panel closing, and the updater's own output is kept in `update-runner.log` in the state folder (ADR 0064, docs/upgrading.md). The update to 1.13.1 itself still runs the old updater, so on a Mac run `collie update` in a terminal once; updates after it work from the phone. Reported by @ubuntudroid (#283). ([3067bd21](https://github.com/AltanS/collie/commit/3067bd21), [5bd705a5](https://github.com/AltanS/collie/commit/5bd705a5), [8ae50191](https://github.com/AltanS/collie/commit/8ae50191))

## [1.13.0] - 2026-09-24

### Added
- **A pane can show what changed in its workspace since the last commit.** Tap the Changes mark at the right end of the actions belt, beside the pane switcher: the files changed in the git repos of the pane's workspace folder, and in repos inside it, grouped by repo with added and removed line counts. Tap a file to read its diff, then step to the next file from there. It only reads: nothing is staged or committed, a repo's own hooks and filters never run, and it never reaches the network, not even to fetch a file a partial clone left out. Settings → Changes decides whether it looks inside the folder and how deep. zellij panes show no Changes mark, because zellij reports no folder (ADR 0065). Thanks @lighcen. ([d887f939](https://github.com/AltanS/collie/commit/d887f939), [8094592c](https://github.com/AltanS/collie/commit/8094592c), [ef25b35d](https://github.com/AltanS/collie/commit/ef25b35d), [9212ced7](https://github.com/AltanS/collie/commit/9212ced7))
- **The Changes list can show as a folder tree, and a filter narrows it.** Toggle List or Tree at the top; the Filter button matches files by path and by status letter, and Previous and Next step through only the files shown. The filter opens as a card floating over the list rather than a row that pushes it down, and a tap outside it or Escape closes it without clearing it. ([709b592b](https://github.com/AltanS/collie/commit/709b592b), [9212ced7](https://github.com/AltanS/collie/commit/9212ced7))
- **A diff in the Changes view shows syntax colour.** TypeScript, JavaScript, Python, Go, Rust, shell, YAML, JSON, CSS, Markdown and 16 more languages are coloured once the highlighter loads, which happens only when you open such a file. The plain text shows first and nothing moves when the colour arrives. A diff over 2000 lines stays plain (ADR 0065). ([9593ffcd](https://github.com/AltanS/collie/commit/9593ffcd))
- **Every pane in a workspace shows the same Changes list, and the header names the workspace and its folder.** The folder is the workspace's own when herdr or tmux keeps one, else the folder that holds all its panes, never your home folder or above it; past that the pane's own folder stands in. `GET /api/workspace/<id>/changes` asks for the same list without naming a pane, forwarded across a crew like the pane route. Opened from a pane, the list marks the repo that pane works in with "This pane" and scrolls to it, and when repos sit deeper than Settings lets it look, the list ends with a note that links to that setting (ADR 0065). ([9212ced7](https://github.com/AltanS/collie/commit/9212ced7), [a2a05201](https://github.com/AltanS/collie/commit/a2a05201))
- **The dashboard has a footer with three tabs: Panes, Focus and Changes.** Panes is the dashboard as it was. The tab you pick is kept on this device, and the footer, the workspace strip and the summary line stay put when you switch (ADR 0066). ([b10cded5](https://github.com/AltanS/collie/commit/b10cded5), [433db135](https://github.com/AltanS/collie/commit/433db135), [82f93398](https://github.com/AltanS/collie/commit/82f93398))
- **Focus shows only the panes that need you.** Each workspace keeps only its panes that are blocked or ready and unseen, and a workspace with none drops out. Nothing is sorted: workspaces and panes keep their order, each heading still counts its whole workspace, and the summary line still counts every pane. When nothing needs you, the tab shows the "Nothing needs you" line instead of an empty list. The tab shows a red count only for panes blocked on you. When none is blocked but a finished pane waits unseen, it shows a quiet dot and no number (ADR 0066). Thanks @simplysoft (#270). ([b10cded5](https://github.com/AltanS/collie/commit/b10cded5), [433db135](https://github.com/AltanS/collie/commit/433db135), [53d6a5c1](https://github.com/AltanS/collie/commit/53d6a5c1), [82f93398](https://github.com/AltanS/collie/commit/82f93398))
- **The Changes tab lists every workspace with its changed files.** Each row shows how many files changed and the lines added and removed, and a tap opens that workspace's Changes. A clean workspace shows "No changes" and a zellij workspace "No folder". The counts are read the moment you open the tab or come back to the app, refresh every 5 seconds while the tab is open, and stop when you leave it or the app is hidden (ADR 0066). ([b10cded5](https://github.com/AltanS/collie/commit/b10cded5), [fd913052](https://github.com/AltanS/collie/commit/fd913052))
- **An open Changes screen refreshes itself every 5 seconds.** The list, and the diff of an open file, are read again while the app is visible, and nothing moves when nothing changed. A file that is no longer changed says so in place, and after two failed reads in a row the header says "Not updating". Phones and tabs that read the same workspace at the same moment share one git run (ADR 0065). ([97ba7665](https://github.com/AltanS/collie/commit/97ba7665), [84d29139](https://github.com/AltanS/collie/commit/84d29139))
- **Changes can show a repo's last commit.** Agents commit their own work, so the list often empties right after the change you wanted to read. A clean repo now offers "Show last commit": its subject, short hash, author and age, then its files with the same list, tree, filter and diffs. A newer commit or new uncommitted work shows as a quiet line to tap, never swapping what you read. It reads HEAD only, with the same hardening as the rest of the view (ADR 0065). ([c57edb39](https://github.com/AltanS/collie/commit/c57edb39))
- **A Muse request for network access shows its answers as buttons.** Muse asks before it reaches a host, and Collie used to show only the card with Esc, which answers No. The four answers now show as buttons, with the host and the full address on screen above them. Thanks @jpcarranza94 (#280). ([ca7dab20](https://github.com/AltanS/collie/commit/ca7dab20))

### Changed
- **An update puts the phone in update mode until it is done.** Tap "Update all machines to X" on the Updates page, and the first screen of update mode names every machine and this phone, with Start update as the confirm; the card no longer grows a confirm inside itself. While the update runs, your app stays in view behind a veil and takes no tap. A band at the top says "Update mode · step N of 7" with a clock and a progress bar, and a panel at the bottom walks the seven steps: Check, Build, Restart, Verify, Other machines, This phone, Done. Each machine has a row with its versions, and only the row that is working moves. A member that stops answering, or waits out its hourly limit, gets "Skip <name>" and "Keep trying". The update ends on a Done, Rolled back or Stuck screen with "Back to the app", never on a toast alone. Another phone or tablet keeps its app and shows one line, "Update running, started on another device", with View. Nothing in the panel moves from one step to the next (ADR 0064). ([bf0305c4](https://github.com/AltanS/collie/commit/bf0305c4))
- **The actions belt is 15% larger, and Settings can make it larger still.** The band, its pills, icons and words grow together: the band is 45px, up from 40, and the icons 18px, up from 16. Settings → Action belt size offers Default, Large and Larger. ([79e40bb5](https://github.com/AltanS/collie/commit/79e40bb5))
- **The Changes and Switch pane pills tint and shrink slightly on press, and tint more softly on hover.** A tap is now visibly acknowledged on both. ([bd2adca2](https://github.com/AltanS/collie/commit/bd2adca2))
- **The Changes tab's counts fade in instead of popping.** Each row holds a quiet placeholder until its count arrives, and coming back to the tab shows the last counts at once (ADR 0066). ([5b811bda](https://github.com/AltanS/collie/commit/5b811bda))
- **The dashboard's second tab is called Focus, and wears `CircleDot`.** It was "Needs you", then "Attention", both of which read as a demand even when nothing needed you; the count still shows only when something does, and the dot marks unseen finished work, not a notification (ADR 0066, ADR 0068). ([433db135](https://github.com/AltanS/collie/commit/433db135), [82f93398](https://github.com/AltanS/collie/commit/82f93398))
- **The six translated catalogs catch up on everything added since 1.12.1.** The Changes view, the belt size setting, the dashboard footer, update mode and the Focus badge's screen-reader labels had landed in English only; German, Spanish, Japanese, Korean, Simplified Chinese and Traditional Chinese now carry a wordsmith translation instead, English is untouched. ([ecaef3bb](https://github.com/AltanS/collie/commit/ecaef3bb))
- **Older strings that still read English in those six languages are translated too.** The harness bar, spaces, notification and pane settings, the prompt-cache sheet, the first-run tour and the update screen predate 1.12.1 and had never been translated. ([cc94bb39](https://github.com/AltanS/collie/commit/cc94bb39))
- **Tapping a Changes tab row or a pane row glides it into the screen it opens, and the back arrow glides it back.** Where the browser supports view transitions (Safari 18, Chrome): a Changes row's name and counts, or a pane row's status dot, icon and name, fly into the arriving header, right from the first frame; the in-app back arrow flies them back down into the row you tapped, or crossfades instead when that row is out of sight. A pane's first read now starts as your finger lands, so it usually opens a little sooner. The swipe back, reduced motion and a slow read all skip the glide for the plain slide instead, never a frozen screen (ADR 0069). ([1a8a60a8](https://github.com/AltanS/collie/commit/1a8a60a8), [e93f5ed3](https://github.com/AltanS/collie/commit/e93f5ed3), [c5f0d891](https://github.com/AltanS/collie/commit/c5f0d891))

### Fixed
- **OpenCode 2 panes show their history and their prompt-cache chip again.** OpenCode 2 keeps its sessions in new tables in the same database, which Collie did not read, so History said there was no log and the cache chip never appeared. Collie now reads both the OpenCode 1 and the OpenCode 2 tables, and when a session sits in both, it reads the one written last. Thanks @kekefigure. ([f0b9ba24](https://github.com/AltanS/collie/commit/f0b9ba24), [ac2bc91e](https://github.com/AltanS/collie/commit/ac2bc91e))
- **The last action on the belt now stops clear of the pane switcher.** Scrolled to the end, the last pill used to stop under the fade in front of the switcher mark. It now stops before the fade, with 16px of room to spare. ([8094592c](https://github.com/AltanS/collie/commit/8094592c))
- **The update screen no longer closes while the other machines still update.** It used to close, and say "Crew updated", the moment the lead finished, while a member was still waiting its turn. It now stays on the members' step until each one has arrived or you skipped it (ADR 0064). ([bf0305c4](https://github.com/AltanS/collie/commit/bf0305c4))
- **This phone reloads once, at the end of an update, and comes back to the update screen.** The reload used to happen whenever a new app arrived, even in the middle of the run, and the page that came back had forgotten which update it was showing. It now waits for the phone's own step, and the update screen reopens after the reload at the step it had reached. A new app that arrives while you have unsent text now waits for that text too, instead of reloading over it (ADR 0064). ([bf0305c4](https://github.com/AltanS/collie/commit/bf0305c4))
- **The "done" message no longer repeats every time the app loads.** It showed again on every load for ten minutes after an update. The Done screen replaces it, on the phone that started the update only (ADR 0064). ([bf0305c4](https://github.com/AltanS/collie/commit/bf0305c4))
- **"Try minibuch again" names the machine.** A retry for one member used to say "Retry crew update". The button and the screen it opens now name the machine the retry is for. ([bf0305c4](https://github.com/AltanS/collie/commit/bf0305c4))
- **A drag-opened pane switcher no longer drops out and slides back in.** Opening the switcher with the upward drag on the belt sometimes showed it open, vanish and open again, when the pane redrew while the switcher was up. It now stays put, and a tap-open still slides in. Thanks @enieuwy. ([8e6884e6](https://github.com/AltanS/collie/commit/8e6884e6))
- **The keyboard stays open on a foldable's cover screen.** On a narrow cover screen such as the Galaxy Fold's, opening the keyboard made the page read as sideways, so auto-zen started and closed the reply box you had just tapped. Auto-zen now starts only when the phone itself is turned. Thanks @welldoingk. ([a888be40](https://github.com/AltanS/collie/commit/a888be40), [9e4c6d54](https://github.com/AltanS/collie/commit/9e4c6d54))
- **Update mode keeps the screen on and fits a larger text size.** The phone that started an update keeps its screen awake while the panel is up, so the clock and the progress bar do not stop when the phone would dim. With a larger text size, the panel now grows as one piece and the list of machines scrolls, where the note used to cut its second line in half (ADR 0064). ([329ab399](https://github.com/AltanS/collie/commit/329ab399))
- **The Changes filter overlay never says "Filter files" twice.** Its dismiss surface is hidden from assistive tech, and its own Clear action stays reachable while the card covers the list. ([e1ecf92f](https://github.com/AltanS/collie/commit/e1ecf92f))
- **The Changes screens no longer flicker while an agent edits a file.** On every 5 second refresh that brought a changed diff, the whole diff dropped its syntax colour and redrew every row; now only the new lines and the line numbers that moved change, in colour. A refresh waits while you scroll or touch the list, and runs a second after you stop. The dashboard's Changes tab no longer redraws when its numbers stay the same. ([f5bedf5a](https://github.com/AltanS/collie/commit/f5bedf5a))
- **A swipe back goes up one level.** On the installed app the edge swipe used to land on the last screen you saw: the pane you switched away from, the History you just closed, or Settings again after its back arrow. Switching panes, tabs, spaces or machines now replaces the screen instead of stacking it, and every back arrow steps back to the level it came from, so the swipe and the arrow agree. A pane opened from a notification has the dashboard behind it, a notification tapped while the app is open no longer reloads it, one tapped during an update opens its pane once the update is done, and a swipe no longer plays the app's own slide on top of the phone's. A link opened in a browser tab keeps the browser's own history (ADR 0067). ([a9c2a570](https://github.com/AltanS/collie/commit/a9c2a570), [039fcafa](https://github.com/AltanS/collie/commit/039fcafa))
- **A Muse message with a blank line in it sends again.** A paragraph break in the draft made Collie lose Muse's input box: the send typed but never submitted, the unread-dialog card covered the box, and each retry typed the message once more. Collie now reads the box across blank lines. Thanks @jpcarranza94 (#274). ([6007c05d](https://github.com/AltanS/collie/commit/6007c05d))
- **A slash command sent to a Muse pane runs.** Typing `/usage` opens Muse's command list under the input box, and Collie read that list as part of the message, so the send never matched and stalled. When the list shows exactly the command you typed, Collie now reads the command alone and submits it. A partial command still stalls, because Enter there would run the suggestion instead of what you typed. Thanks @jpcarranza94 (#276). ([878bae0e](https://github.com/AltanS/collie/commit/878bae0e))
- **A photo or file sent to a Muse pane submits.** Muse turns a typed image path into `[Image #1]` and puts quotes around any other path, so the input box never showed the text Collie typed and the send stalled. Collie now maps each image mark back to its path, in order, and drops the quotes before it compares. Thanks @jpcarranza94 (#278). ([1af5f920](https://github.com/AltanS/collie/commit/1af5f920))

## [1.12.1] - 2026-09-23

### Changed
- **A chip whose marker you deleted now says it goes in front.** Send puts such an attachment's path in front of your text. The chip now shows this before you send: its border turns dashed, its number gains an arrow, and its title and screen-reader text say where the path will go. Type the marker back to clear it (ADR 0060). ([f61a3a4e](https://github.com/AltanS/collie/commit/f61a3a4e))
- **A pane keeps its place when its state changes.** Every list of panes now keeps the order your multiplexer shows: the pane strip inside a pane, the space view, the Switch pane sheet and a crew's dashboard. Before, a pane that blocked jumped to the top of these lists and moved back when it resumed, and in a crew a peer's blocked pane pulled that whole machine above the lead. The Switch pane sheet now groups panes by workspace like the dashboard, with one line on top that counts what needs you and takes you to the first of it. In a crew, the pane strip also stops showing another machine's panes from a tab with the same id (ADR 0063). ([bac490b4](https://github.com/AltanS/collie/commit/bac490b4))

### Fixed
- **A block or Powerline character no longer stops short of its row.** In the terminal mirror, a prompt pill's round caps and a bar of `█` stopped a quarter of a row short, so the pill stepped in at both ends and stacked bars showed a stripe between rows. Block characters are now painted to the full row, so stacked rows meet and a half block splits at half the row. Powerline caps and arrows are painted to the same height as the pill beside them. The text, find and copy do not change. Thanks @enieuwy (#268, fixes #267). ([41483043](https://github.com/AltanS/collie/commit/41483043), [0dbefc92](https://github.com/AltanS/collie/commit/0dbefc92))
- **A crew update takes a member straight to the new release.** If the update to 1.12.0 left a machine behind, update the lead to 1.12.1 and tap Retry crew update on the Updates page once. A member one release behind its lead took the lead's old release the moment the update was confirmed, then refused the new one for an hour, and the Updates page said "no change for 20 minutes". The lead now hands out a turn only once it runs the new release itself. A member takes the second step of a run it already joined without waiting out its hour. And a member that is waiting on its own once-an-hour limit reads "rate-limited, retries in about N min" instead of failing. If the lead's own update rolls back, the crew run ends at once and each member's line says it was not started. No crew run stays open past 2 hours, and a new update waits until it ends (ADR 0062). ([2beed08a](https://github.com/AltanS/collie/commit/2beed08a), [a169b75b](https://github.com/AltanS/collie/commit/a169b75b))
- **The update band no longer runs text off the edge of a phone.** Its one line now truncates with an ellipsis instead of clipping mid-word, and every state that points at `/settings/updates` — an offer, a packaged offer, a peer that could not update — makes the whole band a single 44px-tall tap target, keyboard-reachable and named by its full sentence, with its own close staying independently tappable beside it. ([876132a1](https://github.com/AltanS/collie/commit/876132a1))
- **The stacking primitive behind that band, the composer's status slot and every other swap between alternatives keeps its box inside the screen.** `ui/one-of.tsx`'s grid layers had no `min-w-0`, so a `white-space: nowrap` run inside one of them — the update band's own copy, on a narrow phone — could size the whole grid column to the unbroken sentence and push it off the right edge, past the point any of that copy's own truncation could still draw an ellipsis. A real-browser case now pins the geometry a unit test cannot see. ([c72125f8](https://github.com/AltanS/collie/commit/c72125f8), [e48616e3](https://github.com/AltanS/collie/commit/e48616e3))
- **The Switch pane sheet opens the tapped machine's own pane.** On a crew, two machines can share a pane id such as `w1:p1`; the sheet used to compare and select by that bare id alone, so both machines' rows could show as current and a tap could open the wrong machine's pane. It now compares and opens by the pane's full address, host included (ADR 0063). ([3c40b9f9](https://github.com/AltanS/collie/commit/3c40b9f9))

## [1.12.0] - 2026-09-23

### Added
- **A dialog Collie cannot read now shows the harness's own way out.** When every grammar declines a screen and the harness can still tell its input box is gone, Collie draws a small card over the raw mirror: the caption "Collie cannot read this dialog" and one button, the key that harness prints as the way out of a modal. Escape on Claude, Codex, Muse, AGY and Antigravity; Ctrl+C on grok, where Escape opens the scrollback view instead. The card locks the composer, because free text typed at a modal is swallowed and the submit key answers the modal. It never strands you either: tap Send once and the status line names the key on the card, tap Send again and Collie types anyway. omp is not covered yet, because its composer scanner can read "no composer" on a healthy pane and the card would then sit over a live one. Two Claude screens can still draw the card over a live input box, a wrapped multi-line draft and a numbered statusline row, because the box probe does not read them, and so can a Muse draft that holds a blank row between two paragraphs (issue #261); the second tap on Send types anyway there too. ([11ce4aa6](https://github.com/AltanS/collie/commit/11ce4aa6))

- **The `/effort` slider shows every level, and a tap moves the marker there.** Collie reads the level the marker stands over and, because the screen prints the whole scale on one row, the card now shows every level as its own button: low, medium, high, xhigh, max and ultracode, with the current one marked. A tap on any of them moves the marker there, as that many presses of the arrow the screen itself named, so nothing is sent that the screen did not offer. Confirm, This session only and Cancel sit below as before. A narrow pane wraps the slider, and that is read too, down to 40 columns: the footer is joined back from the two or three rows it runs over, and each level is rebuilt from its head and the half printed under it. ([4e7dde57](https://github.com/AltanS/collie/commit/4e7dde57), [acbe8d99](https://github.com/AltanS/collie/commit/acbe8d99), [35870a5f](https://github.com/AltanS/collie/commit/35870a5f), [c3a82215](https://github.com/AltanS/collie/commit/c3a82215))

- **Collie can be served under a path, from the release build, with one setting.** A proxy that gives Collie a path, such as `https://host/collie/`, used to lose it at the first asset and the first `/api/*` call. Set `COLLIE_BASE_PATH` (or `[serve] base_path`) and restart: the bridge serves the app, its assets, the manifest, the service worker and the API under that path, `collie serve` publishes the `tailscale serve` mount there instead of at the root, and `collie doctor` names the mount and warns when the door and the app disagree. Inside the web bundle nothing names the root, and the bridge resolves the shell to the mount when it serves `index.html`, so a binary install needs no rebuild and a checkout keeps the setting across `collie update`. A mount change is a new app on the phone: remove and re-add the home-screen icon (ADR 0052). Thanks @edwinhu for PR #253, which mapped every place the mount matters. ([2b9fe4c1](https://github.com/AltanS/collie/commit/2b9fe4c1), [462ddfa3](https://github.com/AltanS/collie/commit/462ddfa3), [23055728](https://github.com/AltanS/collie/commit/23055728))
- **The release check can carry your GitHub token, so a shared network's rate limit no longer stops an update.** GitHub allows an anonymous caller 60 API calls an hour per network address, and `collie update` on a binary install, the phone's update banner and `install.sh` all spend from that budget, so behind a busy router the check failed with `HTTP 403` before anything ran. All three now read `COLLIE_GITHUB_TOKEN` (or `github_token` under `[update]`), `GH_TOKEN` or `GITHUB_TOKEN`, the first one set, and send it to `api.github.com` alone; the release download never carries it. The tag list is public, so a token with no scopes is enough. A message names the variable the token came from and never its value, and a token GitHub refuses reads as `HTTP 401` with that name rather than as a rate limit. Reported by @CorrectRoadH (#254). ([0b44e3ca](https://github.com/AltanS/collie/commit/0b44e3ca))
- **`collie crew add` and `collie crew update` work on a lead with no git checkout.** A lead installed by `install.sh` or by a package has no commit to push, so both verbs refused and printed a manual path. They now install and level each member from the release the lead itself runs: Collie's own installer travels over the same ssh as a payload, pinned to `v<lead version>`, verified by sha256 against the release manifest and re-read afterwards, so such a member needs `curl`, `tar` and `sha256sum` or `shasum` in place of git and Bun, and `--path` names its install root. The probe now reports which kind of Collie a member already has, so a member that takes the other kind is named instead of written over: on a release lead a member running from git is skipped with `collie update --to-tag v<version>` on its row, and on a checkout lead a member installed by `install.sh` is skipped as one the phone's Updates page levels, where before it was invisible and a bundle push cloned a second Collie beside it. A skipped member never stops the run. Reported by @fonnesbeck (#248). ([0e06e4ff](https://github.com/AltanS/collie/commit/0e06e4ff))
- **A pane can be told to render natively instead of inverting.** Collie's light theme mirrors a terminal by inverting it, which is right for the dark themes most agents ship and wrong for a light-authored one: an opencode or codex pane on a light theme came out dark and hard to read. The display sheet now carries a per-pane switch that overrides the inversion in both directions, so the operator can point their own pane the right way without Collie having to know every agent's palette. Picking the agent's own answer clears the override rather than pinning it, so a pane does not freeze on today's answer if the native-mirror set changes under it later. Thanks @waynehoover (#241, fixes #240). ([351ca2df](https://github.com/AltanS/collie/commit/351ca2df), [fb96f289](https://github.com/AltanS/collie/commit/fb96f289), [fca2754a](https://github.com/AltanS/collie/commit/fca2754a), [939f5317](https://github.com/AltanS/collie/commit/939f5317), [faae4c0d](https://github.com/AltanS/collie/commit/faae4c0d))
- **Every dialog card has a way back to the terminal.** A Terminal control on the card shows the rows it replaced; Back returns to the card. The choice lasts as long as the dialog (ADR 0056). ([a4a59832](https://github.com/AltanS/collie/commit/a4a59832), [e5303208](https://github.com/AltanS/collie/commit/e5303208))
- **The photo picker takes several photos at once.** Pick more than one photo in the attach sheet and each one uploads in turn, in the order picked, through the same size and type checks as a single photo. The Files picker is unchanged. Thanks @jyothyswaroop (#259). ([73807566](https://github.com/AltanS/collie/commit/73807566))

### Changed
- **The Effort card shows its chips alone; the raw slider rows no longer sit above them.** At 40 and 60 columns those mirrored rows were wrapped fragments, and the chips already carry every level plus the current one, so the card no longer shows both. The generic menu (`/model`, `/tasks`) still mirrors its screen: it parses no scale, so the mirror stays its only way to show its options (ADR 0054). ([3b9616da](https://github.com/AltanS/collie/commit/3b9616da))
- **The composer is one box.** The attach control, the text field and Send sit on one row inside one bordered container, the pattern the shadcn-registry prompt kits use, ported by hand with no new dependency. An empty composer is one button row tall, the buttons stay pinned to the bottom edge as a long draft grows, and focus draws one frame on the whole box. The 44px strip the attach button held inside the field goes back to the typing area. Ctrl+Enter still sends and a bare Enter is still a newline, because the draft goes to a terminal (ADR 0057). ([e2d040ec](https://github.com/AltanS/collie/commit/e2d040ec), [4e77501f](https://github.com/AltanS/collie/commit/4e77501f), [5d97d957](https://github.com/AltanS/collie/commit/5d97d957))
- **Every dialog card sits in the same place.** A lifted card docks directly above the Keys belt instead of following the terminal text, so it starts at the same spot on every screen. A tall card scrolls inside the dock (ADR 0059). ([721499d8](https://github.com/AltanS/collie/commit/721499d8))
- **An attachment shows as a chip.** A photo shows as a thumbnail and a file as its name, each with its number and an x, instead of its path in the text. A short marker such as `[Image #1]` holds its place in your words, and Send puts the path there, so the terminal gets the same line as before (ADR 0060). ([24aca425](https://github.com/AltanS/collie/commit/24aca425))
- **The terminal draft notice floats.** When you type in the terminal itself, the notice with Take over floats above the belt instead of pushing the page, and an x hides it until that draft is gone (ADR 0061). ([0471476a](https://github.com/AltanS/collie/commit/0471476a), [61be3d37](https://github.com/AltanS/collie/commit/61be3d37))
- **The pane screen's tab and pane rows take 22px less height.** The open tab no longer draws an underline; it reads in full ink and a heavier weight, and the other tabs sit in the lighter ink. The tab row is 30px instead of 44, and the pane row is 26px instead of 34.5. A pane pill still answers a 44px touch, up from 35, and a tab answers 44px when no pane row sits under it. Under a pane row, a tab answers its own 30px, because the pane row keeps every pixel of its box. The space screen's tab row takes the same look. ([b1430d56](https://github.com/AltanS/collie/commit/b1430d56))

### Fixed
- **The dashboard's filter strip no longer scrolls sideways and down.** Its chips could be dragged out of sight, and the same overflow was clipping away their tap target. Thanks @bendrucker (#265). ([6b6292ed](https://github.com/AltanS/collie/commit/6b6292ed))
- **The Keys tray has a tall Enter, set apart from the arrows.** Enter spans both rows at the right edge behind a small gap and carries a light tint, the arrows form an inverted T, and Space, Shift, Tab and the arrows show icons. Thanks @lighcen (fixes #263). ([6d7e701a](https://github.com/AltanS/collie/commit/6d7e701a), [879c1eab](https://github.com/AltanS/collie/commit/879c1eab), [570f062b](https://github.com/AltanS/collie/commit/570f062b))
- **A long machine name no longer pushes dashboard cards off a narrow phone.** A crew member whose id comes from a long hostname, such as a Mac's name with its search domain appended, kept its full width at the end of each row, so on a 375px phone every card on that machine grew wider than the screen and the page panned sideways under the top bar. The name now stops at the same width the other address tags keep and ends in an ellipsis, and the dashboard and space lists no longer pan sideways. Thanks @dantebarba (fixes #264). ([8034a656](https://github.com/AltanS/collie/commit/8034a656))

- **A Muse reply that quotes a dialog no longer blocks every send until the transcript moves.** When Muse printed the text of an approval, a question or a review screen as its last reply, the reply check took the quote for a live dialog and refused each send from the app, with no way out but "Type into terminal". A live Muse dialog owns the keyboard, so its input box is always bare; the same rows above a box holding a draft or a placeholder are transcript. The check now refuses a question, checkbox or note match only above a bare box, and a review match only with its live header directly above, which is the same test the buttons already use. An approval or trust match still refuses on its own, since neither leaves a live box. Thanks @jpcarranza94 (#262, fixes #260). ([fe44ae0e](https://github.com/AltanS/collie/commit/fe44ae0e))
- **A Claude pane in shell mode is read as a live input box again.** Shell mode paints `!` on the prompt line in place of `❯`, so Collie found no input box, every send stalled, and the new unread-dialog card drew "Collie cannot read this dialog" over a composer you could type into. The frame walk now accepts a `!` prompt row, the bang is treated as chrome so the draft chip shows the command alone, and the pane's own `! for shell mode` hint moves to the status strip, where it tells you that your reply runs as a shell command. Only the prompt row learned the bang: a `!`-led line anywhere else on screen is still ordinary text. ([c9c3f3d8](https://github.com/AltanS/collie/commit/c9c3f3d8))
- **A crew member that is asleep no longer stops this machine updating.** `collie doctor` reports the crew's health as well as this machine's, and the update preflight treated every one of its errors alike, so a laptop that had gone to sleep turned the update button off on a healthy desktop that had the disk, the bun and a clean tree. The preflight asks whether THIS machine can take a new version, so only a fault on this machine makes it red now, and a crew fault is amber and names the check that raised it. A member levels itself to its lead's release when it comes back, which is what this was blocking. The same rule now covers the tap as well as the button: a member the lead knows it cannot reach no longer refuses the lead's own update, which matters because the lead banks what it knows in memory and its own update restarts it. A crew-only run, where the members are the whole request, still refuses. A member that the update would strand rather than merely outrun still blocks the confirm in the terminal. ([a11b81e4](https://github.com/AltanS/collie/commit/a11b81e4))
- **`collie doctor` now asks the bridge whether it needs a restart, instead of hunting for a pid.** `restart-pending` used to find the bridge's process from outside, through the systemd unit, the pidfile or the crew marker, and then read `/proc/<pid>/exe`. A solo install under launchd on a Mac has none of those, so the check said "no pid" against a bridge that was up. The bridge already reports the answer on every snapshot as `update.restartNeeded`, so the check reads that first, off the one snapshot request `doctor` already makes, and names the restart command the bridge spells for its install kind. The process is read from outside only when the snapshot carried no verdict, and the skip then says why. On a platform without `/proc` a pass says it was judged by version alone. Thanks @ubuntudroid (#238). ([fcef456c](https://github.com/AltanS/collie/commit/fcef456c))
- **A Codex pane no longer leaves a dark strip above the status bar.** Codex paints a blank background row above its native `›` composer. The mirror removed the prompt but kept that padding, so the fill stayed on screen as a band. The composer band now takes the adjacent blank rows that carry the prompt's own background with it, and the gap between the transcript and the status bar matches Claude Code's. Prompt detection and draft binding are unchanged, and interior paragraph spacing is kept. Thanks @Femoon (#250, fixes #249). ([e46e8ce5](https://github.com/AltanS/collie/commit/e46e8ce5))
- **`collie crew add` no longer leaves a member that runs two multiplexers unable to restart.** Leg 3 asks which one Collie should drive there, or takes `--mux <name>`, and writes `COLLIE_MUX` beside the bind; a member that runs exactly one is left to pick it itself as before. ([ef2edf42](https://github.com/AltanS/collie/commit/ef2edf42))
- **A harness chip no longer shrinks to a lone ✓ after it fires.** The check takes the icon's place and the word stays, so the other chips on the belt no longer slide left for 700ms and back. ([ec262d3e](https://github.com/AltanS/collie/commit/ec262d3e))
- **The `/effort` slider shows its Confirm and Cancel buttons again.** Claude Code's `/effort` picker prints "Enter to confirm" in its footer, and Collie read that one phrase as the folder-trust prompt, so the generic menu stood down and the screen arrived with no buttons at all. The trust prompt is now recognised by its own words, and every other screen that prints the phrase keeps the keys its footer names. ([90a74a55](https://github.com/AltanS/collie/commit/90a74a55))
- **The folder trust prompt is two buttons again in current Claude Code.** Claude Code 2.1.278 prints the trust prompt's rows without numbers, so Collie declined it and offered only the unread-dialog card's Escape. The prompt lifts again: because the rows lost their numbers, a tap now walks the pointer with the arrow keys and confirms with Enter, exactly the keys the screen names, and no digit is invented. The option under the pointer is "No, exit", which quits Claude, so the card marks the row the pointer is on and every other row shows the arrow its tap starts with. The older numbered prompt is unchanged (ADR 0055). ([62f6a8c6](https://github.com/AltanS/collie/commit/62f6a8c6))
- **Resuming a Claude Code session works from the card.** The /resume picker lists each past session as a row; a tap moves the pointer there and resumes it. The picker never prints Enter, so this dialog alone sends it unprinted (ADR 0058). ([106d0fdb](https://github.com/AltanS/collie/commit/106d0fdb), [840fd60d](https://github.com/AltanS/collie/commit/840fd60d))
- **The dashboard keeps its scroll position when you open a pane and come back.** Opening a pane and returning used to always land back at the top, because the screen transition remounts the dashboard's own scroller as a fresh element. The dashboard and the space screen now each remember their own scroll position in memory and restore it on the way back. ([b12a6a92](https://github.com/AltanS/collie/commit/b12a6a92))

## [1.11.1] - 2026-09-20

### Fixed

- **A crew update no longer stalls after the lead has updated itself.** The phone stopped reading the update subject the moment the lead's own run reached `done`, which on a crew update is seconds in, before the members have started. That read is also what asks each member for a fresh preflight verdict, and a member whose verdict the lead does not hold is never handed its turn, so a run could sit on `waiting` for minutes and then take the release in four seconds. The phone follows the crew half of the run now, and the lead asks for the verdict it is stuck on instead of waiting to be asked. ([a0175935](https://github.com/AltanS/collie/commit/a0175935))
- **A member that is not handed its turn now says why.** A withheld turn was the one thing an update run did in total silence, on the lead and on the member, so a run that had stopped moving looked exactly like one that was working. The lead names the machine and the cause once, in its own journal. ([a0175935](https://github.com/AltanS/collie/commit/a0175935))
- **The update badge no longer covers the message box.** A run another device started drew a bar across the bottom of the screen, over the composer's input row, and it did so in the one case that hands that box back on purpose: after `keep using the app` on a download that had stopped. It is one line in the band above the header now, beside the connection bar and the update offer, and the band picks one winner rather than stacking them. A connection you have lost still wins that band: during a crew update the two are often one event seen twice, but not always, and hiding a machine you cannot reach is the worse of the two mistakes. ([a0175935](https://github.com/AltanS/collie/commit/a0175935))

## [1.11.0] - 2026-09-20

### Added

- **The pane switcher now shows each row's cache time.** The Layers sheet already named the pane and its place; the same warm, expiring or cold reading that rides the dashboard row now trails the name here too, so you can tell a warm pane from a cold one without leaving the sheet. ([20d2bada](https://github.com/AltanS/collie/commit/20d2bada))
- **Muse panes get their own adapter, so you can answer Muse from the phone.** Muse's command approval, its single-choice and multi-choice questions (with the review screen), and its workspace trust prompt show as buttons, and the command or folder they concern stays on screen above them. Collie also takes Muse's input box and status row off the mirror, shows a draft left in the box, and checks each reply against the box before it sends. A dialog quoted in the transcript, or one above a box that holds a draft, stays text, so a tap can never send a draft. Contributed by [@jpcarranza94](https://github.com/jpcarranza94) ([#244](https://github.com/AltanS/collie/pull/244)) ([d634d025](https://github.com/AltanS/collie/commit/d634d025), [c99a863d](https://github.com/AltanS/collie/commit/c99a863d), [c7e5c8e8](https://github.com/AltanS/collie/commit/c7e5c8e8))
- **The cache chip turns cold when an action drops the cache.** A `/model` switch to another model, an effort change, a compaction and `/reload-plugins --force` make the next turn rebuild the cached prefix, and the chip kept counting down over it. Collie now reads these actions from Claude Code's transcript as they happen, and a model change or a compaction from opencode, and shows the chip cold with the clock still running. The cache sheet names the action, or the one that most likely made the last turn miss, and the cache watch stays quiet on a pane that is already cold. Every rule carries its source, and plain `/reload-plugins`, which keeps the cache, ships as a rule too ([#236](https://github.com/AltanS/collie/issues/236)) ([da555bc8](https://github.com/AltanS/collie/commit/da555bc8))

### Changed

- **A crew-only update takes the screen on the phone that started it.** "Retry crew update", and levelling the members while the lead is already current, left the app live with no sheet, because such a run writes no record on the lead. The phone that tapped it now gets the same sheet as a full update: the app behind is blocked until the members finish, the lead's row says it is already up to date and does not restart, and the end reads `Members updated to <version>`. A member that could not update leaves the sheet open on that phone with its reason. Every other device shows the badge, as it does for a full update. The "Still working" way out appears when no member has moved for three minutes. ([5f5c44c9](https://github.com/AltanS/collie/commit/5f5c44c9))

### Fixed

- **Claude's background agents show on the phone again.** The list Claude draws under its statusline (`● main` and one row per agent) left the mirror with the input box, and nothing showed it anywhere. It now sits under the statusline as its own row: the first agent and a count of the rest, and a tap shows every row. Reported by [@leiyangyou](https://github.com/leiyangyou) ([#242](https://github.com/AltanS/collie/issues/242)) ([588f4694](https://github.com/AltanS/collie/commit/588f4694))
- **Codex Astra's starfield no longer blocks sends or poses as a draft.** Astra models paint sparkles around Codex's input line. Rows of sparkles between the input line and the status row made the phone think a dialog was up, and it refused to send. Sparkles on an empty input line showed up as a stranded draft. Collie now finds the input line by its own marks and reads past the sparkles. Reported by [@dondiegorivera](https://github.com/dondiegorivera) ([#245](https://github.com/AltanS/collie/issues/245)) ([12e168cd](https://github.com/AltanS/collie/commit/12e168cd))
- **`crew add` and `crew update` on a lead from install.sh say what to do instead of reporting a broken checkout.** Both commands push the lead's own git commit, and a standalone install has none, so both stopped with "is not a git checkout" after a full probe of the far machine. They now stop before the first ssh connection. `crew add` prints the manual path with the lead's release pinned, and `crew update` names the phone's Updates page and `collie update --to-tag` on each member. `crew add` on a packaged lead gets the same answer. Reported by [@fonnesbeck](https://github.com/fonnesbeck) ([#248](https://github.com/AltanS/collie/issues/248)) ([ad3171bf](https://github.com/AltanS/collie/commit/ad3171bf))
- **The cache chip and History follow a Claude Code session hand-over.** Claude Code can move a live conversation into a new session file and leave a `continued-in` record at the end of the old one, while Herdr keeps naming the old session. The chip then counted down on a file nobody writes to, and History could stay on it too. Collie now follows that record to the live file, up to eight hops and never outside the projects folder it started in, and ignores it once the old session writes a new turn after it ([#236](https://github.com/AltanS/collie/issues/236)) ([1e9d1a36](https://github.com/AltanS/collie/commit/1e9d1a36))
- **The crew update button goes away once every member runs the lead's version.** "Update crew" and "Retry crew update" could stay on the Updates page over a crew that was already level. A member that had moved past the lead counted as behind, and a member that failed a run kept counting after it updated itself. The phone and the lead now apply one rule: a member counts as behind only when its version is lower than the lead's, and a failed member stops counting once it reports the lead's version or a newer one. The band's "Could not update" line clears at the same moment. A member whose version is unknown still counts, and a member whose package manager owns it never counts, awake or asleep. ([4f4f3be5](https://github.com/AltanS/collie/commit/4f4f3be5), [78d581bb](https://github.com/AltanS/collie/commit/78d581bb))
- **A crew update refused over a packaged member says so.** A member whose package manager owns it cannot be levelled from the phone (ADR 0035), and a start that found only such a member behind was refused with "there is no newer release to take", which is not what happened. It now names the member and its package manager. ([24f3d37c](https://github.com/AltanS/collie/commit/24f3d37c))
- **`collie doctor` can read its own bridge again when a tailnet login is required.** With `COLLIE_TRUSTED_USER` set and `tailscale serve` in front, the bridge refuses a read that carries no identity, so `doctor` could not reach its own `/api/snapshot` and called a healthy bridge one that was down. It now shows the login it is configured with, and a refusal that still comes back is reported as a refusal, not as a bridge to go and start. Reported by [@ubuntudroid](https://github.com/ubuntudroid) ([#238](https://github.com/AltanS/collie/issues/238)) ([a94d41a0](https://github.com/AltanS/collie/commit/a94d41a0), [1ae0dde2](https://github.com/AltanS/collie/commit/1ae0dde2))
- **The close button on a failed update sheet closes it.** A failed update leaves its sheet open with the reason, and the sheet offered a close that did nothing, so it covered the app until the page reloaded. The close now puts it away on that device, and a later failure shows again. ([5f5c44c9](https://github.com/AltanS/collie/commit/5f5c44c9))

## [1.10.2] - 2026-09-19

### Fixed

- **`collie update` works again when your home directory is a git repository.** A dotfiles repository whose working tree sits at `~` made Collie read a binary install as a source checkout. `collie update` then refused to run and pointed you at your own dotfiles remote. Collie now counts a directory as a checkout only when the repository starts there. Reported by [@krishkumar](https://github.com/krishkumar) ([#243](https://github.com/AltanS/collie/issues/243)) ([d43f8fd1](https://github.com/AltanS/collie/commit/d43f8fd1))
- **A checkout whose git data is unreadable is never mistaken for a binary install.** A corrupt or unreadable `.git` made git refuse to answer, and Collie then read the folder as a binary install, which `collie update` moves aside. Collie now stops, says the git data cannot be read, and tells you to repair it. ([0091f5ec](https://github.com/AltanS/collie/commit/0091f5ec))
- **Collie no longer asks git about the wrong repository.** If `GIT_DIR` or one of its siblings was set in your shell, or Collie ran from a git hook, every git question it asked was answered about that other repository instead of its own. No Collie process passes those variables to anything it starts now. ([ADR 0049](https://github.com/AltanS/collie/blob/main/.adr/0049-no-child-inherits-a-relocated-repository.md), [dcd313b1](https://github.com/AltanS/collie/commit/dcd313b1))

## [1.10.1] - 2026-09-17

### Fixed

- **The dashboard summary no longer splits a count across two lines.** On a phone with all five states, each count stays in one piece, and whole counts move to a second line when the row is too wide. ([45084e9e](https://github.com/AltanS/collie/commit/45084e9e))
- **A send no longer stalls when Claude's slash menu cuts a command name.** On a narrow pane Claude shortens a long command name with a leading `…`, and Collie then lost sight of the input box, typed the text and held back Enter, so the message needed a second send. Collie now finds the input box by its own frame and reads the shortened names; rows under the box that it cannot name stay visible on the mirror. Names cut onto a hyphen and names that print an alias in brackets are read too. ([67387a7e](https://github.com/AltanS/collie/commit/67387a7e), [56f2846b](https://github.com/AltanS/collie/commit/56f2846b))
- **A send can no longer land on Claude's background-agents screen.** That screen has a typing field of its own, and Collie read it as the ordinary message box: a send from the phone pressed Enter there and started an agent task. Collie now recognises the screen and holds the send until you leave it. ([67387a7e](https://github.com/AltanS/collie/commit/67387a7e), [56f2846b](https://github.com/AltanS/collie/commit/56f2846b))

## [1.10.0] - 2026-09-16

### Changed

- **The dashboard keeps every pane where it sits.** Panes stay in their workspace group in the multiplexer's own order, whatever their status, and the Needs you and Ready · unseen sections at the top are gone. What needs you now shows where the pane sits: a red wash on its row, a red dot on its workspace heading, and one summary line at the top that counts every state in words, which a tap takes you to. Each heading shows the same counts as numbers. ([a039e277](https://github.com/AltanS/collie/commit/a039e277))
- **A strip of workspace chips filters the dashboard.** Tap a workspace to see it alone, tap it or All to see everything. Long-press a chip to hide that workspace, and long-press it again to bring it back; a hidden chip stays in the strip, dimmed and struck through, still showing its status. The choice is kept on each device, by workspace name. ([a039e277](https://github.com/AltanS/collie/commit/a039e277))
- **An unseen reply is marked with a square.** A finished pane you have not opened carries a small square after its name, on the summary line, on its workspace heading and on its chip, instead of a white dot and a green wash that read as one more status. ([a039e277](https://github.com/AltanS/collie/commit/a039e277))
- **A tab you named that holds one pane names that pane.** If you named a tab and it holds a single pane, the header, the belt, the dashboard and push notifications now use that tab name ahead of the title Claude writes itself, which moves to the dashboard row's second line. A `/rename` and a pane label still come first, and a tmux window keeps its automatic name out of it. ([8962e695](https://github.com/AltanS/collie/commit/8962e695))
- **The switcher mark shows a red dot when another pane needs you.** While you are in one pane, the layers icon at the end of the bottom belt carries a red dot as soon as any other pane is waiting on you, and its spoken name says so. Only a pane that needs you lights it. ([eb7470d1](https://github.com/AltanS/collie/commit/eb7470d1))
- **The tab belt names the pane and underlines the open tab.** A tab that holds one pane shows that pane's name, so the open tab and the header read the same word. The open tab is underlined, every other tab reads in near full ink, and the brand tile and the dashed desktop-focus ring are gone from the cells. ([a039e277](https://github.com/AltanS/collie/commit/a039e277))

### Fixed

- **A Herdr plugin action reads the same state as the running service.** Herdr puts its own plugin state directory into every action it runs, and Collie used it, so the `push-test` action found no subscriptions and an update started from the `update` or `update-major` action kept its progress record where the phone could not see it. Collie now ignores that directory; `COLLIE_STATE_DIR` still moves the state. Thanks @lighcen (#226). ([d07ec4c4](https://github.com/AltanS/collie/commit/d07ec4c4))
- **An update that finds its target already live stages nothing and records nothing.** Such a run used to leave its update record at `staging`, and the phone reported an interrupted update about an install that was fine; it now ends before the record opens and before it asks for Bun. Thanks @foreverrrree (#231). ([a18827d5](https://github.com/AltanS/collie/commit/a18827d5))
- **A Muse pane's hard line breaks read as soft wraps on the phone.** The 2-column row gutter and the full-width row padding Muse draws are trimmed from its native mirror, so paragraphs no longer show a stray indent or blank stub lines. Detectors still read the untrimmed screen. Thanks @jpcarranza94 (#230). ([d67f48b5](https://github.com/AltanS/collie/commit/d67f48b5))
- **A Muse pane's light mirror stands on Herdr's own light background.** The native ground moves from the page grey to `#fffbf8`, so Muse's prompt fill and other authored tones keep their contrast. Thanks @jpcarranza94 (#229). ([cc76e9bf](https://github.com/AltanS/collie/commit/cc76e9bf))
- **An update checks Bun can run before it touches the checkout.** A managed or staged update now asks `bun --version` first and stops with the checkout unchanged when Bun cannot answer. A machine whose Bun is installed but cannot run now refuses its update instead of warning: the update check shows red rather than amber, which also blocks a crew update until that Bun is fixed. The compile step runs in a private folder under `bin/`, so Bun's scratch file no longer lands in the checkout root; `bin/` must be a real directory, not a symlink. Thanks @en-ver (#232). ([53e2f462](https://github.com/AltanS/collie/commit/53e2f462))

## [1.9.1] - 2026-09-15

### Added

- **An urgent patch keeps the daily update cadence.** A fix operators must take today, data loss, a security hole, a broken update path, carries one `**Urgent.**` line under its changelog heading. The release publishes that line in its `collie-release.json` sidecar and on its release page, and the phone then tells you at the release or at the next 09:00 after it, instead of folding the fix into the weekly patch digest. The push opens with the release's own sentence, the update card prints it beside a short Urgent label, and the band carries the label. One urgent release makes the whole waiting train daily; the version stays an ordinary patch. ([53dbaaa2](https://github.com/AltanS/collie/commit/53dbaaa2))

### Changed

- **The actions belt stands at 40px, and the reply field's focus ring has room to breathe.** The belt under the pane read as a thin strip on the phone at the pill's own 32px; it now carries 4px above and below the pills, and the harness section's tint still runs from rule to rule. The reply field's focus ring used to land on the belt's bottom edge; the field row now keeps 4px above the field, so the ring clears the belt above and the chrome below by the same margin. ([a0ae39e7](https://github.com/AltanS/collie/commit/a0ae39e7))

### Fixed

- **A finished agent no longer hides in Recent on Herdr 0.9.** Herdr 0.9 says `idle` on its API for an agent whose turn ended, and only its own client turns that into `done`, so a completion sat in Recent with no mark and Ready · unseen looked empty. Collie now counts a settled pane, `idle` or `done`, as unseen when its last turn ended after you last opened it, shells excluded. Only a turn that ends counts as new work, so Herdr's own acknowledgement and detection flicker do not re-mark a pane you have read, and an agent that exits takes its unread history with it. On tmux and zellij the same rule lifts a beacon-reported pane into Ready · unseen when its turn ends. After the update, a pane that finished earlier and was never opened may show as unseen once; opening it clears it. Thanks @magoz (#222). ([769cdaa8](https://github.com/AltanS/collie/commit/769cdaa8))
- **Muse panes render natively in light mode.** The mirror no longer inverts Muse's mid-tone palette into a 2:1 grey-on-white; the pane sits on the page ground with only bright foregrounds resolved dark, and dark rendering is unchanged. Thanks @jpcarranza94 (#220, ADR 0047). ([7e521c6d](https://github.com/AltanS/collie/commit/7e521c6d))
- **A Codex pane stops painting a black bar again when Codex changes its fill.** The mirror's light-fill rule reads luminance instead of one exact colour, so the band Codex 0.154.0 paints four levels off the reported value is caught like the original, and the next one will be too. The rule is one module shared with omp; each adapter names its own floor. Thanks @foreverrrree (#224, follow-up to #144).

### Docs

- **The install page opens with Install, Update and Uninstall, each spelled for a Herdr plugin and for a standalone install.** A table at the top says how to tell the two kinds apart, how their verbs are spelled, and where each keeps its config and state. Packages get one line per manager in those three sections and keep their long notes further down. Uninstall is now three steps, service, program, own files, with the paths that stay behind. ([ef776e9b](https://github.com/AltanS/collie/commit/ef776e9b))

## [1.9.0] - 2026-09-14

### Added

- **One row of actions above the keyboard, with the running agent's own commands in it.** Keys, Type, Quick, Agent and the display gear share a single scrolling row with the harness's commands, which sit in a segment tinted with that harness's brand colour and carry an icon each. Claude Code panes get Model, Effort, Compact and Resume; Codex, pi and omp get their own. Every button sends its bare command and the harness paints its own picker in the mirror, so the list of models or effort levels never lives in Collie. Operators add or replace the segment with `bar = true` in `commands.toml`; Settings, Harness shortcuts, hides it per device. ([fc8d1be9](https://github.com/AltanS/collie/commit/fc8d1be9))
- **A config file carries every setting.** `~/.collie/config.toml` sets any Collie setting in TOML for the whole machine, and a `config.toml` beside your `.env` overrides it for one instance; the environment and your `.env` still win over both, and a broken key never stops the bridge from starting. ([1df9edd4](https://github.com/AltanS/collie/commit/1df9edd4))
- **Three verbs for that file.** `collie config init` writes a commented file with every setting and its default, `collie config check` validates one, and `collie config show` prints both file paths and every setting with its effective value and where it came from. ([95a2f7b1](https://github.com/AltanS/collie/commit/95a2f7b1))
- **Cache rules are dated, sourced claims, and `collie doctor` says when one goes stale.** Every TTL carries the vendor page it was read on and the date it was read; a claim older than 180 days is a doctor warning, and one older than a year fails the build. ([49484669](https://github.com/AltanS/collie/commit/49484669))
- **`cache-rules.toml` moves a TTL your provider changed.** It sits beside `commands.toml`, overrides one rule id, and must carry the page you read and the date you read it. ([74004b6c](https://github.com/AltanS/collie/commit/74004b6c))
- **Every agent pane shows how long its prompt cache stays warm.** A chip on the dashboard card and in the pane header counts down from the harness's last request: green while the window is wide, red in its last quarter, and blue once the cache goes cold. A tap on the pane screen opens the rule, its source and the date it was last checked. ([f12f7a63](https://github.com/AltanS/collie/commit/f12f7a63))
- **The first launch is one screen that says what Collie does and what this install looks like.** It names the multiplexer and the machine it mirrors, counts the panes and the ones blocked on you, says whether this device may type and how many machines are in your crew, offers at most two things to do about it, and closes with the six things you can do here. Shown once per device; Settings shows it again. ([a9c6c22f](https://github.com/AltanS/collie/commit/a9c6c22f))
- **A push warns you before a pane's prompt cache goes cold.** Switch it on for one pane from its settings sheet, or for every pane under Settings → Notify when, where the panes you watched one by one are listed. The warning fires once per warm cycle, honours the snooze, and `COLLIE_CACHE_WARN_SECONDS` moves its 300-second window. ([eeedfabf](https://github.com/AltanS/collie/commit/eeedfabf))
- **omp's harness bar has a Tree button.** It sits between Compact and Resume, the order pi's bar already uses, and opens omp's own session tree in the mirror. `/tree` joins the omp command palette with it. ([cc38c2de](https://github.com/AltanS/collie/commit/cc38c2de))

### Changed

- **A crew member too old to speak the current protocol is now a red preflight, not a silent link.**
  The lead's `collie update --check` walk names a protocol floor: 1.8.0 is the oldest build that
  speaks crew protocol 2. A member below it, under a lead at 1.9.0 or newer, reds the `version`
  check with both versions and the remedy, which blocks the crew update instead of starting a roll
  that cannot finish. A version the lead cannot parse stays amber, as before. A state directory that
  still carries 1.7.0's `pack-*.json` names is now named at start, with the two hand edits printed
  in full. ([6e97194c](https://github.com/AltanS/collie/commit/6e97194c))
- **The crew link speaks one version again: the 1.7.0 compatibility layer is gone.** 1.8.0 kept the
  old `/pack/v1/*` paths, the `COLLIE_PACK_*` timeout keys, the `pack-*.json` state-file rename, the
  `/api/pack` redirect and every `packId` reader alive for one release so a 1.7.0 member could
  follow the update roll. All of it is removed. Bring every member to 1.8.x before you move the lead
  to 1.9.0: a member still on 1.7.0 now shows red on the lead's preflight, naming both versions and
  the remedy, and reads as `incompatible` in `crew status`. The `collie pack` command alias, `collie
  docs pack` and the app's `/pack` address are untouched and stay until 2.0.0. ([fe8eec0b](https://github.com/AltanS/collie/commit/fe8eec0b))
- **The config schema names the cache warn window.** `COLLIE_CACHE_WARN_SECONDS` has its row, so `collie config show` and `config init` carry it. ([44317201](https://github.com/AltanS/collie/commit/44317201))
- **The config schema forgets the 1.7.0 pack keys.** The two `COLLIE_PACK_*` timeout aliases left with the crew wire overlap, so `collie config show` no longer lists them. ([cdafe05a](https://github.com/AltanS/collie/commit/cdafe05a))
- **The agent card drops the relative-time chip.** The prompt-cache countdown next to it says what matters; the extra number read as a session clock and confused. ([cd70aa30](https://github.com/AltanS/collie/commit/cd70aa30))
- **The dashboard row carries its machine and cache reading on the name line.** The host chip and the cache countdown ride at the end of the pane's name, on every row of the dashboard, and the second line is the place alone, so a row is two lines and never three; an empty reading leaves its space, so nothing slides. ([cc5965d3](https://github.com/AltanS/collie/commit/cc5965d3))
- **The cache countdown carries an hourglass mark in one quiet ink per state.** The chip on the dashboard row and in the pane header opens with one fixed hourglass glyph, so the number reads as a cache reading beside the host chip's server mark rather than as a loose word. The hourglass is green while the window is wide, red in its last quarter, and blue once the cache goes cold; the machine's identity tint is left to the host chip beside it. ([d3a52e25](https://github.com/AltanS/collie/commit/d3a52e25))
- **The key rail fades and shows a chevron on the edge that still hides content.** The scrolling row of harness shortcuts above the keys says which way it scrolls, so a rail wider than the screen no longer looks like it ends at the last visible button. ([abccd401](https://github.com/AltanS/collie/commit/abccd401))
- **The actions row is a belt.** One full-bleed band sits above the input, flush under the mirror: Collie's own controls run on a scrolling track tinted with the brand colour, and the harness's commands sit in a section tinted with the harness's colour. The fixed Switch cell sits at the right, on the composer's own ground, behind a hairline. The track's right edge carries exactly one constant fade and no chevron, and the last pill always scrolls fully into view; the Switch pill's tap area ends at its own hairline. Every pill is an icon and a word, so Collie's controls and the harness's commands read as one family. ([9b530786](https://github.com/AltanS/collie/commit/9b530786))
- **The pane's status word leaves the composer.** The thin line above the controls that named the machine and the pane's state is gone; the state now stays on the header's dot and on the dashboard. ([adaa1fb3](https://github.com/AltanS/collie/commit/adaa1fb3))
- **A bare Switch mark at the end of the actions belt opens the pane switcher.** The belt's right end carries the layers glyph above Send, behind a hairline and with no word or border of its own; a drag up from anywhere on the belt also opens the switcher, a sideways drag still scrolls it, and the 30px handle band above the composer is gone. ([931f857a](https://github.com/AltanS/collie/commit/931f857a))
- **The machine's name moves into the pane header, onto the path line.** The header's second line names the workspace, and on a crew the host name and the cache countdown ride at its end. The pane menu stands alone in the corner; place and meta stand on one baseline; the actions belt no longer carries the name. ([931f857a](https://github.com/AltanS/collie/commit/931f857a))
- **One name on every screen.** A pane is called the same thing on the dashboard, in the switcher, on its own header, on its pill and in a push: the name you gave it, else the name the agent gave its session, else the title the pane's program prints, else the word for the agent running there. The pane header no longer leads with the space and tab, and no screen falls back to a directory for a name. ([6e8eeafc](https://github.com/AltanS/collie/commit/6e8eeafc))
- **The place is the second line, and only the second line.** `space › tab` sits under the name on the dashboard row, in the switcher row and in a push; the pane header shows the workspace alone, because the tab strip under it already names the open tab. A card already grouped under its tab keeps the directory there instead, since its place is the heading above it. ([6e8eeafc](https://github.com/AltanS/collie/commit/6e8eeafc))
- **A tab the multiplexer only numbered reads its position, not nothing.** A multiplexer labels an unnamed tab by position, "1" or "Tab #2"; that number now reads as `tab 2` in a lighter ink on every surface, the tab strip, the pane header's crumb and the dashboard rows alike, instead of a dot. A tab with no label at all still shows nothing, and a screen reader still hears the raw label. ([583e561d](https://github.com/AltanS/collie/commit/583e561d))
- **Rows keep their order.** The bridge sends every pane in the multiplexer's own arrangement, space then tab then the pane's place in that tab, and the dashboard, the switcher and the pane strip keep it rather than re-sorting by activity or by pane id. A row moves when it changes section, not while you reach for it, and the dashboard's list of spaces now runs in the same order as the space strip. ([6e8eeafc](https://github.com/AltanS/collie/commit/6e8eeafc))
- **The dashboard's rows sit under the workspace they live in.** What needs you stays on top, by urgency, listed once and never again under its workspace group; every other pane now sits under a heading that names its workspace and counts what is inside it, in the multiplexer's own machine and workspace order. Each row carries its tab on a second line, or `tab 2` when the tab has only a number. The name sits in the middle of the row when the tab has neither, and every row of a group is the same height. Bare shells join their tab's group after its agents. The Working and Recent headings are gone with them, and so are Recent's fold and its sort toggle. ([64b6f499](https://github.com/AltanS/collie/commit/64b6f499))
- **The tab row and the pane row under the header get compact.** Tab row 32px, pane pills 24px, text 11px, the size of the header's path line; every pill still answers a 44px tap. The tab row draws no horizontal rule and no hairlines between tabs; the open tab is an outlined pill on the row's own ground. The tab row and the pane row beneath it are one continuous band, sharing one ground rather than falling through to the page's ambient black. ([c2a16502](https://github.com/AltanS/collie/commit/c2a16502))
- **A tmux window tmux named itself shows its folder, not its program.** With automatic-rename on, the tab's name is the last folder of the window's active pane; a window you named keeps its name. ([f90b7410](https://github.com/AltanS/collie/commit/f90b7410))
- **The dashboard's attention rows are as compact as the workspace rows.** "Needs you" and "Ready · unseen" used to be tall standalone cards above a list of short rows, two shapes for one kind of thing; every row now shares the 44px form in one framed list, and a finished pane you have not opened yet carries a small dot after its name. ([10cd0557](https://github.com/AltanS/collie/commit/10cd0557))
- **The composer's belt is a third shorter, and its scroll fade is twice as long.** The belt now stands at the pill height, 32px instead of 44px, the Switch mark narrows from 44 to 32px, and the fade under it runs over 64px so the belt reads as a strip that keeps going. The belt also no longer scrolls vertically under a thumb, in Safari either. ([5e7f626c](https://github.com/AltanS/collie/commit/5e7f626c), [63513aee](https://github.com/AltanS/collie/commit/63513aee))

### Fixed

- **A pane's cache countdown survives a `/compact`.** A transcript probe that finds no turn inside its 128 KB window now keeps the last reading and lets it age, instead of dropping the pane's countdown for good. ([05065d54](https://github.com/AltanS/collie/commit/05065d54))
- **A measured cache window cites the rule it was really measured on.** A Claude pane on a subscription measures the one-hour window, so the sheet now quotes the subscription page and date instead of the five-minute API page the tier guess had picked. ([068e2e28](https://github.com/AltanS/collie/commit/068e2e28))
- **A member serving plain HTTP no longer reads as a rejected certificate.** `collie doctor` and `crew status` said "the TLS certificate was not accepted" for a member that answered with no TLS at all, which sent the operator to a pin that was never consulted; the reason now says the address answers over plain HTTP, the same sentence `collie join` already gives. ([80e262d7](https://github.com/AltanS/collie/commit/80e262d7))
- **A URL the pane wrapped is one whole link again.** A URL longer than the pane was cut at the column edge, so only its first row became a link, and that link opened a truncated URL. On Herdr the bridge now reads the same rows with soft wraps undone when a URL runs to a row's end, and every row of that URL opens the whole URL. Thanks @thelinuxlich (#212). ([e44d35c8](https://github.com/AltanS/collie/commit/e44d35c8))
- **A wrapped Codex question card is recognised instead of falling back to raw.** A long question, a description, or the `esc to interrupt` hint can each wrap onto their own row, and `ask.ts` now joins a wrapped row back into the question or description it belongs to, accepting a continuation only when it starts at or beyond that description's own column. The digit recipe is unchanged. Thanks @alvinycheung (#201). ([e44d35c8](https://github.com/AltanS/collie/commit/e44d35c8))
- **The history view reads in the chosen terminal font.** The full-transcript reading page ignored Settings → Terminal font and always rendered in the shipped default face; it now applies the same font to its own `ChatMessageList`, matching the live pane mirror. Thanks @fjse (#216). ([e44d35c8](https://github.com/AltanS/collie/commit/e44d35c8))
- **A multi-agent push notification names the panes, not the agent kind.** With several agents blocked at once the body read `claude, claude, claude`; it now shows each pane's own label, falling back to its folder name and then its agent kind, and adds the workspace when two panes still match. Thanks @caioreis123 (#215). ([15f9db67](https://github.com/AltanS/collie/commit/15f9db67))
- **A peer's own space gets its blocked dot and recency back on the dashboard and in the space strip.** Both matched a space by workspace id alone, or kept keying it to the lead regardless of `?h=`, so a peer's identically-numbered space showed no dot and no order, and the lead's own blocked agent could colour a peer's chip. Both now key off the addressed host, the same one the loader already narrows a peer's spaces and tabs to. Thanks @namseokyoo (#209). ([2fc6a3a0](https://github.com/AltanS/collie/commit/2fc6a3a0))
- **`hooks install` writes through a symlinked `~/.claude`, and still refuses a symlinked settings file.** Stow, chezmoi and similar tools point the whole config directory elsewhere; the write now follows that link instead of refusing it, while a settings file that is itself a symlink (home-manager's read-only profile) is still refused, with a worded error rather than a raw write failure for a dangling or unwritable link. Thanks @cryptiklemur (#190). ([ae078d89](https://github.com/AltanS/collie/commit/ae078d89))
- **An update tapped on a Mac phone no longer leaves the service unloaded.** On macOS neither `systemd-run` nor a `setsid` binary exists, so the bridge started the update runner inside the launchd job's process group; restarting the job killed the runner before it could load the job again. The bridge now spawns that runner in a session of its own on every tier except `systemd-run`, which stays as it was. If a phone update has already left the service unloaded, `collie restart` loads it again. Thanks @PhillipChaffee (#213). ([eeadde63](https://github.com/AltanS/collie/commit/eeadde63))
- **`collie doctor` no longer credits a commented-out cache rule.** The `cache-env` check read the example file's commented rows as a live override; it now counts only rows that validate, and a `retrieved` date in the future is rejected like any other bad row. ([8f8d149f](https://github.com/AltanS/collie/commit/8f8d149f))
- **The cache countdown no longer blinks between polls.** A refresh that arrived without a reading unmounted the chip for a frame and put it back on the next poll; the last reading now holds until a new one, or an explicit cold, replaces it, and it is dropped when the pane goes away. ([d777c559](https://github.com/AltanS/collie/commit/d777c559))
- **The pane title no longer shows a raw pane id.** A tab with several unnamed panes appended the multiplexer's `p3` to the title and printed it on every pill of the switcher; the title names the tab now, and a pill carries its place in the row only when a pill beside it would otherwise read the same. ([2eefd38e](https://github.com/AltanS/collie/commit/2eefd38e))
- **A second Herdr session no longer wipes the first one's cache readings.** The bridge's cache tracker forgot every reading a session's poll did not name, including the other session's, so each poll dropped and re-probed every pane; a poll now forgets only its own session's departed panes, and a transient probe failure keeps the last reading. ([22c79342](https://github.com/AltanS/collie/commit/22c79342))
- **The cold-cache push now fires for panes on a five-minute cache.** Codex, OpenCode, pi and omp all default to a 300-second TTL, no longer than the configured warn window, so the push skipped them outright; it now warns at half the pane's own cache lifetime whenever that is shorter than the configured window, about two and a half minutes before those panes go cold. ([d2811bc9](https://github.com/AltanS/collie/commit/d2811bc9))

## [1.8.2] - 2026-09-12

### Fixed

- **The service worker precaches only its own channel's icons.** A release build's precache no longer carries the dev build's or the playground's icon files, and vice versa: entries dropped from 37 (1660.11 KiB) to 28 (1485.71 KiB) in a same-channel build. ([d43fcf80](https://github.com/AltanS/collie/commit/d43fcf80))
- **Static files ship gzipped, so an update downloads in a quarter of the time.** Only JSON API replies were compressed; the app bundle, the stylesheet and the service worker went out raw, so a phone precaching an update pulled the whole thing over the tailnet and showed the app as offline until it finished. Every text asset is now compressed when the browser offers `gzip`, and a compressed asset is cached in memory so the work is done once per build rather than once per request. The main chunk goes from 869 kB to 250 kB; images and fonts are untouched, since they are already compressed. ([9b484bdb](https://github.com/AltanS/collie/commit/9b484bdb))
- **The update band waits for the new bundle instead of reloading early.** Tapping "tap to reload" while the new version was still downloading reloaded the phone onto the old app shell, which then asked for a chunk that no longer existed, so the loading dog ran forever and only a second manual reload fixed it. The page now reloads only once the new service worker is in control, the band says the new version is downloading for as long as that takes, and the eight-second guard fires only when nothing is on its way in. ([44b7afb1](https://github.com/AltanS/collie/commit/44b7afb1))
- **The downloading band can be closed, and the app stays usable meanwhile.** A download that never finishes, on a link that has gone away, is now one you can put down: the row closes, the app on screen goes on working from the bundle it already has, and nothing is declined — the install carries on in the background and the page still reloads itself once the new version takes over. ([5646f7e6](https://github.com/AltanS/collie/commit/5646f7e6))

## [1.8.1] - 2026-09-12

### Added

- **Opening a pane now slides the screen in, and going back slides it back.** The arriving screen enters from the right on the way into a pane and from the left on the way back, 240ms and eased, with the band, the header and the Collie mark holding still. Every other navigation is silent, including a poll revalidation and a machine or session switch: this is a plain entrance animation on the route region, not the View Transitions API removed in 0.10.0 for flickering the page on every poll. Reduced motion gets the new screen in place, with no slide. ([d24a4d73](https://github.com/AltanS/collie/commit/d24a4d73))
- **The playground has Notices and Motion tabs.** Notices shows the notice family, the strip band, the connection recovery flash, the update ribbon and the status toast. Motion shows the collapse and swap primitives, loading states, sheets, menus, and pending and pulsing controls. Every card carries a Replay control, and the ones that swap between states also carry a Slow toggle. Motion opens with a walkthrough of the real app, every route on fixture data inside a phone frame, with the live route, shortcut buttons and a frame meter for each move. ([9429bd61](https://github.com/AltanS/collie/commit/9429bd61))
- **A dev build wears an orange icon, and the playground a red one.** A build whose HEAD isn't the release tag now installs as "Collie (dev)" with orange favicons and manifest tiles, so it is never mistaken for the release build on the same home screen; the states playground gets its own red favicon set. The release build's `index.html` and manifest are unchanged. ([c7c4cc9e](https://github.com/AltanS/collie/commit/c7c4cc9e))

### Changed

- **The states playground is now a tabbed page instead of one long scroll.** The tab list and the theme/clock/typeface/accent controls sit in a sidebar on wide screens and a top bar on narrow ones; only the selected section mounts, so switching sections no longer means scrolling past several of them to reach one. The tabs open with Dashboard, then Pane, Crew and Settings, then Boot & connection, Idle & resume and Brand, then Notices and Motion. The selected tab lives in the URL hash (`#pane`, or `#pane/<card-handle>` to also scroll to a card), remembered in `localStorage` between visits. Within a tab, cards are grouped under a small labelled `Group`, ordered from the everyday state to the rare one, so a tab with a dozen cards can be skimmed by its group titles. `app.tsx` (1600+ lines) is split into one file per section under `src/playground/sections/`, registered in a small `SECTIONS` table. ([9429bd61](https://github.com/AltanS/collie/commit/9429bd61))
- **The Keys tray is less than half its old height.** One seven-column pad replaces the old Keys/123 toggle and stacked rows, with Space in the middle of the bottom row, and 123, Presets and F keys now sit behind one row of chips instead of two separate disclosures. Measured at a 390px-wide viewport: 275px tall before, 119px tall now, every key still at least 36px tall. ([e12b4334](https://github.com/AltanS/collie/commit/e12b4334))

### Fixed

- **The playground's crew fixtures named real machines, not fictional ones.** The lead and deputy are now `lodge` and `workshop`, matching the fixture set's own outbuilding theme (attic, cellar, garage, loft, shed, barn, kennel). These fixtures mount into colliepwa.dev's feature screens, so this stops the real names from reaching new builds of the public site; a dead re-export of the unit-test fixtures was also dropped from this file's public surface, since it carried the same two names and nothing read it. ([260dbe46](https://github.com/AltanS/collie/commit/260dbe46))
- **The dashboard-row playground card named real machines, a real username and real clients.** `dashboard-live.ts`'s frozen snapshot carried the real host id and host name a dozen-odd times (now `lodge`/`workshop`, matching the crew fixtures' outbuilding theme), plus the operator's real OS username and several real client/project codenames throughout its `cwd`, label and session fields — a bigger exposure than the hostnames, now swapped for same-shape fakes. This card is dev-only and was never imported by colliepwa.dev, so nothing public was showing these names, but a future import could have carried them out unnoticed; the website repo now runs a build-time check against exactly that (`bun run build:app`), so a real name reaching `public/app/` fails the build instead of shipping quietly. ([4269ae2d](https://github.com/AltanS/collie/commit/4269ae2d))
- **The top of the app no longer reserves the iPhone notch three times over.** The update ribbon, the connection bar and the header each set `env(safe-area-inset-top)` for themselves, each written when it was the first thing on the screen, so any two of them at once left a tall dead band above the notice — the everyday ribbon-plus-header case on iOS. The band above the header now shows one strip at a time and owns the inset while it is open; the header reserves it only while the band is empty, and the handover rides the band's own 240ms open and close, so nothing jumps. The update offer and the connection bar are `ui/notice.tsx` strips now, which also ends two copies of the tint recipe, two hand-rolled collapse animations, and two rows that asked a screen reader to be assertive and polite at once. The offer's states that carry a ✕ trade their row-wide tap for a named View button, since a button may not hold a button. ([59c77fc3](https://github.com/AltanS/collie/commit/59c77fc3))
- **The update ribbon's text no longer says "Tap to update".** The dismissible ribbon states navigate through the View button beside the ✕, so the row itself no longer taps, and the copy in all seven locales now says only that the version is available. ([15bd0bbd](https://github.com/AltanS/collie/commit/15bd0bbd))
- **The "tap to update" band is a named button again.** The band's text sits in a live region, which does not name the button around it; the button now names itself from that text. ([93a4ecc2](https://github.com/AltanS/collie/commit/93a4ecc2))
- **A long tab row scrolls its active tab into view.** On arrival and on every selection change, the Spaces, Tabs and Panes strips now carry their active item to the nearest visible edge: instant on arrival, smoothly afterwards, and a workspace with many tabs no longer opens on a tab that's scrolled off-screen. ([8a774cc4](https://github.com/AltanS/collie/commit/8a774cc4))
- **The "Collie on" header line no longer flickers on the dashboard.** The header identity stays mounted across routes and only hides inside a pane, so the multiplexer's logo is fetched once per page instead of once per dashboard open. Over a tailnet that fetch left the logo box blank for a round trip every time you came back from a pane. ([1b3939cf](https://github.com/AltanS/collie/commit/1b3939cf))
- **Opening the dashboard no longer re-reads the bridge config.** The footer build stamp asked for it on every mount and threw the answer away once the build was known. ([e3c7816e](https://github.com/AltanS/collie/commit/e3c7816e))
- **A checkout on an untagged release commit builds as dev.** The channel now reads the tags the checkout holds; a tree with no git and a shallow install with no tags still build as release. ([ee3338a2](https://github.com/AltanS/collie/commit/ee3338a2))
- **The top of the app is no longer blurred on iOS 27.** iOS 27 blurs the top edge of a Home Screen web app whose status bar is translucent, into the header. The status bar is opaque now; the header already paints the page colour under it, and iOS 26 and later colour the bar from that. iOS reads the style once, when you add the app to the Home Screen, so an install made before this change stays blurred until you remove it and add it again. Thanks @bendrucker (#203). ([1907ce2e](https://github.com/AltanS/collie/commit/1907ce2e))
- **A light fill in an omp pane no longer reads as a black bar.** The phone renders the mirror dark and inverts it, so a light ANSI background came through as a solid black block with the text lost inside it. omp's light fills now carry the same `mobileTransparentBg` hint the codex adapter already uses, and the phone drops the fill and keeps the text. Which fills count is decided by luminance rather than by a theme palette, so dark fills, diff colours among them, are unchanged. Thanks @tenngoxars (#206). ([64f0d698](https://github.com/AltanS/collie/commit/64f0d698))
- **A peer's space now lists its own panes instead of every tab reading empty.** In a crew, the space screen grouped panes on the machine leading the crew rather than on the machine the space is on, so opening a peer's space drew "(empty tab)" under every tab while the header still counted the panes. Refs #209. ([5784191b](https://github.com/AltanS/collie/commit/5784191b))

### Docs

- **The docs show how to install and update the PWA itself, not just the host.** `docs/install.md` gains two screenshots of the Install card at the top of Settings — the button Chrome and Edge offer, and the share-sheet hint iOS shows instead — since neither existed anywhere before. The Updates screenshots in `docs/upgrading.md` are regenerated too: two still read "Update pack to" and "Retry pack update" from before the crew rename, and one named a real Tailscale hostname (`minibuch`) in its rolled-back-peer example. `scripts/docs-screens.sh`, which generates this whole set, carried both and is what's actually fixed; the images are just its output. ([22d20160](https://github.com/AltanS/collie/commit/22d20160))
- **`scripts/docs-screens.sh` no longer races its own screenshots.** Every capture now scrolls its target flush to the top before the shot, not just the two newest ones: the previous `agent-browser scrollintoview` call centres an element and can still be mid-animation when the screenshot fires, silently cropping the top off. Also tightens the two install-path Notes in `docs/install.md` to open with the platform they apply to, so a reader can tell at a glance which one is theirs. ([1f444d6d](https://github.com/AltanS/collie/commit/1f444d6d))
- **The omp fixture corpus now covers the tool-approval dialog.** That screen was the corpus's one known gap, and the adapter's own comments said so: the claim that Collie refuses to type into it rested on inference, not on a capture. Three captures close it — a `bash` approval and a `write` approval in both selection states, taken against omp v18.1.17 — and the suite now asserts raw-only blocks and `composerReady === false` on them. The prose and the modal counts in `omp/chrome.ts`, `omp/index.ts` and `omp/markers.ts` are corrected to match. Thanks @christensenjames (#204). ([3a4f68db](https://github.com/AltanS/collie/commit/3a4f68db))

## [1.8.0] - 2026-09-09

### Added

- **A real browser opens the app on every push.** CI gained a second job that builds the web bundle, serves it, answers the API from the same fixtures the unit tests use, and opens the app in Chromium at a phone size and a tablet size. It runs beside the existing typecheck and test job, so a browser failure and a lint failure both report in one run, and it uploads a screenshot and a trace when something fails. Nothing about the shipped app changes; the release path downloads no browser. ([051b30e2](https://github.com/AltanS/collie/commit/051b30e2))
- **Thirteen checks that were run by hand now run themselves.** `web/e2e/issue-180.spec.ts` holds seven browser cases for terminal graphics in the mirror, from a placeholder run that shows the journal's picture to a search highlight that has to land on the right character below one. `web/e2e/m24-crew.spec.ts` holds six for the crew page, the `/pack` to `/crew` redirect, the Settings and footer entries, and the Japanese locale. `web/e2e/fixtures/mirror.ts` builds the screen those cases read, the journal turn behind it, and the three answers a blob can give, each one a patch on a fixture the unit suite already uses. ([1448b1a7](https://github.com/AltanS/collie/commit/1448b1a7))
- **Hermes panes get transcript history.** Collie reads Hermes SessionDB through the exact Herdr session ID, including compressed parent sessions, without writing to Hermes state. ([85e0da5e](https://github.com/AltanS/collie/commit/85e0da5e))
- **The update notice says when a release changes the crew link.** An install that is part of a crew reads the new `collie-release.json` asset every release now publishes, sees that the release ahead speaks a different crew wire version, and says so on the band, above the confirm on the Updates card and in the daily push: update the lead first, the members follow. The reading is a number, not a release name, so the release after this one says it too. A solo install says nothing, the confirm button keeps its wording, and every release before 1.8.0 published no asset and reads as no change. ([f39cbddc](https://github.com/AltanS/collie/commit/f39cbddc))
- **Seven browser cases pin the update path from one bundle to the next.** The browser tier now builds the web bundle twice and serves either build from a swappable path, so a page holding the precached shell of one build can be handed the other, which is what a deploy looks like to a phone. The cases cover the footer chip, the automatic check, a tap during an install, a proxy sign-in path the precache must never answer, and the three paths that fit the 2026-09-09 stall: a failed worker-script fetch, three taps on one installing worker, and the stuck guard reloading onto the stale build. ([bb095e3a](https://github.com/AltanS/collie/commit/bb095e3a))

### Changed

- **Update the lead first: the crew wire moves to protocol version 2.** This completes the rename that 1.7.0 began: 1.7.0 changed what you read, 1.8.0 changes what the machines read. The paths become `/crew/v1/*`, the headers `X-Crew-*`, the signing contexts `collie-crew-warrant-v2` and `collie-crew-dial-v2`, and `CREW_PROTOCOL_VERSION` is 2. A 1.8.0 lead keeps answering `/pack/v1/*` in the version 1 shapes for one release, and a 1.8.0 member falls back to that prefix once against a lead still on 1.7.0 and writes one journal line per lead saying it did, so a crew can be rolled lead first with no member cut off. The fallback fires on the answer a 1.7.0 collie really gives an unknown path, the app shell served with `Content-Type: text/html`, as well as on a `404`, a `403` and a version 1 header. The crew id in a warrant, in a standby-device sync and in the enroll answer is written `crewId` and read under either spelling, so no signature and no stored file changes meaning. Both halves of that overlap are removed in 1.9.0, from when a 1.7.0 member no longer talks to a newer lead. ([305c3291](https://github.com/AltanS/collie/commit/305c3291))
- **Every state card in the playground carries a stable handle.** The dev-only states page now renders a `data-state` id on each card, flat kebab-case and unique across the page, so a browser test can address "the update band with a run in flight" without matching the card's prose label. The handle is a required prop, so a new card cannot be added without one, and a unit test refuses a repeat. The controls that switch a card between two states gained accessible names for the same reason. Nothing changes in the shipped bundle: the playground stays out of `web/dist`. ([48286a70](https://github.com/AltanS/collie/commit/48286a70))
- **The crew's own files and identifiers say crew.** `bridge/pack/` is now `bridge/crew/`, `cli/pack.ts` is `cli/crew.ts`, the phone's crew route and its four components follow, and every `Pack…` type, function and constant is spelled `Crew…`, as are the `pack.*` translation keys. Nothing moves on the wire, on disk or in the environment: the `/pack/v1/*` paths, the `X-Pack-*` headers, `PACK_PROTOCOL_VERSION`, `COLLIE_PACK_*`, the three `pack-*.json` state files, the `[pack]` journal prefix, `/api/pack` and the `collie pack` alias all keep their names in this change. The commit-hook hatch is now `SKIP_CREW_WIRE_CHECK=1`. ([12c746f7](https://github.com/AltanS/collie/commit/12c746f7))
- **The environment keys, the state files, the journal and the census say crew.** Reading the crew's own names: `COLLIE_CREW_TIMEOUT_MS` and `COLLIE_CREW_HELLO_TIMEOUT_MS` replace the `COLLIE_PACK_*` pair, `~/.local/state/collie/pack-trust.json`, `pack-ops.json` and `pack-runtime.json` are renamed to `crew-trust.json`, `crew-ops.json` and `crew-runtime.json` on the first start, the journal prefix is `[crew]`, a forwarded write is audited as `via: "crew"`, the phone reads the census at `/api/crew`, and the crew's update rows on `/api/update/check` and inside every `collie update --check --json` document are `crew` rather than `pack`, with `dismissedCrewVersion` for `dismissedPackVersion` in `update-state.json`. Nothing is lost and nothing has to be edited today: each old name still works for this one release, an old state file is moved rather than copied, the old inner keys (`pack`, `packId`) are read once and written back as `crew` and `crewId`, a preflight document printed by a member still on 1.7.0 is read under either spelling, the old dismiss key is read once and written back under the new one, `/api/pack` answers a 308 to `/api/crew`, and one warning line at start names any old environment key still in use. Every one of those overlaps is removed in 1.9.0, so rename the two keys in your own `.env` before then. On a journal that spans the update, grep for both prefixes. If you have a script that greps `[pack]`, reads `pack-trust.json` or calls `/api/pack`, it needs the crew names now; `/api/pack` answers 308 for one release, the rest does not. ([c529e3fd](https://github.com/AltanS/collie/commit/c529e3fd))

### Fixed

- **A reply on OMP's Pi composer could be sent before Enter had actually confirmed it, or with a completion the user never accepted.** The guard now reads the draft back and verifies it before sending, so an unconfirmed line is not silently dropped or included as if it had been typed. A ghost completion Pi offered but the user did not accept is stripped before send. A multiline reply now goes out in verified parts, not as one unchecked block. The paste chip is treated as opaque, since it never showed what would actually be pasted, so it can no longer count as evidence that Enter worked. Thanks SeongQ kim (#192), closes #34. ([47369fb4](https://github.com/AltanS/collie/commit/47369fb4))
- **A stale member record made `collie crew update <member>` impossible to fix.** The preflight walked every member over ssh using the route the ops file remembered, and it ran before `--host`, `--path` and `--port` were used against a machine. A record pointing at a checkout that had moved therefore went red with a remedy naming those exact flags, and passing them changed nothing. The overrides now reach the walk, so the printed remedy clears the red on the next run. ([03eb7a87](https://github.com/AltanS/collie/commit/03eb7a87))
- **A second tap escapes the update that keeps coming back stale.** When the eight-second guard behind "new build, tap to update" reloads the page and the phone comes back on the same old bundle, the next tap now unregisters the service worker and reloads from the bridge instead of starting the identical wait again. It only does that while the bridge is still answering the ordinary poll, so an offline install keeps its precache and its stale bundle rather than landing on an error page. This is the 1.6.0 to 1.7.0 stall on the release lane, where every tap cost a reload and the new bundle took about three minutes to arrive. ([bb095e3a](https://github.com/AltanS/collie/commit/bb095e3a))

### Docs

- **The new browser suite has a place in the docs.** `CLAUDE.md` says how to run each tier and how to add a case, `CONTRIBUTING.md` tells a contributor CI runs it and they need not, and the workspace README documents `make e2e`. ([2221ae8c](https://github.com/AltanS/collie/commit/2221ae8c))

## [1.7.0] - 2026-09-09

### Added

- **The fetch and the build of an update report themselves.** A run record is written when staging begins instead of when it ends, and the steps are appended to a small file the bridge reads and folds into that record, so the phone shows what is happening over the longest part of an update instead of saying "Starting…" for a minute. A staging that gives up says so at once, rather than leaving a run that looks live for ten minutes with the button locked, and a second update started beside a live one no longer writes over the live one's record. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A running update proves it is running.** The Updates page shows which of the four steps it is on and a clock that ticks every second on the phone's own time, so it keeps moving through the restart when the bridge is unreachable and every poll fails. The page also polls fast while a run is in flight instead of every six seconds, and it dropped one of its three pollers. Past ninety seconds the restart stops saying it is not an outage and says what to check. The phase name and the moving counter are new in this release; seeing them during an update is expected. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a), [bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **An AI coding agent in your terminal can read Collie's own manual with `collie skill` and `collie docs`.** `collie skill` prints a brief on how Collie works, and `collie docs` prints the operator pages, both out of the compiled binary rather than off disk, so a packaged install answers exactly what a checkout does and neither needs the network. `collie docs` lists the ten pages, `collie docs <name>` prints one, and `collie docs --all` prints every one behind a marker an agent can split on. `collie --skill` is the flag spelling of the first. ([3edb9667](https://github.com/AltanS/collie/commit/3edb9667), [bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **A crew can be renamed.** `collie crew rename <name>` on the lead rewrites the crew's name and restarts the bridge, so `collie crew status` and the phone's crew page show it at once. The name is display data the lead hands out once at enrollment, so nothing is sent to a member: a machine that joins after the rename gets the new name, and the members already there keep the old string in a field nobody reads. It refuses on a peer and on a machine in no crew. A crew created without `--name` is called "collie crew". ([4d2f3f5b](https://github.com/AltanS/collie/commit/4d2f3f5b))
- **`crew add` offers the hosts this machine already knows.** `collie crew add` with no target now lists candidates instead of printing the usage line: the `Host` entries in your `~/.ssh/config`, and the machines `herdr machine list --json` reports. One machine is one row, merged on the ssh target each name resolves to with `ssh -G`, which never connects. Each row says whether the name came from your ssh config, from herdr, or from both, and a row this lead already leads carries that member's id and is not offered. An `Include` is followed one level deep and only under `~/.ssh/`. Nothing is added until you pick a row, and the confirm still runs. With a target the verb behaves exactly as before. ([e54780ab](https://github.com/AltanS/collie/commit/e54780ab))
- **A peer link tells reconnecting apart from needing you.** A member the lead cannot reach used to read one way whether it was a timeout or a wrong pack secret. The lead now says which it is: reconnecting means it is retrying and there is nothing for you to do, and it is no longer red, while needs attention means retrying will not fix it, and the crew page adds the sentence that says which. The lead also stamps every dial with a counter, so a slow answer from a dial it has already re-made is dropped and logged instead of overwriting a newer one. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **Each machine in a crew answers for its own multiplexer.** A control on a member's pane used to be shown or hidden by what the lead's multiplexer can do, which is the wrong machine's answer whenever the two differ. Every member now reports its own capabilities to the lead over the pack link, and the lead answers `/api/config` per host from what it already holds, so it dials nobody to answer a page load. A member that says nothing keeps the lead's answer, which is exactly what it got before, so a peer running an older build changes in no way. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **The mux conformance set can be run against a peer, through the lead.** `bun scripts/pack-mux-probe.ts --lead <url> --host <member>` points the read-only checks at a member's multiplexer over the pack link, with no host ever reaching a mux adapter. It reports what the pack surface cannot express instead of scoring those checks green: four port verbs have no forwardable route, the pane read fixes the grid request shape, and a capability that is a write is never sent across a live link. It has been run against a tmux member and a zellij member under a herdr lead, and both scored the same, so what fails is the route table and not the multiplexer. `MUX_CONTRACT.md` says which check is gradable on which side. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **Images from an Oh My Pi or pi agent show up on the phone.** Where the agent leaves graphics placeholders on the screen, as Oh My Pi does with `PI_KITTY_PLACEHOLDERS=1`, the live mirror draws the picture beside them, matched by ORDER, so it is usually but not always the right one; the card says so on its face, and the pane's History is exact. pi draws its pictures without placeholders, so in this release they reached History only, not the live mirror (corrected after #292). History renders a picture the agent attached and a screenshot one of its tools returned, instead of dropping both, and in the mirror the black box becomes an image card, or an "[Image]" badge where the ordering had no image left to give. Only a journal blob or inline image bytes are loaded, never a web address out of the agent's log. A member's images are served by the machine whose journal named them and come through the lead, and a peer on an older build shows the badge rather than a broken picture. Thanks @Codder13 (#181, #193), reported in #180. ([fd28d018](https://github.com/AltanS/collie/commit/fd28d018), [fbae4cf6](https://github.com/AltanS/collie/commit/fbae4cf6), [8e8cf78a](https://github.com/AltanS/collie/commit/8e8cf78a), [ba8e19a0](https://github.com/AltanS/collie/commit/ba8e19a0), [797318d6](https://github.com/AltanS/collie/commit/797318d6))
- **`omp` panes get a transcript.** Oh My Pi writes pi's own format, so `omp` is read as a second name for the pi journal, and `~/.omp/agent/sessions` joins `~/.pi/agent/sessions` as a default root. This touches every pi user: a machine with an `~/.omp` folder now has those sessions read too, and `COLLIE_PI_ROOT` still overrides both roots. Thanks @Codder13 (#181, #193), reported in #180. ([fd28d018](https://github.com/AltanS/collie/commit/fd28d018), [fbae4cf6](https://github.com/AltanS/collie/commit/fbae4cf6), [8e8cf78a](https://github.com/AltanS/collie/commit/8e8cf78a), [ba8e19a0](https://github.com/AltanS/collie/commit/ba8e19a0), [797318d6](https://github.com/AltanS/collie/commit/797318d6))

### Changed

- **The group of machines is called a crew, and the word you type changed with it.** The command is `collie crew` and the web page is `/crew`, with the same verbs, arguments and exit codes as before; `collie pack` and `/pack` keep working and go away in 2.0.0. `collie pack` prints a one-line note on a terminal and nothing in a pipe: the note goes to stderr, so a script that reads status output on stdout sees exactly what it saw before. Nothing on the wire, in the env or on disk changes: the protocol paths, the headers, `COLLIE_PACK_*` and the state files keep their names, so a 1.6.0 member keeps talking to a 1.7.0 lead while you level them one at a time. The docs page moved from `collie docs pack` to `collie docs crew`, and the old name still prints it. A crew created without `--name` is now called "collie crew"; a crew you already have keeps the name it was given ([ADR 0038](./.adr/0038-the-group-is-a-crew-the-wire-keeps-pack.md)). ([15f1f987](https://github.com/AltanS/collie/commit/15f1f987), [db6f9a5e](https://github.com/AltanS/collie/commit/db6f9a5e))
- **The list of sessions on one machine now comes from the multiplexer you run, not from Herdr's layout.** The last switch in the bridge that read the multiplexer's name is gone. An adapter now declares whether this machine runs other instances of it and hands back the endpoint for each, and a multiplexer that keeps no such list refuses the question instead of being assumed to have nothing. Herdr declares it and still fronts every named session under your config root, exactly as before. tmux and zellij decline it, each for a reason written into the capability table: tmux has no command that lists servers and leaves a dead server's socket on disk, and zellij answers every read with a process rather than over a socket, so one Collie there drives the one session you pointed it at. `COLLIE_MULTI_SESSION` keeps its meaning as your own off switch. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))

### Fixed

- **The release page lists what changed, grouped, and drops GitHub's own list.** The update command still sits at the top, unfolded, and below it the page now prints the changelog's own lead sentences under Added, Changed, Fixed, Packaging and Docs, then the version's changelog section for the commits and a compare link against the previous tag. GitHub's generated list only knew merged pull requests, and most of Collie's history lands as direct commits, so it read as an almost empty release. ([fc98468b](https://github.com/AltanS/collie/commit/fc98468b))
- **A missing protocol header means the lead learned nothing, not that the peer is foreign.** An answer with no `X-Pack-Protocol` header, from a proxy in front of a peer that is restarting, from a wrong path, or from a machine that is not in a crew at all, is now unreachable and keeps the normal dial cadence. The reason names the HTTP status and how long it has been saying nothing. Only a header that names another version, or a peer that refuses us for skew, is incompatible and goes on the thirty second, two minute, ten minute ladder. The rule is bounded in time, not in answers: a member that has been headerless for over a minute falls back onto that ladder, and any answer that names a version closes the window. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A crew update always ends.** While a run is levelling a peer, that peer is dialled on every sweep whatever backoff it is on, so a peer that answers three dials as incompatible no longer hides a run for ten minutes. A leg that has not changed state for twenty minutes fails, the run settles the moment every leg is terminal, and a run left behind by a crash is not resumed twenty minutes later. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A leg the wall clock failed stays failed.** The twenty minute clock reached the right verdict and the next sweep, one second later, wrote it straight back to waiting, because a leg is minted fresh from the member's own facts every sweep and those facts do not change when a clock runs out. The run was then queued again and could not end, which is the one thing this work is for. What clears the failure now is the member reaching the release, and nothing else. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A peer that speaks to its lead is dialled again at once.** Any request that passes the pack link's two factors clears the backoff the lead was holding against that machine, and the next sweep dials it. Bounded to one reset per member every ten seconds, and to five resets before the lead's own ladder stands again. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **The update band asks for a reload with a reload mark.** Not with the up-arrow that means a new version is on offer, so a band that wants a tap no longer reads as a second update. A tap is also never swallowed by an automatic reload that already ran: the two share a guard against navigating twice, and a reload that does not actually leave the page gives the tap back three seconds later. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **The update button on the Updates page holds one position.** The peer list and the preflight now open below it instead of above, so the button no longer moves 368 pixels down the screen when they arrive, and the confirm that replaces it stays inside a phone viewport. The button also stays disabled, and says it is checking, until the preflight has answered. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A peer's version on the Updates page refreshes on its own.** It refreshes after a crew update, with no pull to refresh. A run that levels only the peers writes no record on the lead, and the page used to drop that run entirely and stop asking for a fresh census. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **A peer that will not level itself says why, on its own journal.** A peer decides eight times before it self-levels, and it used to decide in silence: the lead's leg then sat on "waiting" for the whole twenty minute wall clock and failed with a reason that named no cause. The peer now writes one line naming the guard that stopped it, and only while the lead's turn names that machine, so the line appears where an operator is asking why and not on every sweep of every day. Nothing new goes over the pack link. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **The Updates page keeps up with a peer while you are looking at it.** The page reads the members' progress out of the answer it just polled, instead of out of a copy of an older run it fetched when it opened. The band would say a member could not be updated, or that another was still going, over a page that showed the run before it, until you reloaded. A peers-only retry now moves the rows within one poll, and the band and the page go quiet together. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **The update band and the Updates page read one function.** They can no longer disagree about whether the crew is still moving. A peer that is still updating keeps the band up however long it takes, instead of going quiet after ten minutes over a page that was still counting. Past two minutes the band names the elapsed time and the page says no action is needed. A peer that could not be updated says so in one sentence on both, carries a Retry now button, and can be put down. ([90fc363a](https://github.com/AltanS/collie/commit/90fc363a))
- **An update tapped on the phone reaches its runner.** On a linked-clone or a binary install the staging process handed the swap to a detached `systemd-run` and exited at once, and exiting killed the client before the user manager had started the runner, so the run record sat at `staging` for ten minutes with the lock held and the old version still serving. The handoff now waits for the manager to accept the job, for at most fifteen seconds, and prints "handed off" only after it has. A handoff the manager refused is an abort carrying the tier, the exit code or the word timeout and the manager's own first line, so the phone shows the failure within one poll and the retry is not refused. A launch tier with no manager to ask now declines to start from inside a service instead of dying mid-swap. A machine already stuck at `staging` is cleared by hand, and `docs/troubleshooting.md` carries the steps under "an update started from the phone stays at staging". ([c7191904](https://github.com/AltanS/collie/commit/c7191904), [bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))

- **A tab on zellij counts the panes you can reach, and a launcher beside a zellij pane runs.** Two things a zellij session showed for the first time when one was put under a lead. A tab's pane count came off zellij's own listing, which counts zellij's tab bar, status bar and any floating overlay, so a tab with two shells in it said three. And zellij reports no working directory for a pane, so a launcher row started beside one asked zellij to open a tab in a directory called nothing and zellij refused the whole launch. Counts are now counted off the panes Collie publishes, and a blank working directory means "wherever you would have opened it" on all three multiplexers rather than being passed down as a path. A launch onto a member no longer times out on the lead's poll budget either: a forwarded write gets its own 5 s deadline, so a launch that spawns a process on the far machine comes back as the tab it made instead of an outcome the phone could not confirm. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))

- **The all-sessions view follows the machine you are looking at.** `?all=1` widened the collie your phone is connected to, whatever host the page was scoped to, so the switch and the machine picker disagreed about which machine was on screen. They compose now: with a member selected the view widens that member. The lead also asks every member for all of its sessions on the sweep it already makes, and narrows the answer per request, so a pane in a member's second session is reachable at all, which it was not before. A member running one session sends and shows exactly what it sent and showed before, and nothing about the pack protocol version changes. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))

- **The skew warning names the remedy that matches the direction.** `collie crew status` told you to run `collie crew update <member>` for any version difference, including one where the lead was the older machine — and that command pushes the lead's build outwards, so it would have taken a newer member backwards. The line now says which side is behind: a member behind this lead gets the `crew update` it always got, a member ahead of it gets `collie update` here instead, and two different strings for the same version name no command at all. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **The service check no longer calls a healthy systemd unsupervised.** `systemctl --user show-environment` needs `XDG_RUNTIME_DIR` or `DBUS_SESSION_BUS_ADDRESS`, and a Herdr plugin action passes neither, so `collie update --check` reported "no service manager on this host" on a machine where the bridge was running under `systemd --user` all along, and pushed the update handoff to a tier ADR 0037 refuses from inside a service. A failed probe now retries once with a derived `XDG_RUNTIME_DIR`, never overriding a value already set, and a container with no user manager still reads as unsupervised (reported by @lloydsilvertwo in #194). ([c7191904](https://github.com/AltanS/collie/commit/c7191904), [bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))
- **A binary install's restart recognises its own bridge across a version flip.** The pidfile guard compared the old bridge's command line with the path of the version now executing, and the two never agree after a flip, so the old process was never stopped, kept the port, and every update on an unsupervised binary install rolled back. The guard now ignores the version directory on both sides and still refuses a bridge from a different install root. Thanks @chernesk (#195). ([f3c3c22c](https://github.com/AltanS/collie/commit/f3c3c22c), [9975839a](https://github.com/AltanS/collie/commit/9975839a))

### Docs

- **A Herdr machine list is not a crew.** Herdr 0.9.0 keeps saved ssh machines in its own client, for its own window, on the machine you are sitting at. A crew runs Collie on every machine, reached from your phone through the lead, and handles uploads, the journal, the audit log, updates, and failover on each machine; it also runs under tmux and zellij, which keep no machine list. The two lists stay separate on purpose, and [ADR 0036](.adr/0036-the-map-of-machines-is-collies-a-mux-reports-one-machine.md) records why. [`docs/crew.md`](./docs/crew.md) compares them row by row, and `collie crew add` offers Herdr's machines as candidates so you never type a host twice. ([bd3adc5f](https://github.com/AltanS/collie/commit/bd3adc5f))

## [1.6.0] - 2026-09-08

### Added

- **mise installs Collie on Linux and macOS.** `mise use -g github:AltanS/collie@<version>` fetches the release tarball for that platform, and the install page documents it beside the Arch and Nix routes. mise owns updates on such a tree, with `mise upgrade --bump` and a `collie restart` to move the service off the old version directory, whether that service is a systemd unit or a launchd agent. `collie update` declines there without naming a package manager, because a mise tree is neither a checkout nor a packaged install, and the page says so. ([0febef5](https://github.com/AltanS/collie/commit/0febef5), [0062b91](https://github.com/AltanS/collie/commit/0062b91))
- **`collie doctor` and `collie update` find their tools on Windows.** The tool search finds `git`, `herdr`, `python3` and `bun`: it reads `PATH` with the Windows separator, tries the `PATHEXT` suffixes, and reads the variable under either spelling, so a Windows host no longer reports every tool as missing and the Updates page gets a real preflight. Windows stays a source-only platform that we do not test on hardware. The search can also find a `.cmd` or `.bat` shim that Collie then cannot start, because it spawns these tools without a shell, so a Windows host needs the `.exe` builds of `git`, `herdr`, `bun` and `python3` on `PATH`. Thanks to @jz-wilson (#175). ([d80ebbe](https://github.com/AltanS/collie/commit/d80ebbe), [daa5bdb](https://github.com/AltanS/collie/commit/daa5bdb), [0062b91](https://github.com/AltanS/collie/commit/0062b91))
- **A Claude pane is read only when its screen has changed.** A herd of idle agents no longer costs one socket read per pane per poll, because the pane is read for its session name only after a change. This uses Herdr's pane revision; tmux and zellij panes are read as before. Thanks to @sd2k (#189). ([198fe20](https://github.com/AltanS/collie/commit/198fe20), [258341b](https://github.com/AltanS/collie/commit/258341b))
- **Turning the phone to landscape opens zen.** Turning it back closes it, and a zen you opened yourself stays open through both. This works when zen is enabled. The switch sits under Zen in Settings, off until you turn it on, and it acts only while zen itself is on. Desktops and tablets are landscape all day and are not affected. Thanks @enieuwy (#182). ([36d7b97](https://github.com/AltanS/collie/commit/36d7b97), [3e1033d](https://github.com/AltanS/collie/commit/3e1033d), [5af27c9](https://github.com/AltanS/collie/commit/5af27c9), [4bf3696](https://github.com/AltanS/collie/commit/4bf3696))
- **A reply that scrolled off the terminal is shown in full.** The reply comes from the agent's own log, in place of the rows it covers, and Settings → View → Full latest reply turns it off. Thanks @sd2k (#185). ([46d2fe6](https://github.com/AltanS/collie/commit/46d2fe6), [d433ce8](https://github.com/AltanS/collie/commit/d433ce8))
- **Collie recognises OMP's `rule` composer.** A phone reply reaches an OMP 18.1.10 pane configured with `composer.shape: rule` instead of stalling with "the message did not reach the input box". Thanks @taiansu (#160). ([72fbfec](https://github.com/AltanS/collie/commit/72fbfec), [67b72e3](https://github.com/AltanS/collie/commit/67b72e3))

### Fixed

- **Every command Collie prints for Herdr names its own plugin id.** This holds for every restart and update command, and names the plugin id of the instance that printed it. A host running a second Collie under `COLLIE_INSTANCE` used to be told to invoke `herdr.collie`, which is the host's first Collie and not the one asking, so following the line restarted the wrong service. ([68bb345](https://github.com/AltanS/collie/commit/68bb345))
- **A binary replaced under the running service is noticed.** A package upgrade is caught even when the version does not move: `collie doctor` reports `restart-pending` against the executable itself and names `collie restart`, and the phone raises the same notice. `pacman` replaces the files and restarts nothing, and the check used to say something else did. ([4cb544e](https://github.com/AltanS/collie/commit/4cb544e))
- **`collie pack update` on a packaged lead names the boundary.** It no longer reports a broken checkout. It used to fail with "is not a git checkout" about `/opt/collie`, which pacman owns and which carries no commit to push; it now says updates come from the package manager and sends the operator to the phone's Updates page, where the members still level to the version the lead is running. ([187a0dd](https://github.com/AltanS/collie/commit/187a0dd))
- **`collie serve` stops when the tailnet has no HTTPS.** It says so instead of looking hung. Tailscale asks for HTTPS to be enabled and waits for the answer, and Collie captured that question until the command returned, which is the one case where it never does. Collie now reads the tailnet's certificate domains first and names the admin console, `collie doctor` reports the same tailnet, and the publish runs on the operator's own terminal so anything tailscale prints while it waits is visible. Thanks @nikolauska (#172). ([da8afeb](https://github.com/AltanS/collie/commit/da8afeb))
- **Turning on notifications no longer sticks on "setting up".** A configuration read that fails leaves the switch retryable instead of disabling it, every service worker and PushManager wait is bounded at 30 seconds, registration goes through the shared API client so a sign-in redirect or a server error is reported beside the switch, and the phone reads as subscribed only after the bridge acknowledged the endpoint this device registered. Thanks @Shujakuinkuraudo (#178, #179). ([6fa2694](https://github.com/AltanS/collie/commit/6fa2694))
- **`collie serve` says when it cannot read the HTTPS status.** It publishes anyway. A `tailscale status --json` this build cannot read means "can't tell", never "no HTTPS", so the refusal above stays off that path; the line names the admin console in case the publish does stop and wait after all. ([0062b91](https://github.com/AltanS/collie/commit/0062b91))

### Packaging

- **`collie-bin` is not on the AUR yet.** The install page says so. The AUR has paused new account registration, so the Arch route is a clone of this repository and `makepkg -si` in `packaging/aur`, with the `paru -S collie-bin` line kept below it under "Once it is on the AUR". ([d7dd6d9](https://github.com/AltanS/collie/commit/d7dd6d9))
- **The Arch package installs to `/opt/collie`.** That is the layout Omarchy's package repository expects, and the package ships the metadata that repository uses to follow Collie's releases; a host under `/opt/collie` is told `sudo pacman -Syu collie-bin` like one under `/usr/lib/collie`. ([4480964](https://github.com/AltanS/collie/commit/4480964))
- **The Arch package prints what to do next.** This covers installing, upgrading or removing it. pacman names `collie start` and the `COLLIE_MUX=herdr` form a host with two multiplexers needs, says the running service keeps the old build until `collie restart`, warns before a removal that the `systemd --user` unit and the tailscale serve mapping stay unless `collie uninstall` ran first, and afterwards names the directories left behind. Omarchy's repository carries the same file. ([187a0dd](https://github.com/AltanS/collie/commit/187a0dd))
- **The Arch package trims `depends` and files its docs.** It no longer names `systemd` in `depends`, which is the init of every Arch and Omarchy host anyway, and it offers `herdr` and `tmux` as optional dependencies, one per multiplexer Collie can drive on such a host. `README.md`, `CHANGELOG.md` and `docs/` now install to `/usr/share/doc/collie-bin/` and the licence to `/usr/share/licenses/collie-bin/`, instead of sitting in the install root where nothing reads them at run time. ([4480964](https://github.com/AltanS/collie/commit/4480964))

### Docs

- **A packaged install can be linked into Herdr.** `herdr plugin link /opt/collie` registers Collie's action buttons there, and Herdr never finds the package on its own because it does not scan `/opt`. The install page used to say there is no `herdr plugin link` step at all, and the plugin's `update` and `update-major` actions declining on a packaged tree is the design, not a fault. ([e4e7e9f](https://github.com/AltanS/collie/commit/e4e7e9f))

## [1.5.6] - 2026-09-07

- Collie carries its own package recipes: `packaging/aur` for Arch (`collie-bin`, not yet on the AUR) and `packages.<system>.collie` from this repository's flake for Nix. Both wrap the release tarball, neither builds anything, and neither updates itself, because the package manager owns that folder. ([bb46def](https://github.com/AltanS/collie/commit/bb46def), [43a23a2](https://github.com/AltanS/collie/commit/43a23a2))
- The flake's default package is Collie, so `nix run github:AltanS/collie` runs it. The pinned Bun the release is built with is still there, as `packages.<system>.bun`. ([43a23a2](https://github.com/AltanS/collie/commit/43a23a2))
- The update band remembers a dismissal on the host instead of in one browser, the quiet pack notice can be put down on its own, and a host whose updates come from its package manager reads "Collie 1.6.0 available via pacman." instead of an offer to tap. ([23b5934](https://github.com/AltanS/collie/commit/23b5934), [2be3547](https://github.com/AltanS/collie/commit/2be3547), [f630c1c](https://github.com/AltanS/collie/commit/f630c1c))
- A Mac or an arm64 Linux host on 1.5.4 or 1.5.5 gets a binary that starts again. A host whose binary will not start reinstalls with `curl -fsSL https://colliepwa.dev/install.sh | COLLIE_TAG=v1.5.6 sh`; a host still on 1.5.3 updates as usual, and linux-x64 was never affected. Those two releases were compiled on the build environment's patched Bun, so the Mac binary loaded ICU out of `/nix/store` and the arm64 Linux binary named a `/nix/store` program interpreter. The release now compiles on the upstream Bun archive the flake pins and refuses any binary whose loader inputs point outside the system's own library roots, thanks @rapporbit (#184). ([33df273](https://github.com/AltanS/collie/commit/33df273), [9d07868](https://github.com/AltanS/collie/commit/9d07868))
- The pack journal names each peer's leg change, each incompatible verdict with the reason and the backoff it earns, and the moment a run settles. A run that sits waiting on a peer is now read out of `journalctl --user -u collie` instead of inferred from the arithmetic. ([3ea0108](https://github.com/AltanS/collie/commit/3ea0108))

## [1.5.5] - 2026-09-07

- The pack treats a packaged member as a quiet member instead of failing it, the phone says which host waits for its package manager, and a package swap under a running bridge asks for a restart. ([1df2451](https://github.com/AltanS/collie/commit/1df2451))
- The attach button asks Photos or Files, so the camera roll is on offer again: one `accept` cannot carry `image/*` and thirty text extensions without a phone hiding the gallery. ([9fa55a7](https://github.com/AltanS/collie/commit/9fa55a7))
- The attach button answers a tap at once, with a haptic tick and a filled tone, and its picker opens above the button rather than over it. A bottom sheet covered that button 42ms after the tap, so nothing drawn there to acknowledge the tap could be seen at all. ([9fa55a7](https://github.com/AltanS/collie/commit/9fa55a7), [495b9c7](https://github.com/AltanS/collie/commit/495b9c7))
- The Updates card holds its place while it checks and stays put for the whole run: the preflight and the peer lines arrive through a `Collapse`, the action button is disabled from the tap onward instead of vanishing, and it says what it is waiting for. ([689dcb2](https://github.com/AltanS/collie/commit/689dcb2))
- Codex prints its queue hint and its context metric on one footer row while a turn is active, and the parser now knows that shape, so a reply there stops reporting that it never reached the input box, thanks @stekman08 (#176). ([0ad4f2f](https://github.com/AltanS/collie/commit/0ad4f2f))
- The guarded submit is bound to the prompt the verifying read saw, so a dialog that takes focus between the typing and the Enter is refused instead of answered, thanks @stekman08 (#177). ([e7c1c78](https://github.com/AltanS/collie/commit/e7c1c78))
- `Collapse` waits for a painted frame before it opens, so content that arrives late slides in instead of jumping. Every enter whose child mounted and opened together was a jump before this, which is every late arrival the primitive exists for. ([bffe062](https://github.com/AltanS/collie/commit/bffe062))
- New `AnchoredMenu` primitive: a small menu that opens above its trigger instead of over it, for a control near the bottom edge that a bottom sheet would cover. ([ffd89b0](https://github.com/AltanS/collie/commit/ffd89b0))

## [1.5.4] - 2026-09-07

- Confirming a pack update on the phone levels the peers on an ordinary checkout install, instead of updating only the lead and leaving "Retry pack update" to be tapped by hand. That install kind never recorded the run the lead's turn queue is rebuilt from after its own restart. ([d9eb459](https://github.com/AltanS/collie/commit/d9eb459))
- `collie update` hands off to `systemd-run` only when the systemd user bus is reachable, not just when the binary exists, so a container with systemd installed but not running no longer wedges every update in staging, thanks @chernesk (#174). ([cdbd1a9](https://github.com/AltanS/collie/commit/cdbd1a9))
- Collie recognises an install its package manager owns, declines to update it, and names that manager's command instead, on the terminal and on the phone, thanks @mikebenner (#171). ([8fe3180](https://github.com/AltanS/collie/commit/8fe3180))
- The release tarball carries `scripts/collie-ctl.sh`, the shim every action in its own `herdr-plugin.toml` names, thanks @mikebenner (#171). ([6eb2d17](https://github.com/AltanS/collie/commit/6eb2d17))
- The upload cap is a setting, `COLLIE_MAX_UPLOAD_MB`, and `COLLIE_UPLOAD_EXTRA_TYPES` adds text types the shipped list misses. ([e1493f4](https://github.com/AltanS/collie/commit/e1493f4))
- The pack lead's oversize refusal is named `upload_too_large`, not `image_too_large`, now that it is not only about images. ([e1493f4](https://github.com/AltanS/collie/commit/e1493f4))
- The composer attaches text files as well as images — markdown, code, config and logs — behind a paperclip in place of the picture icon. ([9833ba3](https://github.com/AltanS/collie/commit/9833ba3))
- A truncated error in the header opens on a tap, showing the whole message with a copy button. ([747afaa](https://github.com/AltanS/collie/commit/747afaa))
- The update preflight and the update itself both look for Bun where the shim looks, `$BUN_INSTALL` included, so a Bun off your PATH is green with the path it will run rather than a red that blocks the update, and a file that cannot be executed is no longer taken for a Bun (#169). ([547b198](https://github.com/AltanS/collie/commit/547b198), [77b3f1e](https://github.com/AltanS/collie/commit/77b3f1e))
- `flake.nix` pins the tools a release is built with — Bun, Node, git, tmux and zellij — and the release workflow builds inside that flake, so a published binary names the toolchain that produced it. ([7636222](https://github.com/AltanS/collie/commit/7636222))
- A pre-commit guard refuses a `flake.lock` that moves outside a release commit, so the pinned toolchain and the version move together or not at all. ([b00afe1](https://github.com/AltanS/collie/commit/b00afe1))

## [1.5.3] - 2026-09-06

- Release checks and tag fetches stay on HTTPS when a git `insteadOf` rule rewrites GitHub URLs to SSH, so a service without an SSH key can update again, thanks @magoz (#170). ([b3bd127](https://github.com/AltanS/collie/commit/b3bd127))

## [1.5.2] - 2026-09-05

- STT releases its admission slot immediately when a recording is cancelled, thanks @en-ver (#163). ([43c9cfe](https://github.com/AltanS/collie/commit/43c9cfe))
- Labelled terminal rules now fit on a single line across all harnesses, and only the rule glyphs are dimmed, thanks @en-ver (#168). ([d980f37](https://github.com/AltanS/collie/commit/d980f37))
- Collie speaks Traditional Chinese, thanks @lekoOwO (#165). ([1cec9ea](https://github.com/AltanS/collie/commit/1cec9ea))
- The pane and history screens now widen with the window on a desktop, up to 1400px, so a wide terminal mirror stops wrapping (#166). ([3870c1c](https://github.com/AltanS/collie/commit/3870c1c))

## [1.5.1] - 2026-09-04

- Docs carry phone screenshots of the update flow. ([23dfb1a](https://github.com/AltanS/collie/commit/23dfb1a))
- The refusal and `collie doctor` now spell the fix as `COLLIE_MUX=<mux> collie start`, and name the file it lands in. ([1d458f6](https://github.com/AltanS/collie/commit/1d458f6))
- `COLLIE_MUX=tmux collie start` now writes the choice to `.env`, so the next plain `start` and the supervised unit both see it. ([1d458f6](https://github.com/AltanS/collie/commit/1d458f6))
- The installed app no longer locks to portrait, so a tablet can run Collie in landscape, thanks @edwinhu (#162); the pane and history screens sit in a centred column above phone width, like every other screen. ([28255ae](https://github.com/AltanS/collie/commit/28255ae))
- Release pages link to the version's changelog section instead of copying it, and carry GitHub's generated list of pull requests, contributors and the compare link. ([cd6feaa](https://github.com/AltanS/collie/commit/cd6feaa))
- `collie pair` prints a QR code beside the code; scanning it opens Settings on the phone with the code filled in. ([8c516b4](https://github.com/AltanS/collie/commit/8c516b4))

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
