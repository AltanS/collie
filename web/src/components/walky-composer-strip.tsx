import { Button } from "@/components/ui/button";
import { NOTICE_ACTION, Notice } from "@/components/ui/notice";
import { DeliverNowButton } from "@/components/walky-deliver-button";
import { WalkyIcon } from "@/components/walky-icon";
import { useDeliverNow } from "@/hooks/use-deliver-now";
import { useLocale } from "@/hooks/use-locale";
import type { WalkyAim, WalkyNote } from "@/hooks/use-walky-composer";
import { t, tn } from "@/lib/i18n";
import type { DeliverNow } from "@/lib/walky";

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
 * The held mark (M62 spec 03): "N messages wait while you type", for the owner of the pane whose box
 * they wait for. A tap opens the pane's Messages sheet, where each held row has its Drop. The whole
 * notice is the tap, so it needs no control of its own; it goes when nothing is held any more.
 *
 * Deliver now (prototype): for a LINKED pane with exactly one message waiting (`deliverId`, the id of that
 * message), the mark carries a second line, the button "Deliver now" and "Your text stays in the box." The
 * button hands the message to the agent as data and leaves the person's text alone. The notice then cannot be
 * one whole tap (a control inside a tap is not allowed, see `ui/notice.tsx`), so the first line becomes the
 * button that opens the sheet. With more than one message, or a pane that is not linked, the mark is drawn
 * as it always was.
 */
export function WalkyHeldStrip({
  count,
  onOpen,
  linked = false,
  deliverId,
  onDeliverNow,
}: {
  count: number;
  onOpen: () => void;
  linked?: boolean | undefined;
  deliverId?: string | undefined;
  onDeliverNow?: DeliverNow | undefined;
}) {
  useLocale();
  if (linked && count === 1 && deliverId !== undefined && onDeliverNow !== undefined) {
    return <WalkyHeldDeliverStrip count={count} onOpen={onOpen} deliverId={deliverId} onDeliverNow={onDeliverNow} />;
  }
  return (
    <Notice tone="info" variant="box" className="mb-2" announce="status" icon={<WalkyIcon />} onActivate={onOpen}>
      <span data-slot="walky-held">{tn("walky.held.waits", count)}</span>
    </Notice>
  );
}

function WalkyHeldDeliverStrip({ count, onOpen, deliverId, onDeliverNow }: { count: number; onOpen: () => void; deliverId: string; onDeliverNow: DeliverNow }) {
  // The mark exists only while a message is held, so it is held for as long as this is drawn.
  const delivery = useDeliverNow(true, onDeliverNow);
  return (
    <Notice tone={delivery.error === null ? "info" : "danger"} variant="box" className="mb-2" announce="status" icon={<WalkyIcon />}>
      {/* The words open the sheet. A real 32px height, so its tap and the button's below do not overlap. */}
      <button type="button" data-slot="walky-held-open" onClick={onOpen} className="flex min-h-8 w-full items-center text-left">
        <span data-slot="walky-held">{tn("walky.held.waits", count)}</span>
      </button>
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-normal">
        <DeliverNowButton variant="outline" className={NOTICE_ACTION} busy={delivery.busy} onClick={() => void delivery.run(deliverId)} />
        <span data-slot="walky-held-stays" className="min-w-0 flex-1">
          {t("walky.held.deliverStays")}
        </span>
      </span>
      {delivery.error !== null && (
        <span data-slot="walky-deliver-note" className="mt-1 block font-normal">
          {delivery.error}
        </span>
      )}
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
