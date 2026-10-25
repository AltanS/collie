import { agentLabel } from "@/components/chat-cards";
import { StatusDot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import type { PaneSubagent } from "@/lib/types";
import { cn } from "@/lib/utils";

// The pane's running subagents, as a sheet over the page (Altan, 2026-10-19: "we hate layout shifts.
// agents list should be a sheet or overlay, not causing layout shifts"). It was an in-flow dock above
// the belt, copied from the Tasks dock, and opening it pushed the composer. A `BottomSheet` floats:
// nothing in flow changes when it opens or closes.
//
// One row per subagent: the label an Agent card in Chat uses (model, else type), the task, and how long
// it has run. A tap on a row opens that subagent's transcript in the SAME sheet an Agent card opens
// (subagent-sheet.tsx), as a second layer over this one, the way a message chip inside a sheet opens
// the Messages sheet over it. This list stays open underneath, so closing the transcript comes back to
// it. The rows send nothing.
//
// A row read from the session's journal (Oh My Pi, Gentle Shell) carries `transcript: false`: no
// route serves its log, so it is drawn the same way but is not a button, and a tap does nothing.

/**
 * The name a subagent row draws: its model, else its type. `inherit` names no model, so the type
 * stands in. The row and the transcript sheet read it through `agentLabel`, as an Agent card does.
 */
export function subagentName(subagent: PaneSubagent): string | undefined {
  return subagent.model !== undefined && subagent.model !== "inherit" ? subagent.model : subagent.agentType;
}

interface AgentsSheetProps {
  open: boolean;
  onClose: () => void;
  /** ALREADY TRANSLATED. "Agents 2", the same words the mark on the belt is named by. */
  title: string;
  subagents: readonly PaneSubagent[];
  /** Opens one subagent's transcript over this sheet. */
  onOpen: (subagent: PaneSubagent) => void;
}

export function AgentsSheet({ open, onClose, title, subagents, onOpen }: AgentsSheetProps) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={onClose} title={title}>
      <ul data-slot="agents-list" className="-mx-4 divide-y divide-border">
        {subagents.map((subagent) => {
          const started = subagent.startedAt === undefined ? Number.NaN : Date.parse(subagent.startedAt);
          const body = (
            <>
              <StatusDot status="working" surface="bg-card" className="mt-1" />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-xs font-medium text-muted-foreground">{agentLabel(subagentName(subagent))}</span>
                {subagent.description !== "" && <span className="font-content break-words">{subagent.description}</span>}
              </span>
              {Number.isFinite(started) && (
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{timeAgoShort(started)}</span>
              )}
            </>
          );
          const row = "flex min-h-11 w-full items-start gap-2.5 px-4 py-2.5 text-left text-sm leading-snug";
          return (
            <li key={subagent.agentId}>
              {subagent.transcript === false ? (
                // No transcript behind it: the same row, not a tap.
                <div data-slot="belt-subagent" className={row}>
                  {body}
                </div>
              ) : (
                // A row is one 44px tap (DESIGN.md §6): it opens the subagent's transcript and sends nothing.
                <button
                  type="button"
                  data-slot="belt-subagent"
                  onClick={() => onOpen(subagent)}
                  className={cn(row, "transition-colors active:bg-accent")}
                >
                  {body}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </BottomSheet>
  );
}
