// The scroller wears the page colour, not the mirror's: the light theme's --background is exactly
// what the inverted mirror fill comes out as (web/index.css), so the seam disappears in both themes.
//
// The Terminal view: the pane's mirror as keyed rows (screen/rows.ts), pinned to the live tail while
// the reader follows it. Port of the mirror half of web/src/components/agent-chat.tsx and
// ansi-output.tsx.
//
// FOLLOWING. At the bottom (web's 24px rule), every new read is drawn and the scroller is pinned to
// the end after the commit. Scrolled up, the rows the reader is looking at are FROZEN, as in the
// React mirror: a poll that lands while you read does not move the text under your eye. The jump
// button carries a dot when the live screen has moved since, and one tap goes back to the tail.
//
// FIND AND LINKS. Both are ranges over one text, the shown lines joined by "\n" (screen/decorate.ts):
// web's `findMatches` for the find bar, web's `findLinks` for autolinked URLs. Only the rows a range
// touches are rebuilt. The focused hit is scrolled to the middle after each step.
//
// EMPTY. "(no recent output)" is said only when the pane's RAW screen is empty (`blank`), as web tests
// its `display` text. The rows drawn here can be none while the screen is not empty: a lifted dialog
// block is not a mirror row, and its card is the answer on screen, so no sentence goes under it.
//
// THE REPLY CARD (`lead`, latest-reply.tsx) stands above the rows it replaced, below the top
// affordance and its notes, as web draws it.
//
// LOAD OLDER. A pane with real scrollback grows its requested window (`onOlder`); the reader's place
// is held by keeping the distance from the bottom across the longer text. A pane with an agent
// session links to its History instead, because its alternate screen keeps no scrollback.
import { on, ref, type Handle, type RemixNode } from "remix/component";
import { ArrowDown, ArrowUpToLine, LoaderCircle, ScrollText } from "lucide";

import type { StyledLine } from "@web/lib/blocks";
import { findLinks, type LinkMatch } from "@web/lib/links";
import { t } from "@web/lib/i18n";

import type { Find } from "../../lib/find";
import { decorateRows, haystackOf } from "../../screen/decorate";
import { isAtBottom, recallSpot, rememberSpot } from "../../screen/follow";
import { toRows, type Row } from "../../screen/rows";
import { MUSE_MIRROR, Screen } from "../../screen/screen";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { UnseenMark } from "../../ui/unseen-mark";

/** The top-of-mirror affordance (agent-chat.tsx): History for a session, Load older for scrollback. */
export type MirrorTop = { kind: "history"; onOpen: () => void } | { kind: "older"; loading: boolean; onOlder: () => void } | null;

const EDGE_ROW =
  "mb-2 flex min-h-9 w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60";

export interface TerminalViewProps {
  /** The scroll-memory key: the pane's (host, session, pane) key. */
  spotKey: string;
  lines: readonly StyledLine[];
  /** The pane read's unwrapped text, so a URL broken across rows still links whole. */
  logicalText?: string;
  /** The mirror has never answered: draw nothing rather than "(no recent output)". */
  loading: boolean;
  /** The pane's raw screen text is empty (web's `!display`): the only case that says "(no recent output)". */
  blank: boolean;
  /** The newest reply's card, drawn in place of the rows it covers. */
  lead?: RemixNode;
  /** How many leading rows the card covers (web's `hideLeadingLines`), cut from the rows as drawn. */
  hideLeading: number;
  wrap: boolean;
  fontSize: number;
  /** Muse's native mirror (ADR 0047): light space, never inverted. */
  native: boolean;
  faceClass?: string;
  faceFamily?: string;
  find: Find;
  top: MirrorTop;
  /** Muted lines under the top affordance (no session reported, no log yet, the mux's own note). */
  notes: readonly string[];
  /** Bumped by the owner after a send: snap back to the tail. */
  tailRev: number;
  onFollowChange: (following: boolean) => void;
}

