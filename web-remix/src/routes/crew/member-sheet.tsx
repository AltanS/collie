// One machine's paperwork: everything the formation's node had no room for (web/src/routes/crew.tsx,
// `MemberSheet`). The lead's own sheet carries two extra facts because they are CREW-wide and the lead
// owns them: which rotation of the shared secret is current, and who is named to take over if this lead
// goes quiet (ADR 0027). Every age is measured against the LEAD's clock (`status.ts`), never
// `Date.now()`: the lead stamped them, and a phone a few minutes off would otherwise report a live
// machine as stale. There is no button that changes the crew: join, leave, promote and rotate are CLI
// verbs. The two buttons only MOVE the operator, and each is a deliberate second tap.
import { on, type Handle, type RemixNode } from "remix/component";
import { Activity, Crown, Shield } from "lucide";

import { timeAgoShort } from "@web/lib/format";
import { t } from "@web/lib/i18n";
import type { CrewMemberStatus, CrewStatusResponse } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { useLocale } from "../../lib/i18n-store";
import { Button } from "../../ui/button";
import { Icon } from "../../ui/icon";
import { ListGroup } from "../../ui/list-group";
import { healthTone, healthWord } from "./formation";

export interface MemberSheetProps {
  member: CrewMemberStatus;
  status: CrewStatusResponse;
  onLoad: () => void;
  onGo: () => void;
}

/** A definition-list row: a short read-only fact. */
function Row(handle: Handle<{ label: string; children?: RemixNode }>) {
  return () => (
    <div class="flex items-baseline justify-between gap-4 px-3 py-2.5 text-sm">
      <dt class="shrink-0 text-muted-foreground">{handle.props.label}</dt>
      <dd class="min-w-0 text-right">{handle.props.children}</dd>
    </div>
  );
}

export function MemberSheet(handle: Handle<MemberSheetProps>) {
  useLocale(handle);
  return () => {
    const { member, status } = handle.props;
    // Compared against the LEAD's version, not the newest one known: a crew levels to whatever the lead
    // runs, so "differs from lead" is the sentence that names the fix.
    const versionDiffers = member.version !== undefined && member.version !== status.self.version;
    const isDeputy = status.deputy !== null && status.deputy.id === member.id;
    const deputyName =
      status.deputy === null ? null : (status.members.find((m) => m.id === status.deputy?.id)?.name ?? status.deputy.id);
    const conflict = member.conflict;
    return (
      <div class="space-y-3" data-testid="member-sheet">
        {member.isLead || isDeputy ? (
          // `rounded-md` (2px): an icon plus an uppercase word is a stadium, not a circle.
          <span class="flex w-fit items-center gap-1 rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            <Icon icon={member.isLead ? Crown : Shield} class="size-2.5" />
            {member.isLead ? t("connection.host.lead") : t("crew.role.deputy")}
          </span>
        ) : null}

        <ListGroup as="dl">
          <Row label={t("crew.member.health")}>
            {/* The lead's own word for this member, and its reason VERBATIM under it. */}
            <span class={healthTone(member)}>{healthWord(member)}</span>
          </Row>
          {member.reason !== undefined && member.reason !== "" ? (
            <Row label={t("crew.member.reason")}>
              <span class="font-mono text-[11px] leading-tight break-words">{member.reason}</span>
            </Row>
          ) : null}
          {conflict === undefined ? null : (
            <Row label={t("crew.member.conflict")}>
              {/* The loudest state on the page: another collie also believes it leads this crew. */}
              <span class="font-mono text-[11px] leading-tight break-words text-status-blocked">
                {conflict.warrantGeneration === null
                  ? t("crew.member.conflictNoWarrant", { lead: conflict.leadMemberId })
                  : t("crew.member.conflictValue", { lead: conflict.leadMemberId, generation: conflict.warrantGeneration })}
              </span>
            </Row>
          )}
          {member.version === undefined ? null : (
            <Row label={t("crew.member.version")}>
              {member.version}
              {versionDiffers ? <span class="ml-1.5 text-status-blocked">{t("crew.member.versionDiffers")}</span> : null}
            </Row>
          )}
          {member.address === undefined ? null : (
            <Row label={t("crew.member.address")}>
              <span class="font-mono text-[11px] break-all">{member.address}</span>
            </Row>
          )}
          {member.enrolledAt === undefined ? null : (
            <Row label={t("crew.member.enrolled")}>{timeAgoShort(member.enrolledAt, status.ts)}</Row>
          )}
          {member.isLead ? (
            <>
              <Row label={t("crew.summary.deputy")}>
                {/* Named ahead of time or not at all (ADR 0027): "no deputy named" is a fact worth printing. */}
                {status.deputy === null || deputyName === null ? (
                  <span class="text-muted-foreground">{t("crew.summary.noDeputy")}</span>
                ) : (
                  <>
                    {deputyName}
                    {status.deputy.warrantGeneration === null ? null : (
                      <span class="ml-1.5 text-muted-foreground">
                        {t("crew.summary.warrant", { generation: status.deputy.warrantGeneration })}
                      </span>
                    )}
                  </>
                )}
              </Row>
              <Row label={t("crew.summary.secret")}>
                {t("crew.summary.secretValue", {
                  generation: status.crew.secretGeneration,
                  time: timeAgoShort(status.crew.rotatedAt, status.ts),
                })}
              </Row>
            </>
          ) : null}
        </ListGroup>

        {/* What the operator is asked to do about this link, in one sentence. */}
        {member.linkState === undefined ? null : (
          <p class={cn("text-xs", member.linkState === "attention" ? "text-status-blocked" : "text-muted-foreground")}>
            {member.linkState === "attention" ? t("connection.host.attentionAction") : t("connection.host.reconnectingAction")}
          </p>
        )}

        {/* Two warnings, as sentences rather than badges. */}
        {member.secretBehind || member.provisional ? (
          <div class="text-xs text-status-blocked">
            {member.secretBehind ? <p>{t("crew.member.secretBehind")}</p> : null}
            {member.provisional ? <p>{t("crew.member.provisional")}</p> : null}
          </div>
        ) : null}

        {/* Where its load, history and alert rules live: a link to the page, never a switch of machine. */}
        <Button variant="outline" class="w-full" mix={on("click", () => handle.props.onLoad())}>
          <Icon icon={Activity} class="size-4" />
          {t("machines.memberSheet.link")}
        </Button>
        <Button class="w-full" mix={on("click", () => handle.props.onGo())}>
          {t("crew.sheet.goTo")}
        </Button>
      </div>
    );
  };
}
