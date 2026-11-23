import { useEffect, useRef, useState, type ReactNode } from "react";

import { KeyBadge } from "@/components/option-button";
import { Button } from "@/components/ui/button";
import { FoldPanel, NoteToggle } from "@/components/ui/fold-toggle";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { markedAnswer, optionCost, type AskDecision } from "@/lib/hill/asks";
import { ASK_NOTE_MAX, type AskDraft } from "@/lib/hill/asks-drafts";
import { confirmsOnKey } from "@/lib/hill/asks-keys";
import { HILL_MORE_CONTEXT, HILL_OWN_ANSWER } from "@/lib/hill/wire";
import { t } from "@/lib/i18n";

// THE CONFIRM SHEET OF AN ASK (Asks build 2, 2026-11-23). A tap on an answer card, or a digit key, opens it: the chosen
// answer, "Add a note" behind a `NoteToggle` fold, Confirm and Cancel. It is `BottomSheet`: a sheet from the bottom edge on
// a phone, a centred dialog on a large screen. Confirm stores a draft (`lib/hill/asks-drafts.ts`) and sends nothing; there
// is no toast and no move to the next ask.
//
// THE NOTE IS OPTIONAL, SO IT STANDS BEHIND ITS TOGGLE, drawn open only when there is a note already or a key opened the
// sheet on a screen that has a keyboard (a touch never raises the soft keyboard by itself). "Your own answer" and a `--words`
// ask have a REQUIRED field, drawn open, with Confirm off until it holds words. Enter confirms, Shift+Enter is a new line,
// Escape closes (the sheet's own). A tap on an answered card opens the sheet again with its note filled in, "Change answer".

/** What the sheet is open on. */
export type AskPick =
  | { kind: "option"; intent: string; byKey: boolean }
  /** "Your own answer": the fixed free-text answer of an ask with options. */
  | { kind: "own"; byKey: boolean }
  /** The one card of a `--words` ask. */
  | { kind: "words"; byKey: boolean }
  /** "Ask back": the agent is asked for more context, with an optional note. */
  | { kind: "more"; byKey: boolean };

/** The draft each kind of pick comes to once confirmed. */
export function draftOf(pick: AskPick, text: string): AskDraft {
  const trimmed = text.trim();
  switch (pick.kind) {
    case "option":
      return { intent: pick.intent, text: trimmed };
    case "own":
      return { intent: HILL_OWN_ANSWER, text: trimmed };
    case "words":
      return { intent: null, text: trimmed };
    case "more":
      return { intent: HILL_MORE_CONTEXT, text: trimmed };
  }
}

/** The note a pick starts with: what the draft already holds when it is the very same answer, else nothing. */
export function startText(pick: AskPick, draft: AskDraft): string {
  switch (pick.kind) {
    case "option":
      return draft.intent === pick.intent ? draft.text : "";
    case "own":
      return draft.intent === HILL_OWN_ANSWER ? draft.text : "";
    case "words":
      return draft.text;
    case "more":
      return draft.intent === HILL_MORE_CONTEXT ? draft.text : "";
  }
}

/** A device whose first pointer is a finger: it never gets a soft keyboard raised for it. */
function coarsePointer(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches === true;
}

