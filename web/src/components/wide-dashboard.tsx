// THE DASHBOARD ON A LARGE SCREEN (ADR 0158): the parts `AgentList` draws its groups with when the route
// gives it a grid (`wide`), in the window's `expanded` width class and with Large-screen layout not Off.
// The phone's dashboard is the same `AgentList` without `wide`, and does not change.
//
// Every part is the SAME component the phone list draws, at a fixed width: the Space heading
// (`SectionHeader`, strong, with its urgent mark and `StatusCounts`), the rows (`AgentCard`, 44px, the dot,
// the tint, the unseen mark), one `ListGroup` per Space, the Pinned group and the host chip of a crew.
// What changes is where a Space stands: in a grid of fixed 384px columns that wrap in rows, in the list's
// own order (machine, Space number, tab number), never by status.
//
// ONE EXCEPTION to "urgency is a mark, not a position" (ADR 0147, amended by 0158): a band above the grid
// repeats every session that needs the person or finished unseen, as a card with its question. The band
// is a copy. Each session also keeps its row in its Space, with its mark.

import type { ReactNode } from "react";

import { HostChip } from "@/components/host-chip";
import { SectionHeader } from "@/components/section-header";
import { StatusCounts } from "@/components/status-counts";
import { ListGroup } from "@/components/ui/list-group";
import { t } from "@/lib/i18n";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { worstTriage } from "@/lib/triage";
import type { AgentView } from "@/lib/types";
import { runsIntoColumns, SPACE_GAP_X, SPACE_GAP_Y, SPACE_WIDTH } from "@/lib/wide-dashboard";

/** The heading's mark: blocked when a session inside needs you, as the phone's heading. */
function urgentMark(panes: readonly AgentView[]): "blocked" | undefined {
  return worstTriage(panes) === "needs" ? "blocked" : undefined;
}

/** `columns` fixed Space columns, a row of Spaces sharing one top edge. */
function columnTemplate(columns: number): string {
  return `repeat(${columns}, ${SPACE_WIDTH}px)`;
}

/** One Space: its heading and its sessions in one bordered group, the phone's section at a fixed width. */
export function WideSpace({ group, id, trailing, children }: { group: WorkspaceGroup; id: string; trailing?: ReactNode; children: ReactNode }) {
  return (
    <section data-space={group.key} id={id} className="flex min-w-0 scroll-mt-4 flex-col gap-2" style={{ width: SPACE_WIDTH }}>
      <SectionHeader
        label={group.heading ?? group.label}
        fade={group.key}
        tone="strong"
        mark={urgentMark(group.panes)}
        className="min-h-7"
        trailing={
          <>
            <StatusCounts panes={group.panes} className="shrink-0 text-[11px] text-muted-foreground" />
            {trailing}
          </>
        }
      />
      <ListGroup>{children}</ListGroup>
    </section>
  );
}

/** A grid of Spaces: every Space the same width, a row's Spaces sharing one top edge, a row as tall as its tallest Space. */
export function SpaceGrid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div data-slot="wide-rows" className="grid items-start" style={{ gridTemplateColumns: columnTemplate(columns), columnGap: SPACE_GAP_X, rowGap: SPACE_GAP_Y }}>
      {children}
    </div>
  );
}

/** One machine's Spaces under its name. The name is the chip's own rule: nothing on a solo list. */
export function MachineRun({ host, children }: { host: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      {host !== "" && (
        <div data-slot="wide-machine" className="flex min-h-7 items-center">
          <HostChip host={host} />
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * One list of rows across the grid, read down the first column, then the next: the Pinned group, and the one
 * ranked list of Activity and Cache order. Each column is one `ListGroup` at a Space's width.
 */
export function ListColumns({ rows, columns, renderRow }: { rows: readonly AgentView[]; columns: number; renderRow: (pane: AgentView) => ReactNode }) {
  return (
    <div className="flex items-start" style={{ gap: SPACE_GAP_X }}>
      {runsIntoColumns(rows, columns).map((run, i) => (
        <div key={i} className="min-w-0" style={{ width: SPACE_WIDTH }}>
          <ListGroup>{run.map(renderRow)}</ListGroup>
        </div>
      ))}
    </div>
  );
}

/**
 * The band above the grid: a card for each session that needs you or finished unseen, with its question.
 * The cards stand on the grid's own column edges (the same column gap as the Spaces under them). The caller opens and closes it through `Collapse` and draws each card. The band's own bottom air is
 * inside, so it moves with the band.
 */
export function WaitingBand({ count, columns, children }: { count: number; columns: number; children: ReactNode }) {
  return (
    <section data-slot="wide-waiting" className="flex flex-col gap-2 pb-5">
      <SectionHeader label={t("status.section.needsYou")} count={count} tone="strong" mark="blocked" className="min-h-7" />
      <div className="grid items-start" style={{ gridTemplateColumns: columnTemplate(columns), columnGap: SPACE_GAP_X, rowGap: SPACE_GAP_X / 2 }}>
        {children}
      </div>
    </section>
  );
}
