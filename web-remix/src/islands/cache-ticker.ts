// The cache chips' countdown on an islands page (S3). A chip in server HTML (chips/cache-chip.tsx) carries
// its expiry in `data-expires` and its state in `data-state`; this rewrites the minutes in its
// `[data-cache-label]` once every whole minute, as the chip's own clock does on a static-shell page. A
// chip that turns cold, or any other change of tint, comes with the next frame answer: the server draws
// it from the same clock.
import { cacheChipView } from "@web/lib/cache-view";
import type { PaneCache } from "@web/lib/types";

const TICK_MS = 15_000;

/** Rewrite every ticking chip's label now. */
export function tickCacheChips(root: ParentNode = document, now = Date.now()): void {
  for (const chip of root.querySelectorAll<HTMLElement>("[data-slot=cache-chip][data-expires]")) {
    const expiresAt = Number(chip.dataset.expires);
    const state = chip.dataset.state;
    if (!Number.isFinite(expiresAt) || (state !== "warm" && state !== "expiring")) continue;
    // Only the state and the expiry reach the countdown (web/src/lib/cache-view.ts `cacheChipView`).
    const view = cacheChipView({ state, expiresAt, ttlSeconds: 0, ruleId: "", confidence: "inferred" } satisfies PaneCache, now);
    const label = chip.querySelector<HTMLElement>("[data-cache-label]");
    if (view === null || label === null || label.textContent === view.label) continue;
    label.textContent = view.label;
  }
}

/** Tick until `signal` aborts. */
export function startCacheTicker(signal: AbortSignal): void {
  const timer = setInterval(() => tickCacheChips(), TICK_MS);
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
