# The install-count receiver

This folder holds the contract of the daily ping a Collie bridge sends (M86). The receiver runs on
the colliepwa.dev server and keeps one row per bridge per day in Postgres, with no IP address.
This contract is the public record of the ping.

## What it accepts

`POST https://ping.colliepwa.dev/v1/ping` with a JSON body of at most 8 KB. A typical v3 body is
under 1 KB; 8 KB is above the largest body the caps below allow (a test in the bridge pins that):

```json
{
  "v": 3,
  "id": "0123456789abcdef0123456789abcdef",
  "day": "2026-11-13",
  "version": "1.27.0",
  "os": "linux",
  "arch": "x64",
  "install": "binary",
  "line": "stable",
  "role": "solo",
  "trouble": [{ "kind": "dialog", "harness": "codex", "version": "0.46.0", "mux": "herdr", "count": 2 }],
  "usage": [
    { "harness": "claude", "mux": "herdr", "sessions": 3 },
    { "harness": "codex", "mux": "herdr", "sessions": 1 },
    { "harness": "omp", "mux": "tmux", "sessions": 2 }
  ]
}
```

A bridge that counts usage sends this shape, `v: 3`. Bridges up to 1.28.x keep sending `v: 2` (ten
keys, no `usage`), and a 1.27.0-edge.1 bridge sends `v: 1`. The receiver accepts v2 and v3 side by side, see
"Versions" below.

Anything that does not match is `400` and is stored nowhere. A good ping is `204`.

| Field     | Rule                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| (keys)    | Exactly these eleven keys for `v: 3`. A missing or extra key is refused.         |
| `v`       | The number `3`. Older bridges send `2` (ten keys) or `1` (nine keys), see "Versions". |
| `id`      | 32 lowercase hex characters.                                                      |
| `day`     | A real `YYYY-MM-DD` date, within one day of the server's UTC date.                |
| `version` | Semver-like (`1.27.0`, `1.27.0-edge.1`), at most 40 characters.                   |
| `os`      | `linux`, `darwin`, `win32`, `freebsd` or `other`.                                 |
| `arch`    | `x64`, `arm64` or `other`.                                                        |
| `install` | `binary`, `linked-clone`, `detached-checkout`, `packaged` or `unknown`.           |
| `line`    | `stable` or `edge`.                                                               |
| `role`    | `solo`, `lead` or `member`. A deputy or peer that is not the lead is a `member`.  |
| `trouble` | The trouble tally since the last ping, an array, `[]` when none. See below.       |
| `usage`   | The usage tally since the last ping, an array, `[]` when none. See below.         |

### Versions

The receiver accepts these side by side. A body is checked against the key set of its own `v`, and a
body whose keys do not match its `v` is refused.

| `v` | Keys | Sent by |
| --- | --- | --- |
| `1` | The first nine, up to and including `role`. | 1.27.0-edge.1 |
| `2` | The first ten, up to and including `trouble`. | 1.27.0 up to 1.28.x |
| `3` | All eleven, with `usage`. | A bridge with the usage tally |

A `v: 3` body must carry `usage`, `[]` when no agent ran. A `v: 2` body must not carry it. Old
bridges stay in service for a long time, so the receiver keeps `v: 2` for as long as any ping of it
arrives, and stores a v2 ping as one with no usage.

### The usage tally

The ping says how many agent sessions ran, per agent program and multiplexer, since the last ping
(about a day). It is counts only: no name, path, title, id, prompt, model name or timing. Each row
holds three keys:

