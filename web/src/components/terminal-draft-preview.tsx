import { Terminal, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";

interface TerminalDraftPreviewProps {
  /** The live host/terminal draft text — the caller feeds it the RAW per-poll line, so host typing
   * streams in here. Display-only: this component never writes back into the composer. */
  text: string;
  /** Deliberate takeover — copy the current draft into the phone-owned composer and hide the preview.
   * `null` withdraws the affordance: the line holds the harness's OWN opaque token rather than the
   * user's words (Claude collapses a long paste into `[Pasted text #N +M lines]`), and copying that
   * into the composer would make the literal string the message. The preview still shows it. */
  onTakeOver: (() => void) | null;
  /** The x: hide the notice until this draft is gone (ADR 0061). The composer owns the lifetime. */
  onDismiss: () => void;
}

/**
 * The 44px floor for the x, bought back as hit area (DESIGN.md §6): the face is `size-6`, 24px, and
 * `-inset-2.5` reaches 10px out on every side, so 24 + 20 = 44 in both axes.
 */
const DISMISS_TAP_TARGET = "relative before:absolute before:-inset-2.5 before:content-['']";

// A read-only notice for a draft stranded on the terminal's "❯" line (a message queued then recalled
// on the HOST, which stripChrome hides from the mirror). The composer input is exclusively
// phone-owned — a host draft is NEVER written into it implicitly. Instead we surface it here and let
// the user deliberately Take over (copy it into the composer) so the two live input surfaces never
// fight. Its TEXT tracks the live line, so watching the host type streams straight into this block;
// that can't glitch the phone's field because nothing here feeds back into it.
//
// IT FLOATS (ADR 0061). It used to be an in-flow strip under the belt, so every host keystroke that
// stranded or cleared a draft grew and shrank the footer and moved the belt, the field and the
// mirror's tail. Now the composer draws it over the bottom edge of the mirror, out of the layout: a
// translucent card that covers terminal text and moves nothing. The x hides it until this draft is
// gone; Take over is withdrawn (absent, not greyed) when the line is only the harness's own paste
// placeholder — see `onTakeOver`.
export function TerminalDraftPreview({ text, onTakeOver, onDismiss }: TerminalDraftPreviewProps) {
  useLocale();
  return (
    <div
      className="pointer-events-auto flex items-start gap-1.5 rounded-lg border border-foreground/20 bg-card/95 py-1.5 pr-1.5 pl-2.5 text-xs text-muted-foreground shadow-md backdrop-blur-sm"
    >
      <Terminal className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("composer.draftPreview.title")}</div>
        <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground/90">
          {text}
        </div>
      </div>
      {onTakeOver !== null && (
        <Button
          variant="ghost"
          size="sm"
          className="h-6 shrink-0 self-center px-2 text-xs font-medium"
          onClick={onTakeOver}
        >
          {t("composer.draftPreview.takeOver")}
        </Button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t("composer.draftPreview.dismissAria")}
        className={`${DISMISS_TAP_TARGET} grid size-6 shrink-0 self-center place-items-center rounded-full text-muted-foreground transition-colors active:bg-muted/60`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
