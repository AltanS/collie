import { PaneBadge } from "@/components/pane-badge";
import { SectionHeader } from "@/components/section-header";
import { ListGroup, LIST_ROW_CORNERS } from "@/components/ui/list-group";
import { Progress } from "@/components/ui/progress";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { modIconOf } from "@/lib/mods/icons";
import { parseModSessionId } from "@/lib/mods/schema";
import { useModsState } from "@/lib/mods/store";
import { paneHeaderLine, paneProgress, paneSubtitle } from "@/lib/pane-marks";
import { paneName } from "@/lib/pane-name";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";

// A MOD SESSION AS ONE ROW (M94 slice 03), and the Mods Space that lists them on the Dashboard and in
// Switch session. The row is the Programs row's shape (program-space-row.tsx): square, on the list's
// hairline, two lines that each state their height, so a subtitle or a badge that comes or goes moves
// nothing. Line 2 is the pane header's line (lib/pane-marks.ts): the running step or the percent while
// the part carries a progress, else its subtitle. The progress is a hairline along the bottom edge, in
// every state: a run that finished red still says how far it got.
//
// IT WEARS NO STATUS MARK. A mod session is never "needs you" (ADR 0063 point 3), so the slot a status
// shape takes on every other row holds the mod's own icon in its own 2px frame, the frame a mod's mark
// draws in (lib/mods/mark.tsx).

/** The mod's icon word, from the store's list, by the session's host and mod. */
function useModIcon(pane: AgentView): string | undefined {
  const { mods } = useModsState();
  const address = parseModSessionId(pane.paneId);
  return mods.find((mod) => mod.host === address?.host && mod.id === address.mod)?.icon;
}

/** The mod's icon in its own frame. Never a status shape. */
export function ModSessionIcon({ pane, className }: { pane: AgentView; className?: string }) {
  const Icon = modIconOf(useModIcon(pane));
  return (
    <span
      aria-hidden
      data-slot="mod-session-icon"
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-sm border border-border text-primary", className)}
    >
      <Icon className="size-3.5" />
    </span>
  );
}

/** Line 2 of a mod session's row, and its Header's: the step or percent, else the subtitle. */
export function modSessionLine(pane: AgentView): string | null {
  return paneHeaderLine(paneProgress(pane), paneSubtitle(pane));
}

export function ModSessionRow({
  pane,
  onOpen,
  variant = "list",
  active = false,
}: {
  pane: AgentView;
  onOpen: (pane: AgentView) => void;
  /** `list` on the Dashboard; `switch` in Switch session, in that sheet's row voice. */
  variant?: "list" | "switch";
  /** The session open now, in Switch session. */
  active?: boolean;
}) {
  useLocale();
  const progress = paneProgress(pane);
  const line = modSessionLine(pane);
  const name = paneName(pane);
  return (
    <button
      type="button"
      data-slot="mod-session"
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
        <ModSessionIcon pane={pane} />
        <div className="min-w-0 flex-1">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <span data-slot="mod-session-name" className={cn("min-w-0 truncate font-medium", variant === "switch" && "text-sm")}>
              {name}
            </span>
            <PaneBadge pane={pane} className="shrink-0" />
          </div>
          <div data-slot="mod-session-line" className="h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
            {line ?? ""}
          </div>
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

/** The Mods Space on the Dashboard: one row per mod session, after the Programs. Nothing when there is none. */
export function ModSpaceSection({ sessions, onOpen }: { sessions: readonly AgentView[]; onOpen: (pane: AgentView) => void }) {
  useLocale();
  if (sessions.length === 0) return null;
  return (
    <section data-slot="mod-space-section" className="flex flex-col gap-2 px-4 py-4">
      <SectionHeader label={t("mods.space.title")} count={sessions.length} />
      <ListGroup id="mods-body">
        {sessions.map((pane) => (
          <ModSessionRow key={pane.paneId} pane={pane} onOpen={onOpen} />
        ))}
      </ListGroup>
    </section>
  );
}

/** The sheet that asks which session a draft with no session goes to (the frame's fix button). */
export function ModDraftPicker({
  open,
  choices,
  onChoose,
  onClose,
}: {
  open: boolean;
  choices: readonly AgentView[];
  onChoose: (pane: AgentView) => void;
  onClose: () => void;
}) {
  useLocale();
  return (
    <BottomSheet open={open} onClose={onClose} title={t("mods.draft.pick")}>
      {choices.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-foreground">{t("mods.draft.none")}</p>
      ) : (
        <ListGroup className="mx-4 mb-4">
          {choices.map((pane) => (
            <button
              key={`${pane.host ?? ""}\n${pane.paneId}`}
              type="button"
              data-slot="mod-draft-choice"
              onClick={() => onChoose(pane)}
              className={cn("flex h-11 w-full min-w-0 items-center px-3.5 text-left text-sm hover:bg-muted/50", LIST_ROW_CORNERS)}
            >
              <span className="min-w-0 truncate">{paneName(pane)}</span>
            </button>
          ))}
        </ListGroup>
      )}
    </BottomSheet>
  );
}
