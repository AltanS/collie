// Stretchtext in a reply: `{{short|long}}` marks a stretch, which the reader sees as `short` and can
// open to put `long` in its place. `long` may hold further stretches. Code spans and fences are copied
// as written, so braces in code never open a stretch. Replies written with the cc-stretch Claude Code
// plugin carry this markup, and Collie's journal shows it as Markdown.
//
// `parse` and its helpers are ported from cc-stretch 0.3.4 `hooks/parse.ts`, and `grown`, `anchorsOf`,
// `bare` and `isMarkup` from its `hooks/grow.ts` and `hooks/layout.ts`
// (https://github.com/pro-vi/cc-stretch, MIT, Copyright (c) 2026 pro-vi), with the same semantics.
//
// HOW A STRETCH REACHES THE RENDERER. Collie's Markdown parser knows nothing of stretches, so
// `composeStretches` writes the reply as Markdown with each stretch bracketed by private-use
// characters (the markers below), `parseMarkdown` parses that, and `liftStretches` turns each
// bracketed run back into a stretch span. A reply never writes these characters, and every public
// entry point strips them from its input first, so a reply cannot forge a stretch.
//
// HOW A STRETCH IS COLOURED, as cc-stretch colours it in the terminal: each stretch has one of four
// hues, a closed stretch is underlined in it, and an open stretch draws the words its long form added
// in it, the anchors (the short form's own words) keeping the text's ink. The stretch opened last
// takes the hue's soft form, every other open stretch its faded form, and a closer is always soft.
// One deviation: cc-stretch hands out hues by the order stretches are opened, and Collie by their
// place in the reply (`huesOf`), so a closed stretch is underlined in the colour it opens in. Words
// the long form added on one line, unbroken by an anchor, a markup mark or a nested stretch, are
// tinted as one run with the spaces between them, which draws as cc-stretch's word-by-word paint
// does and keeps emphasis that spans those words inside the run.

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

/** How many hues stretches take in turn: cc-stretch's four Claude Code theme colours. */
const HUES = 4;

/** Opens a closed stretch's short form; the stretch's index in `keys` follows, then {@link STRETCH_SEP}. */
export const STRETCH_OPEN = "\uE000";
/** Ends a closed stretch's index and starts its short form; ends a tint's tone and starts its words. */
export const STRETCH_SEP = "\uE001";
/** Ends a closed stretch's short form. */
export const STRETCH_END = "\uE002";
/** Opens an open stretch's closer; the stretch's index in `keys` follows, then {@link CLOSER_END}. */
export const CLOSER_OPEN = "\uE003";
/** Ends an open stretch's closer. */
export const CLOSER_END = "\uE004";
/**
 * Opens a run of words an open stretch added: the stretch's hue digit follows, then `s` for soft or
 * `f` for faded, then {@link STRETCH_SEP}, then the words.
 */
export const TINT_OPEN = "\uE005";
/** Ends a run of tinted words. */
export const TINT_END = "\uE006";

const ANY_MARKER = /[\uE000-\uE006]/g;

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

/**
 * `open` without the stretch `key` and without every stretch nested inside it, so a stretch opened
 * again starts with its own stretches closed.
 */
export function closeStretch(open: ReadonlyMap<string, number>, key: string): Map<string, number> {
  const nested = `${key}${KEY_SEPARATOR}`;
  return new Map([...open].filter(([k]) => k !== key && !k.startsWith(nested)));
}

/** A reply's stretches, read from `text` once every marker character is stripped from it. */
export function parseStretches(text: string): Segment[] {
  return parse(stripMarkers(text));
}

/** What {@link liftStretches} needs to name and colour each marked stretch, by its index in the markers. */
export interface StretchMarks {
  keys: readonly string[];
  /** Each marked stretch's hue, 0 to 3: a closed stretch's underline, an open one's closer and tint. */
  hues: readonly number[];
}

/** Markdown source with its stretches marked, and the key and hue of each marked stretch by its index. */
export interface ComposedStretches extends StretchMarks {
  source: string;
  keys: string[];
  hues: number[];
}

/**
 * The hue of every stretch in `segments`: the k-th in {@link stretches} order takes `k % 4`, or the
 * next one round when that is its parent's, so a nested stretch never shares its parent's colour.
 */
function huesOf(segments: Segment[]): Map<Stretch, number> {
  const hues = new Map<Stretch, number>();
  const walk = (parts: Segment[], parent: number | undefined) => {
    for (const part of parts) {
      if (part.kind === "prose") continue;
      const own = hues.size % HUES;
      const hue = own === parent ? (own + 1) % HUES : own;
      hues.set(part, hue);
      walk(part.long ?? [], hue);
    }
  };
  walk(segments, undefined);
  return hues;
}

