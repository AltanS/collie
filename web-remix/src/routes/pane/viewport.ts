// What the viewport says about the pane screen: is the soft keyboard up (web/src/hooks/use-keyboard.ts)
// and is this a short landscape phone (agent-chat.tsx's auto-zen reading). Pure rules plus one
// controller that listens on `visualViewport`, `matchMedia` and `screen.orientation` until the
// route's signal aborts, and wakes its owner through `onChange`.

/** Opening: the viewport lost at least this much height (use-keyboard.ts). */
export const KEYBOARD_MIN_PX = 150;
/** Closing: hysteresis, so a suggestion bar sliding in and out does not flap the reading. */
export const KEYBOARD_CLOSE_PX = 100;

export function nextKeyboardOpen(wasOpen: boolean, baselineHeight: number, currentHeight: number): boolean {
  const lost = baselineHeight - currentHeight;
  return wasOpen ? lost > KEYBOARD_CLOSE_PX : lost > KEYBOARD_MIN_PX;
}

/** The auto-zen switch from Settings (web/src/lib/zen.ts `AUTO_STORAGE_KEY`), read at mount. */
const AUTO_ZEN_KEY = "collie:auto-zen-enabled:v1";

export function autoZenSetting(): boolean {
  try {
    return localStorage.getItem(AUTO_ZEN_KEY) === "1";
  } catch {
    return false;
  }
}

export interface ViewportReading {
  keyboard: boolean;
  landscape: boolean;
}

/** The controller `watchViewport` hands back: a pull of the current reading. */
export interface ViewportWatch {
  read(): ViewportReading;
}

export function watchViewport(onChange: () => void, signal: AbortSignal): ViewportWatch {
  let keyboard = false;
  let landscape = false;
  const vv = globalThis.visualViewport ?? undefined;
  let baseline = vv?.height ?? 0;
  let baselineWidth = vv?.width ?? 0;

  const set = (next: ViewportReading): void => {
    if (next.keyboard === keyboard && next.landscape === landscape) return;
    keyboard = next.keyboard;
    landscape = next.landscape;
    onChange();
  };

  const onResize = (): void => {
    if (!vv) return;
    if (vv.width !== baselineWidth) {
      baselineWidth = vv.width;
      baseline = vv.height;
      set({ keyboard: false, landscape });
      return;
    }
    baseline = Math.max(baseline, vv.height);
    set({ keyboard: nextKeyboardOpen(keyboard, baseline, vv.height), landscape });
  };
  vv?.addEventListener("resize", onResize, { signal });

  if ("matchMedia" in globalThis) {
    const short = window.matchMedia("(max-height: 520px)");
    const wide = window.matchMedia("(orientation: landscape)");
    const orientation = window.screen?.orientation;
    const measure = (): void => {
      const physical = orientation ? orientation.type.startsWith("landscape") : wide.matches;
      set({ keyboard, landscape: physical && short.matches });
    };
    short.addEventListener("change", measure, { signal });
    wide.addEventListener("change", measure, { signal });
    orientation?.addEventListener("change", measure, { signal });
    const physical = orientation ? orientation.type.startsWith("landscape") : wide.matches;
    landscape = physical && short.matches;
  }

  return { read: () => ({ keyboard, landscape }) };
}
