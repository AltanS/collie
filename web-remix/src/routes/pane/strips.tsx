import { on, ref, type Handle } from "remix/component";
import { ChevronDown, ChevronUp, LoaderCircle, Plus, SquareTerminal } from "lucide";

import { hostKey } from "@web/lib/hosts";
import { t, tn, type MessageKey, type TemplateVars } from "@web/lib/i18n";
import { paneName, tabCellTitle, type TabTitle } from "@web/lib/pane-name";
import { paneOrdinals, panesOfTab } from "@web/lib/pane-ordinal";
import type { Scope } from "@web/lib/scope";
import { TRIAGE_STATUS, worstTriage, type TriageKey } from "@web/lib/triage";
import { statusLabel, type AgentStatus, type AgentView, type TabView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { PaneActionsSheet } from "../../chips/pane-actions-sheet";
import { creating, newTab, tabCreateKey } from "../../chips/space-actions";
import { TabActionsSheet } from "../../chips/tab-actions-sheet";
import { capability } from "../../chips/capability";
import { afterLayout } from "../../lib/after-layout";
import { address, config } from "../../lib/data";
import { LONG_PRESS_EVENT, longPress } from "../../lib/gestures";
import { useLocale } from "../../lib/i18n-store";
import { reducedMotion } from "../../lib/motion";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Collapse, CollapseSwap } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { LabelledStrip, STRIP_TAP_TARGET } from "../../ui/labelled-strip";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";

// Port of the pane screen's two strips and the bar that stands in for them: web/src/components/
// tab-strip.tsx, pane-strip.tsx and strips-summary.tsx, with the band logic of agent-chat.tsx
// (`stripsExist`, `folded`, `foldLabelKey`, `goToTab`).
//
// ONE BAND. The tab row and the pane row fold together into a 24px bar of beads: they are chrome
// ABOUT the pane, not its output, and they leave in one gesture. `CollapseSwap` morphs the band
// between the rows and the bar, so the bar that leaves is not pushed down by the rows that arrive.
// The caller owns WHETHER it is folded (the device pref, plus the keyboard override); this file
// only draws it, and reports a tap on the chevron or on the bar through `onToggleFold`.
//
// NOTHING IN FLOW APPEARS BARE. The whole band, the tab row and the pane row each sit in a
// `Collapse`, so a second pane opening in the tab (a poll, or the desktop) eases the pane row in
// instead of shoving the mirror 26px. `web/` drew those three as bare conditionals.
//
// COMPACT LABELS. This is the pane screen, so the strips draw no visible name; the names stay in
// the tree as each nav's accessible name (`CompactStripLabels` in web/).
//
// The strips read the snapshot through props (the pane route owns that subscription). The only
// stores read here are the ones a leaf renders from: `creating` (the "+" spinner) and `config`
// (whether the multiplexer can create a tab at all).

export interface StripsProps {
  /** The open pane (snapshot record). */
  pane: AgentView;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  tabs: readonly TabView[];
  scope: Scope | undefined;
  readOnly: boolean;
  /** The stripsCollapsed pref, read by the caller. */
  folded: boolean;
  onToggleFold: () => void;
  /** The caller navigates (side by side, replace). */
  onSelectPane: (pane: AgentView) => void;
  onPaneClosed: (paneId: string) => void;
  onTabClosed: (tabId: string) => void;
}

// ── Pure helpers (strips.test.ts) ─────────────────────────────────────────────────────────────────

/**
 * The tabs of the open pane's space, in the snapshot's own order. Tab ids collide across a crew
 * exactly as workspace and pane ids do, so a tab tagged with another machine is not this space's;
 * an untagged one is ambient, as everywhere else. (web/ filters by workspace id alone.)
 */
export function spaceTabs(pane: AgentView, tabs: readonly TabView[]): TabView[] {
  return tabs.filter((tab) => tab.workspaceId === pane.workspaceId && (tab.host === undefined || hostKey(tab) === hostKey(pane)));
}

/**
 * Would any row draw? The tab row draws when the space reports tabs; the pane row below two panes
 * draws nothing. With both silent there is no band: no bar and no chevron, because a fold over
 * nothing is a control that lies.
 */
