import { on, type Handle } from "remix/component";
import { Check } from "lucide";

import { t } from "@web/lib/i18n";
import { isUnseen } from "@web/lib/triage";
import { statusLabel, type AgentStatus, type AgentView } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";
import { UnseenMark } from "../../ui/unseen-mark";

// Port of web/src/components/status-counts.tsx: every state counted once, in urgency order, and the
// one summary line above the dashboard that jumps to the first thing that needs you. Not ported:
// the right-edge overflow fade (ui/overflow-edges), which is a measurement hook of its own.
type Counted = { kind: "status"; status: AgentStatus } | { kind: "unseen" };
const ORDER: readonly Counted[] = [
  { kind: "status", status: "blocked" },
  { kind: "unseen" },
  { kind: "status", status: "working" },
  { kind: "status", status: "done" },
  { kind: "status", status: "idle" },
];
const SPELLED_MAX_COUNTS = 2;

interface StateCounts {
  blocked: number;
  unseen: number;
  working: number;
  done: number;
  idle: number;
}

const keyOf = (c: Counted): keyof StateCounts =>
  c.kind === "unseen" ? "unseen" : c.status === "blocked" || c.status === "working" || c.status === "done" ? c.status : "idle";

function countStates(panes: readonly AgentView[]): StateCounts {
  const n: StateCounts = { blocked: 0, unseen: 0, working: 0, done: 0, idle: 0 };
  for (const p of panes) {
    if (p.kind === "shell") continue;
    if (p.status === "blocked") n.blocked++;
    else if (isUnseen(p)) n.unseen++;
    else if (p.status === "working") n.working++;
    else if (p.status === "done") n.done++;
    else if (p.status === "idle") n.idle++;
  }
  return n;
}

export function StatusCounts(handle: Handle<{ panes: readonly AgentView[]; labelled?: boolean; class?: string }>) {
  return () => {
    const { panes, labelled = false } = handle.props;
    const n = countStates(panes);
    const shown = ORDER.filter((c) => n[keyOf(c)] > 0);
    if (shown.length === 0) return null;
    return (
      <span
        class={cn(
          "flex min-w-0 flex-nowrap items-center overflow-hidden py-0.5 leading-none tabular-nums",
          labelled ? "gap-x-2" : "gap-x-3",
          handle.props.class,
        )}
      >
        {shown.map((c, i) => {
          const k = keyOf(c);
          const spelled = labelled && i === 0 && shown.length <= SPELLED_MAX_COUNTS;
          const word = c.kind === "unseen" ? t("home.row.unseen") : statusLabel(c.status);
          return (
            <span
              key={k}
              class={cn("flex shrink-0 items-center gap-1.5 whitespace-nowrap", k === "blocked" && "text-status-blocked")}
              aria-label={spelled ? undefined : `${String(n[k])} ${word}`}
            >
              <span aria-hidden="true" class="flex size-3 shrink-0 items-center justify-center">
                {c.kind === "unseen" ? <UnseenMark size="sm" /> : <StatusDot status={c.status} class="size-2" />}
              </span>
              <span aria-hidden={spelled ? undefined : "true"}>{spelled ? `${String(n[k])} ${word}` : n[k]}</span>
            </span>
          );
        })}
      </span>
    );
  };
}

export interface StatusSummaryLineProps {
  panes: readonly AgentView[];
  allClear: boolean;
  onJump?: (() => void) | undefined;
  id?: string;
  /** Keep a line with no `onJump` reachable by script (`aria-disabled`, `tabindex=-1`), web/'s rule. */
  focusable?: boolean;
  class?: string;
}

export function StatusSummaryLine(handle: Handle<StatusSummaryLineProps>) {
  return () => {
    const { panes, allClear, onJump, id, focusable = false } = handle.props;
    const inert = onJump === undefined;
    return (
      <button
        id={id}
        type="button"
        disabled={inert && !focusable}
        aria-disabled={inert && focusable ? "true" : undefined}
        tabIndex={inert && focusable ? -1 : undefined}
        data-testid="summary-line"
        mix={on("click", () => handle.props.onJump?.())}
        class={cn(
          "flex min-h-8 min-w-0 max-w-full items-center gap-3 text-left text-xs font-medium text-foreground disabled:opacity-100",
          handle.props.class,
        )}
      >
        {allClear && (
          <span class="flex min-w-0 items-center gap-1.5 leading-none">
            <Icon icon={Check} class="size-4 shrink-0 text-status-done" />
            <span class="min-w-0 truncate">{t("home.allClear")}</span>
          </span>
        )}
        <StatusCounts panes={panes} labelled={!allClear} class={allClear ? "text-muted-foreground" : undefined} />
      </button>
    );
  };
}
