import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles } from "../../web/src/lib/surface/profile.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { surfaceOfScreen } from "../../web/src/lib/surface/fold.ts";
import { boxMatches, boxMatchesTail } from "./protocol.ts";

const SENT =
  "This message is long enough that in a small pane it wraps past the height of the Claude Code input box. When that happens Claude Code scrolls the box and draws an up arrow with a count of hidden lines in the top border, and the prompt line with the caret scrolls out of view. Collie looks for that prompt line to find the box, so it cannot find it, and the send stops after typing without pressing Enter.";
const FIXTURE = join(import.meta.dirname, "..", "..", "web", "src", "fixtures", "panes", "claude--v2331-draft-scrolled-up--w59.txt");

describe("Claude Code 2.1.331 box scrolled to `↑ 5 more` after a 404-char send", () => {
  const rows = splitLines(parseAnsi(readFileSync(FIXTURE, "utf8")));
  const read = surfaceOfScreen({ seq: 0, source: "screen", at: 0, revision: 1, rows, ask: null }, loadProfiles().get("claude")!.idle);

  test("the screen reads as an idle box holding a draft, not unknown/no-match", () => {
    expect(read.frame?.scrolled).toBe(true);
    expect(read.surface).toMatchObject({ turn: "idle", modal: "none", composer: "draft" });
  });

  test("S1 confirms the send by the tail: the box shows only the end of what was typed", () => {
    const box = read.frame!.interior.text;
    expect(boxMatches(box, "", [SENT], null)).toBe(false);
    expect(boxMatchesTail(box, "", [SENT])).toBe(true);
    expect(boxMatchesTail(box, "", [SENT.replace("without pressing", "after pressing")])).toBe(false);
  });
});