| Key        | Rule                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| `harness`  | The agent program, from a closed list: one of `agy`, `antigravity`, `claude`, `codex`, `dsh-tui`, `grok`, `hermes`, `kiro`, `muse`, `omp`, `openclaw`, `opencode`, `pi` (this build's list), or `other`. |
| `mux`      | The multiplexer, from a closed list: `durable`, `herdr`, `herdr-core`, `tern`, `tmux`, `tuios`, `zellij` (this build's list), or `other`. |
| `sessions` | How many sessions, 1 to 999.                                                               |

The receiver treats `harness` and `mux` as text of the shape `^[a-z0-9-]{1,24}$` and does not
enforce the list: the lists grow with a release, and a new word must not make a ping fail. Rows are
sorted by `harness`, then `mux`. A pair of words appears once. A bridge sends at most 24 rows, and
the receiver refuses more.

Where the counts come from. Each bridge samples the panes its multiplexer reports, at most every 30
seconds per herd session. A pane that holds an agent counts as one session, once per ping window: a
bare shell and a trick's own session do not count, and the same agent session in the same pane is not
counted twice. A new agent session in the same pane counts again. A pane that a crew member runs is
counted by that member's own bridge, which pings as role `member`, so a lead never counts a member's
panes. A program or multiplexer off the lists counts under `other`. To tell a session from a
repeat, the bridge keeps a hash of it in its state file, salted with the install ID; the hash never
leaves the machine and goes with the ID when the count is off.

The window is the time since the last ping, not a calendar day. A session that spans two pings
counts in both. A bridge that was not running counts nothing for that time. A failed send loses that
window's counts.

### The trouble tally

When the phone shows one of Collie's two trouble cards ("Cannot read a dialog", "Send not landing"),
it tells the bridge once: once per card instance for a dialog, once per streak for a send. The
bridge counts it, and the next ping carries the tally since the ping before. Each row holds five
keys, and from 1.27.4 a `dialog` row may hold a sixth, `screen`:

| Key       | Rule                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `kind`    | `dialog` or `send`.                                                                   |
| `harness` | The agent program's name: lowercase letters, digits and `-`, 1 to 24 characters. A plain shell, no pane and any other word are `other`. |
| `version` | The agent program's version, semver-like, at most 40 characters, or `null`.            |
| `mux`     | The multiplexer's own name as the bridge reports it: lowercase letters, digits and `-`, 1 to 24 characters; `other` when the phone had none. |
| `screen`  | Optional, `dialog` rows only: 8 lowercase hex characters, `^[0-9a-f]{8}$`. Absent otherwise. |
| `count`   | How often since the last ping, 1 to 999.                                               |

A tally holds at most 20 distinct rows; a signal for a 21st is dropped. The tally is cleared when the
ping goes out (in the same write that records the day, so a crash never counts twice and a failure
loses at most one day's tally), and with the install ID the moment the count is off for any reason.
It never carries a pane, a host name, a path, a request id, the screen or anything typed.

The `screen` field is a short hash of the dialog's key-hint row only, never a row with the person's
text, never the screen or what was typed. It is absent unless that row is a short list of key
hints. The phone takes the lowest of the screen's last six non-blank rows that names a way out
(`esc`, `escape`, `⎋`), strips the box glyphs and spaces at its ends and collapses white space. It
hashes that row, with FNV-1a 32 over its UTF-8 bytes, only when all of these hold:

| Rule | Detail |
| --- | --- |
| Length | At most 160 characters. |
| Segments | At least two, split at ` · `, ` • `, ` \| ` or `│`. |
| Segment size | Each at most 6 words and 40 characters. |
| Keys in segments | At least two segments hold a key token, such as `esc`, `⏎`, `↑`, `ctrl+g` or `enter`. |
| A real key | At least one token is a key and nothing else. `enter`, `tab`, `space`, `home` and `end` do not count here. |

A row without `screen` is byte for byte what 1.27.3 sends. The tally keeps one row per kind,
harness, version, mux and screen. `bun scripts/trouble-screens.ts` prints the hash of every pane
fixture, to look one up.

A phone paired to a crew lead sees the members' panes through the lead. Its trouble signal goes to
the bridge the phone talks to, so the lead counts a member's trouble under its own install.

Other answers: `404` for another path, `405` for another method, `500` if the database fails. The
body of a refusal is one fixed word such as `bad_os` or `bad_role`. It never repeats what was sent.
