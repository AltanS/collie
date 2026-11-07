import { useCallback, useLayoutEffect, useState } from "react";
import type { ChangeEvent, CSSProperties, KeyboardEvent, RefObject, SyntheticEvent } from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Minimize2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { hasResizeObserver } from "@/lib/env";
import { cn } from "@/lib/utils";

// THE FULLSCREEN EDITOR (Altan, 2026-11-08: "we'd want this expand input button to go fullscreen for
// very long inputs"). The composer's Expand button opens it; it is the composer's draft written in a
// bigger room, nothing more.
//
// ONE DRAFT. The layer's field is bound to the composer's own draft state through the composer's own
// change handler, so nothing is copied in or out and nothing can be lost between the two. The
// composer opens and closes it in one tap each, moving the focus and the caret from one field to the
// other inside that tap, so the soft keyboard stays up.
//
// WHERE IT STANDS. Over the pane view only: from the top of the reading area (the mirror or the Chat
// stream) to the bottom of the composer's chrome block, as wide as the reading area, so the header and
// the tab strip stay visible and on a wide layout only this pane's column is covered. It is portalled
// to <body> and `fixed`, so no ancestor's overflow or transform can clip it, and it is measured from
// those two elements on open and again on every resize (the keyboard) and scroll. With
// `interactive-widget=resizes-content` the chrome block's bottom is the keyboard's top.
//
// WHAT IS IN IT. The field, filling the layer with no row cap, at the composer's text size; Collapse
// at the top right; Send at the bottom right (the bottom left for the left hand, where the composer's
// Send stands too). No title and no hint. A dialog card or a queued row that arrives meanwhile is drawn
// where it always is, under the layer, and is there when the layer closes.
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
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
  /** The composer's box centre, from the layer's top left: where the opening scale grows from. */
  readonly originX: number;
  readonly originY: number;
}

/** The layer's rectangle: the reading area's top, left and width, down to the chrome block's bottom. */
export function layerFrame(area: DOMRectReadOnly, bottom: number, box: DOMRectReadOnly): Frame {
  return {
    top: area.top,
    left: area.left,
    width: area.width,
    height: Math.max(0, bottom - area.top),
    originX: box.left + box.width / 2 - area.left,
    originY: box.top + box.height / 2 - area.top,
  };
}

function measure(area: HTMLElement, box: HTMLElement): Frame {
  const block = box.closest<HTMLElement>('[data-slot="chrome-block"]') ?? box;
  return layerFrame(area.getBoundingClientRect(), block.getBoundingClientRect().bottom, box.getBoundingClientRect());
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

export interface ExpandedEditorProps {
  /** The reading area: the layer's top, left and width. */
  readonly area: HTMLElement;
  /** The composer's box: the bottom of its chrome block is the layer's bottom. */
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
      className="fixed z-40 flex flex-col bg-background"
      style={{
        top: frame.top,
        left: frame.left,
        width: frame.width,
        height: frame.height,
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
        // The whole layer, 16px of air, and room kept clear of Collapse (top) and Send (bottom), so
        // neither button sits on a line of text. No cap: this field is the room the cap leaves out.
        className="field-sizing-fixed h-full max-h-none min-h-0 flex-1 overflow-y-auto p-4 pt-4 pr-14 pb-16 font-mono"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 size-9 rounded-full text-foreground"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onCollapse}
        aria-label={collapseLabel}
      >
        <Minimize2 className="size-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        className={cn("absolute bottom-3 size-9 rounded-full", hand === "left" ? "left-3" : "right-3", sendInert && "opacity-50")}
        onMouseDown={(event) => event.preventDefault()}
        aria-disabled={sendInert ? true : undefined}
        onClick={sendInert ? undefined : onSend}
        aria-label={sendLabel}
      >
        <ArrowUp className="size-4" />
      </Button>
    </div>,
    document.body,
  );
}
