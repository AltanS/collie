# 0127: The lead's launcher rows are the crew's rows

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** The lead's merged launcher rows are the crew's rows, and adds go to the lead. A lead row crosses to a member only over the crew link with the lead's header, and the deputy keeps a read-only copy; ADR 0145 states the rule today, and the items it listed as not built (a per-row `hosts` filter, a member switch to decline, an "adopt to the lead" action) are noted in `bridge/crew/launcher-rows.ts`.
- **Full text:** `git show 0741ed872:.adr/0127-the-leads-launcher-rows-are-the-crews-rows.md`
