import { Component, forwardRef, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from "react";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import type { TranscriptEntry } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { hasResizeObserver } from "@/lib/env";

interface AnchorProps {
  list: RefObject<ChatMessageListHandle | null>;
  entries: TranscriptEntry[];
  children: ReactNode;
}
interface AnchorSnapshot {
  top: number;
  rows: { id: string; offset: number }[];
}

// getSnapshotBeforeUpdate measures the OLD DOM before React replaces journal parts or drops the
// oldest rows. A layout-effect cleanup runs too late for that guarantee. Keep this Conversation-
// only: Terminal owns its own frozen mirror and load-older anchoring.
type ReaderState = Record<string, never>;

class ReaderAnchor extends Component<AnchorProps, ReaderState> {
  private anchor: AnchorSnapshot | null = null;
  private scrollElement: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private observed = new Set<Element>();

  private snapshot(): AnchorSnapshot | null {
    const el = this.props.list.current?.getScrollElement();
    if (!el) return null;
    if (el.scrollHeight - el.scrollTop - el.clientHeight <= 24) return null;
    const top = el.getBoundingClientRect().top;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-entry]"))
      .filter(row => row.getBoundingClientRect().bottom > top)
      .map(row => ({ id: row.dataset.conversationEntry ?? "", offset: row.getBoundingClientRect().top - top }));
    return { top: el.scrollTop, rows };
  }

  private remember = () => { this.anchor = this.snapshot(); };

  private restore(snapshot: AnchorSnapshot | null) {
    const el = this.props.list.current?.getScrollElement();
    if (!el || !snapshot) return;
    const rows = Array.from(el.querySelectorAll<HTMLElement>("[data-conversation-entry]"));
    // Preserve the first intersecting row, including its negative offset when partially visible.
    // If the bounded window evicted it, use the next
    // surviving row at its old offset. With no overlap, retain the numeric position, clamped by DOM.
    for (const anchor of snapshot.rows) {
      const row = rows.find(candidate => candidate.dataset.conversationEntry === anchor.id);
      if (!row) continue;
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.offset;
      return;
    }
    el.scrollTop = snapshot.top;
  }

  private observeContent() {
    const el = this.scrollElement;
    const observer = this.resizeObserver;
    if (!el || !observer) return;
    // The scrollport has a fixed height; its direct children grow when nested journal images
    // decode. Track replacements too, such as the loading placeholder becoming the thread.
    const current = new Set<Element>([el, ...el.children]);
    for (const node of this.observed) if (!current.has(node)) observer.unobserve(node);
    for (const node of current) if (!this.observed.has(node)) observer.observe(node);
    this.observed = current;
  }

  componentDidMount() {
    this.scrollElement = this.props.list.current?.getScrollElement() ?? null;
    this.scrollElement?.addEventListener("scroll", this.remember);
    this.remember();
    if (!hasResizeObserver()) return;
    this.resizeObserver = new ResizeObserver(() => {
      // No React update accompanies a delayed image load. Use the last settled reader anchor,
      // not a measurement of the already-grown DOM. A null anchor leaves tail-follow to the
      // shared list. Scroll events, including jump-to-latest, replace or clear the old anchor.
      if (this.anchor) {
        this.restore(this.anchor);
        this.remember();
      }
    });
    this.observeContent();
  }

  getSnapshotBeforeUpdate(previous: AnchorProps): AnchorSnapshot | null {
    return previous.entries === this.props.entries ? null : this.snapshot();
  }

  componentDidUpdate(previous: AnchorProps, _state: ReaderState, snapshot: AnchorSnapshot | null) {
    if (previous.entries !== this.props.entries) {
      this.restore(snapshot);
      this.remember();
    }
    this.observeContent();
  }

  componentWillUnmount() {
    this.scrollElement?.removeEventListener("scroll", this.remember);
    this.resizeObserver?.disconnect();
    this.observed.clear();
  }

  render() { return this.props.children; }
}

export const ConversationMessageList = forwardRef<ChatMessageListHandle, { entries: TranscriptEntry[]; children: ReactNode }>(
  function ConversationMessageList({ entries, children }, ref) {
    useLocale();
    const list = useRef<ChatMessageListHandle>(null);
    const [atBottom, setAtBottom] = useState(true);
    const [seen, setSeen] = useState(entries);
    useEffect(() => { if (atBottom) setSeen(entries); }, [atBottom, entries]);
    useImperativeHandle(ref, () => ({
      scrollToBottom: () => list.current?.scrollToBottom(),
      getScrollElement: () => list.current?.getScrollElement() ?? null,
    }), []);
    const hasNew = !atBottom && JSON.stringify(entries) !== JSON.stringify(seen);
    return (
      <ReaderAnchor list={list} entries={entries}>
        <ChatMessageList
          ref={list}
          dep={entries}
          onAtBottomChange={setAtBottom}
          hasNew={hasNew}
          newContentLabel={t("chat.conversation.updated")}
          className="px-4 pt-2 pb-3"
          style={{ overflowAnchor: "none" }}
          role="region"
          aria-label={t("chat.conversation.title")}
          tabIndex={0}
        >
          {children}
        </ChatMessageList>
      </ReaderAnchor>
    );
  },
);
