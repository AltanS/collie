import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";
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
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
} satisfies Record<StatusTone, string>;

const ICONS = {
  info: Info,
  success: CheckCircle2,
  warn: AlertTriangle,
  error: AlertCircle,
} as const;

export function HeaderStatus({ children }: { children: ReactNode }) {
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
  if (!status) return <>{children}</>;
  const Icon = ICONS[status.tone];
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
      {/* `<output>` carries an implicit ARIA role of "status" — the same announcement contract
          StatusArea's own `<output>` made, kept verbatim. */}
      <output
        aria-live="polite"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 truncate text-sm font-semibold",
          TONE[status.tone],
        )}
      >
        <Icon className="size-4 shrink-0" />
        <span className="truncate">{status.text}</span>
      </output>
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
            <X className="size-4 opacity-70" />
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
