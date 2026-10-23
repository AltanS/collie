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
   code is the command's own. A signal that ends the wrapper ends the command.
4. **A wrapper failure costs the reading, never the statusLine.** A document that does not parse, a
   missing session id, a full disk, a state dir that is not the operator's own: no file, and the
   command still runs. Outside a multiplexer nothing is written, as the beacon emitter does.
5. **The file holds numbers only.** The bridge keeps a percentage clamped to 0 to 100 and a reset
   time, and draws its own labels (`5h`, `7d`). No text from the document reaches the file or the
   phone. A window whose reset time has passed is dropped. A file older than eight days is removed.
6. **`uninstall` decodes the string and puts the operator's command back exactly.** A file whose
   beacon hooks are installed and whose statusLine is not wrapped by this build counts as behind, so
   `collie update` prints its usual nudge to re-run the install.
7. **Not on Windows.** Claude Code runs a statusLine there in a shell that `/bin/sh` is not, so the
   install leaves the command alone.

The wrapper never reads a credential, makes no network call and never answers anything. Like a
beacon, the reading is a hint the phone draws and nothing decides on.

## Consequences

- The dots exist only for an operator with a statusLine. That is the price of not adding one, and the
  install says so in one line.
- The wrapper adds one process start to every statusLine run, about 60 ms measured with the source
  build on 2026-10-23. Claude Code debounces the runs at 300 ms and cancels a run a newer one replaces.
- An operator who later replaces their statusLine (Claude Code's `/statusline` does) loses the dots
  until the next install, and `collie update` nudges for it. An operator who wants the hooks and not
  the wrap has no switch today; add one when somebody asks.
- The reading is per session and keyed by the session id, not the pane id, which is the key v2 needs.
- Another harness gets dots by reporting the same numbers to the same file. The phone's code names no
  harness: it draws the gauges the wire carries.
- Revisit if Claude Code puts the same numbers on a hook event. A hook is already installed, and
  the statusLine would then not need to be touched at all.
