import { useState } from "react";
import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
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
 * `harnessBar.…` is translated, anything else is printed as it stands. That covers the two things we
 * must not reword — an operator's own `bar_label` and a harness's own wire text (a model alias, an
 * effort level) — without the table having to carry a second flag for each.
 */
function labelText(label: string): string {
  if (!label.startsWith("harnessBar.")) return label;
  // SAFETY: every `harnessBar.` label in lib/harness-bar.ts is a key present in messages/en.ts, and
  // the i18n parity test holds the other six catalogs to the same set. A label that is not a key
  // would not start with this prefix.
  return translate(label as MessageKey);
}

/** The chooser's note line. Always ours, never operator text — a chooser is not expressible in TOML. */
function noteText(note: string): string {
  // SAFETY: the only `note` in lib/harness-bar.ts is `harnessBar.codex.modelNote`, which is a key in
  // messages/en.ts, and the i18n parity test holds the other six catalogs to the same set. A chooser
  // cannot be declared in `commands.toml`, so no operator string ever reaches this line.
  return translate(note as MessageKey);
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
  /**
   * **A TEST AND PLAYGROUND SEAM, NOT A PRODUCT PROP.** When set, it is the `id` of a `chooser` item
   * whose sheet is open on first render. THE COMPOSER NEVER PASSES IT, and nothing should thread it
   * in from there later. The playground's `chooser-open` card and the component test pass it, because
   * the alternative is a card that has to simulate a tap before it shows anything — which makes a
   * static screenshot of that state impossible.
   */
  initialOpen?: string;
}

export function HarnessBar({
  agent,
  mine,
  onRun,
  disabled,
  initialOpen,
}: HarnessBarProps) {
  useLocale();
  const shown = useHarnessBarEnabled();
  const echo = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();
  const [openId, setOpenId] = useState<string | undefined>(initialOpen);

  // The gate lives here rather than at the two call sites, so the composer cannot drift into showing
  // the row in one layout and not the other. Off, or no items for this agent, and it renders nothing
  // and costs no height.
  const items = shown ? barFor(agent, mine) : [];
  if (items.length === 0) return null;

  const open = items.find((i) => i.id === openId && i.kind === "chooser");

  function fire(item: HarnessBarItem) {
    if (item.kind === "chooser") {
      setOpenId(item.id);
      return;
    }
    if (item.confirm === true && !confirm(item.id)) return; // first tap arms the confirm
    reset();
    void echo.run(item.id, () => onRun(item.command));
  }

  function pick(item: HarnessBarItem, arg: string) {
    setOpenId(undefined);
    // Keyed on the PARENT item, so the checkmark lands on the bar button the operator pressed rather
    // than on a sheet row that is already gone. `arg: ""` sends the bare command and lets the
    // harness's own picker come up in the mirror.
    void echo.run(item.id, () => onRun(`${item.command} ${arg}`.trim()));
  }

  return (
    <>
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
                aria-haspopup={item.kind === "chooser" ? "dialog" : undefined}
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

      {open !== undefined && (
        <BottomSheet
          open
          onClose={() => setOpenId(undefined)}
          title={translate("harnessBar.chooser.title", { command: open.command })}
        >
          {/* Codex's Model sheet carries one line saying where the effort dial went — that picker
              sets the model AND the reasoning effort, which is why Codex has no Effort button. No
              other harness gets a note. */}
          {open.note !== undefined && (
            <p className="mb-3 text-sm text-muted-foreground">{noteText(open.note)}</p>
          )}
          <div className="flex flex-col gap-1">
            {(open.options ?? []).map((option) => (
              <button
                key={`${option.label}:${option.arg}`}
                type="button"
                onClick={() => pick(open, option.arg)}
                className="flex h-11 shrink-0 items-center rounded-md px-3 text-left text-sm font-medium text-foreground transition-colors active:bg-muted"
              >
                {labelText(option.label)}
              </button>
            ))}
          </div>
        </BottomSheet>
      )}
    </>
  );
}
