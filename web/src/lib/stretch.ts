// Stretchtext in a reply: `{{short|long}}` marks a stretch, which the reader sees as `short` and can
// open to put `long` in its place. `long` may hold further stretches. Code spans and fences are copied
// as written, so braces in code never open a stretch. Replies written with the cc-stretch Claude Code
// plugin carry this markup, and Collie's journal shows it as Markdown.
//
// `parse` and its helpers are ported from cc-stretch 0.3.4 `hooks/parse.ts`
// (https://github.com/pro-vi/cc-stretch, MIT, Copyright (c) 2026 pro-vi), with the same semantics.
//
// HOW A STRETCH REACHES THE RENDERER. Collie's Markdown parser knows nothing of stretches, so
// `composeStretches` writes the reply as Markdown with each stretch bracketed by private-use
// characters (the markers below), `parseMarkdown` parses that, and `liftStretches` turns each
// bracketed run back into a stretch span. A reply never writes these characters, and every public
// entry point strips them from its input first, so a reply cannot forge a stretch.

import type { MdBlock, MdSpan } from "@/lib/markdown";

/** A segment of a reply: prose as written, or a stretch. */
export type Segment = Prose | Stretch;

export interface Prose {
  kind: "prose";
  text: string;
}

export interface Stretch {
  kind: "stretch";
  /**
   * Names the stretch by its short form and its parents' (`cache › key`), so a stretch added
   * elsewhere in the reply leaves every other key as it was. A short form repeated among siblings
   * takes `~2`, `~3`.
   */
  key: string;
  short: string;
  /** Undefined when no `|` was written: then there is nothing to open, and `short` is plain text. */
  long: Segment[] | undefined;
  /** False while the reply streams and the closing braces have not arrived. */
  isClosed: boolean;
}

interface Frame {
  stretch: Stretch;
  siblings: Map<string, number>;
}

const KEY_SEPARATOR = " › ";

/** Opens a closed stretch's short form; the stretch's index in `keys` follows, then {@link STRETCH_SEP}. */
export const STRETCH_OPEN = "\uE000";
/** Ends a closed stretch's index and starts its short form. */
export const STRETCH_SEP = "\uE001";
/** Ends a closed stretch's short form. */
export const STRETCH_END = "\uE002";
/** Opens an open stretch's closer; the stretch's index in `keys` follows, then {@link CLOSER_END}. */
export const CLOSER_OPEN = "\uE003";
/** Ends an open stretch's closer. */
export const CLOSER_END = "\uE004";

const ANY_MARKER = /[\uE000-\uE004]/g;

function stripMarkers(text: string): string {
  return text.replace(ANY_MARKER, "");
}

function isOpenable(stretch: Stretch): boolean {
  return stretch.isClosed && stretch.long !== undefined;
}

/** Whether a stretch is drawn as a link: openable, with its short form on one line, as a link cannot span lines. */
function isLinkable(stretch: Stretch): boolean {
  return isOpenable(stretch) && !stretch.short.includes("\n");
}

/**
 * An open stretch's long form followed by its `closer`, after a space, or after `gap` when the long
 * form ends in a line text after it would change: a rule, which then reads as plain dashes, or a code
 * fence, which then no longer closes.
 */
