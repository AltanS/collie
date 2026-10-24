import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRevalidator } from "react-router";
import { ChevronDown, ChevronUp, Columns2, PanelLeftClose, PanelLeftOpen, Plus, Replace, TerminalSquare } from "lucide-react";

import { ActionRow } from "@/components/action-sheet-rows";
import { AgentIcon } from "@/components/agent-icon";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { SettingsGear, useHeaderDock } from "@/components/app-header";
import { useHostHealth } from "@/components/crew-provider";
import { StatusDot } from "@/components/status-badge";
import { TabStrip } from "@/components/tab-strip";
import { ColumnControls, ColumnHeader, PaneColumnBody, columnFrame } from "@/components/strip-column";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { Wordmark } from "@/components/wordmark";
import { openForCount, useDashPrefs } from "@/hooks/use-dash-prefs";
import { useElementWidth } from "@/hooks/use-element-width";
import { useLocale } from "@/hooks/use-locale";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNav } from "@/hooks/use-nav";
import { useNoPromptsGuard } from "@/hooks/use-no-prompts-guard";
import type { FoldPosture } from "@/hooks/use-fold-posture";
import { useRootOverscrollLock } from "@/hooks/use-root-overscroll-lock";
import { useRowDrag, useVerticalSwipe, type DropTarget } from "@/hooks/use-row-drag";
import { tabCreateKey, useSpaceActions } from "@/hooks/use-spaces";
import { useStripSnap } from "@/hooks/use-strip-snap";
import { queueBeltIntent, type BeltIntent } from "@/lib/belt-intent";
import { writeRefusal } from "@/lib/host-health";
import { hostKey, hostName, isMultiHost, paneRowKey } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { useLaunchers } from "@/lib/launchers";
import { homePath, newPath, panePath } from "@/lib/nav";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { paneName } from "@/lib/pane-name";
import { isOpenBeside, queueOpenBeside, takeOpenBeside } from "@/lib/open-beside";
import { usePairing } from "@/lib/pairing";
import { setStatus } from "@/lib/status";
import { usePins } from "@/lib/pins";
import { useRootData } from "@/lib/route-data";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import { COLUMN_SNAP_CLASSES, STRIP_SNAP_CLASSES, leftmostWholeColumn, shouldFollowFocus } from "@/lib/strip-snap";
import { isReadOnly, statusLabel, type AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  allowedPresets,
  arrive,
  columnKeyOf,
  cycleWidth,
  dropIndexAt,
  hasWidthChoice,
  insertAt,
  isWideMode,
  landingOf,
  MIN_PANE_WIDTH,
  openBeside,
  openHere,
  PRESET_FRACTION,
  prune,
  RAIL_WIDTH,
  removeColumn,
  scopeOfPane,
  scrollTargetFor,
  shownPreset,
  SIDEBAR_WIDTH,
  spaceKeyOf,
  spacesInOrder,
  spaceSwipe,
  wholeColumnStart,
  type Places,
  type SpaceStrip,
} from "@/lib/wide-layout";
import { setSidebarOpen, setSpaceStrip, spaceStrip, useSidebarOpen, useSpaceStrips } from "@/lib/wide-layout-store";

// THE PANE SCREEN ON A LARGE SCREEN (ADR 0120). From 600px wide, and only on `pane/:paneId`, the
// screen is a sidebar beside a strip of columns, after the niri window manager: each space keeps its
// own row of panes, each column has its own width, the strip scrolls and snaps, and columns never
// shrink to fit. The vertical axis is spaces, moved by the space header.
//
// THE ROUTE STAYS THE TRUTH. The focused column is always the route's pane. Every act here either
// writes this device's layout (lib/wide-layout-store.ts) and then moves sideways to a pane with
// `nav.side`, or only writes the layout. On arrival the strip reconciles: a pane that is a column
// takes the focus, one that is not replaces the focused column (lib/wide-layout.ts `arrive`).
//
// ONE AgentChat. The focused column holds the route's own view, handed in as `focused`, with the one
// header docked at its top (app-header.tsx `useHeaderDock`). Every other column is a read-only view
// with its pane's belt and no reply box (strip-column.tsx).

/** A press that travels further than this is a scroll, not a tap. */
const TAP_SLOP_PX = 10;

/** On a column: its scrollers pass a sideways overscroll up to the strip (important, to win over the
 *  transcript list's own `overscroll-contain`). Vertical overscroll is untouched. */
const COLUMN_PASSES_X = "[&_*]:overscroll-x-auto!";

/** The mark's drawing in the rail's top row; its 44px tap box is the header's. */
const RAIL_MARK_PX = 26;

/** The mark's drawing in the open sidebar's top row, a step above the rail's; the row stays 48px (h-12). */
const SIDEBAR_MARK_PX = 36;

interface WideLayoutProps {
  widthClass: "medium" | "expanded";
  paneId: string;
  /** The route's scope. */
  scope: Scope;
  /** The route's pane, when the view knows it. */
  agent: AgentView | undefined;
  /** The route's own pane view, mounted in the focused column. */
  focused: ReactNode;
  /** A half-open foldable's layout (hooks/use-fold-posture.ts `usePaneFold`); "flat" elsewhere. */
  fold?: FoldPosture;
}

/** Whether a text field of this layout holds the document focus: the reply box, or any input,
 *  textarea or editable element inside the layout. A scroll never takes the focus from it. */
