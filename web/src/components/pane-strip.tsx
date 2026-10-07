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
  /** A saved copy is on screen: the long-press sheet shows a note in place of rename and close. */
  savedCopy?: boolean;
  /** Revalidate after a rename. Long-press pane actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Navigate/refresh after a close (Home if it's the open pane). Enables long-press with onRenamed. */
  onClosed?: (paneId: string) => void;
  /** Every pane of the herd, for the sheet's Pin to top row (lib/pins.ts reads it on a pin). */
  herd?: readonly AgentView[];
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
// A long-press on a pill opens its actions sheet (pin / rename / close) when the parent wires the
// actions.
export function PaneStrip({
  panes,
  currentPaneId,
  onSelect,
  scope,
  readOnly,
  savedCopy,
  onRenamed,
  onClosed,
  herd,
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
      {/* THIS ROW SHARES THE TAB BAR'S OWN GROUND, `bg-chrome` — it used to draw none of its own,
          riding on the tab bar's active cell being filled with the same surface as the content below
          it (a "folder tab", where the open tab's box visually continued into this row). That folder
          shape is gone (`tab-strip.tsx`'s header): the open tab draws no box at all now, let alone
          one spanning down to here, so a `<nav>` with no ground of its own fell through to the page's
          ambient background instead — `--background`, which in dark IS the terminal mirror's own
          fill (measured #0A0A0A against the tab bar's #171717), so this row read as a BLACK GAP
          between the tab bar and the mirror's top rule below it. Altan, from the phone, on the
          composite: "there's a weird black gap followed by a horizontal line." The gap was this row;
          the line was already correct (see below) and stays.
          `bg-chrome` closes that gap by matching the tab bar exactly, so the two rows read as one
          continuous band with the pills sitting inside it — no rule between them (a rule would double
          against the tab bar's own lack of one), no tint of their own, and the ONE rule that survives
          is the mirror's own top edge below both rows, which `agent-chat.tsx` draws unconditionally
          and by design (DESIGN.md §2 — that rule belongs to the content region, not to either strip,
          and stays).

          THE ROW IS 26px: the 24px pill and 1px of air above and below it (option 3 of the
          2026-09-23 top-bar deck). It used to wear LabelledStrip's shared `py-1.5`, 36px.

          THE HIT BOX IS THE ROW, AND NOTHING BELOW IT. For a while the pill's reach hung 18px
          under the row (`pb-[18px] -mb-[18px]` here, `before:-bottom-5` on the pill, a `z-[2]`
          track to win over the tab row's own overhang) to make 44px of touch. That 18px lay over
          the first lines of the chat or terminal and took the tap off a file-path link standing
          there (measured 2026-10-07 on the tab row, same recipe: `elementFromPoint` over a link
          1px under the strip returned the strip's button for 13 of the link's 20px). A content link
          must win every tap inside the content area, so the pill answers its 26px row and 44px
          across (`min-w-11`), above WCAG 2.5.8's 24px. Nothing may reach up either: above this row
          is the tab row, whose tabs own every pixel of it, and the two hit boxes meet on their
          shared edge and never overlap. The scroller keeps `py-0`, so no half of LabelledStrip's
          shared `py-1.5` survives the override. It takes touches itself (no `pointer-events-none`
          anywhere in it), because iOS Safari does not scroll a `pointer-events: none` scroller from
          a `pointer-events: auto` child (https://bugs.webkit.org/show_bug.cgi?id=183870). */}
      <LabelledStrip
        label={t("space.paneStrip.title")}
        className="flow-root bg-chrome"
        scrollerClassName="px-0 py-0"
        scrollerRef={scrollerRef}
      >
        {/* `px-4` moves the gutter from the scroller onto the track, so the track covers the
            gutters too and the scroll width keeps both of them. */}
        <div className="flex w-max min-w-full shrink-0 items-center gap-2 px-4 py-px">
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
        </div>
      </LabelledStrip>

      {actionsEnabled && (
        <PaneActionsSheet
          open={sheetPane !== null}
          onClose={() => setSheetPane(null)}
          pane={sheetPane}
          scope={scope}
          readOnly={readOnly}
          savedCopy={savedCopy}
          onRenamed={onRenamed}
          onClosed={onClosed}
          herd={herd}
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
        // COMPACT: `h-6` and `text-[11px]` draw a 24px pill, the size of the header's path line
        // above it. `h-6` rather than vertical padding, because the row is built to exactly 24px
        // plus 1px either side and a padding-sized pill came out at 22.5.
        //
        // THE HIT BOX ENDS ON THE ROW'S EDGES. `before:-inset-y-[2px]` overrides STRIP_TAP_TARGET's
        // symmetric 7px: an inset resolves against the padding box, 1px inside the border, so `-2px`
        // puts the reach on the row's top and bottom edge (1px of air + the 24px pill + 1px), 26px
        // tall, and no further: below the row lies the content, and a link there must win the tap
        // (see the row's comment in PaneStrip above).
        STRIP_TAP_TARGET,
        "flex h-6 min-w-11 shrink-0 select-none [-webkit-touch-callout:none] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 text-[11px] font-medium transition-colors before:-inset-y-[2px] active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
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
