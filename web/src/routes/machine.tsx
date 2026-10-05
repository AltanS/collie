import { useState } from "react";
import { ArrowLeft, Crown } from "lucide-react";
import { useLoaderData, useParams, useRevalidator } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { healthTone, healthWord } from "@/components/crew-formation";
import { MachineAlertsControl } from "@/components/machine-alerts-control";
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
import { machinesPath, settingsSectionPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { MachineAlerts, MachineHistoryResponse, MachineRow } from "@/lib/types";

// One machine: its numbers large, then CPU, memory and network over the last hour or day, then its
// alert rules.
//
// ── TWO CLOCKS, TWO READS ────────────────────────────────────────────────────
// The row (numbers, health, rules, firing) comes from the SAME loader the list uses, so it rides the
// poll loop and an alert firing shows within a tick. The history does not: it is up to 1440 points that
// change once a minute, so `useMachineHistory` reads it on open and then once a minute while visible.
// The 1 h and 24 h views are one answer sliced client-side; switching is instant and asks for nothing.
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

const CHARTS: readonly { kind: MachineChartKind; title: "machines.metric.cpu" | "machines.metric.mem" | "machines.metric.net" }[] = [
  { kind: "cpu", title: "machines.metric.cpu" },
  { kind: "mem", title: "machines.metric.mem" },
  { kind: "net", title: "machines.metric.net" },
];

function MachineDetail({ id, given }: { id: string; given: MachineHistoryState | undefined }) {
  const nav = useNav();
  const scope = useScope();
  const revalidator = useRevalidator();
  useLocale();
  // SAFETY: `machinesLoader` returns `MachinesData` for this route; `undefined` is the harness case.
  const data = (useLoaderData() as MachinesData | undefined) ?? EMPTY_MACHINES;
  const census = data.census;
  const row = census?.machines.find((m) => m.id === id);
  const live = useMachineHistory(id, row !== undefined && given === undefined);
  const { history, failed } = given ?? live;
  const [range, setRange] = useState<MachineRange>("hour");

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

      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {census === null ? (
          <MachinesEmptyCard reason={data.error ? "error" : "unavailable"} />
        ) : row === undefined ? (
          <MachinesEmptyCard reason="unknown" />
        ) : (
          <>
            <NowCard row={row} ts={census.ts} multi={census.machines.length > 1} />
            <Segmented
              label={t("machines.range.label")}
              options={[
                { value: "hour", label: t("machines.range.hour") },
                { value: "day", label: t("machines.range.day") },
              ]}
              value={range}
              onChange={setRange}
            />
            {CHARTS.map((chart) => (
              <Card key={chart.kind} className="gap-0 py-0">
                <h2 className="px-4 pt-3 pb-1 text-sm font-medium">{t(chart.title)}</h2>
                <ChartBody
                  kind={chart.kind}
                  history={history}
                  failed={failed}
                  range={range}
                  alerts={row.alerts}
                />
              </Card>
            ))}
            <MachineAlertsControl
              machineId={row.id}
              alerts={row.alerts}
              firing={row.firing}
              onSaved={() => void revalidator.revalidate()}
              onOpenAlerts={() => nav.down(settingsSectionPath("alerts", scope))}
            />
          </>
        )}
      </main>
    </div>
  );
}

const EMPTY_MACHINES: MachinesData = { census: null, error: false };

/** The same numbers the list card shows, large, with the machine's health and the age of its reading. */
function NowCard({ row, ts, multi }: { row: MachineRow; ts: number; multi: boolean }) {
  return (
    <Card className="gap-0 py-0">
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className={healthTone(row)}>{healthWord(row)}</span>
          {multi && row.isLead && (
            <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
              <Crown className="size-2.5" aria-hidden />
              {t("connection.host.lead")}
            </span>
          )}
        </div>
        <MachineLoad row={row} ts={ts} size="large" />
        {/* The age of the reading, on a reachable machine too: numbers with no age are a claim about now. */}
        {row.sample !== undefined && row.health === "reachable" && (
          <p className="text-xs text-muted-foreground">{readingLine(row, ts)}</p>
        )}
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
  const rule = kind === "cpu" ? alerts.cpu : kind === "mem" ? alerts.mem : undefined;
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
