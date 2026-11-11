import { useId, useState, type ReactNode } from "react";

import { Switch } from "@/components/ui/switch";

/**
 * A row that holds a switch: a leading icon, a label and an optional second line, with the switch at the
 * end. The whole row is the switch's label, so a tap anywhere on it flips it, inside a real 44px floor
 * (DESIGN.md §6). The look of a sheet's action row (components/action-sheet-rows.tsx `ActionRow`), so the
 * two sit in one list.
 *
 * `onChange` writes the new value and answers the words of a failure, or null when it took. While it runs
 * the switch shows the value asked for and waits; a failure puts the old value back and says why under
 * the row, in the refusal ink. Owns no words. The session sheet's agent view switches.
 */
export function SwitchRow({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: ReactNode;
  label: string;
  hint?: string | undefined;
  checked: boolean;
  onChange: (next: boolean) => Promise<string | null>;
}) {
  const hintId = useId();
  const [asked, setAsked] = useState<boolean | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const busy = asked !== null;
  const shown = asked ?? checked;
  const flip = async (next: boolean) => {
    if (busy) return;
    setAsked(next);
    setNote(null);
    const failed = await onChange(next);
    setAsked(null);
    setNote(failed);
  };
  return (
    <div data-slot="switch-row">
      <label className="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-accent active:bg-muted">
        {icon}
        <span className="min-w-0 flex-1">
          <span className="block">{label}</span>
          {hint !== undefined && (
            <span id={hintId} className="block text-xs font-normal leading-snug text-muted-foreground">
              {hint}
            </span>
          )}
        </span>
        <Switch checked={shown} disabled={busy} onCheckedChange={(next) => void flip(next)} aria-label={label} aria-describedby={hint === undefined ? undefined : hintId} />
      </label>
      {note !== null && (
        <p data-slot="switch-row-note" role="status" className="px-3 pb-1 text-[11px] text-status-blocked">
          {note}
        </p>
      )}
    </div>
  );
}
