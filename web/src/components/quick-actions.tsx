import { Button } from "@/components/ui/button";

// Common one-tap replies, grouped. Each sends its text and submits (then closes the dock).
// Numbered options live in the keyboard quick-key row, not here; the textual set is deduped to
// distinct intents (no yes/ok/approve/go-ahead pile-up, no "stop" that just duplicates Esc).
const CONFIRM = ["yes", "no"];
const COMMON = ["continue", "commit and push", "retry", "skip"];

interface QuickActionsContentProps {
  onSend: (text: string) => void;
  onClose: () => void;
  disabled?: boolean;
}

// Module-level so it isn't a fresh component type each render (which would remount the grid).
function Group({
  title,
  items,
  cols,
  disabled,
  onFire,
}: {
  title: string;
  items: string[];
  cols: string;
  disabled?: boolean;
  onFire: (text: string) => void;
}) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className={`grid gap-2 ${cols}`}>
        {items.map((t) => (
          <Button
            key={t}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => onFire(t)}
            className="h-12 text-sm font-medium"
          >
            {t}
          </Button>
        ))}
      </div>
    </div>
  );
}

// The Quick-actions body — the two one-tap reply grids, no chrome of its own. Docked in-flow by the
// composer (same ComposerDock wrapper as Keys), so it never covers the mirror. `fire` sends then
// closes the dock; padding matches NavTray so both docks read identically.
export function QuickActionsContent({ onSend, onClose, disabled }: QuickActionsContentProps) {
  const fire = (text: string) => {
    if (disabled) return;
    onSend(text);
    onClose();
  };

  return (
    <div className="space-y-4 border-t border-border/60 bg-muted/30 px-3 py-2.5">
      <Group title="confirm" items={CONFIRM} cols="grid-cols-2" disabled={disabled} onFire={fire} />
      <Group title="common" items={COMMON} cols="grid-cols-2" disabled={disabled} onFire={fire} />
    </div>
  );
}