export function stripsExist(pane: AgentView, tabs: readonly TabView[], panes: readonly AgentView[]): boolean {
  return spaceTabs(pane, tabs).length > 0 || panes.length > 1;
}

/**
 * The fold chevron's accessible name, chosen for what is on screen: "Hide tabs and panes" over a
 * screen with no pane row would promise a row that is not there.
 */
export function foldLabelKey(tabCount: number, paneCount: number): MessageKey {
  if (tabCount > 0 && paneCount > 1) return "chat.strips.hide.both";
  if (tabCount > 0) return "chat.strips.hide.tabs";
  return "chat.strips.hide.panes";
}

/** The bar's accessible name: one sentence per case, never a phrase assembled from parts. */
export function summaryLabel(tabCount: number, paneBeadCount: number): string {
  const counts: TemplateVars = { tabs: tn("space.view.tabCount", tabCount), panes: tn("space.view.paneCount", paneBeadCount) };
  if (tabCount > 0 && paneBeadCount > 0) return t("chat.strips.show.both", counts);
  if (tabCount > 0) return t("chat.strips.show.tabs", counts);
  return t("chat.strips.show.panes", counts);
}

/** The bead status of one tab: its worst triage as a status, or null when it holds no agent. */
export function tabBeadStatus(here: readonly AgentView[], tabId: string): AgentStatus | null {
  const worst = worstTriage(here.filter((a) => a.tabId === tabId));
  return worst === null ? null : TRIAGE_STATUS[worst];
}

/**
 * Where a tap on a tab goes: that tab's first pane, in the order the pane row draws. Nothing for
 * the open tab, and nothing for an empty tab (no pane to land on).
 */
export function firstPaneOfTab(
  tab: TabView,
  current: AgentView,
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[],
): AgentView | undefined {
  if (tab.tabId === current.tabId) return undefined;
  const inTab = [...agents, ...shellPanes].find(
    (p) => p.tabId === tab.tabId && p.workspaceId === tab.workspaceId && hostKey(p) === hostKey(current) && p.session === current.session,
  );
  return inTab === undefined ? undefined : panesOfTab(inTab, agents, shellPanes)[0];
}

// ── The tap floor for the tab row's 28px squares (web/ ui/labelled-strip.tsx) ─────────────────────
//
// Not in this shell's labelled-strip (web/'s module imports React). The row cannot reach up (the
// route's scroller clips at the header's bottom edge), so the whole floor hangs from the row's top
// edge down to the tabs' own 44px line. The numbers assume a 1px border on the control, because an
// absolutely placed `::before` resolves its insets against the PADDING box.
const TAB_ROW_SQUARE_TAP_TARGET =
  "relative before:absolute before:-top-[2px] before:-bottom-4 before:-inset-x-[9px] before:z-[1] before:content-['']";

// ── Keeping the active pill in view (web/ hooks/use-reveal-active.ts) ─────────────────────────────

const REVEAL_MARGIN = 12;

/**
 * Where the scroller must go to bring the element carrying `aria-current="true"` to the nearest edge
 * of its visible range, or null when it is already inside it. Never centres. A READ only: it runs
 * after the browser's own layout (lib/after-layout.ts), so its boxes cost nothing.
 */
function revealTarget(scroller: HTMLElement): number | null {
  if (scroller.clientWidth === 0) return null;
  const active = scroller.querySelector<HTMLElement>('[aria-current="true"]');
  if (active === null) return null;
  const box = scroller.getBoundingClientRect();
  const at = active.getBoundingClientRect();
  const left = box.left + REVEAL_MARGIN;
  const right = box.right - REVEAL_MARGIN;
  if (at.left >= left && at.right <= right) return null;
  const target = at.left < left ? scroller.scrollLeft + (at.left - box.left) - REVEAL_MARGIN : scroller.scrollLeft + (at.right - box.right) + REVEAL_MARGIN;
  return Math.max(0, target);
}

/**
 * One row's reveal, as a setup object: `bind` is the `ref` callback for the scroller (or for a
 * child of it, `via`), `after(key)` is called from render and queues the reveal on a change of the
 * active key. Nothing here touches the DOM during render, and nothing reads a box inside the flush:
 * the commit task only hands the scroller to `afterLayout`, whose read runs after the frame's own
 * layout and whose write (one `scrollTo`, only when the pill is out of view) runs after every read
 * of that frame. The first reveal after mount is instant, later ones smooth, reduced motion instant
 * always. Only the one scroller moves, never an ancestor.
 */
