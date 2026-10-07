// The Chat view: the pane's session as a stream of whole turns (ADR 0073). Port of
// web/src/components/session-stream.tsx without React.
//
// The window is polled by the pane route while the chat gate wants it (pane-start.ts), not by this
// view: the gate needs answers even while the Terminal or the start state is on screen. The bridge
// pages by whole turns, so a block on screen is never half a turn; abandoned turns stay in the
// window and are not drawn. Steps fold into runs as the React stream folds them (chat/steps.ts), and
// "Load older" pages earlier turns in above, holding the reader's place: the page merges by turn key
// (web's `mergeChat`, deduped by uuid), and the FIRST VISIBLE BLOCK stays put (chat/anchor.ts): its
// offset is measured before the page lands and `scrollTop` is corrected after the browser's layout,
// by `afterLayout`, so the commit itself reads nothing.
import { on, ref, type Handle, type RemixNode } from "remix/component";
import { ArrowDown, ArrowUpToLine, LoaderCircle } from "lucide";

import { itemsOf, type ChatItem } from "@web/lib/chat-items";
import type { ChatStatus } from "@web/lib/chat-window";
import { t, type MessageKey } from "@web/lib/i18n";
import type { Scope } from "@web/lib/scope";
import type { ChatEntry } from "@web/lib/types";

import { afterLayout } from "../../lib/after-layout";
import { countRender } from "../../lib/render-count";
import { setStatus } from "../../lib/status";
import { useStore } from "../../lib/store";
import { anchorOf, restoredTop, type Anchor, type BlockBox } from "../../chat/anchor";
import { groupRuns } from "../../chat/steps";
import { ItemView, ToolGroup } from "../../chat/tool-card";
import { createTailPin, isAtBottom, recallSpot, rememberSpot } from "../../screen/follow";
import { Button } from "../../ui/button";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { StatusDot } from "../../ui/status-dot";
import { chatStore, loadOlder } from "./chat-store";

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

/**
 * The reader's text size as three token overrides (session-stream.tsx `textTokens`): `text-sm` is
 * `var(--text-sm)`, and a custom property cascades, so every card inside follows with no prop.
 */
export interface TextTokens {
  [token: string]: string;
  "--text-xs": string;
  "--text-sm": string;
  "--text-base": string;
}

export function textTokens(size: number): TextTokens {
  return {
    "--text-xs": `${((size * 12) / 14).toFixed(2)}px`,
    "--text-sm": `${String(size)}px`,
    "--text-base": `${((size * 16) / 14).toFixed(2)}px`,
  };
}

const NO_NOTES: Readonly<Record<string, string>> = {};

/**
 * One block of the stream: web's `STREAM_BLOCK` (session-stream.tsx), verbatim. `content-visibility:
 * auto` skips style, layout and paint for a block off screen, so the pane's first layout lays out
 * the blocks in view and not the whole window (the profile of 2026-10-06, section 6: web set it on
 * 28 elements of this pane, this shell on none). `contain-intrinsic-size: auto 64px` holds a block
 * that has not been drawn at 64 px and a drawn one at its last real height, so the scroll height
 * the tail pin reads does not lie twice. The 12 px padding with the matching negative margin keeps
 * a card's shadow and focus ring inside the paint clip the containment adds; the box is unchanged.
 */
const STREAM_BLOCK = "flex min-w-0 flex-col [content-visibility:auto] [contain-intrinsic-size:auto_64px] -m-3 p-3";

/** Every block of the stream with its stable key (`data-key`, the block's first item id) and its box. */
function blockBoxes(scroller: HTMLElement): BlockBox[] {
  const boxes: BlockBox[] = [];
  for (const node of scroller.querySelectorAll<HTMLElement>("[data-block]")) {
    const { top, bottom } = node.getBoundingClientRect();
    boxes.push({ key: node.dataset.key ?? "", top, bottom });
  }
  return boxes;
}

export interface ChatViewProps {
  /** The pane's (host, session, pane) key: the window's and the scroll memory's key. */
  paneKey: string;
  paneId: string;
  scope: Scope;
  /** The agent is working: the stream ends in a "Still working…" row. */
  working: boolean;
  /** The pane is new and has nothing to read yet (the gate's `start` body). */
  starting: boolean;
  /** Settings → Appearance. Off folds every run, including a lone step. */
  showToolCalls: boolean;
  showCompactions: boolean;
  /** The stream's text size in px (`displayPrefs.chatFontSize`). */
  fontSize: number;
  /** Question notes per item id (web's `waitingQuestionNote`). */
  notes?: Readonly<Record<string, string>>;
  /** Bumped by the owner after a send: snap back to the tail. */
  tailRev: number;
  onFollowChange: (following: boolean) => void;
}

