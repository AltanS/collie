import { ArrowLeft, ChevronRight, Crown, Server } from "lucide-react";
import { useLoaderData } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { healthTone, healthWord } from "@/components/crew-formation";
import { MachineLoad } from "@/components/machine-load";
import { MachinesEmptyCard } from "@/components/machines-empty-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import type { MachinesData } from "@/lib/loaders";
import { machinePath, settingsPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { MachineRow } from "@/lib/types";

// The machines list: every machine in the crew (or the one machine a solo collie is), its CPU, memory
// and network now. One card per machine, the lead first, each a tap into that machine's page.
//
// ── IT IS A REPORT, AND ON THE POLL LOOP ─────────────────────────────────────
// The loader (`machinesLoader`) is revalidated on every poll tick like the Crew page's, so a value
// moving or an alert firing shows without a reload. Every age here is measured against the answer's
// `ts`, never `Date.now()`: the lead stamped it, and a phone a few minutes off would otherwise report
// a live machine as stale (lib/host-health.ts has the full argument).
//
// ── THE SETTINGS ROW IS ALWAYS THERE ─────────────────────────────────────────
// Unlike the Crew page, this one is not host chrome gated on `multi`: a solo collie has one machine
// and a load worth watching, so the Settings index offers the row to everyone.

export function MachinesRoute() {
  const nav = useNav();
  const scope = useScope();
  useLocale();
  // SAFETY: `machinesLoader` returns `MachinesData` for this route; `undefined` is what React Router
  // hands back for a harness that mounts the route without its loader, which the `??` covers. A
  // data-mode `useLoaderData()` is typed `unknown` and cannot be narrowed any other way.
  const data = (useLoaderData() as MachinesData | undefined) ?? EMPTY_MACHINES;
  const census = data.census;
  // The wire already puts the lead first; this keeps it so if a bridge ever stops doing that.
  const machines = census === null ? [] : census.machines.toSorted((a, b) => Number(b.isLead) - Number(a.isLead));

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* The shell's own header, filled with a back button and the title, as on Crew and the Settings
          sections. Back goes up to Settings, never home (ADR 0067). */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => nav.up(settingsPath(scope))}
              aria-label={t("machines.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("machines.title")}</h1>
          </>
        }
      />

      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {census === null ? (
          <MachinesEmptyCard reason={data.error ? "error" : "unavailable"} />
        ) : (
          machines.map((row) => (
            <MachineCard
              key={row.id}
              row={row}
              ts={census.ts}
              showRole={machines.length > 1}
              onOpen={() => nav.down(machinePath(row.id, scope))}
            />
          ))
        )}
      </main>
    </div>
  );
}

const EMPTY_MACHINES: MachinesData = { census: null, error: false };

/**
 * One machine. The name is the card's button and its hit area is stretched over the whole card
 * (`after:absolute after:inset-0`), so the meters stay real elements a screen reader can read while a
 * tap anywhere on the card opens the machine. Nesting the meters inside a `<button>` would flatten
 * them to presentation.
 */
function MachineCard({
  row,
  ts,
  showRole,
  onOpen,
}: {
  row: MachineRow;
  ts: number;
  showRole: boolean;
  onOpen: () => void;
}) {
  return (
    <Card className="relative gap-0 py-0">
      <div className="space-y-3 p-4">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={onOpen}
            className="flex min-h-11 min-w-0 items-center gap-2 text-left after:absolute after:inset-0 after:content-['']"
          >
            <Server className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate font-medium">{row.name || row.id}</span>
          </button>
          <div className="flex shrink-0 items-center gap-2 text-sm">
            {showRole && row.isLead && (
              // `rounded-md` (2px): an icon plus an uppercase word is a stadium, not a circle.
              <span className="flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                <Crown className="size-2.5" aria-hidden />
                {t("connection.host.lead")}
              </span>
            )}
            <span className={healthTone(row)}>{healthWord(row)}</span>
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
          </div>
        </div>
        <MachineLoad row={row} ts={ts} size="card" />
      </div>
    </Card>
  );
}
