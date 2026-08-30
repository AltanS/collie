import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { clearStatus, useStatus, type StatusTone } from "@/lib/status";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// A slim, self-contained status pill. Rendered inside a pointer-events-none positioning wrapper
// (`ui/toast-viewport.tsx`), it shows the latest status with a tone colour + icon. Non-errors fade
// on their own; errors persist and are tap-to-dismiss (the pill re-enables pointer events + shows
// an ✕ for that). Renders nothing when there's no status.
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

export function StatusArea({ className }: { className?: string }) {
  useLocale();
  const status = useStatus();
  if (!status) return null;
  const Icon = ICONS[status.tone];
  const dismissable = status.tone === "error";
  return (
    // Two elements, because there are two jobs. The <output> is the ANNOUNCEMENT (role=status +
    // aria-live), which must not be an interactive element; the dismiss is a real <button>, sized
    // over the whole pill so the phone keeps its generous tap target while a keyboard gets a
    // focusable, labelled control it never had.
    //
    // A PILL, NOT A BAR. It was a full-width slab with a border, and that shape was correct while it
    // held a row in the flex column: a thing that owns a row should own the row's width, or the page
    // has a ragged hole in it. It floats now (ui/toast-viewport.tsx), and a floating slab is a
    // different object — it spans the column edge to edge for two seconds to say one word, which
    // reads as a standing condition arriving rather than a note passing. Hugging the text is what
    // says "this is passing": the shape carries the duration, so the copy does not have to.
    //
    // `w-fit` sits on the WRAPPER, not on the <output>, and that is load-bearing: the dismiss button
    // below is `absolute inset-0`, so a wrapper wider than the pill would put a full-column
    // invisible tap target over the tab strip beneath it. The two must be the same box.
    <div
      key={status.id}
      className={cn(
        "relative mx-auto w-fit max-w-full",
        dismissable && "pointer-events-auto",
        className,
      )}
    >
      <output
        aria-live="polite"
        className={cn(
          // `rounded-full` over the house `rounded-md`: the house radius is for things that hold
          // space, and §3's own rule is that a pill is what a passing, self-sized thing wears.
          "flex items-center justify-center gap-1.5 rounded-full border bg-background/95 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur duration-200 animate-in fade-in",
          dismissable ? "border-status-blocked/50" : "border-border/60",
          TONE[status.tone],
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="truncate">{status.text}</span>
        {dismissable && <X className="size-3.5 shrink-0 opacity-70" />}
      </output>
      {dismissable && (
        <button
          type="button"
          aria-label={t("status.dismissAria")}
          onClick={() => clearStatus()}
          className="absolute inset-0 cursor-pointer rounded-md"
        />
      )}
    </div>
  );
}
