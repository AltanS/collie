import { useEffect, useRef, useState } from "react";

import { Notice } from "@/components/ui/notice";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import type { HoldNote, HoldState } from "@/lib/surface/hold";

// A HOOK-HELD PERMISSION (M56 spec 12). The harness's permission hook holds the request, and the
// bridge publishes it as an ask with `channel: hook`. Where the hold took the screen's own dialog
// (`note.adopted`), the docked prompt card answers it, and this card only adds the outcome note. Else
// this card is the only way to answer the request: the screen shows no dialog for it (a subagent's
// request), or another dialog. It draws the tool, the input shown and the options from the note, and
// a tap posts one Answer through the caller, marked as from the hold card. This card never touches
// the network and no key is ever sent for it.

/** The note sentence for each state that ends a hold, or says Sent. `held` has the card instead. */
const NOTE_TEXT = {
  sent: "chat.hold.sent",
  desk: "chat.hold.desk",
  keys: "chat.hold.keys",
  elsewhere: "chat.hold.elsewhere",
  void: "chat.hold.void",
  timeout: "chat.hold.timeout",
  mismatch: "chat.hold.mismatch",
} as const satisfies Record<Exclude<HoldState, "held">, MessageKey>;

const NOTE_TONE = {
  sent: "info",
  desk: "info",
  keys: "neutral",
  elsewhere: "info",
  void: "caution",
  timeout: "caution",
  mismatch: "caution",
} as const;

/** The ms a new request's card ignores taps, so a tap meant for the card before it lands nowhere. */
export const HOLD_TAP_GUARD_MS = 400;

/** The most lines the input box shows before it scrolls. More lines, and the card says so. */
export const HOLD_CARD_LINES = 8;

export interface HookHoldCardProps {
  readonly note: HoldNote;
  /** One tap on an option, by its index in the note's options. */
  readonly onAnswer: (index: number) => Promise<void> | void;
  readonly disabled?: boolean;
}

/** The card, the note, or nothing. */
export function HookHoldCard({ note, onAnswer, disabled }: HookHoldCardProps) {
  useLocale();
  const [busy, setBusy] = useState<number | null>(null);
  // The time the card showed this request. A new ask id restarts the guard.
  const shownAt = useRef(0);
  useEffect(() => {
    shownAt.current = Date.now();
  }, [note.askId]);
  if (note.state !== "held") {
    return (
      <div className="px-3 pb-2">
        <Notice tone={NOTE_TONE[note.state]} variant="box" announce="status">
          {t(NOTE_TEXT[note.state])}
        </Notice>
      </div>
    );
  }
  // The hold took the screen's own dialog: the docked card answers it, draw nothing more.
  if (note.adopted) return null;
  const title = t("chat.hold.title", { tool: note.tool });
  const lines = note.input.split("\n").length;
  return (
    <div className="px-3 pb-2">
      <PromptPanel ariaLabel={title}>
        <OptionGroupCaption>{title}</OptionGroupCaption>
        {note.agent && <p className="font-content pl-0.5 text-xs text-muted-foreground">{t("chat.hold.subagent")}</p>}
        <pre className="max-h-40 overflow-auto rounded-sm border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">{note.input}</pre>
        {lines > HOLD_CARD_LINES && <p className="font-content pl-0.5 text-xs text-muted-foreground">{t("chat.hold.moreLines", { count: lines })}</p>}
        {note.options.map((label, index) => (
          <OptionButton
            key={label}
            tone={busy === index ? "busy" : "default"}
            keyLabel={String(index + 1)}
            label={label}
            disabled={disabled === true || busy !== null}
            onClick={() => {
              if (Date.now() - shownAt.current < HOLD_TAP_GUARD_MS) return;
              setBusy(index);
              void Promise.resolve(onAnswer(index)).finally(() => setBusy(null));
            }}
          />
        ))}
      </PromptPanel>
    </div>
  );
}
