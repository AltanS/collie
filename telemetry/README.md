# The install-count receiver

A small Cloudflare Worker with one D1 table. It receives the daily ping a Collie bridge sends
(M86), checks its shape, and keeps one row per bridge per day. It keeps no IP address.

Collie ships no Cloudflare account details. Nothing here is deployed by the repo, and no file here
holds an account id, a zone id or a token.

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

Other answers: `404` for another path, `405` for another method, `500` if D1 fails. The body of a
refusal is one fixed word such as `bad_os`. It never repeats what was sent.

## What it keeps

One row per `(id, day)`. A second ping for the same id and day replaces the first, so a repeat adds
nothing. The columns are in `schema.sql`: `id`, `day`, `version`, `os`, `arch`, `install`, `line`, `role`.

There is no column for an IP address, a user agent or a country. The worker reads one request
header, `content-length`, to refuse a large body early. It never reads `request.cf` and writes no
log line. Workers observability is off in
`wrangler.toml`. Rows older than 400 days are deleted by a daily cron trigger at 03:17 UTC.

Cloudflare is the host, so its network sees the connection like any host does. That is outside
this code. The code decides what reaches the table, and that is the eight columns above.

## Deploy (Altan's steps)

You need a Cloudflare account that holds the `colliepwa.dev` zone. Run these from `telemetry/`.

1. Log in. This opens a browser on your machine.

   ```
   bunx wrangler login
   ```

2. Create the database. Wrangler prints a `database_id`.

   ```
   bunx wrangler d1 create collie-ping
   ```

3. Put that id in `wrangler.toml`, in place of `your-database-id`.

4. Create the table on the remote database.

   ```
   bunx wrangler d1 execute collie-ping --remote --file=schema.sql
   ```

5. Deploy the worker. The `[[routes]]` block makes `ping.colliepwa.dev` a custom domain and creates
   its DNS record.

   ```
   bunx wrangler deploy
   ```

6. Check that a good ping is `204` and a bad one is `400`.

   ```
   curl -i -X POST https://ping.colliepwa.dev/v1/ping \
     -d '{"v":1,"id":"00000000000000000000000000000000","day":"'"$(date -u +%F)"'","version":"1.27.0","os":"linux","arch":"x64","install":"binary","line":"stable","role":"solo"}'
   curl -i -X POST https://ping.colliepwa.dev/v1/ping -d '{"v":1}'
   ```

7. Delete the test row.

   ```
   bunx wrangler d1 execute collie-ping --remote \
     --command "DELETE FROM pings WHERE id = '00000000000000000000000000000000'"
   ```

If `colliepwa.dev` is not on this Cloudflare account, replace the `[[routes]]` block with a plain
route (`pattern = "ping.colliepwa.dev/*"`, `zone_name = "colliepwa.dev"`) once the zone is there.

To stop the count: remove the route with `bunx wrangler delete`. A bridge that cannot reach the
endpoint fails quietly and sends nothing else.

## Queries

Run any of these against the live table:

```
bunx wrangler d1 execute collie-ping --remote --command "<the SQL>"
```

Active installs per day, the last 30 days:

```sql
SELECT day, COUNT(DISTINCT id) AS active
FROM pings
GROUP BY day
ORDER BY day DESC
LIMIT 30;
```

Installs per version, on the newest day with data:

```sql
SELECT version, COUNT(DISTINCT id) AS installs
FROM pings
WHERE day = (SELECT MAX(day) FROM pings)
GROUP BY version
ORDER BY installs DESC;
```

Installs per install kind, on the newest day with data:

```sql
SELECT install, COUNT(DISTINCT id) AS installs
FROM pings
WHERE day = (SELECT MAX(day) FROM pings)
GROUP BY install
ORDER BY installs DESC;
```

Installs that pinged at least once in the last 30 days:

```sql
SELECT COUNT(DISTINCT id) AS active_30_days
FROM pings
WHERE day >= date('now', '-29 days');
```

Bridges by role, on the newest day with data (a setup is a solo bridge or a lead; a member belongs
to a setup that a lead counts):

```sql
SELECT role, COUNT(DISTINCT id) AS bridges
FROM pings
WHERE day = (SELECT MAX(day) FROM pings)
GROUP BY role
ORDER BY bridges DESC;
```

The same shape answers `os`, `arch` and `line`: swap the grouped column.

The newest day can be partial, because the day is the sender's UTC date and pings arrive all day.
For a steady number, use a day before today.

## Tests

```
bun test ./telemetry
```

The tests run the handler against a fake D1 and need no Cloudflare account, no network and no
wrangler.

## Local run

```
bunx wrangler d1 execute collie-ping --local --file=schema.sql
bunx wrangler dev --local
```

## Files

| File             | What it is                                                          |
| ---------------- | ------------------------------------------------------------------- |
| `worker.ts`      | The handler, the validation and the daily prune.                    |
| `worker.test.ts` | Tests against a fake D1.                                            |
| `schema.sql`     | The table and its day index.                                        |
| `wrangler.toml`  | The worker, the route, the D1 binding and the cron, with placeholders. |
