import { useEffect, useState } from "react";
import { ArrowLeft, Bell, Loader2 } from "lucide-react";
import { useLoaderData, useNavigate } from "react-router";

import { RouteHeader } from "@/components/app-header";
import { Button } from "@/components/ui/button";
import { BuildStamp } from "@/components/build-stamp";
import { UpdateBanner } from "@/components/update-banner";
import { ConnectionInfo } from "@/components/connection-info";
import { Card } from "@/components/ui/card";
import { NotifyPrefsControl } from "@/components/notify-prefs-control";
import { PairedDevices } from "@/components/paired-devices";
import { PackSettingsCard } from "@/components/pack-settings-card";
import { SnoozeControl } from "@/components/snooze-control";
import { ThemeControl } from "@/components/theme-control";
import { HapticsControl } from "@/components/haptics-control";
import { HandsFreeControl } from "@/components/hands-free-control";
import { LanguageControl } from "@/components/language-control";
import { FontSettingsControl } from "@/components/font-settings";
import { UpdateCheckControl } from "@/components/update-check-control";
import { Switch } from "@/components/ui/switch";
import { fetchConfig } from "@/lib/api";
import { usePushControl } from "@/hooks/use-push";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { type DevicesData } from "@/lib/loaders";
import { homePath } from "@/lib/nav";
import { useScope } from "@/lib/session";
import type { PushAvailability } from "@/lib/push";
import { useOptionalRootData } from "@/lib/route-data";

const EMPTY_DEVICES: DevicesData = { enforced: false, current: null, devices: [], error: false };

// Settings page — currently just the push-notification toggle. Reachable from the home header gear.
// Lives under the root route, so the snapshot polling/push-setup in RootLayout keeps running behind it.
export function SettingsRoute() {
  const navigate = useNavigate();
  const scope = useScope();
  useLocale();
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  const root = useOptionalRootData();
  // This route's OWN loader: the paired-device registry (lib/loaders.ts devicesLoader).
  // Defaulted rather than asserted: a harness that mounts this route without the loader (or a
  // navigation whose loader threw) must still render the rest of Settings, not crash the page.
  // SAFETY: `devicesLoader` returns `DevicesData` for this route; `undefined` is the case the
  // default below exists for. React Router types a data-mode `useLoaderData()` as `unknown`.
  const devices = (useLoaderData() as DevicesData | undefined) ?? EMPTY_DEVICES;
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
      {/* One header treatment app-wide — and now that is a FACT, not a claim: this route does not
          mount a header at all, it fills the one that is already there (RootLayout's
          <AppHeaderHost/>). It used to be a hand-rolled `<header>` that only
          copied the shell's colours, and it drifted the two ways a copy always does. It carried no
          <AlphaBar/>, so walking into Settings off a prerelease build silently dropped the "you are
          on a beta" strip; and its padding recipe was its own, so it could not track the shell's.
          The row's CONTENT is this route's own — a back button where the mark stands, and the page
          title — which is exactly what `override` is for (the pane's find bar is the other user).
          The back button is `size-11` sitting at the row's `pl-4`, so its icon centre lands on the
          same 38px as the Collie mark it stands in for: nothing shifts sideways either. */}
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px — the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11"
              onClick={() => navigate(homePath(scope))}
              aria-label={t("settings.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <h1 className="min-w-0 truncate text-lg font-semibold tracking-tight">{t("settings.title")}</h1>
          </>
        }
      />

      {/* `relative` for the same reason PullToRefresh carries it: an `sr-only` (position: absolute)
          deep in this page would otherwise escape the scroller and grow the document's own
          scrollbar. */}
      <main className="relative flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-4">
        {/* First: it's the setting people come here to change, and below the notification stack it
            sat off-screen on a phone, a scroll into a 1240px page. */}
        <ThemeControl />

        {/* Language sits right beside appearance — both are "how this phone presents itself" — and
            ahead of device behaviour, which is more of a per-device tweak than a standing choice. */}
        <LanguageControl />

        {/* Fonts sits with appearance, immediately under Language: all three are "how this phone
            presents itself". It configures the TERMINAL font only — the app's own typeface is the
            maker's choice and has no setting (round-4 F-D1). */}
        <FontSettingsControl />

        {/* Device behaviour sits with appearance — both are "how this phone treats you", as opposed
            to the herd/notification settings below. Renders nothing where vibrate is unsupported. */}
        <HapticsControl />

        {/* Voice, when this collie has any: also "how this phone treats you", and it belongs beside
            haptics rather than with the herd settings below. Renders nothing where no provider is
            configured or the browser cannot record. */}
        <HandsFreeControl />

        <Card className="gap-0 py-0">
          <div className="flex items-center justify-between gap-4 p-4">
            <div className="flex min-w-0 items-start gap-3">
              <Bell className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <div className="font-medium">{t("settings.push.title")}</div>
                <p className="text-sm text-muted-foreground">{t("settings.push.description")}</p>
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
                  aria-label={t("settings.push.title")}
                />
              ) : (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>

          {state && blocked && (
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {availabilityNote(state.availability)}
            </p>
          )}
          {error && (
            <p className="border-t border-border px-4 py-2.5 text-xs text-status-blocked">
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

        {/* Access sits with the connection diagnostics — both answer "what is this device allowed
            to do, and why". Pairing is the gate you can change from here; ConnectionInfo below only
            reports the header-based one. */}
        <PairedDevices data={devices} />

        {/* The pack census, immediately above the connection diagnostics: both answer "what is this
            thing talking to, and is it well". Renders NOTHING on a solo install — the card owns that
            gate itself (usePack().multi), so this page needs no pack-shaped conditional. */}
        <PackSettingsCard />

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
      return t("settings.push.reason.insecure");
    case "server-off":
      return t("settings.push.reason.serverOff");
    case "denied":
      return t("settings.push.reason.denied");
    case "unsupported":
      return t("settings.push.reason.unsupported");
    default:
      return t("settings.push.reason.default");
  }
}

function availabilityNote(a: PushAvailability): string {
  switch (a) {
    case "insecure":
      return t("settings.push.availability.insecure");
    case "server-off":
      return t("settings.push.availability.serverOff");
    case "denied":
      return t("settings.push.availability.denied");
    case "unsupported":
      return t("settings.push.availability.unsupported");
    case "ready":
      return "";
  }
}
