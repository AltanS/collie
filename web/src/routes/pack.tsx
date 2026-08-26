import type { ReactNode } from "react";
import { ArrowLeft, Crown, Network, Server } from "lucide-react";
import { useLoaderData, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { usePack } from "@/components/pack-provider";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { hostHealth, type HostHealth } from "@/lib/host-health";
import { countsFor, hostCounts, type HostCounts } from "@/lib/hosts";
import { t, tn } from "@/lib/i18n";
import { type PackData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type {
  AgentView,
  PackMemberStatus,
  PackStatusResponse,
  ServerSummary,
} from "@/lib/types";

// The pack census: one row per machine, and the answer to "how is my whole pack doing?".
//
// ── IT IS A REPORT, NOT A CONSOLE ────────────────────────────────────────────
// There is no button here that changes anything, and that is the milestone's rule rather than an
// unfinished edge: join / leave / promote / rotate are CLI verbs (M5 non-goal), so the page names
// what is wrong and stops. It is the ServerSwitcher's posture at page scale — the switcher lists
// members and lets you go to one; this lists the same members with the detail a switcher row has no
// room for (secret generation, warrant, enrolment, version skew) and lets you go to one.
//
// ── WHY IT HAS ITS OWN LOADER RATHER THAN RIDING THE SNAPSHOT ────────────────
// `/api/pack` is a page's worth of detail, and the snapshot is the hot path every phone polls for
// every screen. Its own loader keeps that cost on this page — and, because the loader is a route
// loader, `revalidate()` refreshes it on the ordinary poll while the page is open, which is exactly
// what a status page wants: a member going quiet appears here without a reload.
//
// ── EVERY TIME ON THIS PAGE IS AGED AGAINST THE LEAD'S CLOCK ─────────────────
// `status.ts`, never `Date.now()`. Every timestamp in the payload was stamped by the LEAD, so a
// phone a few minutes fast would otherwise report the entire pack as stale, and one a few minutes
// slow would report a dead machine as current. lib/host-health.ts's header has the full argument;
// this page obeys it for `rotatedAt` and `enrolledAt` as well as for `lastSeenAt`.
export function PackRoute() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const root = useOptionalRootData();
  // TIER-2 health, derived once at the data root against the lead's clock — the same map the
  // ServerSwitcher's rows read, so the two surfaces cannot disagree about a member. See
  // `memberHealth` for what happens when this page is mounted without a provider.
  const { health } = usePack();
  // SAFETY: `packLoader` returns `PackData` for this route; `undefined` is what React Router hands
  // back for a harness that mounts the route without its loader, which the `??` below covers. A
  // data-mode `useLoaderData()` is typed `unknown` and cannot be narrowed any other way.
  const data = (useLoaderData() as PackData | undefined) ?? EMPTY_PACK;
  // Read into a const so the null check below narrows inside the `.map` callback too — a property
  // access re-widens at every closure boundary.
  const status = data.status;
  const counts = hostCounts(root?.agents ?? NO_AGENTS);

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          // 44px, matching Settings' header — size="icon" alone is 36px, below the tap target.
          className="size-11"
          onClick={() => navigate(homePath(scope))}
          aria-label={t("pack.nav.back")}
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">{t("pack.title")}</h1>
      </header>

      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {/* Three outcomes, three shapes, and never a spinner: this loader always resolves before the
            route's element mounts, so "still loading" is not a state this page can be in. A 404 (a
            solo collie, or a peer) and a failed fetch are DIFFERENT sentences — the first says there
            is nothing to report, the second says we could not ask — so they never share a card. */}
        {status === null ? (
          <EmptyCard error={data.error} />
        ) : (
          <>
            <SummaryCard status={status} />
            {status.members.map((m) => (
              <MemberCard
                key={m.id}
                member={m}
                status={status}
                health={memberHealth(health, m)}
                counts={countsFor(counts, m.id)}
                onOpen={() =>
                  // The ServerSwitcher's rule, restated because it is the one this milestone exists
                  // to enforce: a host switch goes HOME on that machine and NEVER carries a pane or
                  // session id across. `w1:p1` on the peer is a different terminal entirely.
                  navigate(homePath({ host: m.isLead ? undefined : m.id, session: undefined }))
                }
              />
            ))}
          </>
        )}
      </main>
    </div>
  );
}

// Module-level constants, not literals in the render: a fresh array/object per render is a new
// reference, which churns every memo downstream for nothing (same reason ServerSwitcher's NO_PANES
// sits at module scope).
const EMPTY_PACK: PackData = { status: null, error: false };
const NO_AGENTS: AgentView[] = [];

