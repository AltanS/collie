import { useState, useSyncExternalStore } from "react";
import { Icon } from "@/components/icons/icon";

import { Notice } from "@/components/ui/notice";
import { useNav } from "@/hooks/use-nav";
import { StripSlot } from "@/components/ui/strip-host";
import { UPDATE } from "@/lib/strip-priority";
import { useLocale } from "@/hooks/use-locale";
import { dismissUpdate } from "@/lib/api";
import { t } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { getUpdateStage, subscribeUpdateStage } from "@/lib/pwa";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { useBundleApply } from "@/lib/bundle-apply";
import { useSelfUpdate } from "@/lib/self-update";
import { useUpdateRun } from "@/lib/update-run-store";
import {
  carriedByMark,
  type Dismissal,
  dismissTarget,
  ribbonText,
  ribbonView,
  type RibbonView,
} from "@/lib/update-ribbon";
import type { DismissScope } from "@/lib/types";

// ── THE UPDATE BAND ─────────────────────────────────────────────────────────────────────────────
//
// ONE top-of-app row for the part of the update subject that is NOT a run: a release is available, or
// a peer's leg failed. It sits in the slot `UpdateAvailableBanner` used to occupy in `routes/root.tsx`,
// which it absorbs entirely — there is no second top band for updates.
//
// ── THE APP BUNDLE IS THE MARK'S, NOT THIS ROW'S (2026-11-06) ────────────────
// This row used to say "Downloading the new version…" and "New version, tap to update" as well. Altan
// asked for the header mark to carry both: every bead turns in this row's own colour
// (`--status-working`) at the loading rate, and a tap on the mark opens the dashboard, whose update
// line says which of the two it is (`components/update-banner.tsx`, `lib/bundle-apply.ts`). So the
// reading still decides those two states, and with them that nothing below them is said, but this
// component posts no row for them ({@link carriedByMark}). The band's geometry is untouched: a fact
// that posts no slot takes no height.
//
// ── A RUN IN PROGRESS IS THE SCREEN'S, NOT THIS ROW'S (M28/01) ───────────────
// The confirm just tapped, the run in flight, the run finished and the peers trailing it all left for
// `components/update-screen.tsx`, which shows a row per machine and this device's own download. The
// reasoning sits at the precedence list in `lib/update-ribbon.ts`. What this row must never do is say
// the same thing again in forty characters.
//
// ── IT REGISTERS A SLOT; IT DOES NOT DRAW A ROW ──────────────────────────────
// The pixels live in the ONE band under the header, `ui/strip-host.tsx`, and this component only
// says how loud its fact is: `UPDATE`, the quietest of the four (`lib/strip-priority.ts`). That is
// what ended the band's original fault — this row, the connection bar and the auth refusal each
// reserved the safe-area inset for themselves, on the assumption that each might be the first thing
// on the screen, so any two of them at once paid for the notch twice and left a dead strip above
// the notice. The inset now has one owner (the header, which the band sits under) and the band has
// one winner. The losing fact is not lost: the update offer keeps its footer line and its
// `/settings/updates` control.
//
// ── FIXED HEIGHT, IN EVERY STATE ─────────────────────────────────────────────
// The row is one height whatever it is saying, and only the text changes. A band that grew and
// shrank as a run progressed would cover more and then less of the route under the operator's thumb
// mid-update (it reflowed the whole route until the band became an overlay on 2026-10-07), which is
// the one moment they are least able to tolerate it. That height is now `ui/notice.tsx`'s
// `min-h-[33px]` strip floor, shared with every other strip, rather than a number written here —
// which is also what makes the band's arbitration height-invariant. One truncating line rather than
// a wrapping paragraph, and the strings are held to a 40-character budget in all six locales for
// the same reason (see the i18n test).
//
// ── MOUNTED UNCONDITIONALLY ──────────────────────────────────────────────────
// `useSelfUpdate()` is a CONTROLLER as well as a flag: it drives the bundle auto-reload for the
// app's lifetime, and it only runs while something mounts it. So this component mounts always and
// returns null when it has nothing to say — exactly the invariant the banner it replaces carried.
//
// ── A DISMISSAL IS THE MACHINE'S, NOT THE BROWSER'S ──────────────────────────
// Closing the band posts the version to the bridge, which keeps it beside the digest's own record
// (M17/08). One tap on the phone therefore drops the band on the laptop at its next poll, and the
// same request stops tomorrow's digest naming the version that was just declined. The local state
// below is optimistic only — it drops the band on the tap instead of on the poll.
//
// ── THE BAND NEVER STARTS AN UPDATE ──────────────────────────────────────────
// Every state navigates to `/settings/updates`, where the confirm lives. A band that could start an
// update from any screen would be the reflex tap the confirm was designed against.