/** The stretch opened last: the one with the highest sequence. Sequence 0, which a find opens with, is never the newest. */
function newestOf(open: ReadonlyMap<string, number>): string | undefined {
  let newest: string | undefined;
  let highest = 0;
  for (const [key, sequence] of open) {
    if (sequence <= highest) continue;
    newest = key;
    highest = sequence;
  }
  return newest;
}

/**
 * The reply as Markdown source for `parseMarkdown`, drawn as cc-stretch's fullscreen reply draws it:
 * a stretch in `open` as its long form, the words it added tinted, then its closer; a closed one as
 * its marked short form; and one that cannot be pressed (unclosed, without a long form, or with a
 * short form over several lines) as plain text. `open` maps each open stretch's key to the sequence
 * it was opened at, so the highest is the newest and drawn soft; the others are drawn faded.
 * `keys` and `hues` name and colour each marked stretch by its index in the markers, in the order
 * they are written; a closed stretch's long form is not drawn, so its nested stretches have none.
 */
export function composeStretches(segments: Segment[], open: ReadonlyMap<string, number>): ComposedStretches {
  const keys: string[] = [];
  const hues: number[] = [];
  const hueOf = huesOf(segments);
  const newest = newestOf(open);
  const write = (parts: Segment[]): string => parts.map((part) => (part.kind === "prose" ? part.text : draw(part))).join("");
  const draw = (stretch: Stretch): string => {
    if (stretch.long === undefined || !stretch.isClosed) return stretch.short;
    // A short form over several lines is drawn open, or as written when its long form is empty.
    if (!isLinkable(stretch)) return stretch.long.length === 0 ? stretch.short : write(stretch.long);
    // SAFETY: `huesOf` walked every stretch of `segments`, and `draw` is only handed those.
    const hue = hueOf.get(stretch)!;
    const index = keys.push(stretch.key) - 1;
    hues.push(hue);
    if (!open.has(stretch.key)) return `${STRETCH_OPEN}${index}${STRETCH_SEP}${stretch.short}${STRETCH_END}`;
    const tone = stretch.key === newest ? "s" : "f";
    const paint = (words: string) => `${TINT_OPEN}${hue}${tone}${STRETCH_SEP}${words}${TINT_END}`;
    return closeAfter(grown(stretch.short, stretch.long, draw, paint), `${CLOSER_OPEN}${index}${CLOSER_END}`, "\n\n");
  };
  return { source: write(segments), keys, hues };
}

/** A word or a run of whitespace of a long form, or a stretch nested in it. */
type GrowToken = { kind: "word" | "space"; text: string } | { kind: "nested"; stretch: Stretch };

/** A bare word of a long form, and the token it stands in. */
interface Word {
  token: number;
  word: string;
}

/**
 * An open stretch's long form as cc-stretch's `grow` draws it fully grown: the anchors as written,
 * each nested stretch by `draw`, and each run of added words by `paint`. A run is the added words on
 * one line with the spaces between them, broken by an anchor, a markup mark or a nested stretch.
 */
function grown(short: string, long: Segment[], draw: (nested: Stretch) => string, paint: (words: string) => string): string {
  const tokens = tokenize(long);
  const anchors = anchorsOf(short, tokens);
  let out = "";
  let run = "";
  let gap = "";
  const flush = () => {
    out += (run === "" ? "" : paint(run)) + gap;
    run = "";
    gap = "";
  };
  const keep = (text: string) => {
    flush();
    out += text;
  };
  const add = (word: string) => {
    if (run === "" || gap.includes("\n")) {
      flush();
      run = word;
      return;
    }
    run += gap + word;
    gap = "";
  };
  tokens.forEach((token, i) => {
    if (token.kind === "nested") keep(draw(token.stretch));
    else if (token.kind === "space") {
      if (run === "") out += token.text;
      else gap += token.text;
    } else if (anchors.has(i) || isMarkup(token.text)) keep(token.text);
    else add(token.text);
  });
  flush();
  return out;
}

function tokenize(long: Segment[]): GrowToken[] {
  return long.flatMap((part): GrowToken[] =>
    part.kind === "prose"
      ? part.text
          .split(/(\s+)/)
          .filter((text) => text !== "")
          .map((text): GrowToken => ({ kind: /^\s+$/.test(text) ? "space" : "word", text }))
      : [{ kind: "nested", stretch: part }],
  );
}

