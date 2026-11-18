import { useId, type CSSProperties, type ReactNode } from "react";

import { Icon } from "@/components/icons/icon";
import { KeyBadge, optionSurface, type OptionTone } from "@/components/option-button";
import { OneOf } from "@/components/ui/one-of";
import { useApproveHold } from "@/hooks/use-approve-hold";
import { useLocale } from "@/hooks/use-locale";
import { trickYesKind } from "@/lib/hill/code-card";
import type { HillDecision, HillOption } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// THE YES TO A TRICK'S CODE (ADR 0156): one button for every card that asks it, the chat's approval card, the
// agent view's, the Hill's and Settings, Tricks, for a proposed trick and for a new version. It is an option
// row (option-button.tsx `optionSurface`, the key badge, the detail line), and a hold of 1.5 seconds
// approves (hooks/use-approve-hold.ts). Its words change with the hold, "Hold to switch on", "Keep holding…",
// and for a key "Press again to confirm", all three in one slot sized by the widest, so nothing moves
// (DESIGN.md §2). The fill is the belt Stop's (index.css `hold-fill-layer`), in the primary ink: this is a
// yes, not a harm. `touch-pan-y` (2026-11-18, was `touch-none`): the button is a full-width row, and `touch-none` made
// a swipe that began on it pan nothing, so a card taller than the screen could not be scrolled from its buttons. Now a
// vertical swipe that starts on the button scrolls the chat (the browser takes the pan and fires `pointercancel`, which
// ends the hold with no yes), and a sideways drift of the thumb is never a pan, so it cannot cancel the hold. A still
// finger holds as before (hooks/use-approve-hold.ts).

/** The hold's words for each kind of yes to a trick's code. */
const HOLD_WORD = { on: "hill.hold.on", use: "hill.hold.use", always: "hill.hold.always" } as const;

/** The words at rest of the yes `option` of the trick card `decision`: "Hold to switch on", "Hold to use". */
export function holdLabel(decision: HillDecision, option: HillOption): string {
  return t(HOLD_WORD[trickYesKind(decision, option)]);
}

/** What the button needs: its words, its state, and the yes. */
export interface HoldToApproveProps {
  /** The words at rest: "Hold to switch on", "Hold to use". Also the button's accessible name at rest. */
  label: string;
  /** The option's detail line from the bridge, under the words. */
  description?: ReactNode;
  /** The option's number, as the other rows of the card show it. */
  keyLabel?: ReactNode;
  /** Whether a hold may approve now. False draws the button disabled. */
  enabled: boolean;
  /** This option's answer is in flight: the spinner, and no press. */
  busy?: boolean;
  /**
   * This option was the answer: it stays in place, in the chosen look (never dimmed), with a check mark in the slot
   * the spinner used, and takes no press. The card's other options are drawn disabled by the caller.
   */
  chosen?: boolean;
  /**
   * This option's yes did not land (no answer, or refused): the label says "Not sent. Hold again" in its own slot,
   * which is sized for those words from the first frame, so saying it moves nothing. `problem` is the reason in
   * words, read to a screen reader and kept as the button's title; it takes no room on the card.
   */
  notSent?: boolean;
  problem?: string;
  /** The card's code as the button approves it (its digest): a new key ends a hold. */
  resetKey: string;
  onApprove: () => void;
  className?: string;
  "data-slot"?: string;
  "data-intent"?: string;
}

/** The yes to a trick's code: a hold of 1.5 seconds, or two presses of a key. */
export function HoldToApprove({ label, description, keyLabel, enabled, busy = false, chosen = false, notSent = false, problem, resetKey, onApprove, className, ...data }: HoldToApproveProps) {
  useLocale();
  const hintId = useId();
  const pressable = enabled && !busy && !chosen;
  const { phase, fillStyle, back, props } = useApproveHold({ enabled: pressable, resetKey, onApprove });
  const tone: OptionTone = busy || chosen ? "busy" : phase === "armed" ? "armed" : "default";
  const word = phase === "armed" ? "armed" : phase === "filling" ? "holding" : notSent ? "again" : "rest";
  // Where a cancelled fill stood: the clip's right inset the run back starts from (index.css `hold-fill-back`).
  const backStyle: CSSProperties & { "--hold-from"?: string } = back === null ? {} : { "--hold-from": `${String(Math.round((1 - back) * 100))}%` };
  return (
    <>
      <button
        type="button"
        disabled={!pressable}
        aria-busy={busy}
        aria-describedby={hintId}
        data-phase={phase}
        data-chosen={chosen ? "" : undefined}
        data-not-sent={notSent ? "" : undefined}
        title={notSent ? problem : undefined}
        {...data}
        {...props}
        className={cn(optionSurface(tone), "relative touch-pan-y select-none overflow-hidden [-webkit-touch-callout:none]", className)}
      >
        {phase === "filling" && <span aria-hidden data-slot="hold-fill" style={fillStyle} className="hold-fill-layer pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/20" />}
        {back !== null && (
          <span
            aria-hidden
            data-slot="hold-fill"
            data-back=""
            style={backStyle}
            className="hold-fill-layer-back pointer-events-none absolute inset-0 rounded-[inherit] bg-primary/20"
          />
        )}
        {keyLabel != null && (
          <span className="relative flex">
            <KeyBadge tone={tone}>{keyLabel}</KeyBadge>
          </span>
        )}
        <span className="relative min-w-0 flex-1">
          <span className={cn("font-content block break-words text-sm font-medium leading-snug", tone === "armed" ? "text-destructive" : "text-foreground")}>
            <OneOf
              active={word}
              layerClassName="transition-opacity duration-150 ease-out motion-reduce:transition-none"
              options={[
                { key: "rest", node: label },
                { key: "holding", node: t("hill.hold.holding") },
                { key: "armed", node: t("hill.hold.armed") },
                { key: "again", node: t("hill.hold.again") },
              ]}
            />
          </span>
          {description ? <span className="font-content block break-words text-xs leading-snug text-muted-foreground">{description}</span> : null}
        </span>
        <span aria-hidden className="relative flex size-4 shrink-0 items-center justify-center">
          {busy ? (
            <Icon name="busy" className="size-3.5 animate-spin text-muted-foreground" />
          ) : chosen ? (
            <Icon name="done" data-slot="option-chosen-mark" className="size-4 text-primary" />
          ) : null}
        </span>
      </button>
      <span id={hintId} className="sr-only">
        {t("hill.hold.hint")}
      </span>
      {/* The reason a yes did not land, for a screen reader: always in the page, out of the layout. */}
      <span className="sr-only" role="status" data-slot="hold-problem">
        {notSent ? (problem ?? t("hill.hold.again")) : ""}
      </span>
    </>
  );
}
