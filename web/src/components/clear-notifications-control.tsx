import { useState } from "react";
import { Icon } from "@/components/icons/icon";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Notice, type NoticeTone } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { clearNotifications } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { clearDeviceNotifications, type DeviceCleanup } from "@/lib/clear-notifications";
import { mutate } from "@/lib/mutate";
import { cn } from "@/lib/utils";

// Clear all: what opening every pane does, in one tap. The bridge marks every pane seen and retracts
// every finished alert; this device then closes its own notifications and zeroes the cleared slots of
// its icon count (lib/clear-notifications.ts). Other devices follow when the bridge's clear reaches
// them or Collie is next opened there. An agent still blocked on you stays blocked on the dashboard.
// It sits beside the snooze because both act on the whole bridge; after it we revalidate, so the
// dashboard's finished dots are gone on arrival.
//
// THE OUTCOME IS SAID IN THE CARD (DESIGN.md §11, a contextual notice). The Settings page mounts no
// floating status, and what was cleared is not on this page (the banners were in the system tray, the
// dots are on the dashboard), so the card is the only place the operator can learn that it happened,
// or that it did not and why. It is a `Notice` box under the button, opened by `Collapse` (§11's two
// hard rules), so a long line wraps below the button and never moves it, and the button's word never
// changes, so nothing resizes it. The last outcome stays while a retry runs.

/** What the last tap came to, said under the button until the next one ends. */
type Outcome =
  | { kind: "cleared" }
  /** The bridge cleared, but this device refused to close its notifications, or to zero its count. */
  | { kind: "partial"; device: DeviceCleanup }
  | { kind: "failed"; reason: string };

/** A cleanup that could not even say what it did: both halves count as refused. */
const UNKNOWN_CLEANUP: DeviceCleanup = { notifications: "failed", countStore: "failed" };

/** Which half of this device's clear was refused, said as exactly that. */
function partialKey(device: DeviceCleanup): MessageKey {
  const notifications = device.notifications === "failed";
  const store = device.countStore === "failed";
  if (notifications && store) return "settings.clearNotifications.failed.both";
  return notifications ? "settings.clearNotifications.failed.notifications" : "settings.clearNotifications.failed.badge";
}

function words(outcome: Outcome): string {
  if (outcome.kind === "cleared") return t("settings.clearNotifications.done");
  if (outcome.kind === "partial") return t(partialKey(outcome.device));
  return outcome.reason;
}

const TONE = { cleared: "success", partial: "caution", failed: "danger" } as const satisfies Record<Outcome["kind"], NoticeTone>;

export function ClearNotificationsControl() {
  useLocale();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // A refusal is told here, not twice: `ownError` keeps `mutate` off the floating channel. A refused
  // request touches nothing on this device, so what it shows still matches what the bridge holds.
  // Once the bridge has cleared, the control settles whatever this device's half does, an unexpected
  // throw included: the button comes back, the outcome is said, and the snapshot is read again.
  async function clear() {
    setBusy(true);
    try {
      const res = await mutate(() => clearNotifications(), { ownError: true });
      if (!res.ok) {
        setOutcome({ kind: "failed", reason: describeThrownError(res.error) });
        return;
      }
      let device = UNKNOWN_CLEANUP;
      try {
        device = await clearDeviceNotifications(res.value.clearedSlots);
      } finally {
        const refused = device.notifications === "failed" || device.countStore === "failed";
        setOutcome(refused ? { kind: "partial", device } : { kind: "cleared" });
        revalidator.revalidate();
      }
    } catch {
      // `clearDeviceNotifications` never throws; this is the last word if a future edit makes it.
    } finally {
      setBusy(false);
    }
  }

  const said = busy ? t("settings.clearNotifications.clearing") : outcome === null ? "" : words(outcome);
  return (
    <Card className="gap-0 py-0">
      <div className="flex min-w-0 items-start gap-3 p-4">
        <Icon name="notifications" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.clearNotifications.title")}</div>
          <p className="text-sm text-muted-foreground">{t("settings.clearNotifications.description")}</p>
        </div>
      </div>

      <div className="flex min-h-11 items-center gap-3 border-t border-border px-3 py-1">
        {/* 44px tall (DESIGN.md §6): `sm` keeps the outline face, `h-11` buys the tap floor. Its word
            never changes; the spinner after it has its slot whether it turns or not (§2). */}
        <Button variant="outline" size="sm" className="h-11 shrink-0" disabled={busy} aria-busy={busy} onClick={() => void clear()}>
          {t("settings.clearNotifications.action")}
        </Button>
        <Icon
          name="busy"
          aria-hidden
          className={cn("size-4 shrink-0 text-muted-foreground", busy ? "motion-safe:animate-spin" : "invisible")}
        />
      </div>
      <Collapse open={outcome !== null}>
        {outcome !== null && (
          <div className="px-3 pb-3">
            <Notice variant="box" tone={TONE[outcome.kind]}>
              {words(outcome)}
            </Notice>
          </div>
        )}
      </Collapse>
      {/* The outcome, for a screen reader: one live line, always mounted, never seen. */}
      <p role="status" className="sr-only">
        {said}
      </p>
    </Card>
  );
}