/**
 * The token indexes of the long form that carry the short form's words, as many as can be kept in
 * order (a longest common subsequence). A nested stretch shows its own short form, so its words
 * count where it stands.
 */
function anchorsOf(short: string, tokens: GrowToken[]): Set<number> {
  const want = short.split(/\s+/).map(bare).filter((word) => word !== "");
  const anchors = commonTokens(want, wordsOf(tokens));
  // Punctuation standing on its own right after an anchor (`{{...}}.`) belongs to that anchor.
  let last = -1;
  tokens.forEach((token, i) => {
    if (token.kind === "space") return;
    if (token.kind === "word" && bare(token.text) === "" && anchors.has(last)) anchors.add(i);
    last = i;
  });
  return anchors;
}

/** The long form's bare words, each with the token it stands in. */
function wordsOf(tokens: GrowToken[]): Word[] {
  return tokens.flatMap((token, i) => {
    const words = token.kind === "word" ? [token.text] : token.kind === "nested" ? token.stretch.short.split(/\s+/) : [];
    return words
      .map(bare)
      .filter((word) => word !== "")
      .map((word) => ({ token: i, word }));
  });
}

/** The tokens of `have` a longest common subsequence with `want` keeps. */
function commonTokens(want: string[], have: Word[]): Set<number> {
  const lengths = commonLengths(want, have);
  const anchors = new Set<number>();
  let i = 0;
  let j = 0;
  while (i < want.length && j < have.length) {
    if (want[i] === have[j].word) {
      anchors.add(have[j].token);
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) i++;
    else j++;
  }
  return anchors;
}

