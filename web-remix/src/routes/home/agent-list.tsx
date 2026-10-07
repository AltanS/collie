import { ref, type Handle, type RemixNode } from "remix/component";
import { Inbox, Server, WifiOff } from "lucide";

import { groupHost, pinnedRows, shownGroups, stripEntries } from "@web/lib/dash-view";
import { clockTime } from "@web/lib/format";
import { HOST_TEXT_CLASSES, hostName, hostSlot, paneRowKey, paneScope } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@web/lib/pane-groups";
import type { Scope } from "@web/lib/scope";
import { ATTENTION, bucketOf, triage, worstTriage } from "@web/lib/triage";
import type { AgentView, BridgeStatus, ServerSummary, SessionSummary, TabView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { tabCreateKey } from "../../chips/space-actions";
import { act, holdAct, islandsHtml } from "../../lib/acts";
import { href } from "../../routes";
import { createFrozenRanks } from "../../lib/frozen-ranks";
import { machinesHiddenFrom } from "../../lib/hidden-machines";
import { useLocale } from "../../lib/i18n-store";
import { inRankOrder, rankedHeading, type PaneOrder } from "../../lib/pane-order";
import { pinHintRetired, pinMatcher, showsPinHint, type Pin } from "../../lib/pins";
import { onServer } from "../../lib/server-render";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Chip } from "../../ui/chip";
import { Icon } from "../../ui/icon";
import { STRIP_SCROLLER } from "../../ui/labelled-strip";
import { ListGroup } from "../../ui/list-group";
import { AgentRow } from "./agent-row";
import { NeedsYouSwitch, PaneOrderToggle, PinHint, WorkspaceNewTab } from "./list-controls";
import { SectionHeader } from "./section-header";
import { StatusCounts, StatusSummaryLine } from "./status-counts";

// Port of web/src/components/agent-list.tsx: the dashboard's pane list, in full.
//
//   - THE STRIP: "All", then one chip per workspace, lit with its worst status. Tap isolates, hold
//     hides (dimmed, struck through, its dot kept). A hidden MACHINE (issue #288) is one dimmed
//     stand-in chip with the server glyph in its tint and the worst dot of all its panes; a tap shows
//     it again, and focus stays on the strip.
//   - THE SUMMARY LINE: every state counted once, for the whole dashboard, whatever the filters
//     (ADR 0085). The needs-you switch and the order toggle sit at its end.
//   - PINNED (ADR 0070): the first group, in place order (or the rank in force), ignoring the
//     isolate, the hidden workspaces and the needs-you switch. The pin hint stands in its place while
//     nothing is pinned.
//   - BY WORKSPACE (place order): one strong heading per workspace, a dot and the counts when
//     something needs you, and the "+" for a new tab. `min-h-7` is reserved on every heading.
//   - RANKED (activity or cache order, ADR 0071): ONE list under one heading that names the order.
//     The ranks are FROZEN (lib/frozen-ranks.ts): a poll never moves a row; a tap on the toggle, a
//     return to the tab or a new order takes a new reading.
//
// Every prop is read in render; the list keeps only the rank reading and the reveal it played.
export interface HeadingNewTab {
  scope: Scope;
  sessions?: readonly SessionSummary[] | undefined;
  creating: ReadonlySet<string>;
  onNewTab: (workspaceId: string, at: Scope) => void;
}

export interface AgentListProps {
  agents: AgentView[];
  shellPanes: AgentView[];
  bridge: BridgeStatus | undefined;
  /** The snapshot on screen is stale: the last poll failed and there is a (cached) body to show. */
  error: boolean;
  /**
   * The bridge has not answered yet. NOT a verdict: no "Disconnected", no "No agents running.", only
   * a quiet placeholder while the first-connect cover (shell/boot-splash.tsx) holds the screen.
   */
  pending?: boolean;
  lastSeenAt: number | undefined;
  tabs: readonly TabView[];
  servers: readonly ServerSummary[] | undefined;
  /** The multiplexer's own sentence for why it cannot tell agents apart, or "" when it can. */
  agentDetectionNote: string;
  isolated: string | null;
  hidden: readonly string[];
  onIsolate: (key: string | null) => void;
  onToggleHidden: (key: string) => void;
  hiddenMachines: readonly string[];
  addressedHost: string | undefined;
  onShowMachine: (host: string) => void;
  needsYouOnly: boolean;
  onNeedsYouOnlyChange: (on: boolean) => void;
  pins: readonly Pin[];
  order: PaneOrder;
  onOrderChange: (order: PaneOrder) => void;
  /** Another body in place of the workspace groups (the Files tab). */
  renderBody?: (shown: readonly WorkspaceGroup[]) => RemixNode;
  newTab?: HeadingNewTab;
  onOpen: (pane: AgentView, row: HTMLElement) => void;
  onPress?: (pane: AgentView) => void;
  glideKeyOf?: (pane: AgentView) => string;
  /** Islands document (S3): a row whose pane page is not an islands page is a plain document link. */
  documentLink?: (pane: AgentView) => boolean;
  onHold?: (pane: AgentView) => void;
  /**
   * The rank reading the browser holds (S3: an islands document's list is drawn on the bridge every
   * beat, so the reading the operator is looking at comes back with the request, `X-Collie-Ranks`).
   * Absent, the list takes its own reading as before.
   */
  heldRanks?: ReadonlyMap<string, number>;
  /** Bring a row into view and focus it (after a pin moved it); a fresh object each time. */
  reveal?: { rowKey: string } | null;
}