/** The field the person writes in: the composer's own look, 16px so a phone does not zoom on focus. */
function Field({ id, label, placeholder, rows, value, onChange, focus }: { id: string; label: string; placeholder: string; rows: number; value: string; onChange: (value: string) => void; focus: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // The sheet takes the focus for itself as it opens, in an effect that runs after this one: the field asks one frame later.
  useEffect(() => {
    if (!focus) return;
    const frame = requestAnimationFrame(() => {
      const field = ref.current;
      if (field === null) return;
      field.focus({ preventScroll: true });
      field.setSelectionRange(field.value.length, field.value.length);
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <textarea
        ref={ref}
        id={id}
        data-slot="ask-confirm-text"
        value={value}
        onChange={(event) => onChange(event.target.value.slice(0, ASK_NOTE_MAX))}
        placeholder={placeholder}
        rows={rows}
        maxLength={ASK_NOTE_MAX}
        spellCheck={false}
        className="min-h-11 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
    </div>
  );
}

/** The chosen answer as a tile: its digit, its title, and what happens then. */
function Tile({ number, title, then, cost }: { number: number | null; title: string; then?: string; cost?: string }) {
  return (
    <div data-slot="ask-confirm-tile" className="flex flex-col gap-2 rounded-md border border-primary bg-primary/10 px-3.5 py-3">
      <div className="flex items-start gap-2">
        {number !== null && <KeyBadge tone="selected">{number}</KeyBadge>}
        <span className="font-content min-w-0 break-words text-[17px] font-semibold leading-tight text-foreground">{title}</span>
      </div>
      {then !== undefined && (
        <span className="block min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{t("asks.card.then")}</span>
          <span className="font-content block break-words text-[15px] leading-snug text-foreground">{then}</span>
        </span>
      )}
      {cost !== undefined && (
        <span className="block min-w-0">
          <span className="block text-xs font-medium text-muted-foreground">{t("asks.card.cost")}</span>
          <span className="font-content block break-words text-[15px] leading-snug text-foreground">{cost}</span>
        </span>
      )}
    </div>
  );
}

function ConfirmBody({ ask, pick, draft, answered, onConfirm, onClose }: { ask: AskDecision; pick: AskPick; draft: AskDraft; answered: boolean; onConfirm: (draft: AskDraft) => void; onClose: () => void }) {
  const [text, setText] = useState(() => startText(pick, draft));
  const touch = coarsePointer();
  const required = pick.kind === "own" || pick.kind === "words";
  const [noteOpen, setNoteOpen] = useState(() => text.trim() !== "" || (pick.byKey && !touch));
  const canConfirm = !required || text.trim() !== "";
  const confirm = () => {
    if (canConfirm) onConfirm(draftOf(pick, text));
  };
  // Enter confirms, anywhere in the sheet but on a button (which taps itself); Shift+Enter stays a new line.
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const onButton = event.target instanceof HTMLElement && event.target.closest("button, a, summary") !== null;
      if (!confirmsOnKey({ key: event.key, shiftKey: event.shiftKey, isComposing: event.isComposing, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey, onButton })) return;
      event.preventDefault();
      confirmRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  let body: ReactNode;
  if (pick.kind === "own" || pick.kind === "words") {
    const own = pick.kind === "own";
    body = (
      <Field
        id="ask-confirm-field"
        label={own ? t("asks.confirm.ownLabel") : t("asks.confirm.wordsLabel")}
        placeholder={own ? t("asks.confirm.ownPlaceholder") : t("asks.confirm.wordsPlaceholder")}
        rows={4}
        value={text}
        onChange={setText}
        focus={!touch}
      />
    );
  } else {
    const option = pick.kind === "option" ? ask.options.findIndex((candidate) => candidate.intent === pick.intent) : -1;
    const chosen = option === -1 ? undefined : ask.options[option];
    const more = pick.kind === "more";
    body = (
      <>
        {more ? <Tile number={null} title={t("asks.moreContext")} then={t("asks.confirm.askBackLine")} /> : <Tile number={option + 1} title={chosen?.label ?? ""} then={chosen?.detail} cost={chosen === undefined ? undefined : optionCost(chosen)} />}
        <div className="-mx-3 flex flex-col">
          <NoteToggle open={noteOpen} onToggle={() => setNoteOpen((open) => !open)} controls="ask-confirm-note" label={t("asks.confirm.note")} className="self-start" />
          <FoldPanel id="ask-confirm-note" open={noteOpen} className="flex flex-col gap-2 px-3 pb-1">
            <Field
              id="ask-confirm-field"
              label={more ? t("asks.confirm.askBackLabel") : t("asks.confirm.noteLabel")}
              placeholder={more ? t("asks.confirm.askBackPlaceholder") : t("asks.confirm.notePlaceholder")}
              rows={3}
              value={text}
              onChange={setText}
              focus={pick.byKey && !touch}
            />
          </FoldPanel>
        </div>
      </>
    );
  }

  return (
    <div data-slot="ask-confirm" data-kind={pick.kind} className="flex flex-col gap-3">
      {body}
      <div className="flex flex-col gap-2">
        <Button type="button" data-slot="ask-confirm-confirm" className="h-11 w-full" disabled={!canConfirm} onClick={confirm}>
          {answered ? t("asks.confirm.change") : t("asks.confirm.confirm")}
        </Button>
        <Button type="button" variant="outline" data-slot="ask-confirm-cancel" className="h-11 w-full" onClick={onClose}>
          {t("asks.confirm.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** A stable key for a pick, so the sheet draws a fresh body (and a fresh note) for each one. */
export function pickKey(pick: AskPick): string {
  return pick.kind === "option" ? `option:${pick.intent}` : pick.kind;
}

export function AskConfirmSheet({ ask, pick, draft, onConfirm, onClose }: { ask: AskDecision; pick: AskPick | null; draft: AskDraft; onConfirm: (draft: AskDraft) => void; onClose: () => void }) {
  useLocale();
  const title = pick === null ? "" : pick.kind === "own" ? t("asks.own.title") : pick.kind === "more" ? t("asks.askBack") : t("asks.confirm.title");
  return (
    <BottomSheet open={pick !== null} onClose={onClose} title={title}>
      {pick !== null && <ConfirmBody key={`${ask.id}:${pickKey(pick)}`} ask={ask} pick={pick} draft={draft} answered={markedAnswer(ask, draft) !== null} onConfirm={onConfirm} onClose={onClose} />}
    </BottomSheet>
  );
}
