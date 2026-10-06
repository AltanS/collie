// The Terminal view: the pane's mirror as keyed rows (screen/rows.ts), pinned to the live tail while
// the reader follows it. Port of the mirror half of web/src/components/agent-chat.tsx.
//
// FOLLOWING. At the bottom (web's 24px rule), every new read is drawn and the scroller is pinned to
// the end after the commit. Scrolled up, the rows the reader is looking at are FROZEN, as in the
// React mirror: a poll that lands while you read does not move the text under your eye. The jump
// button carries a dot when the live screen has moved since, and one tap goes back to the tail.
//
// The parent passes the lines the mirror draws (the blocks no dialog card took). Rows are rebuilt
// only when those lines change, reusing every unchanged row (`toRows(lines, prev)`).
import { on, ref, type Handle } from "remix/component";
import { ArrowDown } from "lucide";

import type { StyledLine } from "@web/lib/blocks";
import { t } from "@web/lib/i18n";

import { isAtBottom, recallSpot, rememberSpot } from "../../screen/follow";
import { toRows, type Row } from "../../screen/rows";
import { MIRROR_SPACE, Screen } from "../../screen/screen";
import { Icon } from "../../ui/icon";
import { UnseenMark } from "../../ui/unseen-mark";

export interface TerminalViewProps {
  /** The scroll-memory key: the pane's (host, session, pane) key. */
  spotKey: string;
  lines: readonly StyledLine[];
  /** The mirror has never answered: draw nothing rather than "(no recent output)". */
  loading: boolean;
  onFollowChange: (following: boolean) => void;
}

export function TerminalView(handle: Handle<TerminalViewProps>) {
  const spot = recallSpot(`terminal:${handle.props.spotKey}`);
  let following = spot.following;
  let restoreTop: number | null = spot.following ? null : spot.top;
  let scroller: HTMLDivElement | undefined;
  let lastLines: readonly StyledLine[] | undefined;
  let rows: Row[] = [];
  let shown: Row[] = [];

  const save = (): void => {
    if (scroller) rememberSpot(`terminal:${handle.props.spotKey}`, { following, top: scroller.scrollTop });
  };

  const pin = (): void => {
    if (!scroller) return;
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

  handle.signal.addEventListener("abort", save);

  return () => {
    const { lines, loading } = handle.props;
    if (lines !== lastLines) {
      lastLines = lines;
      rows = toRows(lines, rows);
    }
    if (following || shown.length === 0) shown = rows;
    const hasNew = !following && shown !== rows;
    handle.queueTask(pin);
    return (
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="terminal-view">
        <div
          data-testid="pane-scroller"
          class={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${MIRROR_SPACE}`}
          mix={[
            ref((node: HTMLDivElement) => {
              scroller = node;
            }),
            on("scroll", (event) => {
              const box = event.currentTarget;
              follow(isAtBottom(box));
              save();
            }),
          ]}
        >
          {shown.length > 0 ? (
            <Screen rows={shown} testId="pane-text" />
          ) : loading ? null : (
            <p class="py-16 text-center text-sm text-muted-foreground">{t("chat.output.empty")}</p>
          )}
        </div>
        {!following && (
          <button
            type="button"
            aria-label={t("common.scrollToLatestAria")}
            data-testid="scroll-to-latest"
            class="absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full border border-border bg-background/90 shadow-md backdrop-blur"
            mix={on("click", () => {
              follow(true);
              handle.queueTask(pin);
            })}
          >
            <Icon icon={ArrowDown} class="size-4" />
            {hasNew && (
              <span class="absolute top-1 right-1 flex">
                <UnseenMark />
              </span>
            )}
          </button>
        )}
      </div>
    );
  };
}
