import { useState } from "react";
import { BellOff, Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { setSnooze } from "@/lib/api";

// "Do not disturb" for push: a global snooze with quick presets. Server-enforced (the bridge sends
// nothing while a deadline is active and self-resumes), so it quiets every device — for when you're
// heads-down at the desk. State rides the snapshot (`snoozedUntil`), so it stays in sync across
// devices; after a change we revalidate to pull the new deadline straight back in.

const PRESETS: ReadonlyArray<{ labelKey: MessageKey; minutes: number }> = [
  { labelKey: "settings.snooze.preset.min30", minutes: 30 },
  { labelKey: "settings.snooze.preset.hour1", minutes: 60 },
  { labelKey: "settings.snooze.preset.hour4", minutes: 240 },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SnoozeControl({ snoozedUntil }: { snoozedUntil: number | null }) {
  useLocale();
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState(false);
  const snoozed = snoozedUntil !== null && snoozedUntil > Date.now();

  async function apply(next: number | null) {
    setBusy(true);
    try {
      await setSnooze(next);
      revalidator.revalidate();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellOff className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.snooze.title")}</div>
            <p className="text-sm text-muted-foreground">
              {snoozed
                ? t("settings.snooze.description.active", { time: formatTime(snoozedUntil) })
                : t("settings.snooze.description.idle")}
            </p>
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      <div className="flex items-center gap-2 border-t border-border p-3">
        {snoozed ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => apply(null)}>
            {t("settings.snooze.resume")}
          </Button>
        ) : (
          PRESETS.map((p) => (
            <Button
              key={p.labelKey}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => apply(Date.now() + p.minutes * 60_000)}
            >
              {t(p.labelKey)}
            </Button>
          ))
        )}
      </div>
    </Card>
  );
}
