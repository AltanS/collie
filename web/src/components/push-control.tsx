import { useState } from "react";
import { Bell, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { usePushControl } from "@/hooks/use-push";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { availabilityNote, reasonText } from "@/lib/push-copy";
import { describeThrownError } from "@/lib/api-error-message";

// The push-notification switch. Lifted out of the Settings route unchanged when Settings became an
// index of four pages: the row belongs to Alerts, and a page cannot mount sixty lines that live in
// another route's file.
//
// `availability` is the browser's answer, not ours, so the row stays mounted and explains itself
// rather than disappearing: a switch that is missing teaches nothing about why push is off.
export function PushControl() {
  useLocale();
  const { state, busy, setEnabled } = usePushControl();
  const [error, setError] = useState<string | null>(null);

  // "On" = the user hasn't disabled it AND a live subscription exists on this device.
  const on = Boolean(state && !state.userDisabled && state.subscribed);
  const blocked = Boolean(state && state.availability !== "ready");
  // Capability/permission refusals block enabling; a failed config read must remain retryable.
  const toggleDisabled = busy || !state || (blocked && !on && state.availability !== "unavailable");

  async function toggle(next: boolean) {
    setError(null);
    try {
      const res = await setEnabled(next);
      if (next && !res.ok) setError(reasonText(res.reason));
    } catch (err) {
      setError(describeThrownError(err));
    }
  }

  return (
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
        <p role="alert" className="border-t border-border px-4 py-2.5 text-xs text-status-blocked">
          {error}
        </p>
      )}
    </Card>
  );
}

/** Whether this bridge has push at all. Alerts hides the bridge-wide rows when it does not. */
export function usePushAvailability(): string | undefined {
  const { state } = usePushControl();
  return state?.availability;
}
