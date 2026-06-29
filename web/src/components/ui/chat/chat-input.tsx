import * as React from "react";

import { cn } from "@/lib/utils";

// Auto-growing message composer. It's just a styled textarea, so the phone's native keyboard —
// including voice dictation via the keyboard mic — works for free. Auto-capitalization is off: this
// drives a terminal (shell commands, slash-commands, agent replies) where a forced leading capital
// is usually wrong. (Callers can still override via props.)
function ChatInput({ className, ref, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      ref={ref}
      data-slot="chat-input"
      autoComplete="off"
      autoCapitalize="none"
      className={cn(
        "field-sizing-content max-h-40 min-h-11 w-full resize-none rounded-md border border-input bg-transparent px-3 py-2.5 text-base shadow-xs outline-none transition-[color,box-shadow] placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { ChatInput };
