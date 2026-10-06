// The machines list (web/src/routes/machines.tsx): every machine in the crew (or the one machine a solo
// collie is), its CPU, memory and network now. One card per machine, the lead first, each a tap into
// that machine's page. It is a report, on the polling beat while open: a value moving or an alert firing
// shows without a reload, and an unchanged row keeps its identity across reads (`data.ts`). Every age is
// measured against the answer's `ts`, never `Date.now()`.
//
// Back goes UP to Settings (ADR 0067), never home. Opening a machine is DOWN, a push.
import type { Handle } from "remix/component";

import { t } from "@web/lib/i18n";
import { machinePath, settingsPath } from "@web/lib/nav";
import type { MachineRow } from "@web/lib/types";

import { address } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Frame } from "../frame/frame";
import { goDown } from "../frame/up";
import { MachineCard } from "./card";
import { MACHINES_SOURCE, MACHINE_SPARK_MINUTES, leadFirst, machines } from "./data";
import { MachinesEmptyCard } from "./empty-card";

/** One card's worth of height, pulsing, while the first answer is on its way. */
function CardSkeleton() {
  return () => <div class="h-40 animate-pulse rounded-xl bg-muted motion-reduce:animate-none" data-testid="machine-skeleton" aria-hidden="true" />;
}

export function MachinesRoute(handle: Handle) {
  want(MACHINES_SOURCE, handle.signal);
  const read = useStore(handle, machines);
  const where = useStore(handle, address);
  useLocale(handle);
  // Made once: a card reads the scope at tap time, so the callbacks never churn.
  const open = (row: MachineRow): void => goDown(machinePath(row.id, where().scope));
  const openAlerts = (row: MachineRow): void => goDown(machinePath(row.id, where().scope, "alerts"));

  return () => {
    const { census, error, loaded } = read();
    const rows = census === null ? [] : leadFirst(census.machines);
    return (
      <Frame title={t("machines.title")} backLabel={t("machines.nav.back")} up={settingsPath(where().scope)} class="gap-3 p-4">
        {!loaded ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : census === null ? (
          <MachinesEmptyCard reason={error ? "error" : "unavailable"} />
        ) : (
          rows.map((row) => (
            <MachineCard
              key={row.id}
              row={row}
              ts={census.ts}
              showRole={rows.length > 1}
              sparkMinutes={MACHINE_SPARK_MINUTES}
              onOpen={open}
              onOpenAlerts={openAlerts}
            />
          ))
        )}
      </Frame>
    );
  };
}
