import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/section-header";
import { openForCount } from "@/hooks/use-dash-prefs";
import { useLaunchers } from "@/lib/operator-config";
import { useSpaceActions } from "@/hooks/use-spaces";
import { cn } from "@/lib/utils";

interface LaunchStripProps {
  /**
   * Fold state, owned by the dashboard so it can be persisted (like Spaces and Recent). `null` =
   * never chosen, resolved here against the row count — this component owns the config read, so the
   * count is not the route's to know.
   */
  open: boolean | null;
  onOpenChange: (open: boolean) => void;
}

// The operator's own launcher rows (`launchers.toml`), one tap each. A tap creates a throwaway Space
// and types that row's command into its fresh shell — Herdr deletes a Space whose last pane closes,
// so a command that closes its own pane leaves nothing behind to tidy up. The tap reuses the same
// fresh-pane navigation a tab/space create uses, so you land in the new shell immediately while a
// revalidate catches the snapshot up.
//
// It folds, on the same terms as Spaces and Recent, because it is the one dashboard section whose
// height is set by a config file: `flex-wrap` fits two labels per row on a phone, so six launchers
// is three rows of buttons between the herd you came to read and the navigator below it. Folded, the
// header still says how many there are — the count is the reason to unfold.
export function LaunchStrip({ open, onOpenChange }: LaunchStripProps) {
  const launchers = useLaunchers();
  const { launch, launching } = useSpaceActions();

  // Nothing declared → no affordance at all, not an empty section. Worth a comment because an early
  // return like this reads as a forgotten empty state, when it is the intended default for every
  // install without a `launchers.toml`: that dashboard is byte-for-byte the one they had.
  if (launchers.length === 0) return null;

  const expanded = openForCount(open, launchers.length);

  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <SectionHeader
        label="Launch"
        count={launchers.length}
        open={expanded}
        onToggle={onOpenChange}
        controls="launch-body"
      />

      {expanded && (
        <div id="launch-body" className="flex flex-wrap gap-2">
          {launchers.map((launcher) => {
            // In flight → this row only. A launch takes a moment (the bridge waits for the new
            // shell to draw before typing), so the row says so and refuses a second tap; its
            // neighbours stay live, because another launcher is another intention.
            const pending = launching.has(launcher.command);
            return (
              // `size="lg"` is h-11 — the same 44px target every other primary phone action gets —
              // and `outline` keeps a launcher from competing with the triage list for attention.
              <Button
                key={launcher.command}
                type="button"
                variant="outline"
                size="lg"
                disabled={pending}
                // Undimmed while pending, like the Quick dock's tapped reply: the busy row is the
                // one to look at, not the one to lose.
                className={cn(pending && "disabled:opacity-100")}
                onClick={() => void launch(launcher.command)}
              >
                {pending && <Loader2 className="size-4 animate-spin" />}
                {launcher.label}
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
