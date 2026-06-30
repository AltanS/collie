import { useState } from "react";
import { BellOff, Loader2 } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { setSnooze } from "@/lib/api";

// "Do not disturb" for push: a global snooze with quick presets. Server-enforced (the bridge sends
// nothing while a deadline is active and self-resumes), so it quiets every device — for when you're
// heads-down at the desk. State rides the snapshot (`snoozedUntil`), so it stays in sync across
// devices; after a change we revalidate to pull the new deadline straight back in.

const PRESETS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "4h", minutes: 240 },
];

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SnoozeControl({ snoozedUntil }: { snoozedUntil: number | null }) {
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
            <div className="font-medium">Do not disturb</div>
            <p className="text-sm text-muted-foreground">
              {snoozed
                ? `Snoozed until ${formatTime(snoozedUntil)} — no pushes until then.`
                : "Pause all push notifications for a while."}
            </p>
          </div>
        </div>
        {busy && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      <div className="flex items-center gap-2 border-t border-border/60 p-3">
        {snoozed ? (
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => apply(null)}>
            Resume now
          </Button>
        ) : (
          PRESETS.map((p) => (
            <Button
              key={p.label}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => apply(Date.now() + p.minutes * 60_000)}
            >
              {p.label}
            </Button>
          ))
        )}
      </div>
    </Card>
  );
}
