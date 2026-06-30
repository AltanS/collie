import { parseAnsi } from "./ansi";

// The ANSI parser is the XSS boundary: it must turn SGR escapes into *style metadata* while
// every byte of visible text is preserved verbatim as a plain string (the renderer puts it in a
// React text node). These tests pin down the colour/weight parsing AND, crucially, that raw markup
// survives as literal text and is never interpreted.

const ESC = "\x1b";

/** Concatenate the visible text of every segment — what the user actually sees. */
const visible = (s: string) => parseAnsi(s).map((seg) => seg.text).join("");

describe("parseAnsi — text fidelity", () => {
  it("returns plain text as a single unstyled segment", () => {
    const segs = parseAnsi("hello world");
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("hello world");
    expect(segs[0]!.fg).toBeUndefined();
    expect(segs[0]!.bg).toBeUndefined();
    expect(segs[0]!.bold).toBeFalsy();
  });

  it("strips SGR escape sequences from the visible text but keeps the surrounding characters", () => {
    const segs = parseAnsi(`a${ESC}[31mb${ESC}[0mc`);
    expect(segs.map((s) => s.text)).toEqual(["a", "b", "c"]);
    const joined = segs.map((s) => s.text).join("");
    expect(joined).toBe("abc");
    // No raw escape bytes or CSI fragments leak into any segment.
    expect(joined).not.toContain(ESC);
    expect(joined).not.toContain("[31m");
    expect(joined).not.toContain("[0m");
  });

  it("returns an empty array for empty input", () => {
    expect(parseAnsi("")).toEqual([]);
  });
});

describe("parseAnsi — SGR colour & weight", () => {
  it("parses a basic foreground colour (31 = red)", () => {
    const segs = parseAnsi(`${ESC}[31mred${ESC}[0m`);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe("red");
    expect(segs[0]!.fg).toBe("#cd3131");
  });

  it("parses a background colour (42 = green bg)", () => {
    const segs = parseAnsi(`${ESC}[42mx`);
    expect(segs[0]!.bg).toBe("#0dbc79");
  });

  it("parses bright foreground colours (91 = bright red)", () => {
    const segs = parseAnsi(`${ESC}[91mx`);
    expect(segs[0]!.fg).toBe("#f14c4c");
  });

  it("parses weights/styles and resets them", () => {
    const segs = parseAnsi(`${ESC}[1mbold${ESC}[22mnorm`);
    expect(segs[0]!.text).toBe("bold");
    expect(segs[0]!.bold).toBe(true);
    expect(segs[1]!.text).toBe("norm");
    expect(segs[1]!.bold).toBe(false);
  });

  it("parses italic, underline and strike", () => {
    const segs = parseAnsi(`${ESC}[3;4;9mx`);
    expect(segs[0]!.italic).toBe(true);
    expect(segs[0]!.underline).toBe(true);
    expect(segs[0]!.strike).toBe(true);
  });

  it("parses 256-colour cube codes (38;5;46 → pure green)", () => {
    const segs = parseAnsi(`${ESC}[38;5;46mx`);
    expect(segs[0]!.fg).toBe("rgb(0,255,0)");
  });

  it("parses 256-colour grayscale ramp (38;5;232 → near-black)", () => {
    const segs = parseAnsi(`${ESC}[38;5;232mx`);
    expect(segs[0]!.fg).toBe("rgb(8,8,8)");
  });

  it("parses 24-bit truecolor (38;2;r;g;b)", () => {
    const segs = parseAnsi(`${ESC}[38;2;10;20;30mx`);
    expect(segs[0]!.fg).toBe("rgb(10,20,30)");
  });

  it("swaps fg/bg for inverse video (7m), with sensible fallbacks", () => {
    const segs = parseAnsi(`${ESC}[7mx`);
    expect(segs[0]!.fg).toBe("var(--background)");
    expect(segs[0]!.bg).toBe("var(--foreground)");
  });

  it("skips OSC sequences (window title) without leaking them into the text", () => {
    const segs = parseAnsi(`${ESC}]0;the title${"\x07"}visible`);
    expect(visible(`${ESC}]0;the title${"\x07"}visible`)).toBe("visible");
    expect(segs.map((s) => s.text).join("")).not.toContain("title");
  });

  it("treats an empty CSI reset (ESC[m) as a full reset", () => {
    const segs = parseAnsi(`${ESC}[31mred${ESC}[mplain`);
    expect(segs.find((s) => s.text === "red")!.fg).toBe("#cd3131");
    expect(segs.find((s) => s.text === "plain")!.fg).toBeUndefined();
  });
});