function revealer(handle: { queueTask(task: () => void): void; signal: AbortSignal }, via: "self" | "parent") {
  let node: HTMLElement | null = null;
  let seen: string | null | undefined;
  let revealed = false;
  return {
    bind: (el: Element): void => {
      node = el instanceof HTMLElement ? el : null;
    },
    after(key: string | null): void {
      if (key === seen) return;
      seen = key;
      handle.queueTask(() => {
        const scroller = via === "self" ? node : (node?.parentElement ?? null);
        if (scroller === null) return;
        afterLayout(
          scroller,
          () => revealTarget(scroller),
          (left) => {
            const first = !revealed;
            revealed = true;
            if (left !== null) scroller.scrollTo({ left, behavior: first || reducedMotion() ? "auto" : "smooth" });
          },
          handle.signal,
        );
      });
    },
  };
}

// ── The band ──────────────────────────────────────────────────────────────────────────────────────

export function Strips(handle: Handle<StripsProps>) {
  useLocale(handle);

  const selectTab = (tab: TabView): void => {
    const { pane, agents, shellPanes, onSelectPane } = handle.props;
    const target = firstPaneOfTab(tab, pane, agents, shellPanes);
    if (target !== undefined) onSelectPane(target);
  };

  return () => {
    const { pane, agents, shellPanes, tabs, scope, readOnly, folded } = handle.props;
    const spaceRows = spaceTabs(pane, tabs);
    const panes = panesOfTab(pane, agents, shellPanes);
    const exists = stripsExist(pane, tabs, panes);
    const canFold = spaceRows.length > 0;
    const isFolded = canFold && folded;
    // Tab status is counted over THIS machine's panes only: a peer's blocked agent must not light
    // the lead's tab (tab ids collide across a crew).
    const here = agents.filter((a) => hostKey(a) === hostKey(pane));

    return (
      <Collapse open={exists}>
        <div data-slot="strips">
          <CollapseSwap
            open={!isFolded}
            standIn={
              <StripsSummary
                tabs={spaceRows}
                here={here}
                selectedTabId={pane.tabId}
                panes={panes}
                currentPaneId={pane.paneId}
                onExpand={() => handle.props.onToggleFold()}
              />
            }
          >
            {/* `pb-1`: the 4px of page above the mirror's rule lives HERE, inside the Collapse, so it
                arrives and leaves with the rows instead of popping on a boolean. */}
            <div class="pb-1">
              <Collapse open={spaceRows.length > 0}>
                <TabStrip
                  workspaceId={pane.workspaceId}
                  tabs={spaceRows}
                  here={here}
                  selectedTabId={pane.tabId}
                  paneCount={panes.length}
                  scope={scope}
                  readOnly={readOnly}
                  onSelect={selectTab}
                  onTabClosed={(tabId) => handle.props.onTabClosed(tabId)}
                  onToggleFold={() => handle.props.onToggleFold()}
                />
              </Collapse>
              <Collapse open={panes.length > 1}>
                <PaneStrip
                  panes={panes}
                  currentPaneId={pane.paneId}
                  scope={scope}
                  readOnly={readOnly}
                  herd={[...agents, ...shellPanes]}
                  onSelect={(next) => handle.props.onSelectPane(next)}
                  onPaneClosed={(paneId) => handle.props.onPaneClosed(paneId)}
                />
              </Collapse>
            </div>
          </CollapseSwap>
        </div>
      </Collapse>
    );
  };
}

// ── The summary bar ───────────────────────────────────────────────────────────────────────────────

interface StripsSummaryProps {
  /** The open pane's space's tabs. */
  tabs: readonly TabView[];
  /** The panes of this machine, for each tab's worst triage. */
  here: readonly AgentView[];
  selectedTabId: string;
  /** The panes that share the open tab, in the order the pane row draws them. */
  panes: readonly AgentView[];
  currentPaneId: string;
  onExpand: () => void;
}

