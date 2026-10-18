import { useMemo } from "react";
import type { MouseEvent } from "react";

import { Collapse } from "@/components/ui/collapse";
import { STRIP_SCROLLER, STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { OverflowEdges } from "@/components/ui/overflow-edges";
import { useLocale } from "@/hooks/use-locale";
import type { AgentCommand } from "@/lib/agent-commands";
import { t } from "@/lib/i18n";
import { segmentsOf, suggest, SUGGEST_LIMIT, type Suggestion, type SuggestionLine } from "@/lib/sent-suggest";
import { cn } from "@/lib/utils";

// THE SUGGESTION STRIP: one row of chips directly above the composer's text box, the way a phone
// keyboard offers words. A tap puts the chip's text in the box and sends nothing. It has two sources,
// and a pane only ever has one of them:
//
// - SENT, on a shell pane (M61 spec 02). Lines from Sent that fit what is in the box: the folder's
//   newest lines while it is empty, prefix matches and then lines holding every typed word while the
//   person types (lib/sent-suggest.ts ranks them). The last chip, "All", opens the Sent sheet. The
//   Settings switch `sentSuggestions` governs this source and only this one.
// - COMMANDS, on an agent pane (#475). The agent's own command list (the shipped catalog, or the
//   operator's `commands.toml` rows where they address the pane), filtered by the typed `/` or `$`
//   token (lib/agent-commands.ts `suggestCommands` ranks them), at most SUGGEST_LIMIT chips. A tap fills the box with the command
//   and a trailing space, and the trailing space closes the row. Nothing here reads a file on disk.
//
// IT MUST NEVER TAKE THE KEYBOARD AWAY. A tap on a button moves focus off the text box, and that
// closes a phone's keyboard. The chips cancel `mousedown`, whose default is that focus move; a touch
// tap reaches the chip as a click after a compatibility mousedown, so it holds on a phone too. (Not
// `pointerdown`: cancelling that one stops the mouse events that follow it, and with them nothing
// is left to cancel the focus move.)
//
// NOTHING MOVES WHILE TYPING (DESIGN.md §2). The row opens through `Collapse` and keeps one height
// while it is open: the chips change, the row does not. On a shell pane it opens when the box takes
// focus, and a box with nothing to match shows the "All" chip alone rather than closing.
//
// The caller decides whether the strip is wanted at all and passes it as `open`: for Sent that is a
// shell pane, box focused, switch on, no Type into terminal, no dialog card, not locked, no
// attachment chip; for commands it is an agent pane, not locked, no Type into terminal, and a typed
// token that matches at least one command.

/** Lines from Sent, on a shell pane. */
export interface SentSource {
  kind: "sent";
  /** The lines to rank. An empty list draws no row. */
  lines: readonly SuggestionLine[];
  /** A chip was tapped: put this line in the box. */
  onPick: (line: string) => void;
  /** The "All" chip: open the Sent sheet. */
  onAll: () => void;
}

/** The agent's own commands, already filtered and ranked for the typed token, on an agent pane. */
export interface CommandSource {
  kind: "commands";
  /** The commands to offer, in order. An empty list draws no row. */
  commands: readonly AgentCommand[];
  /** A chip was tapped: put this command in the box. */
  onPick: (command: AgentCommand) => void;
}

export type SuggestionSource = SentSource | CommandSource;

export interface SuggestionStripProps {
  open: boolean;
  /** What the box holds now. */
  typed: string;
  source: SuggestionSource;
}

/** Keeps the text box focused through a tap on a chip. */
function keepFocus(event: MouseEvent) {
  event.preventDefault();
}

// The drawn chip is 32px; STRIP_TAP_TARGET reaches 7px above and below it, a 46px touch box. The row
// is the 32px plus STRIP_SCROLLER's `py-1.5`, a fixed 44px that nothing inside it can change.
const CHIP =
  "inline-flex h-8 min-w-11 shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md border border-transparent bg-muted px-3 text-xs touch-manipulation active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

interface Chip {
  key: string;
  suggestion: Suggestion;
  pick: () => void;
}

// A command chip draws its name whole, without the bold: the list was ranked by name and by
// description, and a bold run would mark only the first kind of match.
function chipsOf(source: SuggestionSource, sentOffered: readonly Suggestion[]): Chip[] {
  if (source.kind === "sent") {
    return sentOffered.map((suggestion) => ({
      key: suggestion.line,
      suggestion,
      pick: () => source.onPick(suggestion.line),
    }));
  }
  // The same cap as Sent's: the best matches first, in the order `suggestCommands` ranked them. A bare
  // `/` therefore shows the first twelve, and the Agent palette stays the place for the full list.
  return source.commands.slice(0, SUGGEST_LIMIT).map((command) => ({
    key: command.command,
    suggestion: { line: command.command, marks: [] },
    pick: () => source.onPick(command),
  }));
}

export function SuggestionStrip({ open, typed, source }: SuggestionStripProps) {
  useLocale();
  // Sent ranks up to 300 lines per keystroke, so that ranking is memoised on the lines and the text;
  // the command list arrives already ranked (the composer calls `suggestCommands`).
  const sentLines = source.kind === "sent" ? source.lines : null;
  const sentOffered = useMemo(() => (sentLines === null ? [] : suggest(sentLines, typed)), [sentLines, typed]);
  const chips = chipsOf(source, sentOffered);
  const sent = source.kind === "sent";
  const hasRows = sent ? source.lines.length > 0 : source.commands.length > 0;
  return (
    <Collapse open={open && hasRows}>
      <div
        data-slot={sent ? "sent-suggestions" : "command-suggestions"}
        role="group"
        aria-label={sent ? t("sent.suggest.aria") : t("commands.title")}
        className="h-11"
      >
        <OverflowEdges cue="none">
          {(ref) => (
            <div ref={ref} className={cn(STRIP_SCROLLER, "h-11 px-1")}>
              {chips.map(({ key, suggestion, pick }) => (
                <button
                  key={key}
                  type="button"
                  // The line whole: its runs are separate spans, and a reader must not hear the space between two of them go missing.
                  aria-label={suggestion.line}
                  onMouseDown={keepFocus}
                  onClick={pick}
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
              {sent && (
                <button
                  type="button"
                  onMouseDown={keepFocus}
                  onClick={source.onAll}
                  aria-label={t("sent.suggest.all.aria")}
                  className={cn(STRIP_TAP_TARGET, CHIP, "font-medium text-foreground")}
                >
                  {t("sent.suggest.all")}
                </button>
              )}
            </div>
          )}
        </OverflowEdges>
      </div>
    </Collapse>
  );
}
