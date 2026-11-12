import { useEffect, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { Badge } from "@/components/ui/badge";
import { BottomSheet } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { useArm } from "@/hooks/use-arm";
import { useHillSwitch } from "@/hooks/use-hill-switch";
import { useLocale } from "@/hooks/use-locale";
import { useHillCount } from "@/lib/hill/store";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE HILL, SHOWN AS A BUILT-IN ENTRY of Settings → Tricks (2026-11-11). The Hill is Collie's own screen, not a
// trick, but a person reads it as the first trick: one row at the top of the card, and a tap opens an
// About sheet with its one switch. The entry holds NO value of its own. The switch is the Hill's switch
// (bridge/hill/switch.ts), through the same hook as Settings → Alerts (`useHillSwitch`), so the two controls
// read one value from the snapshot and agree. The entry never closes, withdraws or moves a Decision, never
// touches a proposal and never switches a trick: it writes the switch and nothing else.
//
// THE ROW is the trick row's shape without a switch, a version line or a Remove: the Hill's mountain, the
// name with the app's "this row opens another screen" chevron, one description line, and the quiet "Built in"
// badge where a trick shows where it came from. The whole row is the button, a 44px floor.
//
// THE ARMED SECOND TAP. Off blocks every answer: the Decisions that wait (an agent's, a trick's or Collie's own)
// stay open and cannot be answered meanwhile. So a first tap on the switch while ANY Decision is open ARMS it
// (`useArm`, the shared window and dwell): the switch stays on, and a note says how many questions wait. A
// second tap inside the window switches off. With no Decision open, a tap switches at once. Turning on never
// asks. The note has a RESERVED SLOT under the switch (DESIGN.md §2): the sheet is anchored to the bottom, so a
// note that grew in would lift the switch away from the thumb between the two taps. An invisible copy of the
// words holds the height from the moment the sheet knows a question waits, and the slot stays until the sheet
// closes (switching off empties the list the phone holds, and a sheet that shrank then would drop the switch
// the same way).
//
// A CREW MEMBER draws no entry: the Hill lives on the lead (the member's own route answers 400, and its
// snapshot carries no hill), as the card already says that tricks run on the lead (`runsOn`).

/** The row at the top of the Tricks card. */
export function HillEntryRow({ onAbout }: { onAbout: () => void }) {
  useLocale();
  return (
    <div data-slot="hill-entry" className="px-4 py-3">
      <button
        type="button"
        data-slot="hill-about"
        aria-label={t("settings.tricks.about.open", { name: t("settings.tricks.hill.name") })}
        aria-haspopup="dialog"
        onClick={onAbout}
        // The row's own 44px floor: the text block is taller than that already, the button fills the row.
        className="flex min-h-11 w-full items-start gap-3 text-left"
      >
        <Icon name="hill" className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1 font-medium">
            <span className="min-w-0 truncate">{t("settings.tricks.hill.name")}</span>
            <Icon name="row-go" className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </span>
          <span data-line="description" className="line-clamp-2 block break-words text-sm text-muted-foreground">
            {t("settings.tricks.hill.description")}
          </span>
          {/* Where a trick shows its origin. A 16px box on a 20px line, as the Experimental badge. */}
          <Badge variant="outline" data-slot="hill-badge" className="mt-1 h-4 px-1 py-0 text-[11px] leading-none text-muted-foreground">
            {t("settings.tricks.hill.badge")}
          </Badge>
        </span>
      </button>
    </div>
  );
}

/** The armed note's look: the armed tint of DESIGN.md §4 in a box with the house corner. */
const noteClass = (extra: string): string => cn("rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm break-words text-destructive", extra);

export interface HillAboutSheetProps {
  open: boolean;
  onClose: () => void;
  /** The Hill's switch as the bridge says it, or as the last tap asked while the snapshot catches up. */
  on: boolean;
  /** This device may write, and no write is in flight. */
  canSet: boolean;
  /** How many Decisions are open, from the list the phone holds. Any of them arms the switch. */
  waiting: number;
  /** The write. The sheet never writes anything else. */
  onSet: (on: boolean) => void;
}

/** The Hill's About sheet, every value handed in, so the playground draws the real markup in each state. */
export function HillAboutSheet({ open, onClose, on, canSet, waiting, onSet }: HillAboutSheetProps) {
  useLocale();
  const { armed, tap, disarm } = useArm<"off">();
  // A position the switch reached by itself, or a sheet that closed, leaves no arm behind.
  useEffect(() => disarm(), [on, open, disarm]);
  const asks = armed === "off";
  // The slot of the armed note: reserved once a question waits, and kept while the sheet is open.
  const [reserved, setReserved] = useState(on && waiting > 0);
  useEffect(() => {
    if (on && waiting > 0) setReserved(true);
  }, [on, waiting]);

  function flip(next: boolean): void {
    if (next) {
      onSet(true);
      return;
    }
    // Off blocks every answer, so any open Decision arms it; with none waiting the switch goes at once.
    if (waiting === 0) {
      onSet(false);
      return;
    }
    if (tap("off") === "fire") onSet(false);
  }

  const about = ["what", "post", "nothing", "collie"] as const;
  return (
    <BottomSheet open={open} onClose={onClose} title={t("settings.tricks.hill.name")}>
      <div data-slot="trick-about-body" data-hill="">
        <p data-line="description" className="text-sm font-medium break-words">
          {t("settings.tricks.hill.description")}
        </p>
        <div data-section="about" className="pt-3">
          <p className="text-sm break-words">{about.map((key) => t(`settings.tricks.hill.about.${key}` as const)).join(" ")}</p>
        </div>
        <p data-line="built-in" className="pt-3 text-sm break-words text-muted-foreground">
          {t("settings.tricks.hill.builtIn")}
        </p>
        <section data-section="switch" className="pt-4">
          <div className="flex min-h-11 items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="text-sm">{t("settings.hill.label")}</div>
              <p className="text-xs text-muted-foreground">{t("settings.hill.hint")}</p>
            </div>
            <Switch checked={on} disabled={!canSet} onCheckedChange={flip} aria-label={t("settings.hill.label")} />
          </div>
          {reserved && (
            <div data-slot="armed-slot" className="relative mt-3">
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
        </section>
      </div>
    </BottomSheet>
  );
}

/** The sheet over the Hill's real switch and the real list. Mounted only while it is open. */
export function HillAboutSheetControl({ onClose }: { onClose: () => void }) {
  const sw = useHillSwitch();
  const waiting = useHillCount();
  return <HillAboutSheet open onClose={onClose} on={sw.on} canSet={sw.canWrite && !sw.busy} waiting={waiting} onSet={(next) => void sw.set(next)} />;
}