/** The key a device remembers a workspace by: machine, session and NAME (web/'s workspacePrefKey). */
export function workspacePrefKey(g: WorkspaceGroup): string {
  const cut = g.key.lastIndexOf("\u0000");
  return `${cut === -1 ? "" : g.key.slice(0, cut)}\u0000${g.label}`;
}

function groupDomId(key: string): string {
  return `ws-group-${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

export function rowDomId(rowKey: string): string {
  return `pane-row-${rowKey.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

function urgentCount(g: WorkspaceGroup): number {
  return g.panes.filter((p) => ATTENTION.has(bucketOf(p))).length;
}

const PINNED_ID = "pinned-group";
const PINNED_HEADING_ID = "pinned-group-heading";
const RANKED_ID = "ranked-group";
const RANKED_HEADING_ID = "ranked-group-heading";
const SUMMARY_ID = "dash-summary-line";
const NO_PANES: AgentView[] = [];

function revealElement(el: HTMLElement): void {
  const reduced = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ block: "nearest", behavior: reduced ? "instant" : "smooth" });
  el.focus({ preventScroll: true });
}

export function AgentList(handle: Handle<AgentListProps>) {
  useLocale(handle);
  const hintRetired = useStore(handle, pinHintRetired);
  const frozen = createFrozenRanks();
  let revealed: AgentListProps["reveal"] = null;
  let strip: HTMLElement | null = null;
  // Coming back to a background tab IS opening the dashboard again: a new reading (web/'s
  // `rereadOnVisible`). Never on a poll. Not in a server render (no document, no signal to end it).
  if (!onServer()) {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState !== "visible" || handle.props.order === "place") return;
        frozen.reread();
        scheduleUpdate(handle);
      },
      { signal: handle.signal },
    );
  }

  return () => {
    const p = handle.props;
    if (p.agents.length === 0 && p.shellPanes.length === 0) return <EmptyHerd {...p} />;

    const reveal = p.reveal ?? null;
    if (reveal !== null && reveal !== revealed) {
      revealed = reveal;
      handle.queueTask(() => {
        const target = document.getElementById(rowDomId(reveal.rowKey)) ?? document.getElementById(SUMMARY_ID);
        if (target) revealElement(target);
      });
    }

    const order = p.order;
    const ranks = p.heldRanks ?? frozen.ranks(order, [...p.agents, ...p.shellPanes]);
    const attention = triage(p.agents).filter((s) => ATTENTION.has(s.key) && s.agents.length > 0);
    const groups = groupPanesByWorkspace(p.agents, p.shellPanes, { order: "fixed", tabs: p.tabs, servers: p.servers });
    if (groups.length === 0) return null;
    const isolatedGroup = p.isolated === null ? undefined : groups.find((g) => workspacePrefKey(g) === p.isolated);
    const hiddenSet = new Set(p.hidden);
    const machineHidden = machinesHiddenFrom(p.hiddenMachines, p.servers, p.addressedHost);
    const shown = isolatedGroup
      ? [isolatedGroup]
      : groups.filter((g) => !hiddenSet.has(workspacePrefKey(g)) && !machineHidden.has(groupHost(g)));
    const entries = stripEntries(groups, machineHidden, isolatedGroup?.key);
    const isPinned = pinMatcher(p.pins);
    const ranked = order !== "place";
    const pinned = inRankOrder(pinnedRows(groups, isPinned), ranks);
    const pinnedUrgent = pinned.some((a) => ATTENTION.has(bucketOf(a)));
    const firstUrgent = groups.find((g) => urgentCount(g) > 0);
    const drawn = shownGroups(shown, p.needsYouOnly, isPinned);
    const rankedRows = ranked && !p.renderBody ? inRankOrder(drawn.flatMap((d) => d.rows), ranks) : NO_PANES;
    const firstUrgentRow = rankedRows.find((a) => ATTENTION.has(bucketOf(a)));
    const shownRows = drawn.reduce((n, d) => n + d.rows.length, 0);
    const pinHintHere = !p.needsYouOnly && p.renderBody === undefined && p.onHold !== undefined;
    const pinHintOpen = showsPinHint(hintRetired(), p.pins.length, shownRows);
    const firstShownRow = ranked ? rankedRows[0] : drawn[0]?.rows[0];
    // An islands document (S3): the server draws the list once per beat and no island hydrates it, so
    // the jump says where to go in attributes (islands/act-table.ts), and the rows are links.
    const html = islandsHtml();
    const jumpActs = !html || p.renderBody
      ? undefined
      : pinnedUrgent
        ? act("scroll-to", { id: PINNED_ID })
        : ranked && firstUrgentRow !== undefined
          ? act("reveal", { id: rowDomId(paneRowKey(firstUrgentRow)) })
          : firstUrgent
            ? drawn.some((d) => d.group === firstUrgent)
              ? act("scroll-to", { id: groupDomId(firstUrgent.key) })
              : act("isolate", { key: workspacePrefKey(firstUrgent) })
            : undefined;

    const jumpTo = (g: WorkspaceGroup): void => {
      if (!drawn.some((d) => d.group === g)) {
        handle.props.onIsolate(workspacePrefKey(g));
        return;
      }
      document.getElementById(groupDomId(g.key))?.scrollIntoView({ behavior: "smooth", block: "start" });
    };
    const onJump = p.renderBody
      ? undefined
      : pinnedUrgent
        ? () => document.getElementById(PINNED_ID)?.scrollIntoView({ behavior: "smooth", block: "start" })
        : ranked && firstUrgentRow !== undefined
          ? () => {
              const el = document.getElementById(rowDomId(paneRowKey(firstUrgentRow)));
              if (el) revealElement(el);
            }
          : firstUrgent
            ? () => jumpTo(firstUrgent)
            : undefined;

    const headingNewTab = (g: WorkspaceGroup): RemixNode => {
      const first = g.panes[0];
      const nt = p.newTab;
      if (nt === undefined || first === undefined) return null;
      const at = paneScope(nt.scope, first, p.servers, nt.sessions);
      return (
        <WorkspaceNewTab
          workspaceId={first.workspaceId}
          label={g.label}
          at={at}
          host={first.host}
          busy={nt.creating.has(tabCreateKey(first.workspaceId, at))}
          onNewTab={nt.onNewTab}
        />
      );
    };

    const row = (a: AgentView, scope: "place" | "herd" = "place") => {
      const glideKey = p.glideKeyOf?.(a);
      return (
      <AgentRow
        key={paneRowKey(a)}
        link={html && glideKey !== undefined ? { href: href(glideKey), rowKey: encodeURIComponent(paneRowKey(a)), document: p.documentLink?.(a) === true } : undefined}
        id={rowDomId(paneRowKey(a))}
        agent={a}
        scope={scope}
        unseen={bucketOf(a) === "ready"}
        glideKey={glideKey}
        onOpen={(pane, el) => handle.props.onOpen(pane, el)}
        onPress={p.onPress}
        onHold={p.onHold}
      />
      );
    };

    const controls = (
      <div class="flex shrink-0 gap-1">
        <NeedsYouSwitch on={p.needsYouOnly} onChange={(on) => handle.props.onNeedsYouOnlyChange(on)} />
        <PaneOrderToggle
          order={order}
          onChange={(next) => {
            frozen.reread();
            handle.props.onOrderChange(next);
            void handle.update();
          }}
        />
      </div>
    );

    return (
      <div class="flex flex-col gap-5 px-4 py-4" data-testid="agent-list">
        <nav aria-label={t("space.strip.title")} class="-mx-4">
          <div
            class={cn(STRIP_SCROLLER, "px-4")}
            data-testid="space-strip"
            mix={ref((node: HTMLElement) => {
              strip = node;
            })}
          >
            <Chip label={t("space.tabStrip.all")} active={!isolatedGroup} acts={act("isolate", { key: "" })} onClick={() => handle.props.onIsolate(null)} />
            {entries.map((entry, i) => {
              if (entry.kind === "machine") {
                const name = hostName(p.servers, entry.host) ?? entry.host;
                const slot = hostSlot(p.servers, entry.host);
                const host = entry.host;
                return (
                  <Chip
                    key={`machine\u0000${host}`}
                    glyph={
                      <span data-testid="machine-chip" data-host={host} class="flex">
                        <Icon icon={Server} class={cn("size-3.5 shrink-0", slot === null ? "text-muted-foreground" : HOST_TEXT_CLASSES[slot])} />
                      </span>
                    }
                    label={name}
                    ariaLabel={t("home.machineHidden.show", { name })}
                    active={false}
                    dimmed
                    status={worstTriage(entry.panes)}
                    acts={act("show-machine", { host })}
                    onClick={() => {
                      handle.props.onShowMachine(host);
                      // Focus stays on the strip, on the chip that took this one's place.
                      handle.queueTask(() => strip?.querySelectorAll<HTMLElement>("button")[i + 1]?.focus());
                      void handle.update();
                    }}
                  />
                );
              }
              const g = entry.group;
              const key = workspacePrefKey(g);
              return (
                <Chip
                  key={g.key}
                  label={g.label}
                  active={isolatedGroup?.key === g.key}
                  dimmed={!isolatedGroup && hiddenSet.has(key)}
                  status={worstTriage(g.panes)}
                  acts={html ? { ...act("isolate", { key: isolatedGroup?.key === g.key ? "" : key }), ...holdAct("hide-space", { key }) } : undefined}
                  onClick={() => handle.props.onIsolate(isolatedGroup?.key === g.key ? null : key)}
                  onLongPress={() => handle.props.onToggleHidden(key)}
                />
              );
            })}
          </div>
        </nav>

        <div class="flex min-h-11 items-center justify-between gap-2">
          <StatusSummaryLine
            id={SUMMARY_ID}
            panes={p.agents}
            allClear={attention.length === 0}
            onJump={onJump}
            focusable={p.pins.length > 0 || reveal !== null}
            acts={jumpActs}
            class="min-w-0 flex-1"
          />
          {p.renderBody === undefined ? (
            controls
          ) : (
            <div class="invisible shrink-0" aria-hidden="true">
              {controls}
            </div>
          )}
        </div>

        {pinned.length > 0 && (
          <section id={PINNED_ID} aria-labelledby={PINNED_HEADING_ID} data-testid="pinned-group" class="flex scroll-mt-4 flex-col gap-2">
            <SectionHeader id={PINNED_HEADING_ID} label={t("home.pinned.title")} ui />
            <ListGroup>{pinned.map((a) => row(a, "herd"))}</ListGroup>
          </section>
        )}

        {pinHintHere && (
          <PinHint
            open={pinHintOpen}
            onFocusLeaves={() => {
              if (firstShownRow === undefined) return;
              document.getElementById(rowDomId(paneRowKey(firstShownRow)))?.focus({ preventScroll: true });
            }}
          />
        )}

        {p.renderBody?.(shown)}

        {!p.renderBody && ranked && rankedRows.length > 0 && (
          <section id={RANKED_ID} aria-labelledby={RANKED_HEADING_ID} data-testid="ranked-group" class="flex scroll-mt-4 flex-col gap-2">
            <SectionHeader id={RANKED_HEADING_ID} label={t(rankedHeading(order))} count={rankedRows.length} tone="strong" ui class="min-h-7" />
            <ListGroup>{rankedRows.map((a) => row(a, "herd"))}</ListGroup>
          </section>
        )}

        {!p.renderBody &&
          !ranked &&
          drawn.map(({ group: g, rows }) => (
            <section key={g.key} id={groupDomId(g.key)} data-rmx-key={html ? `group:${encodeURIComponent(g.key)}` : undefined} data-testid="workspace-group" data-host={groupHost(g)} class="flex scroll-mt-4 flex-col gap-2">
              <SectionHeader
                label={g.label}
                tone="strong"
                dot={worstTriage(g.panes) === "needs" ? "bg-status-blocked" : undefined}
                class="min-h-7"
                trailing={
                  <>
                    <StatusCounts panes={g.panes} class="shrink-0 text-[11px] text-muted-foreground" />
                    {headingNewTab(g)}
                  </>
                }
              />
              <ListGroup>{rows.map((a) => row(a))}</ListGroup>
            </section>
          ))}
      </div>
    );
  };
}

function EmptyHerd(handle: Handle<AgentListProps>) {
  return () => {
    const { error, pending, lastSeenAt, bridge, agentDetectionNote } = handle.props;
    if (pending) return <div class="min-h-48" data-testid="herd-pending" aria-busy="true" />;
    if (error) {
      return (
        <div class="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground" data-testid="herd-empty">
          <Icon icon={WifiOff} class="size-7" />
          <span class="text-sm">
            {lastSeenAt === undefined ? t("home.empty.disconnected") : t("home.empty.disconnectedAt", { time: clockTime(lastSeenAt) })}
          </span>
        </div>
      );
    }
    return (
      <div class="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground" data-testid="herd-empty">
        <Icon icon={Inbox} class="size-7" />
        <span class="text-sm">{bridge === "connected" ? t("home.empty.noAgents") : t("home.empty.waiting")}</span>
        {bridge === "connected" && agentDetectionNote !== "" && (
          <p class="max-w-xs text-center text-xs leading-snug">
            {agentDetectionNote} {t("home.empty.panesHint")}
          </p>
        )}
      </div>
    );
  };
}