// The tab row and the pane row, folded down to one 24px bar of beads: a bead per tab in the tab
// row's triage palette, a bead per pane, a seam between the groups. The beads are decorative
// (colour is their only channel), so the button's accessible name spells the whole thing in words.
//
// 24px DRAWN, 44px HIT: the beads are 16px boxes, so 24 leaves 4px of air each side. A full-width
// control is the one shape that buys its 44px floor as pure hit area (D §6): 10px above and below.
// It draws NO `border-b`: the seam between chrome and mirror is drawn once, by the mirror.
function StripsSummary(handle: Handle<StripsSummaryProps>) {
  useLocale(handle);
  return () => {
    const { tabs, here, selectedTabId, panes, currentPaneId } = handle.props;
    // The pane row draws nothing below two panes, so neither does its bead group.
    const paneBeads = panes.length < 2 ? [] : panes;
    return (
      <button
        type="button"
        data-testid="strips-summary"
        aria-expanded="false"
        mix={on("click", () => handle.props.onExpand())}
        class="relative flex h-6 w-full shrink-0 items-center gap-2 px-4 text-left transition-colors before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span class="sr-only">{summaryLabel(tabs.length, paneBeads.length)}</span>
        <span aria-hidden="true" class="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {tabs.length > 0 && (
            <span class="flex items-center">
              {tabs.map((tab) => (
                <Bead key={tab.tabId} active={tab.tabId === selectedTabId} status={tabBeadStatus(here, tab.tabId)} />
              ))}
            </span>
          )}
          {tabs.length > 0 && paneBeads.length > 0 && (
            // The seam inside one control's contents: `--border`, not `--rule` (D §4).
            <span class="h-3 w-px shrink-0 bg-border" />
          )}
          {paneBeads.length > 0 && (
            <span class="flex items-center">
              {paneBeads.map((pane) => (
                <Bead key={pane.paneId} active={pane.paneId === currentPaneId} status={pane.status} />
              ))}
            </span>
          )}
        </span>
        <Icon icon={ChevronDown} class="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  };
}

// One bead: a status dot in a fixed 16px box. THE BOX IS FIXED AND THE RING IS PAINT (D §2): every
// bead is the same 16px square in every state, the dot inside is always 8px, and only the paint
// changes (the resting beads dim, the current one gains a ring its box already reserved).
function Bead(handle: Handle<{ active: boolean; status: AgentStatus | null }>) {
  return () => {
    const { active, status } = handle.props;
    return (
      <span
        class={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors",
          active ? "border-foreground/30" : "border-transparent",
        )}
      >
        {status === null ? (
          // A tab holding no agent at all is not idle (idle is a resting agent), so it is neutral.
          <span class="size-2 rounded-full bg-muted-foreground/40" />
        ) : (
          <StatusDot status={status} surface="bg-background" class={cn("size-2", !active && "opacity-50")} />
        )}
      </span>
    );
  };
}

// ── The tab row ───────────────────────────────────────────────────────────────────────────────────

interface TabStripProps {
  workspaceId: string;
  /** This space's tabs, already filtered. */
  tabs: readonly TabView[];
  here: readonly AgentView[];
  selectedTabId: string;
  /** Panes in the open tab, for the fold chevron's name. */
  paneCount: number;
  scope: Scope | undefined;
  readOnly: boolean;
  onSelect: (tab: TabView) => void;
  onTabClosed: (tabId: string) => void;
  onToggleFold: () => void;
}

