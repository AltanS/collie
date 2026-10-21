import { useId, useState } from "react";
import { Check, ChevronDown } from "lucide-react";

import { Select } from "@/components/ui/select";
import { BottomSheet } from "@/components/ui/sheet";
import { PANE_ORDER_SEGMENTS } from "@/components/pane-order-toggle";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import { PANE_ORDERS, type PaneOrder } from "@/lib/pane-order";
import type { StripEntry } from "@/lib/dash-view";
import { hostName } from "@/lib/hosts";
import { worstTriage, type TriageKey } from "@/lib/triage";
import { statusLabel, type ServerSummary } from "@/lib/types";
import type { WorkspaceGroup } from "@/lib/pane-groups";
import { cn } from "@/lib/utils";

// The two controls under the dashboard's summary line (2026-10-07): the workspace filter on the left,
// the pane order on the right. They replaced the chip strip and the three-glyph order toggle, which
// took two rows and a scroller to say two things. The order is a native select (`ui/select.tsx`).
// The workspace filter chooses SEVERAL workspaces (issue #527), and a native `multiple` select reads
// poorly on a phone, so it is a button drawn as the same 44px box that opens a sheet of checks.

/** Above this many chosen workspaces, the closed filter counts them instead of naming them. */
const NAMED_CHOICES = 2;

/**
 * The state of a workspace in words, for a row that draws no dot. Only a state that means something
 * is spelled: needs you, unseen, working. A workspace that is merely quiet has nothing to add to its
 * name.
 */
function stateWord(key: TriageKey | null): string | null {
  if (key === "needs") return statusLabel("blocked");
  if (key === "ready") return t("home.row.unseen");
  if (key === "working") return statusLabel("working");
  return null;
}

/**
 * What the closed filter says: "All workspaces" when nothing is chosen, the chosen names while they
 * are few ("collie, membero"), and a count past that ("3 workspaces").
 */
function choiceLabel(chosen: readonly WorkspaceGroup[]): string {
  if (chosen.length === 0) return t("home.workspaceFilter.all");
  if (chosen.length <= NAMED_CHOICES) return chosen.map((g) => g.label).join(", ");
  return tn("home.workspaceFilter.count", chosen.length);
}

/** One checkable row of the filter's sheet: a 44px row with its check box, the label, then words. */
function CheckRow({
  checked,
  label,
  words,
  onToggle,
}: {
  checked: boolean;
  label: string;
  words: readonly string[];
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex min-h-11 w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors hover:bg-accent active:bg-muted"
    >
      <span
        aria-hidden
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded border",
          checked ? "border-primary bg-primary/20 text-primary" : "border-border bg-background",
        )}
      >
        {checked ? <Check className="size-3" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium text-foreground">{label}</span>
        {words.map((word) => (
          <span key={word} className="text-muted-foreground">{` · ${word}`}</span>
        ))}
      </span>
    </button>
  );
}

/** A row of the filter's sheet that does something rather than choosing: show a machine, or the hidden. */
function ActionRow({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex min-h-11 w-full items-center rounded-lg px-3 py-2.5 pl-10 text-left text-sm text-muted-foreground transition-colors hover:bg-accent active:bg-muted"
    >
      {label}
    </button>
  );
}

/**
 * The workspace filter (issue #527): a button that names the choice, and a sheet that holds it.
 * "All workspaces" first, then one check per workspace in the list's own order, each followed by its
 * state in words ("collie-workspace · needs you"). The chosen workspaces show, in the list's order,
 * the others stay in the sheet; "All workspaces" shows everything, and unchecking the last chosen
 * workspace does the same. A tap applies at once and the sheet stays up, so several workspaces are
 * chosen in one visit. It carries the chip strip's other two jobs as rows, so nothing the strip could
 * do is stranded:
 *
 * - A workspace this device HID (it is left off the list, and its row says "hidden") can still be
 *   chosen, which shows it, because isolate wins over hide. "Show hidden workspaces" brings every one
 *   of them back. Hiding one is not offered here, and a stored choice keeps working.
 * - A hidden MACHINE (issue #288) is one "Show <machine>'s panes" row where its stand-in chip sat, so
 *   a machine that is off the list is never unreachable, the Machines sheet hidden too.
 */
