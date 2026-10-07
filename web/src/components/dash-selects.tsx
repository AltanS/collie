import { Select } from "@/components/ui/select";
import { PANE_ORDER_SEGMENTS } from "@/components/pane-order-toggle";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { PANE_ORDERS, type PaneOrder } from "@/lib/pane-order";
import type { StripEntry } from "@/lib/dash-view";
import { hostName } from "@/lib/hosts";
import { worstTriage, type TriageKey } from "@/lib/triage";
import { statusLabel, type ServerSummary } from "@/lib/types";
import type { WorkspaceGroup } from "@/lib/pane-groups";

// The two selects under the dashboard's summary line (2026-10-07): the workspace filter on the left,
// the pane order on the right. They replaced the chip strip and the three-glyph order toggle, which
// took two rows and a scroller to say two things. Both are native selects (`ui/select.tsx`), so a
// phone draws its own picker and the dashboard needs no sheet of its own.

const ALL = "all";
const SHOW_HIDDEN = "show-hidden";
const spaceValue = (i: number) => `space:${i}`;
const machineValue = (i: number) => `machine:${i}`;

/**
 * The state of a workspace in words, for an option a native list cannot draw a dot on. Only a state
 * that means something is spelled: needs you, unseen, working. A workspace that is merely quiet has
 * nothing to add to its name.
 */
function stateWord(key: TriageKey | null): string | null {
  if (key === "needs") return statusLabel("blocked");
  if (key === "ready") return t("home.row.unseen");
  if (key === "working") return statusLabel("working");
  return null;
}

/**
 * The workspace filter: "All workspaces", then one option per workspace in the list's own order, each
 * followed by its state in words ("collie-workspace · needs you"). The chosen workspace shows alone,
 * the others stay in the list; "All workspaces" shows everything. It carries the chip strip's other
 * two jobs as options, so nothing the strip could do is stranded:
 *
 * - A workspace this device HID (it is left off the list, and its option says "hidden") can still be
 *   picked, which shows it alone, because isolate wins over hide. "Show hidden workspaces" brings
 *   every one of them back. The strip hid a workspace on a long press; a native list has no long
 *   press, so hiding one is no longer offered here and a stored choice keeps working.
 * - A hidden MACHINE (issue #288) is one "Show <machine>'s panes" option where its stand-in chip
 *   sat, so a machine that is off the list is never unreachable, the Machines sheet hidden too.
 *
 * The two action options are not values: the select stays on the workspace that was chosen, and the
 * list changes under it.
 */
export function WorkspaceSelect({
  entries,
  isolatedKey,
  isHidden,
  servers,
  onIsolate,
  onShowHidden,
  onShowMachine,
  className,
}: {
  /** The strip's entries (lib/dash-view.ts): a workspace, or the one stand-in for a hidden machine. */
  entries: readonly StripEntry[];
  /** The group key of the isolated workspace, or undefined when the list shows everything. */
  isolatedKey: string | undefined;
  /** Whether this device hides a workspace (its stored choice, by the key a device remembers it by). */
  isHidden: (group: WorkspaceGroup) => boolean;
  servers: readonly ServerSummary[] | undefined;
  /** Pick a workspace (its group), or null for all of them. */
  onIsolate: (group: WorkspaceGroup | null) => void;
  /** Bring back every hidden workspace. Withheld, the option is not offered. */
  onShowHidden?: ((groups: readonly WorkspaceGroup[]) => void) | undefined;
  onShowMachine?: ((host: string) => void) | undefined;
  className?: string;
}) {
  useLocale();
  const hiddenGroups = entries.flatMap((e) => (e.kind === "space" && isHidden(e.group) ? [e.group] : []));
  const current = entries.findIndex((e) => e.kind === "space" && e.group.key === isolatedKey);
  return (
    <Select
      className={className}
      aria-label={t("home.workspaceFilter.aria")}
      value={current === -1 ? ALL : spaceValue(current)}
      onChange={(event) => {
        const value = event.target.value;
        if (value === ALL) return onIsolate(null);
        if (value === SHOW_HIDDEN) return onShowHidden?.(hiddenGroups);
        const entry = entries[Number(value.slice(value.indexOf(":") + 1))];
        if (entry === undefined) return;
        if (entry.kind === "machine") return onShowMachine?.(entry.host);
        onIsolate(entry.group);
      }}
    >
      <option value={ALL}>{t("home.workspaceFilter.all")}</option>
      {entries.map((entry, i) => {
        if (entry.kind === "machine") {
          const name = hostName(servers, entry.host) ?? entry.host;
          return (
            <option key={`machine\u0000${entry.host}`} value={machineValue(i)}>
              {t("home.machineHidden.show", { name })}
            </option>
          );
        }
        const words = [stateWord(worstTriage(entry.group.panes)), isHidden(entry.group) ? t("home.workspace.hidden") : null];
        return (
          <option key={entry.group.key} value={spaceValue(i)}>
            {[entry.group.label, ...words.filter((w) => w !== null)].join(" · ")}
          </option>
        );
      })}
      {hiddenGroups.length > 0 && onShowHidden !== undefined && (
        <option value={SHOW_HIDDEN}>{t("home.workspaceFilter.showHidden")}</option>
      )}
    </Select>
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
