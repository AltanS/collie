import { MessagesSquare } from "lucide-react";

import { ExperimentalBadge } from "@/components/experimental-badge";
import { StatusDot } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { useLocale } from "@/hooks/use-locale";
import { sessionDisplayName } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import { programCounts, sessionState, wearsExperimental } from "@/lib/session-cards";
import type { AgentStatus, SessionState, SessionSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { LIST_ROW_CORNERS } from "@/components/ui/list-group";

// A PROGRAM SESSION AS ONE ROW (M55 spec 02, spec 13): a durable program carried by this collie or by a
// member of its crew, drawn as a row of the dashboard's Programs section.
//
// Line 1 is the session's name with the Experimental badge; line 2 is its runtime and where it runs
// ("pi-durable, local"), with the member's name after it when another machine of the crew runs it. The
// state draws the shared status mark (DESIGN.md §3). At the right edge a ready program shows its two
// counts: the open conversations, and, only when there are any, the conversations that wait on you, in
// the needs-you ink with its triangle. A program that is not ready says its state in words there instead.
// A tap opens the session's home, its conversation list, in every state.
//
// The row is the Spaces list's own flat row (`space-overview.tsx`): square, on the list's hairline, 14px
// in from the group's edge, the mark in the same 10px slot. It is two lines where a space row is one,
// because it has two facts to carry; each line states its own height, so a count or a state word that
// comes or goes at the right edge moves nothing on the left.

/** The shared status mark each state draws. */
const MARK = {
  ready: "idle",
  starting: "working",
  unreachable: "unknown",
} satisfies Record<SessionState, AgentStatus>;

function stateWord(state: SessionState): string {
  return t(`space.program.state.${state}`);
}

/**
 * The word at the right edge of a row that is not ready. A program the bridge refused for its wire
 * version carries `notice` on its card; it says "Version mismatch" in place of the generic "Unreachable".
 * Its mark, its ink and its tap are the unreachable ones.
 */
function notReadyWord(session: Pick<SessionSummary, "notice">, state: SessionState): string {
  if (state === "unreachable" && (session.notice ?? "") !== "") return t("space.program.state.versionMismatch");
  return stateWord(state);
}

/**
 * Line 2: the runtime and the place, or the place alone when the card names no runtime, then the
 * member's name when another machine of the crew runs the program.
 */
function placeLine(session: Pick<SessionSummary, "mux" | "where">, member: string | undefined): string {
  const where = t(session.where === "remote" ? "space.program.where.remote" : "space.program.where.local");
  const mux = session.mux ?? "";
  const line = mux === "" ? where : t("space.program.line", { mux, where });
  return member === undefined ? line : t("space.program.member", { line, member });
}

/** The two counts of a ready program, the open one anchoring the right edge. */
function Counts({ open, waiting }: { open: number; waiting: number }) {
  return (
    <span data-slot="program-space-counts" className="flex shrink-0 items-center gap-2">
      {/* Hidden at zero, and to the LEFT of the open count, so the open count holds the right edge
          whether or not something waits. */}
      {waiting > 0 && (
        <span
          data-slot="program-space-waiting"
          className="flex items-center gap-1 text-xs font-semibold tabular-nums text-status-blocked"
        >
          <StatusDot status="blocked" className="size-2.5" />
          <span aria-hidden>{waiting}</span>
          <span className="sr-only">{tn("space.program.waiting", waiting)}</span>
        </span>
      )}
      <Badge variant="secondary" data-slot="program-space-open" className="tabular-nums text-muted-foreground">
        <MessagesSquare aria-hidden />
        <span aria-hidden>{open}</span>
        <span className="sr-only">{tn("space.program.open", open)}</span>
      </Badge>
    </span>
  );
}

export function ProgramSpaceRow({
  session,
  member,
  onOpen,
}: {
  session: SessionSummary;
  /** The crew member that runs this program, named when it is not the machine the phone is connected to. */
  member?: string;
  onOpen: (session: SessionSummary) => void;
}) {
  useLocale();
  const state = sessionState(session);
  const counts = programCounts(session);
  return (
    <button
      type="button"
      data-slot="program-space"
      data-state={state}
      onClick={() => onOpen(session)}
      className={cn("w-full text-left transition-colors hover:bg-muted/50 active:scale-[0.99]", LIST_ROW_CORNERS)}
    >
      <div className={cn("flex flex-row items-center gap-3 px-3.5 py-2.5 shadow-[var(--edge-accent)_transparent]", LIST_ROW_CORNERS)}>
        <StatusDot status={MARK[state]} className="size-2.5" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-2">
            <span data-slot="program-space-name" className="min-w-0 truncate font-medium">
              {sessionDisplayName(session)}
            </span>
            {wearsExperimental(session) && <ExperimentalBadge className="shrink-0" />}
          </div>
          <div data-slot="program-space-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
            {placeLine(session, member)}
          </div>
        </div>
        {/* Ready shows its counts and says its state only to a screen reader, because the mark is a
            shape and a colour. Starting and unreachable say the word where the counts would be:
            there is nothing to count yet, or nothing current. */}
        {state === "ready" ? (
          <>
            <span className="sr-only">{stateWord(state)}</span>
            <Counts open={counts.open} waiting={counts.waiting} />
          </>
        ) : (
          <span
            data-slot="program-space-state"
            className={cn("shrink-0 text-xs", state === "unreachable" ? "text-muted-foreground" : "text-foreground")}
          >
            {notReadyWord(session, state)}
          </span>
        )}
      </div>
    </button>
  );
}
