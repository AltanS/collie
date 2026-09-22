import { useRef, useState, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";

import { STRIP_TAP_TARGET, TAB_ROW_SQUARE_TAP_TARGET } from "@/components/ui/labelled-strip";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { StatusDot } from "@/components/status-badge";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { useLongPress } from "@/hooks/use-long-press";
import { useRevealActive } from "@/hooks/use-reveal-active";
import { cn } from "@/lib/utils";
import { TRIAGE_STATUS, worstTriage, type TriageKey } from "@/lib/triage";
import { hostKey } from "@/lib/hosts";
import { tabCellTitle, type TabTitle } from "@/lib/pane-name";
import { statusLabel } from "@/lib/types";
import type { AgentView, TabView } from "@/lib/types";
import { useMuxCapability } from "@/lib/mux-capability";
import type { Scope } from "@/lib/scope";
import { t as translate } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface TabStripProps {
  workspaceId: string;
  tabs: TabView[];
  agents: AgentView[];
  /** The machine this space is on — tab ids collide across a crew, so status is counted per host. */
  host?: string;
  /** Selected tab id, or null for "All" (every tab's panes). */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  onNewTab: (workspaceId: string) => void;
  /** True while this Space's own "+" create is in flight — disables the button and swaps its icon
   *  for a spinner, so a second tap during the round trip is refused rather than silently ignored
   *  (the hook already ignores it; this is the feedback that stops the operator tapping twice). */
  creatingTab?: boolean;
  /** Show the leading "All" tab (home space view); off for the in-pane tab bar. */
  allowAll?: boolean;
  /** Session scope for the long-press tab actions (rename/close); undefined = primary. */
  scope?: Scope;
  /** Drop the long-press write actions when the device isn't authorised (the sheet shows a note). */
  readOnly?: boolean;
  /** Revalidate after a rename. Long-press tab actions turn on only when this AND onClosed are set. */
  onRenamed?: () => void;
  /** Refresh/fall back after a close. Enables long-press together with onRenamed. */
  onClosed?: (tabId: string) => void;
  /**
   * A control PINNED to the row's trailing end, outside the scroller — the pane screen's fold
   * chevron, and nothing else so far.
   *
   * It is a slot rather than a named prop because this row must not learn what the pane screen is
   * doing with it. Two things follow from "outside the scroller", and both are the point: it does
   * not scroll away with the tabs (a control you can lose by swiping is not an affordance), and it
   * costs no height at all: it is a 28px square centred in the 30px row, and its 44px reach hangs
   * DOWN out of the row the same way every tab's does (`TAB_ROW_SQUARE_TAP_TARGET`), so the control
   * adds no pixel the row was not already spending.
   *
   * The cost, stated: with a trailing control the last tab can no longer scroll clean off the screen
   * edge, because the edge now belongs to the control. That is the `-mx-4 px-4` trick below, and it
   * survives on the LEFT (the first tab still starts on the route's gutter) while the right half is
   * traded for the pin. Passing nothing leaves the row byte-identical to what it always was.
   */
  trailing?: ReactNode;
}

// The selected space's tabs, drawn as PLAIN CELLS on the composer's chrome ground — not the
// file-folder kind this row used to draw.
//
// The folder illusion is gone. It drew a full-width baseline rule under the whole row, bordered the
// active tab on three sides and covered the baseline under it with an absolutely-positioned strip so
// the tab and the content below read as one continuous piece. On a phone that geometry read as clutter
// rather than as a drawer: Altan, on the compact row this became, "the top tabs area has a lot of
// weird lines now" — and the call was not to tune the lines but to drop them. "Completely remove
// horizontal borders and just have vertical ones for tab items."
//
// So this row now draws NO horizontal rule of its own, top or bottom, on the `<nav>` or on the
// scroller inside it. It sits on the composer's own chrome ground (`bg-chrome`) rather than on a
// ground of its own, the same fill the header above and the input row below both stand on, so the
// row reads as part of that block rather than as a bordered strip laid over it. A HEADER above this
// row keeps its own bottom rule where one exists; that boundary belongs to the header, not to this
// component, and is unaffected by anything here.
//
// THIS ROW DRAWS NO HAIRLINE AT ALL, NOT EVEN A VERTICAL ONE. The vertical `divide-x divide-border`
// between adjacent tabs is gone: Altan, on the phone, past the horizontal-rule fix above, "the
// border left is weird, I'd prefer a full border on the item" — a `divide-x` seam sits on ONE side
// of whichever tab happens to be next to it, which reads as a stray border stuck to that tab's edge
// rather than as a boundary between two. A group with nothing dividing it needs a real gap instead,
// so adjacent inactive tabs (both plain, both on the row's own ground) stay legible as separate
// cells. The gap is now 12px of visible air between two labels, bought as each tab's own `px-1.5`
// rather than as a flex `gap`, so the hit boxes of two neighbours touch instead of leaving a 12px
// dead strip between them.
//
// THE OPEN TAB IS MARKED BY INK AND WEIGHT, AND BY NOTHING ELSE (option 3 of the 2026-09-23 top-bar
// deck). It has been an inverted pill, then a 2px underline in full ink; both cost height, and the
// underline with its padding made this row 44px of a phone screen for one line of 11px type. Altan
// picked the variant with no mark at all: the open tab is `text-foreground font-semibold`, every
// other tab `text-muted-foreground font-medium`, and no cell draws a fill, a border, a bar or a
// radius. The row is 30px, the tab's own drawn height. The weight change would re-flow the row on a
// selection (a semibold label is wider), so every label reserves its semibold width with an
// invisible copy of itself (`StableLabel` below): the row keeps one width per tab in both states.
// The dashed desktop-focus ring is still gone (see the cell's own comment on why).
//
// A CELL NAMES WHAT THE HEADER NAMES (lib/pane-name.ts § tabCellTitle). A one-pane tab reads its
// pane's name — `plumbing`, the same word the pane header shows — not the tab's own label, so the
// open cell and the header agree. The tab label stays for a tab that is a real group. And no brand
// tile: the header already carries the agent's mark once, and a tile on every cell repeated it four
// times across the row, which is what made the belt read as a list of agents rather than as a row of
// tabs. The status dot stays; it is the one fact the eye scans the whole row for.
//
// This row draws no name. The shape announces itself — that is the operator's reason for choosing
// it — so `LabelledStrip` is gone from here and the structure it provided lives inline: the <nav>,
// the accessible name (now an `aria-label`, since there is no visible word to point at), and the
// `-mx-4 px-4` that lets the last tab scroll clean off the screen while the first still starts on
// the route's 16px gutter. Spaces and Panes keep the primitive and keep their labels.
export function TabStrip({
  workspaceId,
  tabs,
  agents,
  host,
  selected,
  onSelect,
  onNewTab,
  creatingTab = false,
  allowAll = true,
  scope,
  readOnly,
  onRenamed,
  onClosed,
  trailing,
}: TabStripProps) {
  useLocale();
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  // Asked of the machine these tabs live on (M22/03); absent scope is the lead, as everywhere.
  const newTab = useMuxCapability("createTab", scope);
  // Actions need both callbacks wired (revalidate on rename, fall back on close); without them the
  // tabs stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Keyed on `selected` (not `workspaceId`): a many-tab strip must reveal the active tab on mount
  // AND every time the operator switches tabs, and `selected` is the value that changes on a switch.
  useRevealActive(scrollerRef, selected);

  // Tab status is computed over THIS machine's panes only: tab ids (`w1:t1`) collide across a crew
  // exactly as pane and workspace ids do, so an unfiltered merged list would paint a peer's blocked
  // agent onto the lead's tab. Solo panes are untagged and `host` is undefined — same set as before.
  const here = agents.filter((a) => hostKey(a) === (host ?? ""));
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);
  if (wsTabs.length === 0) return null;

  return (
    <>
      <nav
        // The row's accessible name, which used to come from the visible word via aria-labelledby.
        // The word is gone; the name is not. A row of buttons with no name is an unnamed run of
        // buttons to a screen reader, which is the fault LabelledStrip was written to fix.
        aria-label={translate("space.tabStrip.title")}
        // shrink-0: this is a child of a `flex-1 flex-col` scroller, so without it the row shrinks
        // while its tabs overflow and the row below paints over them.
        // bg-chrome: the row's own ground — see the header comment above for why this replaces the
        // baseline rule the folder shape used to draw. No border-t and no border-b: this row draws no
        // horizontal rule of its own, and a header above it keeps whatever rule it already had.
        // `flex items-stretch` only when something is pinned to the trailing end; otherwise a
        // `flow-root` block. Either one stops the scroller's `-mb-3.5` from collapsing through the
        // <nav>'s own bottom edge, which would leave the <nav> (and its chrome ground) 44px tall
        // while the row below it moved up 14px to overlap.
        className={cn("shrink-0 bg-chrome px-4", trailing ? "flex items-stretch" : "flow-root")}
      >
        <div
          ref={scrollerRef}
          // -mx-4 px-4: the gutter moves onto the scroller and is cancelled by the negative margin,
          // so the last tab scrolls clean off the screen edge while the first still starts on the
          // route's 16px gutter. The two halves are ONE number and must move together.
          //
          // pb-3.5 -mb-3.5: THE TAP FLOOR HANGS BELOW THE ROW, and this pair is what lets it. The
          // row draws 30px, and a 44px hit needs 14px more. It cannot go UP: the route's own
          // content scroller starts at the header's bottom edge and clips anything above it, and
          // the header is a sticky `z-20` bar with 44px buttons of its own. So the whole 14px goes
          // down, and a reach off a drawn box is clipped the instant the clip box (this scroller's
          // padding box, `overflow-x: auto` clips BOTH axes, see STRIP_TAP_TARGET) does not extend
          // into it. `pb-3.5` extends the clip box 14px; `-mb-3.5` takes the same 14px back out of
          // the layout, so the <nav> still measures 30px and the scroller's lower 14px lies over
          // whatever comes next. Only a tab's `::before` answers a tap there, and only because it
          // carries `before:z-[1]`: the scroller itself is a plain block and loses to what lies
          // under it, so the blank stretch between and beside the tabs stays the page's. The two
          // halves are ONE number, like the gutter pair, and the tab's `before:-bottom-3.5` is the
          // same number a third time.
          //
          // What comes next decides what the reach takes. On a one-pane tab it is the 4px page gap
          // and then the terminal mirror, which is `relative` and later in the tree and would win
          // a tap without the `z-[1]`. With it the tab measures 44, and the price is stated: under
          // each tab the mirror's top 10px stop answering a tap, a long-press or the start of a
          // drag. On the space route the same 14px lie over the top of the space's list.
          //
          // Under a pane row the pane row wins instead: it is `relative z-[2]` (`pane-strip.tsx`),
          // so it owns its whole 26px, gaps included, and the boundary lands on the rows' shared
          // edge. The tab measures its own 30px there. Two stacked 44px targets need 88px of
          // pitch and the two rows are 56, so one of them has to give, and it is the tab, whose
          // row is the taller one.
          className={cn(
            "flex items-center gap-3 overflow-x-auto pb-3.5 -mb-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            // With a pinned control the right half of the edge-to-edge trick is spent on it: the
            // scroller becomes the flex row's growing child, keeps the LEFT gutter cancellation so
            // the first tab still starts on the route's 16px, and stops at the control instead of at
            // the screen. `min-w-0` is what lets it actually shrink rather than push the control off.
            trailing ? "-ml-4 min-w-0 flex-1 pl-4 pr-3" : "-mx-4 px-4",
          )}
        >
          {/* THE TAB GROUP: every tab cell, separated by air rather than a hairline, no `divide-x`
              any more (the header comment above says why). The air is each tab's own `px-1.5`, so
              the group itself has no gap, and `-mx-1.5` pulls the first LABEL back onto the route's
              16px gutter that the first tab's padding would otherwise push it off. It is its own flex
              child of the scroller so the "+" button, a sibling outside this group, keeps the
              scroller's own `gap-3` from the group: the "+" reaches 8px sideways, and 12px of gap
              keeps that reach off the last tab. */}
          <div className="-mx-1.5 flex shrink-0 items-stretch">
            {allowAll && (
              <Tab
                label={translate("space.tabStrip.all")}
                active={selected === null}
                onClick={() => onSelect(null)}
              />
            )}
            {wsTabs.map((t) => {
              const inTab = here.filter((a) => a.tabId === t.tabId);
              return (
              <Tab
                key={t.tabId}
                label={t.label}
                title={tabCellTitle(t.label, inTab)}
                active={selected === t.tabId}
                // What's actually going on in there — blocked / ready / working / idle — instead of a
                // dot that only ever appeared for blocked and left every other state unreadable.
                status={worstTriage(inTab)}
                onClick={() => onSelect(t.tabId)}
                // Long-press (and a tap on the already-active tab) opens the actions sheet — only when
                // the parent wired the actions; otherwise the tabs stay plain tap-to-switch.
                onLongPress={actionsEnabled ? () => setSheetTab(t) : undefined}
                onTapActive={actionsEnabled ? () => setSheetTab(t) : undefined}
              />
              );
            })}
          </div>
          {/* HIDE, don't explain (M10/06). A "+" at the end of the tab row is an affordance, not a
              promise: nobody arrives at Collie needing to know why a particular multiplexer will not
              open a tab, the way they arrive needing to know where their agent's history went. Every
              adapter shipped today declares `createTab`, so this hides on none of them — it asks
              anyway, because the alternative is a fourth adapter discovering the answer by 500ing. */}
          {newTab.capable && (
            <button
              type="button"
              onClick={() => onNewTab(workspaceId)}
              disabled={creatingTab}
              aria-label={translate("space.tabStrip.new.aria")}
              aria-busy={creatingTab}
              // 28px drawn, 44x44 hit, a true square, which is the one shape allowed to keep
              // `rounded-full`. 28 and not the old 32 because the row is 30 now: the circle must sit
              // inside it. The hit is TAB_ROW_SQUARE_TAP_TARGET's: from the row's top edge down to
              // the tabs' own 44px line, and 8px out on each side, where it is last in the row and
              // the scroller's 12px gap keeps it clear of the last tab.
              className={cn(
                TAB_ROW_SQUARE_TAP_TARGET,
                "flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
              )}
            >
              {/* Same box, same icon size, swapped in place — the button never resizes between its
                  idle and busy shapes (DESIGN.md's no-shift rule). */}
              {creatingTab ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="size-4" />
              )}
            </button>
          )}
        </div>
        {/* The pinned slot. `self-center`: whatever stands here is a control beside the tabs, not a
            tab, so it centres in the 30px row. It sits outside the scroller, so nothing clips its
            reach; the caller gives it TAB_ROW_SQUARE_TAP_TARGET so it answers the same 44px the
            "+" does. */}
        {trailing !== undefined && (
          <div className="flex shrink-0 self-center pl-1.5">{trailing}</div>
        )}
      </nav>

      {actionsEnabled && (
        <TabActionsSheet
          open={sheetTab !== null}
          onClose={() => setSheetTab(null)}
          tab={sheetTab}
          scope={scope}
          readOnly={readOnly}
          onRenamed={onRenamed}
          onClosed={onClosed}
        />
      )}
    </>
  );
}

