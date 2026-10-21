import { Notice } from "@/components/ui/notice";
import { WalkyIcon } from "@/components/walky-icon";
import { useLocale } from "@/hooks/use-locale";
import type { WalkyAim, WalkyNote } from "@/hooks/use-walky-composer";
import { t } from "@/lib/i18n";

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

export function WalkyNoteStrip({ note, onDismiss }: { note: WalkyNote; onDismiss: () => void }) {
  useLocale();
  return (
    <Notice
      tone={note.tone}
      variant="box"
      className="mb-2"
      announce={note.tone === "danger" ? "alert" : "status"}
      onDismiss={onDismiss}
      dismissLabel={t("walky.composer.dismiss")}
    >
      <span data-slot="walky-note">{note.text}</span>
    </Notice>
  );
}
