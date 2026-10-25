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
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md) · amended 2026-10-25: the context
  for pi, OMP, Codex and OpenCode from the journal (`bridge/cache/tracker.ts`,
  `bridge/journal/model-window.ts`), see the last section

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

## Other harnesses: the context reading from the journal (2026-10-25)

Altan, 2026-10-25: OMP, and the other harnesses, should carry the same row above the belt as Claude
Code, with the model, the context and the usage limits. Until now the context came only from Claude's
beacon hooks writing the usage file, so a pi, OMP, Codex or OpenCode pane had no `usage` and the row
did not draw. The 5-hour and 7-day windows stay as [ADR 0118](./0118-account-windows-come-from-the-vendors-usage-endpoint-with-the-operators-own-login.md)
left them; this section is about the context only.

- **One seam, journal-side.** The prompt-cache probe already reads each harness's session log on the
  bridge's poll (`bridge/cache/tracker.ts`). `CacheProbe` gains two optional numbers:
  `contextTokens`, what the last turn carried into the model, and `contextWindow`, the window size
  when one is known. The tracker keeps them per session beside the model label, with the same owner
  and the same reap. A probe that read a turn replaces the reading; a read with no turn keeps it.
- **The tokens, per harness.** Each in its own fields, input side only, as Claude's /context counts:
  - pi and OMP: the assistant row's `usage.input + usage.cacheRead + usage.cacheWrite`. pi counts the
    cache apart from `input`. A failed turn writes zeros and is passed over for the turn before it.
  - Codex: `last_token_usage.input_tokens` of the newest `token_count` row. It already includes
    `cached_input_tokens` and `cache_write_input_tokens` (on 0.164.0: 16209 input, 15770 cached, 436
    written), so neither is added.
  - OpenCode: the assistant message's `tokens.input + tokens.cache.read + tokens.cache.write`. A reply
    still at zero tokens is passed over.
  - A compaction after the measured turn (pi's `compaction` row, Codex's `compacted` row, OpenCode's
    compaction summary or V2 `compaction` row) leaves the context unknown until the next turn, as
    the beacon does on `compact`.
- **The window rule stays: no window, no context.** A window comes from, in this order:
  1. the session log itself: Codex's `info.model_context_window` (258,400 seen);
  2. the harness's own model catalog on disk, when it names the model: pi's
     `<agent dir>/models-store.json` (`<provider>.models[].contextWindow`), OMP's
     `<agent dir>/models.db` (table `model_cache`, the provider's row or a `<provider>:<variant>` row,
     `models[].contextWindow`), OpenCode's `$XDG_CACHE_HOME/opencode/models.json`
     (`<provider>.models.<id>.limit.context`). The agent dir is the parent of the `sessions` folder
     above the log. Read once per model id per bridge run, a file or row over 16 MB is not read, a
     model the catalog does not name is asked again after ten minutes, and the database opens
     read-only (`bridge/journal/model-window.ts`);
  3. nothing: no context dot, and the model label still draws.

  Never a guessed window, never a table shipped in Collie, never a process spawned, never a network
  call.
- **The join.** `UsageTracker.get` takes the context from the session's usage file when that holds
  one (Claude's road, unchanged), else from the journal's reading when it knows both the tokens and
  the window, floored to one decimal like the beacon's (`contextPercent`) and clamped at 100. The
  account windows join exactly as before. The wire does not change; `ModelTag` already draws when
  any gauge exists, so the web needs no change.
- **Read live on bluefin, 2026-10-25.** Codex 0.164.0: 17,345 of 258,400, 6.7%. OMP 18.6.1 on
  OpenRouter `openai/gpt-6-luna`: 98,087 of 1,050,000 from the `openrouter:pseudo-api` row, 9.3%.
  pi 0.87.1 on OpenRouter `anthropic/claude-opus-4.7`: 10,718 of 1,000,000 from `models-store.json`.
  OpenCode on OpenRouter `inclusionai/ling-3.0-flash-sante:free`: tokens read, and the catalog does
  not name the model, so no dot; a model the catalog names (`openai/gpt-6-luna`, 1,050,000) was
  checked by its lookup only, with no live OpenCode session on it.

**Known limits.**

- A model the harness's catalog does not list has no context dot: a custom provider, a free variant
  missing from models.dev, a provider OMP has not cached. On OMP that depends on what OMP itself
  cached; on this machine OpenRouter is cached as `openrouter:pseudo-api`, and another machine may
  have no row for its provider. pi's own `models.json` (operator-defined models) is not read yet.
- pi's and Codex's own footers count the reply's output tokens too (Codex also against the window
  less a 12k baseline), so Collie's dot can read a little lower than theirs. Collie counts what went
  in, for every harness alike.
- pi's session is a tree. After a jump to another branch the newest assistant row in the file may
  belong to the branch left behind, until the next turn.
- A catalog that changes a model's window during a bridge run is read again only after a restart.

**The session cost (2026-10-25).** The tag also shows what the session has cost, in US dollars, after
the last gauge (`PaneUsage.cost`). Collie prices nothing: it shows a figure the harness states.
Claude Code's statusLine document carries `cost.total_cost_usd`, which the wrapper keeps in the usage
file beside the context. pi and OMP write `message.usage.cost.total` on every assistant row, and
OpenCode a `cost` on every assistant message; the journal sums them (`CacheProbe.costUsd`), the file
once and then only the appended bytes for pi and OMP (3 ms for a 1.3 MB log), one SQL sum for OpenCode.
Codex's log has no cost. The usage file's cost wins over the journal's, as the context does. The field
is absent, never a placeholder: no `0` for an unknown cost, and a journal sum of zero (aborted turns, a
free model) is not sent. The tag writes `<$0.01`, `$0.11` or `$123` (`formatCost`), is not a gauge (no
dots, never the working colour), and shows even when the harness's own status line prints a cost too.
