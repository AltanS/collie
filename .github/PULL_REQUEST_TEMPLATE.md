<!-- What changed, and why. A sentence or two is fine. -->

**Base branch** — see [CONTRIBUTING.md](../CONTRIBUTING.md#base-branch):

- [ ] Opened against `main` — there is one line of development, and `main` is it

**Checks**

- [ ] `bun run typecheck` (root **and** `web/`), `bun run lint`, `bun test ./bridge ./cli ./scripts`, `cd web && bun run test` all pass
- [ ] CHANGELOG entry added under `## [Unreleased]`, below one of `### Added` / `### Changed` /
      `### Fixed` / `### Packaging` / `### Docs`, opening with a bold lead sentence
      (`- **The lead sentence.** the detail …`), no commit hash. A fork PR or a docs-only
      change is exempt, the maintainer picks the version there
