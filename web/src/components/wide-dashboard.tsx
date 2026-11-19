// THE DASHBOARD ON A LARGE SCREEN: four answers for the proposal round `dashboard-wide`
// (`web/src/pick/rounds/dashboard-wide.tsx`). Not mounted by any route yet. The phone's dashboard is
// `agent-list.tsx` and does not change; a route mounts one of these only where `isWideDashboard` holds
// (two Space columns fit) and Large-screen layout is not Off, so the compact width class and the Off
// setting keep the phone's column at every width.
//
// Every option draws the SAME parts as the phone list, from the same components: the Space heading
// (`SectionHeader`, strong, with its urgent mark and `StatusCounts`), the rows (`AgentCard`, 44px, the
// dot, the tint, the unseen mark), one `ListGroup` per Space, the Pinned group, and the host chip of a
// crew. What changes is only where a Space stands. The order is always the list's own
// (`groupPanesByWorkspace` with the fixed order: machine, Space number, tab number), never a status.
//
// After the pick, the chosen option stays here, the other three and the round go, and `AgentList`
// renders its groups through the chosen one at large widths (its filters, freeze and still-list stay
// where they are).

import type { ReactNode } from "react";

import { AgentCard } from "@/components/agent-card";
import { HostChip } from "@/components/host-chip";
import { SectionHeader } from "@/components/section-header";
import { StatusCounts } from "@/components/status-counts";
import { ListGroup } from "@/components/ui/list-group";
import { pinnedRows, shownGroups, type ShownGroup } from "@/lib/dash-view";
import { paneRowKey } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { groupPanesByWorkspace } from "@/lib/pane-groups";
import { COLUMN_SNAP_CLASSES, STRIP_SNAP_CLASSES } from "@/lib/strip-snap";
import { bucketOf, needsYou, worstTriage } from "@/lib/triage";
import type { AgentView, ServerSummary, TabView, WorkspaceView } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  dealIntoColumns,
  gridWidth,
  machineRuns,
  runsIntoColumns,
  SPACE_GAP_X,
  SPACE_GAP_Y,
  SPACE_WIDTH,
  spaceColumns,
  WIDE_GUTTER,
  type MachineRun,
} from "@/lib/wide-dashboard";

/** Where the dashboard's control block is drawn: one 44px row across the grid, or the phone's two rows in one column. */
export type ControlPlace = "row" | "column";

export interface WideDashboardProps {
  /** The dashboard's own width in px. The route measures it; the column count is read from it and from nothing else. */
  width: number;
  agents: readonly AgentView[];
  shellPanes?: readonly AgentView[];
  tabs?: readonly TabView[];
  workspaces?: readonly WorkspaceView[];
  servers?: readonly ServerSummary[];
  /** Which panes are pinned (ADR 0070). Omit and nothing is. */
  isPinned?: (pane: AgentView) => boolean;
  /** Open a row's session, with the row as the glide origin, as `AgentList`'s `onOpen`. */
  onOpen: (pane: AgentView, row?: HTMLElement) => void;
  /** The herd is the saved copy: rows dim and speak in the past tense, as on the phone. */
  stale?: boolean;
  /** The dashboard's control block (the summary line, the needs-you switch, the Space filter, the order, the magnifier), drawn for each place. */
  controls: Readonly<Record<ControlPlace, ReactNode>>;
  /** What follows the list on the phone, in the phone's order: Launch, the Spaces navigator, Programs, the Tricks Space. */
  after?: ReactNode;
}

const NO_PANES: readonly AgentView[] = [];
const NOT_PINNED = () => false;

/** The heading's mark: blocked when a session inside needs you, as the phone's heading. */
function urgentMark(panes: readonly AgentView[]): "blocked" | undefined {
  return worstTriage(panes) === "needs" ? "blocked" : undefined;
}

interface Herd {
  readonly pinned: AgentView[];
  readonly runs: MachineRun<ShownGroup>[];
}

/** The phone list's groups and Pinned rows, cut into one run per machine. */
function readHerd({ agents, shellPanes = NO_PANES, tabs, workspaces, servers, isPinned = NOT_PINNED }: WideDashboardProps): Herd {
  const groups = groupPanesByWorkspace(agents, shellPanes, { order: "fixed", tabs, workspaces, servers });
  return { pinned: pinnedRows(groups, isPinned), runs: machineRuns(shownGroups(groups, false, isPinned)) };
}

function Row({ pane, scope, density = "row", onOpen, stale }: { pane: AgentView; scope: "place" | "herd"; density?: "row" | "card"; onOpen: WideDashboardProps["onOpen"]; stale: boolean }) {
  return (
    <AgentCard
      agent={pane}
      onClick={(el) => onOpen(pane, el)}
      scope={scope}
      statusStyle="dot"
      density={density}
      unseen={bucketOf(pane) === "ready"}
      tint
      stale={stale}
    />
  );
}