/**
 * The tier-2 health for a member row.
 *
 * The snapshot-derived map is the answer wherever there is one, so this page and the switcher can
 * never disagree. The fallback is for a mount with no `PackProvider` — this route's own unit tests,
 * and a first paint where the snapshot has not landed — and it is derived from THIS payload rather
 * than invented: `hostHealth` with `at: 0` skips the §10.2 tolerance and presents the lead's plain
 * boolean, which is precisely what ServerSwitcher's identical fallback does.
 */
function memberHealth(map: ReadonlyMap<string, HostHealth>, m: PackMemberStatus): HostHealth {
  return map.get(m.id) ?? hostHealth(asServerSummary(m), { at: 0, pollMs: 0 });
}

/** The census row read as a roster entry — the two shapes overlap exactly where health lives. */
function asServerSummary(m: PackMemberStatus): ServerSummary {
  return {
    id: m.id,
    name: m.name,
    isLead: m.isLead,
    // Only `reachable` is a green light. `conflicted` in particular is NOT: two collies believing
    // they lead the same pack is the one state where a write could land somewhere unintended.
    reachable: m.health === "reachable",
    protocol: m.health === "incompatible" ? "incompatible" : m.lastSeenAt > 0 ? "ok" : "unknown",
    protocolDetail: m.reason,
    lastSeenAt: m.lastSeenAt,
  };
}

function SummaryCard({ status }: { status: PackStatusResponse }) {
  const reachable = status.members.filter((m) => m.health === "reachable").length;
  const lead = status.members.find((m) => m.isLead);
  const deputy =
    status.deputy === null
      ? null
      : {
          name: status.members.find((m) => m.id === status.deputy?.id)?.name ?? status.deputy.id,
          warrantGeneration: status.deputy.warrantGeneration,
        };

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4 pb-3">
        <Network className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="truncate font-medium">{status.pack.name || status.pack.id}</div>
          <p className="text-sm text-muted-foreground">
            {t("pack.summary.counts", {
              machines: tn("pack.summary.machines", status.members.length),
              reachable: t("pack.summary.reachable", { count: reachable }),
            })}
          </p>
        </div>
      </div>
      <dl className="divide-y divide-border/60 border-t border-border/60">
        <Row label={t("pack.summary.lead")}>
          {lead?.name ?? status.self.name}
          <span className="ml-1.5 text-muted-foreground">{status.self.version}</span>
        </Row>
        <Row label={t("pack.summary.deputy")}>
          {/* Named ahead of time or not named at all (ADR 0027) — and "no deputy named" is a fact
              worth printing, because it is the difference between a pack that survives the lead
              going quiet and one that does not. */}
          {deputy === null ? (
            <span className="text-muted-foreground">{t("pack.summary.noDeputy")}</span>
          ) : (
            <>
              {deputy.name}
              {deputy.warrantGeneration !== null && (
                <span className="ml-1.5 text-muted-foreground">
                  {t("pack.summary.warrant", { generation: deputy.warrantGeneration })}
                </span>
              )}
            </>
          )}
        </Row>
        <Row label={t("pack.summary.secret")}>
          {t("pack.summary.secretValue", {
            generation: status.pack.secretGeneration,
            // Aged against the LEAD's clock, like everything else here — see the header.
            time: timeAgoShort(status.pack.rotatedAt, status.ts),
          })}
        </Row>
      </dl>
    </Card>
  );
}

