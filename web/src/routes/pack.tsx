import type { ReactNode } from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Crown, Network, Shield } from "lucide-react";
import { useLoaderData, useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { BottomSheet } from "@/components/ui/sheet";
import { usePack } from "@/components/pack-provider";
import { healthTone, healthWord, PackFormation } from "@/components/pack-formation";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { hostCounts } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { type PackData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type { AgentView, PackMemberStatus, PackStatusResponse } from "@/lib/types";

// The pack census: the whole pack drawn as a FORMATION, and the answer to "how is my pack doing?".
//
// ── THE BODY IS A SHAPE, AND TAPPING A MACHINE OPENS ITS PAPERWORK ───────────
// The lead stands at the apex, the deputy directly beneath it on a thick connector, and every other
// member is fanned in a V on thin ones (components/pack-formation.tsx owns the drawing and the pure
// geometry). A node carries only what survives being glanced at — a health ring, a name, and a
// "needs you" count — and everything a list used to print instead lives one tap away in a bottom
// sheet: the lead's own word for that member and its reason verbatim, a conflict, version skew, the
// address, the enrolment, and on the lead itself the secret generation and who deputises for it.
//
// ── IT IS STILL A REPORT, NOT A CONSOLE ──────────────────────────────────────
// There is no button here that changes anything, and that is the milestone's rule rather than an
// unfinished edge: join / leave / promote / rotate are CLI verbs (M5 non-goal), so the page names
// what is wrong and stops. The one thing it does is what the ServerSwitcher does — take you to a
// machine — and it is a deliberate second tap inside the sheet, never the node itself. Tapping a
// node on a picture must be free to mean "tell me about this one".
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
  // `memberHealth` in pack-formation.tsx for a mount without a provider.
  const { health } = usePack();
  // SAFETY: `packLoader` returns `PackData` for this route; `undefined` is what React Router hands
  // back for a harness that mounts the route without its loader, which the `??` below covers. A
  // data-mode `useLoaderData()` is typed `unknown` and cannot be narrowed any other way.
  const data = (useLoaderData() as PackData | undefined) ?? EMPTY_PACK;
  // Read into a const so the null check below narrows inside the callbacks too — a property access
  // re-widens at every closure boundary.
  const status = data.status;
  const counts = hostCounts(root?.agents ?? NO_AGENTS);
  // The open sheet holds the member ID, not the member: the loader revalidates underneath an open
  // sheet on every poll, and a held object would go on rendering the census as it was when tapped.
  const [openId, setOpenId] = useState<string | null>(null);
  const selected = status?.members.find((m) => m.id === openId) ?? null;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      {/* One header treatment app-wide: the page colour, cut off the content by a full-strength
          rule. Was `bg-background/85 backdrop-blur-md`, which the dashboard header never had — three
          headers, two treatments, one app. The blur is not merely redundant, it is a hazard: a
          backdrop-filter makes the element a containing block, and session-switcher.tsx:63 already
          carries the scar comment about the app header having clipped a portalled sheet that way.
          `border-border/60` goes with it — it composites to 1.09:1 on the page, so at 85% opacity
          the header was separated by essentially nothing. */}
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-rule bg-background px-2 py-2 [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
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
          <PackFormation
            status={status}
            health={health}
            counts={counts}
            onSelect={(m) => setOpenId(m.id)}
          />
        )}
      </main>

      {/* Portalled to the body, exactly as the ServerSwitcher's sheet is: the sheet is `fixed`, and
          this route's scrolling `<main>` is a containing block that would otherwise clip it. */}
      {status !== null &&
        createPortal(
          <BottomSheet
            open={selected !== null}
            onClose={() => setOpenId(null)}
            title={selected === null ? undefined : selected.name || selected.id}
          >
            {selected !== null && (
              <MemberSheet
                member={selected}
                status={status}
                onGo={() => {
                  setOpenId(null);
                  // The ServerSwitcher's rule, restated because it is the one this milestone exists
                  // to enforce: a host switch goes HOME on that machine and NEVER carries a pane or
                  // session id across. `w1:p1` on the peer is a different terminal entirely.
                  navigate(
                    homePath({ host: selected.isLead ? undefined : selected.id, session: undefined }),
                  );
                }}
              />
            )}
          </BottomSheet>,
          document.body,
        )}
    </div>
  );
}