// Defensive premise of the parser: ANY non-SGR escape (cursor moves, screen clears, OSC-via-ST)
// must vanish from the visible text rather than leak through — part of the same safety boundary.
describe("parseAnsi — non-SGR escapes are stripped", () => {
  it("strips non-SGR CSI sequences (cursor move, clear screen) from the visible text", () => {
    const input = `before${ESC}[2Jmid${ESC}[10Aafter`;
    expect(visible(input)).toBe("beforemidafter");
    expect(visible(input)).not.toContain(ESC);
  });

  it("skips an OSC terminated by ST (ESC \\) too, not just BEL", () => {
    const input = `${ESC}]0;the title${ESC}\\visible`;
    expect(visible(input)).toBe("visible");
    expect(visible(input)).not.toContain("title");
  });
});

describe("parseAnsi — XSS boundary (raw markup stays literal)", () => {
  it("treats an injected <img onerror> payload as plain text, never markup", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const segs = parseAnsi(payload);
    expect(segs).toHaveLength(1);
    // The exact bytes survive — nothing is interpreted, escaped, or dropped.
    expect(segs[0]!.text).toBe(payload);
  });

  it("preserves <script> markup verbatim even when wrapped in real SGR colour", () => {
    const payload = "<script>alert(document.cookie)</script>";
    const segs = parseAnsi(`${ESC}[31m${payload}${ESC}[0m`);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.text).toBe(payload);
    expect(segs[0]!.fg).toBe("#cd3131"); // still styled, but the body is inert text
  });

  it("keeps angle brackets, ampersands and quotes intact (no HTML entity encoding)", () => {
    const payload = `<b>&"'</b>`;
    expect(visible(payload)).toBe(payload);
  });
});

// ─── New test groups ──────────────────────────────────────────────────────────

describe("parseAnsi — CR overwrite semantics (last-write-wins per line)", () => {
  it("spinner: last frame wins — each \\r resets to column 0, final content is what remains", () => {
    expect(visible("\rframe1\rframe2\rframe3")).toBe("frame3");
  });

  it("progress bar: content after the final \\r is the visible result", () => {
    expect(visible("      0%\r[=====] 100%")).toBe("[=====] 100%");
  });

  it("CR mid-line: last-CR-wins replaces everything from column 0", () => {
    expect(visible("abc\rXY")).toBe("XY");
  });

  it("CR within a multi-line string: only affects the current line, not earlier lines", () => {
    expect(visible("line1\nbar\rfoo")).toBe("line1\nfoo");
  });

  it("SGR state carries through CR: colour active before \\r applies to content after", () => {
    // Real terminal: \r moves cursor to col 0; SGR state is unchanged. Content after \r is
    // rendered in whatever colour was set before the \r.
    const segs = parseAnsi(`${ESC}[31mred\rblue`);
    expect(visible(`${ESC}[31mred\rblue`)).toBe("blue");
    expect(segs[0]!.fg).toBe("#cd3131"); // "blue" text is in red colour
  });

  it("multiple lines: \\r only rolls back the current line, leaving prior lines intact", () => {
    // "aaa\n" is committed; on the second line, "bbb" is overwritten by "ccc".
    expect(visible("aaa\nbbb\rccc\nddd")).toBe("aaa\nccc\nddd");
  });

  it("CRLF line endings keep their content — a \\r right before \\n is a terminator, not an overwrite", () => {
    // Herdr's pane buffer is CRLF; treating the trailing \r as an overwrite wiped every line to
    // blank (the empty-mirror regression). The line content before the \r must survive.
    expect(visible("line one\r\nline two\r\n")).toBe("line one\nline two\n");
  });

  it("a trailing \\r at end of input keeps the line content (overwrites nothing)", () => {
    expect(visible("done\r")).toBe("done");
  });
});

