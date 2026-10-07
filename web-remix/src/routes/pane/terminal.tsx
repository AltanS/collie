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
import { Frame, on, ref, type Handle, type RemixNode } from "remix/component";
import { ArrowDown, ArrowUpToLine, LoaderCircle, ScrollText } from "lucide";

import type { StyledLine } from "@web/lib/blocks";
import { findLinks, type LinkMatch } from "@web/lib/links";
import { t } from "@web/lib/i18n";

import { countRender } from "../../lib/render-count";
import type { Find } from "../../lib/find";
import { decorateRows, haystackOf } from "../../screen/decorate";
import { createTailPin, isAtBottom, recallSpot, rememberSpot } from "../../screen/follow";
import { toRows, type Row } from "../../screen/rows";
import { MUSE_MIRROR, Screen } from "../../screen/screen";
import { Button } from "../../ui/button";
import { Collapse } from "../../ui/collapse";
import { Icon } from "../../ui/icon";
import { UnseenMark } from "../../ui/unseen-mark";
import { bindGlideScreenFrame } from "../../lib/glide";
import { SCREEN_FRAME } from "./frames";

/** The top-of-mirror affordance (agent-chat.tsx): History for a session, Load older for scrollback. */
export type MirrorTop = { kind: "history"; onOpen: () => void } | { kind: "older"; loading: boolean; onOlder: () => void } | null;

/** Widths of the bars, cycled down the screen so the rows read as lines of output, not as a block. */
const BAR_WIDTHS = ["72%", "48%", "86%", "30%", "64%", "92%", "40%", "78%", "56%", "68%", "34%", "84%", "52%", "74%", "44%", "62%"] as const;
/** More rows than any phone shows (the clip cuts the rest), so a tall screen is never half empty. */
const TERMINAL_BARS = [...BAR_WIDTHS, ...BAR_WIDTHS, ...BAR_WIDTHS] as const;
/** One user turn (a boxed head, then its lines), then replies: bars only, no box. */
const CHAT_TURN: readonly (readonly string[])[] = [["82%", "58%"], ["94%", "88%", "71%", "40%"], ["46%"], ["90%", "76%", "52%"]];
/** Three turns' worth, more than a phone shows (the clip cuts the rest). The first block is the boxed one. */
const CHAT_BLOCKS: readonly (readonly string[])[] = [...CHAT_TURN, ...CHAT_TURN, ...CHAT_TURN];

/**
 * What a pane's screen draws from the first frame until its first text: muted bars in `.count-skeleton`
 * (the breathing the Changes list and the Crew tab use, still under reduced motion), never an empty
 * box. It fills the screen region it stands in (the region is `flex-1`, so the composer, the belt and
 * the strips under it keep their place when the text arrives) and clips what does not fit, so a tall
 * phone and a short one both end on a whole row. `kind` is the view the operator chose: "terminal"
 * draws lines of output, "chat" draws a user turn and a reply, so the Chat view never shows the
 * mirror's shape first (the 38 ms Terminal flash before Chat replaced it).
 */
