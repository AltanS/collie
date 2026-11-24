import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PANES_DIR } from "../../test/surface-corpus";
import { parseAnsi } from "../ansi";
import { splitLines } from "../blocks";
import { findInputFrame } from "./frame";
import { requireProfile } from "./profile";

const IDLE = requireProfile("claude").idle;
const rows = splitLines(parseAnsi(readFileSync(join(PANES_DIR, "claude--v2331-draft-scrolled-up--w59.txt"), "utf8")));

describe("Claude Code 2.1.331 box scrolled past its height (`─── ↑ 5 more ───`, no ❯ row in view)", () => {
  it("is still the input box, marked scrolled, with the visible tail as its text", () => {
    const frame = findInputFrame(rows, IDLE);
    expect(frame).not.toBeNull();
    expect(frame!.top).toBe(1);
    expect(frame!.bottom).toBe(5);
    expect(frame!.scrolled).toBe(true);
    expect(frame!.label).toBe("↑ 5 more");
    expect(frame!.interior.text.startsWith("of view. Collie looks for that prompt line")).toBe(true);
    expect(frame!.interior.text.endsWith("without pressing Enter.")).toBe(true);
  });
});
