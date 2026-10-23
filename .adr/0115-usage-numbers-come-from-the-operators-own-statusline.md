# 0115: usage numbers come from the operator's own statusLine

- **Status:** Proposed
- **Date:** 2026-10-23
- **Shipped in:** pending
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

**The numbers come from the operator's own statusLine, through a wrapper, and from nowhere else.**

1. `collie hooks install claude` rewrites `statusLine.command` to
   `<collie> beacon statusline <base64url of the operator's command> # collie-statusline v1`. Every
   other key of `statusLine` stays where it was. The operator's command travels in the string, so
   there is no second copy of it to go stale.
2. **A settings file with no statusLine gets none.** Collie never adds one, because it would take
   the footer hints away. Such an operator sees the model tag as before, with no dots.
3. The wrapper reads stdin, writes the numbers to `<stateDir>/usage/<digest of the session id>.json`,
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
7. **The context is the session's; the windows are the account's.** A pane shows its own session's
   context, and for each window the newest figure any session of the same harness reported, so a
   quiet session does not show an old 5-hour figure beside a busy one. Only a session that reported
   windows of its own gets them, so an API-key session stays without. The phone lights one dot per
   full fifth: only 100% lights the fifth.
8. **`uninstall` decodes the string and puts the operator's command back exactly.** A file whose
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
