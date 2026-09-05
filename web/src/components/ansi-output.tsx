import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi, type AnsiSegment } from "@/lib/ansi";
import { buildBlocks } from "@/lib/harness";
import {
  lineText,
  splitLines,
  type Block,
  type MenuModel,
  type MultiSelectModel,
  type PreviewSelectModel,
  type PromptModel,
  type StyledLine,
  type WizardModel,
} from "@/lib/blocks";
import { tableRuns, type TableRun } from "@/lib/table-run";
import { MIRROR_SPACE, MIRROR_INVERT, styleFor } from "@/components/mirror-space";
import { findMatches, splitSegment, type FindMatch } from "@/lib/find";
import { findLinks } from "@/lib/links";
import { PromptSelectBlock, type PromptBlockAction } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";
import { MultiSelectBlock } from "@/components/multi-select-block";
import { MenuBlock, type MenuBlockAction } from "@/components/menu-block";
import { AutocompleteBlock } from "@/components/autocomplete-block";
import type { MultiSelectIntent } from "@/lib/multi-select-action";

/** A raw block, narrowed off the Block union (the highlight/offset paths only touch these). */
type RawBlock = Extract<Block, { kind: "raw" }>;
/** The (at most one) prompt-select block — always at the tail. */
type PromptBlock = Extract<Block, { kind: "prompt-select" }>;
/** The (at most one) wizard block — always at the tail, mutually exclusive with prompt-select. */
type WizBlock = Extract<Block, { kind: "wizard" }>;
/** The (at most one) preview-select block — tail, mutually exclusive with the other two. */
type PrevBlock = Extract<Block, { kind: "preview-select" }>;
/** The (at most one) multi-select block — tail, mutually exclusive with the other dialog blocks. */
type MultiBlock = Extract<Block, { kind: "multi-select" }>;
/** The (at most one) generic-menu block — tail, and only ever lifted when all four above declined. */
type GenericMenuBlock = Extract<Block, { kind: "menu" }>;
/** The (at most one) completion-popup block — tail, and the only non-raw kind that is NOT a modal:
 *  the agent's input box is live under it, so it renders with no controls and locks nothing. */
type AutoBlock = Extract<Block, { kind: "autocomplete" }>;

export interface AnsiOutputProps {
  text: string;
  className?: string;
  /** true = wrap; the block breaks at the viewport width instead of scrolling horizontally. Default
   *  true — the mirror is mostly agent prose, and a phone shows far fewer columns than the desktop
   *  width panes are spawned at, so panning was the common case. Tables are the exception and are
   *  handled inside that default (lib/table-run.ts): each one pans in its own scroller, so turning
   *  Wrap off is now only for output whose columns matter EVERYWHERE, such as a full-screen TUI. */
  wrap?: boolean;
  /** Monospace font size in px. Default 11. */
  fontSize?: number;
  /** Active find query. Empty (the default) = not searching: the fast, allocation-free render path. */
  query?: string;
  /** Index of the focused match — highlighted stronger and scrolled into view. -1 = none. */
  currentMatch?: number;
  /** Reports the current match count back to the parent (drives the find bar's "3/17"). */
  onMatchCount?: (count: number) => void;
  /** The pane's agent — picks the adapter whose block grammars run (prompt-select, chrome). Each
   *  registered adapter contributes its own: claude lifts dialogs and strips chrome, omp strips chrome
   *  only. An absent/unregistered agent renders pure raw output. */
  agent?: string;
  /** Injected handler for a prompt-select tap (the race guard lives in AgentChat). Absent (or with a
   *  disabled block) means the buttons render but don't act — AnsiOutput never touches the network. */
  onPromptAction?: (
    action: PromptBlockAction,
    prompt: PromptModel,
  ) => boolean | void | Promise<boolean | void>;
  /** Injected handler for a wizard tap — one race-guarded keystroke per control (see
   *  lib/wizard-action.ts). Same presentational contract as onPromptAction. */
  onWizardAction?: (keys: string[], wizard: WizardModel) => void | Promise<void>;
  /** Injected handler for a preview-dialog tap (option / note / step-nav intents — the race-guarded
   *  choreography lives in lib/preview-action.ts). Same presentational contract as onPromptAction. */
  onPreviewAction?: (action: PreviewBlockAction, preview: PreviewSelectModel) => void | Promise<void>;
  /** Injected handler for a multi-select tap (toggle / submit / escape / confirm / cancel — the
   *  race-guarded choreography lives in lib/multi-select-action.ts). Same presentational contract. */
  onMultiSelectAction?: (action: MultiSelectIntent, multi: MultiSelectModel) => void | Promise<void>;
  /** Injected handler for a generic-menu tap (a footer-named key, or an arrow — the race-guarded
   *  send lives in lib/menu-action.ts). Same presentational contract as onPromptAction. */
  onMenuAction?: (action: MenuBlockAction, menu: MenuModel) => void | Promise<void>;
  /** Disable the prompt-select/wizard/preview/multi-select/menu buttons (read-only / gone pane). */
  promptDisabled?: boolean;
}

