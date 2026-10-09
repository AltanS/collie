# 0094: Launchers added from a phone live on the machine, under the operator's switches

- **Status:** Accepted
- **Date:** 2026-10-09
- **Shipped in:** pending (1.19.0)
- **Relates to:** [ADR 0091](./0091-launch-by-id-with-a-request-id.md) (launch by id, the request id
  pattern this reuses), [ADR 0013](./0013-a-peer-listens-without-becoming-a-front-door.md) (the crew
  link forwards, it does not interpret), [ADR 0086](./0086-reads-need-the-pairing-token.md) (pairing).
- **Trail:** `bridge/launcher-recipes.ts` · `bridge/launchers-added.ts` · `bridge/launcher-adds.ts` ·
  `bridge/operator-launchers.ts` (`[phone]`, `harness`, `no_prompts`) · `bridge/server.ts`
  (`serveAddedLauncherRoute`, `launchersRoute`, the revoke paths, `FORGET_DEVICE_PATH`) ·
  `cli/pairing.ts` (`devices revoke`) · `web/src/lib/no-prompts.ts` · spec M48/02

## Context

Until now the launch allowlist was exactly the operator's `launchers.toml`, and that file was the
whole security story of `POST /api/launch`: a phone names a row, it never sends a command line. The
New page (M48) lets a person add their own launcher from the phone. That reopens three questions:

- **Where a phone's row lives.** `launchers.toml` is the operator's hand-written file. A bridge that
  rewrites it loses comments and formatting, and a stolen token would then edit the operator's own
  allowlist.
- **What a phone may add.** A free line is a remote shell line. A recipe (an agent plus option
  chips) is a closed set of words the bridge already knows.
- **Prompts.** Several harnesses can start with permission prompts turned off. A start like that is
  the person's choice and must not read as an answer to a permission prompt nobody saw.

## Decision

**A phone's rows live in a per-machine state file the bridge owns, merged into the allowlist at read
time and governed by two operator switches in `launchers.toml`. A row that skips prompts is badged,
confirmed once per device, and can be turned off by the operator.**

1. **The store.** `<stateDir>/launchers-added.json`, `{ "version": 1, "rows": [...] }`, mode 0600,
   written to a temp name unique to the write and renamed over the target, at most 20 rows. Each row
   records its id (the add's request id), kind (`agent` or `command`), the harness that reads an
   agent row, its source (`recipe` or `text`), the recipe's option ids, the line, the label, whether
   it skips prompts, the adding device's pairing label, whether the add came over the crew link, and
   the time. A file that is not version 1 reads as empty and refuses every write until the operator
   moves it away, so a newer Collie's file survives a downgrade.
2. **Checked again at every read.** The same rule as the add: the character rule on the line and the
   label, and a recipe row must equal what the bridge's table builds today. A row that fails is
   dropped alone. So a hand edit, or a renamed CLI flag, can never type a line nobody added.
3. **The allowlist is a merge.** Built-in harness ids, then the operator's rows, then the added rows
   the switches allow. An operator row wins over an added row with the same line. Nothing merged is
   ever stored.
4. **Recipes first.** The phone sends `{ harness, options: [ids] }`. The bridge looks the ids up in
   `bridge/launcher-recipes.ts` and builds the line, options in table order, one per group. Every flag
   in that table was read off the CLI's own `--help` on 2026-10-09; a harness that was not installed
   lists no option. `GET /api/launchers` carries the table, so the phone can show the line first.
5. **Free text is the operator's switch.** `[phone] free_text` (default false) allows a line typed by
   hand. `[phone] adds` (default true) allows phone rows at all. A value that is not a boolean reads
   as false. Both are enforced on the bridge: the add is refused, and the rows a switch covers leave
   the allowlist at once (kept on disk, so the switch can be turned back on).
6. **The character rule.** Trim, NFC, at most 200 code points for a line and 60 for a label, and no
   ASCII or C1 control character, no U+2028 or U+2029, and no bidi control (U+202A to U+202E, U+2066
   to U+2069, and the LRM, RLM and ALM marks). The operator's own rows meet the same character rule.
7. **Adds are writes.** On the write gate, with a paired device to attribute (`launcher.no_device`
   otherwise), and refused before the attempt on a crew member that is not taking writes. A UUID
   `requestId` is required; a known one answers the stored row with `replayed: true`. Adds are
   serialised, so two copies of one id cannot both write. `?host=` reaches that member's own store
   through the ordinary forward; no row is ever copied to another machine.
8. **Remove and rename** by id, for any paired write device on that machine. Operator rows are not in
   the store and cannot be changed from a phone.
9. **Revoke takes the device's rows.** `POST /api/devices/revoke` and a re-pair over an expired
   device remove its rows and write one audit line per row. `collie devices revoke` (another process)
   removes them from the file and appends the same audit lines. A read-time sweep drops any local row
   whose device is no longer paired, for a revoke this process never saw. A crew member cannot see the
   lead's registry, so the lead sends `launchers/added/forget-device` to each reachable member when a
   label leaves its registry; that path is refused on the browser side and admitted by the crew
   link's two factors alone.
10. **"No prompts" guards.** A recipe chip declares it, and a free line or an operator row is scanned
    for the known flags (Claude `--dangerously-skip-permissions`, `--permission-mode
    bypassPermissions`; Codex `--dangerously-bypass-approvals-and-sandbox`, `--yolo`,
    `--ask-for-approval never`; opencode `--auto`). An alias hides its flags, so a free line also takes
    the person's own tick, and an operator row takes `no_prompts = true`. The phone shows a "No
    prompts" badge in words, and asks once per device before the first start, showing command,
    folder and machine; that confirm is kept per device, per machine and per line, and wiped with the
    pairing. With `adds = false` the operator turns every phone row off.
11. **One list per machine.** `GET /api/launchers` answers `items`: every agent, row and the shell,
    each with `available` and a reason code (`not_found`, `adds_off`, `free_text_off`), so the page
    shows what is off as a disabled option with its reason.

## Consequences

- The operator's `launchers.toml` is never written by the bridge. A phone's rows can be read, and
  removed, in one JSON file.
- A stolen token can add only what the switches allow: by default, a recipe made of words the bridge
  already holds. It cannot add a free line unless the operator turned that on.
- A crew member's rows stay on that member after a revoke if the member was unreachable at that
  moment, or if the lead's bridge was down when `collie devices revoke` ran. Such a row shows who
  added it and can be removed from the phone. Rows on the lead itself have no such gap.
- Codex `--full-auto` is not scanned: Codex 0.162.0 refuses the flag. A CLI that renames a flag
  drops the recipe rows built from it on their next read.
- The state dir gains one file, written only by an add.
