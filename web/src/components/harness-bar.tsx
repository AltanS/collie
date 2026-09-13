import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { STRIP_TAP_TARGET } from "@/components/ui/labelled-strip";
import { useActionEcho } from "@/hooks/use-action-echo";
import { useLocale } from "@/hooks/use-locale";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { t as translate, type MessageKey } from "@/lib/i18n";
import { barFor, type HarnessBarItem } from "@/lib/harness-bar";
import { useHarnessBarEnabled } from "@/lib/harness-bar-pref";
import type { OperatorCommand } from "@/lib/types";
import { cn } from "@/lib/utils";

// The harness bar: one row of the running agent's own slash commands, above the key rail and below
// the status band. Model, Effort, Compact and Resume on a Claude Code pane; Codex, pi and omp get
// their own. The table is lib/harness-bar.ts — nothing here decides what the buttons are.
//
// It exists because Altan drives Claude Code from the phone and wants those four under the thumb
// rather than three taps down inside the Agent palette.
//
// IT ADDS NO REFUSAL OF ITS OWN. `disabled` (the composer's `locked`) greys every button in place,
// the way the key rail greys a key the multiplexer refuses rather than removing it. Everything else
// is refused inside `send()`: a dialog on screen is refused there with the existing status line, and
// a WORKING pane is not refused at all, because the Agent palette does not refuse one either. One
// gate, one place. The checkmark is the honest signal — it appears only when `send()` resolved true,
// so a tap that was refused shows nothing and the label stays put.
//
// It does not collapse or animate. A row that appeared and disappeared would move the input under the
// thumb, and DESIGN.md §2 says reserve, never reflow — so its presence is decided by the pane's
// agent, which does not change while the pane is on screen.

/**
 * A bar label is either an i18n key or literal text, and the prefix is the discriminator:
 * `harnessBar.…` is translated, anything else is printed as it stands. That covers the one thing we
 * must not reword, an operator's own `bar_label`, without the table having to carry a second flag.
 */
function labelText(label: string): string {
  if (!label.startsWith("harnessBar.")) return label;
  // SAFETY: every `harnessBar.` label in lib/harness-bar.ts is a key present in messages/en.ts, and
  // the i18n parity test holds the other six catalogs to the same set. A label that is not a key
  // would not start with this prefix.
  return translate(label as MessageKey);
}

export interface HarnessBarProps {
  /** The focused pane's agent — the same value the composer threads into the command palettes. */
  agent: string | undefined | null;
  /** The snapshot's `operatorCommands`; the `bar = true` ones replace the shipped bar (ADR 0043). */
  mine?: readonly OperatorCommand[];
  /** Bound to `(t) => send(t, false)`. Resolving true drives the checkmark. */
  onRun: (text: string) => Promise<boolean>;
  /** Bound to the composer's `locked`. Greys every button in place. */
  disabled?: boolean;
}

export function HarnessBar({ agent, mine, onRun, disabled }: HarnessBarProps) {
  useLocale();
  const shown = useHarnessBarEnabled();
  const echo = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();

  // The gate lives here rather than at the two call sites, so the composer cannot drift into showing
  // the row in one layout and not the other. Off, or no items for this agent, and it renders nothing
  // and costs no height.
  const items = shown ? barFor(agent, mine) : [];
  if (items.length === 0) return null;

  function fire(item: HarnessBarItem) {
    if (item.confirm === true && !confirm(item.id)) return; // first tap arms the confirm
    reset();
    void echo.run(item.id, () => onRun(item.command));
  }

  return (
    <div
        data-slot="harness-bar"
        role="group"
        aria-label={translate("harnessBar.label")}
        className="-mx-3 mt-1 mb-1 flex items-center"
      >
        {/* 32px faces inside a `py-1.5` scroller give each button a 44px touch height, `min-w-11`
            supplies the other axis, and the row scrolls sideways rather than wrapping to a second
            line. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto overscroll-x-contain px-3 py-1.5 [mask-image:linear-gradient(to_right,transparent,black_1.5rem,black_calc(100%-1.5rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {items.map((item) => {
            const phase = echo.phaseOf(item.id);
            const armed = pending === item.id;
            return (
              <Button
                key={item.id}
                type="button"
                variant={phase === "idle" && !armed ? "ghost" : "default"}
                size="sm"
                disabled={disabled}
                onClick={() => fire(item)}
                aria-label={
                  armed
                    ? translate("harnessBar.confirmAria", { command: item.command })
                    : labelText(item.label)
                }
                className={cn(
                  `${STRIP_TAP_TARGET} before:-inset-x-px h-8 min-w-11 shrink-0 touch-manipulation px-2.5 text-xs select-none`,
                  armed
                    ? "border border-destructive/40 bg-destructive/10 text-destructive"
                    : "text-muted-foreground",
                )}
              >
                {phase === "done" ? <Check className="size-4" /> : labelText(item.label)}
              </Button>
            );
          })}
        </div>
    </div>
  );
}
