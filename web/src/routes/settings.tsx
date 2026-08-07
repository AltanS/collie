import { useEffect, useState } from "react";
import { ArrowLeft, Bell, Loader2 } from "lucide-react";
import { useNavigate, useRouteLoaderData } from "react-router";

import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { ConnectionInfo } from "@/components/connection-info";
import { Card } from "@/components/ui/card";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { SnoozeControl } from "@/components/snooze-control";
import { ThemeControl } from "@/components/theme-control";
import { HapticsControl } from "@/components/haptics-control";
import { UpdateCheckControl } from "@/components/update-check-control";
import { Switch } from "@/components/ui/switch";
import { fetchConfig } from "@/lib/api";
import { usePushControl } from "@/hooks/use-push";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { PushAvailability } from "@/lib/push";

// Settings page — currently just the push-notification toggle. Reachable from the home header gear.
// Lives under the root route, so the snapshot polling/push-setup in RootLayout keeps running behind it.
export function SettingsRoute() {
  const navigate = useNavigate();
  const scope = useScope();
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  // Settings lives under the root route, so the live snapshot (bridge + device auth) is right here.
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData | undefined;
  // The build the bridge reports it's serving — handy in the diagnostics panel alongside the local
  // stamp in the footer. Best-effort: stays undefined if the bridge is unreachable.
  const [serverBuild, setServerBuild] = useState<string | undefined>();
  useEffect(() => {
    let alive = true;
    fetchConfig()
      .then((c) => alive && setServerBuild(c.build))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // "On" = the user hasn't disabled it AND a live subscription exists on this device.
  const on = Boolean(state && !state.userDisabled && state.subscribed);
  const blocked = Boolean(state && state.availability !== "ready");
  // When blocked we can still allow turning OFF a lingering subscription, but never turning ON.
  const toggleDisabled = busy || !state || (blocked && !on);

  async function toggle(next: boolean) {
    setError(null);
    const res = await setEnabled(next);
    if (next && !res.ok) setError(reasonText(res.reason));
  }

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <header className="sticky top-0 z-20 flex items-center gap-2 border-b border-border/60 bg-background/85 px-2 py-2 backdrop-blur-md [padding-top:calc(env(safe-area-inset-top)_+_0.5rem)]">
        <Button
          variant="ghost"
          size="icon"
          // size="icon" is 36px; the header's other controls are 44px since the tap-target pass.
          className="size-11"
          onClick={() => navigate(homePath(scope))}
          aria-label="Back"
        >
          <ArrowLeft className="size-5" />
        </Button>
        <h1 className="text-lg font-semibold tracking-tight">Settings</h1>
      </header>

      <main className="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {/* First: it's the setting people come here to change, and below the notification stack it
            sat off-screen on a phone, a scroll into a 1240px page. */}
        <ThemeControl />

        {/* Device behaviour sits with appearance — both are "how this phone treats you", as opposed
            to the herd/notification settings below. Renders nothing where vibrate is unsupported. */}
        <HapticsControl />

        <Card className="gap-0 py-0">
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <Bell className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-medium">Push notifications</div>
                <p className="text-sm text-muted-foreground">
                  Get a notification when an agent needs you.
                </p>
              </div>
            </div>
            {/* Fixed slot the size of the Switch (h-6 w-11): the spinner is smaller, so without it
                the row — and the whole page under it — resized when state landed. */}
            <div className="flex h-6 w-11 shrink-0 items-center justify-center">
              {state ? (
                <Switch
                  checked={on}
                  disabled={toggleDisabled}
                  onCheckedChange={toggle}
                  aria-label="Push notifications"
                />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>

          {state && blocked && (
            <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
              {availabilityNote(state.availability)}
            </p>
          )}
          {error && (
            <p className="border-t border-border/60 px-4 py-2.5 text-xs text-status-blocked">
              {error}
            </p>
          )}
        </Card>

        {/* Mounted while push state is still UNKNOWN, and only removed once we positively learn the
            bridge has no VAPID keys. Gating on `state` truthiness instead inserted ~400px into the
            middle of the page one frame late, shoving everything below it down. These two are
            bridge-wide settings — which transitions notify, and quiet hours — so they are meaningful
            whatever this particular device's push status turns out to be. */}
        {state?.availability !== "server-off" && (
          <>
            <NotifyPrefsControl />
            <SnoozeControl snoozedUntil={root?.snoozedUntil ?? null} />
          </>
        )}

        {/* On-demand upstream update check (independent of push) — drives the footer UpdateBanner. */}
        <UpdateCheckControl />

        <ConnectionInfo bridge={root?.bridge} device={root?.device} build={serverBuild} />

        {/* Update nudge + build stamp, grouped and pinned to the bottom of the page. */}
        <div className="mt-auto flex flex-col gap-2 pt-4">
          <UpdateBanner />
          <BuildStamp />
        </div>
      </main>
    </div>
  );
}

function reasonText(reason: PushAvailability | undefined): string {
  switch (reason) {
    case "insecure":
      return "Push needs an HTTPS connection.";
    case "server-off":
      return "Push isn't configured on the bridge (no VAPID keys).";
    case "denied":
      return "Notifications are blocked — enable them in your browser settings.";
    case "unsupported":
      return "This browser doesn't support push notifications.";
    default:
      return "Couldn't enable push notifications.";
  }
}

function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return "Unavailable over plain HTTP — serve Collie over HTTPS to enable push.";
    case "server-off":
      return "The bridge has no VAPID keys configured, so push is disabled server-side.";
    case "denied":
      return "Notifications are blocked for this site. Re-enable them in your browser settings.";
    case "unsupported":
      return "This browser doesn't support push notifications.";
    case "ready":
      return "";
  }
}
