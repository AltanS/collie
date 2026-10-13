import { useState } from "react";
import { Loader2 } from "lucide-react";

import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { answerAsk, apiErrorStatus } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import {
  answerable,
  answered,
  effectKey,
  freshCard,
  optionTone,
  polled,
  pressed,
  secondaryLabel,
  tapped,
  visibleOptions,
  type AnswerResult,
  type AskCardState,
} from "@/lib/ask";
import { t } from "@/lib/i18n";
import type { Scope } from "@/lib/scope";
import type { Ask, AskOption } from "@/lib/types";
import { mintRequestId } from "@/lib/worktree-name";

// A DURABLE PROGRAM'S ASK, AS A CARD (ADR 0100).
//
// It wears the permission card's own look (PromptPanel, OptionGroupCaption, OptionButton), so an ask
// from a program reads like a Claude permission card. What differs is where it comes from: the card
// is drawn from DATA the pane carries, and a tap answers by the ask's id and revision with a request
// id minted for the tap, through the answer route. No keys, no screen, no read-back.
//
// ONLY A PERSON'S TAP POSTS. The one call to the route is `tap()`, and `tap()` is reached from a
// button's onClick and from nothing else: no effect, no timer and no poll result sends an answer.
// "Try again" is a tap too, and it carries the SAME request id as the tap it retries, so the bridge
// answers from its receipt instead of resolving the ask twice.
//
// STRINGS FROM THE PROGRAM are React text nodes only, as every string in this app is. The bridge
// cleaned and capped them; a card of a kind this version does not know is drawn with its words and
// no buttons.

/** A transport error as an answer: a refusal the bridge made on purpose says so, anything else may have arrived. */
function thrownAnswer(status: number | undefined, message: string): AnswerResult {
  if (status === 400 || status === 401 || status === 403) return { outcome: "refused", detail: message };
  return { outcome: "unknown" };
}

export interface AskCardProps {
  /** The ask as the last poll drew it. A newer revision of the same ask replaces what the card shows. */
  ask: Ask;
  paneId: string;
  scope?: Scope;
  /** This device may not write, or the pane's machine is not taking writes. The buttons are off. */
  disabled?: boolean;
  /** The pane is drawn from saved or frozen data: the buttons are off and the card says why. */
  offline?: boolean;
  /** An answer reached the bridge and changed what is current (taken, too late, stale): read the pane again. */
  onSettled?: () => void;
}

