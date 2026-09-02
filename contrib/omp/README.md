# omp slash-command catalog

The running omp session writes a **hint file** (not a control channel — same rule as Collie beacons)
so the phone palette can list skills and extension commands without spawning `omp --mode rpc`.

Install: copy `collie-slash-catalog.ts` to `~/.omp/agent/extensions/` and **restart omp**.

Dumps land in `~/.local/state/collie/slash-catalog/herdr-<paneId>.json`.
Collie's bridge reads those files on each snapshot and merges them into the Agent-commands sheet
(search-only; the shipped omp catalog stays the first screen).
