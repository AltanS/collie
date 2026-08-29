import { Maximize2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setZenEnabled, useZenEnabled } from "@/lib/zen";

// Zen mode's availability gate, next to Haptics: both are "how this phone treats you". The pane
// header hosts zen's ENTRY, but not this — a persisted per-device capability toggle is not a
// rendering pref, and it is not something you reach for mid-session. Default off, so the extra
// header button only appears for people who asked for it.
export function ZenControl() {
  const enabled = useZenEnabled();

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Maximize2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">Zen mode</div>
            <p className="text-sm text-muted-foreground">
              Adds a button to the pane header that hides everything but the terminal.
            </p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch checked={enabled} onCheckedChange={setZenEnabled} aria-label="Zen mode" />
        </div>
      </div>
    </Card>
  );
}
