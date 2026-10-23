import { Button } from "@/components/ui/button";
import { NOTICE_ACTION, Notice } from "@/components/ui/notice";
import { WalkyIcon } from "@/components/walky-icon";
import { useLocale } from "@/hooks/use-locale";
import type { WalkyAim, WalkyNote } from "@/hooks/use-walky-composer";
import { t, tn } from "@/lib/i18n";

// What the composer says while a message is on its way (M62 spec 05): the target of a reply, which
// stands until the person turns it off, and the outcome of the last message, which stands until it is
// dismissed. Both are CONDITIONS with their own control, so they sit in the strip slot above the box
// with the other armed-mode strips and never in the top pills (components/composer.tsx).

export function WalkyAimStrip({ aim, onCancel }: { aim: WalkyAim; onCancel: () => void }) {
  useLocale();
  return (
    <Notice
      tone="info"
      variant="box"
      className="mb-2"
      icon={<WalkyIcon />}
      onDismiss={onCancel}
      dismissLabel={t("walky.composer.cancel")}
    >
      <span data-slot="walky-aim">{t("walky.composer.replyTo", { label: aim.label })}</span>
    </Notice>
  );
}

/**
 * The held mark (M62 spec 03): "N messages wait for the box to clear", for the owner of the pane whose
 * box they wait for. A tap opens the pane's Messages sheet, where each held row has its Drop. The whole
 * notice is the tap, so it needs no control of its own; it goes when nothing is held any more.
 */
export function WalkyHeldStrip({ count, onOpen }: { count: number; onOpen: () => void }) {
  useLocale();
  return (
    <Notice tone="info" variant="box" className="mb-2" announce="status" icon={<WalkyIcon />} onActivate={onOpen}>
      <span data-slot="walky-held">{tn("walky.held.mark", count)}</span>
    </Notice>
  );
}

/**
 * The outcome line. While the message it follows is held (M62 spec 03) the line carries Cancel: the sender's
 * way to take the message back before the box clears. `onCancel` is null otherwise.
 */
export function WalkyNoteStrip({ note, onDismiss, onCancel = null }: { note: WalkyNote; onDismiss: () => void; onCancel?: (() => void) | null }) {
  useLocale();
  return (
    <Notice
      tone={note.tone}
      variant="box"
      className="mb-2"
      announce={note.tone === "danger" ? "alert" : "status"}
      onDismiss={onDismiss}
      dismissLabel={t("walky.composer.dismiss")}
      action={
        onCancel === null ? undefined : (
          <Button variant="ghost" size="sm" className={NOTICE_ACTION} data-slot="walky-note-cancel" onClick={onCancel}>
            {t("walky.sheet.cancel")}
          </Button>
        )
      }
    >
      <span data-slot="walky-note">{note.text}</span>
    </Notice>
  );
}