export function WorkspaceFilter({
  entries,
  isolatedKeys,
  isHidden,
  servers,
  onIsolate,
  onShowHidden,
  onShowMachine,
  className,
}: {
  /** The strip's entries (lib/dash-view.ts): a workspace, or the one stand-in for a hidden machine. */
  entries: readonly StripEntry[];
  /** The group keys of the chosen workspaces; empty when the list shows everything. */
  isolatedKeys: ReadonlySet<string>;
  /** Whether this device hides a workspace (its stored choice, by the key a device remembers it by). */
  isHidden: (group: WorkspaceGroup) => boolean;
  servers: readonly ServerSummary[] | undefined;
  /** Choose these workspaces (their groups, in the list's order), or none for all of them. */
  onIsolate: (groups: WorkspaceGroup[]) => void;
  /** Bring back every hidden workspace. Withheld, the row is not offered. */
  onShowHidden?: ((groups: readonly WorkspaceGroup[]) => void) | undefined;
  onShowMachine?: ((host: string) => void) | undefined;
  className?: string;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const labelId = useId();
  const valueId = useId();
  const spaces = entries.flatMap((e) => (e.kind === "space" ? [e.group] : []));
  const chosen = spaces.filter((g) => isolatedKeys.has(g.key));
  const hiddenGroups = spaces.filter(isHidden);
  const toggle = (group: WorkspaceGroup) => {
    const on = chosen.includes(group);
    onIsolate(spaces.filter((g) => (g === group ? !on : chosen.includes(g))));
  };
  return (
    <div className={cn("relative", className)}>
      <span id={labelId} className="sr-only">
        {t("home.workspaceFilter.aria")}
      </span>
      {/* The same 44px box, border, corner and chevron as `ui/select.tsx`, so the row under the
          summary still reads as two selects side by side. */}
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => setOpen(true)}
        className="flex h-11 w-full items-center rounded-lg border border-border bg-background pl-3 pr-8 text-left text-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <span id={valueId} className="min-w-0 truncate">
          {choiceLabel(chosen)}
        </span>
      </button>
      <ChevronDown
        aria-hidden
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t("home.workspaceFilter.title")}>
        <div className="flex flex-col gap-1">
          <CheckRow
            checked={chosen.length === 0}
            label={t("home.workspaceFilter.all")}
            words={[]}
            onToggle={() => onIsolate([])}
          />
          {entries.map((entry) => {
            if (entry.kind === "machine") {
              const name = hostName(servers, entry.host) ?? entry.host;
              return (
                <ActionRow
                  key={`machine\u0000${entry.host}`}
                  label={t("home.machineHidden.show", { name })}
                  onClick={() => onShowMachine?.(entry.host)}
                />
              );
            }
            const words = [stateWord(worstTriage(entry.group.panes)), isHidden(entry.group) ? t("home.workspace.hidden") : null];
            return (
              <CheckRow
                key={entry.group.key}
                checked={isolatedKeys.has(entry.group.key)}
                label={entry.group.label}
                words={words.filter((w) => w !== null)}
                onToggle={() => toggle(entry.group)}
              />
            );
          })}
          {hiddenGroups.length > 0 && onShowHidden !== undefined && (
            <ActionRow label={t("home.workspaceFilter.showHidden")} onClick={() => onShowHidden(hiddenGroups)} />
          )}
        </div>
      </BottomSheet>
    </div>
  );
}

/** The pane order as a select: Place, Activity, Cache, its glyph in front of the chosen word. */
export function PaneOrderSelect({
  order,
  onChange,
  className,
}: {
  order: PaneOrder;
  onChange: (order: PaneOrder) => void;
  className?: string;
}) {
  useLocale();
  const { Icon } = PANE_ORDER_SEGMENTS[order];
  return (
    <Select
      className={className}
      aria-label={t("paneOrder.aria")}
      value={order}
      lead={<Icon className="size-4" />}
      onChange={(event) => {
        const next = PANE_ORDERS.find((o) => o === event.target.value);
        if (next !== undefined) onChange(next);
      }}
    >
      {PANE_ORDERS.map((value) => (
        <option key={value} value={value}>
          {t(PANE_ORDER_SEGMENTS[value].label)}
        </option>
      ))}
    </Select>
  );
}