// The space's tabs as PLAIN CELLS on the composer's chrome ground. The open tab is marked by ink and
// weight and by nothing else: no fill, border, bar or radius, and no horizontal rule on the row (a
// header above keeps its own). The row is 30px; the tap floor hangs BELOW it (`pb-3.5 -mb-3.5`),
// because nothing may reach up into the header. A cell names what the header names (`tabCellTitle`),
// and no brand tile: the header already carries the agent's mark once.
//
// The fold chevron is pinned to the row's trailing end, outside the scroller: a control you can
// lose by swiping is not an affordance. It costs no height (28px square centred in the 30px row,
// reach hanging down like every tab's). Traded for it: the last tab no longer scrolls clean off the
// screen edge, because that edge now belongs to the chevron.
function TabStrip(handle: Handle<TabStripProps>) {
  useLocale(handle);
  const inFlight = useStore(handle, creating);
  // The "+" is drawn only when the multiplexer can create a tab; read from the config it comes from.
  useStore(handle, config);
  const reveal = revealer(handle, "self");
  let sheetTab: TabView | null = null;
  let sheetOpen = false;

  const openSheet = (tab: TabView): void => {
    sheetTab = tab;
    sheetOpen = true;
    void handle.update();
  };

  return () => {
    const { workspaceId, tabs, here, selectedTabId, paneCount, scope, readOnly } = handle.props;
    // Keyed on the selected tab: reveal on mount and on every switch.
    reveal.after(selectedTabId);
    // The "+" goes where the create will (the ambient scope when the pane names none).
    const busy = inFlight().has(tabCreateKey(workspaceId, scope ?? address.get().scope));
    const canCreate = capability("createTab").capable;
    return (
      <>
        <nav
          // The row's name. The visible word is gone; the name is not.
          aria-label={t("space.tabStrip.title")}
          // `flex items-stretch` only while a control is pinned (always, here); either keeps the
          // scroller's `-mb-3.5` from collapsing through the nav's own bottom edge.
          class="flex shrink-0 items-stretch bg-chrome px-4"
        >
          <div
            mix={ref((node) => reveal.bind(node))}
            // `-ml-4 pl-4`: the first tab still starts on the route's 16px gutter; the right half is
            // spent on the pinned chevron. `pb-3.5 -mb-3.5` is the hanging tap floor (one number).
            class="-ml-4 flex min-w-0 flex-1 items-center gap-3 overflow-x-auto pb-3.5 pl-4 pr-3 -mb-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* The tab group: separated by air (each tab's own `px-1.5`), not a hairline, and `-mx-1.5`
                puts the first LABEL back on the gutter. */}
            <div class="-mx-1.5 flex shrink-0 items-stretch">
              {tabs.map((tab) => {
                const inTab = here.filter((a) => a.tabId === tab.tabId);
                return (
                  <Tab
                    key={tab.tabId}
                    label={tab.label}
                    title={tabCellTitle(tab.label, inTab)}
                    active={tab.tabId === selectedTabId}
                    status={worstTriage(inTab)}
                    onClick={() => handle.props.onSelect(tab)}
                    onLongPress={() => openSheet(tab)}
                    onTapActive={() => openSheet(tab)}
                  />
                );
              })}
            </div>
            {/* HIDE, don't explain: a "+" is an affordance, not a promise. 28px drawn, 44 hit. */}
            {canCreate && (
              <button
                type="button"
                disabled={busy}
                aria-label={t("space.tabStrip.new.aria")}
                aria-busy={busy ? "true" : "false"}
                mix={on("click", () => void newTab(handle.props.workspaceId, handle.props.scope))}
                class={cn(
                  TAB_ROW_SQUARE_TAP_TARGET,
                  "flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:bg-accent active:scale-95 disabled:opacity-100",
                )}
              >
                {busy ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : <Icon icon={Plus} class="size-4" />}
              </button>
            )}
          </div>
          <div class="flex shrink-0 self-center pl-1.5">
            <button
              type="button"
              data-testid="strips-fold"
              aria-expanded="true"
              aria-label={t(foldLabelKey(tabs.length, paneCount))}
              mix={on("click", () => handle.props.onToggleFold())}
              class={cn(
                TAB_ROW_SQUARE_TAP_TARGET,
                "flex size-7 shrink-0 items-center justify-center rounded-full border border-transparent text-muted-foreground transition-colors hover:bg-accent active:scale-95",
              )}
            >
              <Icon icon={ChevronUp} class="size-4" />
            </button>
          </div>
        </nav>

        <TabActionsSheet
          open={sheetOpen}
          onClose={() => {
            sheetOpen = false;
            scheduleUpdate(handle);
          }}
          tab={sheetTab}
          scope={scope}
          readOnly={readOnly}
          onClosed={(tabId) => handle.props.onTabClosed(tabId)}
        />
      </>
    );
  };
}

interface TabProps {
  /** The raw label: the spoken fallback when the cell has no title to draw. */
  label: string;
  title: TabTitle | null;
  active: boolean;
  /** The most urgent thing in the tab; null when it holds no agent (not the same as idle). */
  status: TriageKey | null;
  onClick: () => void;
  onLongPress: () => void;
  /** A plain tap on the already-open tab opens its actions rather than a dead re-select. */
  onTapActive: () => void;
}

