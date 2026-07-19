import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { BottomSheet } from "@/components/ui/sheet";
import { useHoldReload } from "@/lib/reload-guard";

interface NewSpaceSheetProps {
  open: boolean;
  onClose: () => void;
  onCreate: (opts: { label?: string; cwd?: string }) => void;
}

// Create a new space (workspace). Both fields are optional and dictation-friendly: leave the
// directory blank to open the shell in your home dir (it's a shell — cd from there), or set a path
// for a specific project. The new space opens a fresh shell you launch your own agent in.
export function NewSpaceSheet({ open, onClose, onCreate }: NewSpaceSheetProps) {
  const [label, setLabel] = useState("");
  const [cwd, setCwd] = useState("");

  // Don't let a self-update reload yank this tab/space form out from under a half-typed
  // directory/label — hold while it's open; the self-updater shows the banner and updates on close.
  useHoldReload("new-space", open);

  useEffect(() => {
    if (open) {
      setLabel("");
      setCwd("");
    }
  }, [open]);

  function create() {
    onCreate({ label: label.trim() || undefined, cwd: cwd.trim() || undefined });
    onClose();
  }

  return (
    <BottomSheet open={open} onClose={onClose} title="New space">
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Directory (optional)</span>
          <input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder="~ (home dir)"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Label (optional)</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="name this space"
            className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          />
        </label>
        <Button onClick={create} className="mt-1 h-11">
          Create space &amp; open shell
        </Button>
      </div>
    </BottomSheet>
  );
}
