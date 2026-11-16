# 0149: Usage figures are what the agent states, and the account is asked with its own login

- **Status:** Accepted (2026-11-16)
- **Date:** 2026-11-16
- **Supersedes:** ADR 0115, ADR 0118
- **Trail:** the owner's brief of 2026-10-23 (the credential road named and declined), the owner's
  call of 2026-10-24 (the windows must show without a statusLine, and the wrap opt-in), counsel of
  2026-10-24 (an allowlist, the unproven readers off), the owner's calls of 2026-10-25 (the other
  harnesses), 2026-11-13 (no table of windows, the token count, the wrap by default) and 2026-11-15
  (the agent's own windows, M101), issue #672 (429s and the ask rate), #693 (one reading per
  `CLAUDE_CONFIG_DIR`). Files: `bridge/usage.ts`, `bridge/account-windows.ts`,
  `bridge/account-windows-setting.ts`, `bridge/usage-seen.ts`, `cli/statusline.ts`,
  `cli/context-reading.ts`, `cli/usage-store.ts`, `bridge/journal/model-window.ts`,
  `web/src/components/model-tag.tsx`, `docs/configure.md` ("Usage windows")

## Context

The tag above the belt shows a session's context use and cost, and the account's usage windows.
0115 took them from a wrapper around the operator's statusLine and declined to read a login. Its
amendments rewrote that several times, and 0118 reopened the login road a day later. 0141 added account
folders, and #693 gave each folder its own reading. No single record said what holds.

## Decision

1. The context and the cost belong to the session; the windows belong to the account. Every figure
   is a hint the phone draws. Nothing decides on it (0024).
2. A figure is one the harness states. Collie ships no table of model windows and prices nothing. A
   context with no stated window shows its token count, never a guessed share.
3. Claude's context comes from the beacon hooks, which read the end of the session transcript. Its
   window size comes only from a wrapped statusLine, the one place Claude Code states it.
4. `collie hooks install claude` wraps a plain statusLine by default. The command runs through
   `/bin/sh -c` with the same bytes in and out and its own exit code. `--no-statusline` keeps or
   restores the plain command. No statusLine is added where there is none: one hides Claude Code's
   footer hints. Windows, and a statusLine with `shell` or `args`, stay unwrapped. A wrap that names
   another collie binary is behind, and `collie update` says so.
5. The other harnesses' context and cost come from their session logs. The window comes from the log
   or from the harness's own model catalog on disk, read-only. No process and no network call.
6. The account windows come from the vendor's usage endpoint, asked with the login the harness keeps
   on this machine. The token is read for one request and is not stored, logged, refreshed or sent to
   another host. A redirect fails the request. A login file that group or other may read, or an
   expired token, is not used. Codex reads its own session files and sends no token.
7. `COLLIE_ACCOUNT_WINDOWS` (`[bridge] account_windows`) names the sources. The default is `claude`
   and `codex`. `opencode` and `grok` stay off until a real login has proven their shape. An unknown
   id is dropped with a warning, so a typo turns nothing on.
8. A source is asked only while a pane of its harness is open (a custom folder: one of its panes): at
   first, after a turn ends (at most once in five minutes), and every five minutes. Failures back
   off, and a reading older than 20 minutes is not drawn.
9. A pane's windows are its account's reading when there is one. Otherwise each window is the newest
   one a wrapped statusLine of the same harness and folder reported, and a session that reported no
   windows borrows none on that road.
10. The account folder is the `CLAUDE_CONFIG_DIR` a Claude session reported, else the folder of the
    pane's added account (0141). Each folder is read with its own login.
11. The windows are the agent's own list: the vendor's key, a cleaned label, at most eight, `5h` and
    `7d` first. `5h` and `7d` keep their meaning for an older phone and crew member.
12. What reaches disk is numbers, labels, times and the folder path, no token: one usage file per
    session, and the last reading per account. Each machine reads its own logins for its own panes.

## Today in the code

- Rules 1 and 2: `UsageTracker.get` (`bridge/usage.ts`) builds `PaneUsage`; `contextPercent` divides
  only by a known window. `model-tag.tsx` draws `contextTokens` in the share's place, never red.
- Rule 3: `cli/context-reading.ts` reads `TAIL_BYTES` (256 KiB) of `transcript_path` on `Stop` and
  `PostToolUse` (a `.jsonl` under the Claude config root only), drops the context on a `compact` or
  `clear` start, and writes a share only beside `windowBy: WINDOW_BY_STATUSLINE`. `mergeBeacon` and
  `mergeStatusLine` (`cli/usage-store.ts`) let both writers share one file.
