import { describe, expect, it } from "vitest";

import { stripSgr } from "./plain";

describe("stripSgr", () => {
  it("removes colour, faint and reset sequences and keeps the text", () => {
    expect(stripSgr("\u001b[2mask anything\u001b[0m")).toBe("ask anything");
    expect(stripSgr("\u001b[38;2;215;119;87mhi\u001b[39m there")).toBe("hi there");
    expect(stripSgr("\u001b[38:5:208mx\u001b[m")).toBe("x");
  });

  it("leaves a buffer with no escape byte as it is", () => {
    const text = "  ❯ 1. Yes\n    2. No\n";
    expect(stripSgr(text)).toBe(text);
  });

  it("leaves every non-SGR escape and every control byte alone", () => {
    const text = "\u001b[2Jmove\u001b[1;5H\u001b[?25l\t\r\n";
    expect(stripSgr(text)).toBe(text);
  });

  it("keeps row breaks and padding, so rows and columns stay where they were", () => {
    expect(stripSgr("\u001b[1ma\u001b[0m  \n\u001b[7m \u001b[0mb")).toBe("a  \n b");
  });
});
