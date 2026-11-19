import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { USER_WELL } from "@/components/user-well";
import { gapBefore, loadingRows, recallSilhouette, type SilhouetteRow, type WidthClass } from "@/lib/chat-silhouette";
import { cn } from "@/lib/utils";

/**
 * How long a Chat body waits for its first page before it draws the pending rows. A switch that is answered
 * inside it (the usual one, and every one that starts from a held window) never shows them.
 */
export const CHAT_PENDING_DELAY_MS = 150;

/** Widths of an agent text's last line, by the class the silhouette keeps. */
const LAST_LINE = { 1: "w-1/3", 2: "w-3/5", 3: "w-5/6" } as const satisfies Record<WidthClass, string>;

/** Widths of a person's bubble, by class: at most the 85 percent the real one takes (`USER_WELL_HUG`). */
const BUBBLE = { 1: "w-[40%]", 2: "w-[70%]", 3: "w-[85%]" } as const satisfies Record<WidthClass, string>;

/** The widths a text's full lines take in turn, so the bars read as lines of words and not as one slab. */
const FULL_LINE = ["w-full", "w-[94%]", "w-full", "w-[88%]"] as const;

/** One bar: muted, breathing with `.count-skeleton`, which holds still under reduced motion. */
function Bar({ className }: { className: string }) {
  return <span className={cn("count-skeleton block h-2.5 shrink-0 rounded-full bg-muted", className)} />;
}

function PersonRow({ row }: { row: SilhouetteRow }) {
  // The bubble's own surface and padding (user-well.ts); the bars stand where its lines of text will.
  const lines = Math.min(6, Math.max(1, Math.round((row.h - 20) / 20)));
  return (
    <div className={cn(USER_WELL, "ml-auto flex flex-col justify-center gap-2", BUBBLE[row.w ?? 2])} style={{ height: row.h }}>
      {Array.from({ length: lines }, (_, index) => (
        <span
          key={index}
          className={cn("count-skeleton block h-2.5 shrink-0 rounded-full bg-status-working/20", index === lines - 1 && lines > 1 ? "w-2/3" : "w-full")}
        />
      ))}
    </div>
  );
}

function AgentRow({ row }: { row: SilhouetteRow }) {
  const lines = row.n ?? 3;
  return (
    <div className="flex flex-col" style={{ height: row.h }}>
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="flex min-h-0 flex-1 items-center">
          <Bar className={index === lines - 1 && lines > 1 ? LAST_LINE[row.w ?? 2] : FULL_LINE[index % FULL_LINE.length]!} />
        </div>
      ))}
    </div>
  );
}

function RowView({ row }: { row: SilhouetteRow }) {
  switch (row.k) {
    case "person":
      return <PersonRow row={row} />;
    case "agent":
      return <AgentRow row={row} />;
    case "tool":
      // The folded run's frame (chat-cards.tsx `FOLDED_RUN`, the ground word): a muted well, the summary and the step as bars.
      return (
        <div className="flex flex-col justify-center gap-2 rounded-md border border-transparent bg-muted/40 px-3" style={{ height: row.h }}>
          <Bar className="w-1/3" />
          <Bar className="ml-5 w-1/2" />
        </div>
      );
    case "card":
      return (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3" style={{ height: row.h }}>
          <Bar className="w-1/4" />
        </div>
      );
    case "other":
      return (
        <div className="flex items-center justify-center" style={{ height: row.h }}>
          <Bar className="w-1/3" />
        </div>
      );
  }
}

/**
 * What the reading area shows while a pane's Chat has not been read yet and the wait has run past
 * {@link CHAT_PENDING_DELAY_MS}: always a mix of a bubble, a tool block and text lines. A pane's own silhouette
 * (lib/chat-silhouette.ts), the rows and heights its thread had when Chat last drew it, is drawn bottom-anchored and
 * filling the screen when it is a mix; a pane this device never drew, or one whose last screen was text alone, gets
 * a typical thread in the same language. No text, no spinner. The bars breathe with `.count-skeleton`, which holds
 * still under reduced motion. The scroller is pinned to its bottom, and its bottom padding is the thread's, so for a
 * mixed silhouette the newest row of the page stands where the newest row of the silhouette stood and nothing jumps
 * when the page comes.
 */
export function ChatPending({ address }: { address: string }) {
  const [late, setLate] = useState(false);
  const [viewport, setViewport] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setTimeout(() => setLate(true), CHAT_PENDING_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
  // The scroller's own height, read before paint: the rows that fill it are chosen from it.
  useLayoutEffect(() => {
    const scroller = root.current?.parentElement;
    if (scroller === null || scroller === undefined) return;
    setViewport(scroller.clientHeight);
  }, [late]);
  if (!late) return null;
  const { rows, top } = loadingRows(recallSilhouette(address), viewport);
  return (
    <div ref={root} data-slot="chat-pending" data-anchor={top ? "top" : "bottom"} aria-hidden className="flex min-w-0 flex-col">
      {rows.map((row, index) => (
        <div key={index} data-row={row.k} className="min-w-0" style={{ marginTop: gapBefore(rows[index - 1]?.k, row.k) }}>
          <RowView row={row} />
        </div>
      ))}
    </div>
  );
}