function closeAfter(long: string, closer: string, gap: string): string {
  const trimmed = long.trimEnd();
  const last = trimmed.slice(trimmed.lastIndexOf("\n") + 1);
  const endsInBlock = isRule(last) || /^ {0,3}(?:`{3,}|~{3,})[ \t]*$/.test(last);

  return endsInBlock ? `${trimmed}${gap}${closer}` : `${long} ${closer}`;
}

/** Whether `line` is a rule: three or more of one of `-`, `*` and `_`, spaces between allowed. */
function isRule(line: string): boolean {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

/** Where the code span opening at `i` ends: past the next run of as many backticks, or at the text's end. */
function codeSpanEnd(text: string, i: number): number {
  const run = /^`+/.exec(text.slice(i))?.[0] ?? "`";
  const end = text.indexOf(run, i + run.length);
  return end === -1 ? text.length : end + run.length;
}

function parse(text: string): Segment[] {
  const root: Segment[] = [];
  const stack: Frame[] = [];
  const rootSiblings = new Map<string, number>();

  const write = (chunk: string) => {
    const frame = stack.at(-1);
    if (frame && frame.stretch.long === undefined) {
      frame.stretch.short += chunk;
      return;
    }
    const segments = frame?.stretch.long ?? root;
    const last = segments.at(-1);
    if (last?.kind === "prose") last.text += chunk;
    else segments.push({ kind: "prose", text: chunk });
  };

  let i = 0;
  while (i < text.length) {
    const frame = stack.at(-1);
    const isInShort = frame !== undefined && frame.stretch.long === undefined;

    const fenceStop = i === 0 || text[i - 1] === "\n" ? fenceEnd(text, i) : undefined;
    if (fenceStop !== undefined) {
      write(text.slice(i, fenceStop));
      i = fenceStop;
      continue;
    }

    if (text[i] === "`") {
      const stop = codeSpanEnd(text, i);
      write(text.slice(i, stop));
      i = stop;
      continue;
    }

    if (text.startsWith("{{", i) && !isInShort) {
      const stretch: Stretch = {
        kind: "stretch",
        key: "",
        short: "",
        long: undefined,
        isClosed: false,
      };
      (frame?.stretch.long ?? root).push(stretch);
      stack.push({ stretch, siblings: new Map() });
      i += 2;
      continue;
    }

    if (isInShort && text[i] === "|") {
      frame.stretch.key = keyOf(frame.stretch.short, stack.at(-2), rootSiblings);
      frame.stretch.long = [];
      i += 1;
      continue;
    }

    if (frame && text.startsWith("}}", i)) {
      frame.stretch.isClosed = true;
      stack.pop();
      i += 2;
      continue;
    }

    write(text[i] ?? "");
    i += 1;
  }

  return root;
}

function keyOf(short: string, parent: Frame | undefined, rootSiblings: Map<string, number>): string {
  const name = short.trim();
  const siblings = parent?.siblings ?? rootSiblings;
  const seen = (siblings.get(name) ?? 0) + 1;
  siblings.set(name, seen);
  const own = seen === 1 ? name : `${name}~${seen}`;

  return parent ? `${parent.stretch.key}${KEY_SEPARATOR}${own}` : own;
}

/** Where a fenced code block opening at `start` ends (past its closing line), or undefined when no fence opens there. */
function fenceEnd(text: string, start: number): number | undefined {
  const lineEnd = (from: number) => {
    const end = text.indexOf("\n", from);
    return end === -1 ? text.length : end;
  };
  const opening = /^[ \t]*(`{3,}|~{3,})/.exec(text.slice(start, lineEnd(start)))?.[1];
  if (opening === undefined) return undefined;

  for (let at = lineEnd(start) + 1; at < text.length; at = lineEnd(at) + 1) {
    const line = text.slice(at, lineEnd(at)).trim();
    if (line.length >= opening.length && [...line].every((c) => c === opening[0])) return Math.min(lineEnd(at) + 1, text.length);
  }

  return text.length;
}

/** Every stretch, outermost first, in the order the reply writes them. */
export function stretches(segments: Segment[]): Stretch[] {
  return segments.flatMap((segment) => (segment.kind === "prose" ? [] : [segment, ...stretches(segment.long ?? [])]));
}

/** A reply's stretches, read from `text` once every marker character is stripped from it. */
export function parseStretches(text: string): Segment[] {
  return parse(stripMarkers(text));
}

/** Markdown source with its stretches marked, and the key of each marked stretch by its index. */
export interface ComposedStretches {
  source: string;
  keys: string[];
}

/**
 * The reply as Markdown source for `parseMarkdown`, drawn as cc-stretch's fullscreen reply draws it:
 * a stretch in `open` (by key) as its long form then its closer, a closed one as its marked short
 * form, and one that cannot be pressed (unclosed, without a long form, or with a short form over
 * several lines) as plain text. `keys` names each marked stretch by its index in the markers, in the
 * order they are written; a closed stretch's long form is not drawn, so its nested stretches have none.
 */
export function composeStretches(segments: Segment[], open: ReadonlySet<string>): ComposedStretches {
  const keys: string[] = [];
  const write = (parts: Segment[]): string => parts.map((part) => (part.kind === "prose" ? part.text : draw(part))).join("");
  const draw = (stretch: Stretch): string => {
    if (stretch.long === undefined || !stretch.isClosed) return stretch.short;
    // A short form over several lines is drawn open, or as written when its long form is empty.
    if (!isLinkable(stretch)) return stretch.long.length === 0 ? stretch.short : write(stretch.long);
    const index = keys.push(stretch.key) - 1;
    if (!open.has(stretch.key)) return `${STRETCH_OPEN}${index}${STRETCH_SEP}${stretch.short}${STRETCH_END}`;
    return closeAfter(write(stretch.long), `${CLOSER_OPEN}${index}${CLOSER_END}`, "\n\n");
  };
  return { source: write(segments), keys };
}

/** The reply as cc-stretch's fullscreen reply first paints it: every stretch closed, short forms as text. */
export function skimSpelling(text: string): string {
  const write = (parts: Segment[]): string => parts.map((part) => (part.kind === "prose" ? part.text : draw(part))).join("");
  const draw = (stretch: Stretch): string => {
    if (stretch.long === undefined || !stretch.isClosed || isLinkable(stretch)) return stretch.short;
    return stretch.long.length === 0 ? stretch.short : write(stretch.long);
  };
  return write(parseStretches(text));
}

/** The reply as cc-stretch paints it on the main screen: every stretch with a long form drawn as it, and no closers. */
export function fullSpelling(text: string): string {
  return writeOpen(parseStretches(text));
}

function writeOpen(parts: Segment[]): string {
  return parts.map((part) => (part.kind === "prose" ? part.text : part.long === undefined ? part.short : writeOpen(part.long))).join("");
}

// One marker run in a text span: a stretch's start (group 1 is its index), its end, a closer (group 2
// is its index), or a lone marker character that belongs to none of those and is dropped.
const MARKER_RUN = /\uE000(\d+)\uE001|\uE002|\uE003(\d+)\uE004|[\uE000-\uE004]/g;

type Token = MdSpan | { kind: "start"; index: number } | { kind: "end" } | { kind: "closer"; index: number };

interface Run {
  index: number;
  spans: MdSpan[];
}

/** `text` with every marker run removed, a start's or a closer's index along with it. */
function stripRuns(text: string): string {
  return text.replace(MARKER_RUN, "");
}

/** Appends `span` to `spans`, joining two runs of text into one as `parseInline` does. */
function pushSpan(spans: MdSpan[], span: MdSpan): void {
  if (span.kind === "text" && span.text === "") return;
  const prev = spans[spans.length - 1];
  if (span.kind === "text" && prev?.kind === "text") spans[spans.length - 1] = { kind: "text", text: prev.text + span.text };
  else spans.push(span);
}

/** A text span cut at its marker runs. */
function textTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKER_RUN)) {
    tokens.push({ kind: "text", text: text.slice(at, m.index) });
    if (m[1] !== undefined) tokens.push({ kind: "start", index: Number(m[1]) });
    else if (m[2] !== undefined) tokens.push({ kind: "closer", index: Number(m[2]) });
    else if (m[0] === STRETCH_END) tokens.push({ kind: "end" });
    at = m.index + m[0].length;
  }
  tokens.push({ kind: "text", text: text.slice(at) });
  return tokens;
}

/** `spans` with every marker character removed and the text kept, for where no stretch may stand. */
function stripSpans(spans: readonly MdSpan[]): MdSpan[] {
  const out: MdSpan[] = [];
  for (const span of spans) pushSpan(out, stripSpan(span));
  return out;
}

function stripSpan(span: MdSpan): MdSpan {
  switch (span.kind) {
    case "text":
    case "code":
      return { ...span, text: stripRuns(span.text) };
    case "image":
      return { ...span, alt: stripRuns(span.alt) };
    case "stretch-close":
      return span;
    default:
      return { ...span, spans: stripSpans(span.spans) };
  }
}

/** One span of a sibling level as tokens: text cut at its markers, emphasis lifted as a level of its own. */
function spanTokens(span: MdSpan, keys: readonly string[]): Token[] {
  switch (span.kind) {
    case "text":
      return textTokens(span.text);
    case "bold":
    case "italic":
      return [{ kind: span.kind, spans: liftSpans(span.spans, keys) }];
    default:
      // No press may sit inside an anchor, and code is verbatim: both keep their text, unmarked.
      return [stripSpan(span)];
  }
}

/** Ends the innermost run: a stretch when its index names a key, its words as plain text otherwise. */
function endRun(stack: Run[], root: MdSpan[], keys: readonly string[]): void {
  const run = stack.pop();
  if (run === undefined) return;
  const into = stack.at(-1)?.spans ?? root;
  const key = keys[run.index];
  if (key === undefined) for (const span of run.spans) pushSpan(into, span);
  else into.push({ kind: "stretch", key, spans: run.spans });
}

/** One sibling level of spans with its marker runs lifted into stretch and stretch-close spans. */
function liftSpans(spans: readonly MdSpan[], keys: readonly string[]): MdSpan[] {
  const root: MdSpan[] = [];
  const stack: Run[] = [];
  for (const token of spans.flatMap((span) => spanTokens(span, keys))) {
    const into = stack.at(-1)?.spans ?? root;
    if (token.kind === "start") stack.push({ index: token.index, spans: [] });
    else if (token.kind === "end") endRun(stack, root, keys);
    else if (token.kind !== "closer") pushSpan(into, token);
    else if (keys[token.index] !== undefined) into.push({ kind: "stretch-close", key: keys[token.index]! });
  }
  // A start with no end at this level: its words stay, as plain text where it began.
  while (stack.length > 0) {
    const run = stack.pop()!;
    for (const span of run.spans) pushSpan(stack.at(-1)?.spans ?? root, span);
  }
  return root;
}

function liftBlock(block: MdBlock, keys: readonly string[]): MdBlock {
  switch (block.kind) {
    case "paragraph":
    case "heading":
    case "quote":
      return { ...block, spans: liftSpans(block.spans, keys) };
    case "list":
      return { ...block, items: block.items.map((item) => liftSpans(item, keys)) };
    case "table":
      return {
        ...block,
        header: block.header.map((cell) => liftSpans(cell, keys)),
        rows: block.rows.map((row) => row.map((cell) => liftSpans(cell, keys))),
      };
    case "code":
      return { ...block, text: stripRuns(block.text) };
    case "rule":
      return block;
  }
}

/**
 * The blocks `parseMarkdown` made of {@link composeStretches}' source, with each marked stretch
 * lifted into a `stretch` span and each closer into a `stretch-close` span, both named by
 * `keys`. A marker that does not pair up at one level of spans, or names no key, is dropped and its
 * words kept as text; inside a link, where no press may stand, every marker is dropped.
 */
export function liftStretches(blocks: MdBlock[], keys: readonly string[]): MdBlock[] {
  return blocks.map((block) => liftBlock(block, keys));
}
