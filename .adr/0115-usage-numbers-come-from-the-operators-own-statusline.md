# 0115: usage numbers come from the operator's own statusLine

- **Status:** Accepted
- **Date:** 2026-10-23
- **Shipped in:** 1.24.0
- **Trail:** Altan, 2026-10-23: the row above the belt should carry the session's context use and the
  5-hour and 7-day subscription windows, as bars or dots. The brief named the other road and asked
  for an explicit yes before it was built: read `~/.claude/.credentials.json` and call the OAuth
  usage endpoint. The Edge integrator asked for this record because `collie hooks install claude` now
  writes into the operator's settings a second time · `cli/statusline.ts` · `cli/hooks.ts` ·
  `bridge/usage.ts` · `web/src/components/model-tag.tsx` · the playground's `#usage-row` ·
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md)

## Context

Three places hold the numbers. The vendor holds them behind the account's OAuth token. The agent
holds them and hands them to exactly one local program: its statusLine command, which Claude Code
runs on every assistant message with a JSON document on stdin (`context_window.used_percentage`, and
for a Pro or Max account `rate_limits.five_hour` and `rate_limits.seven_day`, each with a percentage
and a reset time). The screen holds them too, when the operator's statusline happens to print them.

The vendor road reads the operator's credential and makes Collie a client of the vendor account.
Collie holds no model key, and its v2 check asks of every feature whether it puts a credential of
Collie's on the path to a model. The screen road is a reader per statusline, and every operator writes
their own. The statusLine road needs the agent's own document and nothing else.

A statusLine is not free. With one configured, Claude Code stops drawing most of its footer hints,
`esc to interrupt` among them, and the phone's Claude screen readers use those hints.

## Decision

**The numbers come from the operator's own statusLine, through a wrapper, and from nowhere else.** (amended, see below)

1. (amended, see below) `collie hooks install claude` rewrites `statusLine.command` to
   `<collie> beacon statusline <base64url of the operator's command> # collie-statusline v1`. Every
   other key of `statusLine` stays where it was. The operator's command travels in the string, so
   there is no second copy of it to go stale.
2. **A settings file with no statusLine gets none.** Collie never adds one, because it would take
   the footer hints away. Such an operator sees the model tag as before, with no dots.
3. (amended, see below) The wrapper reads stdin, writes the numbers to `<stateDir>/usage/<digest of the session id>.json`,
   then runs the operator's command through `/bin/sh -c` with the same bytes on stdin and stdout and
   stderr inherited. What Claude Code draws is the command's own output, byte for byte, and the exit
   code is the command's own. `/bin/sh` is what Claude Code uses: its docs say only that the command
   "runs in a shell", and the 2.1.309 bundle (read 2026-10-23) runs a POSIX statusLine through its
   hook runner with `shell: true`, which is `/bin/sh -c`. A statusLine with its own `shell` or `args`
   key runs another way, so it is not wrapped.
4. **A stopped run stops the whole command.** Claude Code starts the command in a process group of
   its own and cancels a run by signalling that group, SIGTERM and then SIGKILL. The shell stays in
   the wrapper's group, so the group signal reaches everything the command started. A signal sent
   to the wrapper alone is passed on to the group; a wrapper that leads no group gives the shell one
   of its own and signals that.
5. **A wrapper failure costs the reading, never the statusLine.** A document that does not parse, a
   missing session id, a full disk, a state dir that is not the operator's own: no file, and the
   command still runs. Outside a multiplexer nothing is written, as the beacon emitter does.
6. **The file holds numbers only.** The bridge keeps a percentage clamped to 0 to 100 and a reset
   time, and draws its own labels (`5h`, `7d`). No text from the document reaches the file or the
   phone. A window whose reset time has passed is dropped. A file older than eight days is removed.
7. (amended, see below) **The context is the session's; the windows are the account's.** A pane shows its own session's
   context, and for each window the newest figure any session of the same harness reported, so a
   quiet session does not show an old 5-hour figure beside a busy one. Only a session that reported
   windows of its own gets them, so an API-key session stays without. The phone lights one dot per
   full fifth: only 100% lights the fifth.
8. (amended, see below) **`uninstall` decodes the string and puts the operator's command back exactly.** A file whose
   beacon hooks are installed and whose statusLine is not wrapped by this build counts as behind, so
   `collie update` prints a nudge in words of its own to re-run the install (`hooks status --check`
   prints `statusline` when that is the only lag).
9. **Not on Windows.** Claude Code runs a statusLine there through Git Bash or PowerShell, not
   `/bin/sh`, so the install leaves the command alone and says so in one line.

The wrapper never reads a credential, makes no network call and never answers anything. Like a
beacon, the reading is a hint the phone draws and nothing decides on.

## Consequences

- The dots exist only for an operator with a statusLine. That is the price of not adding one, and the
  install says so in one line.
