import { useRevalidator } from "react-router";

import { MachineAlertsControl } from "@/components/machine-alerts-control";
import { SettingsNavRow } from "@/components/settings-nav-row";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t, type MessageKey } from "@/lib/i18n";
import type { MachinesData } from "@/lib/loaders";
import { formatPercent } from "@/lib/machine-units";
import { machineLoadPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { MachineMetric, MachineRow } from "@/lib/types";

// MACHINE LOAD, ON NOTIFICATIONS (ADR 0170). A load alert is a notification, so a person who looks for "tell me
// when the CPU stays high" looks on Notifications. The rules belong to each machine, and the machine's own page
// keeps its card; this group is one more door to the SAME card (`MachineAlertsControl`, one registry id per rule),
// never a copy of it.
//
// One machine: its three alerts in place, because a list of one row with a page behind it is a step for nothing.
// A crew: one row per machine with its rules as a line, and the row opens the card on a page of its own
// (`/settings/notifications/load/:machine`).

const METRICS = ["cpu", "mem", "disk"] as const satisfies readonly MachineMetric[];

const METRIC_NAME = {
  cpu: "machines.metric.cpu",
  mem: "machines.metric.mem",
  disk: "machines.metric.disk",
} as const satisfies Record<MachineMetric, MessageKey>;

/** A machine answers but reports no load: no rule on it could fire. A machine that is down is not a reason to say update. */
export function needsUpdate(row: MachineRow): boolean {
  return row.sample === undefined && (row.health === "reachable" || row.health === "incompatible");
}

/** The machine's rules in one line: "CPU above 90% for at least 10 min · Memory above 95% for at least 5 min", or "No alerts". */
export function rulesLine(row: MachineRow): string {
  if (needsUpdate(row)) return t("settings.load.needsUpdate");
  const rules = METRICS.flatMap((metric) => {
    const rule = row.alerts[metric];
    if (rule === undefined) return [];
    return [t("settings.load.rule", { metric: t(METRIC_NAME[metric]), percent: formatPercent(rule.above), minutes: rule.forMin })];
  });
  return rules.length === 0 ? t("settings.load.none") : rules.join(" · ");
}

/** The card of one machine's rules, as its own page draws it. */
export function MachineLoadCard({ row }: { row: MachineRow }) {
  const revalidator = useRevalidator();
  return (
    <MachineAlertsControl
      machineId={row.id}
      alerts={row.alerts}
      firing={row.firing}
      needsUpdate={needsUpdate(row)}
      hasDisks={row.sample?.disks !== undefined}
      onSaved={() => void revalidator.revalidate()}
    />
  );
}

export function MachineLoadSettings({ data }: { data: MachinesData }) {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const machines = data.census?.machines ?? [];
  if (machines.length === 0) return null;
  const only = machines.length === 1 ? machines[0] : undefined;
  if (only !== undefined) return <MachineLoadCard row={only} />;
  return (
    <Card className="gap-0 py-0" data-slot="machine-load-rows">
      <ul className="divide-y divide-border">
        {machines.map((row) => (
          <li key={row.id}>
            <SettingsNavRow
              icon="machine-activity"
              title={row.name}
              caption={rulesLine(row)}
              onOpen={() => nav.down(machineLoadPath(row.id, scope))}
            />
          </li>
        ))}
      </ul>
    </Card>
  );
}