- Rule 4: `wrapCommand`, `statusLineState`, `startShell` (the process group) and `statusLineBehind`
  (`cli/statusline.ts`); `NO_STATUSLINE_FLAG` and `wrapsStatusLine` (`cli/hooks.ts`, false on
  `win32`); `nudgeHooks` (`cli/update.ts`); the doctor row `statusline-claude` (`statusLineWrap`).
- Rule 5: `CacheProbe.contextTokens`, `contextWindow` and `costUsd` (`bridge/cache/tracker.ts`, the
  probes in `bridge/journal/pi.ts`, `codex.ts`, `opencode.ts`); `bridge/journal/model-window.ts`
  with `CATALOG_MAX_BYTES` (16 MB) and the database opened read-only.
- Rule 6: `readLoginFile` refuses mode `0o077` off Windows; `claudeTokenFrom` reads `accessToken` and
  `expiresAt` only; `redirect: "error"`; on macOS `claudeKeychainService` names the item per raw
  folder (`bridge/account-windows.ts`). `codexAccountSource` is `kind: "local"`.
- Rule 7: `parseAccountWindowsSetting`, `ACCOUNT_WINDOWS_DEFAULT`, `ACCOUNT_WINDOWS_UNVERIFIED`
  (`bridge/account-windows-setting.ts`); `accountWindowsDoctorLine` for the `account-windows` row.
- Rule 8: `AccountWindows.observe`, `poke` and `isTurnEnd`; `ASK_EVERY_MS` and `POKE_EVERY_MS` (both
  5 min), `STALE_AFTER_MS` (20 min), `FETCH_TIMEOUT_MS` (10 s), `BACKOFF` (401 and 403 drop the
  reading); `limitedWait` honours `Retry-After`, at least 15 min, doubled per 429 in a row, at most
  an hour.
- Rules 9 and 10: `UsageTracker.get` and `newestLimits`, keyed by harness and `configDir`, which
  `customClaudeConfigDir` writes, else `folderOf` (the `PaneAccountFolder` seam); `observeConfigDirs`
  and `forConfigDir` (Claude, Codex, Grok), at most `MAX_CUSTOM_CONFIG_DIRS` (16).
- Rule 11: `orderedLimits`, `READING_WINDOWS_MAX` (8), `scopedWindowKey` (`7d:<model>`),
  `cleanWindowText`; `WINDOW_KEYS` and `VENDOR_WINDOW_KEY` in `cli/statusline.ts`.
- Rule 12: `USAGE_DIR_MODE` (0700), `USAGE_FILE_MAX_BYTES` (4096), `USAGE_MAX_AGE_MS` (8 days),
  `USAGE_FILES_MAX` (512); `bridge/usage-seen.ts` with `SEEN_KEYS_MAX` (32) and
  `SEEN_WRITE_EVERY_MS` (1 min). `bridge/index.ts` feeds `AccountWindows` from the local engine only.

## Recorded, not found in the code

- 0118: "A `CLAUDE_CONFIG_DIR` profile is read only when the bridge's own environment names it." Since
  #693 each session's folder is read with its own login (rule 10).
- 0118: a turn end asks at most once a minute, and a 429 waits a flat 15 minutes. Since #672 the poke
  waits five minutes and a 429 follows `limitedWait`.

## Consequences

- An API-key, Bedrock or Vertex session shows the windows of its folder's login, if it has any.
- A vendor may object to a third-party program reading the login. The read is the one the harness
  makes, from the same file, read-only, and the setting turns it off in one line. Revisit when a
  vendor publishes a rule or documents the endpoint.
- The Claude endpoint is undocumented and changed shape once, so `parseAccountUsage` takes both, and
  a body it cannot read keeps the last reading, waits five minutes, and never breaks the pane.
- A session without the wrap shows a token count. After `/model` the share divides by the old size
  until the next statusLine run, well under a second. Revisit if a hook event carries the size.
- A model no catalog names shows a count, not a share. pi and OMP show no account windows yet,
  because their windows follow the provider of the active model.
- Live beside this record: 0141 (what an account is), 0024 (a beacon is a hint), 0041 and 0042.

## What we tried before

- 0115 (2026-10-23): the wrapper as the only source, the credential road declined. 2026-10-25: the
  journal context and the cost for the other harnesses.
- 0115, 2026-10-24 to 2026-11-13: the wrap opt-in, a window from `SessionStart` with a `[1m]` rule,
  then a table of model windows, wrong within the day; then only a stated window and the wrap again.
- 0118 (2026-10-24): the vendor endpoint with the operator's login, Codex, OpenCode Go and Grok. Not
  taken: `codex app-server`, because it spawns a process for a number the session files hold.
- 0115 and 0118, 2026-11-15: a fixed `5h` and `7d` pair with a hidden `scoped` list, then the open
  list and `usage-seen.json`.
