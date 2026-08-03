import { useEffect, useRef } from "react";
import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ECHO_DONE_MS, useActionEcho } from "@/hooks/use-action-echo";
import type { EchoPhase } from "@/hooks/use-action-echo";

// Common one-tap replies, grouped. Each sends its text and submits, then closes the dock.
// Numbered options live in the keyboard quick-key row, not here; the textual set is deduped to
// distinct intents (no yes/ok/approve/go-ahead pile-up, no "stop" that just duplicates Esc).
const CONFIRM = ["yes", "no"];
const COMMON = ["continue", "commit and push", "retry", "skip"];

interface QuickActionsContentProps {
  /** Resolves true once the reply is verified sent — drives the ✓ and the deferred close. */
  onSend: (text: string) => Promise<boolean>;
  onClose: () => void;
  disabled?: boolean;
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
  items: string[];
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
export function QuickActionsContent({ onSend, onClose, disabled }: QuickActionsContentProps) {
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
      <Group
        title="confirm"
        items={CONFIRM}
        cols="grid-cols-2"
        disabled={disabled}
        busy={echo.pending}
        phaseOf={echo.phaseOf}
        onFire={fire}
      />
      <Group
        title="common"
        items={COMMON}
        cols="grid-cols-2"
        disabled={disabled}
        busy={echo.pending}
        phaseOf={echo.phaseOf}
        onFire={fire}
      />
    </div>
  );
}
