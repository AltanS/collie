// The display match between a sent text and the input box's visible draft (lib/draft-match.ts).
// Moved from reply-action.test.ts with the function in M56 spec 06: the phone's type-then-verify that
// used it is gone, and the echo suppression and the harness tests keep it.

import { draftCarriesSend } from "./draft-match";

describe("draftCarriesSend", () => {
  it("accepts the exact text, and the space-joined form of a wrapped draft", () => {
    expect(draftCarriesSend("ship it please", "ship it please")).toBe(true);
    expect(draftCarriesSend("ship it\nplease", "ship it please")).toBe(true);
  });

  it("accepts a windowed slice of a long draft", () => {
    const sent = "a much longer message than the input box can show at one time";
    expect(draftCarriesSend(sent, "message than the input box can show")).toBe(true);
  });

  it("rejects an empty, absent, or too-short remnant", () => {
    expect(draftCarriesSend("anything", null)).toBe(false);
    expect(draftCarriesSend("anything", "   ")).toBe(false);
    // "a" IS a substring of the send, but one stray character is not evidence our text landed.
    expect(draftCarriesSend("a much longer message", "a")).toBe(false);
  });

  it("requires the whole thing when the send is shorter than the floor", () => {
    expect(draftCarriesSend("ok", "ok")).toBe(true);
    expect(draftCarriesSend("ok", "o")).toBe(false);
  });

  it("rejects an unrelated draft", () => {
    expect(draftCarriesSend("deploy to prod", "someone else's leftover")).toBe(false);
  });

  it("accepts a CJK draft wrapped mid-run (the fold fabricates a space the send never had)", () => {
    // A Japanese draft has no word boundaries, so the input box wraps it mid-run and the
    // space-joined fold yields a space absent from the sent text. This stalled every wrapped
    // Japanese reply: the guard never verified the text and withheld the submit key.
    const sent = "これちなみに電池寿命的にはどうなんだろね。";
    expect(draftCarriesSend(sent, "これちなみに電池寿命的にはどうなん だろね。")).toBe(true);
    // A windowed (tail-only) slice of a wrapped CJK draft still matches.
    expect(draftCarriesSend(sent, "電池寿命的にはどうなん だろね。")).toBe(true);
    // An unrelated CJK remnant still fails.
    expect(draftCarriesSend(sent, "別の誰かの下書きです、これは。")).toBe(false);
  });

  it("accepts mixed CJK/latin text wrapped at either kind of seam", () => {
    // The case no language test could handle: ONE draft carrying both a genuine space (between
    // "pull" and "request") and a fabricated one (wherever the box broke the CJK run).
    const sent = "これは pull request のテストです";
    expect(draftCarriesSend(sent, "これは pull request のテ ストです")).toBe(true); // mid-CJK break
    expect(draftCarriesSend(sent, "これは pull request のテストです")).toBe(true); // at the space
    expect(draftCarriesSend(sent, "これは pull request のテストです")).toBe(true); // no wrap at all
  });

  it("still rejects a draft that lost or altered a non-space character", () => {
    // Only the WIDTH of a gap is unknowable, every visible character must still be there. A box
    // showing text with a space genuinely missing is NOT our text and must not be verified.
    expect(draftCarriesSend("deploy the app", "deploythe app")).toBe(false);
    const sent = "これを実行して結果を教えてください";
    expect(draftCarriesSend(sent, "これを実行して結果を")).toBe(true); // a prefix is a slice
    expect(draftCarriesSend(sent, "これを実行させて結果を")).toBe(false); // an inserted char is not
  });

  it("still requires the visible runs to be contiguous in the send", () => {
    // The relaxation must not degrade into a fuzzy "these words appear somewhere" match: whatever
    // sits between two runs in the send has to be whitespace, or it isn't a contiguous slice.
    expect(draftCarriesSend("deploy the app to prod", "deploy app")).toBe(false);
    expect(draftCarriesSend("送信して、確認して", "送信して 確認して")).toBe(false);
  });

  it("only lets a gap the fold could have made collapse to nothing", () => {
    // The fold's seam is always exactly one plain space. Any other whitespace was really on screen,
    // so the send has to carry whitespace there too, otherwise the screen holds a different
    // message. U+3000 between two CJK runs is the case that matters in Japanese.
    expect(draftCarriesSend("危険実行してください", "危険　実行してください")).toBe(false);
    expect(draftCarriesSend("危険　実行してください", "危険　実行してください")).toBe(true);
    // A gap the fold cannot make is not loosened at all, it must appear in the send verbatim, so a
    // full-width space on screen never verifies a half-width one in the send, or vice versa.
    expect(draftCarriesSend("delete file now", "delete　file now")).toBe(false);
    expect(draftCarriesSend("deploy the app now", "deploy  the app now")).toBe(false);
    expect(draftCarriesSend("deploy  the app now", "deploy  the app now")).toBe(true);
    // ...but a wrap AT that whitespace folds it down to the seam, and the seam still collapses,
    // the tolerance is one-directional, keyed on what the DRAFT shows, not on what the send holds.
    expect(draftCarriesSend("deploy  the app now", "deploy the app now")).toBe(true);
    expect(draftCarriesSend("delete　file now", "delete file now")).toBe(true);
    // A single space still collapses, that is the wrapped-CJK case the guard exists for.
    expect(draftCarriesSend("これを実行してください", "これを実行 してください")).toBe(true);
  });

  it("counts the floor in visible characters, not UTF-16 code units", () => {
    // A ZWJ family sequence is 11 code units but ONE character on screen. Counting code units let a
    // single glyph clear the 8-character floor and pass as evidence that the message landed.
    const family = "👨‍👩‍👧‍👦";
    expect(draftCarriesSend(`please explain ${family} before proceeding`, family)).toBe(false);
    expect(draftCarriesSend(`${family}${family}`, `${family}${family}`)).toBe(true); // whole send
  });

  it("requires the match to land on visible-character boundaries", () => {
    // "👩‍👧‍👦" is a code-unit substring of "👨‍👩‍👧‍👦" while being a different character. Matching
    // mid-character would let the screen show one emoji and verify as another.
    expect(draftCarriesSend("👨‍👩‍👧‍👦", "👩‍👧‍👦")).toBe(false);
    expect(draftCarriesSend("👨‍👩‍👧‍👦", "👨‍👩‍👧‍👦")).toBe(true);
    // The END of the match is checked too, not just its start: "abcdefgh" stops inside the "h" +
    // combining-acute cluster here, so it is not a slice of what we sent. Both sides are long
    // enough that the floor is not what rejects it, the boundary check has to be doing the work.
    expect(draftCarriesSend("abcdefgh́ then more", "abcdefgh")).toBe(false);
    // A windowed tail that DOES start on a boundary is a legitimate slice and must still pass.
    expect(draftCarriesSend("café opened wide", "é opened wide")).toBe(true);
  });

  it("checks every occurrence, not only the first", () => {
    // The first "abcdefgh" here ends inside a combining cluster; the second is properly aligned.
    // Bailing after one hit would stall a reply whose text is verifiably on screen.
    expect(draftCarriesSend("abcdefgh́ then abcdefgh", "abcdefgh")).toBe(true);
  });

  it("does not let invisible controls pad the floor", () => {
    // Segmenter calls each LRM its own cluster, so this is EIGHT clusters carrying FOUR readable
    // characters, exactly enough to clear the floor while showing half of it. Four LRMs, not
    // three: at three the string is seven clusters and the floor rejects it whatever we count.
    const padded = "\u200EA\u200EB\u200EC\u200ED";
    expect(draftCarriesSend(`prefix ${padded} suffix`, padded)).toBe(false);
    // A control INSIDE a cluster still joins visible characters, so the emoji stays one character.
    // Eight of them is exactly the floor, so this fails if a ZWJ cluster is counted as nothing.
    const family = "👨‍👩‍👧‍👦";
    expect(draftCarriesSend(`prefix ${family.repeat(8)} suffix`, family.repeat(8))).toBe(true);
  });

  // M46: the bridge masks a known secret shape on screen (bridge/redact.ts) but never the operator's
  // own send, so a reply carrying a key reads back from the box as the key's mask. Placeholder only.
  it("reads the bridge's secret mask as one printable character per mark", () => {
    const key = "sk-or-v1-your-key-here-0000000000";
    const masked = `sk-o${"•".repeat(key.length - 4)}`;
    expect(draftCarriesSend(`use ${key} now`, `use ${masked} now`)).toBe(true);
    // One mark too many or too few is a different text.
    expect(draftCarriesSend(`use ${key} now`, `use ${masked}• now`)).toBe(false);
    expect(draftCarriesSend(`use ${key} now`, `use ${masked.slice(0, -1)} now`)).toBe(false);
    // A mark never stands for whitespace, and a literal bullet still verifies itself.
    expect(draftCarriesSend("password: a b c d e f", "password: a•b c d e f")).toBe(false);
    expect(draftCarriesSend("• first item in a list", "• first item in a list")).toBe(true);
  });

  it("treats regex metacharacters in the draft as literal text", () => {
    expect(draftCarriesSend("run a.*b now", "run a.*b now")).toBe(true);
    expect(draftCarriesSend("run axxb now", "run a.*b now")).toBe(false);
  });

  it("still verifies a wrapped draft on an engine without Intl.Segmenter", async () => {
    // This module is in the main chunk, so a module-scope `new Intl.Segmenter` would throw at
    // evaluation on Firefox < 125 / Safari < 14.1 and white-screen the app at boot. Import it with
    // the constructor gone: it must load, and the guard must keep working at per-code-point
    // precision, the degradation is grapheme accuracy, never the app.
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    // @ts-expect-error: Intl.Segmenter is not optional in the lib types; that is the point.
    delete Intl.Segmenter;
    vi.resetModules();
    try {
      const legacy = await import("./draft-match");
      const sent = "これちなみに電池寿命的にはどうなんだろね。";
      expect(legacy.draftCarriesSend(sent, "これちなみに電池寿命的にはどうなん だろね。")).toBe(
        true,
      );
      expect(legacy.draftCarriesSend(sent, "別の誰かの下書きです、これは。")).toBe(false);
    } finally {
      Object.defineProperty(Intl, "Segmenter", segmenter);
      vi.resetModules();
    }
  });
});
