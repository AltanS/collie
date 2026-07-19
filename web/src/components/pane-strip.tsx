import { useState } from "react";
import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { SectionLabel } from "@/components/ui/section-label";
import { StatusDot } from "@/components/status-badge";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { useLongPress } from "@/hooks/use-long-press";
import { paneDisplayName } from "@/lib/types";
import type { AgentView } from "@/lib/types";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Session scope for the long-press pane actions (rename/close); undefined = primary. */
  session?: string;
  /** Drop the long-press write actions when the device isn't authorised. */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press pane actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Navigate/refresh after a close (Home if it's the open pane). Enables long-press with onRenamed. */
  onClosed?: (paneId: string) => void;
}

// The panes within the current tab, as a horizontal switcher one level below the tab bar
// (space › tab › pane). Mobile deliberately doesn't replicate the desktop's pane tiling — a tab can
// hold several panes, and this is just a quick way to flip between them. Rendered only when the tab
// actually holds more than one pane (a lone pane needs no switcher), so it's an optional extra row.
// A long-press on a pill opens its actions sheet (rename / close) when the parent wires the actions.
export function PaneStrip({
  panes,
  currentPaneId,
  onSelect,
  session,
  readOnly,
  onRenamed,
  onClosed,
}: PaneStripProps) {
  const [sheetPane, setSheetPane] = useState<AgentView | null>(null);
  // Actions need both callbacks wired (revalidate on rename, navigate on close); without them the
  // pills stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  if (panes.length < 2) return null;

  return (
    <>
      <div className="flex items-center gap-2 overflow-x-auto border-t border-border/40 bg-muted/20 px-3 py-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <SectionLabel>Panes</SectionLabel>
        {panes.map((p) => (
          <PanePill
            key={p.paneId}
            pane={p}
            active={p.paneId === currentPaneId}
            onSelect={onSelect}
            onLongPress={actionsEnabled ? () => setSheetPane(p) : undefined}
            // Tapping the already-active pill would otherwise be a useless re-navigate; repurpose it
            // to open the same actions sheet a long-press would, so it's not a dead tap.
            onTapActive={actionsEnabled ? () => setSheetPane(p) : undefined}
          />
        ))}
      </div>

      {actionsEnabled && (
        <PaneActionsSheet
          open={sheetPane !== null}
          onClose={() => setSheetPane(null)}
          pane={sheetPane}
          session={session}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
        />
      )}
    </>
  );
}

function PanePill({
  pane,
  active,
  onSelect,
  onLongPress,
  onTapActive,
}: {
  pane: AgentView;
  active: boolean;
  onSelect: (paneId: string) => void;
  onLongPress?: () => void;
  /** A plain tap on the pill when it's already `active` — opens actions instead of a no-op re-select. */
  onTapActive?: () => void;
}) {
  const isShell = pane.kind === "shell";
  // The "pN" suffix of the pane id disambiguates same-named panes (two claudes in one tab).
  const tag = pane.paneId.split(":").pop();
  // A user label, then Claude's /rename session name, then the agent/shell name (see paneDisplayName)
  // — the icon still conveys which agent it is.
  const name = paneDisplayName(pane);
  const longPress = useLongPress(onLongPress);

  // A long-press already suppresses the ensuing click via longPress.onClickCapture (stops it before
  // this ever runs), so this only ever sees a genuine tap.
  function onClick() {
    if (active && onTapActive) {
      onTapActive();
      return;
    }
    onSelect(pane.paneId);
  }

  return (
    <button
      type="button"
      onClick={onClick}
      {...longPress}
      aria-current={active ? "true" : undefined}
      title={active && onTapActive ? "Tap for pane actions" : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native long-press gesture otherwise fires pointercancel and kills our hold timer.
        "flex shrink-0 select-none [-webkit-touch-callout:none] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-sm font-medium transition-colors active:scale-95",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0" />
      ) : (
        <StatusDot status={pane.status} />
      )}
      <span>{name}</span>
      <span
        className={cn(
          "font-mono text-[10px]",
          active ? "text-primary-foreground/70" : "text-muted-foreground/60",
        )}
      >
        {tag}
      </span>
    </button>
  );
}
