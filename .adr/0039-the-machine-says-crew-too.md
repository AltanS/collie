# 0039 — The machine says "crew" too

- **Status:** Superseded by [ADR 0144](./0144-one-lead-one-door-and-the-operator-moves-the-crown.md) (2026-11-16)
- **Decided:** Every name a machine reads says crew: protocol version 2, `/crew/v1/*`, `X-Crew-*` headers, `crew-*.json` state files and `COLLIE_CREW_*` keys. One release of overlap kept the old names, and 1.9.0 removed it.
- **Full text:** `git show 38f8422b7:.adr/0039-the-machine-says-crew-too.md`
