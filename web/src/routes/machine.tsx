import { useState } from "react";
import { ArrowLeft, Clock } from "lucide-react";
import { useLoaderData, useLocation, useParams, useRevalidator } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { healthTone, healthWord } from "@/components/crew-formation";
import { MachineAlertsControl } from "@/components/machine-alerts-control";
import { LeadBadge } from "@/components/machine-card";
import { ChartPlaceholder, MachineChart, type MachineChartKind } from "@/components/machine-chart";
import { MachineLoad, readingLine } from "@/components/machine-load";
import { MachinesEmptyCard } from "@/components/machines-empty-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import { useMachineHistory, type MachineHistoryState } from "@/hooks/use-machine-history";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import type { MachinesData } from "@/lib/loaders";
import type { MachineRange } from "@/lib/machine-chart";
import { machineReading } from "@/lib/machine-reading";
import { machinePath, machinesPath, machineTabOf, settingsSectionPath, type MachineTab } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { MachineAlerts, MachineHistoryResponse, MachineRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BandMain } from "@/components/ui/strip-host";

// One machine, in two views under the header: Status (its numbers large, a bar per disk, then CPU,
// memory, disk and network over the last hour or day) and Alerts (its rules).
//
// ── THE VIEW IS IN THE URL, AND A SWITCH IS SIDEWAYS ─────────────────────────
// Status is the page with no parameter, Alerts is `?tab=alerts` (lib/machine-paths.ts). A switch is a
// SIDE move (ADR 0067): it replaces this entry and carries its `from` over, so the two views are one
// level, and Back (the arrow or the edge swipe) leaves the machine for wherever it was opened from,
// never to the other view. A push about a machine opens Status, where the numbers are; the "Alert
// firing" line on Status and on a card opens Alerts, where the rule is. While a rule fires, the Alerts
// segment carries a dot, said in words to a screen reader.
//
// ── TWO CLOCKS, TWO READS ────────────────────────────────────────────────────
// The row (numbers, health, rules, firing) comes from the SAME loader the list uses, so it rides the
// poll loop and an alert firing shows within a tick. The history does not: it is up to 1440 points that
// change once a minute, so `useMachineHistory` reads it on open and then once a minute while visible.
// The 1 h and 24 h views are one answer sliced client-side; switching is instant and asks for nothing.
// The history is read only while Status is shown: Alerts draws no chart, so it reads none, and coming
// back to Status asks only for the minutes since the last point held. An older machine, which never
// sent a reading, gets no charts at all: the lead holds no minute of it.
//
// Every age is measured against the answer's `ts` (the loader's for the row, the history's own for the
// charts), never `Date.now()`.

/**
 * `history` is for the states playground and tests only: a page that stubs nothing cannot fetch, so a
 * card hands the answer in and the live read is switched off. The router never passes it.
 */
export function MachineRoute({ history }: { history?: MachineHistoryState }) {
  const { id = "" } = useParams();
  // Keyed by id so a machine never inherits the previous machine's history or range.
  return <MachineDetail key={id} id={id} given={history} />;
}

const CHART_TITLE = {
  cpu: "machines.metric.cpu",
  mem: "machines.metric.mem",
  disk: "machines.metric.disk",
  net: "machines.metric.net",
} as const satisfies Record<MachineChartKind, string>;

const CHARTS: readonly MachineChartKind[] = ["cpu", "mem", "disk", "net"];