describe("parseAnsi — colon-delimited SGR (ISO 8613-6 sub-parameters)", () => {
  it("38:2:r:g:b truecolor produces the same colour as 38;2;r;g;b", () => {
    const colonForm = parseAnsi(`${ESC}[38:2:10:20:30mx`);
    const semiForm = parseAnsi(`${ESC}[38;2;10;20;30mx`);
    expect(colonForm[0]!.fg).toBe("rgb(10,20,30)");
    expect(colonForm[0]!.fg).toBe(semiForm[0]!.fg);
  });

  it("38:5:n 256-colour produces the same colour as 38;5;n", () => {
    const colonForm = parseAnsi(`${ESC}[38:5:46mx`);
    const semiForm = parseAnsi(`${ESC}[38;5;46mx`);
    expect(colonForm[0]!.fg).toBe("rgb(0,255,0)");
    expect(colonForm[0]!.fg).toBe(semiForm[0]!.fg);
  });

  it("ISO empty-colorspace form 38:2::r:g:b (empty field between 2 and r) works correctly", () => {
    // The empty field between 2 and the r component is silently skipped.
    const segs = parseAnsi(`${ESC}[38:2::10:20:30mx`);
    expect(segs[0]!.fg).toBe("rgb(10,20,30)");
  });

  it("48:2:r:g:b colon-form background truecolor works", () => {
    const colonForm = parseAnsi(`${ESC}[48:2:50:100:150mx`);
    const semiForm = parseAnsi(`${ESC}[48;2;50;100;150mx`);
    expect(colonForm[0]!.bg).toBe("rgb(50,100,150)");
    expect(colonForm[0]!.bg).toBe(semiForm[0]!.bg);
  });
});

describe("parseAnsi — DEC-private and non-SGR CSI are fully consumed (no leaked text)", () => {
  it("\\x1b[>0c (secondary device attributes) produces no visible text", () => {
    const result = visible(`before${ESC}[>0cafter`);
    expect(result).toBe("beforeafter");
    expect(result).not.toContain("0c");
    expect(result).not.toContain(">");
  });

  it("\\x1b[=1h (private DEC mode set) produces no visible text", () => {
    const result = visible(`before${ESC}[=1hafter`);
    expect(result).toBe("beforeafter");
    expect(result).not.toContain("1h");
    expect(result).not.toContain("=");
  });

  it("\\x1b[<5m (private-marker before m) is not treated as SGR and produces no text", () => {
    // The '<' byte is a private-indicator; even with final byte 'm' this is not SGR.
    const result = visible(`before${ESC}[<5mafter`);
    expect(result).toBe("beforeafter");
    expect(result).not.toContain("<");
  });
});

describe("parseAnsi — segment shape carries pre-computed style and muted flag", () => {
  it("every segment has a style object and a muted boolean", () => {
    const segs = parseAnsi("hello");
    expect(segs[0]!.style).toBeDefined();
    expect(typeof segs[0]!.muted).toBe("boolean");
  });

  it("plain text segment is not muted and has an empty style", () => {
    const segs = parseAnsi("hello");
    expect(segs[0]!.muted).toBe(false);
    expect(segs[0]!.style).toEqual({});
  });

  it("coloured segment has color set in style", () => {
    const segs = parseAnsi(`${ESC}[31mred${ESC}[0m`);
    expect(segs[0]!.style.color).toBe("#cd3131");
    expect(segs[0]!.muted).toBe(false);
  });

  it("bold segment has fontWeight in style", () => {
    const segs = parseAnsi(`${ESC}[1mbold${ESC}[0m`);
    expect(segs[0]!.style.fontWeight).toBe(600);
  });

  it("box-drawing segment is marked muted=true", () => {
    // ─ is U+2500 (BOX DRAWINGS LIGHT HORIZONTAL), well within the RULE_GLYPHS range.
    const segs = parseAnsi("────────");
    expect(segs[0]!.muted).toBe(true);
  });

  it("normal ASCII text (including dashes and equals) is not muted", () => {
    // Only Unicode box-drawing / dash chars trigger muted; ASCII - = are excluded.
    expect(parseAnsi("--------")[0]!.muted).toBe(false);
    expect(parseAnsi("========")[0]!.muted).toBe(false);
    expect(parseAnsi("hello world")[0]!.muted).toBe(false);
  });
});
