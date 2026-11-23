import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { OneOf } from "@/components/ui/one-of";
import { Segmented } from "@/components/ui/segmented";
import { useLocale } from "@/hooks/use-locale";
import { savedAtLabel } from "@/lib/format";
import { HILL_CREW_STATES, type HillCrewState } from "@/lib/hill/wire";
import { t, tn } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE CREW STATE AT THE TOP OF THE HILL (1.29.0): "Here / Quiet / Away", one segmented choice, with one
// helper line under it that says what the chosen value does. Under quiet or away, "Tell all sessions now"
// offers the one line the waiting sessions get; once it ran for this change it reads done, with the count.
//
// NOTHING MOVES ON A SWITCH (DESIGN.md §2): the helper line is always one line, every value has one, so a
// switch repaints it in place. The tell row and a failure's line arrive and leave through `Collapse`, so
// the cards below glide rather than jump. This file draws; the route hands it the hook's values
// (hooks/use-hill-crew-state.ts), and the playground fixed ones.

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

export interface HillCrewStateBarProps {
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

export function HillCrewStateBar({ value, saved, told, setBy, canWrite, busy, failed, telling, tellFailed, onChange, onTell }: HillCrewStateBarProps) {
  useLocale();
  const offerTell = saved !== "here";
  const done = told !== null;
  return (
    <section data-slot="hill-crew-state" data-state={value} className="flex flex-col pb-4">
      <Segmented
        label={t("hill.state.label")}
        value={value}
        onChange={onChange}
        disabled={!canWrite || busy}
        options={HILL_CREW_STATES.map((state) => ({ value: state, label: t(LABEL[state]) }))}
      />
      <p data-slot="hill-crew-state-help" className="pt-2 text-xs text-muted-foreground">
        {t(HELP[value])}
      </p>
      <Collapse open={failed}>
        <p role="alert" data-slot="hill-crew-state-failed" className="pt-1 text-xs text-destructive">
          {t("hill.state.failed")}
        </p>
      </Collapse>
      <Collapse open={offerTell}>
        <div className="flex flex-col pt-3">
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
    </section>
  );
}
