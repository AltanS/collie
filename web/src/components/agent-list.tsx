import { Inbox, WifiOff } from "lucide-react";
import type { ReactNode } from "react";

import { clockTime } from "@/lib/format";
import { useMuxCapability } from "@/lib/mux-capability";
import { SectionHeader } from "@/components/section-header";
import { ListGroup } from "@/components/ui/list-group";
import { groupPanesByWorkspace, type WorkspaceGroup } from "@/lib/pane-groups";
import { Chip } from "@/components/ui/chip";
import { StatusCounts, StatusSummaryLine } from "@/components/status-counts";
import { STRIP_SCROLLER } from "@/components/ui/labelled-strip";
import { ATTENTION, bucketOf, triage, worstTriage } from "@/lib/triage";
import { shownGroups } from "@/lib/dash-view";
import type { AgentView, BridgeStatus, ServerSummary, TabView } from "@/lib/types";
import { paneRowKey } from "@/lib/hosts";
import { AgentCard } from "./agent-card";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

interface AgentListProps {
  agents: AgentView[];
  /**
   * Bare shell panes. They join their own workspace's group, after that tab's agents — a shell is a
   * pane of the tab it sits in, not a species that deserves a pen of its own (lib/pane-groups.ts).
   * Omit and the list is agents alone, exactly as it was.
   */
  shellPanes?: AgentView[];
  bridge?: BridgeStatus | undefined;
  /**
   * Open a row. Takes the PANE, not its id: `w1:p1` names a different terminal on every machine in a
   * crew, and this list is one herd across all of them — an id alone cannot say which row was tapped.
   */
  onOpen: (pane: AgentView, row?: HTMLElement) => void;
  /** A row's glide key, its pane's path (lib/glide.ts, the `pane` pair). Omit and no row glides. */
  glideKeyOf?: (pane: AgentView) => string;
  /** The finger landed on a row (lib/pane-prefetch.ts). */
  onPress?: (pane: AgentView) => void;
  /** Show the "no agents" placeholder when the herd is empty (default true). */
  emptyState?: boolean;
  /**
   * The snapshot on screen is stale — the last fetch failed, or this is a cold boot rendering from the
   * write-through cache. An EMPTY herd then means "we don't know", never "nothing is running", so the
   * placeholder must not claim the latter.
   */
  error?: boolean;
  /** When the stale data was fetched, for the "last seen HH:MM" half of the disconnected placeholder. */
  lastSeenAt?: number;
  /** The raw tab list, for the multiplexer's own tab order inside a workspace. */
  tabs?: readonly TabView[];
  /** The snapshot's machine list, for the order machines run in: the lead first (lib/pane-groups.ts). */
  servers?: readonly ServerSummary[] | undefined;
  /**
   * The workspace filter the strip on top drives, per device (hooks/use-dash-prefs.ts). `isolated`
   * shows one workspace alone; `hidden` drops workspaces from the list while their chips stay in
   * the strip, dimmed, still carrying their status dot, so a hidden workspace that needs you is
   * never silent. Keys from `workspacePrefKey` (machine, session, workspace name). Omit both and the list shows everything.
   */
  isolated?: string | null;
  hidden?: readonly string[];
  /** Tap a chip: isolate that workspace, or clear the filter (null). */
  onIsolate?: (key: string | null) => void;
  /** Long-press a chip: hide the workspace, or show it again. */
  onToggleHidden?: (key: string) => void;
  /**
   * The "Focus" tab (issue 270, ADR 0066, renamed by ADR 0068): a group shows only its panes that need you, and a
   * group with none is dropped. A filter, never a sort. The strip, the summary line and every
   * heading's counts still count ALL panes, so the filter never understates the herd.
   */
  needsYouOnly?: boolean;
  /**
   * The "Changes" tab: draws its own body in place of the pane groups, from the workspaces the strip
   * leaves shown. The strip and the summary line above stay exactly where they were.
   */
  renderBody?: (shown: readonly WorkspaceGroup[]) => ReactNode;
}

/** A module-level empty list: a fresh `[]` default per render is a new reference for nothing. */
const NO_PANES: AgentView[] = [];
const NO_KEYS: readonly string[] = [];

/** The heading's dot, in the worst URGENT status inside the group; none when quiet. */
function urgentDot(g: WorkspaceGroup): string | undefined {
  const worst = worstTriage(g.panes);
  if (worst === "needs") return "bg-status-blocked";
  return undefined;
}

function urgentCount(g: WorkspaceGroup): number {
  return g.panes.filter((p) => ATTENTION.has(bucketOf(p))).length;
}

/**
 * The key a device REMEMBERS a workspace by, for hide and isolate: its machine, session and NAME.
 * The group key carries Herdr's workspace id, which is opaque and can change when Herdr restarts, so
 * a preference keyed on it would quietly stop applying. The name is the project folder and stays.
 */
