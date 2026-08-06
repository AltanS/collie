import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { draftCarriesSend, sendGuardedReply } from "./reply-action";

// The regression suite for #34: a free-text reply must never fire the submit key until the text is
// verifiably sitting in the harness's input box. Before this, the reply path typed and then submitted
// blind, so with a dialog focused the text was swallowed and the submit key ANSWERED the dialog —
// approving whatever option was highlighted, while the bridge still reported {ok:true}.

const BOX_RULE = "─".repeat(40); // clears the 20-glyph border threshold in harness/claude/markers
const paneWithDraft = (draft: string) => `some output\n${BOX_RULE}\n❯ ${draft}\n${BOX_RULE}`;
// A focused permission dialog: no input box at the tail at all, so extractInputDraft sees nothing.
const paneWithDialog = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";

/** Record every reply POST, and let the fake pane's screen be swapped per test. */
function harness(screen: () => string) {
  const calls: Array<{ text: string; submit: boolean }> = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () =>
      HttpResponse.json({ paneId: "w1:p1", text: screen(), truncated: false, revision: 1 }),
    ),
    http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      const body = (await request.json()) as { text: string; submit: boolean };
      calls.push(body);
      return HttpResponse.json({ ok: true });
    }),
  );
  return calls;
}

const instant = { sleep: async () => {} }; // no real waiting; the bounded loop still runs its attempts

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
    // Only the WIDTH of a gap is unknowable — every visible character must still be there. A box
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
    // so the send has to carry whitespace there too — otherwise the screen holds a different
    // message. U+3000 between two CJK runs is the case that matters in Japanese.
    expect(draftCarriesSend("危険実行してください", "危険　実行してください")).toBe(false);
    expect(draftCarriesSend("危険　実行してください", "危険　実行してください")).toBe(true);
    // A gap the fold cannot make is not loosened at all — it must appear in the send verbatim, so a
    // full-width space on screen never verifies a half-width one in the send, or vice versa.
    expect(draftCarriesSend("delete file now", "delete　file now")).toBe(false);
    expect(draftCarriesSend("deploy the app now", "deploy  the app now")).toBe(false);
    expect(draftCarriesSend("deploy  the app now", "deploy  the app now")).toBe(true);
    // ...but a wrap AT that whitespace folds it down to the seam, and the seam still collapses —
    // the tolerance is one-directional, keyed on what the DRAFT shows, not on what the send holds.
    expect(draftCarriesSend("deploy  the app now", "deploy the app now")).toBe(true);
    expect(draftCarriesSend("delete　file now", "delete file now")).toBe(true);
    // A single space still collapses — that is the wrapped-CJK case the guard exists for.
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
    // enough that the floor is not what rejects it — the boundary check has to be doing the work.
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
    // characters — exactly enough to clear the floor while showing half of it. Four LRMs, not
    // three: at three the string is seven clusters and the floor rejects it whatever we count.
    const padded = "\u200EA\u200EB\u200EC\u200ED";
    expect(draftCarriesSend(`prefix ${padded} suffix`, padded)).toBe(false);
    // A control INSIDE a cluster still joins visible characters, so the emoji stays one character.
    // Eight of them is exactly the floor, so this fails if a ZWJ cluster is counted as nothing.
    const family = "👨‍👩‍👧‍👦";
    expect(draftCarriesSend(`prefix ${family.repeat(8)} suffix`, family.repeat(8))).toBe(true);
  });

  it("treats regex metacharacters in the draft as literal text", () => {
    expect(draftCarriesSend("run a.*b now", "run a.*b now")).toBe(true);
    expect(draftCarriesSend("run axxb now", "run a.*b now")).toBe(false);
  });
});

describe("sendGuardedReply", () => {
  it("types, verifies the text on the input line, then submits", async () => {
    const calls = harness(() => paneWithDraft("ship it please"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    // Two calls, in order: type without submitting, then submit-only with EMPTY text so the bridge
    // sends nothing but its configured submitKeys.
    expect(calls).toEqual([
      { text: "ship it please", submit: false },
      { text: "", submit: true },
    ]);
  });

  // The PRE-FLIGHT (.adr/0009). The verify-after guard below already kept Enter from answering a
  // dialog; this keeps the MESSAGE from being deposited in one, which is what the `/model` picker
  // exposed — no input box at all, so the text went into the picker before anything noticed.
  it("blocks before typing when the adapter can't see an input box", async () => {
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(out).toMatchObject({ error: expect.stringMatching(/input box isn't on screen/i) });
    // Nothing was typed AT ALL — not even the unsubmitted send_text.
    expect(calls).toEqual([]);
  });

  it("#34: force skips the pre-flight but still never sends the submit key blind", async () => {
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      ...instant,
    });

    expect(out.status).toBe("stalled");
    // THE regression assertion. The old path sent Enter here, which approved the highlighted "Yes".
    expect(calls.some((c) => c.submit)).toBe(false);
    expect(calls).toEqual([{ text: "please do not approve anything", submit: false }]);
  });

  it("the stalled message warns that a key answer probably landed", async () => {
    harness(() => paneWithDialog);
    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      ...instant,
    });
    expect(out).toMatchObject({ error: expect.stringMatching(/that key likely landed/i) });
  });

  it("#34: does not mistake somebody else's stranded draft for our text", async () => {
    const calls = harness(() => paneWithDraft("an unrelated leftover line"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("keeps the legacy one-shot send for a harness with no adapter", async () => {
    // No grammar → the input box is unreadable, so there is nothing to verify against. Guessing
    // would strand a no-echo input (a shell's sudo prompt) with the submit key withheld forever.
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ls -la",
      agent: "shell",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([{ text: "ls -la", submit: true }]);
  });

  it("surfaces a failed type call without submitting", async () => {
    const calls: Array<{ submit: boolean }> = [];
    server.use(
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        calls.push((await request.json()) as { submit: boolean });
        return HttpResponse.json({ ok: false, error: "herdr socket down" });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "error", error: "herdr socket down" });
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("reports textDelivered when the text landed but the submit key failed", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json({
          paneId: "w1:p1",
          text: paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        }),
      ),
      http.post(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = (await request.json()) as { submit: boolean };
        return body.submit
          ? HttpResponse.json({ ok: false, error: "keys failed" })
          : HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("error");
    expect(out).toMatchObject({ textDelivered: true });
  });
});