/** `lengths[i][j]`: the longest common run of `want[i..]` and `have[j..]`. */
function commonLengths(want: string[], have: Word[]): number[][] {
  const lengths = Array.from({ length: want.length + 1 }, () => Array.from({ length: have.length + 1 }, () => 0));
  for (let i = want.length - 1; i >= 0; i--) {
    for (let j = have.length - 1; j >= 0; j--) {
      lengths[i][j] = want[i] === have[j].word ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  return lengths;
}

/** A word without its surrounding punctuation or markdown marks, lowercased, so `cache.` meets `**cache**`. */
function bare(word: string): string {
  return word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/** Whether a word is markdown syntax rather than text: a bullet, a list number, a rule, a fence, a pipe, a heading mark. */
function isMarkup(word: string): boolean {
  return !/[\p{L}\p{N}]/u.test(word) || /^\d+[.)]$/.test(word) || /^(`{3,}|~{3,})/.test(word);
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
// is its index), a tint's start (group 3 is its hue, group 4 its tone), a tint's end, or a lone marker
// character that belongs to none of those and is dropped.
const MARKER_RUN = /\uE000(\d+)\uE001|\uE002|\uE003(\d+)\uE004|\uE005(\d)([sf])\uE001|\uE006|[\uE000-\uE006]/g;

type Token =
  | MdSpan
  | { kind: "start"; index: number }
  | { kind: "end" }
  | { kind: "closer"; index: number }
  | { kind: "tint-start"; hue: number; faded: boolean }
  | { kind: "tint-end" };

/** An open marker run at one sibling level: a closed stretch's short form, or an open stretch's tinted words. */
type Run = { kind: "stretch"; index: number; spans: MdSpan[] } | { kind: "tint"; hue: number; faded: boolean; spans: MdSpan[] };

/** `text` with every marker run removed, a start's, a closer's or a tint's index and tone along with it. */
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

/** The token one marker run stands for, or undefined for a lone marker character. */
function markerToken(m: RegExpMatchArray): Token | undefined {
  if (m[1] !== undefined) return { kind: "start", index: Number(m[1]) };
  if (m[2] !== undefined) return { kind: "closer", index: Number(m[2]) };
  if (m[3] !== undefined) return { kind: "tint-start", hue: Number(m[3]), faded: m[4] === "f" };
  if (m[0] === STRETCH_END) return { kind: "end" };
  if (m[0] === TINT_END) return { kind: "tint-end" };
  return undefined;
}

/** A text span cut at its marker runs. */
function textTokens(text: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (const m of text.matchAll(MARKER_RUN)) {
    tokens.push({ kind: "text", text: text.slice(at, m.index) });
    const marker = markerToken(m);
    if (marker !== undefined) tokens.push(marker);
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
function spanTokens(span: MdSpan, marks: StretchMarks): Token[] {
  switch (span.kind) {
    case "text":
      return textTokens(span.text);
    case "bold":
    case "italic":
      return [{ kind: span.kind, spans: liftSpans(span.spans, marks) }];
    default:
      // No press may sit inside an anchor, and code is verbatim: both keep their text, unmarked.
      return [stripSpan(span)];
  }
}

/** The span a run that paired up becomes, or undefined when its stretch index names no stretch and its words stay plain. */
function runSpan(run: Run, marks: StretchMarks): MdSpan | undefined {
  if (run.kind === "tint") return { kind: "tint", hue: run.hue, faded: run.faded, spans: run.spans };
  const key = marks.keys[run.index];
  const hue = marks.hues[run.index];
  return key === undefined || hue === undefined ? undefined : { kind: "stretch", key, hue, spans: run.spans };
}

/** The closer of the stretch at `index`, or undefined when the index names no stretch. */
function closerSpan(index: number, marks: StretchMarks): MdSpan | undefined {
  const key = marks.keys[index];
  const hue = marks.hues[index];
  return key === undefined || hue === undefined ? undefined : { kind: "stretch-close", key, hue };
}

/**
 * Ends the innermost run when it is of `kind`: a span when it names a stretch or is a tint, its
 * words as plain text otherwise. An end that does not close the innermost run pairs with nothing at
 * this level, and is dropped.
 */
function endRun(stack: Run[], root: MdSpan[], marks: StretchMarks, kind: Run["kind"]): void {
  const run = stack.at(-1);
  if (run?.kind !== kind) return;
  stack.pop();
  const into = stack.at(-1)?.spans ?? root;
  const span = runSpan(run, marks);
  if (span === undefined) for (const word of run.spans) pushSpan(into, word);
  else into.push(span);
}

/** Lifts one token of a sibling level into the innermost open run, or into `root` when none is open. */
function liftToken(token: Token, stack: Run[], root: MdSpan[], marks: StretchMarks): void {
  const into = stack.at(-1)?.spans ?? root;
  switch (token.kind) {
    case "start":
      stack.push({ kind: "stretch", index: token.index, spans: [] });
      return;
    case "tint-start":
      stack.push({ kind: "tint", hue: token.hue, faded: token.faded, spans: [] });
      return;
    case "end":
      endRun(stack, root, marks, "stretch");
      return;
    case "tint-end":
      endRun(stack, root, marks, "tint");
      return;
    case "closer": {
      const closer = closerSpan(token.index, marks);
      if (closer !== undefined) into.push(closer);
      return;
    }
    default:
      pushSpan(into, token);
  }
}

/** One sibling level of spans with its marker runs lifted into stretch, tint and stretch-close spans. */
function liftSpans(spans: readonly MdSpan[], marks: StretchMarks): MdSpan[] {
  const root: MdSpan[] = [];
  const stack: Run[] = [];
  for (const token of spans.flatMap((span) => spanTokens(span, marks))) liftToken(token, stack, root, marks);
  // A start with no end at this level: its words stay, as plain text where it began.
  while (stack.length > 0) {
    const run = stack.pop()!;
    for (const span of run.spans) pushSpan(stack.at(-1)?.spans ?? root, span);
  }
  return root;
}

function liftBlock(block: MdBlock, marks: StretchMarks): MdBlock {
  switch (block.kind) {
    case "paragraph":
    case "heading":
    case "quote":
      return { ...block, spans: liftSpans(block.spans, marks) };
    case "list":
      return { ...block, items: block.items.map((item) => liftSpans(item, marks)) };
    case "table":
      // `source` is what the table's copy button copies, so it loses its markers too.
      return {
        ...block,
        source: stripRuns(block.source),
        header: block.header.map((cell) => liftSpans(cell, marks)),
        rows: block.rows.map((row) => row.map((cell) => liftSpans(cell, marks))),
      };
    case "code":
      return { ...block, text: stripRuns(block.text) };
    case "rule":
      return block;
  }
}

/**
 * The blocks `parseMarkdown` made of {@link composeStretches}' source, with each marked stretch
 * lifted into a `stretch` span, each closer into a `stretch-close` span, both named and coloured by
 * `marks`, and each tinted run into a `tint` span. A marker that does not pair up at one level of
 * spans, or names no key, is dropped and its words kept as text; inside a link, where no press may
 * stand, every marker is dropped.
 */
export function liftStretches(blocks: MdBlock[], marks: StretchMarks): MdBlock[] {
  return blocks.map((block) => liftBlock(block, marks));
}
