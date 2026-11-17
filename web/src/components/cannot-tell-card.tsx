import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/icons/icon";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { RawMirror } from "@/components/raw-mirror";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { useLocale } from "@/hooks/use-locale";
import type { StyledLine } from "@/lib/blocks";
import { t, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE "CANNOT TELL" CARD (M102 spec 04, the picked option "Screen first"). A send ended `unknown`: the bridge
// typed the text and could not see it land. The card sits in the card dock's place, above the box, and
// carries one sentence, the live screen, and the person's two answers: "It arrived" and "Send again" (a
// sign-in code has no text to send again, so its second button is "Enter it again"). Rule 6c holds: nothing
// here sends by itself. Both buttons are the person's own tap, and the composer, not this card, owns what
// each one does. The card draws the screen it is given and calls the two handlers it is given.
//
// A read-only device sees the card without the buttons: it may look and may not answer.
//
// A FINAL ANSWER (the M102 review, K). "It arrived" that the bridge answers 409 (the receipt did not end
// unknown) or 404 (an older member that has no such mark) cannot succeed on another tap: the line says so
// and Close takes the place of "It arrived", so the card never loops on "Try again". Other failures keep it.
//
// WAITING (spec 13). When the receipt says the agent's own word may still come (`awaitingUntil`), the
// sentence says so and "Send again" is off until the time passes. It is `aria-disabled`, not `disabled`, so
// a tap still answers: it says the sentence again in the card's line. The time is a timer on the card; it
// turns the button on and never sends.
//
// THE RING. A tap on the composer's Send over the unchanged kept draft sends nothing: it raises `ring`, and
// the card shows a primary ring for RING_MS and scrolls itself into the dock's view, so the person answers
// the card instead of guessing. The ring is a box-shadow, so no state moves the card (DESIGN.md §2).

/** What the composer reports of the send the card is about. */
export interface CannotTellFacts {
  /** The request id of the `unknown` send, the one "It arrived" marks. */
  readonly requestId: string;
  /** The send was a sign-in code: no text was kept, and the second button is "Enter it again". */
  readonly secret: boolean;
  /** This device may not write: the card shows without its buttons. */
  readonly readOnly: boolean;
  /** Epoch milliseconds until which the agent's own word may still come, or null when nothing is awaited. */
  readonly awaitingUntil: number | null;
  /** The bridge stopped after the send's first key and before its end (reason `interrupted`, M102 spec 16):
   *  the text may be in the box and Enter may not have gone. The sentence says so. */
  readonly interrupted: boolean;
}

/**
 * What became of "It arrived": `recorded` (the card goes), `failed` (on the way: Try again stays), or a final
 * answer that no tap can change (the M102 review, K): `settled`, the receipt did not end unknown (409), and
 * `unknownHere`, the machine does not know the mark, an older member (404). A final answer offers Close.
 */
export type ArrivedAnswer = "recorded" | "failed" | "settled" | "unknownHere";

/** How long the ring stays after a tap on Send over the unchanged draft. */
export const RING_MS = 1_600;

/** The longest one timer of the wait is set for: a longer wait is watched in steps of this size. */
const MAX_TIMER_MS = 60_000;

export interface CannotTellCardProps {
  readonly facts: CannotTellFacts;
  /** The pane's screen as it is now: the whole thing, wrapped, opening at its bottom. */
  readonly lines: StyledLine[];
  /** The device's Wrap lines setting, as the pane mirror follows it. */
  readonly wrap?: boolean;
  /** Raised each time a tap on Send met the unchanged kept draft: each one is a new tick. A card mounted at a tick rings for later ones only. */
  readonly ring?: number;
  /** "It arrived": what became of the person's word (`ArrivedAnswer`). */
  readonly onArrived: () => Promise<ArrivedAnswer>;
  /** Close, offered after a final answer to "It arrived": ends the question. Sends nothing and clears nothing. */
  readonly onClose: () => void;
  /** The second button: Send again, or Enter it again for a sign-in code. */
  readonly onAgain: () => void;
}

type CardLine = "failed" | "waiting" | "settled" | "unknownHere" | null;

const LINE_WORDS = {
  failed: "cannotTell.arrivedFailed",
  waiting: "cannotTell.waiting",
  settled: "cannotTell.arrivedSettled",
  unknownHere: "cannotTell.arrivedUnknownHere",
} as const satisfies Record<Exclude<CardLine, null>, MessageKey>;

/** The live screen: one scroller that opens at its bottom and gives way first when the dock is short. */
function Screen({ lines, wrap }: { lines: StyledLine[]; wrap: boolean }) {
  return (
    <div data-fit-shrink className="flex max-h-56 min-h-20 min-w-0 flex-col">
      <RawMirror lines={lines} wrap={wrap} anchor="bottom" className="min-h-0 overflow-y-auto overscroll-contain" />
    </div>
  );
}

export function CannotTellCard({ facts, lines, wrap = false, ring = 0, onArrived, onAgain, onClose }: CannotTellCardProps) {
  useLocale();
  const { awaitingUntil, secret, readOnly } = facts;
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<CardLine>(null);
  // A final answer to "It arrived" (409, 404): its words stay, and Close takes the place of "It arrived".
  const [final, setFinal] = useState<"settled" | "unknownHere" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ringed, setRinged] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  // The wait is a clock the card watches; reaching its end turns Send again on and sends nothing. A timer
  // that fires a hair early, or a wait longer than one timer can hold, schedules itself again.
  useEffect(() => {
    if (awaitingUntil === null || now >= awaitingUntil) return;
    const left = awaitingUntil - Date.now();
    const timer = setTimeout(() => setNow(Math.max(Date.now(), left <= MAX_TIMER_MS ? awaitingUntil : 0)), Math.min(Math.max(left, 0), MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [awaitingUntil, now]);
  const waiting = awaitingUntil !== null && now < awaitingUntil;
  // A line that said "wait" is stale once the wait is over.
  const shownLine: CardLine = line === "waiting" && !waiting ? null : line;

  // A tap on Send over the unchanged draft: the ring for RING_MS, and the card brought into view.
  const seenRing = useRef(ring);
  useEffect(() => {
    if (ring === seenRing.current) return;
    seenRing.current = ring;
    setRinged(true);
    box.current?.scrollIntoView?.({ block: "nearest" });
    const timer = setTimeout(() => setRinged(false), RING_MS);
    return () => clearTimeout(timer);
  }, [ring]);

  async function arrived(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setLine(null);
    const answer = await onArrived().catch((): ArrivedAnswer => "failed");
    if (!mounted.current) return;
    setBusy(false);
    if (answer === "settled" || answer === "unknownHere") {
      setFinal(answer);
      setLine(answer);
      return;
    }
    if (answer === "failed") setLine("failed");
  }

  function again(): void {
    if (waiting) {
      setLine("waiting");
      return;
    }
    setLine(final);
    onAgain();
  }

  const sentence = t(waiting ? "cannotTell.waiting" : facts.interrupted ? "cannotTell.interrupted" : "cannotTell.sentence");
  return (
    <div
      ref={box}
      data-slot="cannot-tell-card"
      data-highlight={ringed ? "" : undefined}
      className={cn("flex min-h-0 shrink flex-col rounded-xl transition-shadow motion-reduce:transition-none", ringed && "ring-2 ring-primary")}
    >
      <PromptPanel ariaLabel={sentence} wrap={wrap} fit>
        {/* A live region: while the card stands in for the box's notice, a screen reader hears it as it heard the notice. */}
        <OptionGroupCaption>
          <span role="status">{sentence}</span>
        </OptionGroupCaption>
        <Screen lines={lines} wrap={wrap} />
        {!readOnly && (
          <div className="flex gap-2">
            {final === null ? (
              <Button type="button" variant="secondary" data-action="arrived" aria-busy={busy} className="h-11 min-w-0 flex-1" onClick={() => void arrived()}>
                {busy && <Icon name="busy" aria-hidden className="size-3.5 animate-spin" />}
                {t("cannotTell.arrived")}
              </Button>
            ) : (
              <Button type="button" variant="secondary" data-action="close" className="h-11 min-w-0 flex-1" onClick={onClose}>
                {t("cannotTell.close")}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              data-action="again"
              aria-disabled={waiting}
              className={cn("h-11 min-w-0 flex-1", waiting && "opacity-50")}
              onClick={again}
            >
              {t(secret ? "cannotTell.enterAgain" : "composer.step.sendAgain")}
            </Button>
          </div>
        )}
      </PromptPanel>
      {/* The card's one line, under the panel like the dock's own reason line: it opens in a Collapse, so nothing jumps. */}
      <Collapse open={shownLine !== null}>
        {shownLine !== null && (
          <p data-slot="cannot-tell-line" role="status" className="px-1 pb-1 text-xs leading-snug text-muted-foreground">
            {t(LINE_WORDS[shownLine])}
          </p>
        )}
      </Collapse>
    </div>
  );
}
