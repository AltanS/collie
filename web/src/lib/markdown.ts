// A deliberately small Markdown parser for transcript prose.
//
// WHY HAND-ROLLED. Agent output is Markdown, and reading it raw on a phone (`## Heading`, `**bold**`)
// is worse than reading it formatted. But the repo's hard rule is that pane/agent text renders as
// React TEXT NODES, never `innerHTML` — that's the XSS boundary (CLAUDE.md §"Security posture",
// ARCHITECTURE.md §6). So this produces an AST, and the renderer turns it into React elements. No
// HTML string is ever constructed, which keeps the boundary provable rather than trusted, and adds
// no dependency to a phone bundle that currently has seven.
//
// SCOPE. The subset agents actually emit: headings, fenced code, lists, blockquotes, rules,
// paragraphs, GFM tables; inline bold/italic/code/links. Not HTML passthrough. An image is never
// loaded here: it reads as its alt text (a badge is a link whose label is the alt text), unless the
// caller asks for image spans, and then the SCREEN decides what to load (the Files preview, ADR 0090).
//
// FLAT BY DESIGN. Blocks don't nest: a table or a list inside a blockquote or a list item is read as
// the outer block's text, so a quoted table still collapses into a run-on line. Closing that means a
// recursive block parser, which is a different program from this one — and agents put tables at the
// top level, where the collapse actually hurt (#72).
//
// TWO DELIBERATE OMISSIONS, both because this content is code-heavy:
//  - `_underscore_` emphasis is NOT supported. It would mangle `snake_case_identifiers`, which
//    appear constantly in agent output, and Claude writes emphasis with asterisks anyway.
//  - `*emphasis*` requires non-space just inside both delimiters, so a shell glob like
//    "rename *.ts to *.tsx" isn't silently swallowed into an italic run.

/**
 * An inline run within a paragraph/heading/list item.
 *
 * Emphasis and links carry CHILD SPANS, not a flat string, because agents nest them constantly —
 * ``**`c6fe96`**`` (bold wrapping code) is routine in agent prose, and a flat model rendered those
 * backticks literally. `code` is the one leaf: its content is verbatim by definition.
 */
export type MdSpan =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "bold"; spans: MdSpan[] }
  | { kind: "italic"; spans: MdSpan[] }
  /**
   * `href` is already scheme-checked; anything unsafe never becomes a link (see `classifyHref`).
   * `rel` marks a link that is NOT a web address: a relative path (`./other.md`, `docs/x.md`), a
   * root-absolute one (`/x`) or a fragment (`#top`). The parser cannot say where those lead, only
   * the screen that shows the text can, so the renderer asks a resolver and, with none, shows the
   * label as plain text.
   */
  | { kind: "link"; href: string; spans: MdSpan[]; rel?: true }
  /**
   * `![alt](src)`, kept as an image only when the caller asked for images (`parseMarkdown`'s
   * `images`), which the Files preview does and the transcript does not. `src` is the address AS
   * WRITTEN and nothing has vetted it: the screen decides whether it names a file it may load, and
   * draws `alt` otherwise (ADR 0090).
   */
  | { kind: "image"; alt: string; src: string };

export type MdBlock =
  | { kind: "heading"; level: number; spans: MdSpan[] }
  | { kind: "paragraph"; spans: MdSpan[] }
  /** Fenced code. `text` is verbatim — never inline-parsed. */
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: MdSpan[][] }
  | { kind: "quote"; spans: MdSpan[] }
  /**
   * GFM table. `align` is one entry per column (null = unaligned), and every row is padded or
   * truncated to that width so the renderer never has to reason about ragged input.
   */
  | { kind: "table"; align: MdAlign[]; header: MdSpan[][]; rows: MdSpan[][][] }
  | { kind: "rule" };

export type MdAlign = "left" | "center" | "right" | null;

