import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Loader2, Package, TriangleAlert, X } from "lucide-react";
import { useNavigate } from "react-router";

import { useLocale } from "@/hooks/use-locale";
import { dismissUpdate } from "@/lib/api";
import { t } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { checkForUpdate } from "@/lib/pwa";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { useSelfUpdate } from "@/lib/self-update";
import {
  clearUpdateStarted,
  type Dismissal,
  dismissTarget,
  getUpdateStarted,
  ribbonText,
  ribbonView,
  subscribeUpdateStarted,
  type RibbonView,
} from "@/lib/update-ribbon";
import type { DismissScope } from "@/lib/types";
import { cn } from "@/lib/utils";

// ── THE UPDATE BAND ─────────────────────────────────────────────────────────────────────────────
//
// ONE top-of-app row for the whole update subject: a release is available, the confirm was just
// tapped, a run is in flight, the bridge is new and this bundle is behind it, and peers are
// following. It sits in the slot `UpdateAvailableBanner` used to occupy in `routes/root.tsx`, which
// it absorbs entirely — there is no second top band for updates.
//
// ── IN-FLOW, NEVER OVER THE HEADER ───────────────────────────────────────────
// A flex row in RootLayout's `h-[100dvh]` column, `shrink-0`, with the safe-area top inset. It
// RESERVES space rather than overlaying, which is the whole reason a banner here can never cover a
// route's sticky header. No `fixed`, no `absolute`, no z-index escape — asserted by a test.
//
// ── FIXED HEIGHT, IN EVERY STATE ─────────────────────────────────────────────
// The row is one height whatever it is saying, and only the text changes. A band that grew and
// shrank as a run progressed would reflow the whole route under the operator's thumb mid-update,
// which is the one moment they are least able to tolerate it. Hence an explicit height rather than
// vertical padding, and one truncating line rather than a wrapping paragraph. The strings are held
// to a 40-character budget in all six locales for the same reason (see the i18n test).
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
// Four of the five states navigate to `/settings/updates`, where the confirm lives. A band that
// could start an update from any screen would be the reflex tap the confirm was designed against.
// The one exception taps `checkForUpdate()`, which reloads THIS PAGE onto a bundle that is already
// built — it changes nothing on the host.

/** The row itself. Exported so the tests can assert it is byte-identical across every state. */
export const BAND_CLASS =
  "flex w-full shrink-0 items-center gap-2 overflow-hidden border-b px-4 text-left text-xs font-medium text-foreground [height:calc(env(safe-area-inset-top)_+_1.75rem)] [padding-top:env(safe-area-inset-top)]";

/** Existing status tokens only — no new colour enters the app for this band. */
const TINT = {
  working: { row: "border-status-working/40 bg-status-working/15", icon: "text-status-working" },
  blocked: { row: "border-status-blocked/40 bg-status-blocked/15", icon: "text-status-blocked" },
} as const;

export function UpdateRibbon() {
  useLocale();
  const navigate = useNavigate();
  const scope = useScope();
  const data = useOptionalRootData();
  // The self-updater's own flag. Reading it here is also what MOUNTS the controller — see the header.
  const bundleStale = useSelfUpdate();
  const startedAt = useSyncExternalStore(subscribeUpdateStarted, getUpdateStarted, getUpdateStarted);
  // OPTIMISTIC ONLY. The dismissal itself lives on the bridge (M17/08) and arrives on the snapshot;
  // this holds what the operator just closed so the band drops on the tap rather than on the next
  // poll. Keyed by version AND scope like the stored one, so a newer version still raises the band
  // and closing a pack notice does not hide this host's own offer.
  const [justDismissed, setJustDismissed] = useState<Dismissal | null>(null);

  const update = data?.update;
  const runState = update?.run?.state;

  // (s) is over the moment the status object speaks. Done as an effect rather than inside the
  // reading so the store is left tidy for the next confirm, and so the reading stays pure.
  useEffect(() => {
    if (runState !== undefined && runState !== "idle") clearUpdateStarted();
  }, [runState]);

  const view = ribbonView({
    update,
    startedAt,
    bundleStale,
    dismissedVersion: dismissedIn("offer", justDismissed, update?.dismissedVersion),
    dismissedPackVersion: dismissedIn("pack", justDismissed, update?.dismissedPackVersion),
    now: Date.now(),
  });
  if (view.kind === "silent") return null;

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

  return (
    // `role="status"` carries its own politeness — an `aria-live` beside it is the double
    // announcement `ui/notice.tsx` pins a test against.
    <div role="status" className={cn(BAND_CLASS, skin.row)}>
      <button
        type="button"
        onClick={onTap}
        className="flex min-w-0 flex-1 items-center gap-2 text-left"
      >
        <skin.Icon className={cn("size-3.5 shrink-0", skin.icon, skin.spin && "animate-spin")} />
        <span className="min-w-0 flex-1 truncate">{ribbonText(view)}</span>
      </button>
      {target !== null && (
        <button
          type="button"
          aria-label={t(target.scope === "pack" ? "updateRibbon.hideNotice" : "updateRibbon.dismiss")}
          className="shrink-0 text-muted-foreground"
          onClick={() => {
            setJustDismissed(target);
            // Told to the bridge, which is where the decision belongs. A failed call is a courtesy
            // lost, not an error worth a line: this band is already gone, and the next tap re-sends.
            void dismissUpdate(target.version, target.scope).catch(() => {});
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
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

/** Icon + tint per state. A failed peer is the only red the band can show; everything else is
 *  ambient working colour, including a finished run — a done update is not an alarm. */
function skinOf(view: RibbonView) {
  if (view.kind === "peer-failed") {
    return { Icon: TriangleAlert, spin: false, ...TINT.blocked } as const;
  }
  if (view.kind === "starting" || view.kind === "updating" || view.kind === "peers") {
    return { Icon: Loader2, spin: true, ...TINT.working } as const;
  }
  // A packaged peer is a state, not an alarm and not a thing in progress: the ambient tint the band
  // already uses, and a still icon. A spinner here would say the run is waiting on that machine.
  if (view.kind === "package-managed") {
    return { Icon: Package, spin: false, ...TINT.working } as const;
  }
  return { Icon: ArrowUpCircle, spin: false, ...TINT.working } as const;
}
