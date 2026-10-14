import { useEffect, useRef, type ReactNode } from "react";
import { Loader2, MessageSquarePlus } from "lucide-react";

/**
 * The short text a person types ON a card: a bordered box holding a labelled textarea, a help line,
 * a Cancel and a Send that can spin — plus the dashed offer button that opens it.
 *
 * DESIGN.md §1: the plan-approval card (`components/prompt-select-block.tsx`) held this inline, and
 * three more cards need the same box (an AskUserQuestion single question's typed answer, the wizard,
 * the multi-select row), so it is a primitive here and the plan card moved onto it with no visible
 * change. A fix to the box's shape, its focus behaviour or its tap targets lands once.
 *
 * The contract is `ui/notice.tsx`'s: shape and semantics only. It owns no words — every string
 * arrives as a prop, because i18n lives on the feature side — no network, and no draft; the caller
 * holds `value` and decides what Send means. `busy` is the caller's own send in flight, and the
 * spinner is drawn INSIDE Send, so the button that was pressed is the one that says it is working.
 */

export interface InlineEditorProps {
  /** The textarea's id, and what the label's `htmlFor` points at. */
  id: string;
  /** The label above the field. */
  label: string;
  value: string;
  /** The whole next value, never the event: the caller keeps the draft. */
  onChange: (value: string) => void;
  maxLength: number;
  placeholder: string;
  /** The line under the field, saying what Send does. */
  help: string;
  /** Names the textarea for a screen reader, independently of the label's wording. */
  textAriaLabel: string;
  sendLabel: string;
  cancelLabel: string;
  onSend: () => void;
  onCancel: () => void;
  /** Nothing to send, or the card is locked: Send renders disabled. */
  sendDisabled: boolean;
  /** A send of the caller's is in flight: Cancel renders disabled so it cannot race it. */
  cancelDisabled: boolean;
  busy: boolean;
  /** Names the spinner, e.g. "Sending feedback…". */
  busyAriaLabel: string;
  /** Something the caller must say before the person sends again, drawn between the label and the
   *  field. The caller owns its words and its semantics (a `role="status"` element, say). */
  notice?: ReactNode;
}

export function InlineEditor({
  id,
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  help,
  textAriaLabel,
  sendLabel,
  cancelLabel,
  onSend,
  onCancel,
  sendDisabled,
  cancelDisabled,
  busy,
  busyAriaLabel,
  notice,
}: InlineEditorProps) {
  // Focused from an effect rather than with `autoFocus`: the attribute only acts on the very first
  // mount of the element, and it gives assistive tech no chance to announce the surrounding panel
  // first. Mounting IS opening here — the caller renders the editor when it opens it — so the focus
  // runs once, on mount.
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <MessageSquarePlus className="size-3.5 shrink-0" />
        {label}
      </label>
      {notice}
      <textarea
        id={id}
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        rows={3}
        aria-label={textAriaLabel}
        placeholder={placeholder}
        className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <p className="text-[11px] leading-snug text-muted-foreground">{help}</p>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          disabled={cancelDisabled}
          onClick={onCancel}
          className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          disabled={sendDisabled}
          onClick={onSend}
          className="flex items-center gap-1.5 rounded-md border border-primary/60 bg-primary/15 px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors active:bg-primary/25 disabled:opacity-60"
        >
          {busy ? (
            <Loader2
              className="size-3.5 shrink-0 animate-spin text-muted-foreground"
              aria-label={busyAriaLabel}
            />
          ) : null}
          {sendLabel}
        </button>
      </div>
    </div>
  );
}

export interface InlineEditorOfferProps {
  label: string;
  onClick: () => void;
  /** A locked card: the offer renders disabled rather than disappearing, so the screen does not move. */
  disabled: boolean;
}

/**
 * The dashed button that opens the editor. A sibling of the editor rather than part of it, because
 * the card shows exactly one of the two: the offer while the field is closed, the editor once it is
 * open.
 */
export function InlineEditorOffer({ label, onClick, disabled }: InlineEditorOfferProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg border border-dashed border-border/60 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors active:bg-muted disabled:opacity-60"
    >
      <MessageSquarePlus className="size-3.5 shrink-0" />
      {label}
    </button>
  );
}
