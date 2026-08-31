import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { STRIP_TAP_TARGET_SQUARE } from "@/components/ui/labelled-strip";
import { TabActionsSheet } from "@/components/tab-actions-sheet";
import { StatusDot } from "@/components/status-badge";
import { useLongPress } from "@/hooks/use-long-press";
import { cn } from "@/lib/utils";
import { TRIAGE_STATUS, worstTriage, type TriageKey } from "@/lib/triage";
import { hostKey } from "@/lib/hosts";
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
  /** The machine this space is on — tab ids collide across a pack, so status is counted per host. */
  host?: string;
  /** Selected tab id, or null for "All" (every tab's panes). */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  onNewTab: (workspaceId: string) => void;
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
   * costs no height at all — the row is already `h-11`, which is a real 44px target, so the control
   * centres in space the row was spending anyway.
   *
   * The cost, stated: with a trailing control the last tab can no longer scroll clean off the screen
   * edge, because the edge now belongs to the control. That is the `-mx-4 px-4` trick below, and it
   * survives on the LEFT (the first tab still starts on the route's gutter) while the right half is
   * traded for the pin. Passing nothing leaves the row byte-identical to what it always was.
   */
  trailing?: ReactNode;
}

// The selected space's tabs, drawn as TABS — the file-folder kind, not the pill kind.
//
// The two rows around this one (Spaces above, Panes below) are pills, and that difference is doing
// work: rows that navigate different dimensions should not look identical. A pill row says "pick one
// of these"; a folder tab says "this one is the drawer you are looking into", because the active tab
// is physically attached to the content beneath it.
//
// The illusion is three things, and all three have to be right or it reads as a button on a line:
//
//  1. A full-width baseline rule in --rule at the bottom of the row. It is the top edge of the
//     content region below, which is why it belongs to this row and not to that region.
//  2. The active tab is bordered on top/left/right in the SAME --rule, filled with the content
//     surface, and OPEN at the bottom — it covers the baseline for its own width, so the tab and
//     the content read as one continuous piece.
//  3. Inactive tabs are recessed: a quieter fill, muted text, and their box stops one pixel short,
//     so the baseline runs unbroken underneath them.
//
// The geometry that buys (2) is measured, not guessed, and the three numbers below are one set:
// the scroller is pulled one pixel down over the <nav>'s bottom border (`-mb-px`), carries one pixel
// of bottom padding so that pixel is INSIDE its clip box (`overflow-x` forces `overflow-y: auto`,
// so anything past the padding box is clipped away), and the active tab covers it with a 1px
// absolutely-positioned strip in the content colour. Change any one and the baseline shows through
// under the active tab, which is the whole thing.
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
  allowAll = true,
  scope,
  readOnly,
  onRenamed,
  onClosed,
  trailing,
}: TabStripProps) {
  useLocale();
  const [sheetTab, setSheetTab] = useState<TabView | null>(null);
  const newTab = useMuxCapability("createTab");
  // Actions need both callbacks wired (revalidate on rename, fall back on close); without them the
  // tabs stay plain tap-to-switch — long-press is inert.
  const actionsEnabled = !!onRenamed && !!onClosed;

  // Tab status is computed over THIS machine's panes only: tab ids (`w1:t1`) collide across a pack
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
        // No border-t: SpaceStrip now draws its own border-b, which already closes the seam from
        // above. A second hairline here would sit on the same line as that one and double it.
        // border-b is the BASELINE — see the header comment; it is --rule because it cuts between
        // two regions of chrome rather than around one component.
        // `flex items-stretch` only when something is pinned to the trailing end — otherwise the
        // <nav> stays the plain block it has always been, so a row with no `trailing` is unchanged.
        className={cn("shrink-0 border-b border-rule px-4", trailing && "flex items-stretch")}
      >
        <div
          // -mx-4 px-4: the gutter moves onto the scroller and is cancelled by the negative margin,
          // so the last tab scrolls clean off the screen edge while the first still starts on the
          // route's 16px gutter. The two halves are ONE number and must move together.
          // -mb-px + pb-px: one pixel of the scroller hangs over the <nav>'s bottom border, and that
          // pixel is inside the scroller's own padding box so it is not clipped. It is the room the
          // active tab's cover strip lives in. items-start keeps every tab's TOP on the same line,
          // which is what makes the row read as tabs rather than as boxes of different sizes.
          className={cn(
            "-mb-px flex items-start gap-1 overflow-x-auto pb-px [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            // With a pinned control the right half of the edge-to-edge trick is spent on it: the
            // scroller becomes the flex row's growing child, keeps the LEFT gutter cancellation so
            // the first tab still starts on the route's 16px, and stops at the control instead of at
            // the screen. `min-w-0` is what lets it actually shrink rather than push the control off.
            trailing ? "-ml-4 min-w-0 flex-1 pl-4 pr-2" : "-mx-4 px-4",
          )}
        >
          {allowAll && (
            <Tab
              label={translate("space.tabStrip.all")}
              active={selected === null}
              onClick={() => onSelect(null)}
            />
          )}
          {wsTabs.map((t) => (
            <Tab
              key={t.tabId}
              label={t.label}
              active={selected === t.tabId}
              ring={t.focused}
              // What's actually going on in there — blocked / ready / working / idle — instead of a
              // dot that only ever appeared for blocked and left every other state unreadable.
              status={worstTriage(here.filter((a) => a.tabId === t.tabId))}
              // WHICH agent is in there. The pane header names ONE agent, and a tab is exactly the
              // dimension along which that answer changes: `docs` may be Claude and `shell` a bare
              // terminal, and switching between them used to change the header's mark with no warning
              // in the row you switched from. Named here, the answer is in the row you choose.
              agent={soleAgent(here, t.tabId)}
              onClick={() => onSelect(t.tabId)}
              // Long-press (and a tap on the already-active tab) opens the actions sheet — only when
              // the parent wired the actions; otherwise the tabs stay plain tap-to-switch.
              onLongPress={actionsEnabled ? () => setSheetTab(t) : undefined}
              onTapActive={actionsEnabled ? () => setSheetTab(t) : undefined}
            />
          ))}
          {/* HIDE, don't explain (M10/06). A "+" at the end of the tab row is an affordance, not a
              promise: nobody arrives at Collie needing to know why a particular multiplexer will not
              open a tab, the way they arrive needing to know where their agent's history went. Every
              adapter shipped today declares `createTab`, so this hides on none of them — it asks
              anyway, because the alternative is a fourth adapter discovering the answer by 500ing. */}
          {newTab.capable && (
            <button
              type="button"
              onClick={() => onNewTab(workspaceId)}
              aria-label={translate("space.tabStrip.new.aria")}
              // 32px drawn, 44x46 hit — a true square, which is the one shape allowed to keep
              // `rounded-full`. self-center against the row's items-start: it is a button beside the
              // tabs, not a tab, so it centres in the row rather than hanging from the top line.
              // The row is 44px, so the ::before's 7px reach is trimmed to the 6px above a centred
              // 32px box: 32+6+6 = 44 vertically, 32+7+7 = 46 horizontally, where it is last in the
              // row and the gap keeps it clear of its neighbour.
              className={cn(
                STRIP_TAP_TARGET_SQUARE,
                "flex size-8 shrink-0 self-center items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95",
              )}
            >
              <Plus className="size-4" />
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

// The ONE agent a tab runs, or undefined. Undefined is the honest answer in two different cases and
// both must stay unmarked: a tab with no agent at all (a bare shell), and a tab running two brands at
// once — a mark for either would be a claim about the whole tab that only one pane in it supports.
// Scoped to `here`, the panes on THIS machine, for the same reason the status count is: tab ids
// collide across a pack.
function soleAgent(here: AgentView[], tabId: string): string | undefined {
  const brands = new Set(here.filter((a) => a.tabId === tabId).map((a) => a.agent));
  if (brands.size !== 1) return undefined;
  const [only] = brands;
  return only || undefined;
}

interface TabProps {
  label: string;
  active: boolean;
  /** Dimmed folder outline marking the tab focused in the desktop TUI. */
  ring?: boolean;
  /**
   * The most urgent thing happening inside this tab ({@link worstTriage}) — drawn as a leading dot
   * in the same palette the herd list uses. Omit (or pass null) when the tab holds no agent at all:
   * that's not the same as idle, and a resting dot would claim otherwise.
   */
  status?: TriageKey | null;
  /** The agent every pane in this tab runs, drawn as its brand tile. Omitted when the tab runs none,
   *  or more than one — see {@link soleAgent}. */
  agent?: string;
  onClick: () => void;
  /** Long-press (or right-click / Android contextmenu) opens actions. Inert when unset. */
  onLongPress?: () => void;
  /** A plain tap when the tab is already `active` — opens actions instead of a no-op re-select. */
  onTapActive?: () => void;
}

// One folder tab.
function Tab({ label, active, ring, status, agent, onClick, onLongPress, onTapActive }: TabProps) {
  const longPress = useLongPress(onLongPress);

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
        // THE NO-SHIFT RULE, which a folder tab is the classic place to break. The active tab gains
        // a border on three sides and a fill; if the inactive ones did not already reserve that box,
        // every label in the row would jump one pixel on every selection. So the border is in the
        // BASE string, 1px on top/left/right, transparent at rest, and `border-b-0` in both states —
        // the box is byte-identical and only the paint changes. `font-medium` is unconditional
        // (Rule E): bolding the active label re-flows every tab to its right. Measured: a label's
        // left edge, top edge and width are the same to three decimals in both states.
        //
        // Radius: the house 2px on the TOP corners only. A drawer tab does not round where it meets
        // the drawer, and the bottom of this one is an open edge, not an edge at all.
        //
        // h-11 is a REAL 44px tap target, not a hit area faked over a smaller box. That is a thing a
        // tab can do and a pill cannot without becoming a slab, and it is why this row needs none of
        // STRIP_TAP_TARGET's machinery.
        //
        // The `after` strip is the cover: 1px tall, one pixel BELOW the tab, in the content surface,
        // spanning the full border box so the side borders stop where the content begins. It is
        // absolutely positioned, so it is outside layout and can never move anything; it is present
        // in every state and merely transparent when inactive.
        "relative flex h-11 min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap rounded-t-md border border-b-0 border-transparent px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:absolute after:inset-x-0 after:-bottom-px after:h-px after:content-['']",
        active
          ? "border-rule bg-background text-foreground after:bg-background"
          : "bg-muted/40 text-muted-foreground after:bg-transparent hover:bg-muted/60",
        // The desktop-focus mark: the SAME folder outline, in the same --rule, but dashed. It used
        // to be `border-primary/40`, which worked when the active state was a full primary fill and
        // stopped working the moment the active state became a 1px --rule outline — measured in
        // dark, primary/40 composites brighter than --rule, so the TUI-focused tab out-shouted the
        // one that was actually open. Dashed says "this is where the desktop is looking" at exactly
        // the weight of the thing it is a variant of, and it borrows the vocabulary the "+" button
        // already uses: dashed is potential, solid is real. A border-STYLE change moves nothing.
        ring && !active && "border-rule border-dashed",
      )}
    >
      {status && (
        <>
          {/* A hollow resting dot is filled with the surface it sits ON, and the two states of this
              tab are two different surfaces. */}
          <StatusDot
            status={TRIAGE_STATUS[status]}
            surface={active ? "bg-background" : "bg-muted/40"}
            className="size-2"
          />
          {/* The dot is colour-only; say it in words for screen readers. */}
          <span className="sr-only">{statusLabel(TRIAGE_STATUS[status])}</span>
        </>
      )}
      {/* The brand tile, 14px, between the dot and the label. ORDER MATTERS and it is this one: the
          dot has always led this row and it keeps that position, because it is the mark the eye
          scans the whole row for — "where is the trouble" is asked of every tab at once, "which
          agent" is asked of one tab at a time. The tile then sits against the label it introduces.
          It is `aria-hidden` and it has to be: AgentIcon names itself "<agent> logo", and a tab that
          already carries a label and a status announces enough — a third name on the same control is
          noise, not information. The dot keeps its own `sr-only` word, which is the one thing here
          with no visible text.
          14px rather than 16: the row is `h-11` and unpadded vertically, so the tile must not become
          the tallest thing in a tab whose height belongs to the tap target, and it may not outweigh
          the label it introduces. */}
      {agent && (
        <span aria-hidden="true" className="flex shrink-0 items-center">
          <AgentIcon agent={agent} className="size-3.5" />
        </span>
      )}
      {label}
    </button>
  );
}