function isTypingInLayout(strip: HTMLElement): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  const root = strip.closest('[data-slot="wide-layout"]') ?? strip;
  if (!root.contains(active)) return false;
  return active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement || active.isContentEditable;
}

export function WideLayout({ widthClass, paneId, scope, agent, focused, fold = "flat" }: WideLayoutProps) {
  useLocale();
  const root = useRootData();
  const nav = useNav();
  const open = useSidebarOpen();
  const stored = useSpaceStrips();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");

  const places = useMemo<Places>(() => ({ scope, servers: root.servers, sessions: root.sessions }), [scope, root.servers, root.sessions]);
  const herd = useMemo(() => [...root.agents, ...root.shellPanes], [root.agents, root.shellPanes]);
  const byColumn = useMemo(() => new Map(herd.map((p) => [columnKeyOf(p, places), p])), [herd, places]);
  const byRow = useMemo(() => new Map(herd.map((p) => [paneRowKey(p), p])), [herd]);
  const spaces = useMemo(
    () => spacesInOrder(root.agents, root.shellPanes, { order: "fixed", tabs: root.tabs, servers: root.servers }),
    [root.agents, root.shellPanes, root.tabs, root.servers],
  );
  const spaceKeys = useMemo(() => spaces.map((g) => (g.panes[0] === undefined ? g.key : spaceKeyOf(g.panes[0], places))), [spaces, places]);

  const routeKey = agent ? columnKeyOf(agent, places) : paneScopeKey(scope, paneId);
  const spaceKey = agent ? spaceKeyOf(agent, places) : null;
  const spaceAt = spaceKey === null ? -1 : spaceKeys.indexOf(spaceKey);
  const space = spaceAt < 0 ? undefined : spaces[spaceAt];

  // The strip on screen: what this device stored for the space, less the panes a LIVE herd no longer
  // has, arrived at the route's pane. A herd from a saved copy prunes nothing. The route's own pane
  // stays live: a pane just started (`freshPane`) is not in the snapshot yet, and pruning it would
  // make the arrive below loop.
  const live = useMemo(
    () => new Set([...(space?.panes ?? []).map((p) => columnKeyOf(p, places)), routeKey]),
    [space, places, routeKey],
  );
  const kept = spaceKey === null ? undefined : stored.get(spaceKey);
  const strip: SpaceStrip = useMemo(() => {
    if (spaceKey === null) return { cols: [{ key: routeKey, preset: "full" }], focus: routeKey };
    const base = kept ?? spaceStrip(spaceKey);
    const pruned = root.error ? base : prune(base, live);
    // A pane started from this space's add sheet ("New agent in this space") opens beside the focus
    // rather than replacing it (lib/open-beside.ts).
    if (!pruned.cols.some((c) => c.key === routeKey) && isOpenBeside(spaceKey, routeKey)) return openBeside(pruned, routeKey);
    return arrive(pruned, routeKey);
  }, [spaceKey, kept, root.error, live, routeKey]);
  useEffect(() => {
    if (spaceKey === null || strip === kept) return;
    setSpaceStrip(spaceKey, strip);
    if (strip.focus === routeKey && isOpenBeside(spaceKey, routeKey)) takeOpenBeside(spaceKey);
  }, [spaceKey, strip, kept, routeKey]);

  const pathOf = useCallback((pane: AgentView) => panePath(pane.paneId, scopeOfPane(pane, places)), [places]);
  const goTo = useCallback((pane: AgentView) => nav.side(pathOf(pane)), [nav, pathOf]);

  // ── Strip width, wide mode ──────────────────────────────────────────────────────────────────
  const aside = open ? SIDEBAR_WIDTH[widthClass] : RAIL_WIDTH;
  const [measureStrip, stripWidth] = useElementWidth<HTMLDivElement>(Math.max(0, window.innerWidth - aside));
  const scroller = useRef<HTMLDivElement | null>(null);
  const setScroller = useCallback(
    (el: HTMLDivElement | null) => {
      scroller.current = el;
      measureStrip(el);
    },
    [measureStrip],
  );
  const book = fold === "book";
  // Folded as a book the segments set the widths, so the presets rest until the screen is flat.
  const wide = !book && isWideMode(stripWidth, MIN_PANE_WIDTH);
  const allowed = allowedPresets(stripWidth, MIN_PANE_WIDTH);
  const widthChoice = wide && hasWidthChoice(stripWidth, MIN_PANE_WIDTH);

  const shown = strip.cols.filter((c) => c.key === strip.focus || byColumn.has(c.key));
  const framed = shown.length > 1;
  const fractions = shown.map((c) => (wide ? PRESET_FRACTION[shownPreset(c.preset, allowed)] : 1));
  // THE ADD COLUMN ends every flat strip: a scroll or a swipe right always lands on it. It is at least
  // a pane wide, and as wide as the room the last column leaves, so the last column can still rest at
  // the left edge and one column at 1/2 has the rest of the strip as its add column. It is no column
  // of the strip: no focus, no frame, no count, never a landing for the focus that follows the view.
  const addWidth = book ? 0 : Math.max(MIN_PANE_WIDTH, (1 - (fractions.at(-1) ?? 1)) * stripWidth);
  const tail = stripWidth > 0 ? addWidth / stripWidth : 0;
  const focusAt = shown.findIndex((c) => c.key === strip.focus);
  // BOOK: exactly two columns, one per segment: the focused one and its right neighbour, or its left
  // one at the end. One column alone stands in the right segment, beside the full sidebar.
  const pairAt = focusAt < 0 ? 0 : Math.min(focusAt, Math.max(0, shown.length - 2));
  const visible = book ? shown.slice(pairAt, pairAt + 2) : shown;
  const bookPair = book && visible.length === 2;
  // The sidebar while folded is a presentation only: the stored choice is not touched.
  const sidebarShown = book ? !bookPair : open;

  // ── Acts ────────────────────────────────────────────────────────────────────────────────────
  const write = useCallback(
    (pane: AgentView, step: (s: SpaceStrip, key: string) => SpaceStrip) => {
      const key = spaceKeyOf(pane, places);
      const base = key === spaceKey ? strip : spaceStrip(key);
      setSpaceStrip(key, step(base, columnKeyOf(pane, places)));
      goTo(pane);
    },
    [places, spaceKey, strip, goTo],
  );
  const remove = (key: string) => {
    const next = removeColumn(strip, key);
    if (spaceKey === null || next === strip) return;
    setSpaceStrip(spaceKey, next);
    const target = key === strip.focus && next.focus !== null ? byColumn.get(next.focus) : undefined;
    if (target !== undefined) goTo(target);
  };
  const cycle = (key: string) => {
    if (spaceKey !== null) setSpaceStrip(spaceKey, cycleWidth(strip, key, allowed));
  };
  const moveSpace = (by: -1 | 1) => {
    const target = spaces[spaceAt + by];
    const targetKey = spaceKeys[spaceAt + by];
    if (target === undefined || targetKey === undefined) return;
    const keys = target.panes.map((p) => columnKeyOf(p, places));
    const landing = landingOf(spaceStrip(targetKey), keys);
    const pane = landing === null ? undefined : byColumn.get(landing);
    if (pane !== undefined) goTo(pane);
  };
  // A new space, and a new agent from the add slot, are the New page: it starts its agent in a new
  // space of the machine and session on screen. It takes no space to start in (lib/nav.ts `NewAt`).
  const toNew = () => nav.down(newPath({ machine: scope.host, session: scope.session }));
  // A new agent in THIS space is the same page told which space: it starts a new tab there (the launch
  // route's `paneId`), and the pane that comes back opens beside the focused column (lib/open-beside.ts).
  const toNewHere = () => {
    if (agent === undefined || spaceKey === null || space === undefined) return;
    queueOpenBeside(spaceKey, space.panes.map((p) => columnKeyOf(p, places)));
    nav.down(newPath({ machine: scope.host, beside: agent.paneId, session: scope.session }));
  };
  // THE SPACE'S TABS live in the space header, with the pane view's own handlers (agent-chat.tsx's tab
  // row, hidden in a strip): a tab opens its first pane, and "+" opens a new tab the way the row does.
  const { refused: notPaired } = usePairing();
  const readOnly = isReadOnly(root.device) || notPaired;
  const canWriteTabs = useCallback(() => !root.error, [root.error]);
  const { newTab, creatingTab } = useSpaceActions(canWriteTabs);
  // Rename and close from the chip's long-press sheet, wired as the pane view wires its own tab row
  // (agent-chat.tsx): a rename or a close of another tab only revalidates. Closing the tab that holds
  // the focused column must not leave the route on a pane that is gone, so the focus moves to a
  // neighbouring tab's pane (`nav.side`, ADR 0067: pane to pane), and only a space with nothing left
  // to land on goes up to Home.
  const revalidator = useRevalidator();
  const revalidate = () => void revalidator.revalidate();
  const closedTab = (tabId: string) => {
    if (agent === undefined || tabId !== agent.tabId) return revalidate();
    // Published before the move, as the pane view does: the tab you were in is gone either way.
    setStatus(t("space.tab.closed"), "info");
    // The strip's own order and neighbours: the next tab first, the previous only past the end, then
    // on in both directions, because a neighbour can be an empty tab with no pane to land on.
    const mine = root.tabs.filter((tab) => tab.workspaceId === agent.workspaceId && hostKey(tab) === hostKey(agent));
    const at = mine.findIndex((tab) => tab.tabId === tabId);
    for (const tab of [...mine.slice(at + 1), ...mine.slice(0, Math.max(at, 0)).toReversed()]) {
      const target = herd.find((p) => p.tabId === tab.tabId && p.workspaceId === agent.workspaceId && p.host === agent.host);
      if (target !== undefined) return goTo(target);
    }
    nav.up(homePath({ host: scope.host, session: scope.session }));
  };
  const toTab = (tabId: string) => {
    if (agent === undefined || tabId === agent.tabId) return;
    const target = herd.find((p) => p.tabId === tabId && p.host === agent.host);
    if (target !== undefined) goTo(target);
  };
  const onIntent = (pane: AgentView, intent: BeltIntent) => {
    queueBeltIntent(columnKeyOf(pane, places), intent);
    goTo(pane);
  };

  // ── Row gestures: the menu, the drag ────────────────────────────────────────────────────────
  const [menuRow, setMenuRow] = useState<string | null>(null);
  const menuPane = menuRow === null ? undefined : byRow.get(menuRow);
  const locate = useCallback(
    (x: number, y: number): DropTarget | null => {
      const node = scroller.current;
      if (node === null) return null;
      const r = node.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
      const cols = [...node.querySelectorAll<HTMLElement>("[data-col-index]")].map((c) => c.getBoundingClientRect());
      const { index, at } = dropIndexAt(
        x,
        cols.map((c) => c.left),
        cols.map((c) => c.width),
      );
      return { index, markerX: at - r.left + node.scrollLeft };
    },
    [],
  );
  const edgeScroll = useCallback((x: number, y: number) => {
    const node = scroller.current;
    if (node === null) return;
    const r = node.getBoundingClientRect();
    if (y < r.top || y > r.bottom) return;
    if (x >= r.left && x < r.left + 56) node.scrollLeft -= 14;
    else if (x <= r.right && x > r.right - 56) node.scrollLeft += 14;
  }, []);
  const { drag, hostProps } = useRowDrag({
    onMenu: setMenuRow,
    locate,
    edgeScroll,
    onDrop: (rowKey, index) => {
      const pane = byRow.get(rowKey);
      if (pane === undefined) return;
      // A boundary between the columns on screen, as an index into the stored strip.
      const at = shown[index] === undefined ? strip.cols.length : strip.cols.findIndex((c) => c.key === shown[index]?.key);
      // A pane of another space joins its own space's strip, beside that strip's focus.
      if (spaceKeyOf(pane, places) === spaceKey) write(pane, (s, key) => insertAt(s, key, at));
      else write(pane, openBeside);
    },
  });
  const dragPane = drag === null ? undefined : byRow.get(drag.key);

  // ── Scroll the focused column into view, and keep a whole column at the left edge ──────────
  const [view, setView] = useState({ start: 0, size: 1 });
  const measure = useCallback(() => {
    const node = scroller.current;
    if (node === null || node.scrollWidth === 0) return;
    setView({ start: node.scrollLeft / node.scrollWidth, size: Math.min(1, node.clientWidth / node.scrollWidth) });
  }, []);
  // The position line shows while the strip moves and fades out after it rests, like an overlay scroll bar.
  const [moving, setMoving] = useState(false);
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onStripScroll = useCallback(() => {
    measure();
    setMoving(true);
    clearTimeout(restTimer.current);
    restTimer.current = setTimeout(() => setMoving(false), 900);
  }, [measure]);
  useEffect(() => () => clearTimeout(restTimer.current), []);
  const signature = fractions.join(",");
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null || book) return;
    const cols = [...node.querySelectorAll<HTMLElement>("[data-col-index]")];
    const lefts = cols.map((c) => c.offsetLeft);
    const widths = cols.map((c) => c.offsetWidth);
    let to = scrollTargetFor(focusAt, lefts, widths, node.scrollLeft, node.clientWidth, node.scrollWidth);
    if (to === null) {
      const whole = wholeColumnStart(lefts, node.scrollLeft);
      const f = cols[focusAt];
      const keepsFocus = whole === null || f === undefined || (f.offsetLeft >= whole - 0.5 && f.offsetLeft + f.offsetWidth <= whole + node.clientWidth + 0.5);
      to = keepsFocus ? whole : (f?.offsetLeft ?? null);
    }
    if (to !== null) node.scrollTo?.({ left: to, behavior: reduced ? "auto" : "smooth" });
    measure();
  }, [focusAt, signature, stripWidth, reduced, measure, book]);

  // ── Wheel and trackpad settle on a column start; the focus follows the view, as in niri ─────
  // Touch is the browser's own momentum and mandatory snap. After a wheel gesture settles, a focused
  // column the view no longer shows whole hands the focus to the leftmost whole one. Folded as a book
  // the two columns are fixed, so nothing follows. While a text field of the layout (the reply box)
  // has the document focus nothing follows either, and it follows again from the first settle after blur.
  useStripSnap(scroller, {
    // The add column is a snap point too; a start past the end of the scroll range rests at the end.
    columnStarts: () => {
      const node = scroller.current;
      if (node === null) return [];
      const end = Math.max(0, node.scrollWidth - node.clientWidth);
      return [...node.querySelectorAll<HTMLElement>('[data-col-key], [data-slot="add-column"]')].map((c) => Math.min(c.offsetLeft, end));
    },
    reducedMotion: reduced,
    onSettled: (left) => {
      const node = scroller.current;
      if (node === null || book) return;
      // The person is typing: a scroll must not move the focus (and with it the reply box) from under them.
      if (isTypingInLayout(node)) return;
      const cols = [...node.querySelectorAll<HTMLElement>("[data-col-key]")].map((c) => ({
        key: c.dataset.colKey ?? "",
        start: c.offsetLeft,
        width: c.offsetWidth,
        focused: c.hasAttribute("data-focused"),
      }));
      const focusedBox = cols.find((c) => c.focused);
      const viewport = { left, width: node.clientWidth };
      if (focusedBox === undefined || !shouldFollowFocus(viewport, focusedBox)) return;
      const next = leftmostWholeColumn(viewport, cols);
      const pane = next === undefined ? undefined : byColumn.get(next);
      if (pane !== undefined) goTo(pane);
    },
  });
  // Desktop Chrome reads a sideways overscroll as history back; the layout owns the page while mounted.
  useRootOverscrollLock(true);

  // ── The one header, docked in the focused column; the mark in the sidebar's top row ─────────
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [mark, setMark] = useState<HTMLElement | null>(null);
  const sidebarOpen = useSidebarOpen();
  const trail = useHeaderDock({ row, mark, paper: "var(--card)", markSize: sidebarOpen ? SIDEBAR_MARK_PX : RAIL_MARK_PX });

  const press = useRef<{ x: number; y: number } | null>(null);
  const swipe = useVerticalSwipe((dx, dy) => {
    const by = spaceSwipe(dx, dy);
    if (by !== null) moveSpace(by);
  });
  const machine = isMultiHost(root.servers) && agent ? hostName(root.servers, agent.host) : undefined;

  // ── The add column's sheet: the space's other panes, to move here, and a new agent ──────────
  const [adding, setAdding] = useState(false);
  const inView = new Set(shown.map((c) => c.key));
  const offView = (space?.panes ?? []).filter((p) => !inView.has(columnKeyOf(p, places)));

  return (
    <div
      data-slot="wide-layout"
      data-width-class={widthClass}
      data-fold={fold}
      // No scroll bar anywhere in the layout: the position strip says where the strip is, and a bar on
      // every column and list would be a second, noisier answer.
      className="flex min-h-0 w-full flex-1 [&_*]:[scrollbar-width:none] [&_*::-webkit-scrollbar]:hidden"
    >
      <aside
        data-slot={sidebarShown ? "wide-sidebar" : "rail"}
        data-segment={book ? "left" : undefined}
        aria-label={t("wide.sidebar.label")}
        // Folded with one column, the sidebar fills the left segment; with two, it is the rail.
        className={cn("flex shrink-0 flex-col border-r border-rule bg-card", book && sidebarShown && "fold-left-full")}
        style={book && sidebarShown ? undefined : { width: sidebarShown ? SIDEBAR_WIDTH[widthClass] : RAIL_WIDTH }}
      >
        <SidebarTop open={sidebarShown} setMark={setMark} toggle={!book} />
        <div {...hostProps} className="min-h-0 flex-1 overflow-y-auto [-webkit-touch-callout:none]">
          {sidebarShown ? (
            <SidebarList agent={agent} paneId={paneId} scope={scope} onSelect={goTo} />
          ) : (
            <Rail spaces={spaces} hereKey={agent ? paneRowKey(agent) : null} onSelect={goTo} />
          )}
        </div>
        {/* NEW SPACE and SETTINGS, pinned under the list so both are one tap away, however long the
            list. The pane header has no gear; this is the large screen's way to Settings. */}
        <div
          data-slot="sidebar-foot"
          className={cn("flex shrink-0 items-center border-t border-rule", sidebarShown ? "gap-1 px-2 py-1" : "flex-col py-1")}
        >
          {sidebarShown ? (
            <Button variant="ghost" data-slot="new-space" className="h-11 min-w-0 flex-1 justify-start gap-2.5 px-2 text-sm font-medium" onClick={toNew}>
              <Plus className="size-5" aria-hidden />
              <span className="truncate">{t("wide.newSpace")}</span>
            </Button>
          ) : (
            <Button variant="ghost" size="lg" data-slot="new-space" className="size-11 px-0" aria-label={t("wide.newSpace")} onClick={toNew}>
              <Plus className="size-5" aria-hidden />
            </Button>
          )}
          <SettingsGear scope={scope} />
        </div>
      </aside>

      {/* The fold's own width, between the full sidebar and the one column (book, one column). */}
      {book && !bookPair && <span aria-hidden data-slot="fold-gutter" className="fold-gutter shrink-0" />}

      <div data-segment={book && !bookPair ? "right" : undefined} className="flex min-w-0 flex-1 flex-col">
        <div
          data-slot="space-header"
          {...swipe}
          className={cn("flex h-12 shrink-0 touch-none items-center gap-1 border-b border-rule bg-band-ground", bookPair ? "pr-1" : "pl-4 pr-1")}
        >
          {/* Folded with two columns, the header is cut at the fold like the strip under it: the name
              over the left column, the buttons over the right one, nothing on the hinge. */}
          <div className={cn("flex min-w-0 items-center", bookPair ? "fold-left-col pl-4" : "flex-1")}>
            {/* The bar's title: the space, in the face and weight of the pane names under it. */}
            <div data-slot="space-title" className="min-w-0 max-w-[45%] shrink-0 truncate text-sm font-semibold">
              {space?.label ?? ""}
              {machine !== undefined && <span className="font-normal text-muted-foreground"> · {machine}</span>}
            </div>
            {agent !== undefined ? (
              <TabStrip
                workspaceId={agent.workspaceId}
                host={agent.host}
                tabs={root.tabs}
                agents={root.agents}
                selected={agent.tabId}
                onSelect={(id) => {
                  if (id !== null) toTab(id);
                }}
                onNewTab={newTab}
                onNewStarters={() => nav.down(newPath({ machine: scope.host, pane: paneId, session: scope.session }))}
                creatingTab={creatingTab.has(tabCreateKey(agent.workspaceId, scope))}
                allowAll={false}
                scope={scope}
                readOnly={readOnly}
                savedCopy={root.error}
                onRenamed={revalidate}
                onClosed={closedTab}
                className="min-w-0 flex-1 bg-transparent"
              />
            ) : (
              <span className="flex-1" />
            )}
            {spaceAt >= 0 && (
              <span data-slot="space-position" className="shrink-0 px-2 text-xs tabular-nums text-muted-foreground">
                {t("wide.space.position", { index: spaceAt + 1, total: spaces.length })}
              </span>
            )}
          </div>
          {bookPair && <span aria-hidden className="fold-gutter shrink-0" />}
          {bookPair && <span aria-hidden className="flex-1" />}
          <Button variant="ghost" size="lg" className="size-11 px-0" aria-label={t("wide.space.previous")} disabled={spaceAt <= 0} onClick={() => moveSpace(-1)}>
            <ChevronUp className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="lg"
            className="size-11 px-0"
            aria-label={t("wide.space.next")}
            disabled={spaceAt < 0 || spaceAt >= spaces.length - 1}
            onClick={() => moveSpace(1)}
          >
            <ChevronDown className="size-5" />
          </Button>
        </div>

        {/* The strip and its position line share a box, so the line can float over the strip's top edge
            instead of taking a row of its own under it. */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            ref={setScroller}
            data-slot="strip"
            onScroll={onStripScroll}
            className={cn(
              "relative flex min-h-0 flex-1 overflow-y-hidden",
              book ? "overflow-x-hidden" : "overflow-x-auto",
              book || drag !== null ? "snap-none overscroll-x-contain" : STRIP_SNAP_CLASSES,
            )}
          >
            {/* One flat list, the gutter a sibling, so a column keeps its identity through a fold. */}
            {visible.flatMap((c, i) => {
              const isFocus = c.key === strip.focus;
              const pane = byColumn.get(c.key);
              const preset = widthChoice ? shownPreset(c.preset, allowed) : null;
              const controls = (
                <ColumnControls preset={preset} onCycle={() => cycle(c.key)} onRemove={() => remove(c.key)} removable={shown.length > 1} />
              );
              const segment = bookPair ? (i === 0 ? "left" : "right") : undefined;
              const column = (
                <section
                  key={c.key}
                  data-segment={segment}
                  data-col-index={i}
                  data-col-key={c.key}
                  data-focused={isFocus ? "" : undefined}
                  aria-label={pane ? paneName(pane) : undefined}
                  aria-current={isFocus && framed ? "true" : undefined}
                  className={cn(
                    "flex h-full shrink-0 border-r border-rule",
                    COLUMN_SNAP_CLASSES,
                    // A sideways wheel over a column must reach the strip. The transcript list is
                    // `overscroll-contain` on both axes for the phone, which stopped the chain inside
                    // the column, so every scroller in a column hands its x overscroll on. The strip
                    // contains it, and the page's own lock keeps Chrome's history back off.
                    COLUMN_PASSES_X,
                    segment === "left" && "fold-left-col",
                    segment === "right" && "fold-right-col",
                  )}
                  style={
                    segment !== undefined
                      ? undefined
                      : { flex: `0 0 ${book ? 100 : (fractions[i] ?? 1) * 100}%`, minWidth: wide ? MIN_PANE_WIDTH : undefined }
                  }
                  // A tap anywhere on a column without focus gives it the focus. A tap, not a press: a
                  // press would remount the column under the finger, and a drag is a scroll. A pill on
                  // the belt carries its own act and its own focus move (`onIntent`).
                  onPointerDown={(e) => {
                    press.current = { x: e.clientX, y: e.clientY };
                  }}
                  onPointerUp={(e) => {
                    const p = press.current;
                    press.current = null;
                    if (isFocus || pane === undefined || p === null) return;
                    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) return;
                    if (e.target instanceof Element && e.target.closest('[data-slot="chrome-block"] button, [data-slot="column-header"] button') !== null) return;
                    goTo(pane);
                  }}
                >
                  {/* THE FRAME: reserved on every column, drawn on the focused one while the strip shows more
                      than one, so a focus change recolours and moves nothing (DESIGN.md §2). */}
                  <div data-slot="column-frame" className={cn("relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background", columnFrame(isFocus, framed))}>
                    {isFocus ? (
                      <>
                        <div ref={setRow} data-slot="column-head" className="shrink-0" />
                        {trail !== null && agent !== undefined && createPortal(controls, trail)}
                        <div data-strip-focus className="flex min-h-0 flex-1 flex-col">
                          {focused}
                        </div>
                      </>
                    ) : pane !== undefined ? (
                      <>
                        <ColumnHeader pane={pane} controls={controls} onFocus={() => goTo(pane)} />
                        <PaneColumnBody
                          pane={pane}
                          scope={scopeOfPane(pane, places)}
                          onIntent={(intent) => onIntent(pane, intent)}
                          // Tabletop: only the focused pane's belt stands under the fold; the others show Chat.
                          belt={fold !== "tabletop"}
                        />
                      </>
                    ) : null}
                  </div>
                </section>
              );
              // The fold's gutter between the two columns of a book: no column stands on the hinge.
              return segment === "right" ? [<span key="fold-gutter" aria-hidden data-slot="fold-gutter" className="fold-gutter shrink-0" />, column] : [column];
            })}
            {!book && (
              <div data-slot="add-column" className={cn("flex h-full shrink-0 p-3", COLUMN_SNAP_CLASSES)} style={{ flex: `0 0 ${addWidth}px` }}>
                <div className="flex min-w-0 flex-1 items-center justify-center rounded-md border border-dashed border-rule">
                  {/* `sticky`: while only part of the add column is in view, the "+" moves along inside it
                      and stays in the visible part, at either edge of the strip. */}
                  <Button variant="ghost" data-slot="add-button" className="sticky inset-x-3 h-auto flex-col gap-2 px-3 py-2 text-sm text-muted-foreground" onClick={() => setAdding(true)}>
                    <span aria-hidden className="grid size-11 place-items-center rounded-md border border-rule bg-card text-foreground">
                      <Plus className="size-5" />
                    </span>
                    {t("wide.add.label")}
                  </Button>
                </div>
              </div>
            )}
            {drag?.drop != null && (
              <span aria-hidden data-slot="drop-bar" className="pointer-events-none absolute inset-y-0 z-20 w-1 bg-primary" style={{ left: drag.drop.markerX - 2 }} />
            )}
          </div>
          {!book && shown.length > 1 && <PositionStrip widths={fractions} focus={focusAt} view={view} tail={tail} moving={moving} />}
        </div>
      </div>

      {drag !== null && dragPane !== undefined && (
        <div
          aria-hidden
          data-slot="drag-ghost"
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border border-rule bg-card px-3 py-2 text-sm shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          <PaneGlyph pane={dragPane} />
          <span className="max-w-48 truncate">{paneName(dragPane)}</span>
        </div>
      )}

      {/* THIS space's panes the strip does not show, each to open as the last column, then a new agent. */}
      <BottomSheet open={adding} onClose={() => setAdding(false)} title={t("wide.add.label")}>
        <div className="flex flex-col py-1">
          {offView.map((p) => (
            <div key={paneRowKey(p)} data-slot="add-row" className="flex min-h-11 items-center gap-3 px-3 py-1">
              <StatusDot status={p.status} surface="bg-card" />
              <PaneGlyph pane={p} className="size-5" />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{paneName(p)}</span>
              <Button
                variant="outline"
                size="lg"
                className="shrink-0 text-sm"
                aria-label={`${t("wide.openHere")}: ${paneName(p)}`}
                onClick={() => {
                  setAdding(false);
                  // Here is where the add column stands: after the last column, which it becomes.
                  write(p, (s, key) => insertAt(s, key, s.cols.length));
                }}
              >
                {t("wide.openHere")}
              </Button>
            </div>
          ))}
          {agent !== undefined && space !== undefined && (
            <ActionRow
              icon={<Plus className="size-5" />}
              label={t("wide.add.newAgentHere")}
              onClick={() => {
                setAdding(false);
                toNewHere();
              }}
            />
          )}
          <ActionRow
            icon={<Plus className="size-5" />}
            label={t("wide.add.newAgent")}
            onClick={() => {
              setAdding(false);
              toNew();
            }}
          />
        </div>
      </BottomSheet>

      <BottomSheet open={menuPane !== undefined} onClose={() => setMenuRow(null)} title={menuPane ? paneName(menuPane) : undefined}>
        <div className="flex flex-col py-1">
          <ActionRow
            icon={<Replace className="size-5" />}
            label={t("wide.openHere")}
            onClick={() => {
              setMenuRow(null);
              if (menuPane) write(menuPane, openHere);
            }}
          />
          <ActionRow
            icon={<Columns2 className="size-5" />}
            label={t("wide.openBeside")}
            onClick={() => {
              setMenuRow(null);
              if (menuPane) write(menuPane, openBeside);
            }}
          />
        </div>
      </BottomSheet>
    </div>
  );
}

