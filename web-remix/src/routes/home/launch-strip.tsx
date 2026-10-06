import { on, type Handle } from "remix/component";
import { LoaderCircle } from "lucide";

import { fetchLaunchers } from "@web/lib/api";
import { openForCount } from "@web/hooks/use-dash-prefs";
import { writeRefusal as hostRefusal } from "@web/lib/host-health";
import { scopeKey, type Scope } from "@web/lib/scope";
import { shortenHome } from "@web/lib/shorten-home";
import type { Launcher } from "@web/lib/types";
import { cn } from "@web/lib/utils";

import { crewOf } from "../../chips/crew";
import { creating, launch, launchKey } from "../../chips/space-actions";
import { address, snapshot } from "../../lib/data";
import { useLocale } from "../../lib/i18n-store";
import { scheduleUpdate, useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { FoldHeader } from "./fold-header";

// Port of web/src/components/launch-strip.tsx: the operator's own launcher rows (`launchers.toml`),
// one tap each. A tap creates a throwaway Space and types that row's command into its fresh shell;
// `launch()` (chips/space-actions.ts) holds the per-row in-flight mark, refuses on a read-only
// device, reports through the status line and opens the fresh pane.
//
// THE ROWS ARE THE AMBIENT SCOPE'S OWN. A crew peer keeps its own `launchers.toml`, and the lead's
// startup config can only answer for itself, so this reads `GET /api/launchers` on mount and whenever
// the ambient scope changes. A failed read is not an error state: the rows stay as they were (empty
// on a first failed read) and the next mount tries again. When the scope changes the old rows go at
// once: one machine's launchers are never shown for another.
//
// Nothing declared means no affordance at all, not an empty section; the section arrives and leaves
// through a Collapse, because the rows come from a read that lands after first paint (D §1). It folds
// on the same terms as Spaces: `open` is the dashboard's persisted choice, `null` or `undefined`
// (never chosen) resolves here against the row count, because this component owns the config read.
// Folded, the header still says how many there are.
//
// TIER 2 (§10.3): a crew row still shows when its host refuses writes, but the row is disabled with
// the reason, like any other write to that host.
const NO_ROWS: readonly Launcher[] = [];

export interface LaunchStripProps {
  /** Fold state, persisted by the dashboard. `null` / `undefined` = never chosen, the count decides. */
  open: boolean | null | undefined;
  onOpenChange: (open: boolean) => void;
}

export function LaunchStrip(handle: Handle<LaunchStripProps>) {
  useLocale(handle);
  const where = useStore(handle, address);
  const inFlight = useStore(handle, creating);
  const snap = useStore(handle, snapshot);
  let rows: readonly Launcher[] = NO_ROWS;
  let home = "";
  /** The scope key the rows on screen were asked for. */
  let askedKey: string | undefined;

  const load = (scope: Scope, key: string): void => {
    void (async () => {
      try {
        const res = await fetchLaunchers(scope.host === undefined && scope.session === undefined ? undefined : scope);
        if (handle.signal.aborted || askedKey !== key) return;
        rows = res.launchers;
        home = res.home;
        scheduleUpdate(handle);
      } catch {
        // A failed read leaves the rows as they were; a later mount tries again.
      }
    })();
  };

  return () => {
    const scope = where().scope;
    const key = scopeKey(scope);
    if (key !== askedKey) {
      const first = askedKey === undefined;
      askedKey = key;
      if (!first) {
        rows = NO_ROWS;
        home = "";
      }
      handle.queueTask(() => load(scope, key));
    }

    const expanded = openForCount(handle.props.open ?? null, rows.length);
    const refusal = scope.host === undefined || rows.length === 0 ? undefined : hostRefusal(crewOf(snap().data).health.get(scope.host));
    const flying = inFlight();

    return (
      <Collapse open={rows.length > 0}>
        <section class="flex flex-col gap-2 px-3 py-4" data-testid="launch-strip">
          <FoldHeader
            label="Launch"
            count={rows.length}
            open={expanded}
            onToggle={(next) => handle.props.onOpenChange(next)}
            controls="launch-body"
            testId="launch-strip-toggle"
          />

          <Collapse open={expanded}>
            <div id="launch-body" class="flex flex-wrap gap-2">
              {rows.map((launcher) => {
                // In flight: this row only. A launch takes a moment (the bridge waits for the new
                // shell to draw before typing), so the row says so and refuses a second tap; its
                // neighbours stay live, because another launcher is another intention.
                const pending = flying.has(launchKey(launcher.command));
                // Pinned: the folder, shortened under home. Absent: nothing.
                const suffix = launcher.cwd !== undefined ? shortenHome(launcher.cwd, home) : undefined;
                return (
                  // `size="lg"` is h-11, the same 44px target every other primary phone action gets;
                  // `outline` keeps a launcher from competing with the triage list for attention.
                  <Button
                    key={launcher.command}
                    type="button"
                    variant="outline"
                    size="lg"
                    data-testid="launcher"
                    data-command={launcher.command}
                    disabled={pending || refusal !== undefined}
                    aria-label={refusal}
                    title={refusal}
                    aria-busy={pending ? "true" : undefined}
                    // Undimmed while pending, like the Quick dock's tapped reply: the busy row is the
                    // one to look at, not the one to lose.
                    class={cn("h-auto flex-col items-start gap-0 py-1.5", pending && "disabled:opacity-100")}
                    mix={on("click", () => void launch(launcher.command))}
                  >
                    <span class="flex items-center gap-1.5">
                      {pending && <Icon icon={LoaderCircle} class="size-4 animate-spin" />}
                      <span>{launcher.label}</span>
                      {suffix && <span class="font-mono text-xs text-muted-foreground">{suffix}</span>}
                    </span>
                    {/* The command is operator-authored text going into a text node, never markup. */}
                    <span class="font-mono text-xs font-normal text-muted-foreground">{launcher.command}</span>
                  </Button>
                );
              })}
            </div>
          </Collapse>
        </section>
      </Collapse>
    );
  };
}
