<!-- What changed, and why. A sentence or two is fine. -->

**Base branch** — see [CONTRIBUTING.md](../CONTRIBUTING.md#base-branches):

- [ ] Bugfix → opened against `main`
- [ ] Feature, or a change to `cli/` or the bridge → opened against `v1`

**Checks**

- [ ] `bun run typecheck` (root **and** `web/`), `bun run lint`, `bun test ./bridge ./cli ./scripts`, `cd web && bun run test` all pass
- [ ] CHANGELOG entry added — or this is a fork PR / docs-only change, where the maintainer picks the version
