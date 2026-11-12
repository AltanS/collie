
import { useEffect, useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import { CacheChip } from "@/components/cache-chip";
import { HostChip } from "@/components/host-chip";
import { PaneOrderToggle } from "@/components/pane-order-toggle";
import { TRICK_ROW_DRAWN, TrickSessionRow } from "@/components/trick-session";
import { SessionFilterEmpty, SessionFilterField } from "@/components/session-filter-field";
import { MatchText } from "@/components/ui/match-text";
import { SectionHeader } from "@/components/section-header";
import { StatusCounts, StatusSummaryLine } from "@/components/status-counts";
import { pinnedRows, shownGroups } from "@/lib/dash-view";
import { paneRowKey } from "@/lib/hosts";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { inRankOrder, type PaneOrder } from "@/lib/pane-order";
import {
  byScore,
  filterOffered,
  matchPanes,
  PANE_FILTER,
  type PaneField,
  type PaneFilterHidden,
  type PaneFilterLevel,
  type PaneFilterOrder,
  type PaneMatch,
  viaLabelKey,
} from "@/lib/pane-filter";
import { pinMatcher, type Pin } from "@/lib/pins";
import { isTrickPane } from "@/lib/tricks/places";
import { paneName, panePlaceParts } from "@/lib/pane-name";
import { paneSubtitle } from "@/lib/pane-marks";
import { PaneBadge } from "@/components/pane-badge";
import { PaneGlyph } from "@/components/ui/pane-glyph";
import { UnseenMark } from "@/components/ui/unseen-mark";
import { shortenHome } from "@/lib/shorten-home";
import { bucketOf, isAttention, isUnseen, worstTriage, type TriageKey } from "@/lib/triage";
import type { AgentStatus, AgentView, Launcher, ServerSummary, SessionSummary, TabView, WorkspaceView } from "@/lib/types";
import type { Scope } from "@/lib/scope";
import { t } from "@/lib/i18n";
import { useFrozenRanks } from "@/hooks/use-frozen-ranks";
import { useLocale } from "@/hooks/use-locale";
import { Icon } from "@/components/icons/icon";

interface ThreadSidebarProps {
  agents: AgentView[];
  /** Bare shell panes (no agent) — listed in a trailing "Shells" group so fresh spaces are reachable. */
  shellPanes?: AgentView[];
  /**
   * The open pane's full row identity ({@link paneRowKey}), never its bare id. `w1:p1` names a
   * different terminal on every machine in a crew, so on a widened switcher list two rows can
   * answer to the same id — comparing ids alone would mark BOTH as current. Pass `paneRowKey` of
   * the pane you're actually in (agent-chat.tsx already computes this for its own "elsewhere needs
   * you" check).
   */
  currentPaneKey: string;
  /**
   * Open a row. Takes the PANE, not its id — the same reason `agent-list.tsx`'s `onOpen` does: a
   * pane id is unique only within one machine, so an id alone cannot say which row was tapped.
   */
  onSelect: (pane: AgentView) => void;
  /**
   * The trick sessions (M94 slice 03, `HomeData.trickSessions`), listed in a trailing Tricks section in the
   * Dashboard's own row, with no status mark. Absent or empty: no section. They never enter the
   * pane lists above, their counts or their order.
   */
  trickSessions?: readonly AgentView[];
  /** Open a trick session. Absent: the Tricks section is not drawn. */
  onSelectTrick?: (pane: AgentView) => void;
  /** The raw tab list, for the multiplexer's own tab order inside a workspace (lib/pane-groups.ts). */
  tabs?: readonly TabView[];
  /** The snapshot's machine list, for the order machines run in: the lead first. */
  servers?: readonly ServerSummary[] | undefined;
  /**
   * The snapshot's spaces (`root.workspaces`). With them a linked git worktree folds under its open
   * root workspace, as on the dashboard, and one whose root is not open is headed `repo › slug`
   * (issue #666). Omit and every workspace stays its own group.
   */
  workspaces?: readonly WorkspaceView[] | undefined;
  /** The view's address (`?h=` and `?s=`), so `workspaces` is matched to the session it describes. */
  scope?: Scope | undefined;
  /** The snapshot's session registry, to find each machine's primary session when matching `workspaces`. */
  sessions?: readonly SessionSummary[] | undefined;
  /** Whether the Shells section is expanded, and how to fold it. Omit to leave it always open. */
  shellsOpen?: boolean;
  onShellsOpenChange?: (open: boolean) => void;
  /**
   * This device's pins (lib/pins.ts, ADR 0070). A Pinned section then leads, under the summary line,
   * in the dashboard's place order, and each pinned pane leaves its workspace section or Shells, so
   * it is listed once. Omit, or pass none, and the sheet renders as it did.
   */
  pins?: readonly Pin[];
  /**
   * The operator's own launcher rows (`launchers.toml`). A trailing "Launch" section renders only
   * when this is non-empty AND `onLaunch` is given, since the caller (agent-chat) withholds `onLaunch` on
   * a read-only device, which is what keeps a write this device cannot make from being offered here.
   */
  launchers?: readonly Launcher[];
  /** The bridge's own home dir, for shortening a row's fixed `cwd` with a leading `~`. */
  launchersHome?: string;
  /** Fired with the row's command. The caller owns the write (useSpaceActions().launch). */
  onLaunch?: (command: string) => void;
  /** Commands whose launch is still in flight; those rows are disabled and say so. */
  launching?: ReadonlySet<string>;
  /** The §10.3 refusal for this sheet's scope, when the host it would launch on refuses writes. */
  launchRefusal?: string;
  /** Whether the Launch section is expanded, and how to fold it. Omit to leave it always open. */
  launchOpen?: boolean;
  onLaunchOpenChange?: (open: boolean) => void;
  /**
   * Which way the rows run: `place` (the default, and ADR 0063's order) or `activity`. Activity
   * folds the workspace sections and Shells into ONE list, newest first.
   */
  order?: PaneOrder;
  /**
   * Store a new order. Given, the sheet draws the Place/Activity toggle above the rows; withheld,
   * it draws no control and keeps whatever `order` says — which is how a list with nowhere to store
   * the answer avoids offering a choice that would not survive the next render.
   */
  onOrderChange?: (order: PaneOrder) => void;
  /** Override the list container padding (e.g. flush inside a bottom sheet). */
  className?: string;
  /**
   * The large screen's standing sidebar (ADR 0120), not the switcher sheet: rows on a 16px inset with
   * more air, the space headings in the quiet voice (muted, the name's own case), and badges in the
   * muted ink, so the pane's name is the one thing in full ink.
   */
  roomy?: boolean;
  /**
   * The filter's three switches (`PANE_FILTER` in lib/pane-filter.ts): how a term matches, whether a
   * query keeps the list's order or ranks it, and whether a field the row does not draw is searched.
   * Props so the playground round can draw the variants side by side; the app passes none.
   */
  filterLevel?: PaneFilterLevel;
  filterOrder?: PaneFilterOrder;
  filterHidden?: PaneFilterHidden;
  /**
   * Where the filter block sticks and how far it bleeds, which only the scroller's owner knows: the
   * sheet passes `SHEET_BODY_STICKY` (under its own sticky head), the large screen's sidebar its
   * gutter. Default `top-0`, the top of the scroller.
   */
  filterClassName?: string;
  /** The query the field starts with. The app passes none: the query starts empty and is never stored. */
  initialQuery?: string;
}

// The pane switcher behind the swipe-up "Switch pane" sheet: every agent pane under the WORKSPACE it
// lives in, in the dashboard's own fixed order (lib/pane-groups.ts, `order: "fixed"`), then any bare
// shell panes under a trailing "Shells" group, with the open one highlighted. Switching is the ONLY
// action here — closing a pane lives in the pane pill's long-press sheet (with its own confirm), so a
// fat-thumbed switch can never destroy a pane.
//
// NOTHING HERE MOVES WHEN A PANE CHANGES STATE (ADR 0063). This sheet used to sort into the triage
// sections (Needs you, Ready, Working, Recent), so a row changed section, and therefore place, every
// time its agent took a turn: the row the thumb was reaching for was elsewhere by the time it landed,
// and on this sheet a wrong tap opens another terminal. Urgency is a MARK now, exactly as on the
// dashboard: the row's alarm edge, the lit heading, and one summary line on top that counts what
// needs you and jumps to the first of it.
//
// THE ORDER IS THE OPERATOR'S, AND IT STILL DOES NOT MOVE (ADR 0071). Place order is the default and
// is unchanged. Activity and Cache are the alternatives ADR 0063's closing clause allows, "a toggle
// the operator taps and watches": each reads the clock once, when the sheet opens, and holds that
// reading until the operator taps again. So the sentence above survives the new settings rather than
// being weakened by them. A pane that finishes a turn while the sheet is up still repaints where it
// stands, and so does one whose cache window ticks down under the reader's thumb.
//
// The two long tails still fold: 30-odd bare shells, and the Launch rows, using the dashboard's own
// header primitive and remembering it. In either ranked order the sections and the Shells fold give
// way to one list, for the reason at `rankedRows`.
//
// This device's pinned panes lead the sheet in a Pinned section (ADR 0070), in the dashboard's place
// order, each listed once. The sheet stays switch-only: pinning lives in the pane menu.
//
// THE FILTER (M97). Above five session rows a filter field leads the list, sticky at the top of its
// scroller (lib/pane-filter.ts holds the model, session-filter-field.tsx the field). A query keeps
// Pinned, the space sections, Shells and Tricks in their order and takes out the rows that do not match
// and the sections left empty. The Tricks group is one more group of session rows (M97 decision 11):
// its rows count toward the five, match by the fields a trick row draws, and leave like any other. A
// folded Shells opens while a query is set, without writing the stored fold; the Launch rows, which
// are not sessions, hide. The matched letters are marked in place (`MatchText`), and a row that
// matched only in a field it does not draw (its branch, its folder, its agent, its machine) says that
// field on its second line instead of its place, in the same line box.
// Rows leave and come back with no animation: that is a shift the operator causes by typing and is
// watching, the first case DESIGN.md §2 allows ("a shift the operator caused directly and is
// watching"), as the Spaces and Files filters already do; §11's `Collapse` rule is about a state
// arriving, not about a list under the operator's own filter. The block itself is always mounted
// while the list is long enough, so the field never pops in under a thumb. With the field empty the
// list below the block is exactly what it was before the filter existed.
// A module-level empty list, not a `= []` default in the parameter list: a fresh array literal on
// every render is a new reference, which defeats memoisation downstream for no benefit here.
const NO_PANES: AgentView[] = [];
const NO_LAUNCHERS: readonly Launcher[] = [];
const NO_PINS: readonly Pin[] = [];

/** The buckets that mean "a human is required here" — the same two the dashboard's line counts. */
const URGENT: ReadonlySet<TriageKey> = new Set<TriageKey>(["needs", "ready"]);

/** A DOM id for a pane row, so the summary line can scroll to it and focus it. */
function rowDomId(pane: AgentView): string {
  return `switch-row-${paneRowKey(pane).replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

/** Scroll a row into view and give it the focus, for the summary line's jump. */
function jumpTo(pane: AgentView): void {
  const row = document.getElementById(rowDomId(pane));
  row?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  row?.focus({ preventScroll: true });
}

/** The switcher row draws the name, the space and the tab as text; the machine is a glyph only. */
const SWITCHER_DRAWN: ReadonlySet<PaneField> = new Set<PaneField>(["name", "space", "tab"]);

export function ThreadSidebar({
  agents,
  shellPanes = NO_PANES,
  currentPaneKey,
  onSelect,
  trickSessions = NO_PANES,
  onSelectTrick,
  tabs,
  servers,
  workspaces,
  scope,
  sessions,
  shellsOpen = true,
  onShellsOpenChange,
  pins = NO_PINS,
  launchers = NO_LAUNCHERS,
  launchersHome = "",
  onLaunch,
  launching,
  launchRefusal,
  launchOpen = true,
  onLaunchOpenChange,
  order = "place",
  onOrderChange,
  className,
  roomy = false,
  filterLevel = PANE_FILTER.level,
  filterOrder = PANE_FILTER.order,
  filterHidden = PANE_FILTER.hidden,
  filterClassName = "top-0",
  initialQuery = "",
}: ThreadSidebarProps) {
  useLocale();
  // THE ORDER, AND WHY IT IS READ ONCE: see `useFrozenRanks` and the long note below. Called here, above
  // the early return, because a hook cannot sit behind one.
  const { ranks, reread } = useFrozenRanks(order, [...agents, ...shellPanes]);
  const showLaunch = launchers.length > 0 && onLaunch !== undefined;
  const noPanes = agents.length === 0 && shellPanes.length === 0;
  const showTricks = trickSessions.length > 0 && onSelectTrick !== undefined;
  // The trick rows the list draws: none while the Tricks group is not drawn, so a list that cannot
  // open a trick session neither counts nor searches one.
  const trickRows = showTricks ? trickSessions : NO_PANES;

  // THE FILTER'S QUERY is this component's state, so it lives exactly as long as the list: the sheet
  // unmounts on close (ui/sheet.tsx returns null), and the large screen's sidebar unmounts this list
  // when it closes to the rail. Nothing is stored on the device. A list too short to be offered the
  // field filters nothing, whatever was typed before it shrank.
  const [query, setQuery] = useState(initialQuery);
  const total = agents.length + shellPanes.length + trickRows.length;
  const offered = filterOffered(total);
  const activeQuery = offered ? query : "";
  const hits = useMemo(() => {
    const options = { level: filterLevel, hidden: filterHidden, ctx: { servers } };
    const paneHits = matchPanes([...agents, ...shellPanes], activeQuery, { ...options, drawn: SWITCHER_DRAWN });
    if (paneHits === null || trickRows.length === 0) return paneHits;
    // A trick row draws only its name, so a match in its space, tab or trick id is said on line 2.
    const trickHits = matchPanes(trickRows, activeQuery, { ...options, drawn: TRICK_ROW_DRAWN });
    return new Map([...paneHits, ...(trickHits ?? [])]);
  }, [agents, shellPanes, trickRows, activeQuery, filterLevel, filterHidden, servers]);
  // The summary line's jump to a row the query hides: the query is cleared first, and the jump runs
  // once the row is back in the list.
  const [pendingJump, setPendingJump] = useState<AgentView | null>(null);
  useEffect(() => {
    if (pendingJump === null) return;
    jumpTo(pendingJump);
    setPendingJump(null);
  }, [pendingJump]);

  // An operator with no panes but a launchers.toml still has something to reach in here, so the
  // empty-panes text and the Launch section coexist rather than the text winning outright.
  if (noPanes && !showLaunch && !showTricks) {
    return (
      <div className="px-4 py-12 text-center text-sm text-muted-foreground">
        {t("home.empty.noAgents")}
      </div>
    );
  }

  // The dashboard's grouping, so the switcher and the dashboard list the same panes in the same place.
  const groupOptions = { order: "fixed" as const, tabs, servers, workspaces, scope, sessions };
  const groups = groupPanesByWorkspace(agents, [], groupOptions);
  // PINNED LEADS (ADR 0070): the dashboard's place order over agents AND shells (a shell sits after
  // its tab's agents, as on the dashboard), so the two surfaces agree by construction. Each pinned
  // pane then leaves its workspace section or Shells: listed once. A workspace section left with no
  // rows is dropped, as on the dashboard; its heading would count panes listed elsewhere.
  const isPinned = pinMatcher(pins);
  const pinned =
    pins.length === 0
      ? NO_PANES
      : pinnedRows(groupPanesByWorkspace(agents, shellPanes, groupOptions), isPinned);
  const sections = shownGroups(groups, false, isPinned);
  const shellRows = pins.length === 0 ? shellPanes : shellPanes.filter((p) => !isPinned(p));

  // ── THE ORDER, AND WHY IT IS READ ONCE ───────────────────────────────────────
  // ADR 0063 took status out of every list because a row that moves while its state changes is a row
  // the thumb misses, and on THIS sheet a missed tap opens another terminal. Its closing clause
  // leaves one door open: an order the operator asks for and watches. ADR 0071 walks through it.
  //
  // So activity order reads the clock ONCE, when the sheet opens, and draws from that reading until
  // the operator taps the toggle. A pane that finishes a turn while the sheet is up repaints where
  // it stands; it does not climb past the row a thumb is already reaching for. The sheet unmounts on
  // close (ui/sheet.tsx returns null), so the next open is a fresh reading by construction, and the
  // one thing that re-reads while it is open is the operator's own tap.
  //
  // The reading itself lives in `hooks/use-frozen-ranks.ts`, shared with the dashboard, so the two
  // surfaces keep the one promise the one way. A tap on the toggle, the segment already selected
  // included, asks for a new reading; nothing else does.
  const pinnedAll = inRankOrder(pinned, ranks);
  // ONE LIST IN ACTIVITY ORDER: every workspace section and the Shells fold together, because "when
  // did anything last happen here" is not a question a workspace heading can answer, and a shell you
  // used a minute ago has to be able to outrank an agent you have not opened all day. The fold goes
  // with the sections and is not missed: the long tail it protected against is precisely what sinks
  // to the bottom once the newest rows lead.
  // Place keeps its workspace sections; BOTH ranked orders collapse to one list, for the same reason:
  // a rank crosses every workspace, and a heading cannot answer a question asked across all of them.
  const ranked = order !== "place";
  const rankedAll = ranked
    ? inRankOrder([...sections.flatMap((g) => g.rows), ...shellRows], ranks)
    : NO_PANES;

  const urgent = agents.filter((a) => URGENT.has(bucketOf(a)));
  const isUrgent = (a: AgentView) => URGENT.has(bucketOf(a));
  // The first urgent row in DISPLAY order, not in the order the list arrived in: in Pinned when a
  // pinned pane needs you, and in whichever order the rows below it are running in.
  const firstUrgent = [
    ...pinnedAll,
    ...(ranked ? rankedAll : sections.flatMap((g) => g.rows)),
  ].find(isUrgent);

  // ── WHAT A QUERY LEAVES ─────────────────────────────────────────────────────
  // With no query (`hits` null) every list below is the very array it was before the filter, so the
  // rows render exactly as they did. With one, each list keeps its order and loses the rows that do
  // not match; a section left with no row goes with its heading. In a ranked order the one list is
  // filtered in place. `best` instead draws one flat list, best match first, ties in place order.
  const keep = (p: AgentView) => hits === null || hits.has(paneRowKey(p));
  const pinnedShown = hits === null ? pinnedAll : pinnedAll.filter(keep);
  const rankedRows = hits === null ? rankedAll : rankedAll.filter(keep);
  const sectionsShown =
    hits === null
      ? sections
      : sections.map((g) => ({ ...g, rows: g.rows.filter(keep) })).filter((g) => g.rows.length > 0);
  const shellsShown = hits === null ? shellRows : shellRows.filter(keep);
  const bestRows =
    hits !== null && filterOrder === "best"
      ? byScore([...pinned, ...sections.flatMap((g) => g.rows), ...shellRows, ...trickRows], hits)
      : null;
  // The Tricks group trails every order; in best-first its rows are in the one flat list instead.
  const trickShown = bestRows !== null ? NO_PANES : hits === null ? trickRows : trickRows.filter(keep);
  const shownRows =
    bestRows ?? [
      ...pinnedShown,
      ...(ranked ? rankedRows : [...sectionsShown.flatMap((g) => g.rows), ...shellsShown]),
      ...trickShown,
    ];
  const hitOf = (p: AgentView): PaneMatch | undefined => hits?.get(paneRowKey(p));

  // The jump goes to the first urgent row the list SHOWS; when the query hides every urgent row, it
  // clears the query and jumps once the rows are back. The line's count stays the whole list's.
  const firstUrgentShown = hits === null ? firstUrgent : shownRows.find(isUrgent);
  const onJump =
    firstUrgent === undefined
      ? undefined
      : firstUrgentShown !== undefined
        ? () => jumpTo(firstUrgentShown)
        : () => {
            setQuery("");
            setPendingJump(firstUrgent);
          };
  // Enter, or the Go key: switch to the first row shown. Only with a query, so a Go on an empty field
  // never switches panes by accident.
  const openTrick = (pane: AgentView) => onSelectTrick?.(pane);
  const goFirst = () => {
    const first = hits === null ? undefined : shownRows[0];
    if (first === undefined) return;
    if (isTrickPane(first)) openTrick(first);
    else onSelect(first);
  };
  const trickRow = (pane: AgentView) => (
    <TrickSessionRow
      key={pane.paneId}
      pane={pane}
      variant="switch"
      active={pane.paneId === currentPaneKey}
      onOpen={openTrick}
      match={hitOf(pane)}
    />
  );
  // A trick row reaches here only in best-first order, where every matched row shares one flat list.
  const row = (a: AgentView) =>
    isTrickPane(a) ? (
      trickRow(a)
    ) : (
      <PaneRow
        key={paneRowKey(a)}
        id={rowDomId(a)}
        pane={a}
        active={paneRowKey(a) === currentPaneKey}
        onSelect={onSelect}
        roomy={roomy}
        match={hitOf(a)}
      />
    );

  return (
    <div className={cn("flex flex-col px-2 py-3", roomy ? "gap-6" : "gap-4", className)}>
      {/* The filter block: sticky at the top of the scroller, on the panel's own fill with the rule
          that closes it, above every row, and always mounted while the list is long enough. */}
      {offered && (
        <SessionFilterField
          query={query}
          onQuery={setQuery}
          shown={shownRows.length}
          total={total}
          onGo={goFirst}
          className={cn("sticky z-10 border-b border-rule bg-card py-2", filterClassName)}
        />
      )}
      {noPanes && (
        <p className="px-2 py-2 text-sm text-muted-foreground">{t("home.empty.noAgents")}</p>
      )}

      {/* ONE CHROME ROW, not two. The summary line is the alarm and keeps the left, where ADR 0063
          point 3 puts urgency; the order control takes the right as glyphs. Stacked, these cost two
          full rows plus a heading before the first pane, which on a phone was most of what the sheet
          had to give (reported 2026-09-30). The heading below still names the order in words, so
          dropping the labels here loses nothing a reader needs.

          The row is drawn while EITHER half has something, and the summary line keeps a slot of its
          own while there are agents, so the rows below never shift when the first pane needs you or
          the last one is answered. */}
      {(agents.length > 0 || (onOrderChange && !noPanes)) && (
        <div className={cn("flex items-center justify-between gap-2 px-2", roomy && "min-h-11")}>
          {agents.length > 0 ? (
            <StatusSummaryLine
              panes={urgent}
              allClear={firstUrgent === undefined}
              onJump={onJump}
              className="min-w-0 flex-1"
            />
          ) : (
            <span className="flex-1" />
          )}
          {onOrderChange && !noPanes && (
            <PaneOrderToggle
              order={order}
              onChange={(next) => {
                reread();
                onOrderChange(next);
              }}
              compact
              // The large screen's icon buttons are 20px glyphs in 44px boxes, these three too.
              {...(roomy ? { iconClassName: "size-5" } : {})}
            />
          )}
        </div>
      )}

      {bestRows !== null ? (
        // BEST MATCH FIRST (the playground's alternative order): one flat list with no heading, the
        // count line above already saying how many it holds.
        bestRows.length > 0 && (
          <div data-slot="switch-best" className={roomy ? ROW_RULES : undefined}>
            {bestRows.map(row)}
          </div>
        )
      ) : (
        <>
          {/* The Pinned section, in the section voice Shells and Launch wear, with no dot and no count,
              and it does not fold: a pin is the one thing this sheet was opened to reach. */}
          {pinnedShown.length > 0 && (
            <Section id="switch-pinned" roomy={roomy} headingId="switch-pinned-heading" label={t("home.pinned.title")}>
              {pinnedShown.map(row)}
            </Section>
          )}

          {ranked ? (
            // The one flat list. It keeps the workspace sections' own row ink and marks — a row still
            // wears its alarm edge and the place under its name — so only the ORDER differs from place
            // order, never what a row says about itself. No dot on the heading: the summary line above
            // already counts what needs you, and a heading over every pane would always carry one.
            //
            // The heading NAMES THE ORDER, which is what pays for the compact glyphs in the row above.
            rankedRows.length > 0 && (
              <Section
                roomy={roomy}
                id="switch-activity"
                label={t(order === "cache" ? "paneOrder.coldest" : "paneOrder.recent")}
                count={rankedRows.length}
                tone={roomy ? "quiet" : "strong"}
              >
                {rankedRows.map(row)}
              </Section>
            )
          ) : (
            <>
              {sectionsShown.map(({ group: g, rows }) => (
                <Section
                  roomy={roomy}
                  key={g.key}
                  id={`switch-ws-${g.key.replace(/[^A-Za-z0-9_-]/gu, "_")}`}
                  label={g.heading ?? g.label}
                  tone={roomy ? "quiet" : "strong"}
                  mark={worstTriage(g.panes) === "needs" ? "blocked" : undefined}
                  trailing={<StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />}
                >
                  {rows.map(row)}
                </Section>
              ))}

              {/* Under a query Shells is open and does not fold, so a match folded away is still
                  listed and the stored fold is never written by a filter. */}
              {shellsShown.length > 0 && (
                <Section
                  roomy={roomy}
                  id="switch-shells"
                  label={t("home.sidebar.shells")}
                  count={shellsShown.length}
                  dot="bg-status-unknown"
                  {...(onShellsOpenChange && hits === null ? { open: shellsOpen, onToggle: onShellsOpenChange } : {})}
                >
                  {shellsShown.map(row)}
                </Section>
              )}
            </>
          )}
        </>
      )}

      {/* The Tricks group (M94) after the sessions, outside their counts and order. Under a query its
          rows filter like any other group's, and an empty group leaves with its heading. */}
      {trickShown.length > 0 && (
        <Section roomy={roomy} id="switch-tricks" label={t("tricks.space.title")} count={trickShown.length} tone={roomy ? "quiet" : "strong"}>
          {trickShown.map(trickRow)}
        </Section>
      )}

      {/* Nothing matches: one line and the way out, in the list's place. */}
      {hits !== null && shownRows.length === 0 && (
        <SessionFilterEmpty query={activeQuery.trim()} onClear={() => setQuery("")} />
      )}

      {/* The Launch rows are not sessions: they hide while a query is set. */}
      {hits === null && launchers.length > 0 && onLaunch && (
        <Section
          roomy={roomy}
          id="switch-launch"
          label="Launch"
          count={launchers.length}
          dot="bg-status-unknown"
          {...(onLaunchOpenChange ? { open: launchOpen, onToggle: onLaunchOpenChange } : {})}
        >
          {launchers.map((launcher) => (
            <LaunchRow
              key={launcher.command}
              launcher={launcher}
              home={launchersHome}
              busy={!!launching?.has(launcher.command)}
              refusal={launchRefusal}
              onLaunch={onLaunch}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

// Uses the dashboard's own header primitive so the fold affordance is identical in both places —
// level 3 because the sheet's own title is the h2. Passing no `open`/`onToggle` renders a plain
// heading that does not fold, with nothing to press.
function Section({
  id,
  headingId,
  label,
  count,
  mark,
  dot,
  tone,
  trailing,
  open,
  onToggle,
  roomy,
  children,
}: {
  id: string;
  /** The heading's id. Given, the section takes its name from it (`aria-labelledby`). */
  headingId?: string;
  label: string;
  count?: number;
  /** The status mark beside the header. A workspace heading carries one only while a pane inside
   *  needs you, as on the dashboard. */
  mark?: AgentStatus | undefined;
  /** A plain status-palette bullet, for a section that is a kind of thing (Shells, Launch). */
  dot?: string | undefined;
  tone?: "muted" | "strong" | "quiet";
  trailing?: React.ReactNode;
  open?: boolean;
  onToggle?: (open: boolean) => void;
  /** The large screen's sidebar: a hairline between rows. */
  roomy: boolean;
  children: React.ReactNode;
}) {
  const foldable = open !== undefined && onToggle !== undefined;
  return (
    <section className="flex flex-col gap-0.5" aria-labelledby={headingId}>
      <SectionHeader
        level={3}
        label={label}
        className="px-2"
        {...(headingId !== undefined ? { id: headingId } : {})}
        {...(count !== undefined ? { count } : {})}
        {...(mark !== undefined ? { mark } : {})}
        {...(dot !== undefined ? { dot } : {})}
        {...(tone !== undefined ? { tone } : {})}
        {...(trailing !== undefined ? { trailing } : {})}
        {...(foldable ? { open, onToggle, controls: id } : {})}
      />
      {(!foldable || open) && (
        <div id={id} className={roomy ? ROW_RULES : undefined}>
          {children}
        </div>
      )}
    </section>
  );
}

// THE HAIRLINE BETWEEN ROWS (DESIGN.md §4: a boundary is drawn once). Each row after the first draws
// it on its own top edge, inside the 1px its transparent border already reserves, so it costs no
// height and never meets the alarm edge's colour. Inset to the rows' 16px text line.
const ROW_RULES =
  "[&>*+*]:relative [&>*+*]:before:pointer-events-none [&>*+*]:before:absolute [&>*+*]:before:inset-x-2 [&>*+*]:before:-top-px [&>*+*]:before:h-px [&>*+*]:before:bg-rule";

function PaneRow({
  id,
  pane,
  active,
  onSelect,
  roomy,
  match,
}: {
  /** The row's DOM id, for the summary line's jump. Every row has one, shells too. */
  id?: string;
  pane: AgentView;
  active: boolean;
  onSelect: (pane: AgentView) => void;
  /** The large screen's sidebar ({@link ThreadSidebarProps.roomy}). */
  roomy: boolean;
  /** How the filter's query matched this row (lib/pane-filter.ts). Absent with no query: the row is drawn as before. */
  match?: PaneMatch | undefined;
}) {
  const isShell = pane.kind === "shell";
  // ONE NAME, ONE PLACE (lib/pane-name.ts), the same way round as every other row in the app: the
  // pane's name on line 1, where it sits underneath. This row used to be the other way up — the
  // place bold on line 1, the name muted below — which made the switcher the one list where you
  // could not find a pane by the name you had just read on the dashboard. The place's two halves
  // stay separate spans so the TAB survives truncation: eight rows of one project all begin with the
  // same nine characters, and the tab is the only one of the two that discriminates.
  const name = paneName(pane);
  const { space, tab } = panePlaceParts(pane);
  const subtitle = paneSubtitle(pane);
  const marks = match?.hit.marks;
  // THE FIELD THAT MATCHED, when the row does not draw it: it takes line 2's place words, in the same
  // line box and the same ink, so the row keeps its height and the reason it is listed is on it.
  const via = match?.hit.via ?? null;
  const viaLabel = via === null ? null : viaLabelKey(via);
  return (
    <button
      id={id}
      type="button"
      // The row's full identity (paneRowKey), read back by a large screen's row gestures (a hold
      // opens "Open here" and "Open beside", a drag carries the row into the strip, ADR 0120). The
      // gestures sit on a host around this list, so the list itself takes only the tap.
      data-pane-key={paneRowKey(pane)}
      onClick={() => onSelect(pane)}
      aria-current={active ? "page" : undefined}
      className={cn(
        // The border is in the base string and transparent at rest, so an alarm edge only ever
        // changes the paint. Added by state it would pull the text 1px in and grow the row 2px,
        // which is the zig-zag every switcher row above and below it would then sit out of line
        // with. This is a gap list, not a divide-y one, so a four-sided edge is the right mark.
        "flex w-full min-w-0 items-center gap-2.5 rounded-lg border border-transparent text-left transition-colors",
        // The sidebar's 16px inset is the list's 8 plus the row's 8, and its 44px floor a little more air.
        roomy ? "min-h-11 px-2 py-2.5" : "px-2.5 py-2",
        active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 active:bg-muted",
        // The switcher is exactly where you jump TO the thing that needs you, so it must be able to
        // SHOW that across the whole row, not only in the mark on the logo. Staying denser than the
        // dashboard is fine; being unable to mark a blocked pane is not. (isAttention, so the rule
        // isn't re-derived here.)
        //
        // The border is applied even to the ACTIVE row, so the two cues compose: the pane you're in
        // AND blocked keeps both its accent fill and its alarm edge. Only the fill is withheld,
        // because two backgrounds can't both win.
        isAttention(pane.status) && "border-status-blocked/40",
        !active && isAttention(pane.status) && "bg-status-blocked/5",
      )}
    >
      {isShell ? (
        <Icon name="shell-pane" className="size-3.5 shrink-0 text-muted-foreground" />
      ) : (
        // EVERY ROW SAYS ITS OWN STATUS (issue #695): the mark on the logo's corner, as the closed rail
        // draws it. Before ADR 0063 the row's section said it. The heading's counts say how many panes
        // work or wait, not which ones, so four panes in one space left the reader to open each one.
        // The mark repaints and never moves the row. Its backing is the surface under it: the sidebar
        // and the sheet are both on `--card`, the current row on `--accent`. A shell row keeps the bare
        // glyph, as on the dashboard: nobody waits on a shell's status.
        <PaneGlyph pane={pane} className="size-5" markOn={active ? "bg-accent" : "bg-card"} named />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-1">
          <span className={cn("min-w-0 truncate text-sm font-medium", roomy && "leading-5", roomy && !active && "text-foreground")}>
            <MatchText text={name} ranges={marks?.name} />
          </span>
          <PaneBadge pane={pane} className={cn("shrink-0 self-center", roomy && "text-muted-foreground")} />
          {/* A finished pane nobody opened: the dashboard's square, after the name, so a row agrees with
              the heading's `■` count. The slot is kept on every agent row, so a name truncates at one
              width whether the mark is drawn or not (DESIGN.md §2). */}
          {!isShell && <UnseenMark on={isUnseen(pane)} reserve />}
          {/* The cache reading trails the name, same corner as the dashboard row (agent-card.tsx,
              via PaneMeta), but without PaneMeta's session chip. `row`, not `button` — the whole row
              is already a `<button>`, and a button cannot nest inside one. The machine is the glyph
              at the end of the place line below, not a chip here. */}
          <CacheChip cache={pane.cache} variant="row" className="ml-auto shrink-0" />
        </div>
        {/* `leading-4` on the large screen: a stated line box, so the second line always fits inside
            the row and its descenders are never clipped by the truncation. */}
        <div className={cn("flex min-w-0 items-baseline gap-1 text-[11px] text-muted-foreground", roomy && "leading-4")}>
          {via !== null && match !== undefined ? (
            <>
              {viaLabel !== null && <span className="shrink-0 text-muted-foreground/70">{t(viaLabel)}</span>}
              <span data-slot="pane-row-via" className="min-w-0 flex-1 truncate">
                <MatchText text={match.fields[via]} ranges={marks?.[via]} />
              </span>
            </>
          ) : (
            <>
              <span className="max-w-[45%] shrink truncate">
                <MatchText text={space} ranges={marks?.space} />
              </span>
              {tab && (
                <>
                  {/* The place's own separator (PLACE_SEP), because a space CONTAINS a tab. */}
                  <span className="shrink-0 text-muted-foreground/60" aria-hidden>
                    ›
                  </span>
                  {/* A positional tab (`tabTitle`'s `tab 2`) reads a shade lighter, the same ink every
                      other surface gives it — it is the tab's position, never a name someone chose. */}
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate",
                      tab.positional && "text-muted-foreground/70",
                    )}
                  >
                    <MatchText text={tab.text} ranges={marks?.tab} />
                  </span>
                </>
              )}
            </>
          )}
          {/* WHICH MACHINE, as its tint and its glyph alone (Altan, 2026-10-21): on a crew this sheet
              lists every machine's panes, and in activity order there is no heading to say whose. A
              word would be a third thing on a line that already carries the place, so the machine is
              the one mark the dashboard row and the pane header already use for it, with the name in
              the label. Hidden on a one-machine install by HostChip's own rule, so a solo row is
              byte-identical. `self-center`: a glyph has no baseline to stand on. */}
          <HostChip host={pane.host} variant="glyph" className="ml-auto self-center" />
        </div>
        {/* A durable program's own line, when it set one (WIRE.md 7.11). A third line only for such a pane. */}
        {subtitle !== null && (
          <div data-slot="pane-row-subtitle" className="min-w-0 truncate text-[11px] text-muted-foreground">
            {subtitle}
          </div>
        )}
      </div>
    </button>
  );
}

// A launcher row, styled like PaneRow so it sits in the same list rather than reading as a second
// kind of control bolted onto the bottom. Same shape as the deleted LaunchSheet's rows: a Play icon
// that swaps for a spinner while the row is busy, the label, and the command underneath in mono.
// A sheet row is a full screen width, so showing the command costs nothing and tells you what you're
// about to run before you tap it.
function LaunchRow({
  launcher,
  home,
  busy,
  refusal,
  onLaunch,
}: {
  launcher: Launcher;
  home: string;
  busy: boolean;
  /** The §10.3 write refusal for this scope, or undefined when the row may be tapped. */
  refusal: string | undefined;
  onLaunch: (command: string) => void;
}) {
  // A fixed folder → that folder, shortened under home; absent → "here" (opens beside this pane,
  // wherever it is), which is the one thing the switcher can say that the dashboard's "here"
  // cannot — there, home is already implied and this suffix is withheld instead (launch-strip.tsx).
  const suffix = launcher.cwd !== undefined ? shortenHome(launcher.cwd, home) : t("chat.switcher.launch.here");
  const disabled = busy || refusal !== undefined;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={refusal}
      title={refusal}
      onClick={() => onLaunch(launcher.command)}
      // min-h-11 (44px) keeps the touch floor even though the two-line label is shorter than that.
      className="flex w-full min-h-11 items-center gap-2.5 rounded-lg border border-transparent px-2.5 py-2 text-left transition-colors hover:bg-muted/60 active:bg-muted disabled:opacity-60"
    >
      {busy ? (
        <Icon name="busy" className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden />
      ) : (
        <Icon name="launch" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium">{launcher.label}</span>
          <span className="shrink-0 truncate font-mono text-xs text-muted-foreground">{suffix}</span>
        </span>
        {/* The command is operator-authored text going into a text node, never markup. */}
        <span className="truncate font-mono text-xs text-muted-foreground">{launcher.command}</span>
      </span>
    </button>
  );
}
