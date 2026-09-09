import type { ReactNode } from "react";
import { useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Crown, Network, Shield } from "lucide-react";
import { useLoaderData, useNavigate } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ListGroup } from "@/components/ui/list-group";
import { BottomSheet } from "@/components/ui/sheet";
import { useCrew } from "@/components/crew-provider";
import { healthTone, healthWord, CrewFormation } from "@/components/crew-formation";
import { useLocale } from "@/hooks/use-locale";
import { timeAgoShort } from "@/lib/format";
import { hostCounts } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { type CrewData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import type { AgentView, CrewMemberStatus, CrewStatusResponse } from "@/lib/types";
import { cn } from "@/lib/utils";

// The crew census: the whole crew drawn as a FORMATION, and the answer to "how is my crew doing?".
//
// ── THE BODY IS A SHAPE, AND TAPPING A MACHINE OPENS ITS PAPERWORK ───────────
// The lead stands at the apex, the deputy directly beneath it on a thick connector, and every other
// member is fanned in a V on thin ones (components/crew-formation.tsx owns the drawing and the pure
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
// `/api/crew` is a page's worth of detail, and the snapshot is the hot path every phone polls for
// every screen. Its own loader keeps that cost on this page — and, because the loader is a route
// loader, `revalidate()` refreshes it on the ordinary poll while the page is open, which is exactly
// what a status page wants: a member going quiet appears here without a reload.
//
// ── EVERY TIME ON THIS PAGE IS AGED AGAINST THE LEAD'S CLOCK ─────────────────
// `status.ts`, never `Date.now()`. Every timestamp in the payload was stamped by the LEAD, so a
// phone a few minutes fast would otherwise report the entire crew as stale, and one a few minutes
// slow would report a dead machine as current. lib/host-health.ts's header has the full argument;
// this page obeys it for `rotatedAt` and `enrolledAt` as well as for `lastSeenAt`.
export function CrewRoute() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const root = useOptionalRootData();
  // TIER-2 health, derived once at the data root against the lead's clock — the same map the
  // ServerSwitcher's rows read, so the two surfaces cannot disagree about a member. See
  // `memberHealth` in crew-formation.tsx for a mount without a provider.
  const { health, servers } = useCrew();
  // SAFETY: `crewLoader` returns `CrewData` for this route; `undefined` is what React Router hands
  // back for a harness that mounts the route without its loader, which the `??` below covers. A
  // data-mode `useLoaderData()` is typed `unknown` and cannot be narrowed any other way.
  const data = (useLoaderData() as CrewData | undefined) ?? EMPTY_CREW;
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
      {/* One header treatment app-wide — and now that is a FACT, not a claim: this route does not
          mount a header at all, it fills the one that is already there (RootLayout's
          <AppHeaderHost/>). It used to be a hand-rolled `<header>` that only
          copied the shell's colours, and it drifted the two ways a copy always does. It carried no
          <AlphaBar/>, so walking into the Crew page off a prerelease build silently dropped the "you are
          on a beta" strip; and its padding recipe was its own, so it could not track the shell's.
          The row's CONTENT is this route's own — a back button where the mark stands, and the page
          title — which is exactly what `override` is for (the pane's find bar is the other user).
          The back button is `size-11` sitting at the row's `pl-4`, so its icon centre lands on the
          same 38px as the Collie mark it stands in for: nothing shifts sideways either. */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => navigate(homePath(scope))}
              aria-label={t("crew.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("crew.title")}</h1>
          </>
        }
      />

      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {/* Three outcomes, three shapes, and never a spinner: this loader always resolves before the
            route's element mounts, so "still loading" is not a state this page can be in. A 404 (a
            solo collie, or a peer) and a failed fetch are DIFFERENT sentences — the first says there
            is nothing to report, the second says we could not ask — so they never share a card. */}
        {status === null ? (
          <EmptyCard error={data.error} />
        ) : (
          <CrewFormation
            status={status}
            health={health}
            counts={counts}
            servers={servers}
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
const EMPTY_CREW: CrewData = { status: null, error: false };
const NO_AGENTS: AgentView[] = [];

/**
 * One machine's paperwork — everything the formation's node had no room for.
 *
 * The lead's own sheet carries two extra facts because they are CREW-wide rather than per-member and
 * the lead is the machine that owns them: which rotation of the shared secret is current, and who is
 * named to take over if this lead goes quiet (ADR 0027).
 */
function MemberSheet({
  member,
  status,
  onGo,
}: {
  member: CrewMemberStatus;
  status: CrewStatusResponse;
  onGo: () => void;
}) {
  // Compared against the LEAD's version, not against the newest one known: a crew levels to whatever
  // the lead runs (`crew update` pushes the lead's own commit — ADR 0016), so "differs from lead" is
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
          {member.isLead ? t("connection.host.lead") : t("crew.role.deputy")}
        </span>
      )}

      <ListGroup as="dl">
        <Row label={t("crew.member.health")}>
          {/* The lead's own word for this member, and its reason VERBATIM under it — never
              paraphrased, because the operator's next move is to read it and go fix a version, a
              route or a second lead somewhere. */}
          <span className={healthTone(member)}>{healthWord(member)}</span>
        </Row>
        {member.reason !== undefined && member.reason !== "" && (
          <Row label={t("crew.member.reason")}>
            <span className="font-mono text-[11px] leading-tight break-words">{member.reason}</span>
          </Row>
        )}
        {member.conflict !== undefined && (
          <Row label={t("crew.member.conflict")}>
            {/* The loudest state on the page: another collie also believes it leads this crew. Both
                halves are printed, because the warrant generation is how the operator decides which
                one is the stale believer. */}
            <span className="font-mono text-[11px] leading-tight break-words text-status-blocked">
              {member.conflict.warrantGeneration === null
                ? t("crew.member.conflictNoWarrant", { lead: member.conflict.leadMemberId })
                : t("crew.member.conflictValue", {
                    lead: member.conflict.leadMemberId,
                    generation: member.conflict.warrantGeneration,
                  })}
            </span>
          </Row>
        )}
        {member.version !== undefined && (
          <Row label={t("crew.member.version")}>
            {member.version}
            {versionDiffers && (
              <span className="ml-1.5 text-status-blocked">{t("crew.member.versionDiffers")}</span>
            )}
          </Row>
        )}
        {member.address !== undefined && (
          <Row label={t("crew.member.address")}>
            <span className="font-mono text-[11px] break-all">{member.address}</span>
          </Row>
        )}
        {member.enrolledAt !== undefined && (
          <Row label={t("crew.member.enrolled")}>
            {timeAgoShort(member.enrolledAt, status.ts)}
          </Row>
        )}
        {member.isLead && (
          <>
            <Row label={t("crew.summary.deputy")}>
              {/* Named ahead of time or not named at all (ADR 0027) — and "no deputy named" is a
                  fact worth printing, because it is the difference between a crew that survives the
                  lead going quiet and one that does not. */}
              {status.deputy === null || deputyName === null ? (
                <span className="text-muted-foreground">{t("crew.summary.noDeputy")}</span>
              ) : (
                <>
                  {deputyName}
                  {status.deputy.warrantGeneration !== null && (
                    <span className="ml-1.5 text-muted-foreground">
                      {t("crew.summary.warrant", { generation: status.deputy.warrantGeneration })}
                    </span>
                  )}
                </>
              )}
            </Row>
            <Row label={t("crew.summary.secret")}>
              {t("crew.summary.secretValue", {
                generation: status.crew.secretGeneration,
                // Aged against the LEAD's clock, like everything else here — see the header.
                time: timeAgoShort(status.crew.rotatedAt, status.ts),
              })}
            </Row>
          </>
        )}
      </ListGroup>

      {/* What the operator is being asked to do about this link, in one sentence, and it is the half of
          §10.2's split that a word alone cannot carry: "reconnecting" without "nothing to do" still
          reads as a summons. The sentence is present exactly when the lead offered the distinction, so
          an older lead's rows say nothing extra rather than something invented. */}
      {member.linkState !== undefined && (
        <p
          className={cn(
            "text-xs",
            member.linkState === "attention" ? "text-status-blocked" : "text-muted-foreground",
          )}
        >
          {member.linkState === "attention"
            ? t("connection.host.attentionAction")
            : t("connection.host.reconnectingAction")}
        </p>
      )}

      {/* Two warnings, as sentences rather than badges: each one describes something the operator has
          to go and do, and a coloured dot would have to be decoded first. */}
      {(member.secretBehind || member.provisional) && (
        <div className="text-xs text-status-blocked">
          {member.secretBehind && <p>{t("crew.member.secretBehind")}</p>}
          {member.provisional && <p>{t("crew.member.provisional")}</p>}
        </div>
      )}

      <Button className="w-full" onClick={onGo}>
        {t("crew.sheet.goTo")}
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
          <div className="font-medium">{error ? t("crew.error.title") : t("crew.solo.title")}</div>
          <p className="text-sm text-muted-foreground">
            {error ? t("crew.error.description") : t("crew.solo.description")}
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
