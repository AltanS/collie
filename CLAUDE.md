# CLAUDE.md — working agreement for this repo

**Collie** (repo `AltanS/collie`) — a phone web UI for your Herdr agent herd, served over
Tailscale. A mobile-first PWA (Vite + React + TS + Tailwind v4 + shadcn) plus a Bun/TS bridge that
talks to Herdr's Unix socket, letting you monitor and reply to agents from a phone. The Herdr
plugin id is `herdr.collie` (manifest: `herdr-plugin.toml`). Orientation:
[`README.md`](./README.md) · [`DESIGN.md`](./DESIGN.md) · verified API
[`HERDR_API.md`](./HERDR_API.md).

## Versioning — MANDATORY

This plugin is **SemVer**ed, and the version is **enforced**, so it never silently drifts.

**The version lives in three files that must always agree, plus a matching CHANGELOG entry:**
`herdr-plugin.toml` (canonical — Herdr reads it) · `package.json` · `web/package.json` ·
newest `## [x.y.z]` heading in `CHANGELOG.md`.

**Before committing any functional change** (anything under `src/`, `web/src/`, `scripts/`, or the
manifest) you MUST:

1. **Bump** the version in all three files to the same number:
   - **PATCH** (`0.2.0 → 0.2.1`): bug fix / internal refactor, no behavior change.
   - **MINOR** (`0.2.0 → 0.3.0`): new backward-compatible capability.
   - **MAJOR** (`0.2.0 → 1.0.0`): breaking change to config, API, or behavior.
2. **Add a `CHANGELOG.md` entry** under a new `## [x.y.z] - YYYY-MM-DD` heading (Added / Changed /
   Fixed). Use the real date.
3. **Run `scripts/check-version.sh`** — it must print `✓`.

Doc-only changes (`*.md`) don't need a bump. This is enforced two ways, but **you are the first
line — do it as part of the change, not after**:

- `scripts/check-version.sh` runs inside `scripts/collie-ctl.sh build` (a release can't build while
  versions disagree).
- A **git pre-commit hook** (`scripts/git-hooks/pre-commit`, activate once with
  `scripts/install-hooks.sh`) blocks commits where functional code changed but the version didn't.
  Escape hatch for a single commit: `SKIP_VERSION_CHECK=1 git commit …`.

## Build / run (operational facts that are easy to forget)

- **Frontend changes** (`web/`): rebuild with `bun run build` (root) or `cd web && bun run build`.
  The bridge serves `web/dist` **from disk at request time**, so on the deployment host (`bluefin`)
  a rebuild is **immediately live — no restart**.
- **Backend changes** (`src/*.ts`): Bun does **not** hot-reload the service — you must
  `systemctl --user restart collie`. Forgetting this is the #1 "my change didn't take" trap.
- Typecheck before building: `cd web && bun run typecheck` (the Vite build does **not** typecheck).
- **Tests:** `cd web && bun run test` (Vitest + jsdom + Testing Library + MSW; no headless browser).
  A **pre-push hook** (`scripts/git-hooks/pre-push`) runs them before every push — override once with
  `SKIP_TESTS=1 git push`. Backend (`src/*.ts`) uses Bun APIs Vitest-on-Node can't run, so tests
  live in `web/`.
- Service: `systemd --user` unit `collie` on `bluefin`; logs `journalctl --user -u collie -f`.
- TS is strict: `verbatimModuleSyntax` + `erasableSyntaxOnly` (no parameter-property shorthand;
  use `import type` for types) + `noUnusedLocals/Parameters`.

## Frontend data layer (React Router, not TanStack)

- Data flows through **React Router** (`createBrowserRouter`, data mode): route **loaders**
  (`web/src/lib/loaders.ts`) fetch the snapshot + pane; **polling is `useRevalidator()` on an
  adaptive interval** (`web/src/hooks/use-polling.ts`); mutations are direct `lib/api.ts` calls
  followed by `revalidator.revalidate()`. There is **no TanStack Query** — don't reintroduce it.
- Routes: `/` (home) and `/pane/:paneId` (detail). The idle-lock in `App.tsx` unmounts the
  `RouterProvider` to pause polling; the router instance is module-scoped so it keeps its location.
- **PWA** via `vite-plugin-pwa` (`web/vite.config.ts`): manifest + `sw.js`, registered manually
  from `virtual:pwa-register` in `main.tsx` (bundled = CSP-safe). Install/SW need a **secure
  context** — over plain HTTP they no-op silently (Chrome insecure-origin flag, or HTTPS, to test).

## Herdr socket gotchas (see HERDR_API.md for the full, verified contract)

- RPC is **one-shot**: one request per connection; the server closes after one reply. `id` must be
  a **string**. Only `events.subscribe` streams.
- `pane.send_keys` grammar is **`+`-joined, not tmux**: `ctrl+c` (NOT `C-c`), `shift+tab`, `Up`,
  `Tab`, `Escape`, `Enter`, `Backspace`. `PageUp`/`Home`/`End`/`Delete` are unsupported.
- Pane output is rendered as **React text nodes** (never `innerHTML`); the ANSI parser only derives
  colors/weights. Keep it that way — it's the XSS boundary. Strict CSP + same-origin gate stay.

## Security posture (don't regress)

Loopback bind only · `tailscale serve` is the sole ingress (never `funnel`) · same-origin gate ·
optional `COLLIE_TRUSTED_USER` identity check · strict CSP. A socket call can type into a
real terminal — treat the bridge as remote shell access.
