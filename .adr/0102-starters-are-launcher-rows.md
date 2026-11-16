# 0102: starters are launcher rows

- **Status:** Retired: the rule lives in `bridge/starter-launch.ts` (2026-11-16)
- **Decided:** A durable program's starters are launcher rows: `GET /api/launchers` lists them and `POST /api/launch` runs one by id with a request id and the same receipt, and a starter takes no input. Its point 4, that the operator's switches and the "No prompts" badge rules reach starters, was never built: no switch turns starters off, and a starter never carries the badge.
- **Full text:** `git show 0741ed872:.adr/0102-starters-are-launcher-rows.md`
