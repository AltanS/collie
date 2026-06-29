import * as React from "react";
import { ArrowDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useAutoScroll } from "@/hooks/use-auto-scroll";

export interface ChatMessageListHandle {
  /** Imperatively jump to the latest output (e.g. after sending a reply). */
  scrollToBottom: () => void;
}

interface ChatMessageListProps extends React.HTMLAttributes<HTMLDivElement> {
  smooth?: boolean;
  /** Changing this value re-pins the list to the bottom (pass your message count / latest text). */
  dep?: unknown;
  /** Fires when the user reaches / leaves the bottom — lets the parent follow or freeze content. */
  onAtBottomChange?: (atBottom: boolean) => void;
  /** Dot the "jump to latest" button when newer output arrived while you were scrolled up. */
  hasNew?: boolean;
}

// Scrollable conversation container that auto-follows new messages and shows a "jump to latest"
// affordance once the user scrolls up. Exposes `scrollToBottom` via ref so the parent can re-follow
// after an action, and reports at-bottom changes so the parent can freeze content while you read.
const ChatMessageList = React.forwardRef<ChatMessageListHandle, ChatMessageListProps>(
  function ChatMessageList(
    { className, children, smooth, dep, onAtBottomChange, hasNew, ...props },
    ref,
  ) {
    const { scrollRef, isAtBottom, scrollToBottom, onScroll } = useAutoScroll<HTMLDivElement>({
      smooth,
      dep,
      onAtBottomChange,
    });

    React.useImperativeHandle(ref, () => ({ scrollToBottom: () => scrollToBottom() }), [
      scrollToBottom,
    ]);

    return (
      <div className="relative h-full w-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className={cn(
            "flex h-full w-full flex-col gap-4 overflow-y-auto overflow-x-hidden px-3 py-4",
            className,
          )}
          {...props}
        >
          {children}
        </div>

        {!isAtBottom && (
          <Button
            onClick={() => scrollToBottom()}
            size="icon"
            variant="outline"
            className="absolute bottom-3 left-1/2 z-10 size-9 -translate-x-1/2 rounded-full shadow-md"
            aria-label="Scroll to latest"
          >
            <ArrowDown className="size-4" />
            {hasNew && (
              <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full bg-status-blocked ring-2 ring-background" />
            )}
          </Button>
        )}
      </div>
    );
  },
);

export { ChatMessageList };
