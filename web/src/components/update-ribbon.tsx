import { useEffect, useState, useSyncExternalStore } from "react";
import { ArrowUpCircle, Loader2, TriangleAlert, X } from "lucide-react";
import { useNavigate } from "react-router";

import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { updatesPath } from "@/lib/nav";
import { checkForUpdate } from "@/lib/pwa";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { useSelfUpdate } from "@/lib/self-update";
import {
  clearUpdateStarted,
  getUpdateStarted,
  ribbonText,
  ribbonView,
  subscribeUpdateStarted,
  type RibbonView,
} from "@/lib/update-ribbon";
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

/** Where the dismissal of an OFFER is remembered. Keyed by the version, so a newer release is a
 *  different fact and brings the band back. Bare string, like every other small pin in this app. */
const DISMISS_KEY = "collie:update-dismissed:v1";

function readDismissed(): string | null {
  try {
    return globalThis.localStorage?.getItem(DISMISS_KEY) ?? null;
  } catch {
    return null; // storage disabled (private mode) — the offer simply keeps showing
  }
}

function writeDismissed(version: string): void {
  try {
    globalThis.localStorage?.setItem(DISMISS_KEY, version);
  } catch {
    /* storage disabled — the dismissal holds for this session through the state below */
  }
}

/** Test seam: forget the dismissal. */
export function __resetUpdateRibbon(): void {
  try {
    globalThis.localStorage?.removeItem(DISMISS_KEY);
  } catch {
    /* nothing stored, nothing to forget */
  }
}

export function UpdateRibbon() {
  useLocale();
  const navigate = useNavigate();
  const scope = useScope();
  const data = useOptionalRootData();
  // The self-updater's own flag. Reading it here is also what MOUNTS the controller — see the header.
  const bundleStale = useSelfUpdate();
  const startedAt = useSyncExternalStore(subscribeUpdateStarted, getUpdateStarted, getUpdateStarted);
  const [dismissed, setDismissed] = useState(readDismissed);

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
    dismissedVersion: dismissed,
    now: Date.now(),
  });
  if (view.kind === "silent") return null;

  const skin = skinOf(view);
  // Only the offer is dismissable. The other four describe something that is happening, and a
  // dismissed run is a run the operator can no longer see the end of.
  const dismissable = view.kind === "available";

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
      {dismissable && (
        <button
          type="button"
          aria-label={t("updateRibbon.dismiss")}
          className="shrink-0 text-muted-foreground"
          onClick={() => {
            const version = view.kind === "available" ? view.version : "";
            writeDismissed(version);
            setDismissed(version);
          }}
        >
          <X className="size-3.5" />
        </button>
      )}
    </div>
  );
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
  return { Icon: ArrowUpCircle, spin: false, ...TINT.working } as const;
}