// Stable empty result so the "not searching" path keeps the same `matches` reference across polls
// (no needless effect re-runs / parent count updates while find is closed).
const NO_MATCHES: FindMatch[] = [];
/** The grammar's own frozen empty result, so "this block has no table" is one identity everywhere.
 *  `NO_BLOCK_RUNS` is the wrap-off answer for EVERY block at once: that path computes nothing, and
 *  the lookup below falls through to NO_RUNS for each block it asks about. */
const NO_RUNS = tableRuns([]);
const NO_BLOCK_RUNS: readonly (readonly TableRun[])[] = Object.freeze([]);

// The mirror's dark colour space and its light-theme inversion live in mirror-space.ts — the
// statusline strip renders the same terminal segments and the two must not drift.

// An autolinked URL keeps the colour the agent printed — recolouring it would lie about the
// terminal's own output — and is marked by an underline in `currentColor`, which is legible against
// whatever the mirror's background is under either theme.
//
// `py-[0.35em]` is the tap target, and it is free: vertical padding on an INLINE box doesn't grow
// the line box, so the mirror's height and the terminal grid are identical with or without it
// (measured: same <pre> height either way) while the hit area goes from ~14px to ~22px on a phone.
// It must stay em-relative and small, and the reason is NOT that the padded box fits the line box —
// it doesn't: ~14px of content plus 2x4.2px of padding is ~22px against a 15px line advance, so it
// overlaps its neighbours by design. Two things make that safe, and both must hold:
//   1. The pad never reaches the neighbouring line's CENTRE at any size the A+/A- control offers.
//      A px value tuned for 12px text would, at the 9px floor — and a tap on ordinary output would
//      silently open a link. This is why it stays em-relative.
//   2. Where the overlap does cover the next line's text, that line's spans come later in DOM order
//      and win inline hit-testing, so a tap on visible text goes to the text. Only empty space
//      beside a link can bleed to the anchor.
// Don't convert it to a px value, and don't "fix" it to fit the line box — that would undo (1).
const LINK_CLASS =
  "underline decoration-1 underline-offset-2 break-all cursor-pointer py-[0.35em]";

// A segment marked `mobileTransparentBg` hands its ANSI fill to a custom property instead of the
// inline `background-color`, and `.terminal-mobile-transparent-bg` in index.css paints it: on a
// desktop from the property, on a phone not at all. Inline styles beat a class, so the alternative
// spelling is `!important` in the stylesheet. Every other segment takes the plain inline style, and
// the other mirror surface (the statusline strip) calls styleFor directly and is unaffected.
function segmentStyle(s: AnsiSegment): CSSProperties {
  const style = styleFor(s);
  if (!s.mobileTransparentBg) return style;
  const { backgroundColor, ...rest } = style;
  // SAFETY: a CSS custom property is a valid style key at runtime; React passes any `--*` key
  // straight to the CSSOM. CSSProperties has no index signature for it, so the cast is the only
  // spelling. The value is the backgroundColor just removed from the same object.
  return { ...rest, "--terminal-seg-bg": backgroundColor } as CSSProperties;
}