// Only these schemes may become a real link. Everything else (javascript:, data:, file:, vbscript:,
// or a made-up one) renders as its label, never as an anchor and never as its raw source: a link is
// the one place this view could otherwise hand a URL straight to the browser.
const SAFE_SCHEME = /^(https?:|mailto:)/i;
// Any scheme at all: letters first, then letters, digits, `+`, `-`, `.`, then the colon.
const ANY_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
// A C0 control or DEL anywhere in a target. Browsers strip some of these before they read a scheme
// (`java\x01script:`), so a target holding one is refused outright rather than reasoned about.
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR = /[\x00-\x1f\x7f]/;

/**
 * What a link target is: `external` for http(s) and mailto, `rel` for a scheme-less target (a
 * relative path, a root-absolute one or a fragment, kept as written), and null for everything else,
 * which must not become a link at all. A protocol-relative `//host` is null: it inherits the page
 * scheme and is a real navigation to a stranger's host, so it is as unsafe as a scheme.
 */
export function classifyHref(raw: string): { href: string; rel: boolean } | null {
  const href = raw.trim();
  if (href === "" || CONTROL_CHAR.test(href)) return null;
  if (SAFE_SCHEME.test(href)) return { href, rel: false };
  if (ANY_SCHEME.test(href)) return null;
  if (href.startsWith("//") || href.startsWith("/\\") || href.startsWith("\\")) return null;
  return { href, rel: true };
}

/** The href of an EXTERNAL link (http, https, mailto), or null for anything else. */
function externalHref(raw: string): string | null {
  const target = classifyHref(raw);
  return target !== null && !target.rel ? target.href : null;
}

// A URL AN AGENT WROTE AS ITSELF, with no brackets around it. Agents do this constantly — a server
// they started, a PR they opened — and until 2026-09-30 every one of them rendered as dead text a
// reader had to select by hand on a phone. It is the LAST alternative on purpose: `[text](url)`
// starts at its `[`, a code span at its backtick, and both sit left of the `h`, so the leftmost-match
// rule hands those to their own branch and a URL inside them never reaches this one.
//
// The lookbehind keeps it to a URL that STARTS somewhere: no `xhttp://`, and no second match inside
// a URL this alternative already took. The tail class is what stops "see http://x." from swallowing
// the full stop, and "(http://x)" from swallowing the bracket — a URL may not END on sentence
// punctuation, though it may contain it.
const BARE_URL = "(?<![\\w@/.-])((?:https?://|mailto:)[^\\s<>`\"']*[^\\s<>`\"'.,:;!?)\\]}])";

// The pieces of a link, each bounded, each with a branch that cannot match what the other can:
//  - LABEL holds anything but a bracket, or ONE image (`![alt](src)`), which is how a badge is
//    written: `[![build](badge.svg)](https://ci)`. An image always opens with `![`, and a plain
//    character can never be `[`, so the two branches never match the same text.
//  - URL_BODY holds anything but a paren or a space, or one level of balanced parens, which is how
//    a wiki address is written: `https://en.wikipedia.org/wiki/Foo_(bar)`.
//  - TITLE is the optional `"title"` or `'title'` after the address. It is dropped.
// Excluding `[` from a label also makes a run of `[` fail in one step each instead of 500.
const LABEL = String.raw`(?:[^\[\]\n]|!\[[^\[\]\n]{0,500}\]\([^)\s]{0,500}\)){0,500}`;
const URL_BODY = String.raw`(?:[^()\s]|\([^()\s]{0,200}\)){1,500}`;
const TITLE = String.raw`(?:\s{1,20}(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'))?`;
const DEST = String.raw`\(\s{0,20}(${URL_BODY})${TITLE}\s{0,20}\)`;

