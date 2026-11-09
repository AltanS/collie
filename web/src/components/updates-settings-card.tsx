import { useEffect, useState } from "react";

import { updateNotice } from "@/components/update-banner";
import { fetchUpdateState } from "@/lib/api";
import { t, tn } from "@/lib/i18n";
import { useOptionalRootData } from "@/lib/route-data";
import { leadLevelsCrew } from "@/lib/crew-level";
import { peersBehind } from "@/lib/update-crew";
import type { UpdateInfo, UpdateCrewMember } from "@/lib/types";

/**
 * The status the Updates row on the Settings index shows (M16/01, moved from System by the Settings
 * rework).
 *
 * Updating used to be three cards on one page for one subject — the check control, the card, and a
 * footer chip. It is a flow now, with a lead, N peers, progress and a rollback state, so it lives on
 * `/settings/updates` and the Settings index carries ONE row that opens it. The row itself is drawn
 * by `routes/settings.tsx` like its siblings; this file owns what it SAYS.
 *
 * Unlike the crew card this is NOT gated on `multi`. A solo install still updates, and the row is
 * the way to that page from Settings.
 *
 * ── WHY IT READS THE CHECK AT ALL ────────────────────────────────────────────
 * "N peers behind" is not on the snapshot: the roster every phone polls carries no versions, on
 * purpose. So the row takes ONE best-effort read of the cached `GET /api/update/check` on mount.
 * A failed read is not an error to render — the line falls back to what the snapshot already knows,
 * which is every case except the peer count.
 */
export function useUpdatesStatus(): UpdatesStatus {
  const data = useOptionalRootData();
  const [crew, setCrew] = useState<UpdateCrewMember[]>([]);

  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const check = await fetchUpdateState(ac.signal);
        setCrew(check.crew ?? []);
      } catch {
        // No peer count, and no line on screen about it. Every other case still reads true.
      }
    })();
    return () => ac.abort();
  }, []);

  // No root answer yet, or the last one failed: whatever `update` still names is a stale
  // snapshot's, and rendering it would state a release (or "up to date") as current fact (#512).
  const unknown = data === undefined || data.error;
  const update = data?.update;
  const runState = update?.run?.state;
  const running =
    runState === "preflight" ||
    runState === "staging" ||
    runState === "restarting" ||
    runState === "verifying";
  // A development-build lead offers no crew run, so it counts nobody behind (`leadLevelsCrew`).
  const behind = leadLevelsCrew(update?.build) ? peersBehind(crew, update?.current ?? "") : 0;

  return updatesStatus({ update, running, behind, unknown });
}

/** The row's caption, and whether a release is waiting (the row then leads with a dot). */
export interface UpdatesStatus {
  line: string;
  available: boolean;
}

/**
 * The row's status line, in the stated precedence. `unknown` outranks them all: a snapshot
 * that never arrived, or a stale copy after a failed load, states no update fact at all (#512).
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
export function updatesStatus(a: {
  update: UpdateInfo | undefined;
  running: boolean;
  behind: number;
  /** The snapshot is absent or a failed load's stale copy: no fact below may be stated (#512). */
  unknown?: boolean;
}): UpdatesStatus {
  if (a.unknown) return { line: t("updates.entry.status.unknown"), available: false };
  if (a.running) return { line: t("updates.entry.status.updating"), available: false };
  if (a.behind > 0) return { line: tn("updates.entry.status.peersBehind", a.behind), available: false };
  const notice = updateNotice(a.update);
  if (notice === null) {
    const current = a.update?.current ?? "";
    const line =
      current === ""
        ? t("updates.entry.status.upToDate")
        : t("updates.entry.status.upToDateVersion", { version: current });
    return { line, available: false };
  }
  if (a.update?.bridgeStale === true) return { line: notice.line, available: false };
  const version = a.update?.latest ?? a.update?.majorAvailable ?? "";
  return { line: t("updates.entry.status.available", { version }), available: true };
}

/** {@link updatesStatus}'s caption alone. */
export function updatesStatusLine(a: Parameters<typeof updatesStatus>[0]): string {
  return updatesStatus(a).line;
}