function Tab(handle: Handle<TabProps>) {
  return () => {
    const { label, title, active, status } = handle.props;
    return (
      <button
        type="button"
        // Not role="tab": these navigate (a tap goes to another pane's URL), they do not swap a panel.
        aria-current={active ? "true" : undefined}
        mix={[
          // A hold suppresses the click that ends it, so this only ever sees a genuine tap.
          on("click", () => {
            if (handle.props.active) handle.props.onTapActive();
            else handle.props.onClick();
          }),
          longPress(),
          on(LONG_PRESS_EVENT, () => handle.props.onLongPress()),
        ]}
        class={cn(
          // NO BOX AT ALL, IN EITHER STATE: ink and weight are the only mark. The tap floor is not in
          // this box: `before:top-0 before:-bottom-3.5` takes the whole 14px downward (30 + 14 = 44)
          // into the scroller's own `pb-3.5` clip room, and `before:z-[1]` lets it win over the mirror.
          STRIP_TAP_TARGET,
          "relative flex h-7.5 min-w-11 shrink-0 select-none items-center justify-center gap-1.5 [-webkit-touch-callout:none] whitespace-nowrap px-1.5 text-[11px] transition-colors before:top-0 before:-bottom-3.5 before:z-[1] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          active ? "font-semibold text-foreground" : "font-medium text-muted-foreground hover:text-foreground",
        )}
      >
        {status === "ready" && <UnseenMark size="sm" />}
        {status !== null && status !== "ready" && (
          <>
            {/* Every cell sits on the row's bare chrome ground, so a hollow dot fills with it. */}
            <StatusDot status={TRIAGE_STATUS[status]} surface="bg-chrome" class="size-1.5" />
            <span class="sr-only">{statusLabel(TRIAGE_STATUS[status])}</span>
          </>
        )}
        {title === null ? (
          <>
            {/* Only an EMPTY label falls to the dot; the label stays the spoken name. */}
            <span aria-hidden="true" class="size-1 shrink-0 rounded-full bg-current opacity-50" />
            <span class="sr-only">{label}</span>
          </>
        ) : (
          // A position (`tab 2`) reads a step lighter than a name someone chose.
          <StableLabel class={title.positional && !active ? "text-muted-foreground/70" : undefined}>{title.text}</StableLabel>
        )}
      </button>
    );
  };
}

// A label as wide in medium as in semibold, so opening a tab never re-flows the row. Two copies
// share one grid cell: the invisible one is always semibold and sets the width, the visible one
// takes the tab's weight. The copy is `aria-hidden`, so the name is the label once, not twice.
function StableLabel(handle: Handle<{ children?: string; class?: string | undefined }>) {
  return () => (
    <span class={cn("grid justify-items-center", handle.props.class)}>
      <span aria-hidden="true" class="invisible col-start-1 row-start-1 font-semibold">
        {handle.props.children}
      </span>
      <span class="col-start-1 row-start-1">{handle.props.children}</span>
    </span>
  );
}

// ── The pane row ──────────────────────────────────────────────────────────────────────────────────

interface PaneStripProps {
  /** The panes that share the open tab (agents then shells), in the row's stable order. */
  panes: readonly AgentView[];
  currentPaneId: string;
  scope: Scope | undefined;
  readOnly: boolean;
  /** Every pane of the herd, for the sheet's Pin to top row. */
  herd: readonly AgentView[];
  onSelect: (pane: AgentView) => void;
  onPaneClosed: (paneId: string) => void;
}

