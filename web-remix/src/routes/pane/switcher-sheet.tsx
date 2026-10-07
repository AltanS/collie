import { on, type Handle, type RemixNode } from "remix/component";
import { LoaderCircle, Play, SquareTerminal } from "lucide";

import { pinnedRows, shownGroups } from "@web/lib/dash-view";
import { paneRowKey } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { groupPanesByWorkspace } from "@web/lib/pane-groups";
import { paneName, panePlaceParts } from "@web/lib/pane-name";
import { scopeKey, type Scope } from "@web/lib/scope";
import { shortenHome } from "@web/lib/shorten-home";
import { bucketOf, isAttention, worstTriage, type TriageKey } from "@web/lib/triage";
import type { AgentView, Launcher, LaunchersResponse } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { crewOf, hostWriteBlock } from "../../chips/crew";
import { CacheChip } from "../../chips/cache-chip";
import { creating, launch, launchKey } from "../../chips/space-actions";
import { writeRefusal } from "../../chips/writes";
import { bridgeGet } from "../../lib/api";
import { snapshot } from "../../lib/data";
import { createFrozenRanks } from "../../lib/frozen-ranks";
import { useLocale } from "../../lib/i18n-store";
import { inRankOrder, ORDER_SEGMENTS, ORDERS, rankedHeading, type PaneOrder } from "../../lib/pane-order";
import { pinMatcher, pins } from "../../lib/pins";
import { dashPrefs, setDashPref } from "../../lib/prefs";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { BottomSheet, type SheetPeek } from "../../ui/sheet";
import { AgentIcon } from "../home/agent-icon";
import { FoldHeader } from "../home/fold-header";
import { SectionHeader } from "../home/section-header";
import { StatusCounts, StatusSummaryLine } from "../home/status-counts";
import { launchersUrl } from "../../lib/urls";

// Port of the pane screen's swipe-up "Switch pane" sheet: web/src/components/agent-sidebar.tsx
// (`ThreadSidebar`) inside the BottomSheet of agent-chat.tsx, with the peek wired.
//
// EVERY PANE under the WORKSPACE it lives in, in the dashboard's own fixed order (place order),
// then bare shells under a trailing "Shells" group, with the open pane highlighted. Switching is the
// ONLY action: closing a pane lives in the pane pill's long-press sheet, so a fat-thumbed switch can
// never destroy a pane. A trailing Launch section rides along, because this is the launcher's one
// home reachable from inside a pane.
//
// NOTHING HERE MOVES WHEN A PANE CHANGES STATE (ADR 0063, 0071). Urgency is a MARK: the row's alarm
// edge, the lit heading and one summary line that counts what needs you and jumps to the first of
// it. Place order is the multiplexer's own. Activity and Cache order read the clock ONCE, when the
// list mounts, and hold that reading until the operator taps the toggle. The list mounts when the
// sheet opens (or when a peek starts) and is gone when it closes, so each open is a fresh reading
// by construction, and a pane that finishes a turn while the sheet is up repaints where it stands.
//
// The two long tails still fold (shells, Launch) on the dashboard's own fold header and remember it.
// Every section that can arrive or leave on a poll goes through Collapse (D §1). Not ported: the
// level-3 heading of the sections (this shell's section headers are h2) and the dot on the Shells
// and Launch headings (the fold header draws none).

/** The buckets that mean "a human is required here". */
const URGENT: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

/** web/ hooks/use-dash-prefs.ts `COLLAPSE_THRESHOLD` and `openForCount` (that module imports React). */
const COLLAPSE_THRESHOLD = 8;
function openForCount(pref: boolean | null, count: number): boolean {
  return pref !== null ? pref : count <= COLLAPSE_THRESHOLD;
}

const NO_PANES: readonly AgentView[] = [];
const NO_LAUNCHERS: readonly Launcher[] = [];