function preClass(wrap: boolean, className?: string): string {
  return cn(
    "m-0 font-mono leading-[1.25] tracking-normal text-foreground [font-variant-ligatures:none]",
    MIRROR_SPACE,
    MIRROR_INVERT,
    wrap
      ? "whitespace-pre-wrap break-words"
      : // Horizontal pan for wide TUI tables. `overflow-x-auto` forces `overflow-y` to compute to
        // `auto` (CSS overflow quirk), and a flex item with non-visible overflow may shrink below its
        // content height — the <pre> then becomes the vertical scroller and ChatMessageList's
        // stickiness is a no-op (pane opens stuck at the oldest scrollback). `shrink-0` keeps the
        // pre at content height so vertical scroll stays on the outer list; x-scroll still works.
        "min-w-0 w-full max-w-full shrink-0 whitespace-pre overflow-x-auto overscroll-x-contain [touch-action:pan-x_pan-y]",
    className,
  );
}

// A table run (lib/table-run.ts) is the one thing Wrap must not reflow, so it pans in its own
// scroller while the mirror around it keeps wrapping. Five details are load-bearing:
//
//   · `inline-block`, not `block`. The run sits between the same "\n" text nodes as every other
//     line, and the mirror's find offsets, its link offsets and a clipboard copy are all defined by
//     those nodes. A block box would need them deleted either side of every run — three coordinate
//     spaces perturbed for a line break the inline-block already gets from the newline it follows.
//     Same in-flow shape as the single-row border clip below, which is not the same class string.
//     `align-bottom` keeps its rows on the mirror's own 1.25em grid: `baseline` would add the
//     strut's descent under the table. `w-full` makes the box fill the line instead of shrinking to
//     fit, so a table narrower than the mirror still scrolls from the same left edge as the prose.
//   · `overscroll-x-contain` and `[touch-action:pan-x_pan-y]`, for the same reason preClass carries
//     them: a pan that reaches the end of the table must not become a page-level swipe, and the
//     vertical gesture must still reach the message list underneath.
//   · `overflow-y-hidden`, explicitly. `overflow-x-auto` alone computes `overflow-y` to `auto` (the
//     CSS quirk preClass documents), and LINK_CLASS's em-padding deliberately overflows its line box
//     — so an autolinked URL in a cell would make the run a second, stray vertical scroller. What y
//     clipping costs is one pixel: measured at every size the A+/A- control offers, the first row's
//     ink starts 1.0px above the run's border box, so the very top of a tall glyph is cut. The last
//     row and a link's underline are inside the box at every size.
//   · No scrollbar of its own. A classic (non-overlay) scrollbar is laid INSIDE an auto-height box,
//     so it would cover about 15px at the foot of the run — a whole 13.75px row at fontSize 11 —
//     and `overflow-y-hidden` leaves no way to reach what it covers. Overlay scrollbars, i.e. every
//     phone, never showed one anyway. Same spelling the strips use.
//   · `whitespace-pre` beats the <pre>'s `pre-wrap` for its subtree, which is the whole point, and
//     it also means a run narrower than the phone simply does not scroll.
const TABLE_RUN_CLASS =
  "inline-block w-full max-w-full align-bottom whitespace-pre break-normal overflow-x-auto overflow-y-hidden overscroll-x-contain [touch-action:pan-x_pan-y] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden";