export function workspacePrefKey(g: WorkspaceGroup): string {
  const cut = g.key.lastIndexOf("\u0000");
  return `${cut === -1 ? "" : g.key.slice(0, cut)}\u0000${g.label}`;
}

/** A DOM id for a workspace group, so the summary line can scroll to it. */
function groupDomId(key: string): string {
  return `ws-group-${key.replace(/[^A-Za-z0-9_-]/gu, "_")}`;
}

// ── THE DASHBOARD, IN ONE FIXED ORDER (ADR 0063) ─────────────────────────────
// BY WORKSPACE, always. One group per workspace, headed by its name and counted, in machine and
// workspace-number order (lib/pane-groups.ts), with the panes inside in the order the bridge sent.
// Rows under one workspace heading are panes, because that is what a workspace holds. The workspace
// is the level the operator thinks in, so it is the level the heading names; the tab drops onto
// line 2 of the row (`AgentCard` at `scope="place"`), where it tells two rows apart without
// spending a heading, and the group reads as one 44px pitch.
//
// A PANE'S ROW NEVER MOVES WHEN ITS STATE CHANGES. The operator finds a pane by where it sits, not
// by what it is doing right now, and every arrangement that once reordered on a status change — a
// "Needs you" section pulled to the top, the Working and Recent sections, the sort toggle — broke
// exactly that and is gone (ADR 0063).
//
// URGENCY IS A MARK NOW, NEVER A POSITION. A workspace holding a pane that needs you lights its own
// heading (a dot) and its own count (`StatusCounts`); the pane's own row takes a full-colour wash
// (`AgentCard`'s `tint`) rather than moving anywhere; and ONE summary line above every group counts
// what needs you across the whole herd and jumps to the first of it. A row is listed once, in its
// one place, and its marks say the rest.
export function AgentList({
  agents,
  shellPanes = NO_PANES,
  bridge,
  onOpen,
  glideKeyOf,
  onPress,
  emptyState = true,
  error = false,
  lastSeenAt,
  tabs,
  servers,
  isolated = null,
  hidden = NO_KEYS,
  onIsolate,
  onToggleHidden,
  needsYouOnly = false,
  renderBody,
}: AgentListProps) {
  useLocale();
  // Whether the multiplexer can say which agent a pane holds. Read unconditionally — a hook cannot
  // sit behind the early return below, and the answer is only consulted in the empty branch.
  const agentDetection = useMuxCapability("agentDetection");
  // A herd with nothing but bare shells in it is still something to show, and "No agents running."
  // is then true rather than empty — so the placeholder waits for BOTH lists to be empty.
  if (agents.length === 0 && shellPanes.length === 0) {
    if (!emptyState) return null;
    // "No agents running." is a claim about the herd, and only the bridge can make it. A stale render
    // (failed fetch, or a cold boot with nothing cached) knows nothing about the herd — saying the
    // herd is empty there is the bug this branch exists to prevent, so the outage is named instead.
    // `bridge` is no help on its own: a cached snapshot still says "connected".
    if (error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground">
          <WifiOff className="size-7" />
          <span className="text-sm">
            {lastSeenAt === undefined
              ? t("home.empty.disconnected")
              : t("home.empty.disconnectedAt", { time: clockTime(lastSeenAt) })}
          </span>
        </div>
      );
    }
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-muted-foreground">
        <Inbox className="size-7" />
        <span className="text-sm">
          {bridge === "connected" ? t("home.empty.noAgents") : t("home.empty.waiting")}
        </span>
        {/* PRESENTATION, not a gate (M10/06). Without `agentDetection` every pane arrives as a
            shell with an unknown status, so this list is empty on a machine that may be running
            plenty — and "No agents running." is then a claim the bridge cannot actually make. The
            adapter's own sentence says why, and the second line says where the panes went, so the
            dashboard reads as one coherent screen instead of an empty one. Renders nothing on a
            multiplexer that reports agents, i.e. nothing on Herdr. */}
        {bridge === "connected" && !agentDetection.capable && agentDetection.note !== "" && (
          <p className="max-w-xs text-center text-xs leading-snug">
            {agentDetection.note} {t("home.empty.panesHint")}
          </p>
        )}
      </div>
    );
  }

  // ONE PASS, NOTHING MOVES (2026-09-16, after four arrangements on the phone and a counsel).
  // Every pane stays in its workspace, in the multiplexer's own order: workspaces by number, tabs by
  // number, panes by id. A status change never moves a row or a group, because the operator finds a
  // pane by where it sits, and the urgent sections that used to pull a pane to the top broke exactly
  // that. Urgency is a MARK now, never a position: a full-row wash, a lit heading, a lit chip, and
  // the one summary line. Push and the badge carry the alarm; this screen answers "where".
  const all = triage(agents);
  const attention = all.filter((s) => ATTENTION.has(s.key) && s.agents.length > 0);
  const groups = groupPanesByWorkspace(agents, shellPanes, { order: "fixed", tabs, servers });
  if (groups.length === 0) return null;
  // A stale key (a workspace since closed) filters nothing: an isolation nobody can see is dropped.
  const isolatedGroup = isolated === null ? undefined : groups.find((g) => workspacePrefKey(g) === isolated);
  const hiddenSet = new Set(hidden);
  const shown = isolatedGroup ? [isolatedGroup] : groups.filter((g) => !hiddenSet.has(workspacePrefKey(g)));
  const allClear = attention.length === 0;
  const firstUrgent = groups.find((g) => urgentCount(g) > 0);
  // What the body draws. Needs you narrows the rows and drops a group left empty; the group itself
  // rides along whole, so its heading keeps counting every pane (lib/dash-view.ts).
  const drawn = shownGroups(shown, needsYouOnly);
  const jumpTo = (g: WorkspaceGroup) => {
    // The target may be filtered out: isolate it, which is also the scroll.
    if (!drawn.some((d) => d.group === g)) {
      onIsolate?.(workspacePrefKey(g));
      return;
    }
    document.getElementById(groupDomId(g.key))?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // The FULL row identity, not the pane id — see `paneRowKey`. A pane id is unique only within one
  // session on one machine, so a merged or widened list holds several rows that answer to `w1:p1`;
  // keyed by the id alone React recycles one row's element for another's between polls, and the
  // card you are looking at acquires a different row's `onClick`. On this list, that is a tap
  // landing in another terminal.
  const row = (a: AgentView) => (
    <AgentCard
      key={paneRowKey(a)}
      agent={a}
      onClick={(el) => onOpen(a, el)}
      glideKey={glideKeyOf?.(a)}
      onPress={onPress && (() => onPress(a))}
      scope="place"
      statusStyle="dot"
      density="row"
      unseen={bucketOf(a) === "ready"}
      tint
    />
  );

  return (
    <div className="flex flex-col gap-5 px-4 py-4">
      {/* THE WORKSPACE STRIP, a filter. "All", then one chip per workspace in the list's own order,
          each lit with the worst status inside. Tap a chip to see that workspace alone, tap it or
          All to see everything again. Long-press a chip to hide the workspace, and again to bring it
          back; a hidden chip stays in the strip, dimmed, with its dot, so hiding never silences a
          workspace that needs you. One height always, so nothing below moves.
          The scroller keeps STRIP_SCROLLER's own `py-1.5` and must: that padding is the room a
          chip's STRIP_TAP_TARGET `::before` reaches into for the 44px tap floor. Trimmed to `py-0`
          it cost both halves at once — the reach was clipped away, so the chips answered a 34px
          touch, and the same overflow became 6px of vertical scroll that dragged their bottom edge
          out of sight. `actions-row.tsx` hit this before; its note carries the mechanism. */}
      <nav aria-label={t("space.strip.title")} className="-mx-4">
        <div className={cn(STRIP_SCROLLER, "px-4")}>
          <Chip label={t("space.tabStrip.all")} active={!isolatedGroup} onClick={() => onIsolate?.(null)} />
          {groups.map((g) => (
            <Chip
              key={g.key}
              label={g.label}
              active={isolatedGroup?.key === g.key}
              dimmed={!isolatedGroup && hiddenSet.has(workspacePrefKey(g))}
              status={worstTriage(g.panes)}
              onClick={() => onIsolate?.(isolatedGroup?.key === g.key ? null : workspacePrefKey(g))}
              onLongPress={onToggleHidden ? () => onToggleHidden(workspacePrefKey(g)) : undefined}
            />
          ))}
        </div>
      </nav>

      {/* The twenty-times-a-day glance, in ONE slot of one height: every state counted, with its
          word, once for the whole dashboard (the headings below repeat the numbers, not the words).
          The all-clear check leads when nothing needs you. A tap goes to the first workspace
          holding something urgent. */}
      <StatusSummaryLine
        panes={agents}
        allClear={allClear}
        onJump={firstUrgent && !renderBody ? () => jumpTo(firstUrgent) : undefined}
      />

      {renderBody?.(shown)}

      {/* By workspace. The heading IS the landmark: full ink, its own case, and it lights up with a
          dot and a count when a pane inside needs you. Flat rows in ONE bordered group. Under Needs
          you with nothing urgent, no group is left, and the summary line's all-clear above is the
          whole answer: no empty list, no second message. */}
      {!renderBody && drawn.map(({ group: g, rows }) => (
        <section key={g.key} id={groupDomId(g.key)} className="flex scroll-mt-4 flex-col gap-2">
          <SectionHeader
            label={g.label}
            tone="strong"
            dot={urgentDot(g)}
            trailing={
              <StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />
            }
          />
          <ListGroup>{rows.map(row)}</ListGroup>
        </section>
      ))}
    </div>
  );
}
