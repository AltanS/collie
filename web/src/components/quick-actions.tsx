import { useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ECHO_DONE_MS, useActionEcho } from "@/hooks/use-action-echo";
import type { EchoPhase } from "@/hooks/use-action-echo";
import { useOperatorQuickReplies } from "@/lib/operator-config";
import { quickRepliesFor } from "@/lib/quick-replies";
import { t as translate } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

interface QuickActionsContentProps {
  /** Resolves true once the reply is verified sent — drives the ✓ and the deferred close. */
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
  /** The pane's agent + kind — pick the reply set (lib/quick-replies). A shell gets y/n, not "skip". */
  agent: string | undefined | null;
  isShell: boolean;
  disabled?: boolean;
}

/** `quickRepliesFor`'s group titles are catalog identifiers ("confirm"/"common"), not display text —
 *  translate them here rather than in the data (lib/quick-replies.ts is the sent-verbatim catalog,
 *  a different content class from a UI label). Unknown ids (a future catalog entry) fall back to the
 *  raw identifier rather than throwing. */
function groupTitle(title: string): string {
  return title === "confirm"
    ? translate("quickActions.group.confirm")
    : title === "common"
      ? translate("quickActions.group.common")
      : title;
}

// Module-level so it isn't a fresh component type each render (which would remount the grid).
function Group({
  title,
  items,
  cols,
  disabled,
  busy,
  phaseOf,
  onFire,
}: {
  title: string;
  items: readonly string[];
  cols: string;
  disabled?: boolean;
  /** Some reply in the dock is in flight — the untapped siblings dim and lock out. */
  busy: boolean;
  phaseOf: (id: string) => EchoPhase;
  onFire: (text: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className={`grid gap-2 ${cols}`}>
        {items.map((t) => {
          const phase = phaseOf(t);
          return (
            <Button
              key={t}
              type="button"
              // The tapped reply goes accent (and stays undimmed under `disabled`, so it reads over
              // its dimmed siblings) — the same busy language the dialog option rows use.
              variant={phase === "idle" ? "outline" : "default"}
              disabled={disabled || busy}
              onClick={() => onFire(t)}
              className={cn(
                "h-12 gap-1.5 text-sm font-medium",
                phase !== "idle" && "disabled:opacity-100",
              )}
            >
              {phase === "pending" && <Loader2 className="size-4 animate-spin" />}
              {phase === "done" && <Check className="size-4" />}
              {t}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

// The Quick-actions body — the two one-tap reply grids, no chrome of its own. Docked in-flow by the
// composer (same ComposerDock wrapper as Keys), so it never covers the mirror. Padding matches
// NavTray so both docks read identically.
//
// The dock deliberately stays up THROUGH the send. It used to close on the tap itself, which meant
// the reply's only acknowledgement — the ✓ on the composer's Send button — flashed a second later on
// a surface you'd already been navigated away from, so a quick reply felt like it vanished into
// nothing. Now the tapped button owns its own feedback (spinner → ✓, siblings dimmed) and the dock
// closes after the ✓, once you've seen where your tap went. A FAILED send leaves the dock open with
// every button live again, so you can retry without reopening it.
export function QuickActionsContent({
  onSend,
  onClose,
  agent,
  isShell,
  disabled,
}: QuickActionsContentProps) {
  useLocale();
  const operatorGroups = useOperatorQuickReplies();
  const groups = quickRepliesFor(agent, isShell, operatorGroups);
  const echo = useActionEcho();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );

  const fire = (text: string) => {
    if (disabled || echo.pending) return;
    void echo.run(text, async () => {
      const ok = await onSend(text);
      // Let the ✓ land before the dock goes. On failure we hold it open — the status bar carries the
      // reason and the user is one tap from trying again.
      if (ok) closeTimer.current = setTimeout(onClose, ECHO_DONE_MS);
      return ok;
    });
  };

  return (
    <div className="space-y-4 border-t border-border/60 bg-muted/30 px-3 py-2.5">
      {groups.map((g) => (
        <Group
          key={g.title}
          title={groupTitle(g.title)}
          items={g.items}
          cols="grid-cols-2"
          disabled={disabled}
          busy={echo.pending}
          phaseOf={echo.phaseOf}
          onFire={fire}
        />
      ))}
    </div>
  );
}