function MachineDetail({ id, given }: { id: string; given: MachineHistoryState | undefined }) {
  const nav = useNav();
  const scope = useScope();
  const revalidator = useRevalidator();
  const tab = machineTabOf(useLocation().search);
  useLocale();
  // SAFETY: `machinesLoader` returns `MachinesData` for this route; `undefined` is the harness case.
  const data = (useLoaderData() as MachinesData | undefined) ?? EMPTY_MACHINES;
  const census = data.census;
  const row = census?.machines.find((m) => m.id === id);
  // An older machine never sent a reading, so the lead holds no minute of it: no charts, and no read
  // that could only come back empty. Its card says to update it, once.
  const older = row !== undefined && census !== null && machineReading(row, census.ts) === "older";
  const live = useMachineHistory(id, row !== undefined && !older && given === undefined && tab === "status");
  const { history, failed } = given ?? live;
  const [range, setRange] = useState<MachineRange>("hour");
  const switchTab = (next: MachineTab) => nav.side(machinePath(id, scope, next));

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px, the tap floor every control in this row shares.
              className="size-11"
              onClick={() => nav.up(machinesPath(scope))}
              aria-label={t("machines.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">
              {row === undefined ? t("machines.title") : row.name || row.id}
            </h1>
          </>
        }
      />

      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {census === null ? (
          <MachinesEmptyCard reason={data.error ? "error" : "unavailable"} />
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
              onChange={switchTab}
            />
            {tab === "status" ? (
              <>
                <NowCard
                  row={row}
                  ts={census.ts}
                  multi={census.machines.length > 1}
                  onOpenAlerts={() => switchTab("alerts")}
                />
                {!older && (
                  <>
                    <Segmented
                      label={t("machines.range.label")}
                      options={[
                        { value: "hour", label: t("machines.range.hour") },
                        { value: "day", label: t("machines.range.day") },
                      ]}
                      value={range}
                      onChange={setRange}
                    />
                    {CHARTS.map((kind) => (
                      <Card key={kind} className="gap-0 py-0">
                        <h2 className="px-4 pt-3 pb-1 text-sm font-medium">{t(CHART_TITLE[kind])}</h2>
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
                // An older member answers but reports no load, so no rule on it could ever fire. A
                // machine that is down has no reading either, and that is not a reason to say update.
                needsUpdate={row.sample === undefined && (row.health === "reachable" || row.health === "incompatible")}
                hasDisks={row.sample?.disks !== undefined}
                onSaved={() => void revalidator.revalidate()}
                onOpenAlerts={() => nav.down(settingsSectionPath("alerts", scope))}
              />
            )}
          </>
        )}
      </BandMain>
    </div>
  );
}

const EMPTY_MACHINES: MachinesData = { census: null, error: false };

/**
 * The numbers now, large, under one line that says the machine's health and the age of its reading.
 * The age is there on a live machine too: numbers with no age are a claim about now. A reachable
 * machine whose reading stopped moving (lib/machine-reading.ts, "stale") keeps its numbers, quieted,
 * and its age turns the waiting colour with a clock beside it, so the state is said in words and
 * marked, not tinted alone.
 */
function NowCard({ row, ts, multi, onOpenAlerts }: { row: MachineRow; ts: number; multi: boolean; onOpenAlerts: () => void }) {
  const reading = machineReading(row, ts);
  const stale = reading === "stale";
  return (
    <Card className="gap-0 py-0">
      <div className="space-y-4 p-4">
        <div className="flex min-h-5 items-center justify-between gap-3 text-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className={healthTone(row)}>{healthWord(row)}</span>
            {multi && row.isLead && <LeadBadge />}
          </div>
          {(reading === "live" || stale) && (
            <span
              className={cn(
                "flex shrink-0 items-center gap-1 text-xs tabular-nums",
                stale ? "font-medium text-status-working" : "text-muted-foreground",
              )}
            >
              {stale && <Clock className="size-3.5" aria-hidden />}
              {readingLine(row, ts)}
            </span>
          )}
        </div>
        <div className={cn(stale && "opacity-60")}>
          <MachineLoad row={row} ts={ts} size="large" onOpenAlerts={onOpenAlerts} />
        </div>
      </div>
    </Card>
  );
}

/** One chart card's body: the chart, or a same-height box saying why there is none yet. */
function ChartBody({
  kind,
  history,
  failed,
  range,
  alerts,
}: {
  kind: MachineChartKind;
  history: MachineHistoryResponse | null;
  failed: boolean;
  range: MachineRange;
  alerts: MachineAlerts;
}) {
  if (history === null) {
    return <ChartPlaceholder>{failed ? t("machines.history.error") : t("machines.history.loading")}</ChartPlaceholder>;
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
}
