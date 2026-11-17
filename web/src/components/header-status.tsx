import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { clearStatus, useStatus, type StatusTone } from "@/lib/status";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { StatusDetailSheet } from "@/components/status-detail-sheet";

/**
 * The pane screen's status (lib/status.ts), living in the header's TITLE SLOT instead of floating
 * over the tab strip.
 *
 * It used to be a `<ToastViewport dock="top">` absolute over the content region — chosen, per that
 * file's own doc, because the bottom of this screen is the composer. That argument was sound and
 * still is; the flaw was the other end of the trade. "Top" on the pane screen is the tab strip and
 * the pane strip, and the tab strip's own "+" (new tab) sits exactly there — so the FIRST status a
 * new tab ever earns ("Tab ready") landed on the control the operator had just tapped to make it.
 * The strip was never free real estate; it is where the control you just pressed lives.
 *
 * The header title, by contrast, is text nobody is reading in the two seconds a status shows —
 * the pane's own name and path sit still, unread, the whole time an agent is running — and the
 * controls beside it (back, the ⋮ menu) never move, because this component only ever swaps what
 * `RouteHeader`'s `children` slot receives. Same box, same height: whichever of `children` or the
 * status text is showing, the box around it is the caller's own (the pane's identity button already
 * states `min-h-11`), so the header never grows or shrinks to say a word passed.
 *
 * Zen mode has no header row at all, so it keeps the old bottom-docked `ToastViewport` — there is
 * no title slot to ride in there. This component is the pane screen's non-zen path only.
 */
const TONE = {
  info: "text-muted-foreground",
  note: "text-status-info",
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
} satisfies Record<StatusTone, string>;

const ICONS = {
  info: "info",
  note: "info",
  success: "success",
  warn: "warning",
  error: "error",
} as const satisfies Record<StatusTone, IconKey>;

/**
 * A state of the screen that holds for as long as it is true, not an event: shown in the title
 * slot while no event status is, in the `note` look (the pane's "Starting…"). It has no dismiss
 * button, because the screen ends it, and an event status always outranks it.
 */
export interface HeaderCondition {
  text: string;
  tone: StatusTone;
}

/** The status line itself, shared by an event and a condition so the two are the same box. */
function StatusLine({ tone, text }: { tone: StatusTone; text: string }) {
  return (
    // `<output>` carries an implicit ARIA role of "status" — the same announcement contract
    // StatusArea's own `<output>` made, kept verbatim.
    <output
      aria-live="polite"
      className={cn("flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold", TONE[tone])}
    >
      <Icon name={ICONS[tone]} className="size-4 shrink-0" />
      <span className="truncate">{text}</span>
    </output>
  );
}

export function HeaderStatus({ children, condition }: { children: ReactNode; condition?: HeaderCondition }) {
  useLocale();
  const status = useStatus();
  // The full message, in a sheet, for the one row that cannot hold it — see StatusDetailSheet.
  const [detail, setDetail] = useState(false);
  // A NEW error must not inherit the old one's open sheet. `status.id` is monotone per publish, so
  // this closes on every republish, including one error replacing another with the same words —
  // which is the case a text comparison would miss. It also covers the status clearing entirely,
  // where leaving the sheet up would strand the operator on a message nothing is showing any more.
  const statusId = status?.id;
  useEffect(() => {
    setDetail(false);
  }, [statusId]);
  // A condition (the pane's "Starting…") holds the title slot while no event status is showing, and over a word that
  // would ride BESIDE the identity: the condition replaces the identity, so a beside word has no name to stand beside.
  if (condition && (!status || status.beside === true)) {
    return (
      <div data-slot="header-condition" className="relative flex min-h-11 min-w-0 flex-1 items-center">
        <StatusLine tone={condition.tone} text={condition.text} />
      </div>
    );
  }
  // A word that stands BESIDE the identity (M104, `beside`): "Sent" after a send. The name and the time stay where
  // they are, in the same place in the tree (no wrapper, so nothing remounts and no box changes size); the word rides
  // at the right end of the name's line, in its free room, over the header's own ground (`header-center` is its
  // containing block), and leaves no box behind, so the header's height and every line in it stay as they were.
  if (!status || status.beside === true) {
    return (
      <>
        {children}
        {status && (
          <output
            key={status.id}
            aria-live="polite"
            data-slot="header-status"
            data-beside=""
            className={cn(
              "pointer-events-none absolute right-0 top-1 flex h-5 items-center gap-1.5 bg-band-ground pl-2 text-sm font-semibold",
              TONE[status.tone],
            )}
          >
            <Icon name={ICONS[status.tone]} className="size-4 shrink-0" />
            <span className="whitespace-nowrap">{status.text}</span>
          </output>
        )}
      </>
    );
  }
  // Errors persist (lib/status.ts's own default ttl) until dismissed. The row used to be ONE target
  // that dismissed them outright, which was the only thing you could do with a sentence the row had
  // cut in half. It is now two: the text opens the whole message, and the ✕ beside it still clears
  // in one tap. Both, not one — routing every dismissal through the sheet would have charged two
  // taps for "Connection lost", a sentence that was never truncated and needs no reading.
  const dismissable = status.tone === "error";
  return (
    <div
      key={status.id}
      data-slot="header-status"
      className={cn("relative flex min-h-11 min-w-0 flex-1 items-center", dismissable && "pointer-events-auto")}
    >
      <StatusLine tone={status.tone} text={status.text} />
      {dismissable && (
        <>
          <button
            type="button"
            aria-label={t("status.detailAria")}
            onClick={() => setDetail(true)}
            className="absolute inset-0 rounded-lg"
          />
          {/* After the overlay in DOM order, so it paints above it and takes its own taps. The
              house floor for anything tappable is `size-11` (DESIGN.md §6), and it costs the text
              44px it can now afford to lose — the sentence has somewhere to go. */}
          <button
            type="button"
            aria-label={t("status.dismissAria")}
            onClick={() => clearStatus()}
            className="relative flex size-11 shrink-0 items-center justify-center rounded-lg"
          >
            <Icon name="dismiss" className="size-4 opacity-70" />
          </button>
          <StatusDetailSheet
            open={detail}
            text={status.text}
            onClose={() => setDetail(false)}
            onDismiss={() => {
              setDetail(false);
              clearStatus();
            }}
          />
        </>
      )}
    </div>
  );
}