/** A DOM id for a pane row, so the summary line can scroll to it and focus it. */
function rowDomId(pane: AgentView): string {
  return `switch-row-${paneRowKey(pane).replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/**
 * Does ANOTHER pane need you? For the belt's Switch badge (`chat.switcher.ariaNeedsYou`). Compared
 * by full row identity, not bare id: on a crew a peer's pane can share the open pane's own id.
 */
export function needsYouElsewhere(here: AgentView | undefined, panes: readonly AgentView[]): boolean {
  const hereKey = here === undefined ? null : paneRowKey(here);
  return panes.some((a) => a.status === "blocked" && paneRowKey(a) !== hereKey);
}

export interface SwitcherSheetProps {
  open: boolean;
  onClose: () => void;
  /** The belt's pull, so the panel follows the finger up before the sheet is open. */
  peek?: SheetPeek;
  /** The open pane; its row is the current one. */
  here: AgentView | undefined;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  /** The open pane's own scope: the machine whose launchers the Launch section lists and runs on. */
  scope: Scope | undefined;
  /** Open a row. Never called for the row that is already open. The sheet closes itself first. */
  onPick: (pane: AgentView) => void;
  /** This device may not write: the Launch section is withheld. */
  readOnly?: boolean;
}

export function SwitcherSheet(handle: Handle<SwitcherSheetProps>) {
  useLocale(handle);
  return () => {
    const { open, onClose, peek } = handle.props;
    return (
      <BottomSheet open={open} onClose={onClose} title={t("chat.switcher.title")} peek={peek}>
        {/* A component, not a computed list: the sheet mounts its children only while open or
            peeking, so nothing below runs on a poll while the sheet is shut. */}
        <SwitcherList
          here={handle.props.here}
          agents={handle.props.agents}
          shellPanes={handle.props.shellPanes}
          scope={handle.props.scope}
          readOnly={handle.props.readOnly === true}
          onClose={() => handle.props.onClose()}
          onPick={(pane) => handle.props.onPick(pane)}
        />
      </BottomSheet>
    );
  };
}

interface SwitcherListProps {
  here: AgentView | undefined;
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
  scope: Scope | undefined;
  readOnly: boolean;
  onClose: () => void;
  onPick: (pane: AgentView) => void;
}

function SwitcherList(handle: Handle<SwitcherListProps>) {
  useLocale(handle);
  const snap = useStore(handle, snapshot);
  const prefs = useStore(handle, dashPrefs);
  const readPins = useStore(handle, pins);
  const inFlight = useStore(handle, creating);
  // THE FREEZE: one reading per mount, retaken only by the operator's tap on the toggle.
  const frozen = createFrozenRanks();

  // This scope's own launcher rows, read when the list mounts and again if the scope changes. A
  // failed read leaves the rows as they were (empty on a first failure).
  let launchRows: readonly Launcher[] = NO_LAUNCHERS;
  let launchHome = "";
  let askedKey: string | undefined;
  const loadLaunchers = (scope: Scope | undefined, key: string): void => {
    void (async () => {
      try {
        const res = await bridgeGet<LaunchersResponse>(launchersUrl(), scope, handle.signal);
        if (handle.signal.aborted || askedKey !== key) return;
        launchRows = res.launchers;
        launchHome = res.home;
        scheduleUpdate(handle);
      } catch {
        // See the header: not an error state.
      }
    })();
  };

  const jumpTo = (pane: AgentView): void => {
    const row = document.getElementById(rowDomId(pane));
    row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    row?.focus({ preventScroll: true });
  };

  const pick = (pane: AgentView): void => {
    const here = handle.props.here;
    handle.props.onClose();
    if (here !== undefined && paneRowKey(pane) === paneRowKey(here)) return;
    handle.props.onPick(pane);
  };

  return () => {
    const { here, agents, shellPanes, scope, readOnly } = handle.props;
    const hereKey = here === undefined ? "" : paneRowKey(here);

    const key = scopeKey(scope);
    if (key !== askedKey) {
      const first = askedKey === undefined;
      askedKey = key;
      if (!first) {
        launchRows = NO_LAUNCHERS;
        launchHome = "";
      }
      handle.queueTask(() => loadLaunchers(scope, key));
    }

    const body = snap().data;
    const prefValues = prefs();
    const order = prefValues.paneOrder;
    const showLaunch = launchRows.length > 0 && !readOnly && writeRefusal() === undefined;
    const noPanes = agents.length === 0 && shellPanes.length === 0;

    // An operator with no panes but a launchers.toml still has something to reach in here, so the
    // empty-panes text and the Launch section coexist rather than the text winning outright.
    if (noPanes && !showLaunch) {
      return (
        <div data-testid="pane-switcher" class="px-4 py-12 text-center text-sm text-muted-foreground">
          {t("home.empty.noAgents")}
        </div>
      );
    }

    const tabs = body?.tabs;
    const servers = body?.servers;
    const ranks = frozen.ranks(order, [...agents, ...shellPanes]);
    // The dashboard's grouping, so the switcher and the dashboard list the same panes in one place.
    const groups = groupPanesByWorkspace(agents, [], { order: "fixed", tabs, servers });
    // PINNED LEADS (ADR 0070): place order over agents AND shells, each pinned pane listed once.
    const pinList = readPins();
    const isPinned = pinMatcher(pinList);
    const pinned =
      pinList.length === 0 ? NO_PANES : pinnedRows(groupPanesByWorkspace(agents, shellPanes, { order: "fixed", tabs, servers }), isPinned);
    const sections = shownGroups(groups, false, isPinned);
    const shellRows = pinList.length === 0 ? shellPanes : shellPanes.filter((p) => !isPinned(p));
    const pinnedShown = inRankOrder(pinned, ranks);
    // BOTH ranked orders collapse to one list: a rank crosses every workspace, and a heading cannot
    // answer a question asked across all of them.
    const ranked = order !== "place";
    const rankedRows = ranked ? inRankOrder([...sections.flatMap((g) => g.rows), ...shellRows], ranks) : NO_PANES;

    const urgent = agents.filter((a) => URGENT.has(bucketOf(a)));
    // The first urgent row in DISPLAY order.
    const firstUrgent = [...pinnedShown, ...(ranked ? rankedRows : sections.flatMap((g) => g.rows))].find((a) => URGENT.has(bucketOf(a)));
    const flying = inFlight();
    const launchRefusal = hostWriteBlock(crewOf(body), here?.host);
    const shellsOpen = openForCount(prefValues.shellsOpen, shellPanes.length);
    const launchOpen = openForCount(prefValues.launchOpen, launchRows.length);

    const rowFor = (pane: AgentView, withId: boolean): RemixNode => (
      <PaneRow key={paneRowKey(pane)} id={withId ? rowDomId(pane) : undefined} pane={pane} active={paneRowKey(pane) === hereKey} onSelect={pick} />
    );

    return (
      <div data-testid="pane-switcher" class="flex flex-col gap-4 px-0 py-1">
        {noPanes && <p class="px-2 py-2 text-sm text-muted-foreground">{t("home.empty.noAgents")}</p>}

        {/* ONE CHROME ROW, not two: the summary line is the alarm and keeps the left, where ADR 0063
            puts urgency; the order control takes the right as glyphs. The row is drawn while either
            half has something, and the summary line keeps a slot of its own while there are agents,
            so the rows below never shift when the first pane needs you or the last is answered. */}
        {!noPanes && (
          <div class="flex items-center justify-between gap-2 px-2">
            {agents.length > 0 ? (
              <StatusSummaryLine
                panes={urgent}
                allClear={firstUrgent === undefined}
                onJump={firstUrgent === undefined ? undefined : () => jumpTo(firstUrgent)}
                class="min-w-0 flex-1"
              />
            ) : (
              <span class="flex-1" />
            )}
            <OrderToggle
              order={order}
              onChange={(next) => {
                frozen.reread();
                setDashPref("paneOrder", next);
              }}
            />
          </div>
        )}

        {/* The Pinned section: no dot, no count, and it does not fold. A pin is the one thing this
            sheet was opened to reach. */}
        <Collapse open={pinned.length > 0}>
          <SwitchSection id="switch-pinned" headingId="switch-pinned-heading" label={t("home.pinned.title")}>
            {pinnedShown.map((a) => rowFor(a, true))}
          </SwitchSection>
        </Collapse>

        {/* The one flat list in a ranked order: the workspace sections' own row ink and marks, so only
            the ORDER differs from place order. The heading NAMES the order, which is what pays for the
            compact glyphs in the row above. */}
        <Collapse open={ranked && rankedRows.length > 0}>
          <SwitchSection id="switch-activity" label={t(rankedHeading(order))} count={rankedRows.length} tone="strong">
            {rankedRows.map((a) => rowFor(a, true))}
          </SwitchSection>
        </Collapse>

        <Collapse open={!ranked && sections.length > 0}>
          <div class="flex flex-col gap-4">
            {sections.map(({ group: g, rows }) => (
              <SwitchSection
                key={g.key}
                id={`switch-ws-${g.key.replace(/[^A-Za-z0-9_-]/gu, "_")}`}
                label={g.label}
                tone="strong"
                dot={worstTriage(g.panes) === "needs" ? "bg-status-blocked" : undefined}
                trailing={<StatusCounts panes={g.panes} class="shrink-0 text-[11px] text-muted-foreground" />}
              >
                {rows.map((a) => rowFor(a, true))}
              </SwitchSection>
            ))}
          </div>
        </Collapse>

        <Collapse open={!ranked && shellRows.length > 0}>
          <SwitchSection
            id="switch-shells"
            label={t("home.sidebar.shells")}
            count={shellRows.length}
            fold={{ open: shellsOpen, onToggle: (next) => setDashPref("shellsOpen", next) }}
          >
            {shellRows.map((p) => rowFor(p, false))}
          </SwitchSection>
        </Collapse>

        <Collapse open={showLaunch}>
          <SwitchSection
            id="switch-launch"
            label="Launch"
            count={launchRows.length}
            fold={{ open: launchOpen, onToggle: (next) => setDashPref("launchOpen", next) }}
          >
            {launchRows.map((launcher) => (
              <LaunchRow
                key={launcher.command}
                launcher={launcher}
                home={launchHome}
                busy={flying.has(launchKey(launcher.command))}
                refusal={launchRefusal}
                onLaunch={(command) => {
                  // Close first: the launch navigates into the new pane, and a sheet still up while
                  // the route changes under it would have to be dismissed on the screen you arrive at.
                  handle.props.onClose();
                  // Beside THIS pane: a tab in this pane's Space, on this pane's own host.
                  void launch(command, handle.props.here?.paneId, handle.props.scope);
                }}
              />
            ))}
          </SwitchSection>
        </Collapse>
      </div>
    );
  };
}

// ── The order toggle (web/ pane-order-toggle.tsx, compact) ────────────────────────────────────────

function OrderToggle(handle: Handle<{ order: PaneOrder; onChange: (order: PaneOrder) => void }>) {
  useLocale(handle);
  return () => (
    <div role="radiogroup" aria-label={t("paneOrder.aria")} class="flex shrink-0 gap-1">
      {ORDERS.map((value) => {
        const { label, icon } = ORDER_SEGMENTS[value];
        const selected = value === handle.props.order;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={selected ? "true" : "false"}
            aria-label={t(label)}
            mix={on("click", () => handle.props.onChange(value))}
            class={cn(
              "flex size-11 min-h-11 shrink-0 items-center justify-center rounded-md text-sm font-medium transition-colors",
              selected ? "bg-muted text-foreground" : "text-muted-foreground active:bg-muted",
            )}
          >
            <Icon icon={icon} class="size-4 shrink-0" />
          </button>
        );
      })}
    </div>
  );
}

// ── A section: the dashboard's own header, folding where it can ───────────────────────────────────

interface SwitchSectionProps {
  id: string;
  /** The heading's id. Given, the section takes its name from it (`aria-labelledby`). */
  headingId?: string;
  label: string;
  count?: number;
  /** Status-palette bullet beside the header; a workspace heading carries one only while a pane in it needs you. */
  dot?: string | undefined;
  tone?: "muted" | "strong";
  trailing?: RemixNode;
  /** Given, the section folds; the body leaves through Collapse. */
  fold?: { open: boolean; onToggle: (open: boolean) => void };
  children?: RemixNode;
}

function SwitchSection(handle: Handle<SwitchSectionProps>) {
  return () => {
    const { id, headingId, label, count, dot, tone, trailing, fold, children } = handle.props;
    return (
      <section class="flex flex-col gap-0.5" aria-labelledby={headingId}>
        {fold === undefined ? (
          <SectionHeader id={headingId} label={label} count={count} dot={dot} tone={tone} trailing={trailing} class="px-2" />
        ) : (
          <FoldHeader label={label} count={count} open={fold.open} onToggle={fold.onToggle} controls={id} trailing={trailing} />
        )}
        {fold === undefined ? (
          <div id={id}>{children}</div>
        ) : (
          <Collapse open={fold.open}>
            <div id={id}>{children}</div>
          </Collapse>
        )}
      </section>
    );
  };
}

// ── Rows ──────────────────────────────────────────────────────────────────────────────────────────

interface PaneRowProps {
  /** The row's DOM id, for the summary line's jump. Shell rows need none. */
  id: string | undefined;
  pane: AgentView;
  active: boolean;
  onSelect: (pane: AgentView) => void;
}

// ONE NAME, ONE PLACE (lib/pane-name.ts), the same way round as every other row in the app: the
// pane's name on line 1, where it sits underneath. The place's two halves stay separate spans so the
// TAB survives truncation: eight rows of one project all begin with the same nine characters, and
// the tab is the only one of the two that discriminates.
function PaneRow(handle: Handle<PaneRowProps>) {
  return () => {
    const { id, pane, active } = handle.props;
    const isShell = pane.kind === "shell";
    const name = paneName(pane);
    const { space, tab } = panePlaceParts(pane);
    return (
      <button
        id={id}
        type="button"
        data-testid="switcher-row"
        data-pane-id={pane.paneId}
        aria-current={active ? "page" : undefined}
        mix={on("click", () => handle.props.onSelect(handle.props.pane))}
        class={cn(
          // The border is in the base string and transparent at rest, so an alarm edge only ever
          // changes the paint. This is a gap list, not a divide-y one, so four sides is the right mark.
          "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors",
          active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
          // The switcher is where you jump TO the thing that needs you, so it must be able to SHOW
          // that. The border applies even to the ACTIVE row so the two cues compose; only the fill
          // is withheld, because two backgrounds cannot both win.
          isAttention(pane.status) && "border-status-blocked/40",
          !active && isAttention(pane.status) && "bg-status-blocked/5",
        )}
      >
        {isShell ? <Icon icon={SquareTerminal} class="size-3.5 shrink-0 text-muted-foreground" /> : <AgentIcon agent={pane.agent} class="size-5" />}
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-baseline gap-1">
            <span class="min-w-0 truncate text-sm font-medium">{name}</span>
            {/* The cache reading trails the name, `row` not `button`: the whole row is already one. */}
            <CacheChip cache={pane.cache} variant="row" class="ml-auto shrink-0" />
          </div>
          <div class="flex min-w-0 items-baseline gap-1 text-[11px] text-muted-foreground">
            <span class="max-w-[45%] shrink truncate">{space}</span>
            {tab && (
              <>
                {/* The place's own separator, because a space CONTAINS a tab. */}
                <span class="shrink-0 text-muted-foreground/60" aria-hidden="true">
                  ›
                </span>
                {/* A positional tab (`tab 2`) reads a shade lighter, the same ink every surface gives it. */}
                <span class={cn("min-w-0 flex-1 truncate", tab.positional && "text-muted-foreground/70")}>{tab.text}</span>
              </>
            )}
          </div>
        </div>
      </button>
    );
  };
}

interface LaunchRowProps {
  launcher: Launcher;
  home: string;
  busy: boolean;
  /** The §10.3 write refusal for this scope, or undefined when the row may be tapped. */
  refusal: string | undefined;
  onLaunch: (command: string) => void;
}

// A launcher row, styled like PaneRow so it sits in the same list. A Play icon that swaps for a
// spinner while busy, the label, and the command underneath in mono: a sheet row is a full screen
// wide, so showing the command costs nothing and says what you are about to run.
function LaunchRow(handle: Handle<LaunchRowProps>) {
  return () => {
    const { launcher, home, busy, refusal } = handle.props;
    // A fixed folder reads shortened under home; absent reads "here" (opens beside this pane).
    const suffix = launcher.cwd !== undefined ? shortenHome(launcher.cwd, home) : t("chat.switcher.launch.here");
    return (
      <button
        type="button"
        data-testid="switcher-launch"
        disabled={busy || refusal !== undefined}
        aria-label={refusal}
        title={refusal}
        mix={on("click", () => handle.props.onLaunch(handle.props.launcher.command))}
        // min-h-11 (44px) keeps the touch floor though the two-line label is shorter.
        class="flex min-h-11 w-full items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-60"
      >
        {busy ? (
          <Icon icon={LoaderCircle} class="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : (
          <Icon icon={Play} class="size-4 shrink-0 text-muted-foreground" />
        )}
        <span class="flex min-w-0 flex-col">
          <span class="flex min-w-0 items-baseline gap-1.5">
            <span class="truncate text-sm font-medium">{launcher.label}</span>
            <span class="shrink-0 truncate font-mono text-xs text-muted-foreground">{suffix}</span>
          </span>
          {/* The command is operator-authored text going into a text node, never markup. */}
          <span class="truncate font-mono text-xs text-muted-foreground">{launcher.command}</span>
        </span>
      </button>
    );
  };
}
