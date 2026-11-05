# The install-count receiver

This folder holds the contract of the daily ping a Collie bridge sends (M86). The receiver runs on
the colliepwa.dev app server and keeps one row per bridge per day in Postgres, with no IP address.
Its source is in the collie-website repository, under `src/lib/ping/`.

## What it accepts

`POST https://ping.colliepwa.dev/v1/ping` with a JSON body of at most 1 KB:

```json
{
  "v": 1,
  "id": "0123456789abcdef0123456789abcdef",
  "day": "2026-11-04",
  "version": "1.27.0",
  "os": "linux",
  "arch": "x64",
  "install": "binary",
  "line": "stable",
  "role": "solo"
}
```

Anything that does not match is `400` and is stored nowhere. A good ping is `204`.

| Field     | Rule                                                                              |
| --------- | --------------------------------------------------------------------------------- |
| (keys)    | Exactly these nine keys. A missing or extra key is refused.                      |
| `v`       | The number `1`.                                                                   |
| `id`      | 32 lowercase hex characters.                                                      |
| `day`     | A real `YYYY-MM-DD` date, within one day of the server's UTC date.                |
| `version` | Semver-like (`1.27.0`, `1.27.0-edge.1`), at most 40 characters.                   |
| `os`      | `linux`, `darwin`, `win32`, `freebsd` or `other`.                                 |
| `arch`    | `x64`, `arm64` or `other`.                                                        |
| `install` | `binary`, `linked-clone`, `detached-checkout`, `packaged` or `unknown`.           |
| `line`    | `stable` or `edge`.                                                               |
| `role`    | `solo`, `lead` or `member`. A deputy or peer that is not the lead is a `member`.  |

Other answers: `404` for another path, `405` for another method, `500` if the database fails. The
body of a refusal is one fixed word such as `bad_os` or `bad_role`. It never repeats what was sent.
