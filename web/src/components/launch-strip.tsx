import { Icon } from "@/components/icons/icon";

import { useCrew } from "@/components/crew-provider";
import { Button } from "@/components/ui/button";
import { Collapse } from "@/components/ui/collapse";
import { SectionHeader } from "@/components/section-header";
import { openForCount } from "@/hooks/use-dash-prefs";
import { writeRefusal } from "@/lib/host-health";
import { useLaunchers } from "@/lib/launchers";
import { ANSWER_MAX_COUNT, useRememberedAnswer } from "@/lib/remembered-shape";
import type { Scope } from "@/lib/scope";
import { shortenHome } from "@/lib/shorten-home";
import { useNoPromptsGuard } from "@/hooks/use-no-prompts-guard";
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
  /** The ambient scope — which host's rows this strip reads and, in a crew, which one may refuse. */
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
//
// CALM LOAD. The rows are read on every mount, after the first paint, so the section used to enter in
// the middle of the dashboard and push the Spaces, Programs and the footer down. The device now
// remembers HOW MANY rows the front machine had (lib/remembered-shape.ts, a number from 0 to 99, never
// a label or a command): the header is drawn with that count from the first frame, and the body, whose
// height only the rows know, eases in under it (`Collapse`) when the read lands. A device with no
// memory, a remembered 0 and a crew member's or a session's launchers, which the front machine's one
// key cannot speak for, draw as before. A real read replaces the memory in full, so a section the
// operator removed goes when the read says so.
export function LaunchStrip({ open, onOpenChange, scope }: LaunchStripProps) {
  const { launchers, home, loadedFor } = useLaunchers(scope);
  const front = scope?.host === undefined && scope?.session === undefined;
  const rememberedCount = useRememberedAnswer("home-launch-count", front && loadedFor !== null ? Math.min(launchers.length, ANSWER_MAX_COUNT) : undefined, scope?.host);
  const count = launchers.length > 0 || loadedFor !== null || !front ? launchers.length : (rememberedCount ?? 0);
  const { launch, launching } = useSpaceActions();
  // A row that skips permission prompts is confirmed once per device before it starts (ADR 0094).
  const { guard, sheet } = useNoPromptsGuard();
  // TIER 2 (§10.3): a crew row still shows when its host refuses writes — a departed/incompatible
  // member's rows are exactly as informative as its panes are — but the row itself is disabled with
  // the reason, same as any other write to that host.
  const { health } = useCrew();
  const refusal = scope?.host === undefined ? undefined : writeRefusal(health.get(scope.host));

  // Nothing declared → no affordance at all, not an empty section. Worth a comment because an early
  // return like this reads as a forgotten empty state, when it is the intended default for every
  // install without a `launchers.toml`: that dashboard is byte-for-byte the one they had.
  if (count === 0) return null;

  const expanded = openForCount(open, count);

  return (
    <section className="flex flex-col gap-2 px-3 py-4">
      <SectionHeader
        label="Launch"
        count={count}
        open={expanded}
        onToggle={onOpenChange}
        controls="launch-body"
      />

      {expanded && (
        // The body mounts with the fold open, as before; only a body that waits for its rows eases in.
        <Collapse open={launchers.length > 0}>
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
                onClick={() =>
                  guard({
                    item: launcher,
                    machine: scope?.host ?? "",
                    folder: suffix ?? "~",
                    go: () => void launch(launcher.command, undefined, launcher.kind === "agent" ? launcher.harness : undefined),
                  })
                }
              >
                <span className="flex items-center gap-1.5">
                  {pending && <Icon name="busy" className="size-4 animate-spin" />}
                  <span>{launcher.label}</span>
                  {suffix && <span className="font-mono text-xs text-muted-foreground">{suffix}</span>}
                </span>
                {/* The command is operator-authored text going into a text node, never markup. */}
                <span className="font-mono text-xs font-normal text-muted-foreground">{launcher.command}</span>
              </Button>
            );
          })}
        </div>
        </Collapse>
      )}
      {sheet}
    </section>
  );
}
