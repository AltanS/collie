import { on, ref, type Handle } from "remix/component";

import { hostKey } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import { tabCellTitle, type TabTitle } from "@web/lib/pane-name";
import { TRIAGE_STATUS, worstTriage, type TriageKey } from "@web/lib/triage";
import { statusLabel, type AgentView, type TabView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { capability } from "../../chips/capability";
import { currentCrew, hostWriteBlock } from "../../chips/crew";
import { creating, newTab, tabCreateKey } from "../../chips/space-actions";
import { TabActionsSheet } from "../../chips/tab-actions-sheet";
import { config } from "../../lib/data";
import { LONG_PRESS_EVENT, longPress } from "../../lib/gestures";
import { useLocale } from "../../lib/i18n-store";
import { setStatus } from "../../lib/status";
import { useStore } from "../../lib/store";
import { STRIP_TAP_TARGET } from "../../ui/labelled-strip";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";
import { revealer, StripAdd } from "./strip-parts";

// Port of web/src/components/tab-strip.tsx for the space screen: the open space's tabs as PLAIN CELLS
// on the composer's chrome ground. The open tab is marked by ink and weight and by nothing else (no
// fill, border, bar or radius, no horizontal rule on the row). The row is 30 px; the 44 px tap floor
// hangs BELOW it (`pb-3.5 -mb-3.5`), because nothing may reach up into the header. A cell names what
// the header names (`tabCellTitle`), carries the worst status in its tab, and a long press, or a tap
// on the open tab, opens the actions sheet (rename, close). The trailing "+" makes a tab.
//
// Not ported: web's `trailing` slot (the pane screen's fold chevron). This row is the space screen's;
// the pane screen draws its own (routes/pane/strips.tsx).
export interface TabStripProps {
  workspaceId: string;
  tabs: readonly TabView[];
  agents: readonly AgentView[];
  /** The machine this space is on: tab ids collide across a crew, so status is counted per host. */
  host: string | undefined;
  /** The open tab's id, or null for "All". */
  selected: string | null;
  onSelect: (tabId: string | null) => void;
  scope: Scope;
  readOnly: boolean;
  onClosed: (tabId: string) => void;
}

export function TabStrip(handle: Handle<TabStripProps>) {
  useLocale(handle);
  const readCreating = useStore(handle, creating);
  // The "+" is drawn only when the multiplexer can create a tab; read from the config it comes from.
  useStore(handle, config);
  const reveal = revealer(handle);
  let sheetTab: TabView | null = null;
  let sheetOpen = false;

  const openSheet = (tab: TabView): void => {
    sheetTab = tab;
    sheetOpen = true;
    void handle.update();
  };
  const closeSheet = (): void => {
    sheetOpen = false;
    void handle.update();
  };
  const onNewTab = (): void => {
    const { workspaceId, host, scope } = handle.props;
    const block = hostWriteBlock(currentCrew(), host);
    if (block !== undefined) {
      setStatus(block, "error");
      return;
    }
    void newTab(workspaceId, scope);
  };

  return () => {
    const { workspaceId, tabs, agents, host, selected, scope, readOnly } = handle.props;
    const wsTabs = tabs.filter((tab) => tab.workspaceId === workspaceId);
    if (wsTabs.length === 0) return null;
    // Keyed on the open tab: reveal on mount and on every switch.
    reveal.after(selected);
    // Status over THIS machine's panes only; solo panes are untagged and `host` is undefined.
    const here = agents.filter((a) => hostKey(a) === (host ?? ""));
    const canCreate = capability("createTab").capable;
    const busy = readCreating().has(tabCreateKey(workspaceId, scope));
    return (
      <>
        <nav
          // The row's name. The visible word is gone; the name is not.
          aria-label={t("space.tabStrip.title")}
          data-testid="tab-strip"
          // `flow-root` keeps the scroller's `-mb-3.5` from collapsing through the nav's bottom edge,
          // which would leave the nav 44 px tall while the row below moved up 14 px to overlap.
          class="flow-root shrink-0 bg-chrome px-4"
        >
          <div
            mix={ref((node) => reveal.bind(node))}
            // `-mx-4 px-4`: the last tab scrolls clean off the screen edge while the first still starts
            // on the route's 16 px gutter. `pb-3.5 -mb-3.5`: the tap floor hangs below the 30 px row
            // (one number, the same as the tab's `before:-bottom-3.5`).
            class="-mx-4 -mb-3.5 flex items-center gap-3 overflow-x-auto px-4 pb-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {/* The tab group: separated by air (each tab's own `px-1.5`), not a hairline; `-mx-1.5` puts
                the first LABEL back on the gutter. */}
            <div class="-mx-1.5 flex shrink-0 items-stretch">
              <Tab
                testId="tab-all"
                label={t("space.tabStrip.all")}
                title={{ text: t("space.tabStrip.all"), positional: false }}
                active={selected === null}
                status={null}
                onClick={() => handle.props.onSelect(null)}
              />
              {wsTabs.map((tab) => {
                const inTab = here.filter((a) => a.tabId === tab.tabId);
                return (
                  <Tab
                    key={tab.tabId}
                    testId="tab-pill"
                    tabId={tab.tabId}
                    label={tab.label}
                    title={tabCellTitle(tab.label, inTab)}
                    active={selected === tab.tabId}
                    status={worstTriage(inTab)}
                    onClick={() => handle.props.onSelect(tab.tabId)}
                    onLongPress={() => openSheet(tab)}
                    onTapActive={() => openSheet(tab)}
                  />
                );
              })}
            </div>
            {/* HIDE, don't explain: a "+" is an affordance, not a promise. 28 px drawn, 44 hit (from the
                row's top edge down to the tabs' own 44 px line, 8 px out each side). */}
            {canCreate && (
              <StripAdd
                testId="space-new-tab"
                size="sm"
                reach={TAB_ROW_SQUARE_TAP_TARGET}
                label={t("space.tabStrip.new.aria")}
                busy={busy}
                onClick={onNewTab}
              />
            )}
          </div>
        </nav>

        <TabActionsSheet
          open={sheetOpen}
          onClose={closeSheet}
          tab={sheetTab}
          scope={scope}
          readOnly={readOnly}
          onClosed={(tabId) => handle.props.onClosed(tabId)}
        />
      </>
    );
  };
}

