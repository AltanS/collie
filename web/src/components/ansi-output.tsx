import { Fragment, memo, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";
import { parseAnsi, type AnsiSegment } from "@/lib/ansi";
import {
  buildBlocks,
  splitLines,
  type Block,
  type PreviewSelectModel,
  type PromptModel,
  type PromptOption,
  type WizardModel,
} from "@/lib/blocks";
import { lineText } from "@/lib/grammar/markers";
import { findMatches, splitSegment, type FindMatch } from "@/lib/find";
import { PromptSelectBlock } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";

/** A raw block, narrowed off the Block union (the highlight/offset paths only touch these). */
type RawBlock = Extract<Block, { kind: "raw" }>;
/** The (at most one) prompt-select block — always at the tail. */
type PromptBlock = Extract<Block, { kind: "prompt-select" }>;
/** The (at most one) wizard block — always at the tail, mutually exclusive with prompt-select. */
type WizBlock = Extract<Block, { kind: "wizard" }>;
/** The (at most one) preview-select block — tail, mutually exclusive with the other two. */
type PrevBlock = Extract<Block, { kind: "preview-select" }>;

export interface AnsiOutputProps {
  text: string;
  className?: string;
  /** false = no wrap; the block scrolls horizontally, preserving column alignment. Default false — enable Wrap in View for prose. */
  wrap?: boolean;
  /** Monospace font size in px. Default 11. */
  fontSize?: number;
  /** Active find query. Empty (the default) = not searching: the fast, allocation-free render path. */
  query?: string;
  /** Index of the focused match — highlighted stronger and scrolled into view. -1 = none. */
  currentMatch?: number;
  /** Reports the current match count back to the parent (drives the find bar's "3/17"). */
  onMatchCount?: (count: number) => void;
  /** The pane's agent — gates the Claude-only block grammars (prompt-select, chrome). Absent/other
   *  agents render pure raw output. */
  agent?: string;
  /** Injected handler for a prompt-select tap (the race guard lives in AgentChat). Absent (or with a
   *  disabled block) means the buttons render but don't act — AnsiOutput never touches the network. */
  onPromptAction?: (option: PromptOption, prompt: PromptModel) => void | Promise<void>;
  /** Injected handler for a wizard tap — one race-guarded keystroke per control (see
   *  lib/wizard-action.ts). Same presentational contract as onPromptAction. */
  onWizardAction?: (keys: string[], wizard: WizardModel) => void | Promise<void>;
  /** Injected handler for a preview-dialog tap (option / note / step-nav intents — the race-guarded
   *  choreography lives in lib/preview-action.ts). Same presentational contract as onPromptAction. */
  onPreviewAction?: (action: PreviewBlockAction, preview: PreviewSelectModel) => void | Promise<void>;
  /** Disable the prompt-select/wizard/preview buttons (read-only device / gone pane). */
  promptDisabled?: boolean;
}

// Stable empty result so the "not searching" path keeps the same `matches` reference across polls
// (no needless effect re-runs / parent count updates while find is closed).
const NO_MATCHES: FindMatch[] = [];

function preClass(wrap: boolean, className?: string): string {
  return cn(
    "m-0 font-mono leading-[1.25] tracking-normal text-foreground [font-variant-ligatures:none]",
    wrap
      ? "whitespace-pre-wrap break-words"
      : "min-w-0 w-full max-w-full whitespace-pre overflow-x-auto overscroll-x-contain [touch-action:pan-x_pan-y]",
    className,
  );
}

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
// Performance: parseAnsi + block-building run once per unique `text` (and `agent`) value (useMemo),
// and React.memo prevents re-renders when props are unchanged — critical for the polling cadence on
// mobile. When not searching (`query` empty) the render skips splitSegment entirely.
export const AnsiOutput = memo(function AnsiOutput({
  text,
  className,
  wrap = false,
  fontSize = 11,
  query = "",
  currentMatch = -1,
  onMatchCount,
  agent,
  onPromptAction,
  onWizardAction,
  onPreviewAction,
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

  useEffect(() => {
    onMatchCount?.(matches.length);
  }, [matches, onMatchCount]);

  const currentRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (currentMatch < 0) return;
    currentRef.current?.scrollIntoView({ block: "center", behavior: "auto" });
  }, [currentMatch, matches]);

  // Muted = box-drawing / rule glyphs. Use muted-foreground (readable on dark) and drop ANSI dim
  // opacity so table borders stay visible — var(--border) + dim made them nearly invisible on mobile.
  const styleFor = (s: AnsiSegment): CSSProperties =>
    s.muted
      ? { ...s.style, color: "var(--muted-foreground)", fontWeight: 400, opacity: 1 }
      : s.style;

  const prompt = promptBlock ? (
    <PromptSelectBlock
      prompt={promptBlock.prompt}
      disabled={promptDisabled || !onPromptAction}
      onAction={(option) => onPromptAction?.(option, promptBlock.prompt)}
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
  ) : null;

  // Fast path — not searching. No global offsets, no splitSegment: one plain span per segment, with
  // "\n" text nodes between lines (and between raw blocks). Identical DOM text to the pre-blocks render.
  if (matches.length === 0) {
    return (
      <>
        {rawBlocks.length > 0 && (
          <pre className={preClass(wrap, className)} style={{ fontSize: `${fontSize}px` }}>
            {rawBlocks.map((block, bi) => (
              <Fragment key={bi}>
                {bi > 0 ? "\n" : null}
                {block.lines.map((line, li) => (
                  <Fragment key={li}>
                    {li > 0 ? "\n" : null}
                    {line.segments.map((s, si) => (
                      <span key={si} style={styleFor(s)}>
                        {s.text}
                      </span>
                    ))}
                  </Fragment>
                ))}
              </Fragment>
            ))}
          </pre>
        )}
        {prompt}
      </>
    );
  }

  // Highlight path. Thread a running global offset through raw blocks → lines → segments (advancing
  // by 1 for each inter-line/inter-block "\n" separator) so splitSegment can tag each segment's
  // slices with the global match index. `currentAssigned` refs only the first slice of the focused
  // match (a match can span segments on a colour change) so scrollIntoView targets one stable node.
  let offset = 0;
  let currentAssigned = false;
  const renderBlock = (block: RawBlock, bi: number) => {
    if (bi > 0) offset += 1; // the "\n" separating this block from the previous
    return (
      <Fragment key={bi}>
        {bi > 0 ? "\n" : null}
        {block.lines.map((line, li) => {
          if (li > 0) offset += 1; // the "\n" separating this line from the previous
          const segNodes = line.segments.map((s, si) => {
            const segStart = offset;
            offset += s.text.length;
            const pieces = splitSegment(s.text, segStart, matches);
            return (
              <span key={si} style={styleFor(s)}>
                {pieces.map((p, j) => {
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
                        "rounded-[2px]",
                        isCurrent ? "bg-yellow-400 text-black" : "bg-yellow-400/30",
                      )}
                    >
                      {p.text}
                    </span>
                  );
                })}
              </span>
            );
          });
          return (
            <Fragment key={li}>
              {li > 0 ? "\n" : null}
              {segNodes}
            </Fragment>
          );
        })}
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
