import { BottomSheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

// Common one-tap replies, grouped. Each sends its text and submits (then closes the sheet).
const OPTIONS = ["1", "2", "3", "4", "5"];
const CONFIRM = ["yes", "no", "approve", "deny"];
const COMMON = ["go ahead", "continue", "commit and push", "retry", "stop", "ok", "skip"];

interface QuickActionsProps {
  open: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  disabled?: boolean;
}

export function QuickActions({ open, onClose, onSend, disabled }: QuickActionsProps) {
  const fire = (text: string) => {
    if (disabled) return;
    onSend(text);
    onClose();
  };

  const Group = ({ title, items, cols }: { title: string; items: string[]; cols: string }) => (
    <div>
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className={`grid gap-2 ${cols}`}>
        {items.map((t) => (
          <Button
            key={t}
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={() => fire(t)}
            className="h-12 text-sm font-medium"
          >
            {t}
          </Button>
        ))}
      </div>
    </div>
  );

  return (
    <BottomSheet open={open} onClose={onClose} title="Quick actions">
      <div className="space-y-4">
        <Group title="select an option" items={OPTIONS} cols="grid-cols-5" />
        <Group title="confirm" items={CONFIRM} cols="grid-cols-4" />
        <Group title="common" items={COMMON} cols="grid-cols-3" />
      </div>
    </BottomSheet>
  );
}