/** One Space: its heading and its sessions in one bordered group, the phone's section at a fixed width. */
export function SpaceCard({ shown, onOpen, stale = false, className }: { shown: ShownGroup; onOpen: WideDashboardProps["onOpen"]; stale?: boolean; className?: string }) {
  const g = shown.group;
  return (
    <section data-space={g.key} className={cn("flex min-w-0 flex-col gap-2", className)} style={{ width: SPACE_WIDTH }}>
      <SectionHeader
        label={g.heading ?? g.label}
        fade={g.key}
        tone="strong"
        mark={urgentMark(g.panes)}
        className="min-h-7"
        trailing={<StatusCounts panes={g.panes} className="shrink-0 text-[11px] text-muted-foreground" />}
      />
      <ListGroup>
        {shown.rows.map((pane) => (
          <Row key={paneRowKey(pane)} pane={pane} scope="place" onOpen={onOpen} stale={stale} />
        ))}
      </ListGroup>
    </section>
  );
}

/** The machine a run of Spaces sits on, as a label over the run. Draws nothing solo (the chip's own rule). */
function MachineLabel({ host }: { host: string }) {
  if (host === "") return null;
  return (
    <div data-slot="wide-machine" className="flex min-h-7 items-center">
      <HostChip host={host} />
    </div>
  );
}

/** The Pinned group across the grid: one list, read down the first column, then the next. */
function PinnedBand({ rows, columns, onOpen, stale }: { rows: readonly AgentView[]; columns: number; onOpen: WideDashboardProps["onOpen"]; stale: boolean }) {
  if (rows.length === 0) return null;
  return (
    <section data-slot="wide-pinned" className="flex flex-col gap-2">
      <SectionHeader label={t("home.pinned.title")} />
      <div className="flex items-start" style={{ gap: SPACE_GAP_X }}>
        {runsIntoColumns(rows, columns).map((run, i) => (
          <div key={i} style={{ width: SPACE_WIDTH }}>
            <ListGroup>
              {run.map((pane) => (
                <Row key={paneRowKey(pane)} pane={pane} scope="herd" onOpen={onOpen} stale={stale} />
              ))}
            </ListGroup>
          </div>
        ))}
      </div>
    </section>
  );
}

/** A grid of rows: every Space the same width, a row's Spaces sharing one top edge. */
function RowGrid({ items, columns, onOpen, stale }: { items: readonly ShownGroup[]; columns: number; onOpen: WideDashboardProps["onOpen"]; stale: boolean }) {
  return (
    <div
      data-slot="wide-rows"
      className="grid items-start"
      style={{ gridTemplateColumns: `repeat(${columns}, ${SPACE_WIDTH}px)`, columnGap: SPACE_GAP_X, rowGap: SPACE_GAP_Y }}
    >
      {items.map((shown) => (
        <SpaceCard key={shown.group.key} shown={shown} onOpen={onOpen} stale={stale} />
      ))}
    </div>
  );
}

/** The page column every grid option sits in: the grid's own width, centred, with the large-screen gutter. */
function GridPage({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ paddingInline: WIDE_GUTTER }}>
      <div className="mx-auto flex flex-col pb-4 pt-1" style={{ width: gridWidth(columns), gap: SPACE_GAP_Y }}>
        {children}
      </div>
    </div>
  );
}

/**
 * OPTION 1, Spaces wrap in rows. A Space is 384px wide and Spaces fill a row left to right, then the
 * next row, in the list's order, so the reading order is the phone's order read like a page. The rows
 * share their top edge, and a row is as tall as its tallest Space. A machine starts a new row under its
 * name. The control block is one row across the top, Pinned a band under it, and what follows the list
 * on the phone is the cell after the last Space.
 */
export function DashboardWideRows(props: WideDashboardProps) {
  const { width, onOpen, stale = false, controls, after } = props;
  const columns = spaceColumns(width);
  const { pinned, runs } = readHerd(props);
  return (
    <GridPage columns={columns}>
      <div data-slot="wide-controls">{controls.row}</div>
      <PinnedBand rows={pinned} columns={columns} onOpen={onOpen} stale={stale} />
      {runs.map((run) => (
        <div key={run.host} className="flex flex-col gap-2">
          <MachineLabel host={run.host} />
          <RowGrid items={run.items} columns={columns} onOpen={onOpen} stale={stale} />
        </div>
      ))}
      {after !== undefined && <div style={{ width: SPACE_WIDTH }}>{after}</div>}
    </GridPage>
  );
}

/**
 * OPTION 2, Spaces stack in columns. The same 384px columns, but each column stacks its own Spaces with
 * no hole under a short one: Space i goes to column i mod n, a rule of its place in the order and the
 * column count only. A Space that grows pushes only the Spaces under it in its own column. The top line
 * reads 1, 2, 3 across like option 1; further down, the order drifts with the heights.
 */
