// The pending leaves (REMIX3.md, "Pending UI"): each is its own small component that subscribes to
// exactly what it draws, so the Shell subscribes to nothing and re-renders on neither (rule 4).
//
//   BusyBar     the 2 px bar over the top of the viewport. It reads `lib/busy.ts`: on for every write
//               in flight, for a first read past 500 ms, and for a poll that has hung past 6 s
//               (web/src/components/busy-bar.tsx fed by lib/busy.ts and hooks/use-poll-busy.ts). It
//               is NOT tied to a glide or to a frame's reload, so an ordinary glide never flashes it.
//               `.busy-bar` (web/src/index.css) holds itself invisible for its first 120 ms and
//               fades in over 140 ms, so a write that answers inside that window never paints it.
//   NavPending  draws nothing. It listens to the top frame's `reloadStart` and `reloadComplete` and
//               holds a navigation load open between them: the orbit turns from the first frame of a
//               navigation, and one still running at 500 ms shows the bar. Our actions fetch nothing,
//               so on an instant route the pair spans one frame and nothing paints; the wait a person
//               feels is the arriving screen's first read, which `startBusyTracking` counts itself.
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";

import { busy } from "../lib/busy";
import { scheduleUpdate } from "../lib/store";

export function BusyBar(handle: Handle) {
  handle.queueTask(() => {
    busy.addEventListener("change", () => scheduleUpdate(handle), { signal: handle.signal });
    if (busy.view.bar) scheduleUpdate(handle);
  });
  return () =>
    busy.view.bar ? (
      <div class="busy-bar" data-testid="busy-bar" role="progressbar" aria-label={t("error.boot.connecting")}>
        <span class="busy-bar__indicator" />
      </div>
    ) : null;
}

export function NavPending(handle: Handle) {
  handle.queueTask(() => {
    const top = handle.frames.top;
    let release: (() => void) | null = null;
    const end = (): void => {
      release?.();
      release = null;
    };
    top.addEventListener(
      "reloadStart",
      () => {
        end();
        release = busy.beginLoad("nav");
      },
      { signal: handle.signal },
    );
    top.addEventListener("reloadComplete", end, { signal: handle.signal });
    // A route that leaves mid-navigation must not strand the orbit.
    handle.signal.addEventListener("abort", end, { once: true });
  });
  return () => null;
}
