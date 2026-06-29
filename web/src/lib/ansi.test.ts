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