- The wrapper adds one process start to every statusLine run: about 85 ms with the compiled binary
  (the Edge review's measure), 97 ms median on bluefin (2026-10-23, no mux, no write). Claude Code
  debounces the runs at 300 ms and cancels a run a newer one replaces.
- The wrapped command names the collie binary by its path. If the binary moves, the statusLine
  prints nothing until the install runs again; `collie update` nudges for it. To change a wrapped
  statusLine the operator unwraps, edits and installs again (docs/multiplexers.md).
- An operator who later replaces their statusLine (Claude Code's `/statusline` does) loses the dots
  until the next install, and `collie update` nudges for it. An operator who wants the hooks and not
  the wrap has no switch today.
- The reading is stored per session and keyed by the session id, not the pane id, which is the key v2
  needs.
- Another harness gets dots by reporting the same numbers to the same file. The phone's code names no
  harness: it draws the gauges the wire carries.
- **Open, Altan's call:** an opt-out that keeps the hooks, declines the wrap and silences the update
  nudge for it. Without one, an operator who unwraps by hand is nudged at every update.
- Revisit if Claude Code puts the same numbers on a hook event. A hook is already installed, and
  the statusLine would then not need to be touched at all.

## Amended 2026-10-24

Altan, 2026-10-24: the usage reading must not depend on the statusLine. The wrap rewrites a line the
operator owns. A binary that moves makes their statusLine print nothing, and a `/statusline` edit
breaks the wrap. Decision items 1, 2, 3, 7 and 8 and the Consequences are amended as follows. The
text above stays as written.

- **The wrap is opt-in.** `collie hooks install claude` leaves `statusLine` alone. Only
  `collie hooks install claude --statusline` wraps a plain statusLine. An install without the flag
  on a file that is already wrapped keeps the wrap and re-points it at the current binary, so an
  Edge 4 operator loses nothing. `hooks uninstall claude` unwraps exactly as before.
- **An unwrapped statusLine is not behind.** `hooks status --check` prints `statusline`, and
  `collie update` prints its nudge, only for a statusLine that is wrapped and names another collie
  binary: that one prints nothing until it is re-pointed. The nudge reads "your wrapped statusLine
  points at an older collie binary; run `collie hooks install claude --statusline` to re-point it."
- **The context comes from the session transcript, through the beacon hooks.** No statusLine is
  involved. `collie beacon emit` reads the end of the transcript on `Stop` and on `PostToolUse` (the
  latter is registered by `--hold-permissions`, so without it the reading moves once a turn). It takes the
  last 256 KiB of `transcript_path`, and from the last assistant line it adds `input_tokens`,
  `cache_creation_input_tokens` and `cache_read_input_tokens`, which is how the agent's own /context
  counts. The path is accepted only when it is absolute, ends in `.jsonl` and is a regular file
  under the Claude config root once every link is resolved. The reading goes to the same usage file
  the wrapper writes and holds numbers only. A reading that fails is no reading, as for every beacon.
- **The window size comes from `SessionStart`, never from the transcript.** The transcript's
  `message.model` is the API id and never carries `[1m]`, so the transcript cannot tell a 200k session
  from a 1M one. The `SessionStart` input carries `model`, the session's model setting, which has the
  `[1m]` suffix for a 1M session (seen on Claude Code 2.1.310: `claude-opus-5-5[1m]`). The beacon
  stores 1,000,000 for a model with that suffix and 200,000 for any other model, in a `window` field
  of the session's usage file that the phone never sees. On `compact` and `clear` it removes the
  context, which is unknown until the next assistant message, and a `compact_boundary` line in the
  transcript with no assistant line after it does the same. On `resume` and `fork` it writes the
  context at once from `context_tokens`.
- **No window, no context.** A percentage needs a window, and a guessed 200k would show a 1M session
  five times too full. A session whose start named no model (`claude -p` sends none) has no
  `window`, and the transcript reading writes no context for it. Known limit: `/model` fires no
  `SessionStart`, so after a switch between a 200k and a 1M model the window stays the one from the
  last start, compact or clear until one of those happens.
- **One file, two writers.** The wrapper and the beacon write the same file and each merges into
  what is there (`cli/usage-store.ts`). The beacon replaces or removes the context and keeps the
  `window` and the running limits. The wrapper replaces the context and the limits and keeps the
  `window`. A kept limit keeps the `at` of the record that reported it, so the bridge's choice of the
  newest window across sessions does not move. A record without `limits` borrows no account windows,
  as before.
- **The 5-hour and 7-day windows still come only from a wrapped statusLine.** Until another source is
  decided, an operator without `--statusline` sees the context dot and no windows. Altan's call.
  Candidate, explicitly not built: Claude Code's own `/api/oauth/usage` endpoint with the operator's
  token, which is the credential road the Context above declined.
- **2026-10-24, later: the windows now come from [ADR 0118](./0118-account-windows-come-from-the-vendors-usage-endpoint-with-the-operators-own-login.md)'s
  source; `--statusline` remains as the second source.**
