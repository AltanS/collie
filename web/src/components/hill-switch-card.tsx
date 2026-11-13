import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { FeatureTokenChip } from "@/components/token-use-label";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useArm } from "@/hooks/use-arm";
import { useHillSwitch } from "@/hooks/use-hill-switch";
import { useLocale } from "@/hooks/use-locale";
import { useHillCount } from "@/lib/hill/store";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// Settings → Experiments → The Hill: one row, one switch (bridge/hill/switch.ts). The Hill is an experiment
// and OFF by default (2026-11-13); the switch turns it on. Off, agents and tricks cannot post and the Hill
// leaves the bar; the open Decisions stay on the bridge and come back when it is on again. It is the one
// place the switch lives: it is no longer on Settings, Alerts, and the Hill's row and About sheet left
// Settings, Tricks. The value rides on the snapshot, so the row is drawn from the first frame with no
// reading of its own.
//
// THE ARMED SECOND TAP (moved here from the Tricks card's About sheet). Off blocks every answer: the Decisions
// that wait (an agent's, a trick's or Collie's own) stay open and cannot be answered meanwhile. So a first tap
// on the switch while ANY Decision is open ARMS it (`useArm`, the shared window and dwell): the switch stays
// on, and a note says how many questions wait. A second tap inside the window switches off. With no Decision
// open, a tap switches at once. Turning on never asks. The note has a RESERVED SLOT under the row (DESIGN.md
// §2): an invisible copy of the words holds the height from the moment the card knows a question waits, and
// the slot stays while the card is on screen (switching off empties the list the phone holds, and a card that
// shrank then would pull the page up under the thumb).

/** The armed note's look: the armed tint of DESIGN.md §4 in a box with the house corner. */
const noteClass = (extra: string): string => cn("rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive", extra);

/** The controller: the bridge's value from the root data, the write through `useHillSwitch`, the open count from the list. */
export function HillSwitchControl() {
  const sw = useHillSwitch();
  const waiting = useHillCount();
  return <HillSwitchCard on={sw.on} disabled={sw.busy || !sw.canWrite} waiting={waiting} onToggle={(next) => void sw.set(next)} />;
}

export interface HillSwitchCardProps {
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  /** How many Decisions are open, from the list the phone holds. Any of them arms the switch. Default none. */
  waiting?: number;
}

/** The row itself, every value handed in, so the playground draws the real markup in each state. */
export function HillSwitchCard({ on, disabled, onToggle, waiting = 0 }: HillSwitchCardProps) {
  useLocale();
  const { armed, tap, disarm } = useArm<"off">();
  // A position the switch reached by itself leaves no arm behind.
  useEffect(() => disarm(), [on, disarm]);
  const asks = armed === "off";
  // The slot of the armed note: reserved once a question waits, and kept while the card is drawn.
  const [reserved, setReserved] = useState(on && waiting > 0);
  useEffect(() => {
    if (on && waiting > 0) setReserved(true);
  }, [on, waiting]);

  function flip(next: boolean): void {
    if (next) {
      onToggle(true);
      return;
    }
    // Off blocks every answer, so any open Decision arms it; with none waiting the switch goes at once.
    if (waiting === 0) {
      onToggle(false);
      return;
    }
    if (tap("off") === "fire") onToggle(false);
  }

  return (
    <Card className="gap-0 py-0" data-slot="hill-switch">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="hill" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            {/* The chip follows the label while it fits, else on a line of its own: the label is never cut for it. */}
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium">
              <span className="max-w-full min-w-0 truncate">{t("settings.hill.label")}</span>
              <FeatureTokenChip feature="hill" />
            </div>
            <p className="text-sm text-muted-foreground">{t("settings.hill.hint")}</p>
          </div>
        </div>
        <Switch checked={on} disabled={disabled} onCheckedChange={flip} aria-label={t("settings.hill.label")} />
      </div>
      {reserved && (
        <div data-slot="armed-slot" className="relative mx-4 mb-4">
          {/* The ghost sets the slot's height with the words themselves; the real note sits over it. */}
          <p aria-hidden className={noteClass("invisible")}>
            {tn("settings.tricks.hill.waits", waiting)}
          </p>
          {asks && (
            <p data-line="armed" role="status" className={noteClass("absolute inset-0")}>
              {tn("settings.tricks.hill.waits", waiting)}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
