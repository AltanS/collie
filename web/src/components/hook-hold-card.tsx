import { useState } from "react";

import { Notice } from "@/components/ui/notice";
import { OptionButton, OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import type { HoldNote, HoldState } from "@/lib/surface/hold";
import type { Ask } from "@/lib/surface/surface";

// A HOOK-HELD PERMISSION (M56 spec 12). The harness's permission hook holds the request, and the
// bridge publishes it as an ask with `channel: hook`. Where the screen draws its own dialog, the
// docked prompt card answers it, and this card only adds the outcome note. Where the screen shows no
// dialog (a subagent's request), this card is the only way to see the request: it draws the tool, the
// input shown and the options from the ask. A tap posts one Answer through the caller; this card
// never touches the network and no key is ever sent for it.

/** The note sentence for each state that ends a hold, or says Sent. `held` has the card instead. */
const NOTE_TEXT = {
  sent: "chat.hold.sent",
  desk: "chat.hold.desk",
  elsewhere: "chat.hold.elsewhere",
  void: "chat.hold.void",
  timeout: "chat.hold.timeout",
  mismatch: "chat.hold.mismatch",
} as const satisfies Record<Exclude<HoldState, "held">, MessageKey>;

const NOTE_TONE = {
  sent: "info",
  desk: "neutral",
  elsewhere: "neutral",
  void: "caution",
  timeout: "caution",
  mismatch: "caution",
} as const;

export interface HookHoldCardProps {
  readonly note: HoldNote;
  /** The pane's ask, when the Surface carries the hook ask this note is about. */
  readonly ask: Ask | null;
  /** True when a docked screen card already shows this dialog: then only the note draws. */
  readonly screenCard: boolean;
  /** One tap on an option, by its index in the ask. */
  readonly onAnswer: (index: number) => Promise<void> | void;
  readonly disabled?: boolean;
}

/** The card, the note, or nothing. */
export function HookHoldCard({ note, ask, screenCard, onAnswer, disabled }: HookHoldCardProps) {
  useLocale();
  const [busy, setBusy] = useState<number | null>(null);
  if (note.state !== "held") {
    return (
      <div className="px-3 pb-2">
        <Notice tone={NOTE_TONE[note.state]} variant="box" announce="status">
          {t(NOTE_TEXT[note.state])}
        </Notice>
      </div>
    );
  }
  // The screen's own card answers the same ask: draw nothing more.
  if (screenCard || ask === null || ask.channel !== "hook" || ask.id !== note.askId) return null;
  const title = t("chat.hold.title", { tool: note.tool });
  return (
    <div className="px-3 pb-2">
      <PromptPanel ariaLabel={title}>
        <OptionGroupCaption>{title}</OptionGroupCaption>
        {note.agent && <p className="font-content pl-0.5 text-xs text-muted-foreground">{t("chat.hold.subagent")}</p>}
        <pre className="max-h-40 overflow-auto rounded-sm border bg-muted/40 px-2 py-1.5 font-mono text-xs whitespace-pre-wrap break-all">{note.input}</pre>
        {ask.options.map((option, index) => (
          <OptionButton
            key={option.id}
            tone={busy === index ? "busy" : "default"}
            keyLabel={option.id}
            label={option.label}
            disabled={disabled === true || busy !== null}
            onClick={() => {
              setBusy(index);
              void Promise.resolve(onAnswer(index)).finally(() => setBusy(null));
            }}
          />
        ))}
      </PromptPanel>
    </div>
  );
}