// The tap floor for the tab row's 28 px square (web/ ui/labelled-strip.tsx; this shell's labelled-strip
// does not carry it). The row cannot reach up, so the whole floor hangs from its top edge down. The
// numbers assume a 1 px border on the control: an absolutely placed `::before` resolves its insets
// against the PADDING box.
const TAB_ROW_SQUARE_TAP_TARGET =
  "relative before:absolute before:-top-[2px] before:-bottom-4 before:-inset-x-[9px] before:z-[1] before:content-['']";

interface TabProps {
  testId: string;
  tabId?: string;
  /** The raw label: the spoken fallback when the cell has no title to draw. */
  label: string;
  title: TabTitle | null;
  active: boolean;
  /** The most urgent thing in the tab; null when it holds no agent (not the same as idle). */
  status: TriageKey | null;
  onClick: () => void;
  /** Long press, or right click: opens actions. Inert when unset. */
  onLongPress?: () => void;
  /** A plain tap on the open tab opens actions rather than a dead re-select. */
  onTapActive?: () => void;
}

function Tab(handle: Handle<TabProps>) {
  return () => {
    const { testId, tabId, label, title, active, status, onLongPress } = handle.props;
    return (
      <button
        type="button"
        data-testid={testId}
        data-tab-id={tabId}
        // Not role="tab": these filter the route's own list, they do not swap a panel.
        aria-current={active ? "true" : undefined}
        mix={[
          // A hold suppresses the click that ends it, so this only ever sees a genuine tap.
          on("click", () => {
            if (handle.props.active && handle.props.onTapActive) handle.props.onTapActive();
            else handle.props.onClick();
          }),
          longPress({ disabled: onLongPress === undefined }),
          on(LONG_PRESS_EVENT, () => handle.props.onLongPress?.()),
        ]}
        class={cn(
          // NO BOX AT ALL, IN EITHER STATE: ink and weight are the only mark. The tap floor is not in
          // this box: `before:top-0 before:-bottom-3.5` takes the whole 14 px downward (30 + 14 = 44)
          // into the scroller's own `pb-3.5` clip room, and `before:z-[1]` lets it win over what is below.
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

// A label as wide in medium as in semibold, so opening a tab never re-flows the row. Two copies share
// one grid cell: the invisible one is always semibold and sets the width, the visible one takes the
// tab's weight. The copy is `aria-hidden`, so the name is the label once, not twice.
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
