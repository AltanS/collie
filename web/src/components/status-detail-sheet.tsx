import { useState } from "react";
import { Copy } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/**
 * THE WHOLE OF AN ERROR, for the one row that cannot hold it.
 *
 * `HeaderStatus` puts the status in the header's title slot, which is a single truncating line —
 * that is what keeps the header from growing or shifting when a word passes, and it is not a
 * constraint worth trading away for the rare long message. So the row stays one line and the
 * message gets somewhere to be read in full: tapping an error opens this.
 *
 * ERRORS ONLY, deliberately. An info or success line is short by construction (the app writes them),
 * auto-clears in 2.5 seconds, and has nothing behind it worth a tap. An error is the one tone whose
 * text comes from somewhere else — the bridge's own sentence, a multiplexer's refusal passed
 * through, a transport failure's `message` — so it is the one tone that can arrive longer than a
 * phone row and the one an operator needs verbatim to act on or report.
 *
 * Copy is here for that last reason and is not decoration: an error worth a bug report is an error
 * worth pasting, and a truncated line cannot be selected out of a header.
 */
export function StatusDetailSheet({
  open,
  text,
  onClose,
  onDismiss,
}: {
  open: boolean;
  /** The full message — the same string the header row truncates, never a re-derived one. */
  text: string;
  /** Close the sheet and leave the status where it is. Backdrop, Escape, and Close all land here. */
  onClose: () => void;
  /** Close the sheet AND clear the status. The tap that used to be the header row's own. */
  onDismiss: () => void;
}) {
  useLocale();
  // Reset by the sheet closing, so re-opening never shows a stale "Copied". `navigator.clipboard`
  // is absent over plain HTTP (an insecure context), which is a supported way to run Collie — so a
  // failure here leaves the button saying what it always said rather than claiming a copy.
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  function close() {
    setCopied(false);
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={close} title={t("status.detail.title")}>
      <div className="flex flex-col gap-3">
        {/* `font-mono` and `whitespace-pre-wrap`: this is the bridge's or the multiplexer's own
            words, not the app's, and a path or a shell fragment in it has to survive being read.
            Scrolls rather than growing, so a very long refusal cannot push the buttons off screen. */}
        <p className="max-h-[50dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted px-3 py-2 font-mono text-sm">
          {text}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="lg" className="flex-1" onClick={() => void copy()}>
            <Copy className="size-4" />
            {copied ? t("status.detail.copied") : t("status.detail.copy")}
          </Button>
          {/* Dismissing is the destructive-ish half (the message is gone once cleared), so it is the
              named action and closing is the default one. */}
          <Button
            type="button"
            variant="secondary"
            size="lg"
            className="flex-1"
            onClick={() => {
              setCopied(false);
              onDismiss();
            }}
          >
            {t("status.detail.dismiss")}
          </Button>
        </div>
      </div>
    </BottomSheet>
  );
}
