import { useMemo } from "react";
import type { MouseEvent } from "react";

import { Collapse } from "@/components/ui/collapse";
import { STRIP_SCROLLER, STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { segmentsOf, suggest, type SuggestionLine } from "@/lib/sent-suggest";
import { cn } from "@/lib/utils";

// THE SUGGESTION STRIP (M61 spec 02): one row of chips directly above a shell pane's text box, the way
// a phone keyboard offers words. It shows lines from Sent that fit what is in the box: the folder's
// newest lines while it is empty, prefix matches and then lines holding every typed word while the
// person types (lib/sent-suggest.ts ranks them). A tap puts the line in the box and sends nothing.
// The last chip, "All", opens the Sent sheet.
//
// IT MUST NEVER TAKE THE KEYBOARD AWAY. A tap on a button moves focus off the text box, and that
// closes a phone's keyboard. The chips cancel `mousedown`, whose default is that focus move; a touch
// tap reaches the chip as a click after a compatibility mousedown, so it holds on a phone too. (Not
// `pointerdown`: cancelling that one stops the mouse events that follow it, and with them nothing
// is left to cancel the focus move.)
//
// NOTHING MOVES WHILE TYPING (DESIGN.md §2). The row opens once, through `Collapse`, when the box
// takes focus, and it keeps one height from then on: the chips change, the row does not. A box with
// nothing to match therefore shows the "All" chip alone, and the row does not close.
//
// The caller decides whether the strip is wanted at all (shell pane, box focused, switch on, no Type
// into terminal, no dialog card, not locked, no attachment chip) and passes it as `open`.

export interface SentSuggestionsProps {
  open: boolean;
  /** The lines to rank. An empty list draws no row. */
  lines: readonly SuggestionLine[];
  /** What the box holds now. */
  typed: string;
  /** A chip was tapped: put this line in the box. */
  onPick: (line: string) => void;
  /** The "All" chip: open the Sent sheet. */
  onAll: () => void;
}

/** Keeps the text box focused through a tap on a chip. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

// The drawn chip is 32px; STRIP_TAP_TARGET reaches 7px above and below it, a 46px touch box. The row
// is the 32px plus STRIP_SCROLLER's `py-1.5`, a fixed 44px that nothing inside it can change.
const CHIP =
  "inline-flex h-8 min-w-11 shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-muted px-3 text-xs touch-manipulation active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

export function SentSuggestions({ open, lines, typed, onPick, onAll }: SentSuggestionsProps) {
  useLocale();
  const offered = useMemo(() => suggest(lines, typed), [lines, typed]);
  return (
    <Collapse open={open && lines.length > 0}>
      <div data-slot="sent-suggestions" role="group" aria-label={t("sent.suggest.aria")} className="h-11">
        <OverflowEdges cue="none">
          {(ref) => (
            <div ref={ref} className={cn(STRIP_SCROLLER, "h-11 px-1")}>
              {offered.map((suggestion) => (
                <button
                  key={suggestion.line}
                  type="button"
                  // The line whole: its runs are separate spans, and a reader must not hear the space between two of them go missing.
                  aria-label={suggestion.line}
                  onMouseDown={keepFocus}
                  onClick={() => onPick(suggestion.line)}
                  className={cn(STRIP_TAP_TARGET, CHIP, "max-w-[16rem] justify-start font-mono")}
                >
                  <span className="truncate">
                    {segmentsOf(suggestion).map((segment, i) => (
                      <span key={i} className={segment.matched ? "font-bold text-foreground" : suggestion.marks.length === 0 ? "text-foreground" : "text-muted-foreground"}>
                        {segment.text}
                      </span>
                    ))}
                  </span>
                </button>
              ))}
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={onAll}
                aria-label={t("sent.suggest.all.aria")}
                className={cn(STRIP_TAP_TARGET, CHIP, "font-medium text-foreground")}
              >
                {t("sent.suggest.all")}
              </button>
            </div>
          )}
        </OverflowEdges>
      </div>
    </Collapse>
  );
}