export function UpdateRibbon() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const data = useOptionalRootData();
  // The self-updater's own flag. Reading it here is also what MOUNTS the controller — see the header.
  const bundleStale = useSelfUpdate();
  // The app on this phone being applied, the fact the mark and the dashboard line read. It covers
  // the automatic lane as well, where `bundleStale` stays down (`lib/bundle-apply.ts`).
  const applying = useBundleApply();
  // The service worker's own progress (`lib/pwa.ts`). Read for the reading's precedence only: while
  // a download is on, the mark carries it and this row says nothing else either.
  const stage = useSyncExternalStore(subscribeUpdateStage, getUpdateStage, getUpdateStage);
  // OPTIMISTIC ONLY. The dismissal itself lives on the bridge (M17/08) and arrives on the snapshot;
  // this holds what the operator just closed so the band drops on the tap rather than on the next
  // poll. Keyed by version AND scope like the stored one, so a newer version still raises the band
  // and closing a crew notice does not hide this host's own offer.
  const [justDismissed, setJustDismissed] = useState<Dismissal | null>(null);

  const update = data?.update;
  // THE CENSUS, from the one store that owns the update subject (ADR 0044). The snapshot does not
  // carry it, and the band needs it for one decision: a failed leg whose member has since levelled
  // itself is no longer a sentence worth a row (`lib/crew-level.ts`). The store is already subscribed
  // by the update screen in `App.tsx`, so reading it here adds no request.
  const { crew } = useUpdateRun();

  const view = ribbonView({
    update,
    bundleStale,
    bundleInstalling: stage === "installing",
    dismissedVersion: dismissedIn("offer", justDismissed, update?.dismissedVersion),
    dismissedCrewVersion: dismissedIn("crew", justDismissed, update?.dismissedCrewVersion),
    // A tap in THIS tab covers the run on screen, whatever it settled at, so it carries no stamp. The
    // bridge's stamp takes over on the next poll.
    dismissedCrewAt: justDismissed?.scope === "crew" ? null : (update?.dismissedCrewAt ?? null),
    crew,
    now: Date.now(),
  });
  if (view.kind === "silent") return null;
  // The mark carries the bundle (see the header), and the row stays gone rather than falling back to
  // the states it outranks: the band and the mark would be talking about two updates at once.
  if (carriedByMark(view)) return null;
  // WHILE THE APP IS BEING APPLIED THE BAND SAYS NOTHING ABOUT UPDATES AT ALL (2026-11-06). The mark
  // and the dashboard line own the subject then, so an offer or a failed peer never shows beside a
  // turning mark. This reaches past `carriedByMark` for one case: the automatic lane, where the
  // reading never sees a bundle state because the self-updater's flag never rises.
  if (applying !== null) return null;

  const skin = skinOf(view);
  // Which states can be put down, and what a dismiss records, is the reading's own decision — see
  // `lib/update-ribbon.ts`. A state that describes something still happening carries no close.
  const target = dismissTarget(view);

  function onTap() {
    nav.down(updatesPath(scope));
  }

  // `announce="status"` and nothing beside it: `role="status"` carries its own politeness, and an
  // `aria-live` next to it is the double announcement `ui/notice.tsx` makes inexpressible.
  const shared = {
    tone: skin.tone,
    variant: "strip",
    announce: "status",
    icon: <Icon name={skin.icon} />,
    children: ribbonText(view, update?.linkChange ?? null, update?.urgent ?? null),
  } as const;

  // THE WHOLE ROW IS ALWAYS THE TARGET NOW (2026-09-23). `ui/notice.tsx` used to forbid pairing a
  // whole-surface tap with a separate dismiss — a <button> may not hold a second one — so a state
  // that could be put down gave up the row-wide target for a named "View" button instead, which on
  // a phone was easy to miss and left the rest of the row dead to the touch. `Notice` now offers a
  // shape for exactly this: an EMPTY overlay button beside the body rather than around it, so the ✕
  // (when there is one) is a sibling and not a nested button, and both stay independently tappable.
  // Which states get a ✕ at all is still `dismissTarget`'s decision, not a second opinion here — a
  // state describing something still happening carries no close, and keeps the row-wide target alone.
  if (target === null) {
    return (
      <StripSlot priority={UPDATE}>
        <Notice {...shared} onActivate={onTap} />
      </StripSlot>
    );
  }

  return (
    <StripSlot priority={UPDATE}>
      <Notice
        {...shared}
        onActivate={onTap}
        dismissLabel={t(target.scope === "crew" ? "updateRibbon.hideNotice" : "updateRibbon.dismiss")}
        onDismiss={() => {
          setJustDismissed(target);
          // Told to the bridge, which is where the decision belongs. A failed call is a courtesy
          // lost, not an error worth a line: this band is already gone, and the next tap re-sends.
          void dismissUpdate(target.version, target.scope).catch(() => {});
        }}
      />
    </StripSlot>
  );
}

/** What the reading should treat as dismissed in one scope: the tap this tab just made, when it was
 *  in that scope, else what the bridge has recorded. */
function dismissedIn(
  scope: DismissScope,
  local: Dismissal | null,
  stored: string | null | undefined,
): string | null {
  if (local !== null && local.scope === scope) return local.version;
  return stored ?? null;
}

/** Icon + tone per state. A failed peer is the only red the band can show; an offer is ambient
 *  working colour. The two bundle states never reach here: the mark carries them.
 *
 *  The tones are `ui/notice.tsx`'s, and they are the SAME two tokens this band mixed for itself
 *  before: `danger` is `--status-blocked` and `caution` is `--status-working`. No colour changes
 *  here; what changes is that the recipe is written once, in the one table allowed to hold it. */
function skinOf(view: RibbonView) {
  if (view.kind === "peer-failed") {
    return { icon: "error", tone: "danger" } as const;
  }
  return { icon: "update-available", tone: "caution" } as const;
}
