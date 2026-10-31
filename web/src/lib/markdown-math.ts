/** A formula keeps its delimiters for literal fallback and copying, and its body for typesetting. */
export interface MdMath {
  kind: "math";
  text: string;
  source: string;
}

/** Bounds both delimiter lookahead and the work handed to the math renderer. */
export const MAX_MATH_CHARS = 4096;

interface MathMatch {
  math: MdMath;
  end: number;
}

function escapedAt(text: string, at: number): boolean {
  let slashes = 0;
  while (at > 0 && text[--at] === "\\") slashes++;
  return slashes % 2 === 1;
}

/** Find a delimiter without mistaking an escaped one for the end of a formula. */
function closingAt(text: string, close: string): number {
  let at = text.indexOf(close);
  while (at !== -1) {
    const dollarRun = close === "$" && (
      (text[at - 1] === "$" && !escapedAt(text, at - 1)) || text[at + 1] === "$"
    );
    if (!escapedAt(text, at) && !dollarRun) return at;
    at = text.indexOf(close, at + close.length);
  }
  return -1;
}

/**
 * Inline math at one position. Code and link destinations are claimed by Markdown before this is
 * called. Dollar delimiters require non-space inside and no word immediately after the closer,
 * so "$5 and $10" and "$HOME/$USER" stay literal. A failed candidate consumes no following prose.
 */
export function readInlineMath(source: string, at: number): MathMatch | null {
  const dollars = source[at] === "$" && source[at - 1] !== "$" && source[at + 1] !== "$";
  const open = dollars ? "$" : source.startsWith("\\(", at) ? "\\(" : null;
  if (open === null || escapedAt(source, at)) return null;
  const close = dollars ? "$" : "\\)";
  // Slice BEFORE searching: a missing closer in a huge dump must not scan the rest of the file.
  const tail = source.slice(at + open.length, at + open.length + MAX_MATH_CHARS + close.length);
  const end = closingAt(tail, close);
  if (end === -1 || end > MAX_MATH_CHARS) return null;
  const text = tail.slice(0, end);
  if (text.trim() === "") return null;
  const after = at + open.length + end + close.length;
  if (dollars && (/^\s|\s$/.test(text) || /\w/.test(source[after] ?? ""))) return null;
  return { math: { kind: "math", text, source: source.slice(at, after) }, end: after };
}

/**
 * A display equation occupies whole source lines, with $$ or \[ ... \]. Keep those lines intact:
 * paragraph reflow would change TeX comments and matrix/alignment rows. Both a one-line equation and
 * a multiline one are accepted. An incomplete or oversized block stays ordinary Markdown text.
 */
export function readDisplayMath(lines: readonly string[], at: number): MathMatch | null {
  const first = lines[at];
  if (first === undefined || first.length > MAX_MATH_CHARS) return null;
  const opening = /^ {0,3}(\$\$|\\\[)/.exec(first);
  if (opening === null) return null;
  const open = opening[1]!;
  if (open === "$$" && first[opening[0].length] === "$") return null;
  const close = open === "$$" ? "$$" : "\\]";
  const body: string[] = [];
  let size = 0;
  for (let i = at; i < lines.length; i++) {
    const line = i === at ? first.slice(opening[0].length) : lines[i]!;
    // Nested openers are not TeX. Stop here so repeated unfinished \[ blocks scan only once.
    if (i > at && /^ {0,3}\\\[/.test(line)) return null;
    size += line.length + 1;
    if (size > MAX_MATH_CHARS) return null;
    const end = closingAt(line, close);
    if (end !== -1) {
      if (line.slice(end + close.length).trim() !== "") return null;
      body.push(line.slice(0, end));
      const text = body.join("\n").trim();
      if (text === "") return null;
      return { math: { kind: "math", text, source: lines.slice(at, i + 1).join("\n") }, end: i + 1 };
    }
    // A missing math closer must not claim a subsequent fenced code example.
    if (/^\s*(?:```|~~~)/.test(line)) return null;
    body.push(line);
  }
  return null;
}
