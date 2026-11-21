import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Keycaps } from "@/components/shortcut-list";
import { collectHints, type Hint } from "@/lib/shortcuts/hints";
import { getShortcutKeymap, isShortcutBarUp, useShortcutKeymap, useShortcutMode } from "@/lib/shortcuts/state";

// THE KEY HINTS (M108). While the prefix waits, each control on screen that an action key would press wears
// that key on its top right corner, so the bar at the foot names the keys and the page shows where they act.
// Mounted once beside the bar (routes/root.tsx). It is a layer over the page and nothing else: a control
// names its action with `shortcutTarget` (lib/shortcuts/target.ts) and never draws a hint, and no control's
// layout changes. Which hints show, and where, is lib/shortcuts/hints.ts.
//
// WHEN. Only while the prefix waits (the one-shot mode), and only where the bar itself would show:
// `isShortcutBarUp` is the one source of that condition. On a phone with no keyboard the prefix is never
// armed, so this renders nothing and runs nothing. In the normal mode and in a sticky mode the component
// returns null: no frame loop, no observer.
//
// FOLLOWING. One `requestAnimationFrame` pass per frame while the prefix waits. It re-reads the live keymap
// and the page each frame, so a scroll, a resize, a re-bound key or a screen that changes under the prefix
// moves or removes a hint, and React renders only when the answer differs.
//
// NOT A CONTROL. `aria-hidden`, `pointer-events: none`, no focus, never in the tab order; the control's own
// accessible name does not change. The cap is the bar's key cap (`Keycaps`), so a key has one look in the
// app. It has no motion, as the bar has none, so a reduced-motion setting has nothing to turn off.

function HintFrames() {
  const [hints, setHints] = useState<readonly Hint[]>([]);
  useEffect(() => {
    let frame = 0;
    let last = "";
    const tick = () => {
      const keymap = getShortcutKeymap();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const next = keymap === null ? [] : collectHints({ doc: document, keymap, viewport });
      const signature = JSON.stringify(next);
      if (signature !== last) {
        last = signature;
        setHints(next);
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, []);
  return createPortal(
    <div aria-hidden data-slot="shortcut-hint-layer" className="pointer-events-none fixed inset-0 z-[70]">
      {hints.map((hint) => (
        <span
          key={hint.key}
          data-slot="shortcut-hint"
          data-action={hint.action}
          className="absolute inline-flex rounded-md shadow-sm"
          style={{ left: hint.left, top: hint.top }}
        >
          <Keycaps caps={hint.caps} />
        </span>
      ))}
    </div>,
    document.body,
  );
}

export function ShortcutHintLayer() {
  const mode = useShortcutMode();
  const keymap = useShortcutKeymap();
  if (mode !== "prefix" || !isShortcutBarUp(mode, keymap)) return null;
  return <HintFrames />;
}
