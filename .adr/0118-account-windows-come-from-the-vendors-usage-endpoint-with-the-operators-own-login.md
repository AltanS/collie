# 0118: account windows come from the vendor's usage endpoint with the operator's own login

- **Status:** Accepted
- **Date:** 2026-10-24
- **Shipped in:** 1.24.0
- **Trail:** Altan, 2026-10-24: the windows must show without a statusLine; the operator sees no dots
  on 8788 because their statusLine is not wrapped; counsel the same day: an allowlist, the unproven readers off · `bridge/account-windows.ts` (`AccountWindows`,
  `readClaudeLogin`, `parseAccountUsage`, `isTurnEnd`) · `bridge/usage.ts` (`UsageTracker.get`, the
  join) · `bridge/index.ts` (the poll and the turn-end poke) · `bridge/account-windows-setting.ts` (the setting's forms) · `bridge/config-schema.ts`
  (`[bridge] account_windows`, `COLLIE_ACCOUNT_WINDOWS`) · `cli/doctor.ts` (`account-windows`) ·
  `docs/multiplexers.md` · `docs/configure.md` ("Usage windows") · amended 2026-10-24: Codex,
  OpenCode Go and Grok sources beside Claude (see "Other harnesses") ·
  [ADR 0115](./0115-usage-numbers-come-from-the-operators-own-statusline.md) ·
  [ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md)

## Context

The 5-hour and 7-day windows belong to the account, not to a session. Three places hold them:

1. **The statusLine document.** Claude Code hands its statusLine command `rate_limits.five_hour` and
   `rate_limits.seven_day` on every assistant message. ADR 0115 reads them there, through a wrapper
   around the operator's own command. Since its amendment of 2026-10-24 the wrap is opt-in, so an
   operator who does not pass `--statusline` sees the context dot and no windows. On 8788 that is
   every operator.
2. **The host control channel.** An SDK host learns the numbers from the agent it runs. Collie hosts
   no sessions.
3. **The vendor endpoint Claude Code itself calls.** Its `/usage` screen makes one request:
   `GET https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer <access token>` and
   `anthropic-beta: oauth-2025-04-20`. Seen live on 2026-10-24 on a Max account.

Hooks never carry the windows. No hook event has them, so the beacon road that gives the context dot
since ADR 0115's amendment cannot give the windows.

ADR 0115 declined the third road on 2026-10-23 because it reads a credential. Altan reopened it on
2026-10-24 with the rules below.

The endpoint is undocumented. Its answer changed shape once: first flat fields
(`five_hour: { utilization, resets_at }`, `seven_day: { … }`), then a structured `limits[]`
(`kind: "session" | "weekly_all" | "weekly_scoped"`, `percent`, `resets_at`, `scope.model.display_name`)
beside the flat fields. Either window may be `null`.

## Decision

**Collie reads the operator's own harness login, locally, for one GET to the vendor. It stores nothing
of it, never refreshes it and never sends it elsewhere. The endpoint is undocumented and its shape
changed once (flat fields, then `limits[]`), so the parser accepts both, and a parse failure costs the
reading, never the pane.**

1. **One service, in memory.** `AccountWindows` in the bridge keeps, per harness with a source, the
   last good reading as `UsageLimit[]`: `5h` from `kind: "session"` or `five_hour`, `7d` from
   `kind: "weekly_all"` or `seven_day`. `used` is the percent clamped to 0 to 100, `resetsAt` is epoch
   ms. A window `limits[]` names wins over its flat field. A body with neither shape is unreadable. A
   body whose windows are all `null` is an account without windows. `claude` was the first source; Codex, OpenCode Go and Grok joined it the same day (see "Other harnesses").
2. **Model-scoped weekly rows are kept, not drawn.** `weekly_scoped` rows are parsed into
   `scoped: [{ label, used, resetsAt }]` (the label stripped of control characters, at most 64
   characters, at most eight rows) for a later build. They never enter `UsageLimit[]`, because the
   phone draws two gauges.
3. **The login, Claude.** `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`
   (`%USERPROFILE%\.claude` on Windows). `claudeAiOauth.accessToken` and `claudeAiOauth.expiresAt`
   are read; nothing else. No ask is made when the file is missing or not a regular file, when on
   POSIX its mode lets group or other read it (0600 and 0400 pass), when `expiresAt` is missing or
   past, or when the token is not a bearer string (printable ASCII, no space, under 4096 characters).
   On macOS, when the file is absent, the Keychain item `Claude Code-credentials` is read with
   `security find-generic-password -s … -w`, with a 3 s timeout. Collie never refreshes a token and
   never reads `refreshToken`: an expired token waits for Claude Code, which refreshes it on its own
   next call.
4. **The token lives in a local variable for one request.** Never a field, a log line, an error
   message, a receipt or a file. It goes to `api.anthropic.com` and nowhere else; redirects are
   refused. The log names a refusal reason or an HTTP status in one line per change, never the
   token, the body or a transport error's text.
5. **Cadence.** Only while this bridge has at least one pane of the harness: once when there is no
   reading, once after a turn ends (working or blocked to idle or done, `isTurnEnd`) at most once a
   minute, and every five minutes. One request in flight per harness, a 10 s timeout,
   `User-Agent: collie/<version>`. No pane of the harness, no ask.
6. **Backoff.** 401 or 403: drop the reading (the account may have logged out), wait 15 minutes. 429:
   keep the reading, wait 15 minutes. No answer, a timeout or another status: keep it, wait 2
   minutes. A body that does not parse: keep it, wait 5 minutes. A refused login: wait 5 minutes, or
   1 minute when the token has expired. A reading older than 20 minutes is not drawn: stale windows
   are worse than none.
7. **The join.** A pane of harness H gets the account windows of H when there are any, whatever its
   session record says, and with no record at all. Otherwise it keeps ADR 0115's behaviour: the newest
   window any session of H reported through a wrapped statusLine. The account windows win because
   they are fresher and the account's own. The context stays the session's. The wire does not change;
   the phone draws `usage.limits` as before.
8. **The setting.** `[bridge] account_windows` / `COLLIE_ACCOUNT_WINDOWS` names which harnesses
   Collie may read. Unset, `1`, `on`, `true` or `yes` is the default set, `claude` and `codex`. `0`,
   `off`, `false` or `no` is none: no login read, nothing asked. `all` is every source. A comma list
   of harness ids (`claude,codex`; case and spaces ignored) is exactly those. An id this build does
   not know is dropped with a warning and only the known ids are on, so a typo never turns on a
   source the operator did not name. `opencode` and `grok` are off by default because no live login
   has proven their shape; they turn on with `all` or by name (see "Other harnesses"). In the file
   the key takes `true`/`false`, a string with the same forms, or an array of ids. A harness left
   out has no source, so its login and files are never opened. `collie doctor` prints one
   `account-windows` row that lists every source with its state:
   `claude: on (reads ~/.claude/.credentials.json, asks api.anthropic.com); codex: on (reads ~/.codex/sessions); opencode: off by default, unverified (COLLIE_ACCOUNT_WINDOWS=all); grok: off by default, unverified (COLLIE_ACCOUNT_WINDOWS=all)`
   (with "or the Keychain" on macOS, and the full path under a `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
   `XDG_DATA_HOME` or `GROK_HOME`). With every source off it says `off` and that the operator turned
   it off; a named `opencode` or `grok` shows `on, unverified`, with its file and host once it has a
   login.

Like a beacon (ADR 0024), the reading is a hint the phone draws and nothing decides on.

## Consequences

- The windows show for every Claude subscription operator on this machine, with no statusLine and no
  hook. `--statusline` stays as the second road, for an operator who prefers it with
  `COLLIE_ACCOUNT_WINDOWS=0` (or a list without `claude`).
- An API-key, Bedrock or Vertex session has no windows: there is no OAuth login file, or the answer's
  windows are `null`. On the statusLine road `rate_limits` is absent for those sessions too.
- The login is the machine's, not the session's. An API-key session on a machine whose Claude login
  is a subscription shows that subscription's windows. On the statusLine road it showed none.
- Each machine of a crew asks with its own login, for its own panes. A lead does not ask for a peer.
- A `CLAUDE_CONFIG_DIR` profile is read only when the bridge's own environment names it. Several
  profiles on one machine show the windows of the one the bridge sees.
- **Policy risk.** A vendor may object to a third-party program reading the login token. Collie's
  read is the same one the harness makes, from the same file, and it is read-only. The off switch is
  one line. Revisit if Anthropic publishes a rule on it, or documents the endpoint.
- The shape may change again. A body this build cannot read costs the reading for five minutes and
  logs one line; the pane and the context dot are untouched.
- A login file that others may read is skipped silently except for one log line. `collie doctor`
  does not judge the file's mode; the bridge's line says why there are no windows.

## Other harnesses (amendment, 2026-10-24)

Altan decided on 2026-10-24 that the account windows cover the other subscriptions too. Three more
sources join `AccountWindows` in the one table in `bridge/account-windows.ts`, keyed by the harness id
a pane carries. They share the lifecycle (pane present, once, after a turn, every five minutes), the
backoff table, the 60 s poke throttle, the 20 minute staleness, the redirect refusal, the 10 s timeout,
the `collie/<version>` user agent, the mode check on a login file, and the one setting.

**Counsel, 2026-10-24: an allowlist, and the unproven readers off.** A reader that has never met a
real login should not read one by default. `claude` is proven live and `codex` sends no token, so
those two are the default set. `opencode` and `grok` are off until one real login has proven their
shape, and then they join the default set in the change that drops "unverified" below.

**None of the three is proven live.** On this machine Codex runs on an API key and OpenCode and pi
run on OpenRouter, and there is no Grok login. Each shape below comes from third-party readers
(CodexBar, oh-my-pi), read on 2026-10-24, and is **unverified live on 2026-10-24**. So every parser
takes every field as optional, and a body that does not parse costs the reading, never the pane, as
for Claude.

1. **Codex, `codex`: no login, no request.** Codex writes `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`.
   A line `{"type":"event_msg","payload":{"type":"token_count","rate_limits":{…}}}` follows each model
   response. On a ChatGPT login `rate_limits.primary` and `rate_limits.secondary` are
   `{used_percent, window_minutes, resets_at}` (`resets_at` in epoch seconds; a value above 1e12 is
   taken as milliseconds). On an API-key login both are `null` (seen on this machine), so there is
   nothing to show. `window_minutes` 300 is `5h` and 10080 is `7d`; any other length goes to the
   service's `scoped` list. On each refresh the source lists the rollout files modified in the last 2
   hours in the folders of today and yesterday (by local and by UTC date), newest first, reads the last
   256 KiB of at most three, walks lines from the end and takes the first `token_count` that carries a
   window. It stops at the first file that yields one. No token is read, nothing is sent. A refresh
   that finds nothing says so in one state line and waits a minute.
2. **OpenCode Go, `opencode`.** `GET https://opencode.ai/zen/go/v1/usage` with
   `Authorization: Bearer <key>`, where the key is `key` (or `access`, for an oauth-shaped entry) of
   the `opencode-go` entry in `$XDG_DATA_HOME/opencode/auth.json` (`~/.local/share/opencode/auth.json`).
   The answer has `rolling`, `weekly` and `monthly`, each `{status, percent, resetsAt}` with an ISO
   `resetsAt`. `rolling` is `5h`, `weekly` is `7d`, and `monthly` goes to `scoped` as `30d` (it
   anchors on the subscription's anniversary). oh-my-pi also sends an `x-opencode-session` header
   (an install id) on this call; Collie sends a random id made once per bridge run. No Go entry: no
   login read, no request, one state line.
3. **Grok, `grok`.** `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` with
   `Authorization: Bearer <token>` and `x-xai-token-auth: xai-grok-cli`. The token is `key` of the
   entry under the scope URL `https://auth.x.ai::<client>` in `$GROK_HOME/auth.json`
   (`~/.grok/auth.json`), else under `https://accounts.x.ai/sign-in`; `token`, `accessToken` and
   `access_token` are accepted too, and `expires_at` is judged when it parses. The answer carries
   `creditUsagePercent` and `currentPeriod: {start, end}` (ISO), at the top or under `config`. The
   period is a billing cycle, not a 5-hour window: a span of 8 days or less is `7d`, a longer one goes
   to `scoped` as `30d`, and an unknown span goes to `scoped` as `credits`. No file: no login read.
4. **pi and OMP: skipped.** Their windows follow the provider of the active model, so a pane's windows
   are the windows of whichever account its current model bills. That is a later build.
5. **The seam.** A source is `http` (login, url, headers, parse) or `local` (read). `claude`,
   `opencode` and `grok` are `http`; `codex` is `local`. Nothing else in the bridge or the web names a
   harness: `bridge/usage.ts` joins by the pane's harness id, and `USAGE_WINDOWS` stays `5h` and `7d`.
   The phone draws what it drew.

**Alternative not taken.** Codex's `codex app-server` answers `account/rateLimits/read` over JSON-RPC.
That would be exact, but it means spawning a process (and `codex app-server` already manages a daemon
per `CODEX_HOME`) for a number the session files already hold. Collie spawns no process for this.

**Shape sources.** CodexBar docs `docs/codex.md` and `docs/grok.md` (steipete/CodexBar); oh-my-pi
(can1357/oh-my-pi), `packages/ai/src/usage/opencode-go.ts` and its xAI OAuth reader.

**Consequences.**

- A Codex session started before the numbers existed, or idle for more than two hours, shows no
  windows until its next turn. The reading is as old as the last model response, and a window whose
  reset has passed is not drawn.
- A wrong guess in one of the three shapes shows as "no windows" for that harness and one log line,
  not as a broken pane. The first operator with a ChatGPT login, a Go plan or a SuperGrok login is
  the live check; change the parser then and drop "unverified" from this record.
- The login reads add two files: OpenCode's auth store holds every provider's key, and Collie reads
  only the `opencode-go` entry and keeps it for one request, as for Claude. Grok's holds a refresh
  token that Collie does not touch.
