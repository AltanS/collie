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
// paragraphs; inline bold/italic/code/links. Not GFM tables (they'd need real column layout on a
// 400px screen — they render as literal text lines for now), not images, not HTML passthrough.
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
  /** `href` is already scheme-checked; anything unsafe never becomes a link (see `safeHref`). */
  | { kind: "link"; href: string; spans: MdSpan[] };

export type MdBlock =
  | { kind: "heading"; level: number; spans: MdSpan[] }
  | { kind: "paragraph"; spans: MdSpan[] }
  /** Fenced code. `text` is verbatim — never inline-parsed. */
  | { kind: "code"; lang: string; text: string }
  | { kind: "list"; ordered: boolean; items: MdSpan[][] }
  | { kind: "quote"; spans: MdSpan[] }
  | { kind: "rule" };

// Only these schemes may become a real link. Everything else (javascript:, data:, vbscript:, or a
// bare word) renders as plain text — a link is the one place this view could otherwise hand a URL
// straight to the browser.
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** The href to use for a link, or null when it must not become one. */
export function safeHref(raw: string): string | null {
  const href = raw.trim();
  if (href === "") return null;
  // Scheme-relative ("//evil.com") inherits the page scheme and is a real navigation — allow it, it
  // can only ever be http(s) here. A rooted or relative path stays same-origin, which is harmless.
  if (href.startsWith("/") || href.startsWith("#")) return href;
  return SAFE_SCHEME.test(href) ? href : null;
}

// Ordered so the greedier delimiters win: ``code`` before **bold** before *italic*.
// Emphasis bodies forbid a leading/trailing space (see the glob note above) and can't span a newline.
const INLINE_RE = new RegExp(
  [
    "(`+)([^`]+?)\\1", // 1,2  inline code
    "\\*\\*(\\S(?:[^\\n]*?\\S)?)\\*\\*", // 3    bold
    "\\*(\\S(?:[^\\n*]*?\\S)?)\\*", // 4    italic
    "\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)", // 5,6  link
  ].join("|"),
  "g",
);

// Emphasis nests, so parsing recurses into each body. Every level strips at least one delimiter pair,
// so it always terminates — this bound is belt-and-braces against pathological input, past which the
// remaining text is simply left as text.
const MAX_INLINE_DEPTH = 6;

/** Parse one line/paragraph of inline Markdown. Pure, and recursive through emphasis/link bodies. */
export function parseInline(text: string, depth = 0): MdSpan[] {
  const spans: MdSpan[] = [];
  const push = (span: MdSpan) => {
    if (span.kind === "text" && span.text === "") return;
    spans.push(span);
  };
  if (depth >= MAX_INLINE_DEPTH) {
    push({ kind: "text", text });
    return spans;
  }

  // A fresh regex per call: INLINE_RE is stateful (`g`), and recursion would otherwise clobber the
  // parent's lastIndex mid-scan.
  const re = new RegExp(INLINE_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = re.exec(text)) !== null) {
    push({ kind: "text", text: text.slice(last, m.index) });
    if (m[2] !== undefined) push({ kind: "code", text: m[2] }); // leaf: content is verbatim
    else if (m[3] !== undefined) push({ kind: "bold", spans: parseInline(m[3], depth + 1) });
    else if (m[4] !== undefined) push({ kind: "italic", spans: parseInline(m[4], depth + 1) });
    else if (m[5] !== undefined && m[6] !== undefined) {
      const href = safeHref(m[6]);
      // An unsafe target keeps its literal Markdown, so nothing silently disappears from the text.
      if (href) push({ kind: "link", href, spans: parseInline(m[5] || href, depth + 1) });
      else push({ kind: "text", text: m[0] });
    }
    last = m.index + m[0].length;
  }
  push({ kind: "text", text: text.slice(last) });
  return spans;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*(?:```|~~~)\s*(\S*)/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;

/**
 * Parse Markdown into blocks. Pure — no React, no DOM — so the whole grammar is unit-testable and
 * the renderer stays a dumb mapping from AST to elements.
 */
export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.split("\n");
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
        spans: parseInline(heading[2] ?? ""),
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
      blocks.push({ kind: "quote", spans: parseInline(body.join(" ").trim()) });
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
        items.push(parseInline(item[1] ?? ""));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
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
        isItem(l)
      )
        break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ kind: "paragraph", spans: parseInline(para.join(" ")) });
  }

  return blocks;
}
