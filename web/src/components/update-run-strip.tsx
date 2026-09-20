import { Loader2 } from "lucide-react";

import { Notice } from "@/components/ui/notice";
import { StripSlot } from "@/components/ui/strip-host";
import { UPDATE_RUN } from "@/lib/strip-priority";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";
import type { UpdateScreenDevice, UpdateScreenRow } from "@/lib/update-screen";

// ── A RUN THIS DEVICE DID NOT ASK FOR IS ONE LINE IN THE BAND ───────────────────────────────────
//
// The other half of `components/update-screen.tsx`. That file owns the sheet — the run this device
// started, which takes the screen. This one owns the badge: a run somebody else started, or a run
// this device has let go of with "keep using the app". A takeover nobody asked for reads as
// hijacked, so those get a fact they can open rather than a panel they have to close.
//
// ── IT IS A STRIP, NOT A BAR AT THE BOTTOM (2026-09-20) ─────────────────────
// It used to be `fixed inset-x-0 bottom-0 z-50`, mounted beside the sheet in `App.tsx`. On a pane
// screen that is exactly where the composer's input row is, so the badge covered the one control the
// operator was using — and in the "keep using the app" case, the one control the badge itself had
// just handed back. The band above the header is this app's ONE place for a persistent one-line
// fact, it arbitrates rather than stacking, and it covers nothing. So the badge lives there, and
// `components/update-screen-provider.tsx` is how it reaches a reading owned outside the router.
//
// ── IT RANKS BELOW THE OUTAGE STRIP ─────────────────────────────────────────
// `lib/strip-priority.ts` carries the argument, which goes the other way to the tempting one: during
// a crew update the red bar and this line are often one event seen twice, but not always, and a
// ranking cannot say "only when they are the same event". So an outage still wins.
//
// ── IT DECIDES NOTHING AND STARTS NOTHING ───────────────────────────────────
// Whether there is a badge at all is `screen.mode`, which is `lib/update-screen.ts`'s answer. The
// only thing a tap does is open the sheet that was already going to be the screen's.

export function UpdateRunStrip({ screen }: { screen: UpdateScreenState }) {
  useLocale();
  // The sheet answers `hidden` and `expanded`; both are `components/update-screen.tsx`'s to draw.
  if (screen.mode !== "collapsed") return null;
  return (
    <StripSlot priority={UPDATE_RUN}>
      {/*
        `onActivate` and no dismiss, which `ui/notice.tsx` makes the two shapes mutually exclusive
        at the type level anyway. There is nothing to put this row down FOR: it describes something
        still happening on a machine, closing it would decline nothing, and the run would go on
        behind a band that had stopped saying so. The whole row is the target, as the badge's own
        chevron used to promise.
      */}
      <Notice
        tone="caution"
        variant="strip"
        announce="status"
        icon={<Loader2 className="animate-spin" />}
        onActivate={() => screen.setExpanded(true)}
      >
        {badgeLine(screen.view.rows, screen.view.device)}
      </Notice>
    </StripSlot>
  );
}

/** The badge's one line: whoever is still moving, or this device's own download. */
export function badgeLine(
  rows: readonly UpdateScreenRow[],
  device: UpdateScreenDevice | null,
): string {
  const moving = rows.find((row) => row.moving);
  if (moving !== undefined) {
    return t("updateScreen.badge.moving", { name: moving.name, word: moving.word });
  }
  if (device !== null) return t("updateScreen.badge.downloading");
  return t("updateScreen.badge.generic");
}
