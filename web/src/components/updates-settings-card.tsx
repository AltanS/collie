import { useEffect, useState } from "react";
import { ChevronRight, ArrowUpCircle } from "lucide-react";
import { useNavigate } from "react-router";

import { Card } from "@/components/ui/card";
import { updateNotice } from "@/components/update-banner";
import { useLocale } from "@/hooks/use-locale";
import { fetchUpdateState } from "@/lib/api";
import { t, tn } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { peersBehind } from "@/lib/update-pack";
import type { UpdateInfo, UpdatePackMember } from "@/lib/types";

/**
 * The ONE update row Settings keeps (M16/01).
 *
 * Updating used to be three cards on this page — the check control, the card, and a footer chip —
 * for one subject, on the screen an operator opens to change a theme. It is a flow now, with a
 * lead, N peers, progress and a rollback state, so it lives on `/settings/updates` and Settings
 * carries this: `PackSettingsCard`'s idiom plus the two things a row that hides a flow needs, a
 * status line and a chevron.
 *
 * Unlike the pack row this one is NOT gated on `multi`. A solo install still updates, and this row
 * is now the only way to that page from Settings.
 *
 * ── WHY IT READS THE CHECK AT ALL ────────────────────────────────────────────
 * "N peers behind" is not on the snapshot: the roster every phone polls carries no versions, on
 * purpose. So the row takes ONE best-effort read of the cached `GET /api/update/check` on mount.
 * A failed read is not an error to render — the line falls back to what the snapshot already knows,
 * which is every case except the peer count.
 */
export function UpdatesSettingsCard() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const data = useOptionalRootData();
  const [pack, setPack] = useState<UpdatePackMember[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const check = await fetchUpdateState(ac.signal);
        setPack(check.pack ?? []);
      } catch {
        // No peer count, and no line on screen about it. Every other case still reads true.
      }
    })();
    return () => ac.abort();
  }, []);

  const update = data?.update;
  const runState = update?.run?.state;
  const running =
    runState === "preflight" ||
    runState === "staging" ||
    runState === "restarting" ||
    runState === "verifying";
  const behind = peersBehind(pack, update?.current ?? "");

  return (
    <Card className="gap-0 py-0">
      <button
        type="button"
        onClick={() => navigate(updatesPath(scope))}
        className="flex w-full items-center gap-3 p-4 text-left active:bg-muted/60"
      >
        <ArrowUpCircle className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{t("updates.entry.title")}</div>
          <p className="text-sm text-muted-foreground">{updatesStatusLine({ update, running, behind })}</p>
        </div>
        <ChevronRight aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      </button>
    </Card>
  );
}

/**
 * The row's status line, in the stated precedence.
 *
 * The first two rows are this row's own: a run in flight, then a peer left behind. Past those the
 * precedence is {@link updateNotice}'s — the same pure function the footer chip used — so the row
 * and the page cannot disagree about which of a stale process, a release and a major matters most.
 *
 * The WORDS are shorter than the banner's, because this row already carries the title "Updates":
 * the banner's "Collie " prefix would print the subject twice on one line. The stale-process case
 * keeps the banner's own sentence, since it names a different remedy and must not be flattened
 * into "a version is available".
 */
export function updatesStatusLine(a: {
  update: UpdateInfo | undefined;
  running: boolean;
  behind: number;
}): string {
  if (a.running) return t("updates.entry.status.updating");
  if (a.behind > 0) return tn("updates.entry.status.peersBehind", a.behind);
  const notice = updateNotice(a.update);
  if (notice === null) return t("updates.entry.status.upToDate");
  if (a.update?.bridgeStale === true) return notice.line;
  const version = a.update?.latest ?? a.update?.majorAvailable ?? "";
  return t("updates.entry.status.available", { version });
}
