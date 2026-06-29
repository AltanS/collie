import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

// shadcn-style chat primitives. A bubble is a row (avatar + message); the message body carries
// the sent/received variant. Terminal/agent text is always passed as children (React escapes it),
// so attacker-influenced output can never inject markup.

const chatBubbleVariants = cva("flex items-end gap-2 max-w-[92%] relative group", {
  variants: {
    variant: {
      received: "self-start",
      sent: "self-end flex-row-reverse",
    },
  },
  defaultVariants: { variant: "received" },
});

interface ChatBubbleProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof chatBubbleVariants> {}

function ChatBubble({ className, variant, ...props }: ChatBubbleProps) {
  return <div className={cn(chatBubbleVariants({ variant }), className)} {...props} />;
}

function ChatBubbleAvatar({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted text-xs font-semibold",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

const chatBubbleMessageVariants = cva("rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed", {
  variants: {
    variant: {
      received: "bg-muted text-foreground rounded-bl-sm",
      sent: "bg-primary text-primary-foreground rounded-br-sm",
    },
  },
  defaultVariants: { variant: "received" },
});

interface ChatBubbleMessageProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof chatBubbleMessageVariants> {
  isLoading?: boolean;
}

function ChatBubbleMessage({
  className,
  variant,
  isLoading,
  children,
  ...props
}: ChatBubbleMessageProps) {
  return (
    <div className={cn(chatBubbleMessageVariants({ variant }), "min-w-0", className)} {...props}>
      {isLoading ? (
        <span className="flex items-center gap-1 py-1" aria-label="loading">
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span className="size-1.5 animate-bounce rounded-full bg-current" />
        </span>
      ) : (
        children
      )}
    </div>
  );
}

function ChatBubbleTimestamp({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("mt-1 block text-[10px] opacity-60", className)} {...props} />;
}

export {
  ChatBubble,
  ChatBubbleAvatar,
  ChatBubbleMessage,
  ChatBubbleTimestamp,
  chatBubbleVariants,
};
