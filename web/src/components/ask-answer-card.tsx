import type { ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { KeyBadge, optionSurface } from "@/components/option-button";
import { Badge } from "@/components/ui/badge";
import { OneOf } from "@/components/ui/one-of";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// ONE ANSWER CARD OF AN ASK (Asks build 2, 2026-11-23). The look is `OptionButton`'s (`optionSurface`): a bordered face
// that reads as a control, and the digit of its key (`KeyBadge`) as a small square on the top-left edge. The digit and
// the neutral "Recommended" badge, or "Answered" once the card is the answer, sit ABSOLUTELY on the top edge, so nothing
// of the card's content moves for them (DESIGN.md §2). The border is one pixel in every state: only its colour changes
// (the chosen card is `border-primary bg-primary/10`, the selected tone of `optionSurface`). Nothing is green before an
// answer; the answered card wears `Badge ok`.
//
// EVERY CARD HAS ITS RESERVED PARTS. The badge slot is one `OneOf`, sized by the widest of its words; the line at the foot
// is 16px tall and holds "Note: ..." when the card is answered with a note, and is empty otherwise; "Your own answer" and
// "Write your answer" keep their body in a `OneOf` of the prompt and the answer text, so writing it moves nothing. The
// agent's words (title, Then, Cost, Why) are `font-content`: the app's face never dresses what an agent wrote.

/** The three kinds of card: an option the agent offered, the fixed "Your own answer", and the one card of a `--words` ask. */
export type AskCardKind = "option" | "own" | "words";

export interface AskAnswerCardProps {
  kind: AskCardKind;
  /** The digit of its key, 1 to 9. */
  number: number;
  title: string;
  /** What happens then (`--does`), the cost (`--cost`) and why this one is recommended (`--why`): each only when the agent sent it. */
  then?: string;
  cost?: string;
  why?: string;
  recommended?: boolean;
  /** The card is the answer marked on this phone. */
  answered: boolean;
  /** The note of an answered option card, drawn on one line in the foot. */
  note?: string;
  /** The card's own line while it is not answered ("Write what the agent should do instead."), and the text once it is. */
  line?: string;
  text?: string;
  /** The confirm sheet is open on this card: it stays marked above the sheet. */
  picked?: boolean;
  disabled?: boolean;
  /** The option's intent, the card's handle for a test and for the keys. */
  intent: string;
  onPick: () => void;
}

/** A label on its own line over the agent's text: "Then", "Cost", "Why". */
function Line({ label, text, slot }: { label: string; text: string; slot: string }) {
  return (
    <span data-slot={slot} className="block min-w-0">
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      <span className="font-content block break-words text-[15px] leading-snug text-foreground">{text}</span>
    </span>
  );
}

/** The one-line note of an answered card, whitespace folded. */
export function noteLine(note: string): string {
  return note.replace(/\s+/gu, " ").trim();
}

export function AskAnswerCard({ kind, number, title, then, cost, why, recommended = false, answered, note, line, text, picked = false, disabled = false, intent, onPick }: AskAnswerCardProps): ReactNode {
  useLocale();
  const on = answered || picked;
  const own = kind !== "option";
  const folded = note === undefined ? "" : noteLine(note);
  const badge = answered ? "answered" : recommended ? "recommended" : null;
  return (
    <div data-slot="ask-card" data-intent={intent} data-kind={kind} data-state={answered ? "answered" : picked ? "picked" : "rest"} className="relative">
      <button
        type="button"
        aria-pressed={answered}
        disabled={disabled}
        onClick={onPick}
        className={cn(optionSurface(on ? "selected" : "default"), "min-h-12 flex-col items-stretch gap-2 px-3.5 pb-2.5 pt-5 shadow-none disabled:opacity-100", own && "border-dashed", "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}
      >
        {answered && <span className="sr-only">{t("asks.card.answered")}. </span>}
        {recommended && !answered && <span className="sr-only">{t("asks.card.recommended")}. </span>}
        <span data-slot="ask-card-title" className="font-content block break-words text-[17px] font-semibold leading-tight text-balance text-foreground">
          {title}
        </span>
        {own ? (
          <OneOf
            active={answered && text !== undefined && text !== "" ? "text" : "line"}
            className="min-w-0"
            options={[
              { key: "line", node: <span className="font-content line-clamp-2 block text-[15px] leading-snug text-muted-foreground">{line}</span> },
              { key: "text", node: <span data-slot="ask-card-text" className="font-content line-clamp-2 block break-words text-[15px] leading-snug text-foreground">{text}</span> },
            ]}
          />
        ) : (
          <>
            {then !== undefined && <Line slot="ask-card-then" label={t("asks.card.then")} text={then} />}
            {cost !== undefined && <Line slot="ask-card-cost" label={t("asks.card.cost")} text={cost} />}
            {why !== undefined && <Line slot="ask-card-why" label={t("asks.card.why")} text={why} />}
          </>
        )}
        <span data-slot="ask-card-foot" className="block h-4 min-w-0 truncate text-xs leading-4 text-muted-foreground">
          {folded === "" ? null : t("asks.card.note", { note: folded })}
        </span>
      </button>
      <span aria-hidden className="pointer-events-none absolute left-3.5 top-0 -translate-y-1/2">
        <KeyBadge tone={on ? "selected" : "default"}>{number}</KeyBadge>
      </span>
      <span aria-hidden className="pointer-events-none absolute right-3.5 top-0 -translate-y-1/2">
        <OneOf
          active={badge}
          className="inline-grid justify-items-end"
          options={[
            {
              key: "recommended",
              node: (
                <Badge variant="value" data-slot="ask-badge-recommended">
                  <Icon name="recommended" aria-hidden className="size-3.5 shrink-0 text-status-working" />
                  {t("asks.card.recommended")}
                </Badge>
              ),
            },
            {
              key: "answered",
              node: (
                <Badge variant="ok" data-slot="ask-badge-answered">
                  <Icon name="done" aria-hidden className="size-3.5 shrink-0" />
                  {t("asks.card.answered")}
                </Badge>
              ),
            },
          ]}
        />
      </span>
    </div>
  );
}
