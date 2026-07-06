import { X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { Modifier } from "@/lib/key-queue";
import { isDangerKey, keyLabel } from "@/lib/key-queue";

// The staging strip that sits at the top of the nav tray while composing: a chip per queued key
// (tap to remove), a ghost chip + one-char input while a modifier is armed, and an explicit Send.
// Presentational only — all state lives in useKeyQueue; every visible string is a plain text node.
interface KeyQueueStripProps {
  queue: string[];
  mod: Modifier | null;
  onRemove: (i: number) => void;
  onClear: () => void;
  onSend: () => void;
  /** Raw input value forwarded straight through — the model (normalizeBaseChar) takes the last char. */
  onBaseChar: (char: string) => void;
  disabled?: boolean;
}

export function KeyQueueStrip({
  queue,
  mod,
  onRemove,
  onClear,
  onSend,
  onBaseChar,
  disabled,
}: KeyQueueStripProps) {
  // Self-guarding: nothing to show unless a modifier is armed or keys are queued.
  if (mod === null && queue.length === 0) return null;

  const danger = queue.some(isDangerKey);
  const modLabel = mod === "shift" ? "⇧" : mod === "ctrl" ? "Ctrl" : null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 p-1.5">
      {/* Queued keys — tap a chip to drop it from the sequence. */}
      {queue.map((key, i) => {
        const label = keyLabel(key);
        return (
          <button
            key={`${key}-${i}`}
            type="button"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${label}`}
            className={cn(
              "inline-flex h-8 items-center gap-1 rounded-md border border-border bg-muted/50 px-2 text-xs font-medium",
              isDangerKey(key) && "border-destructive/40 text-destructive",
            )}
          >
            <span>{label}</span>
            <X className="size-3 opacity-60" />
          </button>
        );
      })}

      {/* Modifier armed, no base yet: a ghost chip showing what's awaited (e.g. "Ctrl + …"). */}
      {mod !== null && (
        <span className="inline-flex h-8 items-center rounded-md border border-dashed border-border px-2 text-xs text-muted-foreground">
          {modLabel} + …
        </span>
      )}

      {/* One-char key input — only while a modifier is armed. Controlled to "" so each keystroke
          fires onChange and the field stays empty; the model takes the last char typed. */}
      {mod !== null && (
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="key"
          value=""
          disabled={disabled}
          onChange={(e) => onBaseChar(e.target.value)}
          aria-label="Type a key to combine"
          className="h-8 w-14 rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        />
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          type="button"
          variant={danger ? "destructive" : "default"}
          size="sm"
          className="h-8"
          disabled={disabled || queue.length === 0}
          onClick={onSend}
        >
          Send
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 text-muted-foreground"
          disabled={disabled}
          onClick={onClear}
          aria-label="Clear queued keys"
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
