// A hold on an element, as `on()` mixins: the subset of web/src/hooks/use-long-press.ts the
// dashboard needs (450 ms, 16 px move tolerance, the right-click / Android contextmenu path, and the
// click that ends a hold swallowed so it is not also a tap). Returns no mixins when `fire` is unset.
import { on } from "remix/component";

const LONG_PRESS_MS = 450;
const MOVE_CANCEL_PX = 16;

export function longPress(fire: (() => void) | undefined) {
  type El = HTMLElement;
  if (fire === undefined) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let start: { x: number; y: number } | undefined;
  let fired = false;
  const clear = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    start = undefined;
  };
  const trigger = (): void => {
    if (fired) return;
    fired = true;
    clear();
    fire();
  };
  return [
    on<El, "pointerdown">("pointerdown", (event: PointerEvent) => {
      fired = false;
      if (event.button !== 0) return;
      start = { x: event.clientX, y: event.clientY };
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, LONG_PRESS_MS);
    }),
    on<El, "pointermove">("pointermove", (event: PointerEvent) => {
      if (!start) return;
      if (Math.abs(event.clientX - start.x) > MOVE_CANCEL_PX || Math.abs(event.clientY - start.y) > MOVE_CANCEL_PX) clear();
    }),
    on<El, "pointerup">("pointerup", clear),
    on<El, "pointercancel">("pointercancel", clear),
    on<El, "pointerleave">("pointerleave", clear),
    on<El, "contextmenu">("contextmenu", (event: MouseEvent) => {
      event.preventDefault();
      trigger();
    }),
    on<El, "click">(
      "click",
      (event: MouseEvent) => {
        if (!fired) return;
        fired = false;
        event.preventDefault();
        event.stopImmediatePropagation();
      },
      true,
    ),
  ];
}
