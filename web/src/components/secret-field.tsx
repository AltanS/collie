// THE SIGN-IN FIELD (M102 spec 06, the picked option "Framed field"): while the screen asks for a sign-in
// code (the Surface's `field: "secret"`), the composer's box gives way to this frame. It looks different
// at a glance and says what it waits for: a two-pixel primary edge, the key mark and the label cut into
// its top edge on the left, the close cross opposite on the right. The mark is a shape first and a
// colour second, and nothing is red: a wrong code is not harm (DESIGN.md).
//
// THE TEXT IS ITS OWN. The frame holds what is typed in its own state, never in the composer's draft,
// so the person's normal draft stays apart and is there again after Close or a send. Nothing here
// writes a store: no draft, no request-id intent, no hold (the Send Protocol's secret path, M101 and
// M102 spec 05). The frame empties after a send that went or may have gone (`unknown`: a second tap would
// send the code twice, so the way on is "Enter it again", the M102 review, D). When the send did not go
// the text stays in the frame's own state (memory of the field only, never stored), so the person can
// send it again or replace it (M102 spec 11).
//
// SHOWN BY DEFAULT. A one-time code is pasted and checked, so it is shown; Show or Hide masks it. Paste
// takes the slot Show takes once text is typed, so nothing moves. A pasted code is trimmed (a copy from a
// mail or a page often carries a space or a newline). Where `navigator.clipboard.readText` is missing
// (plain http, an insecure context) or refuses, Paste focuses the field, so the person pastes with the
// soft keyboard: it never fails silently.
//
// CLOSE sends nothing to the pane. The cross and the cut it stands in are one circle, so its hover and
// focus ring are the shape the eye sees (Altan's note on the round: a square cross with a round ring).
//
// Attachments, the long-press menu, Steer and hold are absent here.

import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";

import { Icon } from "@/components/icons/icon";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { ChatInput } from "@/components/ui/chat/chat-input";
import { TOOLBAR_TAP_TARGET } from "@/components/ui/tap-target";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export interface SecretFieldProps {
  /** Sends the text once through the composer's own send (the secret path). Resolves true when the frame
   *  should empty: the code went or may have gone. False keeps the text: it did not go. */
  onSend: (text: string) => Promise<boolean>;
  /** Ends the secret state. Sends nothing. */
  onClose: () => void;
  /**
   * The text this frame holds changed, or the frame went (closed, or replaced by a fresh one). The composer drops the
   * request id it kept for a code whose answer was lost, so only the very same text goes again under it (the M102
   * review 2, D). Called with no text: the code never leaves the frame this way.
   */
  onTextChange?: () => void;
  /** A send runs, or the pane cannot be written: the field and its buttons wait. */
  disabled: boolean;
  /** A send runs: Send shows a busy state, so the wait has a mark of its own. */
  sending?: boolean;
  /** Why the field is disabled while a pane starts: said in a line under the frame. Null or absent: no
   *  line. The lock speaks through `lockedWhy`, never here. */
  reason?: string | null;
  /** Take the focus when the frame mounts: "Enter it again" on the "cannot tell" card opens the frame ready to type in. */
  focusOnMount?: boolean;
  /**
   * Why nothing typed here can leave for this pane (a pane that is gone, a device that may not write, a
   * box out of reach), in the composer's own words. It stands as the placeholder while it is set, so a
   * field that waits for good never stands there dead with no reason (no block without an exit).
   */
  lockedWhy?: string;
  /** Where a send starts from, for the design reference only: the text and whether it is shown. */
  start?: { readonly value: string; readonly shown: boolean };
}

/** What a paste puts in the field: no leading or trailing space or newline. */
export function cleanPaste(text: string): string {
  return text.trim();
}

/** One icon control in the field's row: drawn 36px, reaching 44px. */
const ICON_BUTTON = cn(TOOLBAR_TAP_TARGET, "size-9 shrink-0 rounded-full");