/** The sidebar's top row: the Collie mark, the word, and the toggle at the edge nearest the strip.
 *  As tall as the space header. The rail keeps the mark, with the toggle under it. */
function SidebarTop({ open, setMark, toggle: hasToggle }: { open: boolean; setMark: (el: HTMLElement | null) => void; toggle: boolean }) {
  // Folded as a book the segments decide, so there is no toggle to offer until the screen is flat.
  const toggle = hasToggle && (
    <Button
      variant="ghost"
      size="lg"
      data-slot="sidebar-toggle"
      className="size-11 shrink-0 px-0 text-muted-foreground"
      aria-label={t("wide.sidebar.label")}
      aria-expanded={open}
      onClick={() => setSidebarOpen(!open)}
    >
      {/* 20px, like every icon button around it (the order glyphs, the space chevrons). A lucide stroke
          scales with its drawing, so at 24px this glyph drew a 2px line beside their 1.7px ones and
          read as another icon set. */}
      {open ? <PanelLeftClose className="size-5 shrink-0" /> : <PanelLeftOpen className="size-5 shrink-0" />}
    </Button>
  );
  if (!open) {
    return (
      <div className="flex shrink-0 flex-col items-center">
        <div ref={setMark} data-slot="sidebar-mark" className="flex h-12 items-center justify-center" />
        <div className="flex h-12 items-center justify-center border-b border-rule">{toggle}</div>
      </div>
    );
  }
  return (
    // `pl-3`: the mark's box is 44px and its drawing SIDEBAR_MARK_PX (36), so the drawing starts
    // 12 + 4 = 16px in, on the list's inset; `-ml-0.5` pulls the word to the drawing past the box's air.
    // `wordmark-lockup`: the row is the pointer target that lights the name's suffix (index.css).
    <div className="wordmark-lockup flex h-12 shrink-0 items-center gap-1 border-b border-rule pl-3 pr-1">
      <div ref={setMark} data-slot="sidebar-mark" className="flex size-11 shrink-0 items-center justify-center" />
      {/* The product's name outside (components/wordmark.tsx): Collie in the text colour, PWA in the
          herd's three colours under a pointer. Not translated. */}
      {/* The word is part of the mark's button: a tap on it is the mark's tap (home, up a level,
          DESIGN.md §12). Hidden from the a11y tree and the tab order, so the row is ONE control. */}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden
        data-slot="sidebar-word"
        onClick={(e) => e.currentTarget.parentElement?.querySelector<HTMLButtonElement>('[data-slot="sidebar-mark"] button')?.click()}
        className="-ml-0.5 flex h-11 min-w-0 flex-1 items-center truncate text-left text-lg font-semibold text-foreground"
      >
        <Wordmark />
      </button>
      {toggle}
    </div>
  );
}

