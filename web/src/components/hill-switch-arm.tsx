import { useEffect, useState } from "react";

import { useArm, useDisarmOn } from "@/hooks/use-arm";
import { useHillSwitch } from "@/hooks/use-hill-switch";
import { useLocale } from "@/hooks/use-locale";
import { useHillCount } from "@/lib/hill/store";
import { tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE HILL'S SWITCH, THE PART THE ROW AND THE DETAILS HEAD SHARE (bridge/hill/switch.ts). The Hill is an experiment
// and OFF by default (2026-11-13); the switch turns it on. Off, agents and tricks cannot post and the Hill
// leaves the bar; the open Decisions stay on the bridge and come back when it is on again. The switch has two
// places in Settings, Tricks: the Hill's row in the trick list (components/hill-row.tsx) and the head of the
// Hill's details page (components/hill-page.tsx). Both read the value from the snapshot and write it through
// `useHillSwitch`, so they agree on every phone.
//
// THE ARMED SECOND TAP. Off blocks every answer: the Decisions that wait (an agent's, a trick's or Collie's own)
// stay open and cannot be answered meanwhile. So a first tap on the switch while ANY Decision is open ARMS it
// (`useArm`, the shared window and dwell): the switch stays on, and a note says how many questions wait. A second
// tap inside the window switches off. With no Decision open, a tap switches at once. Turning on never asks.
//
// WHERE THE NOTE GOES (2026-11-22). Nothing may move under the thumb between the two taps (DESIGN.md §2), and a list row
// must not carry a blank slot. So the two places differ:
//   - ON THE ROW (components/hill-row.tsx) the note takes the place of the row's text block while armed. The text and the
//     note are two layers of ONE grid cell (`HillTextCell`): the cell is as tall as the taller one, so the row never changes
//     height and its switch never moves. Unarmed, the note's layer is `invisible` and `aria-hidden`; armed, the text's layer is.
//     The note's layer exists from the moment a question waits and stays until the row unmounts (switching off empties the
//     list the phone holds, and a row that shrank then would pull the page up under the thumb). With no question
//     waiting only the text exists.
//   - ON THE DETAILS HEAD (components/hill-page.tsx) the note sits BELOW the switch, so the switch cannot move: the note is
//     drawn only while armed (`HillArmedNote`), and what is below moves down by its height.

/** The armed note's look: the armed tint of DESIGN.md §4 in a box with the house corner. */
const noteClass = (extra: string): string => cn("rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive", extra);

/** What a place that draws the Hill's switch needs: the position, whether it is disabled, the open count and the write. */
export interface HillSwitchValue {
  on: boolean;
  disabled: boolean;
  /** How many Decisions are open, from the list the phone holds. Any of them arms the switch. */
  waiting: number;
  onToggle: (next: boolean) => void;
}

/** The bridge's value from the root data, the write through `useHillSwitch`, the open count from the list. */
export function useHillSwitchValue(): HillSwitchValue {
  const sw = useHillSwitch();
  const waiting = useHillCount();
  return { on: sw.on, disabled: sw.busy || !sw.canWrite, waiting, onToggle: (next) => void sw.set(next) };
}

export interface HillSwitchArm {
  /** The switch's `onCheckedChange`: a turn on goes through, a turn off with a Decision open arms first. */
  flip: (next: boolean) => void;
  /** The note shows now: the first tap armed the switch. */
  asks: boolean;
  /** The row keeps the note's layer, from the moment a question waits until it unmounts. */
  reserved: boolean;
}

/** The armed second tap of the Hill's switch. Every value handed in, so the row, the head and the playground draw one rule. */
export function useHillSwitchArm({ on, waiting, onToggle }: Pick<HillSwitchValue, "on" | "waiting" | "onToggle">): HillSwitchArm {
  const { armed, tap, disarm } = useArm<"off">();
  // A position the switch reached by itself leaves no arm behind.
  useDisarmOn(on, disarm);
  // The slot of the armed note: reserved once a question waits, and kept while the control is drawn.
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

  return { flip, asks: armed === "off", reserved };
}

/** The note's words and role, in the armed look. `className` places it (a margin on the head, a grid layer on the row). */
export function HillArmedNote({ waiting, className, hidden = false }: { waiting: number; className?: string; hidden?: boolean }) {
  useLocale();
  return (
    <p data-line="armed" role="status" aria-hidden={hidden || undefined} className={noteClass(cn(hidden && "invisible", className))}>
      {tn("settings.tricks.hill.waits", waiting)}
    </p>
  );
}