// The panes within the open tab, one level below the tab row. THIS ROW IS WHERE PANES ARE TOLD
// APART: a pill carries a small position number only when a neighbour would otherwise read the
// same (`paneOrdinals`). Drawn only when the tab holds more than one pane (the caller's Collapse).
//
// THE ROW IS 26px: the 24px pill and 1px of air each side. The tap floor hangs BELOW it (18px of
// scroller padding given back by `-mb-[18px]`), and the pills sit in a `relative z-[2]` track so
// this row owns its whole 26px against the tab row's reach above it. The scroller takes touches
// itself (no `pointer-events-none`): iOS Safari does not scroll such a scroller from an auto child.
function PaneStrip(handle: Handle<PaneStripProps>) {
  useLocale(handle);
  // The track is the scroller's only child, so the reveal reads the scroller as its parent.
  const reveal = revealer(handle, "parent");
  let sheetPane: AgentView | null = null;
  let sheetOpen = false;

  const openSheet = (pane: AgentView): void => {
    sheetPane = pane;
    sheetOpen = true;
    void handle.update();
  };

  return () => {
    const { panes, currentPaneId, scope, readOnly, herd } = handle.props;
    reveal.after(currentPaneId);
    // Which pills have a twin, worked out once for the row: a pill cannot know its neighbours.
    const ordinals = paneOrdinals(panes);
    return (
      <>
        <LabelledStrip label={t("space.paneStrip.title")} compact class="flow-root bg-chrome" scrollerClass="px-0 py-0 pb-[18px] -mb-[18px]">
          {/* `px-4` moves the gutter from the scroller onto the track, so the track covers the
              gutters too and the scroll width keeps both of them. */}
          <div class="relative z-[2] flex w-max min-w-full shrink-0 items-center gap-2 px-4 py-px" mix={ref((node) => reveal.bind(node))}>
            {panes.map((pane) => (
              <PanePill
                key={`${pane.host ?? ""}\u0000${pane.paneId}`}
                pane={pane}
                active={pane.paneId === currentPaneId}
                ordinal={ordinals.get(pane.paneId)}
                onSelect={() => handle.props.onSelect(pane)}
                onLongPress={() => openSheet(pane)}
                onTapActive={() => openSheet(pane)}
              />
            ))}
          </div>
        </LabelledStrip>

        <PaneActionsSheet
          open={sheetOpen}
          onClose={() => {
            sheetOpen = false;
            scheduleUpdate(handle);
          }}
          pane={sheetPane}
          scope={scope}
          readOnly={readOnly}
          herd={herd}
          onClosed={(paneId) => handle.props.onPaneClosed(paneId)}
        />
      </>
    );
  };
}

interface PanePillProps {
  pane: AgentView;
  active: boolean;
  /** This pane's 1-based place in the row, given only when a neighbour reads the same. */
  ordinal: number | undefined;
  onSelect: () => void;
  onLongPress: () => void;
  onTapActive: () => void;
}

function PanePill(handle: Handle<PanePillProps>) {
  useLocale(handle);
  return () => {
    const { pane, active, ordinal } = handle.props;
    const isShell = pane.kind === "shell";
    // The one name rule: the string the dashboard row, the header and a push all lead with. The
    // place is NOT repeated: this row sits inside the tab whose place the header states.
    const name = paneName(pane);
    return (
      <button
        type="button"
        aria-current={active ? "true" : undefined}
        // A numbered pill states its own name: the number is a separate text node, and the accessible
        // name computation would otherwise run the two together as "claude2".
        aria-label={ordinal === undefined ? undefined : `${name} ${String(ordinal)}`}
        title={active ? t("home.sidebar.paneActionsTitle") : undefined}
        mix={[
          on("click", () => {
            if (handle.props.active) handle.props.onTapActive();
            else handle.props.onSelect();
          }),
          longPress(),
          on(LONG_PRESS_EVENT, () => handle.props.onLongPress()),
        ]}
        class={cn(
          // `rounded-md` (2px): this pill carries a name, so it is a stadium, not a circle. The border
          // is transparent at rest and in the base string, so resting and active are the same box.
          // The tap floor is not centred: `before:-top-[2px] before:-bottom-5` run from the row's top
          // edge to 44px below it, into the scroller's `pb-[18px]` clip room.
          STRIP_TAP_TARGET,
          "flex h-6 min-w-11 shrink-0 select-none [-webkit-touch-callout:none] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 text-[11px] font-medium transition-colors before:-top-[2px] before:-bottom-5 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
        )}
      >
        {isShell ? <Icon icon={SquareTerminal} class="size-3.5 shrink-0" /> : <StatusDot status={pane.status} live />}
        <span>{name}</span>
        {ordinal !== undefined && (
          <span class={cn("font-mono text-[10px]", active ? "text-primary-foreground/70" : "text-muted-foreground/60")}>{ordinal}</span>
        )}
      </button>
    );
  };
}
