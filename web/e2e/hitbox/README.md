# The hitbox census

Two Playwright files that measure where a finger's tap lands in the real app, on the repo's own stub
bridge (`e2e/fixtures/api.ts`). They feed ONE file, `src/playground/fixtures/hitbox-census.json`, which
`bun run hitbox:check` reads. (The playground section "Hitbox investigation" that drew it left the design
reference on 2026-11-13: an investigation is not a state of the product. It is in git history.) They are named `*.run.ts`, so `bun run e2e` does not
collect them: a run takes minutes and is for a person to start.

| File | Question | Time |
| --- | --- | --- |
| `census.run.ts` | Every tap target on 37 screens at 390x844 and 360x780: size, hit area, gap, events, verdict | 3 min |
| `dashboard.run.ts` | Why a Dashboard tap sometimes does nothing: eight causes, 200 taps per poll cell | 15 min |

## Run it

```
cd web
bunx vite build
HITBOX_PORT=5301 bunx playwright test -c e2e/hitbox/playwright.config.ts census
HITBOX_PORT=5301 bunx playwright test -c e2e/hitbox/playwright.config.ts dashboard
```

The config starts `vite preview` on 127.0.0.1 only. Pick a free port with `HITBOX_PORT`. Stop the preview
when you are done: Playwright leaves it running when it reuses one.

`HITBOX_TRIES=20` cuts the poll cells for a quick look. `HITBOX_SHOTS=<dir>` saves a screenshot of every
screen at 390 wide.

## Where it lives and why

Under `web/e2e/`, not `scripts/`: it needs Playwright, the stub world and the unit layer's fixtures, which
`web/` already resolves and the repo root does not.

The scanner (`src/playground/hitbox/scan.ts`) is one self-contained function. The census injects it into the
page. The verdict rules are `src/playground/hitbox/verdict.ts`, with tests.

## What it does not do

It sends touches through the DevTools protocol at a fixed contact size, with a still finger unless a case
says otherwise. It does not know a real phone's touch slop, palm contact, standalone mode or 120 Hz. The
tap lab that read those off a phone left with the investigation section; it is in git history.
