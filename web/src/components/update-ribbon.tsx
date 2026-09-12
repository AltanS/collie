import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Loader2, Package, RefreshCw, TriangleAlert } from "lucide-react";
import { useNavigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Notice, NOTICE_ACTION } from "@/components/ui/notice";
import { StripSlot } from "@/components/ui/strip-host";
import { UPDATE } from "@/lib/strip-priority";
import { useLocale } from "@/hooks/use-locale";
import { dismissUpdate } from "@/lib/api";
import { t } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { checkForUpdate, getUpdateStage, subscribeUpdateStage } from "@/lib/pwa";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { useSelfUpdate } from "@/lib/self-update";
import {
  clearUpdateStarted,
  type Dismissal,
  dismissesLocally,
  dismissTarget,
  getUpdateStarted,
  ribbonText,
  ribbonView,
  subscribeUpdateStarted,
  type RibbonView,
} from "@/lib/update-ribbon";
import type { DismissScope } from "@/lib/types";

// ── THE UPDATE BAND ─────────────────────────────────────────────────────────────────────────────
//
// ONE top-of-app row for the whole update subject: a release is available, the confirm was just
// tapped, a run is in flight, the bridge is new and this bundle is behind it, and peers are
// following. It sits in the slot `UpdateAvailableBanner` used to occupy in `routes/root.tsx`, which
// it absorbs entirely — there is no second top band for updates.
//
// ── IT REGISTERS A SLOT; IT DOES NOT DRAW A ROW ──────────────────────────────
// The pixels live in the ONE band above the header, `ui/strip-host.tsx`, and this component only
// says how loud its fact is: `UPDATE`, the quietest of the four (`lib/strip-priority.ts`). That is
// what ended the band's original fault — this row, the connection bar and the auth refusal each
// reserved the safe-area inset for themselves, on the assumption that each might be the first thing
// on the screen, so any two of them at once paid for the notch twice and left a dead strip above
// the notice. The inset now has one owner and the band has one winner. The losing fact is not lost:
// the update offer keeps its footer line and its `/settings/updates` control.
//
// ── FIXED HEIGHT, IN EVERY STATE ─────────────────────────────────────────────
// The row is one height whatever it is saying, and only the text changes. A band that grew and
// shrank as a run progressed would reflow the whole route under the operator's thumb mid-update,
// which is the one moment they are least able to tolerate it. That height is now `ui/notice.tsx`'s
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
// THE DOWNLOAD ROW IS THE ONE EXCEPTION, and it is not a dismissal at all: closing it declines
// nothing, so it is held in this component and never posted (`lib/update-ribbon.ts`'s
// `dismissesLocally`). The install carries on and the controller swap still reloads this page.
//
// ── THE BAND NEVER STARTS AN UPDATE ──────────────────────────────────────────
// Four of the five states navigate to `/settings/updates`, where the confirm lives. A band that
// could start an update from any screen would be the reflex tap the confirm was designed against.
// The one exception taps `checkForUpdate()`, which reloads THIS PAGE onto a bundle that is already
// built — it changes nothing on the host.

