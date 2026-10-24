import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, Columns2, PanelLeftClose, PanelLeftOpen, Replace, TerminalSquare } from "lucide-react";

import { ActionRow } from "@/components/action-sheet-rows";
import { AgentIcon } from "@/components/agent-icon";
import { ThreadSidebar } from "@/components/agent-sidebar";
import { useHeaderDock } from "@/components/app-header";
import { useHostHealth } from "@/components/crew-provider";
import { StatusDot } from "@/components/status-badge";
import { ColumnControls, ColumnHeader, PaneColumnBody, columnFrame } from "@/components/strip-column";
import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { openForCount, useDashPrefs } from "@/hooks/use-dash-prefs";
import { useElementWidth } from "@/hooks/use-element-width";
import { useLocale } from "@/hooks/use-locale";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useNav } from "@/hooks/use-nav";
import { useNoPromptsGuard } from "@/hooks/use-no-prompts-guard";
import { useRowDrag, useVerticalSwipe, type DropTarget } from "@/hooks/use-row-drag";
import { useSpaceActions } from "@/hooks/use-spaces";
import { queueBeltIntent, type BeltIntent } from "@/lib/belt-intent";
import { writeRefusal } from "@/lib/host-health";
import { hostName, isMultiHost, paneRowKey } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { useLaunchers } from "@/lib/launchers";
import { panePath } from "@/lib/nav";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { paneName } from "@/lib/pane-name";
import { usePairing } from "@/lib/pairing";
import { usePins } from "@/lib/pins";
import { useRootData } from "@/lib/route-data";
import { paneScopeKey, type Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
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

interface WideLayoutProps {
  widthClass: "medium" | "expanded";
  paneId: string;
  /** The route's scope. */
  scope: Scope;
  /** The route's pane, when the view knows it. */
  agent: AgentView | undefined;
  /** The route's own pane view, mounted in the focused column. */
  focused: ReactNode;
}

/** Spaces in the sidebar's workspace order: the agents' sections first, as the sidebar draws them,
 *  then a space that holds only shells. */
function spacesInOrder(agents: readonly AgentView[], shells: readonly AgentView[], options: Parameters<typeof groupPanesByWorkspace>[2]): WorkspaceGroup[] {
  const sections = groupPanesByWorkspace(agents, [], options).map((g) => g.key);
  const all = groupPanesByWorkspace(agents, shells, options);
  const rank = (g: WorkspaceGroup) => {
    const at = sections.indexOf(g.key);
    return at < 0 ? sections.length : at;
  };
  return all.map((g, i) => ({ g, i })).toSorted((a, b) => rank(a.g) - rank(b.g) || a.i - b.i).map(({ g }) => g);
}

export function WideLayout({ widthClass, paneId, scope, agent, focused }: WideLayoutProps) {
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
  // has, arrived at the route's pane. A herd from a saved copy prunes nothing.
  const live = useMemo(() => new Set((space?.panes ?? []).map((p) => columnKeyOf(p, places))), [space, places]);
  const kept = spaceKey === null ? undefined : stored.get(spaceKey);
  const strip: SpaceStrip = useMemo(() => {
    if (spaceKey === null) return { cols: [{ key: routeKey, preset: "full" }], focus: routeKey };
    const base = kept ?? spaceStrip(spaceKey);
    return arrive(root.error ? base : prune(base, live), routeKey);
  }, [spaceKey, kept, root.error, live, routeKey]);
  useEffect(() => {
    if (spaceKey !== null && strip !== kept) setSpaceStrip(spaceKey, strip);
  }, [spaceKey, strip, kept]);

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
  const wide = isWideMode(stripWidth, MIN_PANE_WIDTH);
  const allowed = allowedPresets(stripWidth, MIN_PANE_WIDTH);
  const widthChoice = wide && hasWidthChoice(stripWidth, MIN_PANE_WIDTH);

  const shown = strip.cols.filter((c) => c.key === strip.focus || byColumn.has(c.key));
  const framed = shown.length > 1;
  const fractions = shown.map((c) => (wide ? PRESET_FRACTION[shownPreset(c.preset, allowed)] : 1));
  const tail = Math.max(0, 1 - (fractions[fractions.length - 1] ?? 1));
  const focusAt = shown.findIndex((c) => c.key === strip.focus);

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
  const signature = fractions.join(",");
  useLayoutEffect(() => {
    const node = scroller.current;
    if (node === null) return;
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
  }, [focusAt, signature, stripWidth, reduced, measure]);

  // ── The one header, docked in the focused column; the mark in the sidebar's top row ─────────
  const [row, setRow] = useState<HTMLElement | null>(null);
  const [mark, setMark] = useState<HTMLElement | null>(null);
  const trail = useHeaderDock({ row, mark, paper: "var(--card)" });

  const press = useRef<{ x: number; y: number } | null>(null);
  const swipe = useVerticalSwipe((dx, dy) => {
    const by = spaceSwipe(dx, dy);
    if (by !== null) moveSpace(by);
  });
  const machine = isMultiHost(root.servers) && agent ? hostName(root.servers, agent.host) : undefined;

  return (
    <div
      data-slot="wide-layout"
      data-width-class={widthClass}
      // No scroll bar anywhere in the layout: the position strip says where the strip is, and a bar on
      // every column and list would be a second, noisier answer.
      className="flex min-h-0 w-full flex-1 [&_*]:[scrollbar-width:none] [&_*::-webkit-scrollbar]:hidden"
    >
      <aside
        data-slot={open ? "wide-sidebar" : "rail"}
        aria-label={t("wide.sidebar.label")}
        className="flex shrink-0 flex-col border-r border-rule bg-card"
        style={{ width: aside }}
      >
        <SidebarTop open={open} setMark={setMark} />
        <div {...hostProps} className="min-h-0 flex-1 overflow-y-auto [-webkit-touch-callout:none]">
          {open ? (
            <SidebarList agent={agent} paneId={paneId} scope={scope} onSelect={goTo} />
          ) : (
            <Rail spaces={spaces} hereKey={agent ? paneRowKey(agent) : null} onSelect={goTo} />
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          data-slot="space-header"
          {...swipe}
          className="flex h-12 shrink-0 touch-none items-center gap-1 border-b border-rule bg-band-ground pl-4 pr-1"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {space?.label ?? ""}
              {machine !== undefined && <span className="text-muted-foreground"> · {machine}</span>}
            </div>
          </div>
          {spaceAt >= 0 && (
            <span data-slot="space-position" className="shrink-0 px-2 text-xs tabular-nums text-muted-foreground">
              {t("wide.space.position", { index: spaceAt + 1, total: spaces.length })}
            </span>
          )}
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

        <div
          ref={setScroller}
          data-slot="strip"
          onScroll={measure}
          className={cn("relative flex min-h-0 flex-1 overflow-x-auto overflow-y-hidden", drag !== null ? "snap-none" : "snap-x snap-mandatory")}
        >
          {shown.map((c, i) => {
            const isFocus = c.key === strip.focus;
            const pane = byColumn.get(c.key);
            const preset = widthChoice ? shownPreset(c.preset, allowed) : null;
            const controls = (
              <ColumnControls preset={preset} onCycle={() => cycle(c.key)} onRemove={() => remove(c.key)} removable={shown.length > 1} />
            );
            return (
              <section
                key={c.key}
                data-col-index={i}
                data-col-key={c.key}
                data-focused={isFocus ? "" : undefined}
                aria-label={pane ? paneName(pane) : undefined}
                aria-current={isFocus && framed ? "true" : undefined}
                className="flex h-full shrink-0 snap-start border-r border-rule"
                style={{ flex: `0 0 ${(fractions[i] ?? 1) * 100}%`, minWidth: wide ? MIN_PANE_WIDTH : undefined }}
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
                      <PaneColumnBody pane={pane} scope={scopeOfPane(pane, places)} onIntent={(intent) => onIntent(pane, intent)} />
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}
          {tail > 0 && shown.length > 1 && <span aria-hidden data-slot="strip-end" className="shrink-0" style={{ flex: `0 0 ${tail * 100}%` }} />}
          {drag?.drop != null && (
            <span aria-hidden data-slot="drop-bar" className="pointer-events-none absolute inset-y-0 z-20 w-1 bg-primary" style={{ left: drag.drop.markerX - 2 }} />
          )}
        </div>
        {shown.length > 1 && <PositionStrip widths={fractions} focus={focusAt} view={view} tail={tail} />}
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
function SidebarTop({ open, setMark }: { open: boolean; setMark: (el: HTMLElement | null) => void }) {
  const toggle = (
    <Button
      variant="ghost"
      size="lg"
      data-slot="sidebar-toggle"
      className="size-11 shrink-0 px-0 text-muted-foreground"
      aria-label={t("wide.sidebar.label")}
      aria-expanded={open}
      onClick={() => setSidebarOpen(!open)}
    >
      {open ? <PanelLeftClose className="size-5" /> : <PanelLeftOpen className="size-5" />}
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
    <div className="flex h-12 shrink-0 items-center gap-1 border-b border-rule pl-1 pr-1">
      <div ref={setMark} data-slot="sidebar-mark" className="flex shrink-0 items-center" />
      {/* The product's name outside (ColliePWA), small and muted beside the mark. Not translated. */}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">ColliePWA</span>
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
        className="px-0 py-1"
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

/** Where the strip is: one segment per column, the focused one solid, the visible window framed. */
function PositionStrip({ widths, focus, view, tail }: { widths: readonly number[]; focus: number; view: { start: number; size: number }; tail: number }) {
  const total = widths.reduce((n, w) => n + w, 0) + tail || 1;
  return (
    <div aria-hidden data-slot="position-strip" className="flex h-3 shrink-0 items-stretch border-t border-rule bg-background px-2 py-1">
      <div className="relative flex min-w-0 flex-1 gap-px">
        {widths.map((w, i) => (
          <span key={i} className={cn("h-full", i === focus ? "bg-foreground" : "bg-muted-foreground/40")} style={{ width: `${(w / total) * 100}%` }} />
        ))}
        <span className="pointer-events-none absolute inset-y-[-2px] border border-foreground" style={{ left: `${view.start * 100}%`, width: `${view.size * 100}%` }} />
      </div>
    </div>
  );
}