// Module-level constants, not literals in the render: a fresh array/object per render is a new
// reference, which churns every memo downstream for nothing (same reason ServerSwitcher's NO_PANES
// sits at module scope).
const EMPTY_PACK: PackData = { status: null, error: false };
const NO_AGENTS: AgentView[] = [];

/**
 * One machine's paperwork — everything the formation's node had no room for.
 *
 * The lead's own sheet carries two extra facts because they are PACK-wide rather than per-member and
 * the lead is the machine that owns them: which rotation of the shared secret is current, and who is
 * named to take over if this lead goes quiet (ADR 0027).
 */
function MemberSheet({
  member,
  status,
  onGo,
}: {
  member: PackMemberStatus;
  status: PackStatusResponse;
  onGo: () => void;
}) {
  // Compared against the LEAD's version, not against the newest one known: a pack levels to whatever
  // the lead runs (`pack update` pushes the lead's own commit — ADR 0016), so "differs from lead" is
  // the sentence that names the fix. Silent while a member has never answered and reports none.
  const versionDiffers = member.version !== undefined && member.version !== status.self.version;
  const isDeputy = status.deputy !== null && status.deputy.id === member.id;
  const deputyName =
    status.deputy === null
      ? null
      : status.members.find((m) => m.id === status.deputy?.id)?.name ?? status.deputy.id;

  return (
    <div className="space-y-3">
      {(member.isLead || isDeputy) && (
        // `rounded-md` (2px): an icon plus an uppercase word is a stadium, not a circle. Full-round
        // is reserved for shapes whose width equals their height.
        <span className="flex w-fit items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          {member.isLead ? (
            <Crown className="size-2.5" aria-hidden />
          ) : (
            <Shield className="size-2.5" aria-hidden />
          )}
          {member.isLead ? t("connection.host.lead") : t("pack.role.deputy")}
        </span>
      )}

      <dl className="divide-y divide-rule rounded-lg border border-border/60">
        <Row label={t("pack.member.health")}>
          {/* The lead's own word for this member, and its reason VERBATIM under it — never
              paraphrased, because the operator's next move is to read it and go fix a version, a
              route or a second lead somewhere. */}
          <span className={healthTone(member.health)}>{healthWord(member.health)}</span>
        </Row>
        {member.reason !== undefined && member.reason !== "" && (
          <Row label={t("pack.member.reason")}>
            <span className="font-mono text-[11px] leading-tight break-words">{member.reason}</span>
          </Row>
        )}
        {member.conflict !== undefined && (
          <Row label={t("pack.member.conflict")}>
            {/* The loudest state on the page: another collie also believes it leads this pack. Both
                halves are printed, because the warrant generation is how the operator decides which
                one is the stale believer. */}
            <span className="font-mono text-[11px] leading-tight break-words text-status-blocked">
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
            <span className="font-mono text-[11px] break-all">{member.address}</span>
          </Row>
        )}
        {member.enrolledAt !== undefined && (
          <Row label={t("pack.member.enrolled")}>
            {timeAgoShort(member.enrolledAt, status.ts)}
          </Row>
        )}
        {member.isLead && (
          <>
            <Row label={t("pack.summary.deputy")}>
              {/* Named ahead of time or not named at all (ADR 0027) — and "no deputy named" is a
                  fact worth printing, because it is the difference between a pack that survives the
                  lead going quiet and one that does not. */}
              {status.deputy === null || deputyName === null ? (
                <span className="text-muted-foreground">{t("pack.summary.noDeputy")}</span>
              ) : (
                <>
                  {deputyName}
                  {status.deputy.warrantGeneration !== null && (
                    <span className="ml-1.5 text-muted-foreground">
                      {t("pack.summary.warrant", { generation: status.deputy.warrantGeneration })}
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
          </>
        )}
      </dl>

      {/* Two warnings, as sentences rather than badges: each one describes something the operator has
          to go and do, and a coloured dot would have to be decoded first. */}
      {(member.secretBehind || member.provisional) && (
        <div className="text-xs text-status-blocked">
          {member.secretBehind && <p>{t("pack.member.secretBehind")}</p>}
          {member.provisional && <p>{t("pack.member.provisional")}</p>}
        </div>
      )}

      <Button className="w-full" onClick={onGo}>
        {t("pack.sheet.goTo")}
      </Button>
    </div>
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
    <div className="flex items-baseline justify-between gap-4 px-3 py-2.5 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}