interface TabProps {
  /** The tab's raw label — the spoken fallback when the cell has no title to draw. */
  label: string;
  /** What the cell says ({@link tabCellTitle}); the "All" cell passes its word as a plain title. */
  title?: TabTitle | null;
  active: boolean;
  /**
   * The most urgent thing happening inside this tab ({@link worstTriage}) — drawn as a leading dot
   * in the same palette the herd list uses. Omit (or pass null) when the tab holds no agent at all:
   * that's not the same as idle, and a resting dot would claim otherwise.
   */
  status?: TriageKey | null;
  onClick: () => void;
  /** Long-press (or right-click / Android contextmenu) opens actions. Inert when unset. */
  onLongPress?: () => void;
  /** A plain tap when the tab is already `active` — opens actions instead of a no-op re-select. */
  onTapActive?: () => void;
}

// One plain tab cell.
function Tab({
  label,
  title: titleProp,
  active,
  status,
  onClick,
  onLongPress,
  onTapActive,
}: TabProps) {
  const longPress = useLongPress(onLongPress);
  // A cell given no title (the "All" cell) says its label, plainly.
  const title: TabTitle | null = titleProp === undefined ? { text: label, positional: false } : titleProp;
  // The title is decided by the caller (lib/pane-name.ts § tabCellTitle): a one-pane tab's pane
  // name, else the tab's own name, else its POSITION in the lighter ink — `tab 2`, the same words
  // every other surface gives a tab the multiplexer only numbered. Only a tab with no label at all
  // (no name, no digit) falls to the dot: it keeps its status dot, the one fact about it that is
  // real. The label is still the button's accessible name then, because a screen reader has no row
  // to look at and a word beats a glyph it cannot speak.

  // A long-press already suppresses the ensuing click (via longPress.onClickCapture), so this only
  // ever sees a genuine tap. Tapping the already-active tab opens actions rather than a dead
  // re-select.
  function handleClick() {
    if (active && onTapActive) {
      onTapActive();
      return;
    }
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      {...longPress}
      // Not role="tab". These do not swap a panel in place — they navigate: on the space route the
      // selection is the route's own tab filter, and in the pane view a tap goes to another pane's
      // URL. `role="tablist"` would promise arrow-key roving over panels that are not there and
      // would fight the surrounding <nav>. A nav with aria-current is what this actually is, and it
      // is what the space and pane strips already say.
      aria-current={active ? "true" : undefined}
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch
        // callout, whose native long-press gesture otherwise fires pointercancel and kills the hold
        // timer.
        //
        // NO BOX AT ALL, IN EITHER STATE. No border, no fill, no radius, no underline: the open tab
        // differs from the rest only by ink and weight (the header comment above has the history).
        // So there is no border-box to reserve and no C1 trick to keep; the one thing a selection
        // could still move is the label's WIDTH, because semibold is wider than medium, and
        // `StableLabel` below holds that still.
        //
        // COMPACT: `h-7.5` draws a 30px tab, the row's whole height, and `text-[11px]` the size of
        // the header's path line. The tap floor is not in this box. `before:top-0 before:-bottom-3.5`
        // overrides STRIP_TAP_TARGET's symmetric 7px: the reach cannot go up (the scroller's comment
        // says why), so it takes the whole 14px downward, 30+14 = 44, into the scroller's own
        // `pb-3.5` clip room. The tab has no border, so the inset resolves against the drawn edge and
        // needs no extra pixel the way a bordered pill's does. `before:z-[1]` lets the reach win over
        // the mirror below (the scroller's comment says what that costs).
        STRIP_TAP_TARGET,
        "relative flex h-7.5 min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap px-1.5 text-[11px] transition-colors before:top-0 before:-bottom-3.5 before:z-[1] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
        // INK AND WEIGHT ARE THE ONLY MARK. Full ink and semibold for the open tab; the muted ink
        // and medium weight for every other, with the full ink as the hover answer on a device that
        // has one.
        active
          ? "font-semibold text-foreground"
          : "font-medium text-muted-foreground hover:text-foreground",
        // NO DESKTOP-FOCUS RING. `TabView.focused` (the tab the desktop TUI is looking at) used to
        // paint a dashed outline on its cell. On the phone that read as a second selection beside the
        // solid pill, and the phone's reader does not care where the desktop is looking. It is gone;
        // the open tab's border is the only box any cell draws.
      )}
    >
      {status === "ready" && <UnseenMark size="sm" />}
      {status && status !== "ready" && (
        <>
          {/* A hollow resting dot is filled with the surface it sits ON, and every tab, open or
              not, sits on the row's bare chrome ground: no cell draws a fill of its own. */}
          <StatusDot
            status={TRIAGE_STATUS[status]}
            surface="bg-chrome"
            className="size-1.5"
          />
          {/* The dot is colour-only; say it in words for screen readers. */}
          <span className="sr-only">{statusLabel(TRIAGE_STATUS[status])}</span>
        </>
      )}
      {title === null ? (
        <>
          {/* `bg-current`, so the dot takes the tab's own text colour in both states and nothing has
              to be themed twice. 4px, the smallest mark the row already uses. Only an EMPTY label
              falls here now — a numbered one reads its position instead, below. */}
          <span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-current opacity-50" />
          <span className="sr-only">{label}</span>
        </>
      ) : title.positional ? (
        // The tab's position, a step lighter than a name someone chose so it never reads as one:
        // an inactive position is a step lighter than an inactive name. The
        // open one takes the full ink like any open tab, because ink is half of the only mark.
        <StableLabel className={active ? undefined : "text-muted-foreground/70"}>{title.text}</StableLabel>
      ) : (
        <StableLabel>{title.text}</StableLabel>
      )}
    </button>
  );
}

// A label that is as wide in medium as in semibold, so opening a tab never re-flows the row (Rule
// E). Two copies share one grid cell: the invisible one is always semibold and sets the cell's
// width, the visible one takes the tab's own weight and is centred over it. The copy is
// `aria-hidden`, so the button's accessible name is the label once, not twice.
function StableLabel({ children, className }: { children: string; className?: string }) {
  return (
    <span className={cn("grid justify-items-center", className)}>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-semibold">
        {children}
      </span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  );
}