/** The real switcher list, with the switcher sheet's own wiring: pins, Shells, Launch. */
function SidebarList({ agent, paneId, scope, onSelect }: { agent: AgentView | undefined; paneId: string; scope: Scope; onSelect: (pane: AgentView) => void }) {
  const root = useRootData();
  const dash = useDashPrefs();
  const pins = usePins();
  const { launchers, home: launchersHome } = useLaunchers(scope);
  const { guard, sheet } = useNoPromptsGuard();
  const { refused: notPaired } = usePairing();
  const readOnly = isReadOnly(root.device) || notPaired;
  const hostBlock = writeRefusal(useHostHealth(agent?.host ?? scope.host));
  // A saved copy acts on nothing (M46 spec 11), so a launch from it is refused like every write.
  const canWrite = useCallback(() => !root.error, [root.error]);
  const { launch, launching } = useSpaceActions(canWrite);
  return (
    <>
      <ThreadSidebar
        agents={root.agents}
        shellPanes={root.shellPanes}
        currentPaneKey={agent ? paneRowKey(agent) : ""}
        onSelect={onSelect}
        tabs={root.tabs}
        servers={root.servers}
        pins={pins}
        shellsOpen={openForCount(dash.prefs.shellsOpen, root.shellPanes.length)}
        onShellsOpenChange={dash.setShellsOpen}
        launchers={launchers}
        launchersHome={launchersHome}
        onLaunch={
          readOnly
            ? undefined
            : (command: string) => {
                const row = launchers.find((l) => l.command === command);
                guard({
                  item: row ?? { command },
                  machine: scope.host ?? "",
                  folder: shortenHome(row?.cwd ?? agent?.cwd ?? launchersHome, launchersHome) || "~",
                  go: () => void launch(command, paneId),
                });
              }
        }
        launching={launching}
        launchRefusal={hostBlock}
        launchOpen={openForCount(dash.prefs.launchOpen, launchers.length)}
        onLaunchOpenChange={dash.setLaunchOpen}
        order={dash.prefs.paneOrder}
        onOrderChange={dash.setPaneOrder}
        className="px-2 py-2"
        roomy
      />
      {sheet}
    </>
  );
}

