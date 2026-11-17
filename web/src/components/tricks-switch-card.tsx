import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useArm } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { useTricksSwitch } from "@/hooks/use-tricks-switch";
import { useHillTrickCount } from "@/lib/hill/store";
import { t, tn } from "@/lib/i18n";
import { tricksStore, useTricksState } from "@/lib/tricks/store";
import { cn } from "@/lib/utils";

// Settings → Tricks, first on the page: one card, one switch for tricks AS A WHOLE (bridge/tricks/feature-switch.ts).
// Tricks are an experiment and OFF by default (2026-11-17). Off, no trick runs, none draws a part, and the list
// below stays readable but cannot be changed. Each trick keeps its own switch as it was; the big switch never
// moves them. The value rides on the snapshot (`tricksOff`), so the card is drawn from the first frame with no
// reading of its own, and it always renders: it does not wait for the tricks reply.
//
// THE ARMED SECOND TAP, as on the Hill's card (components/hill-switch-card.tsx). Off hides the Decisions that
// tricks posted: they stay stored and come back when tricks are on, but cannot be answered meanwhile. So a first
// tap off while ANY trick Decision is open ARMS the switch (`useArm`, the shared window and dwell): it stays on,
// and a note says how many questions wait. A second tap inside the window switches off. With none open, a tap
// switches at once. Turning on never asks. The note has a RESERVED SLOT (DESIGN.md §2): an invisible copy of the
// words holds the height from the moment the card knows a question waits, and the slot stays while the card is
// on screen, because switching off empties the list the phone holds and a card that shrank then would pull the
// page up under the thumb.
//
// WINDOWS: a Windows bridge runs no trick (the tricks reply says `gate: "windows"`), so the card says so with the
// one existing line and the switch cannot move.

/** The armed note's look: the armed tint of DESIGN.md §4 in a box with the house corner. */
const noteClass = (extra: string): string => cn("rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive", extra);

/** The controller: the bridge's value from the root data, the write through `useTricksSwitch`, the open trick Decisions from the Hill's list. */
export function TricksSwitchControl() {
  const sw = useTricksSwitch();
  const waiting = useHillTrickCount();
  const windows = useTricksState(tricksStore).gate === "windows";
  return <TricksSwitchCard on={sw.on} disabled={sw.busy || !sw.canWrite} waiting={waiting} windows={windows} onToggle={(next) => void sw.set(next)} />;
}

export interface TricksSwitchCardProps {
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  /** How many Decisions a trick posted are open, from the list the phone holds. Any of them arms the switch. Default none. */
  waiting?: number;
  /** A Windows bridge: the card says tricks do not run there yet and the switch cannot move. Default false. */
  windows?: boolean;
}

/** The card itself, every value handed in, so the playground draws the real markup in each state. */
export function TricksSwitchCard({ on, disabled, onToggle, waiting = 0, windows = false }: TricksSwitchCardProps) {
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
    // Off hides every trick Decision, so any open one arms it; with none waiting the switch goes at once.
    if (waiting === 0) {
      onToggle(false);
      return;
    }
    if (tap("off") === "fire") onToggle(false);
  }

  return (
    <Card className="gap-0 py-0" data-slot="tricks-switch">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="mods" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">
              <span className="block max-w-full min-w-0 truncate">{t("settings.section.tricks.title")}</span>
            </div>
            <p data-line="about" className="text-sm text-muted-foreground">
              {t("settings.tricks.switch.about")}
            </p>
            <p data-line="contract" className="text-sm text-muted-foreground">
              {t("settings.tricks.switch.contract")}
            </p>
            {windows && (
              <p data-line="windows" className="text-sm text-muted-foreground">
                {t("settings.tricks.windows")}
              </p>
            )}
          </div>
        </div>
        <Switch checked={on} disabled={disabled || windows} onCheckedChange={flip} aria-label={t("settings.section.tricks.title")} />
      </div>
      {reserved && (
        <div data-slot="armed-slot" className="relative mx-4 mb-4">
          {/* The ghost sets the slot's height with the words themselves; the real note sits over it. */}
          <p aria-hidden className={noteClass("invisible")}>
            {tn("settings.tricks.switch.waits", waiting)}
          </p>
          {asks && (
            <p data-line="armed" role="status" className={noteClass("absolute inset-0")}>
              {tn("settings.tricks.switch.waits", waiting)}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
