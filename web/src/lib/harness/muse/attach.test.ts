import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseAnsi } from "../../ansi";
import { splitLines } from "../../blocks";
import { museAdapter } from "../muse";
import { museAttachCarriesSend } from "./attach";
import { extractInputDraft } from "./chrome";

const P1 = "/Users/jpcar/.local/state/collie/uploads/wF_p1E-mueq8gyr-af756fb2.jpg";
const P2 = "/Users/jpcar/.local/state/collie/uploads/wM_p1-mueqaikd-d1a86871.jpg";

describe("museAttachCarriesSend — the attach-token second look (#278)", () => {
  it("verifies one image path rewritten as its chip", () => {
    expect(museAttachCarriesSend(P1, "[Image #1]")).toBe(true);
  });

  it("verifies two images positionally, with prose around and between", () => {
    expect(museAttachCarriesSend(`see ${P1} and ${P2} please`, "see [Image #1] and [Image #2] please")).toBe(
      true,
    );
  });

  it("folds the paragraph breaks the sent text keeps", () => {
    expect(museAttachCarriesSend(`look\n\n${P1}`, "look [Image #1]")).toBe(true);
  });

  it("verifies a quoted non-image path against its bare form", () => {
    expect(museAttachCarriesSend("/tmp/repro-before.txt", '"/tmp/repro-before.txt"')).toBe(true);
  });

  it("refuses a stale chip with no corresponding sent run", () => {
    expect(museAttachCarriesSend("hello", "[Image #1] hello")).toBe(false);
  });

  it("refuses a chip count the sent text cannot supply", () => {
    expect(museAttachCarriesSend(P1, "[Image #1] [Image #2]")).toBe(false);
    expect(museAttachCarriesSend(P1, "[Image #2]")).toBe(false);
  });

  it("refuses a mis-ordered mapping", () => {
    expect(museAttachCarriesSend(`${P1} ${P2}`, "[Image #2] [Image #1]")).toBe(false);
  });

  it("refuses an image extension outside the set, stalling safe", () => {
    expect(museAttachCarriesSend("/tmp/photo.tga", "[Image #1]")).toBe(false);
  });

  it("leaves user-typed quotes to the generic match", () => {
    expect(museAttachCarriesSend('say "hi"', 'say "hi"')).toBe(false);
  });

  it("declines plain text without tokens", () => {
    expect(museAttachCarriesSend("hello", "hello")).toBe(false);
  });
});

// The adapter's second look is what the reply path calls, so the wiring is pinned too: read the
// draft off the fixture the way the verify loop does, then ask the adapter, not the module.
describe("museAdapter.draftCarriesSend — the attach look is wired in (#278)", () => {
  const PANES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures", "panes");
  const draftOf = (name: string): string =>
    extractInputDraft(splitLines(parseAnsi(readFileSync(join(PANES_DIR, name), "utf8"))))!;

  it("verifies an image send whose box shows the chip", () => {
    expect(museAdapter.draftCarriesSend!(P1, draftOf("muse--draft-image-chip.txt"))).toBe(true);
  });

  it("verifies a file send whose box shows the quoted path", () => {
    const draft = draftOf("muse--draft-quoted-path.txt");
    expect(museAdapter.draftCarriesSend!("/tmp/repro-before.txt", draft)).toBe(true);
  });

  it("still verifies a paste token, and still refuses a chip with no image sent", () => {
    const long = "q".repeat(3003);
    expect(museAdapter.draftCarriesSend!(long, draftOf("muse--draft-paste-token.txt"))).toBe(true);
    expect(museAdapter.draftCarriesSend!("hello", draftOf("muse--draft-image-chip.txt"))).toBe(false);
  });
});