// Ordered so the greedier delimiters win: ``code`` before **bold** before *italic*.
// Emphasis bodies forbid a leading/trailing space (see the glob note above) and can't span a newline.
const INLINE_RE = new RegExp(
  [
    "(`+)([^`]+?)\\1", // 1,2   inline code
    "\\*\\*(\\S(?:[^\\n]{0,500}?\\S)?)\\*\\*", // 3     bold
    "\\*(\\S(?:[^\\n*]*?\\S)?)\\*", // 4     italic
    String.raw`!\[([^\[\]\n]{0,500})\]\(\s{0,20}(?:${URL_BODY})${TITLE}\s{0,20}\)`, // 5     an image, read as its alt text
    String.raw`\[(${LABEL})\]${DEST}`, // 6,7   [label](url "title")
    String.raw`\[(${LABEL})\]\[([^\[\]\n]{0,200})\]`, // 8,9   [label][ref] and [label][]
    String.raw`\[([^\[\]\n]{1,200})\]`, // 10    [ref], when a definition names it
    "<((?:https?://|mailto:)[^\\s<>]{1,500})>", // 11    <https://x>
    BARE_URL, // 12    a bare URL
  ].join("|"),
  "g",
);

// Emphasis nests, so parsing recurses into each body. Every level strips at least one delimiter pair,
// so it always terminates — this bound is belt-and-braces against pathological input, past which the
// remaining text is simply left as text.
const MAX_INLINE_DEPTH = 6;

/** Link reference definitions of one document: normalised label to the address it names. */
export type RefDefs = ReadonlyMap<string, string>;

/**
 * How many more `![alt](src)` of one document may become image spans. Shared by every inline parse
 * of the document and spent in reading order, so a file of a thousand pictures asks for the first
 * few and reads the rest as their alt text.
 */
export interface ImageBudget {
  left: number;
}

/** The most images one document asks the screen to draw, when it asks for any (ADR 0090). */
export const MAX_DOCUMENT_IMAGES = 20;

/** What every inline parse of one document shares: its definitions, and its image budget if any. */
interface DocContext {
  defs: RefDefs;
  images?: ImageBudget;
}

// The parts of an image, re-read off the whole match: the alternation's own group holds only the alt.
const IMAGE_PARTS = new RegExp(String.raw`^!\[([^\[\]\n]{0,500})\]\(\s{0,20}(${URL_BODY})${TITLE}\s{0,20}\)$`);

/** `[Foo  Bar]` and `[foo bar]` name the same definition. */
const refKey = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

/**
 * Parse one line/paragraph of inline Markdown. Pure, and recursive through emphasis/link bodies.
 *
 * `inLink` is off everywhere but inside a link's own body, where it turns the bare-URL branch back
 * into plain text. `[the docs](https://a)` recurses into its label, and a label that is itself a URL
 * (or holds one) would otherwise nest an anchor inside an anchor, which is not a thing the DOM has.
 *
 * `defs` are the document's `[ref]: url` definitions, from `parseMarkdown`'s first pass. Without
 * them `[a][ref]` and `[ref]` stay text, which is also what they are when no definition names them.
 */
