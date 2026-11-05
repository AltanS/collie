# The install-count receiver

This folder holds the contract of the daily ping a Collie bridge sends (M86). The receiver runs on
the colliepwa.dev server and keeps one row per bridge per day in Postgres, with no IP address.
This contract is the public record of the ping.

## What it accepts

`POST https://ping.colliepwa.dev/v1/ping` with a JSON body of at most 1 KB:

```json
{
  "v": 2,
  "id": "0123456789abcdef0123456789abcdef",
  "day": "2026-11-06",
  "version": "1.27.0",
  "os": "linux",
  "arch": "x64",
  "install": "binary",
  "line": "stable",
  "role": "solo",
  "trouble": [{ "kind": "dialog", "harness": "codex", "version": "0.46.0", "mux": "herdr", "count": 2 }]
}
```

Anything that does not match is `400` and is stored nowhere. A good ping is `204`.

| Field     | Rule                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| (keys)    | Exactly these ten keys. A missing or extra key is refused.                       |
| `v`       | The number `2`. A 1.27.0-edge.1 bridge still sends `v: 1` with the first nine keys. |
| `id`      | 32 lowercase hex characters.                                                      |
| `day`     | A real `YYYY-MM-DD` date, within one day of the server's UTC date.                |
| `version` | Semver-like (`1.27.0`, `1.27.0-edge.1`), at most 40 characters.                   |
| `os`      | `linux`, `darwin`, `win32`, `freebsd` or `other`.                                 |
| `arch`    | `x64`, `arm64` or `other`.                                                        |
| `install` | `binary`, `linked-clone`, `detached-checkout`, `packaged` or `unknown`.           |
| `line`    | `stable` or `edge`.                                                               |
| `role`    | `solo`, `lead` or `member`. A deputy or peer that is not the lead is a `member`.  |
| `trouble` | The trouble tally since the last ping, an array, `[]` when none. See below.       |

### The trouble tally

When the phone shows one of Collie's two trouble cards ("Cannot read a dialog", "Send not landing"),
it tells the bridge once: once per card instance for a dialog, once per streak for a send. The
bridge counts it, and the next ping carries the tally since the ping before. Each row holds exactly
five keys:

| Key       | Rule                                                                                  |
| --------- | ------------------------------------------------------------------------------------- |
| `kind`    | `dialog` or `send`.                                                                   |
| `harness` | The agent program's name: lowercase letters, digits and `-`, 1 to 24 characters. A plain shell, no pane and any other word are `other`. |
| `version` | The agent program's version, semver-like, at most 40 characters, or `null`.            |
| `mux`     | `herdr`, `herdr-core`, `tmux`, `zellij`, `durable` or `other`.                         |
| `count`   | How often since the last ping, 1 to 999.                                               |

A tally holds at most 20 distinct rows; a signal for a 21st is dropped. The tally is cleared when the
ping goes out (in the same write that records the day, so a crash never counts twice and a failure
loses at most one day's tally), and with the install ID the moment the count is off for any reason.
It never carries a pane, a host name, a path, a request id, the screen or anything typed.

A phone paired to a crew lead sees the members' panes through the lead. Its trouble signal goes to
the bridge the phone talks to, so the lead counts a member's trouble under its own install.

Other answers: `404` for another path, `405` for another method, `500` if the database fails. The
body of a refusal is one fixed word such as `bad_os` or `bad_role`. It never repeats what was sent.
