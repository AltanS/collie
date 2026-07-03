import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";

interface FindBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  /** Total matches for the current query. */
  count: number;
  /** Zero-based index of the focused match (only meaningful when count > 0). */
  current: number;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
}

// Compact one-row find bar that takes over the header while searching the pane mirror. Thumb-reach:
// the input fills the row, the match count sits inline, and prev/next/close are right-aligned. Enter
// jumps to the next match (Shift+Enter the previous), Escape closes — matching a desktop find bar.
export function FindBar({
  query,
  onQueryChange,
  count,
  current,
  onPrev,
  onNext,
  onClose,
}: FindBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus (and pop the keyboard) as soon as the bar opens so the user can type immediately.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const countLabel = query ? (count > 0 ? `${current + 1}/${count}` : "0/0") : "";

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <Search className="pointer-events-none size-4 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        inputMode="search"
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (e.shiftKey) onPrev();
            else onNext();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Find in output…"
        aria-label="Find in output"
        className="h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
      />
      <span className="shrink-0 whitespace-nowrap px-1 font-mono text-xs tabular-nums text-muted-foreground">
        {countLabel}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground"
        disabled={count === 0}
        onClick={onPrev}
        aria-label="Previous match"
      >
        <ChevronUp className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground"
        disabled={count === 0}
        onClick={onNext}
        aria-label="Next match"
      >
        <ChevronDown className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 shrink-0 text-muted-foreground"
        onClick={onClose}
        aria-label="Close find"
      >
        <X className="size-4" />
      </Button>
    </div>
  );
}
