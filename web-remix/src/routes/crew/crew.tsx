// The crew census (web/src/routes/crew.tsx): the whole crew drawn as a FORMATION, and the answer to
// "how is my crew doing?". Tapping a machine opens its paperwork in a sheet. It is a report, not a
// console: no button changes anything, and the one move the page offers (to a machine) is a deliberate
// second tap inside the sheet.
//
// The census rides the polling beat while the page is open (`want`), so a member going quiet appears
// without a reload. TIER-2 health is derived from the SNAPSHOT's roster against the lead's clock, the
// same map the machine switcher reads, so the two surfaces cannot disagree about a member. The open
// sheet holds the member ID, not the member: the census revalidates underneath it on every beat.
import type { Handle } from "remix/component";
import { Network } from "lucide";

import { hostHealthMap } from "@web/lib/host-health";
import { hostCounts } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import { homePath, machinePath, settingsSectionPath } from "@web/lib/nav";
import type { AgentView } from "@web/lib/types";

import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { IDLE_MS, want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";
import { BottomSheet } from "../../ui/sheet";
import { Frame } from "../frame/frame";
import { goDown, goSide } from "../frame/up";
import { CREW_SOURCE, crew } from "./data";
import { CrewFormation } from "./formation-view";
import { MemberSheet } from "./member-sheet";

const NO_AGENTS: AgentView[] = [];

/** The one card the page shows when there is no census to show. Never a spinner, never blank. */
function EmptyCard(handle: Handle<{ error: boolean }>) {
  useLocale(handle);
  return () => {
    const { error } = handle.props;
    return (
      <Card class="gap-0 py-0" data-testid="crew-empty">
        <div class="flex items-start gap-3 p-4">
          <Icon icon={Network} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{error ? t("crew.error.title") : t("crew.solo.title")}</div>
            <p class="text-sm text-muted-foreground">{error ? t("crew.error.description") : t("crew.solo.description")}</p>
          </div>
        </div>
      </Card>
    );
  };
}

/** A formation's worth of height, pulsing, while the first answer is on its way. */
function FormationSkeleton() {
  return () => (
    <div class="flex flex-col items-center gap-3" data-testid="crew-skeleton" aria-hidden="true">
      <div class="h-56 w-full animate-pulse rounded-md bg-muted motion-reduce:animate-none" />
      <div class="h-4 w-40 animate-pulse rounded-sm bg-muted motion-reduce:animate-none" />
    </div>
  );
}

export function CrewRoute(handle: Handle) {
  want(CREW_SOURCE, handle.signal);
  const readCrew = useStore(handle, crew);
  const readSnapshot = useStore(handle, snapshot);
  const where = useStore(handle, address);
  useLocale(handle);
  let openId: string | null = null;
  const close = (): void => {
    openId = null;
    void handle.update();
  };

  return () => {
    const { status, error, loaded } = readCrew();
    const scope = where().scope;
    const snap = readSnapshot().data;
    const selected = status?.members.find((m) => m.id === openId) ?? null;
    const health = hostHealthMap(snap?.servers ?? [], { at: snap?.ts ?? 0, pollMs: IDLE_MS });
    const counts = hostCounts(snap?.agents ?? NO_AGENTS);
    return (
      <Frame title={t("crew.title")} backLabel={t("crew.nav.back")} up={settingsSectionPath("system", scope)}>
        {/* Three outcomes, three shapes, and never a spinner: a 404 (solo, or a peer) and a failed
            fetch are DIFFERENT sentences, so they never share a card. */}
        {!loaded ? (
          <FormationSkeleton />
        ) : status === null ? (
          <EmptyCard error={error} />
        ) : (
          <CrewFormation
            status={status}
            health={health}
            counts={counts}
            servers={snap?.servers}
            onSelect={(m) => {
              openId = m.id;
              void handle.update();
            }}
          />
        )}
        <BottomSheet open={selected !== null} onClose={close} title={selected === null ? undefined : selected.name || selected.id}>
          {selected === null || status === null ? null : (
            <MemberSheet
              member={selected}
              status={status}
              onLoad={() => {
                close();
                // Down onto the machine's own page: a level below Crew, so Back returns here.
                goDown(machinePath(selected.id, scope));
              }}
              onGo={() => {
                close();
                // A host switch goes HOME on that machine and NEVER carries a pane or session id across.
                // Sideways: a replace, so Back does not return to the census the operator just left.
                goSide(homePath({ host: selected.isLead ? undefined : selected.id, session: undefined }));
              }}
            />
          )}
        </BottomSheet>
      </Frame>
    );
  };
}
