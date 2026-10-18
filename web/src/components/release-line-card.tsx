import { useEffect, useState, useSyncExternalStore } from "react";
import { GitBranch, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Segmented } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import { setReleaseLine } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { useOptionalRootData } from "@/lib/route-data";
import { openUpdateMode } from "@/lib/update-ask";
import { getUpdateClaim, runInFlight, subscribeUpdateStarted } from "@/lib/update-ribbon";
import { readUpdateState, useUpdateRun } from "@/lib/update-run-store";
import { mintRequestId } from "@/lib/worktree-name";
import type { ReleaseLine } from "@/lib/types";

// ── RELEASE LINE: STABLE OR EDGE (M60 spec 01, ADR 0110) ────────────────────────────────────────
//
// One setting per machine. Stable takes final releases only. Edge also takes the `-edge.N` builds,
// which reach volunteers a few days before they become Stable. The switch installs nothing: the
// bridge saves the line (`POST /api/update/line`, with a request id) and the card above offers what
// the new line offers, through the normal update sheet.
//
// ── BACK TO STABLE, THREE CASES ─────────────────────────────────────────────
// On Stable, a machine that runs an Edge build is in one of three cases, and the bridge says which:
//   1. A Stable release at or above the build is out: it is the card's normal offer. One sentence here.
//   2. The build is ahead of every Stable: the bridge sends `back`, the Stable release below it.
//      "Go back now" opens update mode at "Ready to start" for that release, and its start is the
//      confirm (`POST /api/update/back`, a run with a request id). "Wait for Stable" keeps the build:
//      no Edge build is offered any more, and the next Stable is offered the day it is out.
//      Any state file that release cannot read is named BEFORE the button (ADR 0110).
//   3. The machine already runs a Stable release: nothing to do, and nothing extra is drawn.
//
// ── THE CREW FOLLOWS THE LEAD'S LINE ────────────────────────────────────────
// The lead passes its line to its members with the version it levels, so this card on the lead is
// the crew's switch. A member's own card shows the line it took from its lead.

const EDGE_BUILD = /-edge\.\d+$/;

/** A version a machine on Stable takes: no prerelease part. */
const isStable = (version: string): boolean => /^\d+\.\d+\.\d+$/.test(version);

export function ReleaseLineCard() {
  useLocale();
  const data = useOptionalRootData();
  const { check, run } = useUpdateRun();
  const claim = useSyncExternalStore(subscribeUpdateStarted, getUpdateClaim, getUpdateClaim);
  const info = data?.update ?? check;
  const shown: ReleaseLine = info?.line ?? "stable";
  const current = info?.current ?? "";
  const latest = info?.latest ?? null;
  const releaseAvailable = info?.releaseAvailable ?? false;
  const packaged = (info?.installKind ?? check?.installKind) === "packaged";
  const back = info?.back ?? null;

  // The line this device just saved, until the bridge's own status says the same. A later change
  // from another device then shows, because this one no longer outranks it.
  const [saved, setSaved] = useState<ReleaseLine | null>(null);
  const [receipt, setReceipt] = useState<ReleaseLine | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (saved !== null && saved === shown) setSaved(null);
  }, [saved, shown]);
  const line = saved ?? shown;
  const moving = claim !== null || runInFlight(run);

  async function choose(next: ReleaseLine): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      const answer = await setReleaseLine({ line: next, requestId: mintRequestId() });
      setSaved(answer.line);
      setReceipt(answer.line);
      setWaiting(false);
      // The offer changes with the line, and the card above reads it from the shared check.
      void readUpdateState();
    } catch (thrown) {
      setError(t("updates.line.failed", { reason: describeThrownError(thrown) }));
    } finally {
      setSaving(false);
    }
  }

  const edgeBuild = EDGE_BUILD.test(current);
  const onStableFromEdge = line === "stable" && edgeBuild;
  const stableOffered = releaseAvailable && latest !== null && isStable(latest);

  return (
    <Card className="gap-0 py-0" data-slot="release-line">
      <div className="flex items-start gap-3 p-4">
        <GitBranch className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("updates.line.title")}</div>
          <p className="text-sm text-muted-foreground">{t("updates.line.description")}</p>
        </div>
      </div>

      <div className="border-t border-border p-2">
        <Segmented
          options={[
            { value: "stable", label: t("updates.line.stable") },
            { value: "edge", label: t("updates.line.edge") },
          ]}
          value={line}
          onChange={(next) => void choose(next)}
          label={t("updates.line.title")}
          semantics="choice"
          disabled={saving || moving}
        />
      </div>

      {/* Always rendered, so a receipt or a refusal arriving grows nothing above it. */}
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {saving && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
          {saving
            ? t("updates.line.saving")
            : error !== null
              ? ""
              : receipt === "edge"
                ? t("updates.line.receipt.edge")
                : receipt === "stable"
                  ? t("updates.line.receipt.stable")
                  : line === "edge"
                    ? t("updates.line.on.edge")
                    : t("updates.line.on.stable")}
        </p>
        {error !== null && <p className="text-sm text-status-blocked">{error}</p>}

        {onStableFromEdge && back !== null && !waiting && (
          <div className="flex flex-col gap-2" data-slot="release-line-back">
            <p className="text-sm">{t("updates.line.back.ahead", { current, stable: back.to })}</p>
            {back.exceptions.length > 0 && (
              <p className="text-sm text-status-blocked">
                {t("updates.line.back.exceptions", { stable: back.to, files: back.exceptions.join(", ") })}
              </p>
            )}
            {!packaged && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11"
                  disabled={moving || saving}
                  onClick={() =>
                    openUpdateMode({ kind: "back", version: back.to, major: false, peersOnly: false, current })
                  }
                >
                  {t("updates.line.back.goNow")}
                </Button>
                <Button variant="ghost" size="sm" className="h-11" disabled={moving || saving} onClick={() => setWaiting(true)}>
                  {t("updates.line.back.wait")}
                </Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("updates.line.back.choiceNote", { stable: back.to })}</p>
          </div>
        )}
        {onStableFromEdge && back !== null && waiting && (
          <p className="text-sm text-muted-foreground">{t("updates.line.back.waiting")}</p>
        )}
        {onStableFromEdge && back === null && stableOffered && (
          <p className="text-sm text-muted-foreground">{t("updates.line.back.offered", { stable: latest })}</p>
        )}
        {onStableFromEdge && back === null && !stableOffered && (
          <p className="text-sm text-muted-foreground">{t("updates.line.back.none", { current })}</p>
        )}
      </div>
    </Card>
  );
}