export function AskCard({ ask, paneId, scope, disabled = false, offline = false, onSettled }: AskCardProps) {
  useLocale();
  const [card, setCard] = useState<AskCardState>(() => freshCard(ask));
  // A newer form of this ask from the poll replaces the card, unless a tap is in flight (lib/ask.ts).
  // Adjusted during render, as React documents for state derived from a prop.
  const next = polled(card, ask);
  if (next !== card) setCard(next);

  const shown = card.ask;
  const options = visibleOptions(shown);
  const canAnswer = answerable(shown);
  const busy = card.phase === "sending";
  // Off for good in these phases: the answer was taken, or someone else made it, or it is refused.
  // `unknown` leaves only "Try again" (the same intent); `stale` on an old machine cannot be tapped.
  const settled = card.phase === "taken" || card.phase === "late" || card.phase === "maybe" || card.phase === "refused";
  const frozen = disabled || offline || busy || settled || card.phase === "unknown" || (card.phase === "stale" && card.older);

  /** A press on an option's button. "Always allow" arms on the first press and posts on the second. */
  function onPress(option: AskOption) {
    if (disabled || offline || busy) return;
    const press = pressed(card, option);
    setCard(press.state);
    if (press.post) void tap(option, false, press.state);
  }

  async function tap(option: AskOption, again: boolean, from: AskCardState = card) {
    if (disabled || offline || busy) return;
    // A retry reuses the id of the tap it retries, and only after an unknown outcome.
    const requestId = again && card.requestId !== null ? card.requestId : mintRequestId();
    const sent = from;
    setCard(tapped(sent, option.id, requestId));
    let result: AnswerResult;
    try {
      result = await answerAsk(paneId, { requestId, askId: sent.ask.id, revision: sent.ask.revision, optionId: option.id }, scope);
    } catch (error) {
      result = thrownAnswer(apiErrorStatus(error), describeThrownError(error));
    }
    setCard((now) => answered(now, result));
    if (result.outcome === "taken" || result.outcome === "too-late" || result.outcome === "stale" || result.outcome === "maybe-applied") {
      onSettled?.();
    }
  }

  // Taken closes the card. The program drops the ask from the next poll; until then nothing is drawn.
  if (card.phase === "taken") return null;

  const retryOption = card.phase === "unknown" ? options.find((o) => o.id === card.optionId) : undefined;
  const note = noteFor(card, offline);

  return (
    <PromptPanel ariaLabel={shown.title}>
      <OptionGroupCaption>{t("ask.caption")}</OptionGroupCaption>
      <p data-slot="ask-title" className="font-content pl-0.5 text-sm leading-snug font-medium text-foreground wrap-anywhere">
        {shown.title}
      </p>
      {shown.reason !== undefined ? (
        <p data-slot="ask-reason" className="font-content pl-0.5 text-sm leading-snug whitespace-pre-line text-muted-foreground wrap-anywhere">
          {shown.reason}
        </p>
      ) : null}
      {shown.cleaned === true ? (
        <p data-slot="ask-cleaned" className="pl-0.5 text-xs leading-snug text-muted-foreground">
          {t("ask.cleaned")}
        </p>
      ) : null}
      {shown.tool !== undefined ? (
        <p
          data-slot="ask-tool"
          className="rounded-lg border border-border/60 bg-muted/30 px-2 py-1 font-mono text-xs leading-snug wrap-anywhere"
        >
          <span className="font-medium text-foreground">{shown.tool.name}</span>
          {shown.tool.summary !== "" ? <span className="text-muted-foreground"> {shown.tool.summary}</span> : null}
        </p>
      ) : null}
      {note !== null ? (
        <p data-slot="ask-note" role="status" className="pl-0.5 text-xs leading-snug text-muted-foreground wrap-anywhere">
          {note}
        </p>
      ) : null}
      {canAnswer ? (
        <div className="flex flex-col gap-1">
          {options.map((option) => {
            const inFlight = busy && card.optionId === option.id;
            // Collie's words lead; the program's own label is the quiet second line (lib/ask.ts).
            const main = card.armed === option.id ? t("ask.alwaysArmed", { tool: shown.tool?.name ?? "" }) : t(effectKey(option.effect));
            return (
              <OptionButton
                key={option.id}
                tone={inFlight ? "busy" : optionTone(option.effect)}
                label={main}
                description={secondaryLabel(option.label, t(effectKey(option.effect)))}
                disabled={frozen}
                onClick={() => onPress(option)}
                trailing={
                  inFlight ? (
                    <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" aria-label={t("prompt.sendingAria")} />
                  ) : null
                }
              />
            );
          })}
        </div>
      ) : (
        <p data-slot="ask-not-answerable" className="pl-0.5 text-xs leading-snug text-muted-foreground">
          {t("ask.notAnswerable")}
        </p>
      )}
      {retryOption !== undefined ? (
        <Button
          type="button"
          variant="outline"
          className="h-11"
          disabled={disabled || offline}
          onClick={() => void tap(retryOption, true)}
        >
          {t("ask.retry")}
        </Button>
      ) : null}
    </PromptPanel>
  );
}

/** The one line a phase says under the question, or null while the card is simply waiting for a tap. */
function noteFor(card: AskCardState, offline: boolean): string | null {
  switch (card.phase) {
    case "late":
      // Not "Already answered": after a wake the same question may come back under the same id.
      return t("ask.notTaken");
    case "stale":
      return card.older ? t("ask.stale.older") : t("ask.stale");
    case "unknown":
      return t("ask.unknown");
    case "maybe":
      return t("ask.maybe");
    case "refused":
      return card.detail !== "" ? card.detail : t("ask.refused");
    case "idle":
    case "sending":
    case "taken":
      return offline ? t("prompt.reconnectNote") : null;
  }
}
