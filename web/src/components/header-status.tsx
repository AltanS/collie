import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { clearStatus, useStatus, type StatusTone } from "@/lib/status";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

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
  if (!status) return <>{children}</>;
  const Icon = ICONS[status.tone];
  // Errors persist (lib/status.ts's own default ttl) until dismissed — StatusArea's toast let you
  // tap it away; this is the same contract in the new spot, a tap-sized button laid over the same
  // box rather than a visible ✕, so the status text isn't crowded on a row this narrow.
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
        <button
          type="button"
          aria-label={t("status.dismissAria")}
          onClick={() => clearStatus()}
          className="absolute inset-0 rounded-lg"
        />
      )}
    </div>
  );
}