export function ChatView(handle: Handle<ChatViewProps>) {
  const { paneKey, paneId, scope } = handle.props;
  const store = chatStore(paneKey);
  const read = useStore(handle, store);

  const spot = recallSpot(`chat:${paneKey}`);
  let following = spot.following;
  let restoreTop: number | null = spot.following ? null : spot.top;
  let scroller: HTMLDivElement | undefined;
  /** The block under the reader's eye before an older page lands, so their place is held. */
  let anchor: Anchor | null = null;
  let lastEntries: readonly ChatEntry[] | undefined;
  let lastFold = "";
  let groups: ChatItem[][] = [];
  let seenTail = handle.props.tailRev;

  const save = (): void => {
    if (scroller) rememberSpot(`chat:${paneKey}`, { following, top: scroller.scrollTop });
  };
  handle.signal.addEventListener("abort", save);

  const tail = createTailPin();
  const pin = (): void => {
    if (!scroller) return;
    if (anchor !== null && !store.get().loadingOlder) {
      const held = anchor;
      const box = scroller;
      anchor = null;
      // Read after the page's layout, write once (REMIX3.md, "Layout in insert callbacks").
      afterLayout(
        box,
        () => restoredTop(held, { scrollTop: box.scrollTop, scrollHeight: box.scrollHeight, containerTop: box.getBoundingClientRect().top, blocks: blockBoxes(box) }),
        (top) => {
          if (Math.abs(box.scrollTop - top) >= 1) box.scrollTop = top;
        },
        handle.signal,
      );
      return;
    }
    if (restoreTop !== null) {
      scroller.scrollTop = restoreTop;
      restoreTop = null;
      return;
    }
    if (following) tail.pin(scroller);
  };

  /** A send asked for the tail: pin after this commit even if no size moved. */
  let pinNext = false;
  // Only what a size change would not do; while following, the ResizeObserver below pins after the
  // browser's own layout (the terminal's rule, terminal.tsx `pinAfterCommit`).
  const pinAfterCommit = (): void => {
    if (anchor === null && restoreTop === null && !pinNext) return;
    pinNext = false;
    pin();
  };

  const follow = (next: boolean): void => {
    if (next === following) return;
    following = next;
    handle.props.onFollowChange(next);
    void handle.update();
  };

  const older = async (): Promise<void> => {
    // A tap, not a flush: measuring here costs nothing the commit would pay.
    if (scroller) anchor = anchorOf(blockBoxes(scroller), scroller.getBoundingClientRect().top, scroller.scrollHeight - scroller.scrollTop);
    following = false;
    const failed = await loadOlder(paneKey, paneId, scope);
    if (failed !== undefined) {
      anchor = null;
      setStatus(t("chat.stream.loadOlderFailed"), "error");
    }
  };

  return () => {
    countRender("ChatView");
    const { working, starting, showToolCalls, showCompactions, fontSize, tailRev } = handle.props;
    const notes = handle.props.notes ?? NO_NOTES;
    const { window, loadingOlder, error, answered } = read();
    if (tailRev !== seenTail) {
      seenTail = tailRev;
      following = true;
      restoreTop = null;
      pinNext = true;
    }
    const fold = `${String(showToolCalls)}:${String(showCompactions)}`;
    if (window.entries !== lastEntries || fold !== lastFold) {
      lastEntries = window.entries;
      lastFold = fold;
      const items = window.entries.filter((e) => !e.abandoned).flatMap((e) => itemsOf(e, showCompactions));
      groups = groupRuns(items, showToolCalls ? 3 : 1);
    }
    handle.queueTask(pinAfterCommit);
    const status = window.status;
    const missing = status.kind === "unavailable" && (status.reason === "no-log" || status.reason === "no-session");
    const explain = starting && missing ? null : chatStatusKey(status);
    const empty = groups.length === 0;
    const live = status.kind === "live";
    const reading = live || (starting && (status.kind === "empty" || missing));
    let top: RemixNode = null;
    if (window.hasOlder) {
      top = (
        <button
          type="button"
          data-testid="chat-load-older"
          disabled={loadingOlder}
          class="mb-2 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60"
          mix={on("click", () => void older())}
        >
          <Icon icon={loadingOlder ? LoaderCircle : ArrowUpToLine} class={loadingOlder ? "size-3.5 animate-spin" : "size-3.5"} />
          {loadingOlder ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
        </button>
      );
    } else if (!empty) {
      top = <p class="mb-3 text-center text-[11px] text-muted-foreground">{t("history.startOfConversation")}</p>;
    }
    const emptyLine = empty && explain === null && reading && !working && answered;
    return (
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="chat-view" data-starting={starting ? "" : undefined}>
        <div
          data-slot="session-stream"
          data-testid="chat-stream"
          class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3"
          style={textTokens(fontSize)}
          mix={[
            ref((node: HTMLDivElement, signal: AbortSignal) => {
              scroller = node;
              // The bands under this scroller (statusline, agents footer, card dock) arrive through
              // Collapse AFTER the render-time pin, so the box shrinks under a pinned tail. Re-pin on
              // the box's own resize while following, as web's list re-pins on resize.
              const keep = new ResizeObserver(() => {
                if (following && anchor === null) tail.pin(node);
              });
              keep.observe(node);
              // And the stream's own column: a turn's Collapse grows it after the commit's pin.
              const column = node.firstElementChild;
              if (column !== null) keep.observe(column);
              signal.addEventListener("abort", () => keep.disconnect(), { once: true });
            }),
            on("scroll", (event) => {
              const node = event.currentTarget;
              // The pin's own scroll event: content may have grown since, so pin again, keep following.
              if (following && tail.ours(node)) {
                if (!isAtBottom(node)) tail.pin(node);
              } else follow(isAtBottom(node));
              save();
            }),
          ]}
        >
          <div class="flex flex-col gap-3 pt-2">
            {top}
            {groups.map((group) =>
              group.length === 1 && (showToolCalls || group[0]!.kind !== "tool") ? (
                <div key={group[0]!.id} data-block data-key={group[0]!.id} data-n={1} class={STREAM_BLOCK}>
                  <ItemView item={group[0]!} note={notes[group[0]!.id]} />
                </div>
              ) : (
                <div key={group[0]!.id} data-block data-key={group[0]!.id} data-n={group.length} class={STREAM_BLOCK}>
                  <ToolGroup items={group} liveOpens={showToolCalls} notes={notes} />
                </div>
              ),
            )}
            <Collapse open={working && reading}>
              <p data-slot="stream-live" class="mt-1 flex items-center gap-2 py-2 text-xs font-medium text-muted-foreground">
                <StatusDot status="working" live class="size-2" />
                {t("chat.stream.working")}
              </p>
            </Collapse>
            <Collapse open={live && window.queued.length > 0}>
              <div data-slot="stream-queued" class="flex flex-col gap-1 rounded-md border border-dashed border-status-working/40 bg-status-working/5 px-3 py-2">
                <span class="text-xs font-medium text-status-working">{t("chat.stream.queued")}</span>
                {window.queued.map((text, i) => (
                  <p key={`q-${String(i)}`} class="text-sm break-words whitespace-pre-wrap text-foreground/80">
                    {text}
                  </p>
                ))}
              </div>
            </Collapse>
            <Collapse open={explain !== null}>
              <p class={empty ? "px-2 py-16 text-center text-sm leading-relaxed text-muted-foreground" : "px-2 py-4 text-center text-sm leading-relaxed text-muted-foreground"}>
                {explain !== null ? t(explain) : ""}
              </p>
            </Collapse>
            <Collapse open={error !== undefined && empty && explain === null && !reading}>
              <p class="py-6 text-center text-sm text-muted-foreground" data-testid="chat-error">
                {t("connection.cantReach")}
              </p>
            </Collapse>
            <Collapse open={emptyLine}>
              <p data-testid="chat-empty" class="py-16 text-center text-sm text-muted-foreground">
                {t("chat.stream.empty")}
              </p>
            </Collapse>
          </div>
        </div>
        {!following ? (
          // The shared Button, as web's pill is: it wears the press (`active:scale-[0.98]`, `transition-all`).
          <Button
            variant="outline"
            size="icon"
            aria-label={t("common.scrollToLatestAria")}
            data-testid="scroll-to-latest"
            class="absolute right-3 bottom-3 size-11 rounded-full bg-background/90 shadow-md backdrop-blur"
            mix={on("click", () => {
              follow(true);
              handle.queueTask(pin);
            })}
          >
            <Icon icon={ArrowDown} class="size-4" />
          </Button>
        ) : null}
      </div>
    );
  };
}
