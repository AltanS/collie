import { useState } from "react";
import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { LabelledStrip, STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { StatusDot } from "@/components/status-badge";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { useLongPress } from "@/hooks/use-long-press";
import { paneDisplayName } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface PaneStripProps {
  /** The panes that share the current tab (agents + shells), in stable order. */
  panes: AgentView[];
  currentPaneId: string;
  onSelect: (paneId: string) => void;
  /** Session scope for the long-press pane actions (rename/close); undefined = primary. */
  scope?: Scope;
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
  scope,
  readOnly,
  onRenamed,
  onClosed,
}: PaneStripProps) {
  useLocale();
  const [sheetPane, setSheetPane] = useState<AgentView | null>(null);
  // Actions need both callbacks wired (revalidate on rename, navigate on close); without them the
  // pills stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  if (panes.length < 2) return null;

  return (
    <>
      {/* This row has neither a rule of its own nor a tint of its own any more, and both went for the
          same reason: the tab bar above it is now a FOLDER tab, and the active tab is filled with the
          surface of the content it is attached to. That content is this row.

          - `border-t` would have doubled. The tab bar draws its own baseline `border-b` in --rule,
            because a folder tab has to own the line it breaks; two adjacent 1px rules composite into
            a 2px line, so the cut is drawn once, by the row above.
          - `bg-muted/20` would have broken the illusion. The active tab is `bg-background`; measured
            in dark, the tinted band sat at #101010 against the tab's #0A0A0A, so the tab read as a
            slightly darker box ON the row below rather than as one piece WITH it. The tint is a 2%
            step that was only ever separating this row from its neighbours, and the tab bar's
            baseline now does that job properly. The row is bounded above by that baseline and below
            by the mirror's own top edge.

          Its padding is still the shared one — a tighter row here would have given its pills a
          smaller tap target than the row above. */}
      <LabelledStrip
        label={t("space.paneStrip.title")}
        // No pb-* override: the row's bottom air is LabelledStrip's scroller padding, which is what
        // the pills' tap areas extend into. Overriding it here would clip the 44px floor.
      >
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
      </LabelledStrip>

      {actionsEnabled && (
        <PaneActionsSheet
          open={sheetPane !== null}
          onClose={() => setSheetPane(null)}
          pane={sheetPane}
          scope={scope}
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
      title={active && onTapActive ? t("home.sidebar.paneActionsTitle") : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native long-press gesture otherwise fires pointercancel and kills our hold timer.
        //
        // `rounded-md` (2px), not `rounded-full`: this pill carries a name and a tag, so it is far
        // wider than it is tall — a stadium, not a circle. Full-round is reserved for width ===
        // height. It also has to match the chips in the two strips directly above it, which are the
        // same control one level up.
        //
        // The border and the focus outline are `ui/chip.tsx`'s, copied rather than reinvented: this
        // pill is the space/tab chip one level down and the two must not answer state differently.
        // The border is transparent at rest and lives in the base string, so resting and active
        // occupy exactly the same box and only the paint changes. Focus is a separate channel and
        // sits OUTSIDE the box, so it can never move the row either.
        //
        // Same tap floor as the chips, by the same means: STRIP_TAP_TARGET's transparent ::before
        // takes the hit box to 46px without drawing a pixel. `py-1.5` (was `py-1`) is the one real
        // growth in the whole change — 30px to 34px — and it is not for the floor, which the ::before
        // already clears. It is so this pill and the chips in the two rows above are the SAME height:
        // they are one control at three levels, and the mis-tap that matters most lands here.
        STRIP_TAP_TARGET,
        "flex min-w-11 shrink-0 select-none [-webkit-touch-callout:none] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 py-1.5 text-sm font-medium transition-colors active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