export function parseInline(text: string, depth = 0, inLink = false, defs?: RefDefs, images?: ImageBudget): MdSpan[] {
  const spans: MdSpan[] = [];
  const push = (span: MdSpan) => {
    if (span.kind === "text" && span.text === "") return;
    // Two runs of text side by side are one run: a bracket that turned out to be prose is pushed on
    // its own, and the reader (and a test) should not see where the parser changed its mind.
    const prev = spans[spans.length - 1];
    if (span.kind === "text" && prev?.kind === "text") spans[spans.length - 1] = { kind: "text", text: prev.text + span.text };
    else spans.push(span);
  };
  if (depth >= MAX_INLINE_DEPTH) {
    push({ kind: "text", text });
    return spans;
  }

  /**
   * One link to `rawHref` with `label` read as Markdown. A target that may not become a link leaves
   * its LABEL (never the `[a](javascript:...)` source, which would show the address it refused);
   * a label with nothing in it falls back to the address.
   */
  const pushLink = (label: string, rawHref: string) => {
    const target = classifyHref(rawHref);
    const body = parseInline(label, depth + 1, true, defs);
    if (target === null) {
      for (const span of body) push(span);
      return;
    }
    const labelSpans = body.length > 0 ? body : [{ kind: "text" as const, text: target.href }];
    push(
      target.rel
        ? { kind: "link", href: target.href, spans: labelSpans, rel: true }
        : { kind: "link", href: target.href, spans: labelSpans },
    );
  };

  // A fresh regex per call: INLINE_RE is stateful (`g`), and recursion would otherwise clobber the
  // parent's lastIndex mid-scan.
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    push({ kind: "text", text: text.slice(last, m.index) });
    last = m.index + m[0].length;
    if (m[2] !== undefined) push({ kind: "code", text: m[2] }); // leaf: content is verbatim
    else if (m[3] !== undefined) push({ kind: "bold", spans: parseInline(m[3], depth + 1, inLink, defs, images) });
    else if (m[4] !== undefined) push({ kind: "italic", spans: parseInline(m[4], depth + 1, inLink, defs, images) });
    else if (m[5] !== undefined) {
      // An image is its alt text, unless the caller asked for images and the budget lasts. Inside a
      // link's label it stays text, so a badge is still one link and never a picture inside one.
      const src = images !== undefined && images.left > 0 && !inLink ? IMAGE_PARTS.exec(m[0])?.[2] : undefined;
      if (src !== undefined && images !== undefined) {
        images.left--;
        push({ kind: "image", alt: m[5], src });
      } else push({ kind: "text", text: m[5] });
    }
    else if (m[6] !== undefined && m[7] !== undefined) pushLink(m[6], m[7]);
    else if (m[8] !== undefined || m[10] !== undefined) {
      // `[label][ref]`, `[label][]` and `[ref]`: the address is a definition's, found by its key.
      const label = m[8] ?? m[10]!;
      const key = refKey(m[9] === undefined || m[9].trim() === "" ? label : m[9]);
      const rawHref = defs?.get(key);
      if (rawHref !== undefined && !inLink) pushLink(label, rawHref);
      else if (rawHref !== undefined) push({ kind: "text", text: label });
      else {
        // No such definition: it is a bracket in prose. Take the `[` as text and rescan after it, so
        // `[**a**]` keeps its bold and a link further along the line still links.
        push({ kind: "text", text: "[" });
        last = re.lastIndex = m.index + 1;
      }
    } else if (m[11] !== undefined) {
      // `<https://x>` reads as the address itself, without the angle brackets.
      const href = inLink ? null : externalHref(m[11]);
      if (href) push({ kind: "link", href, spans: [{ kind: "text", text: m[11] }] });
      else push({ kind: "text", text: m[11] });
    } else if (m[12] !== undefined) {
      // Its own text is its label, so the reader sees the address they would tap. Through the same
      // gate as every other link, even though the pattern already limited the scheme: one gate.
      const href = inLink ? null : externalHref(m[12]);
      if (href) push({ kind: "link", href, spans: [{ kind: "text", text: m[12] }] });
      else push({ kind: "text", text: m[12] });
    }
  }
  push({ kind: "text", text: text.slice(last) });
  return spans;
}

// A SOURCE LINE this long is a minified file or a data dump, not prose, and every inline branch is
// superlinear in the worst case. It renders as plain text. The Files view reaches this parser with a
// whole 1 MiB file, so the bound is the guard, not a nicety. The joined-paragraph bound catches the
// other door: a million short lines of `[` that a paragraph glues into one run.
const MAX_LINE_CHARS = 2000;
const MAX_JOINED_CHARS = 50_000;

/** Inline-parse `text`, unless any of the source `lines` it came from is too long to try. */
function parseBounded(text: string, lines: readonly string[], doc: DocContext): MdSpan[] {
  if (text.length > MAX_JOINED_CHARS || lines.some((l) => l.length > MAX_LINE_CHARS)) {
    return text === "" ? [] : [{ kind: "text", text }];
  }
  return parseInline(text, 0, false, doc.defs, doc.images);
}