export function UpdateRibbon() {
  useLocale();
  const navigate = useNavigate();
  const scope = useScope();
  const data = useOptionalRootData();
  // The self-updater's own flag. Reading it here is also what MOUNTS the controller — see the header.
  const bundleStale = useSelfUpdate();
  const startedAt = useSyncExternalStore(subscribeUpdateStarted, getUpdateStarted, getUpdateStarted);
  // The service worker's own progress (`lib/pwa.ts`). The band is the only surface that shows it,
  // and it shows it as one word: a download is happening, wait for it (2026-09-12).
  const stage = useSyncExternalStore(subscribeUpdateStage, getUpdateStage, getUpdateStage);
  // OPTIMISTIC ONLY. The dismissal itself lives on the bridge (M17/08) and arrives on the snapshot;
  // this holds what the operator just closed so the band drops on the tap rather than on the next
  // poll. Keyed by version AND scope like the stored one, so a newer version still raises the band
  // and closing a crew notice does not hide this host's own offer.
  const [justDismissed, setJustDismissed] = useState<Dismissal | null>(null);
  // THE DOWNLOAD ROW, PUT DOWN FOR THIS DOCUMENT ONLY (2026-09-12). See `dismissesLocally` for why
  // it is not the bridge's `dismissUpdate`: nothing was declined, the install goes on, and the
  // controller swap still reloads this page when it lands.
  const [downloadHidden, setDownloadHidden] = useState(false);

  const update = data?.update;
  const runState = update?.run?.state;

  // (s) is over the moment the status object speaks. Done as an effect rather than inside the
  // reading so the store is left tidy for the next confirm, and so the reading stays pure.
  useEffect(() => {
    if (runState !== undefined && runState !== "idle") clearUpdateStarted();
  }, [runState]);

  // A CLOSE COVERS ONE DOWNLOAD, NOT EVERY FUTURE ONE. The stage leaving `installing` is the end of
  // the worker that was closed over, so the next `updatefound` raises the row again rather than
  // inheriting a decision made about a different bundle.
  useEffect(() => {
    if (stage !== "installing") setDownloadHidden(false);
  }, [stage]);

  const view = ribbonView({
    update,
    startedAt,
    bundleStale,
    bundleInstalling: stage === "installing",
    dismissedVersion: dismissedIn("offer", justDismissed, update?.dismissedVersion),
    dismissedCrewVersion: dismissedIn("crew", justDismissed, update?.dismissedCrewVersion),
    now: Date.now(),
  });
  if (view.kind === "silent") return null;
  // Closed for this document, and the row stays gone rather than falling back to the offer it
  // outranks: a band that came straight back as "tap to reload" would be the nag the close refused.
  if (dismissesLocally(view) && downloadHidden) return null;

  const skin = skinOf(view);
  // Which states can be put down, and what a dismiss records, is the reading's own decision — see
  // `lib/update-ribbon.ts`. A state that describes something still happening carries no close.
  const target = dismissTarget(view);

  function onTap() {
    // The two bundle states reload THIS PAGE onto a bundle that already exists. Everything else is a
    // navigation to the page that owns the confirm.
    if (view.kind === "updated" || view.kind === "bundle") {
      void checkForUpdate();
      return;
    }
    void navigate(updatesPath(scope));
  }

  // `announce="status"` and nothing beside it: `role="status"` carries its own politeness, and an
  // `aria-live` next to it is the double announcement `ui/notice.tsx` makes inexpressible.
  const shared = {
    tone: skin.tone,
    variant: "strip",
    announce: "status",
    icon: <skin.Icon className={skin.spin ? "animate-spin" : undefined} />,
    children: ribbonText(view, update?.linkChange ?? null),
  } as const;

  // THE DOWNLOAD ROW: A CLOSE AND NOTHING ELSE (2026-09-12). It carries no action button and no
  // whole-surface tap, because there is nothing for a tap to do while a worker is on its way in —
  // the old tap reached `checkForUpdate()`, which finds that worker and keeps waiting. What the
  // operator needs on a dead link is the other door: put the row down, keep using the app on
  // screen, and let the controller swap reload the page if the download ever lands.
  if (dismissesLocally(view)) {
    return (
      <StripSlot priority={UPDATE}>
        <Notice
          {...shared}
          dismissLabel={t("updateRibbon.hideNotice")}
          onDismiss={() => setDownloadHidden(true)}
        />
      </StripSlot>
    );
  }

  return (
    <StripSlot priority={UPDATE}>
      {/*
        TWO SHAPES, BECAUSE A BUTTON MAY NOT HOLD A BUTTON. `ui/notice.tsx` states the exclusion at
        the type level: a whole-surface tap and a separate dismiss cannot both be true, since the
        browsers that tolerate the nesting disagree about which control a tap fires. This band used
        to write exactly that pair — a row-wide tap target with an ✕ beside it — so the states that
        can be put down give up the row-wide target and get a named control instead. Which states
        those are is `dismissTarget`'s decision and not a second opinion here: a state describing
        something still happening carries no close, and therefore keeps the whole row as its target.
      */}
      {target === null ? (
        <Notice {...shared} onActivate={onTap} />
      ) : (
        <Notice
          {...shared}
          action={
            <Button size="sm" className={NOTICE_ACTION} onClick={onTap}>
              {t("updateRibbon.view")}
            </Button>
          }
          dismissLabel={t(
            target.scope === "crew" ? "updateRibbon.hideNotice" : "updateRibbon.dismiss",
          )}
          onDismiss={() => {
            setJustDismissed(target);
            // Told to the bridge, which is where the decision belongs. A failed call is a courtesy
            // lost, not an error worth a line: this band is already gone, and the next tap re-sends.
            void dismissUpdate(target.version, target.scope).catch(() => {});
          }}
        />
      )}
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

/** Icon + tone per state. A failed peer is the only red the band can show; everything else is
 *  ambient working colour, including a finished run — a done update is not an alarm.
 *
 *  The tones are `ui/notice.tsx`'s, and they are the SAME two tokens this band mixed for itself
 *  before: `danger` is `--status-blocked` and `caution` is `--status-working`. No colour changes
 *  here; what changes is that the recipe is written once, in the one table allowed to hold it. */
function skinOf(view: RibbonView) {
  if (view.kind === "peer-failed") {
    return { Icon: TriangleAlert, spin: false, tone: "danger" } as const;
  }
  // A DOWNLOAD IS A THING IN FLIGHT, so it wears the spinner (2026-09-12). It is the one bundle
  // state that does: the other two are standing offers, and a spinner on an offer would say
  // something was already running.
  if (
    view.kind === "starting" ||
    view.kind === "updating" ||
    view.kind === "peers" ||
    view.kind === "bundle-installing"
  ) {
    return { Icon: Loader2, spin: true, tone: "caution" } as const;
  }
  // A packaged peer is a state, not an alarm and not a thing in progress: the ambient tint the band
  // already uses, and a still icon. A spinner here would say the run is waiting on that machine.
  if (view.kind === "package-managed") {
    return { Icon: Package, spin: false, tone: "caution" } as const;
  }
  // A RELOAD IS NOT AN OFFER (M20/05). `updated` and `bundle` both say "the bundle on this screen is
  // behind, reload it", and `ArrowUpCircle` is the universal mark for "a new version is available".
  // Wearing it here made the operator read the band as a second offer, tap it expecting something to
  // start, and see nothing start. Still, never spinning: nothing is in flight until the tap.
  if (view.kind === "updated" || view.kind === "bundle") {
    return { Icon: RefreshCw, spin: false, tone: "caution" } as const;
  }
  return { Icon: ArrowUpCircle, spin: false, tone: "caution" } as const;
}
