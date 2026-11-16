# 0084: Machines report their load

- **Status:** Retired: the rule lives in `bridge/machines.ts`, `bridge/machine-history.ts` and `docs/crew.md` (2026-11-16)
- **Decided:** Each Collie samples its own CPU, memory, disks and network on the tick it already has, and the lead keeps 24 hours of history per machine and judges one alert rule per metric. A member keeps no history.
- **Full text:** `git show 21ab922c7:.adr/0084-machines-report-their-load.md`
