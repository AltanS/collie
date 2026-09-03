import { Loader2 } from "lucide-react";

import { usePack } from "@/components/pack-provider";
import { Button } from "@/components/ui/button";
import { SectionHeader } from "@/components/section-header";
import { openForCount } from "@/hooks/use-dash-prefs";
import { writeRefusal } from "@/lib/host-health";
import { useLaunchers } from "@/lib/launchers";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
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
  /** The ambient scope — which host's rows this strip reads and, in a pack, which one may refuse. */
  scope?: Scope;
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
export function LaunchStrip({ open, onOpenChange, scope }: LaunchStripProps) {
  const { launchers, home } = useLaunchers(scope);
  const { launch, launching } = useSpaceActions();
  // TIER 2 (§10.3): a pack row still shows when its host refuses writes — a departed/incompatible
  // member's rows are exactly as informative as its panes are — but the row itself is disabled with
  // the reason, same as any other write to that host.
  const { health } = usePack();
  const refusal = scope?.host === undefined ? undefined : writeRefusal(health.get(scope.host));

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
            const disabled = pending || refusal !== undefined;
            // Pinned → the folder, shortened under home. Absent → nothing: from the dashboard the
            // implied folder is already home, so a suffix would say nothing the label didn't
            // (contrast the switcher's "here", which opens beside a specific pane instead).
            const suffix = launcher.cwd !== undefined ? shortenHome(launcher.cwd, home) : undefined;
            return (
              // `size="lg"` is h-11 — the same 44px target every other primary phone action gets —
              // and `outline` keeps a launcher from competing with the triage list for attention.
              <Button
                key={launcher.command}
                type="button"
                variant="outline"
                size="lg"
                disabled={disabled}
                aria-label={refusal}
                title={refusal}
                // Undimmed while pending, like the Quick dock's tapped reply: the busy row is the
                // one to look at, not the one to lose.
                className={cn("h-auto flex-col items-start gap-0 py-1.5", pending && "disabled:opacity-100")}
                onClick={() => void launch(launcher.command)}
              >
                <span className="flex items-center gap-1.5">
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  <span>{launcher.label}</span>
                  {suffix && <span className="font-mono text-xs text-muted-foreground">{suffix}</span>}
                </span>
                {/* The command is operator-authored text going into a text node, never markup. */}
                <span className="font-mono text-xs font-normal text-muted-foreground">{launcher.command}</span>
              </Button>
            );
          })}
        </div>
      )}
    </section>
  );
}
