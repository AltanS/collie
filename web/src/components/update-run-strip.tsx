import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { NOTICE_ACTION, Notice } from "@/components/ui/notice";
import { StripSlot } from "@/components/ui/strip-host";
import { UPDATE_RUN } from "@/lib/strip-priority";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { UpdateScreen as UpdateScreenState } from "@/hooks/use-update-screen";

// ── A RUN THIS DEVICE IS NOT LOCKED BY IS ONE LINE IN THE BAND ──────────────────────────────────
//
// The other half of `components/update-screen.tsx`. That file owns update mode: the locked app and the
// docked panel, on the device that started the run (ADR 0064). This one owns the strip: "Update
// running, started on another device. <step>. View" on every other device, and "Update running.
// <step>." on the device that took "Use the app anyway". A takeover nobody asked for reads as
// hijacked, so those get a fact they can open, and the app stays theirs.
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
// Whether there is a strip at all is `screen.mode`, which is `lib/update-screen.ts`'s answer. "View"
// opens the same panel read-only: no lock, and "Back to the app" instead of the lock line.

export function UpdateRunStrip({ screen }: { screen: UpdateScreenState }) {
  useLocale();
  // The panel answers `hidden` and `expanded`; both are `components/update-screen.tsx`'s to draw.
  if (screen.mode !== "collapsed") return null;
  return (
    <StripSlot priority={UPDATE_RUN}>
      {/*
        No dismiss. There is nothing to put this row down FOR: it describes something still happening
        on a machine, and the run would go on behind a band that had stopped saying so. "View" is an
        action of its own rather than the whole row, so it keeps its place at the end of a line that
        truncates on a phone, the way the drawn option had it.
      */}
      <Notice
        tone="caution"
        variant="strip"
        announce="status"
        icon={<Loader2 className="motion-safe:animate-spin" />}
        action={
          <Button size="sm" variant="ghost" className={NOTICE_ACTION} onClick={() => screen.setExpanded(true)}>
            {t("updateScreen.strip.view")}
          </Button>
        }
      >
        {stripLine(screen)}
      </Notice>
    </StripSlot>
  );
}

/**
 * The strip's one line. On the device that started the run and let go of it: "Update running." and
 * the step. On every other device the same, plus that it was started elsewhere, so a phone that did
 * not tap anything knows why its machines are restarting.
 *
 * "Another device", not the device's name: the run record does not say who started it, and a name
 * guessed here would be wrong on the one screen that needs it right.
 */
export function stripLine(screen: Pick<UpdateScreenState, "view">): string {
  const step = screen.view.heading;
  return screen.view.mine ? t("updateScreen.strip.mine", { step }) : t("updateScreen.strip.other", { step });
}
