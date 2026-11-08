import { useCallback, useLayoutEffect, useState } from "react";
import type { ChangeEvent, CSSProperties, KeyboardEvent, ReactNode, RefObject, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { Icon } from "@/components/icons/icon";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

// THE FULLSCREEN EDITOR (Altan, 2026-11-08: "we'd want this expand input button to go fullscreen for
// very long inputs", and after his phone test: "what do we need the header and the tabs row for in this
// expanded view? it should be a full screen modal"). The composer's Expand button opens it; it is the
// composer's draft written in a bigger room, with the composer's own row of buttons under it.
//
// ONE DRAFT. The layer's field is bound to the composer's own draft state through the composer's own
// change handler, so nothing is copied in or out and nothing can be lost between the two. The
// composer opens and closes it in one tap each, moving the focus and the caret from one field to the
// other inside that tap, so the soft keyboard stays up.
//
// WHERE IT STANDS. The whole app height, `--app-h` (the layout viewport, so above the keyboard, with
// the iOS standalone correction index.css carries), from the top of the screen: the header and the
// tab row are under it, as in the output zoom. Its top padding is the safe area. Its left edge and
// width are the pane's reading area's, so on a phone it is the full width and on a wide layout only
// this pane's column. It is portalled to <body> and `fixed`, so no ancestor's overflow or transform
// can clip it, and the column is measured again on every resize and scroll.
//
// WHAT IS IN IT. The field, filling everything between the safe area and the bottom row, with no row
// cap, at the composer's text size; Collapse at the top right, for either hand; and the composer's
// open row without Expand: Attach, the space, the small mic, Send, mirrored for the left hand. Attach
// and the mic are the composer's own (`leading`, `trailing`), with their behaviour: Attach's picker
// opens from this row, and the mic dictates into the same draft. While a recording stands the layer
// steps aside (`hidden`) so the voice takeover, drawn over the composer, is seen; it comes back when
// the clip lands. A dialog card or a queued row that arrives meanwhile is drawn where it always is,
// under the layer, and is there when the layer closes.
//
// WHAT CLOSES IT is the composer's business (Collapse, Send, Escape, a pane switch, the pane going
// away), never a tap outside, because there is no outside. Android's Back and the iOS edge swipe are
// not taken: a layer that owned a history entry would be a level (ADR 0067, rule 7, sheets own no
// history), so Back leaves the pane as it does with a sheet open, the layer goes with the composer,
// and the draft stays on the phone as every draft does.
//
// MOTION. It opens with a 150 ms fade and a scale from 98%, centred on the composer's box, with no
// slide and no bounce; under reduced motion it simply appears. It closes at once.

/** How long the layer takes to open, in ms. */
export const EXPANDED_OPEN_MS = 150;

interface Frame {
  readonly left: number;
  readonly width: number;
  /** The composer's box centre, from the layer's top left: where the opening scale grows from. */
  readonly originX: number;
  readonly originY: number;
}

/** The layer's column: the reading area's left edge and width; the height is the app's own. */
export function layerFrame(area: DOMRectReadOnly, box: DOMRectReadOnly): Frame {
  return {
    left: area.left,
    width: area.width,
    originX: box.left + box.width / 2 - area.left,
    originY: box.top + box.height / 2,
  };
}

function measure(area: HTMLElement, box: HTMLElement): Frame {
  return layerFrame(area.getBoundingClientRect(), box.getBoundingClientRect());
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export interface ExpandedEditorProps {
  /** The pane's reading area: the layer's left edge and width. */
  readonly area: HTMLElement;
  /** The composer's box: where the opening grows from. */
  readonly box: HTMLElement;
  readonly fieldRef: RefObject<HTMLTextAreaElement | null>;
  readonly value: string;
  readonly onChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  readonly onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => void;
  readonly placeholder: string;
  /** The composer's draft style (size and face); the cap is not taken. */
  readonly fieldStyle: CSSProperties;
  readonly hand: "left" | "right";
  readonly collapseLabel: string;
  readonly sendLabel: string;
  /** Send cannot act now (offline, sending, locked): the button stays, the tap does nothing. */
  readonly sendInert: boolean;
  readonly onCollapse: () => void;
  readonly onSend: () => void;
  /** The composer's Attach button and its picker, first in the row (last for the left hand). */
  readonly leading: ReactNode;
  /** The composer's small mic, beside Send. */
  readonly trailing: ReactNode;
  /** A recording stands: the layer steps aside so the voice takeover is seen. */
  readonly hidden: boolean;
}

export function ExpandedEditor({
  area,
  box,
  fieldRef,
  value,
  onChange,
  onSelect,
  placeholder,
  fieldStyle,
  hand,
  collapseLabel,
  sendLabel,
  sendInert,
  onCollapse,
  onSend,
  leading,
  trailing,
  hidden,
}: ExpandedEditorProps) {
  const [frame, setFrame] = useState<Frame>(() => measure(area, box));
  const [layer, setLayer] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const update = () => setFrame(measure(area, box));
    update();
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    const observer = hasResizeObserver() ? new ResizeObserver(update) : null;
    observer?.observe(area);
    return () => {
      viewport?.removeEventListener("resize", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      observer?.disconnect();
    };
  }, [area, box]);

  // The opening, once, from the composer's box. Read from the first frame only: a resize later moves
  // the layer and must not replay it.
  useLayoutEffect(() => {
    if (layer === null || reducedMotion() || !("animate" in layer)) return;
    const animation = layer.animate({ opacity: [0, 1], transform: ["scale(0.98)", "scale(1)"] }, { duration: EXPANDED_OPEN_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" });
    return () => animation.cancel();
  }, [layer]);

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCollapse();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (!sendInert) onSend();
      }
    },
    [onCollapse, onSend, sendInert],
  );

  return createPortal(
    <div
      ref={setLayer}
      data-slot="composer-expanded"
      role="dialog"
      aria-modal="true"
      aria-label={collapseLabel}
      className={cn("fixed top-0 z-40 flex h-(--app-h) flex-col bg-background pt-[env(safe-area-inset-top)]", hidden && "invisible")}
      style={{
        left: frame.left,
        width: frame.width,
        transformOrigin: `${frame.originX}px ${frame.originY}px`,
      }}
    >
      <ChatInput
        ref={fieldRef}
        value={value}
        onChange={onChange}
        onSelect={onSelect}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        style={fieldStyle}
        // Everything above the row, 16px of air, and room kept clear of Collapse at the top right. No
        // cap: this field is the room the cap leaves out.
        className="field-sizing-fixed min-h-0 max-h-none flex-1 overflow-y-auto p-4 pr-14 font-mono"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-[calc(env(safe-area-inset-top)+0.5rem)] right-2 size-9 rounded-full text-foreground"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCollapse}
        aria-label={collapseLabel}
      >
        <Icon name="editor-close" className="size-4" />
      </Button>
      {/* The composer's open row without Expand: [Attach][space][mic][Send], mirrored for the left
          hand. `relative` is the anchor of Attach's picker, which opens above this row. */}
      <div data-slot="composer-expanded-row" className={cn("relative flex shrink-0 items-center gap-1.5 px-3 pt-1.5 pb-3", hand === "left" && "flex-row-reverse")}>
        {leading}
        <span className="flex-1" />
        {trailing}
        <Button
          type="button"
          size="icon"
          className={cn("size-9 shrink-0 rounded-full", sendInert && "opacity-50")}
          onMouseDown={(event) => event.preventDefault()}
          aria-disabled={sendInert ? true : undefined}
          onClick={sendInert ? undefined : onSend}
          aria-label={sendLabel}
        >
          <Icon name="send-ready" className="size-4" />
        </Button>
      </div>
    </div>,
    document.body,
  );
}