// A LINK REFERENCE DEFINITION: `[ref]: https://x "Title"` on a line of its own, up to three spaces in.
// It names an address for `[text][ref]` and `[ref]`, and is not itself drawn. `[^1]:` is a footnote,
// not a definition, and stays a paragraph. Every part is bounded.
const REF_DEF = /^ {0,3}\[([^[\]\n^][^[\]\n]{0,199})\]:[ \t]{1,20}(<[^<>\s]{1,500}>|\S{1,500})(?:[ \t]{1,20}(?:"[^"\n]{0,300}"|'[^'\n]{0,300}'|\([^()\n]{0,300}\)))?[ \t]{0,20}$/;
// More definitions than any README holds is a hostile file; the rest are left as paragraphs.
const MAX_REF_DEFS = 1000;

/** The definition on `line`, as `[key, address]`, or null. */
function readRefDef(line: string): [string, string] | null {
  if (line.length > MAX_LINE_CHARS) return null;
  const m = REF_DEF.exec(line);
  if (!m) return null;
  const target = m[2]!;
  return [refKey(m[1]!), target.startsWith("<") ? target.slice(1, -1) : target];
}

/** First pass: every definition outside a fenced block. The first definition of a label wins. */
function collectRefDefs(lines: readonly string[]): RefDefs {
  const defs = new Map<string, string>();
  let fenced = false;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || defs.size >= MAX_REF_DEFS) continue;
    const def = readRefDef(line);
    if (def !== null && !defs.has(def[0])) defs.set(def[0], def[1]);
  }
  return defs;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)\s*(\S*)/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

// A table is recognised by its DELIMITER row, never by the header alone: a line of prose containing
// a pipe is common, `| --- | :-: |` under it is not. Both spellings agents emit are accepted —
// with outer pipes and without — but the row must carry at least one pipe, so a bare `---` stays a
// horizontal rule, and every cell must be dashes (optionally colon-flanked), so `|---|:` is not one.
const TABLE_DELIM = /^\s*\|?(?:\s*:?-+:?\s*\|)+(?:\s*:?-+:?)?\s*\|?\s*$/;

/** Split one table row into raw cell strings. `\|` is an escaped pipe, not a column break. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else cur += ch;
  }
  cells.push(cur);
  // Outer pipes produce empty edge cells; they are punctuation, not columns.
  if (cells.length > 1 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 1 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

function parseAlign(line: string): MdAlign[] {
  return splitRow(line).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * Pad/truncate a BODY row to the header's width, so the renderer can assume a rectangle. Ragged body
 * rows are legal GFM and agents emit them; a ragged delimiter row is not — see `startsTable`.
 */
function fitRow(line: string, width: number, doc: DocContext): MdSpan[][] {
  const cells = splitRow(line)
    .slice(0, width)
    .map((cell) => parseBounded(cell, [line], doc));
  while (cells.length < width) cells.push([]);
  return cells;
}

/**
 * True when `line` opens a table — i.e. the line under it is a delimiter row of the SAME width.
 *
 * The width check is what GFM requires, and it is load-bearing here rather than pedantic: without
 * it, any prose line containing a pipe that happens to sit above a dashed line becomes a table split
 * at that pipe. Matching the spec keeps the false positives out.
 *
 * Two side doors remain, both rare enough to leave: a header that also parses as a list item
 * (`1. Name | Value`) is claimed by the list branch, which runs first, and the body loop below takes
 * any pipe-bearing line — so two tables with no blank line between them merge into one.
 */
const startsTable = (line: string, next: string | undefined) =>
  line.includes("|") &&
  next !== undefined &&
  // A line this long is a data dump, not a table, and the delimiter test is superlinear on spaces.
  line.length <= MAX_LINE_CHARS &&
  next.length <= MAX_LINE_CHARS &&
  TABLE_DELIM.test(next) &&
  splitRow(next).length === splitRow(line).length;

/**
 * Parse Markdown into blocks. Pure — no React, no DOM — so the whole grammar is unit-testable and
 * the renderer stays a dumb mapping from AST to elements.
 *
 * `images` asks for `![alt](src)` as image spans, the first {@link MAX_DOCUMENT_IMAGES} of the
 * document in reading order; without it every image is its alt text, as the transcript wants.
 */