export function ScreenSkeleton(handle: Handle<{ kind: "terminal" | "chat"; fontSize?: number }>) {
  return () => {
    const { kind, fontSize = 13 } = handle.props;
    return (
      <div
        role="status"
        data-slot="screen-skeleton"
        data-kind={kind}
        class={`relative min-h-0 flex-1 overflow-hidden ${kind === "chat" ? "px-3 pt-2" : "px-2 pb-3"}`}
      >
        <span class="sr-only">{t("chat.scrollback.loading")}</span>
        {kind === "terminal" ? (
          <div aria-hidden="true" class="flex flex-col">
            {TERMINAL_BARS.map((width, i) => (
              <div key={String(i)} class="flex items-center" style={{ height: `${(fontSize * 1.5).toFixed(1)}px` }}>
                <span class="count-skeleton h-2.5 rounded-full bg-muted" style={{ width }} />
              </div>
            ))}
          </div>
        ) : (
          <div aria-hidden="true" class="flex flex-col gap-3">
            {CHAT_BLOCKS.map((lines, i) => (
              <div key={String(i)} class={i === 0 ? "flex flex-col gap-2 rounded-md border border-border px-3 py-2.5" : "flex flex-col gap-2 px-0.5"}>
                {i === 0 ? <span class="count-skeleton h-2.5 rounded-full bg-muted" style={{ width: "24%" }} /> : null}
                {lines.map((width, j) => (
                  <span key={String(j)} class="count-skeleton h-2.5 rounded-full bg-muted" style={{ width }} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };
}

const EDGE_ROW =
  "mb-2 flex w-full items-center justify-center gap-1.5 rounded-md py-2 text-xs font-medium text-muted-foreground transition-colors active:bg-muted/50 disabled:opacity-60";

export interface TerminalViewProps {
  /** The scroll-memory key: the pane's (host, session, pane) key. */
  spotKey: string;
  lines: readonly StyledLine[];
  /** The pane read's unwrapped text, so a URL broken across rows still links whole. */
  logicalText?: string;
  /** The mirror has never answered: draw the skeleton, never "(no recent output)" and never a blank box. */
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
  /**
   * The rows come from the `pane-screen` server frame at this src (S2, routes/pane/frames.ts), or the
   * browser draws them when undefined. While the find bar is open the browser draws them anyway: its
   * marks are the browser's, and a server row cannot carry them.
   */
  frameSrc?: string;
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
  /** This view drew its skeleton first: the first text fades in over it (`.count-arrive`, still under reduced motion). */
  let sawSkeleton = false;

  const save = (): void => {
    if (scroller) rememberSpot(spotKey, { following, top: scroller.scrollTop });
  };

  const tail = createTailPin();
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
    if (following) tail.pin(scroller);
  };

  /** A send asked for the tail: pin after this commit even if no size moved. */
  let pinNext = false;
  // AFTER EACH COMMIT, ONLY WHAT A SIZE CHANGE WOULD NOT DO (REMIX3.md, "Layout in insert callbacks").
  // Pinning reads `scrollHeight`, which inside the flush forces the layout of everything the commit
  // changed (10 ms and more per pin at 4x CPU, research note 05). While following, the scroller's
  // ResizeObserver below already pins after the browser's own layout whenever the box or the content
  // changes size, the first frame included; so the commit pins only for an anchor, a spot to restore,
  // or a send that asked for the tail.
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

  handle.signal.addEventListener("abort", save);

  return () => {
    countRender("TerminalView");
    const { lines, loading, blank, lead, hideLeading, wrap, fontSize, native, faceClass, faceFamily, find, top, notes, tailRev, logicalText, frameSrc } = handle.props;
    // The server frame draws the rows unless the find bar needs the browser's own (see `frameSrc`).
    const framed = frameSrc !== undefined && !find.state.get().open;
    if (tailRev !== seenTail) {
      seenTail = tailRev;
      following = true;
      restoreTop = null;
      anchor = null;
      pinNext = true;
    }
    // Framed, the rows are the server's: nothing to build here, and `rows` stays as it was.
    if (!framed && lines !== lastLines) {
      lastLines = lines;
      rows = toRows(lines, rows);
    }
    const olderLoading = top?.kind === "older" && top.loading;
    // A Load older that landed takes the new rows even while scrolled up: the reader asked for them.
    if (framed) {
      // The frame is not reloaded while scrolled up (pane-frames.ts, FROZEN): the lines it shows are
      // the ones last taken while following, which is what the jump button's dot compares against.
      if (following || shownLines.length === 0 || anchor !== null) shownLines = lines;
    } else if (following || shown.length === 0 || (anchor !== null && shown !== rows)) {
      shown = rows;
      shownLines = lines;
    }
    if (anchor !== null && !olderLoading && (framed ? shownLines === lines : shown === rows)) {
      const held = anchor;
      handle.queueTask(() => {
        if (anchor === held) anchor = null;
      });
    }
    const hasNew = !following && (framed ? shownLines !== lines : shown !== rows);
    // The reply card's rows come off what is SHOWN, frozen or live, so folding the card gives them
    // back at once even while the reader is scrolled up (web hides them off its frozen `display`).
    if (cut === null || cut.rows !== shown || cut.n !== hideLeading) {
      cut = hideLeading > 0 ? { rows: shown, n: hideLeading, outRows: shown.slice(hideLeading), outLines: shownLines.slice(hideLeading) } : { rows: shown, n: 0, outRows: shown, outLines: shownLines };
    }
    const visibleRows = cut.outRows;
    const visibleLines = cut.outLines;
    const framedRows = Math.max(0, shownLines.length - hideLeading);

    // Links and find marks are laid over the browser's own rows only; a framed row has its links from
    // the server (ssr/frames.tsx) and find never runs while framed.
    let drawn = visibleRows;
    let found: ReturnType<Find["measure"]> = { matches: [], current: -1 };
    if (!framed) {
      const hay = haystackOf(visibleLines);
      if (hay.text !== lastHaystack || logicalText !== lastLogical) {
        lastHaystack = hay.text;
        lastLogical = logicalText;
        links = findLinks(hay.text, logicalText);
      }
      found = find.measure(hay.text);
      drawn = decorateRows(visibleRows, visibleLines, hay.starts, found.matches, found.current, links);
    }
    handle.queueTask(() => {
      if (framed) bindGlideScreenFrame(handle.frames.get(SCREEN_FRAME), handle.signal);
      pinAfterCommit();
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

    if (loading) sawSkeleton = true;
    return (
      <div class="relative flex min-h-0 flex-1 flex-col" data-slot="terminal-view">
        {loading ? <ScreenSkeleton kind="terminal" fontSize={fontSize} /> : null}
        {loading ? null : (
        <div
          data-testid="pane-scroller"
          class={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3 ${native ? MUSE_MIRROR : "bg-background"}${sawSkeleton ? " count-arrive" : ""}`}
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
              // The CONTENT too: the reply card's transcript settles a few px after the render-time
              // pin (images, fonts, its Collapse), which moves no scroll event and left the tail
              // short of the end until the next poll re-pinned. One block wrapper, so no layout moves.
              const content = node.firstElementChild;
              if (content) keep.observe(content);
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
          <div data-slot="terminal-content">
            <div>
              {edge}
              {notes.map((note) => (
                <p key={note} class="mb-2 px-2 py-1 text-center text-xs leading-snug text-muted-foreground">
                  {note}
                </p>
              ))}
            </div>
            <Collapse open={lead !== undefined && lead !== null}>{lead}</Collapse>
            {blank ? (
              <p class="py-16 text-center text-sm text-muted-foreground" data-testid="mirror-empty">
                {t("chat.output.empty")}
              </p>
            ) : framed && framedRows > 0 ? (
              // The rows the reply card covers stay in the frame's HTML and are hidden by position: the
              // frame is the server's, and its rows carry no client state to cut them by.
              <>
                {hideLeading > 0 ? <style>{`[data-frame="pane-screen"] > div:nth-child(-n+${String(hideLeading)}){display:none}`}</style> : null}
                <Screen
                  rows={drawn}
                  frame={<Frame name={SCREEN_FRAME} src={frameSrc ?? ""} />}
                  frameRows={framedRows}
                  wrap={wrap}
                  fontSize={fontSize}
                  native={native}
                  faceClass={faceClass}
                  faceFamily={faceFamily}
                  testId="pane-text"
                />
              </>
            ) : !framed && drawn.length > 0 ? (
              <Screen rows={drawn} wrap={wrap} fontSize={fontSize} native={native} faceClass={faceClass} faceFamily={faceFamily} testId="pane-text" />
            ) : null}
          </div>
        </div>
        )}
        {!following && !loading ? (
          // The shared Button: web's pill is one, so it wears its press (`active:scale-[0.98]`, `transition-all`).
          <Button
            variant="outline"
            size="icon"
            aria-label={t("common.scrollToLatestAria")}
            data-testid="scroll-to-latest"
            class="absolute right-3 bottom-3 size-11 rounded-full bg-background/90 shadow-md backdrop-blur"
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
          </Button>
        ) : null}
      </div>
    );
  };
}
