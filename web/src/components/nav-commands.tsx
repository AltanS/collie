import { useEffect, useRef, useState } from "react";
import { Home, SquarePlus, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

interface NavCommandsProps {
  onHome: () => void;
  /** New tab in the current pane's space. Omitted/disabled when there's no current pane. */
  onNewTab?: () => void;
  /** Close the current pane ("kill"). Two-tap confirm. */
  onKill: () => void;
  killDisabled?: boolean;
}

// The nav hub's sticky footer: pane-level commands for the pane you arrived from. Home and New tab
// are single-tap; Kill is destructive so it needs a two-tap confirm (the logic the retired
// HerdrPalette used to own).
export function NavCommands({ onHome, onNewTab, onKill, killDisabled }: NavCommandsProps) {
  const [confirmKill, setConfirmKill] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  function kill() {
    if (killDisabled) return;
    if (!confirmKill) {
      setConfirmKill(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirmKill(false), 3000);
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setConfirmKill(false);
    onKill();
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" size="sm" className="flex-1 gap-1.5 text-muted-foreground" onClick={onHome}>
        <Home className="size-4" />
        Home
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="flex-1 gap-1.5 text-muted-foreground"
        onClick={onNewTab}
        disabled={!onNewTab}
      >
        <SquarePlus className="size-4" />
        New tab
      </Button>
      <Button
        variant={confirmKill ? "destructive" : "ghost"}
        size="sm"
        className={cn("flex-1 gap-1.5", !confirmKill && "text-destructive/80")}
        onClick={kill}
        disabled={killDisabled}
      >
        <Trash2 className="size-4" />
        {confirmKill ? "Confirm?" : "Kill"}
      </Button>
    </div>
  );
}