function PaneGlyph({ pane, className = "size-7" }: { pane: AgentView; className?: string }) {
  return pane.kind === "shell" ? <TerminalSquare className={cn(className, "text-muted-foreground")} aria-hidden /> : <AgentIcon agent={pane.agent} className={className} />;
}

/** The closed sidebar: each space's panes as icons with their status marks, in the sidebar's order. */
function Rail({ spaces, hereKey, onSelect }: { spaces: readonly WorkspaceGroup[]; hereKey: string | null; onSelect: (pane: AgentView) => void }) {
  return (
    <div className="flex flex-col items-center pb-2">
      {spaces.map((g) => (
        <div key={g.key} role="group" aria-label={g.label} className="flex w-full flex-col items-center border-b border-rule py-1">
          <span aria-hidden className="w-full truncate px-1 text-center text-[11px] leading-4 text-muted-foreground">
            {g.label}
          </span>
          {g.panes.map((p) => {
            const key = paneRowKey(p);
            const here = key === hereKey;
            return (
              <button
                key={key}
                type="button"
                data-pane-key={key}
                aria-label={`${paneName(p)}, ${statusLabel(p.status)}`}
                aria-current={here ? "true" : undefined}
                onClick={() => onSelect(p)}
                className={cn(
                  "flex size-11 select-none items-center justify-center rounded-md border transition-colors [-webkit-touch-callout:none] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  here ? "border-ring bg-accent" : "border-transparent",
                )}
              >
                <span className="relative inline-flex">
                  <PaneGlyph pane={p} />
                  <StatusDot status={p.status} backed surface="bg-card" className="absolute -bottom-1 -right-1" />
                </span>
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Where the strip is: one segment per column, the focused one solid, the visible window framed.
 *  It floats over the strip's top edge and takes no row of its own: shown while the strip moves, it
 *  fades out once the strip rests, the way an overlay scroll bar does. It never takes a pointer. */
function PositionStrip({ widths, focus, view, tail, moving }: { widths: readonly number[]; focus: number; view: { start: number; size: number }; tail: number; moving: boolean }) {
  const total = widths.reduce((n, w) => n + w, 0) + tail || 1;
  return (
    <div
      aria-hidden
      data-slot="position-strip"
      data-moving={moving || undefined}
      className={cn(
        "pointer-events-none absolute inset-x-2 top-0 z-10 flex h-1.5 items-stretch transition-opacity duration-300 motion-reduce:transition-none",
        moving ? "opacity-100" : "opacity-0",
      )}
    >
      <div className="relative flex min-w-0 flex-1 gap-px">
        {widths.map((w, i) => (
          <span key={i} className={cn("h-full", i === focus ? "bg-foreground" : "bg-muted-foreground/40")} style={{ width: `${(w / total) * 100}%` }} />
        ))}
        <span className="pointer-events-none absolute inset-y-[-1px] border border-foreground" style={{ left: `${view.start * 100}%`, width: `${view.size * 100}%` }} />
      </div>
    </div>
  );
}