export function parseMarkdown(source: string, opts: { images?: boolean } = {}): MdBlock[] {
  const lines = source.split("\n");
  const defs = collectRefDefs(lines);
  const doc: DocContext = opts.images === true ? { defs, images: { left: MAX_DOCUMENT_IMAGES } } : { defs };
  const blocks: MdBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") {
      i++;
      continue;
    }

    // Fenced code first: its body is literal, so nothing inside is parsed as Markdown.
    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1] ?? "";
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) body.push(lines[i++]!);
      i++; // consume the closing fence (or run off the end on an unterminated block)
      blocks.push({ kind: "code", lang, text: body.join("\n") });
      continue;
    }

    // A definition names an address for the links that use it and draws nothing itself.
    if (readRefDef(line) !== null) {
      i++;
      continue;
    }

    // A rule must be checked before list items, or "---" reads as a bullet.
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        spans: parseBounded(heading[2] ?? "", [line], doc),
      });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        body.push(q[1] ?? "");
        i++;
      }
      blocks.push({ kind: "quote", spans: parseBounded(body.join(" ").trim(), body, doc) });
      continue;
    }

    const isItem = (l: string) => UL_ITEM.exec(l) ?? OL_ITEM.exec(l);
    const firstItem = isItem(line);
    if (firstItem) {
      const ordered = OL_ITEM.test(line);
      const items: MdSpan[][] = [];
      while (i < lines.length) {
        const item = isItem(lines[i]!);
        // A run stays one list only while its marker kind holds — a switch starts a new block.
        if (!item || OL_ITEM.test(lines[i]!) !== ordered) break;
        items.push(parseBounded(item[1] ?? "", [lines[i]!], doc));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Tables come last of the recognised blocks: every other construct wins a line that could be
    // read as either, and a table is the only one that needs to look ahead.
    if (startsTable(line, lines[i + 1])) {
      const header = splitRow(line).map((cell) => parseBounded(cell, [line], doc));
      // Widths already match — `startsTable` refused the row otherwise — so the columns line up
      // without padding either side.
      const align = parseAlign(lines[i + 1]!);
      i += 2;
      const rows: MdSpan[][][] = [];
      // The body runs until a blank line or anything that isn't a pipe row — a table that bumps
      // into a heading or a fence ends there rather than swallowing it.
      while (i < lines.length && lines[i]!.trim() !== "" && lines[i]!.includes("|")) {
        rows.push(fitRow(lines[i]!, header.length, doc));
        i++;
      }
      blocks.push({ kind: "table", align, header, rows });
      continue;
    }

    // Paragraph: consecutive lines until a blank or a line that starts some other block. Joined with
    // a space, since a hard-wrapped paragraph should reflow to the phone's width, not keep its
    // source line breaks.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" ||
        HEADING.test(l) ||
        FENCE.test(l) ||
        RULE.test(l) ||
        QUOTE.test(l) ||
        isItem(l) ||
        readRefDef(l) !== null ||
        startsTable(l, lines[i + 1])
      )
        break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", spans: parseBounded(para.join(" "), para, doc) });
  }

  return blocks;
}

/** What a run of spans reads as, flattened: the text a heading slug or a length check is made of. */
export function spansText(spans: readonly MdSpan[]): string {
  return spans
    .map((s) => (s.kind === "text" || s.kind === "code" ? s.text : s.kind === "image" ? s.alt : spansText(s.spans)))
    .join("");
}

/**
 * The anchor name GitHub gives a heading: lowercase, spaces to `-`, and every character that is not
 * a letter, a digit, `_` or `-` dropped. Bounded: a heading is one source line, already capped.
 */
export function headingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/**
 * One anchor per block, in document order: the slug for a heading, null for any other block. A slug
 * that was already taken gets `-1`, then `-2`, as GitHub does, and a heading that slugs to nothing
 * gets no anchor.
 */
export function headingAnchors(blocks: readonly MdBlock[]): (string | null)[] {
  const taken = new Map<string, number>();
  return blocks.map((block) => {
    if (block.kind !== "heading") return null;
    const slug = headingSlug(spansText(block.spans));
    if (slug === "") return null;
    const seen = taken.get(slug) ?? 0;
    taken.set(slug, seen + 1);
    return seen === 0 ? slug : `${slug}-${seen}`;
  });
}