export function DashboardWideColumns(props: WideDashboardProps) {
  const { width, onOpen, stale = false, controls, after } = props;
  const columns = spaceColumns(width);
  const { pinned, runs } = readHerd(props);
  const last = runs.length - 1;
  return (
    <GridPage columns={columns}>
      <div data-slot="wide-controls">{controls.row}</div>
      <PinnedBand rows={pinned} columns={columns} onOpen={onOpen} stale={stale} />
      {runs.map((run, r) => {
        const cells: ReactNode[] = run.items.map((shown) => <SpaceCard key={shown.group.key} shown={shown} onOpen={onOpen} stale={stale} />);
        if (r === last && after !== undefined) cells.push(<div key="after" style={{ width: SPACE_WIDTH }}>{after}</div>);
        return (
          <div key={run.host} className="flex flex-col gap-2">
            <MachineLabel host={run.host} />
            <div data-slot="wide-columns" className="flex items-start" style={{ gap: SPACE_GAP_X }}>
              {dealIntoColumns(cells, columns).map((column, i) => (
                <div key={i} className="flex flex-col" style={{ width: SPACE_WIDTH, gap: SPACE_GAP_Y }}>
                  {column}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </GridPage>
  );
}

/**
 * OPTION 3, a strip of Spaces. Each Space is a column the screen's full height that scrolls on its own,
 * and the strip scrolls sideways and snaps to a column start, as the pane strip does (ADR 0120). The
 * first column is the phone's own top: the control block in its two rows, Pinned, and what follows the
 * list. No Space ever moves for another's sake; the cost is that Spaces past the right edge are out of
 * sight until a swipe.
 */
export function DashboardWideStrip(props: WideDashboardProps) {
  const { onOpen, stale = false, controls, after } = props;
  const { pinned, runs } = readHerd(props);
  const column = cn("flex min-h-0 shrink-0 flex-col overflow-y-auto overflow-x-hidden pb-4 pt-1", COLUMN_SNAP_CLASSES);
  return (
    <div data-slot="wide-strip" className={cn("flex min-h-0 flex-1 overflow-x-auto", STRIP_SNAP_CLASSES)} style={{ gap: SPACE_GAP_X, paddingInline: WIDE_GUTTER, scrollPaddingInline: WIDE_GUTTER }}>
      <div className={column} style={{ width: SPACE_WIDTH, gap: SPACE_GAP_Y }}>
        <div data-slot="wide-controls">{controls.column}</div>
        {pinned.length > 0 && (
          <section data-slot="wide-pinned" className="flex flex-col gap-2">
            <SectionHeader label={t("home.pinned.title")} />
            <ListGroup>
              {pinned.map((pane) => (
                <Row key={paneRowKey(pane)} pane={pane} scope="herd" onOpen={onOpen} stale={stale} />
              ))}
            </ListGroup>
          </section>
        )}
        {after}
      </div>
      {runs.flatMap((run) =>
        run.items.map((shown, i) => (
          <div key={shown.group.key} className={column} style={{ width: SPACE_WIDTH }}>
            {/* The machine's name heads its first Space only: the next machine's first column is the cut. */}
            <div className={cn(run.host === "" ? "hidden" : "min-h-7", i > 0 && "invisible")}>
              <MachineLabel host={run.host} />
            </div>
            <SpaceCard shown={shown} onOpen={onOpen} stale={stale} />
          </div>
        )),
      )}
    </div>
  );
}

/**
 * OPTION 4, needs you first. The grid of option 1, under a band that gathers every session that needs
 * you or finished unseen, as a card with its question (the hint), so the first glance on a large screen
 * is the things waiting on the person. The band is a COPY: each session also stays in its Space, marked
 * in place as on the phone. The band is as tall as what waits, so it moves the grid when a session
 * starts or stops waiting.
 */
export function DashboardWideBoard(props: WideDashboardProps) {
  const { width, onOpen, stale = false, controls, after } = props;
  const columns = spaceColumns(width);
  const { pinned, runs } = readHerd(props);
  // In the list's order, never by urgency or age: the band must not reshuffle while a person reads it.
  const waiting = runs.flatMap((run) => run.items.flatMap((s) => s.group.panes)).filter(needsYou);
  return (
    <GridPage columns={columns}>
      <div data-slot="wide-controls">{controls.row}</div>
      {waiting.length > 0 && (
        <section data-slot="wide-waiting" className="flex flex-col gap-2">
          <SectionHeader label={t("status.section.needsYou")} count={waiting.length} tone="strong" mark="blocked" className="min-h-7" />
          <div className="grid items-start" style={{ gridTemplateColumns: `repeat(${columns}, ${SPACE_WIDTH}px)`, gap: SPACE_GAP_X / 2 }}>
            {waiting.map((pane) => (
              <Row key={paneRowKey(pane)} pane={pane} scope="herd" density="card" onOpen={onOpen} stale={stale} />
            ))}
          </div>
        </section>
      )}
      <PinnedBand rows={pinned} columns={columns} onOpen={onOpen} stale={stale} />
      {runs.map((run) => (
        <div key={run.host} className="flex flex-col gap-2">
          <MachineLabel host={run.host} />
          <RowGrid items={run.items} columns={columns} onOpen={onOpen} stale={stale} />
        </div>
      ))}
      {after !== undefined && <div style={{ width: SPACE_WIDTH }}>{after}</div>}
    </GridPage>
  );
}
