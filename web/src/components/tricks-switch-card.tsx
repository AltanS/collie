import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { ExperimentalBadge } from "@/components/experimental-badge";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useArm, useDisarmOn } from "@/hooks/use-arm";
import { useLocale } from "@/hooks/use-locale";
import { useTricksSwitch } from "@/hooks/use-tricks-switch";
import { useHillTrickCount } from "@/lib/hill/store";
import { t, tn } from "@/lib/i18n";
import { tricksStore, useTricksState, type TricksState } from "@/lib/tricks/store";
import { cn } from "@/lib/utils";

// Settings → Tricks and the Hill, under the Hill's card (moved there from the top of Settings, Tricks and the Hill on 2026-11-18): one card, one
// switch for tricks AS A WHOLE (bridge/tricks/feature-switch.ts). While it is on, the Settings index shows a Tricks row for the list.
// Tricks are an experiment and OFF by default (2026-11-17). Off, no trick runs, none draws a part, and the list
// of Settings, Tricks and the Hill is out of reach (a link to it lands here) and cannot be changed. Each trick keeps its own switch as it was; the big switch never
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
// "THESE START AGAIN" (2026-11-17): while the switch is OFF and tricks exist whose own switch is on, one muted line
// under the contract line names them, so the person knows what a tap on the big switch brings back. At most five
// names, then "and N more". Nothing when the switch is on, when no trick's own switch is on, or when this bridge
// runs no trick (Windows, a crew member). The line is outside the armed slot: it is plain text of the card.
//
// WINDOWS: a Windows bridge runs no trick (the tricks reply says `gate: "windows"`), so the card says so with the
// one existing line and the switch cannot move.

/** The armed note's look: the armed tint of DESIGN.md §4 in a box with the house corner. */
const noteClass = (extra: string): string => cn("rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive", extra);

/** The controller: the bridge's value from the root data, the write through `useTricksSwitch`, the open trick Decisions from the Hill's list. */
export function TricksSwitchControl() {
  const sw = useTricksSwitch();
  const waiting = useHillTrickCount();
  const state = useTricksState(tricksStore);
  const windows = state.gate === "windows";
  return <TricksSwitchCard on={sw.on} disabled={sw.busy || !sw.canWrite} waiting={waiting} windows={windows} startAgain={startAgainNames(state)} onToggle={(next) => void sw.set(next)} />;
}

export interface TricksSwitchCardProps {
  on: boolean;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  /** How many Decisions a trick posted are open, from the list the phone holds. Any of them arms the switch. Default none. */
  waiting?: number;
  /** A Windows bridge: the card says tricks do not run there yet and the switch cannot move. Default false. */
  windows?: boolean;  /** The names of the tricks whose own switch is on. While the big switch is off the card says these start again. Default none. */
  startAgain?: readonly string[];
}

/**
 * The names of the tricks whose own switch is on, in the list's order. A member runs none (its list is the lead's,
 * and a tap on its big switch brings nothing back on this machine), so it names none.
 */
export function startAgainNames(state: Pick<TricksState, "tricks" | "runsOn">): string[] {
  return state.runsOn === undefined ? state.tricks.filter((trick) => trick.on).map((trick) => trick.name) : [];
}

/** The default of {@link TricksSwitchCardProps.startAgain}: one stable list. */
const NO_NAMES: readonly string[] = [];

/** The most names "These start again" lists before "and N more". */
export const START_AGAIN_NAMES_MAX = 5;

/** "These start again: a, b, c, d, e and 2 more." Null when nothing starts again. */
export function startAgainLine(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  const shown = names.slice(0, START_AGAIN_NAMES_MAX).join(", ");
  const rest = names.length - START_AGAIN_NAMES_MAX;
  return t("settings.tricks.switch.starts", { names: rest > 0 ? tn("settings.tricks.switch.andMore", rest, { names: shown }) : shown });
}


/** The card itself, every value handed in, so the playground draws the real markup in each state. */
export function TricksSwitchCard({ on, disabled, onToggle, waiting = 0, windows = false, startAgain = NO_NAMES }: TricksSwitchCardProps) {
  useLocale();
  const { armed, tap, disarm } = useArm<"off">();
  // A position the switch reached by itself leaves no arm behind.
  useDisarmOn(on, disarm);
  const asks = armed === "off";
  const starts = on || windows ? null : startAgainLine(startAgain);
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
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-medium">
              <span className="max-w-full min-w-0 truncate">{t("settings.section.tricks.title")}</span>
              {/* The contract line below already says the whole of the Experiments notice; the badge marks the row. */}
              <ExperimentalBadge />
            </div>
            <p data-line="about" className="text-sm text-muted-foreground">
              {t("settings.tricks.switch.about")}
            </p>
            <p data-line="contract" className="text-sm text-muted-foreground">
              {t("settings.tricks.switch.contract")}
            </p>
            {starts !== null && (
              <p data-line="starts" className="text-sm break-words text-muted-foreground">
                {starts}
              </p>
            )}
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
