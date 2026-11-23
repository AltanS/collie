import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { Button, FOCUS_RING_INSET, HOVER_FILL, TRIGGER_OPEN } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { savedAtLabel } from "@/lib/format";
import { HILL_CREW_STATES, type HillCrewState } from "@/lib/hill/wire";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE MODE CONTROL OF THE ASKS PAGE (Asks build 6, 2026-11-23; the crew state of 1.29.0: "Here / Quiet / Away"). It is
// a control a person changes rarely, so it is a ghost icon button in the page's header band, a bell, and not a row at the
// top of the list. In Here the bell stands alone; in Quiet or Away it is a crossed bell with the word, so a mode that
// silences the agents is never hidden. It opens the house menu (`BottomSheet` with an `anchor`: beside its button on a
// wide window, a bottom sheet on a phone) titled "How agents ask you": three `menuitemradio` rows with a check slot and
// the help text of each, then what the page held in the bar before. Who set the value and when; under Quiet or Away
// "Tell all sessions now", with its done words and its failure; a failed set. A device that may not write sees the
// rows disabled. The menu stays up while a write runs, closes when it succeeds, and stays up with its line when it fails.
//
// NOTHING MOVES ON A SWITCH (DESIGN.md §2): every value has one help line, and the tell row and a failure's line arrive
// and leave through `Collapse`. This file draws; the route hands it the hook's values (hooks/use-hill-crew-state.ts), and
// the playground fixed ones.

const LABEL = {
  here: "hill.state.here",
  quiet: "hill.state.quiet",
  away: "hill.state.away",
} as const satisfies Record<HillCrewState, string>;

const HELP = {
  here: "hill.state.help.here",
  quiet: "hill.state.help.quiet",
  away: "hill.state.help.away",
} as const satisfies Record<HillCrewState, string>;

/** Who set the crew state and when: a phone's label, or `terminal` for `collie hill state`. */
export interface HillCrewStateSetBy {
  by: string;
  at: number;
}

export interface HillCrewStateMenuProps {
  value: HillCrewState;
  /** The lead's value now: the tell row follows it, not a tap still in flight. */
  saved: HillCrewState;
  /** How many sessions "Tell all sessions now" reached for this change, or null when it has not run. */
  told: number | null;
  /**
   * Who set the lead's value and when, or null when nobody did. Shown under quiet and away, so a state
   * that silences every push always says where it came from, push or no push (review 8).
   */
  setBy: HillCrewStateSetBy | null;
  canWrite: boolean;
  busy: boolean;
  failed: boolean;
  telling: boolean;
  tellFailed: boolean;
  onChange: (next: HillCrewState) => void;
  onTell: () => void;
}

/** Who set it and when: a phone by its label, the CLI as a terminal. */
function setByWords(setBy: HillCrewStateSetBy): string {
  const time = savedAtLabel(setBy.at);
  return setBy.by === "terminal" ? t("hill.state.setFromTerminal", { time }) : t("hill.state.setBy", { by: setBy.by, time });
}

/** The done words of the tell button: how many sessions the line reached. */
function toldWords(count: number): string {
  return count === 0 ? t("hill.state.toldNone") : tn("hill.state.told", count);
}

export function HillCrewStateMenu({ value, saved, told, setBy, canWrite, busy, failed, telling, tellFailed, onChange, onTell }: HillCrewStateMenuProps) {
  useLocale();
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const picked = useRef(false);
  const sawBusy = useRef(false);
  const offerTell = saved !== "here";
  const done = told !== null;
  const unusual = value !== "here";
  const title = t("asks.mode.title");

  // A row closes the menu once its write has succeeded; a refused write keeps the menu up with its line.
  useEffect(() => {
    if (!picked.current) return;
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    picked.current = false;
    sawBusy.current = false;
    if (!failed) setOpen(false);
  }, [busy, failed]);

  const pick = (next: HillCrewState) => {
    if (next === value) {
      setOpen(false);
      return;
    }
    picked.current = true;
    sawBusy.current = false;
    onChange(next);
  };

  return (
    <div data-slot="hill-crew-state" data-state={value} className="relative flex shrink-0">
      <Button
        ref={anchor}
        type="button"
        variant="ghost"
        data-slot="hill-crew-state-button"
        aria-label={t("asks.mode.aria", { state: t(LABEL[value]) })}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cn("h-11 min-w-11 gap-1.5 px-2.5", TRIGGER_OPEN)}
      >
        <Icon name={unusual ? "notifications-snooze" : "notifications"} aria-hidden className="size-5" />
        {unusual && <span data-slot="hill-crew-state-word">{t(LABEL[value])}</span>}
      </Button>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={title} anchor={anchor}>
        <div data-slot="hill-crew-state-menu" role="menu" aria-label={title} className="flex flex-col">
          {/* A menu has no title row (ui/sheet.tsx), so the heading stands in its body there; a sheet already says it. */}
          <p aria-hidden className="hidden px-3 pt-2 pb-1.5 text-xs font-medium text-muted-foreground in-data-[presentation=menu]:block">
            {title}
          </p>
          {HILL_CREW_STATES.map((state) => (
            <button
              key={state}
              type="button"
              role="menuitemradio"
              aria-checked={value === state}
              data-slot="hill-crew-state-row"
              data-value={state}
              disabled={!canWrite || busy}
              onClick={() => pick(state)}
              className={cn("flex min-h-12 w-full items-start gap-3 rounded-md px-3 py-2.5 text-left disabled:opacity-60 disabled:hover:bg-transparent", FOCUS_RING_INSET, HOVER_FILL)}
            >
              <Icon name="done" aria-hidden className={cn("mt-0.5 size-4 shrink-0", value === state ? "visible" : "invisible")} />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-semibold">{t(LABEL[state])}</span>
                <span data-slot="hill-crew-state-help" className="text-[13px] text-muted-foreground">
                  {t(HELP[state])}
                </span>
              </span>
            </button>
          ))}
          <Collapse open={failed}>
            <p role="alert" data-slot="hill-crew-state-failed" className="px-3 pt-1 text-xs text-destructive">
              {t("hill.state.failed")}
            </p>
          </Collapse>
          <Collapse open={offerTell}>
            <div className="flex flex-col px-3 pt-2 pb-1">
              {setBy !== null && (
                <p data-slot="hill-crew-state-set-by" className="pb-2 text-xs text-muted-foreground">
                  {setByWords(setBy)}
                </p>
              )}
              <Button
                type="button"
                variant="outline"
                data-slot="hill-crew-state-tell"
                data-done={done ? "" : undefined}
                disabled={!canWrite || telling || done}
                onClick={onTell}
                className={cn("h-11 w-full", done && "text-muted-foreground")}
              >
                {/* Both words in one slot, sized by the wider, so the done word moves nothing. */}
                <OneOf
                  active={done ? "done" : "rest"}
                  className="inline-grid"
                  options={[
                    { key: "rest", node: t("hill.state.tell") },
                    { key: "done", node: toldWords(told ?? 0) },
                  ]}
                />
              </Button>
              <Collapse open={tellFailed}>
                <p role="alert" data-slot="hill-crew-state-tell-failed" className="pt-1 text-xs text-destructive">
                  {t("hill.state.tellFailed")}
                </p>
              </Collapse>
            </div>
          </Collapse>
        </div>
      </BottomSheet>
    </div>
  );
}
