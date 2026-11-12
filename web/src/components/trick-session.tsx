import { PaneBadge } from "@/components/pane-badge";
import { SectionHeader } from "@/components/section-header";
import { ListGroup, LIST_ROW_CORNERS } from "@/components/ui/list-group";
import { MatchText } from "@/components/ui/match-text";
import { Progress } from "@/components/ui/progress";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { trickIconOf } from "@/lib/tricks/icons";
import { parseTrickSessionId } from "@/lib/tricks/schema";
import { useTricksState } from "@/lib/tricks/store";
import { viaLabelKey, type PaneField, type PaneMatch } from "@/lib/pane-filter";
import { paneHeaderLine, paneProgress, paneSubtitle } from "@/lib/pane-marks";
import { paneName } from "@/lib/pane-name";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A TRICK SESSION AS ONE ROW (M94 slice 03), and the Tricks Space that lists them on the Dashboard and in
// Switch session. The row is the Programs row's shape (program-space-row.tsx): square, on the list's
// hairline, two lines that each state their height, so a subtitle or a badge that comes or goes moves
// nothing. Line 2 is the pane header's line (lib/pane-marks.ts): the running step or the percent while
// the part carries a progress, else its subtitle. The progress is a hairline along the bottom edge, in
// every state: a run that finished red still says how far it got.
//
// IT WEARS NO STATUS MARK. A trick session is never "needs you" (ADR 0063 point 3), so the slot a status
// shape takes on every other row holds the trick's own icon in its own 2px frame, the frame a trick's mark
// draws in (lib/tricks/mark.tsx).

/** The trick's icon word, from the store's list, by the session's host and trick. */
function useTrickIcon(pane: AgentView): string | undefined {
  const { tricks } = useTricksState();
  const address = parseTrickSessionId(pane.paneId);
  return tricks.find((trick) => trick.host === address?.host && trick.id === address.trick)?.icon;
}

/** The trick's icon in its own frame. Never a status shape. */
export function TrickSessionIcon({ pane, className }: { pane: AgentView; className?: string }) {
  const Icon = trickIconOf(useTrickIcon(pane));
  return (
    <span
      aria-hidden
      data-slot="trick-session-icon"
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-border text-primary", className)}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** Line 2 of a trick session's row, and its Header's: the step or percent, else the subtitle. */
export function trickSessionLine(pane: AgentView): string | null {
  return paneHeaderLine(paneProgress(pane), paneSubtitle(pane));
}

/** What a trick session's row draws as text, for the session filter (lib/pane-filter.ts): its name only. */
export const TRICK_ROW_DRAWN: ReadonlySet<PaneField> = new Set<PaneField>(["name"]);

export function TrickSessionRow({
  pane,
  onOpen,
  variant = "list",
  active = false,
  match,
}: {
  pane: AgentView;
  onOpen: (pane: AgentView) => void;
  /** `list` on the Dashboard; `switch` in Switch session, in that sheet's row voice. */
  variant?: "list" | "switch";
  /** The session open now, in Switch session. */
  active?: boolean;
  /**
   * How Switch session's filter matched this row (M97). Absent with no query: the row is drawn as
   * before. A match in a field the row does not draw takes line 2's slot, as on a pane row.
   */
  match?: PaneMatch | undefined;
}) {
  useLocale();
  const progress = paneProgress(pane);
  const line = trickSessionLine(pane);
  const name = paneName(pane);
  const marks = match?.hit.marks;
  const via = match?.hit.via ?? null;
  const viaLabel = via === null ? null : viaLabelKey(via);
  return (
    <button
      type="button"
      data-slot="trick-session"
      data-pane-id={pane.paneId}
      onClick={() => onOpen(pane)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "relative w-full text-left transition-colors",
        variant === "list"
          ? cn("hover:bg-muted/50 active:scale-[0.99]", LIST_ROW_CORNERS)
          : cn("min-h-11 rounded-sm border border-transparent", active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted"),
      )}
    >
      <div className={cn("flex flex-row items-center gap-3", variant === "list" ? "px-3.5 py-2.5" : "gap-2.5 px-2.5 py-2")}>
        <TrickSessionIcon pane={pane} />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <span data-slot="trick-session-name" className={cn("min-w-0 truncate font-medium", variant === "switch" && "text-sm")}>
              <MatchText text={name} ranges={marks?.name} />
            </span>
            <PaneBadge pane={pane} className="shrink-0" />
          </div>
          {via !== null && match !== undefined ? (
            <div data-slot="trick-session-line" className="flex h-4 min-w-0 items-baseline gap-1 text-xs leading-4 text-muted-foreground">
              {viaLabel !== null && <span className="shrink-0 text-muted-foreground/70">{t(viaLabel)}</span>}
              <span data-slot="trick-session-via" className="min-w-0 flex-1 truncate">
                <MatchText text={match.fields[via]} ranges={marks?.[via]} />
              </span>
            </div>
          ) : (
            <div data-slot="trick-session-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
              {line ?? ""}
            </div>
          )}
        </div>
      </div>
      {progress !== null && (
        <Progress
          value={progress.value}
          label={t("chat.progress.aria")}
          size="hairline"
          className="pointer-events-none absolute inset-x-3.5 bottom-0 w-auto"
        />
      )}
    </button>
  );
}

/** The Tricks Space on the Dashboard: one row per trick session, after the Programs. Nothing when there is none. */
export function TrickSpaceSection({ sessions, onOpen }: { sessions: readonly AgentView[]; onOpen: (pane: AgentView) => void }) {
  useLocale();
  if (sessions.length === 0) return null;
  return (
    <section data-slot="trick-space-section" className="flex flex-col gap-2 px-4 py-4">
      <SectionHeader label={t("tricks.space.title")} count={sessions.length} />
      <ListGroup id="tricks-body">
        {sessions.map((pane) => (
          <TrickSessionRow key={pane.paneId} pane={pane} onOpen={onOpen} />
        ))}
      </ListGroup>
    </section>
  );
}
