# Recorded Tern output

Real output of **tern 0.4.5 (`1d14241`)** on Linux, recorded by @Codder13 on 2026-10-05 and posted
in PR 356. The home folder is renamed to `/home/you`. Nothing else is changed.

- `ls-0.4.5.json` is one `tern ls --json` answer.
- `events-0.4.5.ndjson` is `tern events` across two block creates and two closes.

`captures.test.ts` reads both through the adapter's own parsers, so a change to the parsers that a
real Tern would not survive fails here. The fake Tern in `fixture.ts` is built by hand. These files
are the only bytes in the folder that came from a Tern.
