import { useCallback, type JSX } from "react";

import { MachineCard } from "@/components/machine-card";
import { MachinesEmptyCard } from "@/components/machines-empty-card";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { useMachineCensus, type MachineCensusState } from "@/hooks/use-machine-census";
import { useNav } from "@/hooks/use-nav";
import { t } from "@/lib/i18n";
import { MACHINE_SPARK_MINUTES } from "@/lib/loaders";
import { machinePath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { MachineRow } from "@/lib/types";

// The dashboard's Crew tab body (ADR 0085): one card per machine, the lead first, each with its CPU
// and memory now and their last half hour as sparks. The same card as the Machines list
// (components/machine-card.tsx), so the two never disagree about a machine.
//
// ── IT RUNS ONLY WHILE IT IS ON SCREEN ───────────────────────────────────────
// The tab bar mounts this only while Crew is selected, and `useMachineCensus` reads only while the
// page is visible: on open, then every 15 s, one round at a time. Any other tab, and a phone in a
// pocket, fetch nothing for it (ADR 0066 point 4, the Changes tab's rule).
//
// ── A TAP GOES DOWN, AND BACK COMES HOME ─────────────────────────────────────
// A card opens `/machines/<id>` as a step down. Its back arrow steps back onto the dashboard, because
// `/` is a legitimate parent of a machine (lib/nav.ts `ancestorsOf`), and the dashboard opens on the
// tab it stored, Crew (ADR 0067). A cold link to a machine still goes up to the Machines list.
//
// ── NO GUTTER OF ITS OWN ─────────────────────────────────────────────────────
// The dashboard's list already sits on the page's 16px gutter, so this draws only its stack.

export function CrewTab(): JSX.Element {
  return <CrewTabView state={useMachineCensus()} />;
}

/**
 * The tab's drawing for one census state. Split from the read so the states playground and the tests
 * can hand a state in; the tab itself always reads its own.
 */
export function CrewTabView({ state }: { state: MachineCensusState }): JSX.Element {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const open = useCallback((row: MachineRow) => nav.down(machinePath(row.id, scope)), [nav, scope]);

  if (state.kind === "loading") return <CrewTabSkeleton />;
  if (state.kind === "unavailable") return <MachinesEmptyCard reason="unavailable" />;
  if (state.kind === "error") return <MachinesEmptyCard reason="error" />;

  const { census } = state;
  // The wire puts the lead first; this keeps it so if a bridge ever stops doing that.
  const machines = census.machines.toSorted((a, b) => Number(b.isLead) - Number(a.isLead));
  return (
    <section aria-label={t("machines.tab.aria")} className="flex flex-col gap-3">
      {/* A refresh that failed keeps the cards it had and says so. The ages on the cards keep the
          last answer's clock, so they do not claim the numbers are fresh. */}
      <Collapse open={state.failed}>
        <Notice tone="caution" variant="box" announce="status">
          {t("machines.tab.failed")}
        </Notice>
      </Collapse>
      {machines.map((row) => (
        <MachineCard
          key={row.id}
          row={row}
          ts={census.ts}
          showRole={machines.length > 1}
          sparkMinutes={MACHINE_SPARK_MINUTES}
          onOpen={open}
        />
      ))}
    </section>
  );
}

/**
 * Two cards in the real card's own box before the first answer: the name line, the two metric
 * columns with their spark's height, and the facts line. The bars breathe like the Changes tab's
 * (`.count-skeleton`, still under reduced motion). Announced once as loading.
 */
export function CrewTabSkeleton(): JSX.Element {
  useLocale();
  return (
    <div role="status" className="flex flex-col gap-3" data-slot="crew-tab-skeleton">
      <span className="sr-only">{t("machines.tab.loading")}</span>
      {[0, 1].map((i) => (
        <Card key={i} aria-hidden className="gap-0 py-0">
          <div className="flex min-h-11 items-center justify-between gap-3 pt-2 pr-3 pl-4">
            <span className="count-skeleton h-3 w-28 rounded-full bg-muted" />
            <span className="count-skeleton h-2.5 w-16 rounded-full bg-muted" />
          </div>
          <div className="grid grid-cols-2 gap-4 px-4 pt-1 pb-4">
            {[0, 1].map((j) => (
              <div key={j} className="space-y-2">
                <div className="flex h-6 items-center justify-between">
                  <span className="count-skeleton h-2.5 w-10 rounded-full bg-muted" />
                  <span className="count-skeleton h-3.5 w-12 rounded-full bg-muted" />
                </div>
                <span className="count-skeleton block h-8 w-full rounded-sm bg-muted" />
                <span className="count-skeleton block h-2.5 w-16 rounded-full bg-muted" />
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}
