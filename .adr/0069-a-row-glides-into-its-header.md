# 0069 — A row glides into its header

- **Status:** Retired: the rule lives in `web/src/lib/glide.ts` (2026-11-16)
- **Decided:** One hand-started view-transition engine drives every glide, forward on a row tap and back on the arrow, and React Router's `viewTransition` flag stays off for good. A glide that cannot land on a real row, or whose data is late, falls back to a crossfade or the plain slide.
- **Full text:** `git show c3ee48dbf:.adr/0069-a-row-glides-into-its-header.md`
