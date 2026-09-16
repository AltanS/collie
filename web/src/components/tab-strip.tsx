import { useRef, useState, type ReactNode } from "react";
import { Loader2, Plus } from "lucide-react";

import { STRIP_TAP_TARGET, STRIP_TAP_TARGET_SQUARE } from "@/components/ui/labelled-strip";
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
   * costs no height at all — the row already spends the padding a 44px tap target needs (see the
   * `h-8` tab's own comment below for where that padding lives), so the control centres in space
   * the row was reaching into anyway.
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
// cells — `gap-1`, the row's own external gap, so the group reads as one spacing rule rather than
// two.
//
// THE OPEN TAB IS AN INVERTED PILL — its own `rounded-md` box, filled `bg-primary` with
// `text-primary-foreground`, the same paint the open pane pill in the row below has always used.
// It was an outlined pill (`border-border` on `bg-background`) and on the phone that read too close
// to its neighbours: Altan, "active tab needs to be clearer, panes are inverted and white". One
// mark for "open" across both rows now. `my-px`: the box must sit fully INSIDE the row rather
// than touch its top or bottom edge, so it reads as a pill floating in the 32px row rather than as
// a box that clips against the row's own bounds — 1px in on both sides is enough for the 1px border
// to paint whole. An inactive tab stays exactly as before: plain on the row's bare chrome ground, no
// fill, no border, no radius, so only the open tab ever draws a box at all. There is no folder shape
// to reserve room for, so nothing here needs the no-shift border-reservation trick the old shape
// needed. The dashed desktop-focus ring that used to paint on top is gone too (see the cell's own
// comment on why), so the open tab's border is the only box any cell ever draws.
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
        // `flex items-stretch` only when something is pinned to the trailing end — otherwise the
        // <nav> stays the plain block it has always been, so a row with no `trailing` is unchanged.
        className={cn("shrink-0 bg-chrome px-4", trailing && "flex items-stretch")}
      >
        <div
          ref={scrollerRef}
          // -mx-4 px-4: the gutter moves onto the scroller and is cancelled by the negative margin,
          // so the last tab scrolls clean off the screen edge while the first still starts on the
          // route's 16px gutter. The two halves are ONE number and must move together.
          // pt-1.5 pb-1.5: the room the compact tab's own STRIP_TAP_TARGET reach needs, the same
          // recipe STRIP_SCROLLER states — a `-inset-y-[7px]` reach off a drawn box gets clipped the
          // instant the clip box (this scroller's padding box) does not extend into it, so the tap
          // floor has to be bought with real padding, not just the pseudo-element. items-start keeps
          // every tab's TOP on the same line, which is what makes the row read as tabs rather than as
          // boxes of different sizes.
          className={cn(
            "flex items-start gap-1 overflow-x-auto pt-1.5 pb-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            // With a pinned control the right half of the edge-to-edge trick is spent on it: the
            // scroller becomes the flex row's growing child, keeps the LEFT gutter cancellation so
            // the first tab still starts on the route's 16px, and stops at the control instead of at
            // the screen. `min-w-0` is what lets it actually shrink rather than push the control off.
            trailing ? "-ml-4 min-w-0 flex-1 pl-4 pr-2" : "-mx-4 px-4",
          )}
        >
          {/* THE TAB GROUP: every tab cell, separated by a plain GAP rather than a hairline — no
              `divide-x` any more (the header comment above says why). It is its own flex child of the
              scroller (not the scroller's own `gap-1`) so the "+" button, a sibling outside this
              group, keeps its own gap from the group rather than inheriting the tabs' tighter one; the
              two numbers happen to match today (both `gap-1`) but are two declarations on purpose, so
              a future change to one never silently moves the other. `items-stretch` so the open tab's
              border-box runs the tab's full drawn height. */}
          <div className="flex shrink-0 items-stretch gap-1">
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
              // 32px drawn, 44x46 hit — a true square, which is the one shape allowed to keep
              // `rounded-full`. self-center against the row's items-start: it is a button beside the
              // tabs, not a tab, so it centres in the row rather than hanging from the top line.
              // The row is 44px, so the ::before's 7px reach is trimmed to the 6px above a centred
              // 32px box: 32+6+6 = 44 vertically, 32+7+7 = 46 horizontally, where it is last in the
              // row and the gap keeps it clear of its neighbour.
              className={cn(
                STRIP_TAP_TARGET_SQUARE,
                "flex size-8 shrink-0 self-center items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
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
        {/* The pinned slot. `self-center` for the same reason the "+" takes it: whatever stands here
            is a control beside the tabs, not a tab, so it centres in the row rather than hanging
            from the top line. */}
        {trailing !== undefined && (
          <div className="flex shrink-0 self-center pl-1">{trailing}</div>
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
        // THE OPEN TAB IS AN OUTLINED PILL; AN INACTIVE ONE IS A PLAIN RECTANGLE. Both carry the
        // SAME border-box, always — `border` + `rounded-md` + `my-px` are unconditional, and only
        // the border's COLOUR and the fill flip with `active`. That is the C1 recipe
        // (`ui/labelled-strip.tsx`'s header): a border reserved as transparent at rest costs the box
        // nothing, so selecting a tab can never re-flow its neighbours (Rule E) the way a border that
        // only APPEARS on selection would. `my-px` insets the box 1px off the row's top and bottom —
        // needed so the open tab's border paints whole rather than clipping against the 32px row's
        // own edges, and applied to every tab (not only the open one) so the row's height never
        // shifts by those 2px when a tab is opened or closed. `font-medium` stays unconditional for
        // the same reason: bolding only the active label would re-flow every tab to its right.
        //
        // COMPACT: `h-8` draws a 32px tab, `text-[11px]` the size of the header's path line — Altan's
        // ask, from the phone: this row "feel[s] too tall and the fonts too large". A tab used to BE
        // a real 44px tap target, drawn at that height; now it draws small and answers 44px the way
        // every other strip pill does, through `STRIP_TAP_TARGET`'s transparent `::before` — the
        // reach it needs lives in the scroller's own `pt-1.5 pb-1.5` (see the scroller's comment
        // above), not in this box, so the drawn tab can shrink without the thumb losing anything.
        STRIP_TAP_TARGET,
        "relative flex h-8 min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap border-b-2 px-3 text-[11px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        // GROUND IS THE ONLY MARK. The open tab is inverted, `bg-primary` under `text-primary-
        // foreground`, the pane pill's own "open" paint; every other tab sits on the row's bare chrome
        // ground, draws no fill and keeps its reserved border transparent — a quiet hover wash is the
        // one concession, so a tap target still answers a finger hovering over it on a device that
        // has one. The border stays in the box on both (`border-primary` under the fill, so it never
        // draws a seam of its own) for the no-shift rule.
        // THE OPEN TAB IS UNDERLINED (2026-09-16). The inverted pill read "too white" on the phone and
        // left the other tabs hard to spot beside it. Now every tab reads in near-full ink, and the
        // open one takes a 2px bar under its label in full ink; the bar is reserved transparent on
        // every tab, so opening one never shifts a neighbour.
        active
          ? "border-foreground text-foreground"
          : "border-transparent text-foreground/70 hover:bg-muted/40",
        // NO DESKTOP-FOCUS RING. `TabView.focused` (the tab the desktop TUI is looking at) used to
        // paint a dashed outline on its cell. On the phone that read as a second selection beside the
        // solid pill, and the phone's reader does not care where the desktop is looking. It is gone;
        // the open tab's border is the only box any cell draws.
      )}
    >
      {status === "ready" && <UnseenMark size="sm" />}
      {status && status !== "ready" && (
        <>
          {/* A hollow resting dot is filled with the surface it sits ON, and the two states of this
              tab are two different surfaces: the open tab's own bg-primary, or the row's bare chrome
              ground everywhere else. */}
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
        // The tab's position, a shade lighter than a name someone chose, so it never reads as one.
        // On the inverted open tab the lighter shade is of the inverted ink.
        <span className="text-muted-foreground">
          {title.text}
        </span>
      ) : (
        title.text
      )}
    </button>
  );
}
