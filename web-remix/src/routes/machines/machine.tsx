// One machine, in two views under the header (web/src/routes/machine.tsx): Status (its numbers large, a
// bar per disk, then CPU, memory, disk and network over the last hour or day) and Alerts (its rules).
//
// THE VIEW IS IN THE URL, AND A SWITCH IS SIDEWAYS. Status is the page with no parameter, Alerts is
// `?tab=alerts` (`machineTabOf`). A switch is a SIDE move (ADR 0067): it replaces this entry, so the two
// views are one level and Back leaves the machine for wherever it was opened from, never to the other
// view. While a rule fires, the Alerts segment carries a dot, said in words to a screen reader.
//
// TWO CLOCKS, TWO READS. The row (numbers, health, rules, firing) comes from the census the list reads, so
// it rides the beat and an alert firing shows within a tick. The history does not: it is up to 1440
// points that change once a minute, so `history-data.ts` reads it on open and then once a minute while
// Status is shown. The 1 h and 24 h views are one answer sliced client-side. An older machine, which
// never sent a reading, gets no charts at all. Every age is measured against the answer's `ts`.
//
// Keyed by the machine id in the route action, so a machine never inherits another's history or range.
import type { Handle } from "remix/component";
import { Clock } from "lucide";

import { t } from "@web/lib/i18n";
import type { MachineRange } from "@web/lib/machine-chart";
import { machineReading } from "@web/lib/machine-reading";
import { machinePath, machinesPath, machineTabOf, settingsSectionPath, type MachineTab } from "@web/lib/nav";
import type { MachineAlerts, MachineHistoryResponse, MachineRow } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { kick, want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { Segmented } from "../../ui/segmented";
import { healthTone, healthWord } from "../crew/formation";
import { Frame } from "../frame/frame";
import { goDown, goSide } from "../frame/up";
import { MachineAlertsControl } from "./alerts-control";
import { LeadBadge } from "./card";
import { ChartPlaceholder, MachineChart, type MachineChartKind } from "./chart";
import { MACHINES_SOURCE, machines } from "./data";
import { MachinesEmptyCard } from "./empty-card";
import { historySource, machineHistory } from "./history-data";
import { MachineLoad, readingLine } from "./load";

const CHART_TITLE = {
  cpu: "machines.metric.cpu",
  mem: "machines.metric.mem",
  disk: "machines.metric.disk",
  net: "machines.metric.net",
} as const satisfies Record<MachineChartKind, string>;

const CHARTS: readonly MachineChartKind[] = ["cpu", "mem", "disk", "net"];

export function MachineRoute(handle: Handle<{ machineId: string }>) {
  // Keyed by the id (routes/frame/map.tsx), so setup may read it once.
  const id = handle.props.machineId;
  want(MACHINES_SOURCE, handle.signal);
  want(historySource(id), handle.signal);
  const readCensus = useStore(handle, machines);
  const readHistory = useStore(handle, machineHistory(id));
  const where = useStore(handle, address);
  useLocale(handle);
  let range: MachineRange = "hour";
  // The first history read ran before the census named this machine, so it asked for nothing. Ask once more
  // the moment the row exists, rather than waiting out a beat.
  let kicked = false;
  const switchTab = (next: MachineTab): void => goSide(machinePath(id, where().scope, next));

  return () => {
    const { census, error, loaded } = readCensus();
    const { history, failed } = readHistory();
    const scope = where().scope;
    const tab = machineTabOf(window.location.search);
    const row = census?.machines.find((m) => m.id === id);
    // An older machine never sent a reading, so the lead holds no minute of it: no charts.
    const older = row !== undefined && census !== null && machineReading(row, census.ts) === "older";
    if (!kicked && row !== undefined && history === null && !failed) {
      kicked = true;
      handle.queueTask(() => kick());
    }
    return (
      <Frame
        title={row === undefined ? t("machines.title") : row.name || row.id}
        backLabel={t("machines.nav.back")}
        up={machinesPath(scope)}
      >
        {!loaded ? (
          <div class="h-48 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" data-testid="machine-skeleton" aria-hidden="true" />
        ) : census === null ? (
          <MachinesEmptyCard reason={error ? "error" : "unavailable"} />
        ) : row === undefined ? (
          <MachinesEmptyCard reason="unknown" />
        ) : (
          <>
            <Segmented
              semantics="tabs"
              label={t("machines.view.label")}
              options={[
                { value: "status", label: t("machines.view.status") },
                {
                  value: "alerts",
                  label: t("machines.view.alerts"),
                  mark: row.firing.length > 0 ? t("machines.view.firing") : undefined,
                },
              ]}
              value={tab}
              onChange={(next) => switchTab(next === "alerts" ? "alerts" : "status")}
            />
            {tab === "status" ? (
              <>
                <NowCard row={row} ts={census.ts} multi={census.machines.length > 1} onOpenAlerts={() => switchTab("alerts")} />
                {older ? null : (
                  <>
                    <Segmented
                      label={t("machines.range.label")}
                      options={[
                        { value: "hour", label: t("machines.range.hour") },
                        { value: "day", label: t("machines.range.day") },
                      ]}
                      value={range}
                      onChange={(next) => {
                        range = next === "day" ? "day" : "hour";
                        void handle.update();
                      }}
                    />
                    {CHARTS.map((kind) => (
                      <Card key={kind} class="gap-0 py-0" data-testid="chart-card" data-kind={kind}>
                        <h2 class="px-4 pt-3 pb-1 text-sm font-medium">{t(CHART_TITLE[kind])}</h2>
                        <ChartBody kind={kind} history={history} failed={failed} range={range} alerts={row.alerts} />
                      </Card>
                    ))}
                  </>
                )}
              </>
            ) : (
              <MachineAlertsControl
                machineId={row.id}
                alerts={row.alerts}
                firing={row.firing}
                // An older member answers but reports no load, so no rule on it could ever fire. A machine
                // that is down has no reading either, and that is not a reason to say update.
                needsUpdate={row.sample === undefined && (row.health === "reachable" || row.health === "incompatible")}
                hasDisks={row.sample?.disks !== undefined}
                onOpenAlerts={() => goDown(settingsSectionPath("alerts", scope))}
              />
            )}
          </>
        )}
      </Frame>
    );
  };
}

interface NowCardProps {
  row: MachineRow;
  ts: number;
  multi: boolean;
  onOpenAlerts: () => void;
}

/**
 * The numbers now, large, under one line that says the machine's health and the age of its reading. The
 * age is there on a live machine too: numbers with no age are a claim about now. A reachable machine
 * whose reading stopped moving ("stale") keeps its numbers, quieted, and its age turns the waiting colour
 * with a clock beside it, so the state is said in words and marked, not tinted alone.
 */
function NowCard(handle: Handle<NowCardProps>) {
  return () => {
    const { row, ts, multi, onOpenAlerts } = handle.props;
    const reading = machineReading(row, ts);
    const stale = reading === "stale";
    return (
      <Card class="gap-0 py-0" data-testid="machine-now">
        <div class="space-y-4 p-4">
          <div class="flex min-h-5 items-center justify-between gap-3 text-sm">
            <div class="flex min-w-0 items-center gap-2">
              <span class={healthTone(row)}>{healthWord(row)}</span>
              {multi && row.isLead ? <LeadBadge /> : null}
            </div>
            {reading === "live" || stale ? (
              <span class={cn("flex shrink-0 items-center gap-1 text-xs tabular-nums", stale ? "font-medium text-status-working" : "text-muted-foreground")}>
                {stale ? <ClockMark /> : null}
                {readingLine(row, ts)}
              </span>
            ) : null}
          </div>
          <div class={cn(stale && "opacity-60")}>
            <MachineLoad row={row} ts={ts} size="large" onOpenAlerts={onOpenAlerts} />
          </div>
        </div>
      </Card>
    );
  };
}

function ClockMark() {
  return () => <Icon icon={Clock} class="size-3.5" />;
}

interface ChartBodyProps {
  kind: MachineChartKind;
  history: MachineHistoryResponse | null;
  failed: boolean;
  range: MachineRange;
  alerts: MachineAlerts;
}

/** One chart card's body: the chart, or a same-height box saying why there is none yet. */
function ChartBody(handle: Handle<ChartBodyProps>) {
  return () => {
    const { kind, history, failed, range, alerts } = handle.props;
    if (history === null) {
      return failed ? (
        <ChartPlaceholder>{t("machines.history.error")}</ChartPlaceholder>
      ) : (
        <ChartPlaceholder skeleton>{t("machines.history.loading")}</ChartPlaceholder>
      );
    }
    const rule = kind === "net" ? undefined : alerts[kind];
    return (
      <MachineChart
        kind={kind}
        points={history.points}
        ts={history.ts}
        stepMs={history.stepMs}
        range={range}
        threshold={rule?.above ?? null}
      />
    );
  };
}
