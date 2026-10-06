// The Chat view: the pane's session as a stream of whole turns (ADR 0073). Port of
// web/src/components/session-stream.tsx without React.
//
// The window is polled on the shared beat while this view is mounted (routes/pane/chat-store.ts:
// web's `fetchChat` + `mergeChat`). The bridge pages by whole turns, so a block on screen is never
// half a turn; abandoned turns stay in the window and are not drawn. Steps fold into runs as the
// React stream folds them (chat/steps.ts), and "Load older" pages earlier turns in above, holding
// the reader's place: the distance from the bottom is kept across the insert.
import { on, ref, type Handle, type RemixNode } from "remix/component";
import { ArrowDown } from "lucide";

import { itemsOf, type ChatItem } from "@web/lib/chat-items";
import type { ChatStatus } from "@web/lib/chat-window";
import { t, type MessageKey } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import type { ChatEntry } from "@web/lib/types";

import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { groupRuns } from "../../chat/steps";
import { ItemView, ToolGroup } from "../../chat/tool-card";
import { isAtBottom, recallSpot, rememberSpot } from "../../screen/follow";
import { Icon } from "../../ui/icon";
import { chatStore, loadOlder, pollChat } from "./chat-store";
import { setPaneStatus } from "./status";

/** The sentence for a window that has nothing to stream (session-stream.tsx `chatStatusKey`). */
export function chatStatusKey(status: ChatStatus): MessageKey | null {
  if (status.kind === "stale") return "chat.stale.member";
  if (status.kind !== "unavailable") return null;
  switch (status.reason) {
    case "disabled":
      return "history.unavailable.disabled";
    case "no-session":
      return "history.unavailable.noSession";
    case "no-log":
      return "history.unavailable.noLog";
  }
}

export interface ChatViewProps {
  /** The pane's (host, session, pane) key: the window's and the scroll memory's key. */
  paneKey: string;
  paneId: string;
  scope: Scope;
  /** The agent is working: the stream ends in a "Still working…" row. */
  working: boolean;
  onFollowChange: (following: boolean) => void;
}

export function ChatView(handle: Handle<ChatViewProps>) {
  const { paneKey, paneId, scope } = handle.props;
  const store = chatStore(paneKey);
  want({ key: `chat:${paneKey}`, poll: (signal) => pollChat(paneKey, paneId, scope, signal) }, handle.signal);
  const read = useStore(handle, store);

  const spot = recallSpot(`chat:${paneKey}`);
  let following = spot.following;
  let restoreTop: number | null = spot.following ? null : spot.top;
  let scroller: HTMLDivElement | undefined;
  /** Distance from the bottom before an older page lands, so the reader's place is held. */
  let anchor: number | null = null;
  let lastEntries: readonly ChatEntry[] | undefined;
  let groups: ChatItem[][] = [];

  const save = (): void => {
    if (scroller) rememberSpot(`chat:${paneKey}`, { following, top: scroller.scrollTop });
  };
  handle.signal.addEventListener("abort", save);

  const pin = (): void => {
    if (!scroller) return;
    if (anchor !== null && !store.get().loadingOlder) {
      scroller.scrollTop = scroller.scrollHeight - anchor;
      anchor = null;
      return;
    }
    if (restoreTop !== null) {
      scroller.scrollTop = restoreTop;
      restoreTop = null;
      return;
    }
    if (following) scroller.scrollTop = scroller.scrollHeight;
  };

  const follow = (next: boolean): void => {
    if (next === following) return;
    following = next;
    handle.props.onFollowChange(next);
    void handle.update();
  };

  const older = async (): Promise<void> => {
    if (scroller) anchor = scroller.scrollHeight - scroller.scrollTop;
    following = false;
    const failed = await loadOlder(paneKey, paneId, scope);
    if (failed !== undefined) {
      anchor = null;
      setPaneStatus(t("chat.stream.loadOlderFailed"), "error");
    }
  };

  return () => {
    const { window, loadingOlder, error, answered } = read();
    if (window.entries !== lastEntries) {
      lastEntries = window.entries;
      const items = window.entries.filter((e) => !e.abandoned).flatMap((e) => itemsOf(e));
      groups = groupRuns(items, 3);
    }
    handle.queueTask(pin);
    const statusKey = chatStatusKey(window.status);
    const live = window.status.kind === "live";
    let top: RemixNode = null;
    if (window.hasOlder) {
      top = (
        <button
          type="button"
          data-testid="chat-load-older"
          disabled={loadingOlder}
          class="flex min-h-11 w-full items-center justify-center text-xs font-medium text-muted-foreground active:bg-muted disabled:opacity-60"
          mix={on("click", () => void older())}
        >
          {loadingOlder ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
        </button>
      );
    } else if (live && window.entries.length > 0) {
      top = <p class="py-2 text-center text-xs text-muted-foreground">{t("history.startOfConversation")}</p>;
    }
    return (
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="chat-view">
        <div
          data-slot="session-stream"
          data-testid="chat-stream"
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2"
          mix={[
            ref((node: HTMLDivElement) => {
              scroller = node;
            }),
            on("scroll", (event) => {
              follow(isAtBottom(event.currentTarget));
              save();
            }),
          ]}
        >
          <div class="flex flex-col gap-3">
            {top}
            {groups.map((group) =>
              group.length === 1 ? (
                <div key={group[0]!.id} data-block data-n={1} class="flex min-w-0 flex-col">
                  <ItemView item={group[0]!} />
                </div>
              ) : (
                <div key={group[0]!.id} data-block data-n={group.length} class="flex min-w-0 flex-col">
                  <ToolGroup items={group} />
                </div>
              ),
            )}
            {statusKey !== null && <p class="py-6 text-center text-sm text-muted-foreground">{t(statusKey)}</p>}
            {error !== undefined && window.entries.length === 0 && statusKey === null && (
              <p class="py-6 text-center text-sm text-muted-foreground" data-testid="chat-error">
                {t("connection.cantReach")}
              </p>
            )}
            {answered && live && window.entries.length === 0 && (
              <p class="py-6 text-center text-sm text-muted-foreground">{t("chat.stream.empty")}</p>
            )}
            {handle.props.working && live && (
              <p data-slot="stream-live" class="mt-1 flex items-center gap-2 py-2 text-xs font-medium text-muted-foreground">
                <span class="status-breathe size-2 rounded-full bg-status-working" aria-hidden="true" />
                {t("chat.stream.working")}
              </p>
            )}
            {live && window.queued.length > 0 && (
              <div data-slot="stream-queued" class="flex flex-col gap-1 rounded-md border border-dashed border-status-working/40 px-3 py-2">
                <span class="text-xs font-medium text-status-working">{t("chat.stream.queued")}</span>
                {window.queued.map((text, i) => (
                  <p key={`q-${String(i)}`} class="text-sm break-words whitespace-pre-wrap text-foreground/80">
                    {text}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
        {!following && (
          <button
            type="button"
            aria-label={t("common.scrollToLatestAria")}
            class="absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full border border-border bg-background/90 shadow-md backdrop-blur"
            mix={on("click", () => {
              follow(true);
              handle.queueTask(pin);
            })}
          >
            <Icon icon={ArrowDown} class="size-4" />
          </button>
        )}
      </div>
    );
  };
}