export function SecretField({ onSend, onClose, onTextChange, disabled, sending = false, reason = null, focusOnMount = false, lockedWhy, start }: SecretFieldProps) {
  useLocale();
  const [value, setValue] = useState(start?.value ?? "");
  const [shown, setShown] = useState(start?.shown ?? true);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const label = t("composer.secret.label");
  // Every change of the text, and the frame's end, is told; the latest callback is the one called.
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  useEffect(() => {
    onTextChangeRef.current?.();
  }, [value]);
  useEffect(() => () => onTextChangeRef.current?.(), []);
  // The prop only ever changes together with the frame's key (the composer remounts it), so this runs once per frame.
  useEffect(() => {
    if (focusOnMount) fieldRef.current?.focus();
  }, [focusOnMount]);

  async function send(): Promise<void> {
    const text = value.trim();
    if (text === "" || disabled) return;
    // The text leaves the frame when the send went or may have gone. A send that did not go keeps it, so
    // the person can send it again or replace it. It is state of this frame alone and is never written anywhere.
    if (await onSend(text)) setValue("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey) return;
    // A code has no newline: the return key sends, as its `send` hint says.
    event.preventDefault();
    void send();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const text = event.clipboardData.getData("text");
    if (text === "" || text === cleanPaste(text)) return;
    event.preventDefault();
    const el = event.currentTarget;
    setValue(el.value.slice(0, el.selectionStart) + cleanPaste(text) + el.value.slice(el.selectionEnd));
  }

  async function paste(): Promise<void> {
    // `navigator.clipboard` is undefined outside a secure context; a browser may also refuse the read.
    // Either way the field takes the focus, and the soft keyboard's own paste lands there.
    const clipboard: Clipboard | undefined = navigator.clipboard;
    if (clipboard?.readText === undefined) {
      fieldRef.current?.focus();
      return;
    }
    try {
      const text = cleanPaste(await clipboard.readText());
      if (text === "") {
        fieldRef.current?.focus();
        return;
      }
      setValue(text);
    } catch {
      fieldRef.current?.focus();
    }
  }

  return (
    <>
    <div role="group" aria-label={label} data-slot="secret-field" className="relative mt-6 rounded-xl border-2 border-primary bg-card p-1.5 pt-9">
      {/* The edge row is 40px tall and hangs 20px over the top edge, so the label and the cross stand
          on the frame's own fill and the edge reads as cut behind them. */}
      <div className="absolute inset-x-2 -top-5 flex h-10 items-center justify-between gap-2">
        <span className="inline-flex min-w-0 items-center gap-1 bg-card px-1.5 text-xs font-medium text-primary">
          <Icon name="auth-token" className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
        {/* One circle: the cut in the edge, the button, its hover fill and its focus ring. */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-slot="secret-close"
          aria-label={t("composer.secret.close")}
          className="size-10 shrink-0 rounded-full bg-card"
          onClick={onClose}
        >
          <Icon name="close" className="size-4" />
        </Button>
      </div>
      <div className="flex items-center gap-1">
        <div className="flex min-h-9 min-w-0 flex-1 items-center py-1.5">
          <ChatInput
            ref={fieldRef}
            aria-label={label}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={lockedWhy ?? t("composer.secret.placeholder")}
            disabled={disabled}
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="send"
            rows={1}
            // Five whole lines of the field's own line height, so a long code scrolls with no half row.
            className={cn("min-w-0 max-h-[5lh] px-2 py-0", value !== "" && "font-mono", !shown && "[-webkit-text-security:disc]")}
          />
        </div>
        {value === "" ? (
          <Button type="button" variant="ghost" size="icon" data-slot="secret-paste" aria-label={t("composer.secret.paste")} className={ICON_BUTTON} disabled={disabled} onClick={() => void paste()}>
            <Icon name="paste" className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-slot="secret-show"
            aria-label={t(shown ? "composer.secret.hide" : "composer.secret.show")}
            aria-pressed={shown}
            className={ICON_BUTTON}
            onClick={() => setShown((was) => !was)}
          >
            <Icon name={shown ? "masked" : "show-ignored"} className="size-4" />
          </Button>
        )}
        <Button type="button" size="icon" data-slot="secret-send" aria-label={t("composer.secret.send")} aria-busy={sending} disabled={disabled || value.trim() === ""} className={ICON_BUTTON} onClick={() => void send()}>
          {sending ? <Icon name="busy" className="size-4 animate-spin" /> : <Icon name="send-ready" className="size-4" />}
        </Button>
      </div>
    </div>
    {/* Why the frame waits, when it is the lock or a launch and not a running send (M102 spec 11). */}
    <Collapse open={reason !== null}>
      {reason !== null && (
        <p data-slot="secret-reason" role="status" className="px-1 pt-1 text-xs leading-snug text-muted-foreground">
          {reason}
        </p>
      )}
    </Collapse>
    </>
  );
}
