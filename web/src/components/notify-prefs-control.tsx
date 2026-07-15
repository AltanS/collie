import { BellRing, Loader2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useNotifyPrefs } from "@/hooks/use-notify-prefs";
import type { NotifyPrefs } from "@/lib/api";

// Which lifecycle events are worth a push. Bridge-wide (fans out to every device, like the snooze),
// so the copy says so. Three switches: "Needs input" (blocked, default on), "Finished" (done,
// default off), and "App updates" (updates, default on). Optimistic toggle with revert on failure —
// see useNotifyPrefs.

const ROWS: ReadonlyArray<{ key: keyof NotifyPrefs; label: string; hint: string }> = [
  { key: "blocked", label: "Needs input", hint: "an agent is waiting on you" },
  { key: "done", label: "Finished", hint: "an agent completes its task" },
  { key: "updates", label: "App updates", hint: "a new Collie version is available" },
];

export function NotifyPrefsControl() {
  const { prefs, busy, toggle } = useNotifyPrefs();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BellRing className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Notify when</div>
            <p className="text-sm text-muted-foreground">Applies to all devices.</p>
          </div>
        </div>
        {!prefs && <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />}
      </div>

      {prefs &&
        ROWS.map((row) => (
          <div
            key={row.key}
            className="flex items-center justify-between gap-4 border-t border-border/60 px-4 py-3"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium">{row.label}</div>
              <p className="text-xs text-muted-foreground">{row.hint}</p>
            </div>
            <Switch
              checked={prefs[row.key]}
              disabled={busy}
              onCheckedChange={(next) => void toggle(row.key, next)}
              aria-label={row.label}
            />
          </div>
        ))}
    </Card>
  );
}