// Faithful, colored mirror of a pane's recent terminal output. Rendering flows through the Block AST
// (blocks.ts): parseAnsi → styled lines → typed blocks → React. Text is always rendered as React
// text nodes (escaped); only color/weight come from the ANSI parse — no XSS surface.
//
// For a Claude pane the AST may lift the tail into a `prompt-select` block (native buttons) and strip
// the agent's own input-box chrome; everything else stays a `raw` block that reproduces exactly what
// the flat renderer produced (one <span> per segment, "\n" text nodes between lines). Raw blocks go
// inside the <pre>; the prompt-select block renders after it as its own button group.
//
// Find-in-output highlights matches over the RAW blocks only — the prompt-select block's text is
// rendered as buttons, not searchable mirror text. The haystack is the concatenation of the raw
// blocks' line text (newlines included), and the renderer threads a running offset through
// blocks → lines → segments so each segment maps back to that same coordinate space. (A find query
// can't contain a newline, so no match straddles the inter-line separators.)
//
// Autolinked URLs (lib/links.ts) live in that SAME coordinate space and are applied over the raw
// blocks too, as anchors wrapping the find-highlighted runs. Only `http(s)://` text becomes a link,
// and the href is the matched text itself — no scheme can appear that wasn't printed by the agent.
//
// Performance: parseAnsi + block-building run once per unique `text` (and `agent`) value (useMemo),
// as does the link scan; React.memo prevents re-renders when props are unchanged — critical for the
// polling cadence on mobile. With no query and no links the render skips splitSegment entirely and
// emits the segment's own string, exactly as the pre-find flat renderer did.
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
  wrap = true,
  fontSize = 11,
  query = "",
  currentMatch = -1,
  onMatchCount,
  agent,
  onPromptAction,
  onWizardAction,
  onPreviewAction,
  onMultiSelectAction,
  onMenuAction,
  promptDisabled,
}: AnsiOutputProps) {
  const segments = useMemo(() => parseAnsi(text), [text]);
  const blocks = useMemo(() => buildBlocks(splitLines(segments), { agent }), [segments, agent]);

  const rawBlocks = useMemo(
    () => blocks.filter((b): b is RawBlock => b.kind === "raw"),
    [blocks],
  );
  const promptBlock = useMemo(
    () => blocks.find((b): b is PromptBlock => b.kind === "prompt-select") ?? null,
    [blocks],
  );
  const wizardBlock = useMemo(
    () => blocks.find((b): b is WizBlock => b.kind === "wizard") ?? null,
    [blocks],
  );
  const previewBlock = useMemo(
    () => blocks.find((b): b is PrevBlock => b.kind === "preview-select") ?? null,
    [blocks],
  );
  const multiBlock = useMemo(
    () => blocks.find((b): b is MultiBlock => b.kind === "multi-select") ?? null,
    [blocks],
  );
  const menuBlock = useMemo(
    () => blocks.find((b): b is GenericMenuBlock => b.kind === "menu") ?? null,
    [blocks],
  );
  const autoBlock = useMemo(
    () => blocks.find((b): b is AutoBlock => b.kind === "autocomplete") ?? null,
    [blocks],
  );

  // The table runs of each raw block, by block index. Only while wrapping: with Wrap off the whole
  // <pre> already pans column-faithfully, and a nested scroller would just trap the gesture — so
  // that branch computes nothing at all and every block falls through to NO_RUNS below.
  const runsByBlock = useMemo(
    () => (wrap ? rawBlocks.map((b) => tableRuns(b.lines)) : NO_BLOCK_RUNS),
    [rawBlocks, wrap],
  );

  // Find offsets live over the *raw* mirror text (raw blocks joined by "\n", lines joined by "\n").
  // The join only runs while actually searching, so the idle polling path pays nothing.
  const haystack = useMemo(
    () => rawBlocks.map((b) => b.lines.map(lineText).join("\n")).join("\n"),
    [rawBlocks],
  );
  const matches = useMemo(() => {
    if (!query) return NO_MATCHES;
    return findMatches(haystack, query);
  }, [haystack, query]);

  // Autolinked URLs, in the SAME offset space as find matches — both are ranges over `haystack`, so
  // one running offset serves both splits. Recomputed only when the mirror text changes.
  const links = useMemo(() => findLinks(haystack), [haystack]);

  useEffect(() => {
    onMatchCount?.(matches.length);
  }, [matches, onMatchCount]);

  const currentRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (currentMatch < 0) return;
    currentRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [currentMatch, matches]);

  // Muted = box-drawing / rule glyphs. Drop ANSI dim opacity so table borders stay visible —
  // var(--border) + dim made them nearly invisible on mobile. See styleFor in mirror-space.ts.

  const prompt = promptBlock ? (
    <PromptSelectBlock
      prompt={promptBlock.prompt}
      disabled={promptDisabled || !onPromptAction}
      onAction={(action) => onPromptAction?.(action, promptBlock.prompt) ?? false}
    />
  ) : wizardBlock ? (
    <WizardBlock
      wizard={wizardBlock.wizard}
      disabled={promptDisabled || !onWizardAction}
      onAction={(keys) => onWizardAction?.(keys, wizardBlock.wizard)}
    />
  ) : previewBlock ? (
    <PreviewSelectBlock
      preview={previewBlock.preview}
      disabled={promptDisabled || !onPreviewAction}
      onAction={(action) => onPreviewAction?.(action, previewBlock.preview)}
    />
  ) : multiBlock ? (
    <MultiSelectBlock
      multi={multiBlock.multi}
      disabled={promptDisabled || !onMultiSelectAction}
      onAction={(action) => onMultiSelectAction?.(action, multiBlock.multi)}
    />
  ) : menuBlock ? (
    <MenuBlock
      menu={menuBlock.menu}
      lines={menuBlock.lines}
      disabled={promptDisabled || !onMenuAction}
      onAction={(action) => onMenuAction?.(action, menuBlock.menu)}
    />
  ) : autoBlock ? (
    // No handler and no `disabled`: the completion popup emits no keystroke, so there is nothing for
    // a read-only device to be refused. It is last in the chain only because it is the least
    // specific tail shape; the grammars above are mutually exclusive with it anyway (a popup means an
    // input box, and every dialog above means there isn't one).
    <AutocompleteBlock autocomplete={autoBlock.autocomplete} />
  ) : null;

  // Thread a running global offset through raw blocks → lines → segments (advancing by 1 for each
  // inter-line/inter-block "\n" separator) so both splits below can map a segment's slices back to
  // the haystack. With no query and no links this costs one addition per segment and allocates
  // nothing beyond the spans — the polling path stays as cheap as the old flat render.
  let offset = 0;
  let currentAssigned = false;

  // A run of plain text at global offset `start` → nodes, with find matches split out and
  // highlighted. `currentAssigned` refs only the first slice of the focused match (a match can span
  // segments on a colour change) so scrollIntoView targets one stable node.
  const renderFind = (run: string, start: number): ReactNode => {
    if (matches.length === 0) return run;
    return splitSegment(run, start, matches).map((p, j) => {
      if (p.matchIndex === null) return p.text;
      const isCurrent = p.matchIndex === currentMatch;
      const attach = isCurrent && !currentAssigned;
      if (attach) currentAssigned = true;
      return (
        <span
          key={j}
          ref={attach ? currentRef : undefined}
          data-find-match={isCurrent ? "current" : "other"}
          className={cn(
            "rounded-md",
            // Asymmetric on purpose, and the asymmetry is the whole subtlety.
            //
            // The CURRENT match re-applies the mirror's filter to cancel it, because otherwise
            // yellow-400 comes out of invert+hue-rotate as a dark brown that reads as a redaction
            // bar. It can do that safely only because `text-black` pins its text: black → inner
            // invert → white → outer invert → black.
            //
            // A non-current match sets no text colour, so its text is INHERITED from the segment —
            // dark-space, i.e. light. Double-inverting sends it light → dark → light and it lands
            // light-on-light, erasing the very text you searched for. So the others take the plain
            // single inversion, which renders them as a pale tan wash with the mapped text on top.
            // See .adr/0002 — "cancel the filter only on an element that fully specifies both its
            // foreground and its background".
            isCurrent ? cn(MIRROR_INVERT, "bg-yellow-400 text-black") : "bg-yellow-400/30",
          )}
        >
          {p.text}
        </span>
      );
    });
  };

  // A segment's text → nodes: autolinked URLs as anchors, wrapping find-highlighted runs. Two
  // splits over one coordinate space, links outermost, so a find hit *inside* a URL still lights up.
  // A URL that straddles a colour change yields one <a> per segment slice, each with the same href.
  const renderSegment = (run: string, start: number): ReactNode => {
    if (links.length === 0) return renderFind(run, start);
    let at = start;
    return splitSegment(run, start, links).map((p, i) => {
      const pieceStart = at;
      at += p.text.length;
      if (p.matchIndex === null) return <Fragment key={i}>{renderFind(p.text, pieceStart)}</Fragment>;
      return (
        <a key={i} href={links[p.matchIndex]!.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
          {renderFind(p.text, pieceStart)}
        </a>
      );
    });
  };

  // One mirror line. `lead` says whether this line emits the "\n" that separates it from the one
  // before: the first line of a table run does NOT, because that newline is hoisted out to sit
  // before the run's scroller (inside it, it would open the table with a blank row). The offset is
  // advanced either way — the separator exists in the find/link coordinate space regardless of which
  // element holds its text node.
  //
  // `inRun` settles the PRECEDENCE between the two no-wrap answers, and it is the reconcile with the
  // frame-row clip (blocks.ts FRAME_ROW, issue #156). A box-drawn table's rows open and close on a
  // vertical stroke, so every one of them is `noWrap` as well as a member of a run. THE RUN WINS.
  // Clipping each row on its own would hide the same columns on every row and leave the scroller
  // nothing to pan, so the table would be silently un-pannable, which is the exact failure this
  // change exists to fix. A frame row that is NOT in a run, a lone menu or panel border, keeps its clip
  // untouched: a detected table owns its own rows, and nothing beyond them.
  const renderLine = (line: StyledLine, li: number, lead: boolean, inRun: boolean): ReactNode => {
    if (li > 0) offset += 1; // the "\n" separating this line from the previous
    const segNodes = line.segments.map((s, si) => {
      const segStart = offset;
      offset += s.text.length;
      return (
        <span
          key={si}
          style={segmentStyle(s)}
          className={s.mobileTransparentBg ? "terminal-mobile-transparent-bg" : undefined}
        >
          {renderSegment(s.text, segStart)}
        </span>
      );
    });
    // A run's own rows are never clipped; see `inRun` above. Outside a run this is unchanged: a
    // repeated rule, or a framed menu row, keeps the single-row clip it has always had.
    const content = line.noWrap && wrap && !inRun ? (
      <span className="inline-block max-w-full overflow-hidden align-bottom whitespace-pre break-normal [&_a]:break-normal">{segNodes}</span>
    ) : (
      segNodes
    );
    return (
      <Fragment key={li}>
        {li > 0 && lead ? "\n" : null}
        {content}
      </Fragment>
    );
  };

  const renderBlock = (block: RawBlock, bi: number) => {
    if (bi > 0) offset += 1; // the "\n" separating this block from the previous
    const runs = runsByBlock[bi] ?? NO_RUNS;
    const nodes: ReactNode[] = [];
    let ri = 0;
    for (let li = 0; li < block.lines.length; ) {
      const run: TableRun | undefined = runs[ri];
      if (!run || run.start !== li) {
        nodes.push(renderLine(block.lines[li]!, li, true, false));
        li++;
        continue;
      }
      ri++;
      const rows: ReactNode[] = [];
      for (let k = run.start; k <= run.end; k++) {
        rows.push(renderLine(block.lines[k]!, k, k > run.start, true));
      }
      // Keyed by the table's own first row and height, NEVER by its line index. The mirror is a
      // rendered grid: one new line of output shifts every index by one, and an index key would
      // unmount the scroller on that poll and snap the reader's pan back to column zero — while the
      // table on screen had not moved at all. React reuses the element while the key holds, and
      // scrollLeft lives on the element.
      nodes.push(
        <Fragment key={`run:${run.end - run.start}:${lineText(block.lines[run.start]!)}`}>
          {li > 0 ? "\n" : null}
          <span className={TABLE_RUN_CLASS}>{rows}</span>
        </Fragment>,
      );
      li = run.end + 1;
    }
    return (
      <Fragment key={bi}>
        {bi > 0 ? "\n" : null}
        {nodes}
      </Fragment>
    );
  };

  return (
    <>
      {rawBlocks.length > 0 && (
        <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
          {rawBlocks.map(renderBlock)}
        </pre>
      )}
      {prompt}
    </>
  );
});
