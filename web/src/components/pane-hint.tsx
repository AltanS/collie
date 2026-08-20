import { Info } from "lucide-react";

// THE PANE HINT — a sentence the bridge composed, rendered as text and nothing else.
//
// It is the whole of the frontend's part in M11/05: the bridge decides whether a pane gets one and
// what it says (`bridge/beacon/hint.ts`), so nothing here parses it, branches on it or infers a
// harness, a multiplexer or a status from it. That split is why no name crosses into `web/src` and
// why `scripts/check-mux-names.sh` stays green by the data property rather than by an exclusion.
//
// It renders nothing at all when there is no sentence — an explanation with no words is worse than
// none (the rule `lib/mux-capability.ts` already states for adapter notes).

/** A pane's own sentence, when the bridge sent one. */
export function PaneHint({ hint }: { hint?: string }) {
  if (!hint) return null;
  return (
    <p className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-muted-foreground">
      <Info className="mt-px size-3.5 shrink-0" aria-hidden />
      {/* Wrapped, not truncated: it is one sentence and half of it explains nothing. */}
      <span className="min-w-0">{hint}</span>
    </p>
  );
}