function MemberCard({
  member,
  status,
  health,
  counts,
  onOpen,
}: {
  member: PackMemberStatus;
  status: PackStatusResponse;
  health: HostHealth;
  counts: HostCounts;
  onOpen: () => void;
}) {
  // Compared against the LEAD's version, not against the newest one known: a pack levels to whatever
  // the lead runs (`pack update` pushes the lead's own commit — ADR 0016), so "differs from lead" is
  // the sentence that names the fix. Silent while a member has never answered and reports none.
  const versionDiffers = member.version !== undefined && member.version !== status.self.version;

  return (
    <Card className="gap-0 py-0">
      {/* The whole card is the tap target — a row that navigates should not make you hunt for a
          chevron on a phone. It is also the ONLY interactive thing on this page. */}
      <button type="button" onClick={onOpen} className="w-full p-4 text-left active:bg-muted/60">
        <div className="flex flex-wrap items-center gap-1.5">
          <Server className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-medium">{member.name || member.id}</span>
          {member.isLead && (
            <span className="flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <Crown className="size-2.5" aria-hidden />
              {t("connection.host.lead")}
            </span>
          )}
          {/* The switcher's chip, verbatim in its wording rules: the WORD "unreachable" belongs to
              `writable` — the lead's plain boolean — and never to `state`, which is a statement
              about the age of a receipt. A stale receipt beside a member answering every request is
              an old receipt, not a down machine (host-stale-banner.tsx has the table). */}
          {health.incompatible ? (
            <span className="text-[11px] font-medium text-status-blocked">
              {t("connection.host.incompatible")}
            </span>
          ) : (
            health.state !== "live" && (
              <span className="text-[11px] text-muted-foreground">
                {health.writable
                  ? health.lastSeenLabel
                  : t("connection.host.unreachableSuffix", { label: health.lastSeenLabel })}
              </span>
            )
          )}
        </div>

        {(counts.blocked > 0 || counts.working > 0) && (
          <div className="mt-1.5 flex items-center gap-1.5">
            {counts.blocked > 0 && (
              <span className="rounded-full border border-status-blocked/30 bg-status-blocked/15 px-1.5 py-0.5 text-[10px] font-medium text-status-blocked">
                {tn("status.count.needsYou", counts.blocked)}
              </span>
            )}
            {counts.working > 0 && (
              <span className="rounded-full border border-status-working/30 bg-status-working/15 px-1.5 py-0.5 text-[10px] font-medium text-status-working">
                {tn("status.count.working", counts.working)}
              </span>
            )}
          </div>
        )}
      </button>

      <dl className="divide-y divide-border/60 border-t border-border/60">
        <Row label={t("pack.member.health")}>
          {/* The lead's own word for this member, and its reason VERBATIM under it — never
              paraphrased, because the operator's next move is to read it and go fix a version, a
              route or a second lead somewhere. */}
          <span className={healthTone(member.health)}>{healthWord(member.health)}</span>
        </Row>
        {member.reason !== undefined && member.reason !== "" && (
          <Row label={t("pack.member.reason")}>
            <span className="break-words font-mono text-[11px] leading-tight">{member.reason}</span>
          </Row>
        )}
        {member.conflict !== undefined && (
          <Row label={t("pack.member.conflict")}>
            {/* The loudest state on the page: another collie also believes it leads this pack. Both
                halves are printed, because the warrant generation is how the operator decides which
                one is the stale believer. */}
            <span className="break-words font-mono text-[11px] leading-tight text-status-blocked">
              {member.conflict.warrantGeneration === null
                ? t("pack.member.conflictNoWarrant", { lead: member.conflict.leadMemberId })
                : t("pack.member.conflictValue", {
                    lead: member.conflict.leadMemberId,
                    generation: member.conflict.warrantGeneration,
                  })}
            </span>
          </Row>
        )}
        {member.version !== undefined && (
          <Row label={t("pack.member.version")}>
            {member.version}
            {versionDiffers && (
              <span className="ml-1.5 text-status-blocked">{t("pack.member.versionDiffers")}</span>
            )}
          </Row>
        )}
        {member.address !== undefined && (
          <Row label={t("pack.member.address")}>
            <span className="break-all font-mono text-[11px]">{member.address}</span>
          </Row>
        )}
        {member.enrolledAt !== undefined && (
          <Row label={t("pack.member.enrolled")}>
            {timeAgoShort(member.enrolledAt, status.ts)}
          </Row>
        )}
      </dl>

      {/* Two warnings, as sentences rather than badges: each one describes something the operator has
          to go and do, and a coloured dot would have to be decoded first. */}
      {(member.secretBehind || member.provisional) && (
        <div className="border-t border-border/60 px-4 py-2.5 text-xs text-status-blocked">
          {member.secretBehind && <p>{t("pack.member.secretBehind")}</p>}
          {member.provisional && <p>{t("pack.member.provisional")}</p>}
        </div>
      )}
    </Card>
  );
}

/** The one card the page shows when there is no census to show. Never a spinner, never blank. */
function EmptyCard({ error }: { error: boolean }) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Network className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{error ? t("pack.error.title") : t("pack.solo.title")}</div>
          <p className="text-sm text-muted-foreground">
            {error ? t("pack.error.description") : t("pack.solo.description")}
          </p>
        </div>
      </div>
    </Card>
  );
}

/** ConnectionInfo's row, in this page's own file: a definition list of short read-only facts. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function healthWord(health: PackMemberStatus["health"]): string {
  switch (health) {
    case "reachable":
      return t("pack.health.reachable");
    case "unreachable":
      return t("pack.health.unreachable");
    case "incompatible":
      return t("pack.health.incompatible");
    case "conflicted":
      return t("pack.health.conflicted");
  }
}

/** Only the two loud states are coloured — a page where everything shouts says nothing. */
function healthTone(health: PackMemberStatus["health"]): string {
  switch (health) {
    case "reachable":
      return "text-status-working";
    case "unreachable":
      return "text-muted-foreground";
    case "incompatible":
    case "conflicted":
      return "text-status-blocked";
  }
}

