# CLAUDE.md — working agreement for this repo

**Collie** (repo `AltanS/collie`) — a phone web UI for your Herdr agent herd, served over
Tailscale. A mobile-first PWA (Vite + React + TS + Tailwind v4 + shadcn) plus a Bun/TS bridge that
talks to Herdr's Unix socket, letting you monitor and reply to agents from a phone. The Herdr
plugin id is `herdr.collie` (manifest: `herdr-plugin.toml`). Orientation:
[`README.md`](./README.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) · verified API
[`HERDR_API.md`](./HERDR_API.md).

## Versioning — MANDATORY

This plugin is **SemVer**ed, and the version is **enforced**, so it never silently drifts.

**The version lives in three files that must always agree, plus a matching CHANGELOG entry:**
`herdr-plugin.toml` (canonical — Herdr reads it) · `package.json` · `web/package.json` ·
newest `## [x.y.z]` heading in `CHANGELOG.md`.

**Before committing any functional change** (anything under `bridge/`, `web/src/`, `scripts/`, or the
manifest) you MUST:

1. **Bump** the version in all three files to the same number:
   - **PATCH** (`0.2.0 → 0.2.1`): bug fix / internal refactor, no behavior change.
   - **MINOR** (`0.2.0 → 0.3.0`): new backward-compatible capability.
   - **MAJOR** (`0.2.0 → 1.0.0`): breaking change to config, API, or behavior.
2. **Add a `CHANGELOG.md` entry** under a new `## [x.y.z] - YYYY-MM-DD` heading (Added / Changed /
   Fixed). Use the real date. **Style: super crisp and short** — one line per change, no prose
   paragraphs, and cite the feature's short commit hash at the end of the line (`… (abc1234)`).
   Land features as their own commits first, then cut the release commit so the entry can cite them.
3. **Run `scripts/check-version.sh`** — it must print `✓`.

Doc-only changes (`*.md`) don't need a bump. This is enforced two ways, but **you are the first
line — do it as part of the change, not after**:

- `scripts/check-version.sh` runs inside `scripts/collie-ctl.sh build` (a release can't build while
  versions disagree).
- A **git pre-commit hook** (`scripts/git-hooks/pre-commit`, activate once with
  `scripts/install-hooks.sh`) blocks commits where functional code changed but the version didn't.
  Escape hatch for a single commit: `SKIP_VERSION_CHECK=1 git commit …`.

**Tag the release when you push it.** Cutting a release means the three version files + the newest
`CHANGELOG.md` heading agree on `x.y.z` (steps 1–3). When that release lands on `main` and you push,
**always push a matching annotated git tag with it** — `git tag -a vX.Y.Z -m "Collie X.Y.Z" && git
push origin vX.Y.Z` (or `git push --follow-tags` so the tag ships *with* the release). One `v<x.y.z>`
tag per shipped version on the remote. Not hook-enforced — it's on you. (Adding/adjusting this note is
a doc-only change and needs no version bump.)

**Update notice (user-facing).** The app's in-app update banner links to the newest release's GitHub
page and shows the command to run. Pushing a `v*` tag auto-creates that GitHub Release (with the
commands) via `.github/workflows/release.yml`. **Always express user-facing update/restart
instructions as Herdr plugin actions** — `herdr plugin action invoke update --plugin herdr.collie`
(or `restart`) — never `collie-ctl.sh …` / `systemctl … collie`, which depend on the caller's cwd and
the unit name; the Herdr action runs from anywhere.

## Build / run (operational facts that are easy to forget)

- **Frontend changes** (`web/`): rebuild with `bun run build` (root) or `cd web && bun run build`.
  The bridge serves `web/dist` **from disk at request time**, so on the deployment host
  a rebuild is **immediately live — no restart**.
- **Backend changes** (`bridge/*.ts`): Bun does **not** hot-reload the service — you must
  `systemctl --user restart collie`. Forgetting this is the #1 "my change didn't take" trap.
- `bun run build` (root) and `collie-ctl.sh build` **typecheck both sides first** (root tsc + web
  tsc), then build web to `dist-staging` and swap it in atomically — a failed build never empties a
  live `web/dist`. Bare `cd web && bun run build` still skips typechecking; don't ship from it.
- **Tests:** frontend `cd web && bun run test` (Vitest + jsdom + Testing Library + MSW; no headless
  browser); backend pure-logic `bun run test` at the root (Bun's own runner — covers `checkAccess`,
  `StateEngine`, `loadConfig`). A **pre-push hook** (`scripts/git-hooks/pre-push`) runs **both** before
  every push — override once with `SKIP_TESTS=1 git push`. The bits that genuinely need `Bun.serve` /
  `Bun.connect` (HTTP handlers, the socket client) stay unit-untested — Vitest-on-Node can't run them,
  so keep new backend logic pure/injectable enough for `bun test`, or exercise it through `web/`.
- Service: `systemd --user` unit `collie` on the deployment host; logs `journalctl --user -u collie -f`.
- TS is strict on both sides, with `noUnusedLocals/Parameters` everywhere. **`web/` additionally**
  enforces `verbatimModuleSyntax` + `erasableSyntaxOnly` (use `import type`, no parameter-property
  shorthand there). The **bridge** tsconfig does not enable those two — bridge code uses
  parameter-property shorthand by convention; keep each side consistent with itself.

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
