import { ExperimentalBadge } from "@/components/experimental-badge";
import { StatusDot } from "@/components/status-badge";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { sessionState, wearsExperimental } from "@/lib/session-cards";
import type { AgentStatus, SessionState, SessionSummary } from "@/lib/types";

// A PROGRAM SESSION AS ONE SPACE (M55 spec 02): a durable program carried by this collie, drawn as a
// row of the dashboard's Spaces list, after the terminal spaces.
//
// Line 1 is the session's name with the Experimental badge; line 2 is its runtime and where it runs
// ("pi-durable, local"). The state draws the shared status mark (DESIGN.md §3), and a session that is
// not ready says so in words at the end of line 1. A tap opens the session's home, its conversation
// list.
//
// The row is the Spaces list's own flat row (`space-overview.tsx`): square, on the list's hairline,
// 14px in from the group's edge, the mark in the same 10px slot. It is two lines where a space row is
// one, because it has two facts to carry; each line states its own height, so a state word that comes
// or goes moves nothing.

/** The shared status mark each state draws. */
const MARK = {
  ready: "idle",
  starting: "working",
  unreachable: "unknown",
} satisfies Record<SessionState, AgentStatus>;

function stateWord(state: SessionState): string {
  return t(`space.program.state.${state}`);
}

/** Line 2: the runtime and the place, or the place alone when the card names no runtime. */
function placeLine(session: Pick<SessionSummary, "mux" | "where">): string {
  const where = t(session.where === "remote" ? "space.program.where.remote" : "space.program.where.local");
  const mux = session.mux ?? "";
  return mux === "" ? where : t("space.program.line", { mux, where });
}

export function ProgramSpaceRow({
  session,
  onOpen,
}: {
  session: SessionSummary;
  onOpen: (name: string) => void;
}) {
  useLocale();
  const state = sessionState(session);
  return (
    <button
      type="button"
      data-slot="program-space"
      data-state={state}
      onClick={() => onOpen(session.name)}
      className="w-full text-left transition-colors hover:bg-muted/50 active:scale-[0.99]"
    >
      <div className="flex flex-row items-center gap-3 px-3.5 py-2.5 shadow-[inset_2px_0_0_0_transparent]">
        <StatusDot status={MARK[state]} className="size-2.5" />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-2">
            <span data-slot="program-space-name" className="min-w-0 truncate font-medium">
              {session.name}
            </span>
            {wearsExperimental(session) && <ExperimentalBadge className="shrink-0" />}
            {/* Ready says nothing on screen: it is the resting state. The word is still there for a
                screen reader, because the mark is a shape and a colour. */}
            {state === "ready" ? (
              <span className="sr-only">{stateWord(state)}</span>
            ) : (
              <span data-slot="program-space-state" className="ml-auto shrink-0 text-xs text-muted-foreground">
                {stateWord(state)}
              </span>
            )}
          </div>
          <div data-slot="program-space-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
            {placeLine(session)}
          </div>
        </div>
      </div>
    </button>
  );
}