export function TerminalView(handle: Handle<TerminalViewProps>) {
  const spotKey = `terminal:${handle.props.spotKey}`;
  const spot = recallSpot(spotKey);
  let following = spot.following;
  let restoreTop: number | null = spot.following ? null : spot.top;
  let scroller: HTMLDivElement | undefined;
  let lastLines: readonly StyledLine[] | undefined;
  let rows: Row[] = [];
  let shown: Row[] = [];
  let shownLines: readonly StyledLine[] = [];
  /** Distance from the bottom when Load older was tapped: held across the longer text. */
  let anchor: number | null = null;
  let seenTail = handle.props.tailRev;
  let lastFocus = -1;
  let lastHaystack = "";
  let lastLogical: string | undefined;
  let links: LinkMatch[] = [];
  let cut: { rows: Row[]; n: number; outRows: Row[]; outLines: readonly StyledLine[] } | null = null;

  const save = (): void => {
    if (scroller) rememberSpot(spotKey, { following, top: scroller.scrollTop });
  };

  const pin = (): void => {
    if (!scroller) return;
    if (anchor !== null) {
      scroller.scrollTop = scroller.scrollHeight - anchor;
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

  handle.signal.addEventListener("abort", save);

  return () => {
    const { lines, loading, blank, lead, hideLeading, wrap, fontSize, native, faceClass, faceFamily, find, top, notes, tailRev, logicalText } = handle.props;
    if (tailRev !== seenTail) {
      seenTail = tailRev;
      following = true;
      restoreTop = null;
      anchor = null;
    }
    if (lines !== lastLines) {
      lastLines = lines;
      rows = toRows(lines, rows);
    }
    const olderLoading = top?.kind === "older" && top.loading;
    // A Load older that landed takes the new rows even while scrolled up: the reader asked for them.
    if (following || shown.length === 0 || (anchor !== null && shown !== rows)) {
      shown = rows;
      shownLines = lines;
    }
    if (anchor !== null && !olderLoading && shown === rows) {
      const held = anchor;
      handle.queueTask(() => {
        if (anchor === held) anchor = null;
      });
    }
    const hasNew = !following && shown !== rows;
    // The reply card's rows come off what is SHOWN, frozen or live, so folding the card gives them
    // back at once even while the reader is scrolled up (web hides them off its frozen `display`).
    if (cut === null || cut.rows !== shown || cut.n !== hideLeading) {
      cut = hideLeading > 0 ? { rows: shown, n: hideLeading, outRows: shown.slice(hideLeading), outLines: shownLines.slice(hideLeading) } : { rows: shown, n: 0, outRows: shown, outLines: shownLines };
    }
    const visibleRows = cut.outRows;
    const visibleLines = cut.outLines;

    const hay = haystackOf(visibleLines);
    if (hay.text !== lastHaystack || logicalText !== lastLogical) {
      lastHaystack = hay.text;
      lastLogical = logicalText;
      links = findLinks(hay.text, logicalText);
    }
    const found = find.measure(hay.text);
    const drawn = decorateRows(visibleRows, visibleLines, hay.starts, found.matches, found.current, links);
    handle.queueTask(() => {
      pin();
      find.report(found.matches.length, found.current);
      if (found.current >= 0 && found.current !== lastFocus) {
        scroller?.querySelector('[data-find-match="current"]')?.scrollIntoView({ block: "center", behavior: "auto" });
      }
      lastFocus = found.current;
    });

    let edge: RemixNode = null;
    if (top?.kind === "history") {
      edge = (
        <button type="button" data-testid="mirror-history" class={EDGE_ROW} mix={on("click", () => top.onOpen())}>
          <Icon icon={ScrollText} class="size-3.5" />
          {t("chat.scrollback.showHistory")}
        </button>
      );
    } else if (top?.kind === "older") {
      edge = (
        <button
          type="button"
          data-testid="mirror-load-older"
          disabled={top.loading}
          class={EDGE_ROW}
          mix={on("click", () => {
            if (scroller) anchor = scroller.scrollHeight - scroller.scrollTop;
            top.onOlder();
          })}
        >
          <Icon icon={top.loading ? LoaderCircle : ArrowUpToLine} class={top.loading ? "size-3.5 animate-spin" : "size-3.5"} />
          {top.loading ? t("chat.scrollback.loading") : t("chat.scrollback.loadOlder")}
        </button>
      );
    }

    return (
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="terminal-view">
        <div
          data-testid="pane-scroller"
          class={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 ${native ? MUSE_MIRROR : "bg-background"}`}
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
          <div class="pt-1">
            {edge}
            {notes.map((note) => (
              <p key={note} class="mb-2 px-2 py-1 text-center text-xs leading-snug text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
          <Collapse open={lead !== undefined && lead !== null}>{lead}</Collapse>
          {blank ? (
            loading ? null : (
              <p class="py-16 text-center text-sm text-muted-foreground" data-testid="mirror-empty">
                {t("chat.output.empty")}
              </p>
            )
          ) : drawn.length > 0 ? (
            <Screen rows={drawn} wrap={wrap} fontSize={fontSize} native={native} faceClass={faceClass} faceFamily={faceFamily} testId="pane-text" />
          ) : null}
        </div>
        {!following ? (
          <button
            type="button"
            aria-label={t("common.scrollToLatestAria")}
            data-testid="scroll-to-latest"
            class="absolute right-3 bottom-3 flex size-11 items-center justify-center rounded-full border border-border bg-background/90 shadow-md backdrop-blur"
            mix={on("click", () => {
              anchor = null;
              follow(true);
              handle.queueTask(pin);
            })}
          >
            <Icon icon={ArrowDown} class="size-4" />
            {hasNew ? (
              <span class="absolute top-1 right-1 flex" data-testid="scroll-unseen">
                <UnseenMark />
              </span>
            ) : null}
          </button>
        ) : null}
      </div>
    );
  };
}
