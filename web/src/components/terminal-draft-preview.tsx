import { Terminal } from "lucide-react";

import { Button } from "@/components/ui/button";

interface TerminalDraftPreviewProps {
  /** The live host/terminal draft text — the caller feeds it the RAW per-poll line, so host typing
   * streams in here. Display-only: this component never writes back into the composer. */
  text: string;
  /** Deliberate takeover — copy the current draft into the phone-owned composer and hide the preview. */
  onTakeOver: () => void;
}

// A read-only preview of a draft stranded on the terminal's "❯" line (a message queued then recalled
// on the HOST, which stripChrome hides from the mirror). The composer input is exclusively phone-owned
// — a host draft is NEVER written into it implicitly. Instead we surface it here and let the user
// deliberately Take over (copy it into the composer) so the two live input surfaces never fight. Its
// TEXT tracks the live line, so watching the host type streams straight into this block; that can't
// glitch the phone's field because nothing here feeds back into it. There is no dismiss: the preview is
// honest state — a draft really is stranded on the host's line — so it persists until the user takes it
// over, sends a message (which sweeps the host line), or the host line clears on its own. Same
// zinc/text-xs chip chrome as the composer's "You sent:" strip; the draft body clamps to a few readable
// lines.
export function TerminalDraftPreview({ text, onTakeOver }: TerminalDraftPreviewProps) {
  return (
    <div className="mb-2 flex items-start gap-1.5 rounded-md bg-muted/40 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Terminal className="mt-0.5 size-3 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">Draft in terminal</div>
        <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-muted-foreground/90">
          {text}
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 shrink-0 self-center px-2 text-xs font-medium"
        onClick={onTakeOver}
      >
        Take over
      </Button>
    </div>
  );
}
