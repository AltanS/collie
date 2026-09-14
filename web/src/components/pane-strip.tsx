import { useRef, useState } from "react";
import { TerminalSquare } from "lucide-react";

import { cn } from "@/lib/utils";
import { LabelledStrip, STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { StatusDot } from "@/components/status-badge";
import { PaneActionsSheet } from "@/components/pane-actions-sheet";
import { useLongPress } from "@/hooks/use-long-press";
import { paneName } from "@/lib/pane-name";
import { paneOrdinals } from "@/lib/pane-ordinal";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { useRevealActive } from "@/hooks/use-reveal-active";

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
// (space › tab › pane).
//
// ── THIS ROW IS WHERE PANES ARE TOLD APART, AND THE TITLE IS NOT ─────────────
// The pane header above used to append the multiplexer's pane id suffix to its own name whenever it
// fell back to naming the tab, and every pill here printed that same suffix, on the argument that the
// two are read together and must not drift. The argument was sound and the string was wrong: `p3` is
// Herdr's coordinate for a pane, and Altan, who built this, read his own phone and said "idk what pN
// means". So the two surfaces now say different things on purpose. The TITLE names the tab, with
// nothing appended — a tab is what line 1 fell back to and a suffix does not make that sentence
// truer. THIS ROW tells the panes apart, because it is the row whose whole job that is, and it only
// speaks when it has to: a pill carries a small position number when another pill beside it would
// otherwise read identically (lib/pane-ordinal.ts), and nothing otherwise.
//
// Mobile deliberately doesn't replicate the desktop's pane tiling — a tab can
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
  const scrollerRef = useRef<HTMLDivElement>(null);
  useRevealActive(scrollerRef, currentPaneId);

  if (panes.length < 2) return null;

  // Which pills have a twin, worked out ONCE for the row: a pill cannot know on its own whether it
  // needs a number, because the answer is about its neighbours.
  const ordinals = paneOrdinals(panes);

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
        scrollerRef={scrollerRef}
      >
        {panes.map((p) => (
          <PanePill
            key={p.paneId}
            pane={p}
            active={p.paneId === currentPaneId}
            onSelect={onSelect}
            ordinal={ordinals.get(p.paneId)}
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
  ordinal,
  onSelect,
  onLongPress,
  onTapActive,
}: {
  pane: AgentView;
  active: boolean;
  /** This pane's 1-based place in the row, given only when a neighbour reads the same (pane-ordinal.ts). */
  ordinal?: number;
  onSelect: (paneId: string) => void;
  onLongPress?: () => void;
  /** A plain tap on the pill when it's already `active` — opens actions instead of a no-op re-select. */
  onTapActive?: () => void;
}) {
  const isShell = pane.kind === "shell";
  // The one name rule (lib/pane-name.ts) — the same string the dashboard row, the pane header and a
  // push all lead with. The icon still conveys which agent it is, and the place is NOT repeated
  // here: this strip is already inside the tab whose place the header above it states.
  const name = paneName(pane);
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
      // A numbered pill states its own name, because the number is a separate text node and the
      // accessible name computation would otherwise run the two together as "claude2". A pill with
      // nothing to disambiguate keeps its content as its name, unchanged.
      aria-label={ordinal === undefined ? undefined : `${name} ${ordinal}`}
      title={active && onTapActive ? t("home.sidebar.paneActionsTitle") : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native long-press gesture otherwise fires pointercancel and kills our hold timer.
        //
        // `rounded-md` (2px), not `rounded-full`: this pill carries a name and a tag, so it is far
        // wider than it is tall — a stadium, not a circle. Full-round is reserved for width ===
        // height.
        //
        // The border and the focus outline are `ui/chip.tsx`'s, copied rather than reinvented: this
        // pill is the space/tab chip one level down and the two must not answer state differently.
        // The border is transparent at rest and lives in the base string, so resting and active
        // occupy exactly the same box and only the paint changes. Focus is a separate channel and
        // sits OUTSIDE the box, so it can never move the row either.
        //
        // COMPACT: `py-0.5` (was `py-1.5`) and `text-[11px]` (was `text-sm`) draw a 24px pill, the
        // size of the header's path line just above it — Altan's ask, from the phone: this row and
        // the tab row above it "feel too tall and the fonts too large". The drawn box shrank; the
        // TAP FLOOR did not. `STRIP_TAP_TARGET`'s transparent `::before` still answers a real 44px
        // hit, because the reach it needs lives in `LabelledStrip`'s own scroller padding
        // (`ui/labelled-strip.tsx`), not in this pill's own box — so the pill draws smaller while the
        // thumb still finds the same target it always did.
        STRIP_TAP_TARGET,
        "flex min-w-11 shrink-0 select-none [-webkit-touch-callout:none] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 py-0.5 text-[11px] font-medium transition-colors active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
      )}
    >
      {isShell ? (
        <TerminalSquare className="size-3.5 shrink-0" />
      ) : (
        <StatusDot status={pane.status} live />
      )}
      <span>{name}</span>
      {/* The number is part of the pill's own text, not a decoration beside it: a screen reader
          hearing two pills called "claude" is in exactly the trouble the eye is. */}
      {ordinal !== undefined && (
        <span
          className={cn(
            "font-mono text-[10px]",
            active ? "text-primary-foreground/70" : "text-muted-foreground/60",
          )}
        >
          {ordinal}
        </span>
      )}
    </button>
  );
}
