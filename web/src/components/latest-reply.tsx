import { ChevronRight } from "lucide-react";

import { TranscriptView } from "@/components/transcript-view";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { TranscriptEntry } from "@/lib/types";

// The agent's newest reply, standing IN PLACE OF the mirror rows that could only hold its end.
//
// Rendered by AgentChat only when lib/latest-reply.ts says the message on screen is this one and its
// opening has scrolled off. AgentChat hides the rows it covers (AnsiOutput's `hideLeadingLines`), so
// the two never print the same words twice: this card, then the mirror picking up exactly where the
// message finished — tool calls, a dialog, the cursor, all untouched.
//
// Open state is the PARENT's, because it decides what the mirror shows: collapsing here is "give me
// the raw rows back", so the hiding and the folding have to be one decision, not two that can drift.
//
// This is a TRANSCRIPT surface, not a mirror one: it goes through TranscriptView, so it renders
// Markdown in ordinary app theming and never touches MIRROR_SPACE (ADR 0002 has nothing to say about
// it). The XSS boundary is the one TranscriptView and MarkdownText already own — React elements from
// an AST, never a constructed HTML string.
export function LatestReply({
  entry,
  agent,
  open,
  onToggle,
}: {
  entry: TranscriptEntry;
  agent?: string;
  /** Expanded shows the message and the mirror rows below it stay hidden; collapsed does the reverse. */
  open: boolean;
  onToggle: () => void;
}) {
  useLocale();
  return (
    <div className="mb-2 rounded-lg border bg-muted/30">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left transition-colors active:bg-muted/60"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          {t("chat.fullReply.title")}
        </span>
        {/* Says which of the two sources you are looking at, since the toggle swaps them rather than
            hiding one. */}
        <span className="ml-auto truncate text-[11px] text-muted-foreground">
          {open ? t("chat.fullReply.fromTranscript") : t("chat.fullReply.showingTerminal")}
        </span>
      </button>
      {open && (
        <div className="border-t px-2.5 py-2">
          <TranscriptView entries={[entry]} agent={agent} />
        </div>
      )}
    </div>
  );
}
