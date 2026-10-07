import { readFileSync } from "node:fs";
import { join } from "node:path";

import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import * as registry from "./harness/registry";
import { bracketPaste, draftCarriesSend, sendGuardedReply } from "./reply-action";

// M46 spec 11 turns every send off for a pane the bridge has not answered lately (lib/liveness.ts).
// These suites drive sends against a mocked network and never poll first, so they pin the pane live;
// the gating itself is covered by liveness.test.ts and the *-offline suites.
vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// The regression suite for #34: a free-text reply must never fire the submit key until the text is
// verifiably sitting in the harness's input box. Before this, the reply path typed and then submitted
// blind, so with a dialog focused the text was swallowed and the submit key ANSWERED the dialog —
// approving whatever option was highlighted, while the bridge still reported {ok:true}.

const BOX_RULE = "─".repeat(40); // clears the 20-glyph border threshold in harness/claude/markers
const PANES_DIR = join(import.meta.dirname, "..", "fixtures", "panes");
const fixtureText = (name: string) => readFileSync(join(PANES_DIR, name), "utf8");
const paneWithDraft = (draft: string) => `some output\n${BOX_RULE}\n❯ ${draft}\n${BOX_RULE}`;
// A focused permission dialog: no input box at the tail at all, so extractInputDraft sees nothing.
const paneWithDialog = "Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel";

/** Record every reply POST, and let the fake pane's screen be swapped per test. */
function harness(screen: () => string) {
  const calls: Array<{ text: string; submit: boolean; expected_prompt?: string }> = [];
  server.use(
    http.get(/\/api\/pane\/[^/]+$/, () =>
      HttpResponse.json({ paneId: "w1:p1", text: screen(), truncated: false, revision: 1 }),
    ),
    http.post<never, { text: string; submit: boolean; expected_prompt?: string }>(
      /\/api\/pane\/[^/]+\/reply$/,
      async ({ request }) => {
        const body = await request.json();
        calls.push(body);
        return HttpResponse.json({ ok: true });
      },
    ),
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
    // precision — the degradation is grapheme accuracy, never the app.
    const segmenter = Object.getOwnPropertyDescriptor(Intl, "Segmenter")!;
    // @ts-expect-error — Intl.Segmenter is not optional in the lib types; that is the point.
    delete Intl.Segmenter;
    vi.resetModules();
    try {
      const legacy = await import("./reply-action");
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

describe("sendGuardedReply", () => {
  it("verifies a long Grok draft without treating the input scrollbar as message text", async () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `Collie Grok probe line ${String(i + 1).padStart(2, "0")}: 繁體中文測試，不執行任何工具。`,
    ).join("\n");
    const calls = harness(() =>
      fixtureText(calls.length === 0 ? "grok--fresh-idle.txt" : "grok--draft-scrollbar.txt"),
    );

    const out = await sendGuardedReply({ paneId: "w1:p1", text, agent: "grok", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text, submit: false },
      { text: "", submit: true },
    ]);
  });

  it("verifies a long Grok draft with a fractional scrollbar thumb", async () => {
    const text = Array.from(
      { length: 40 },
      (_, i) => `GB_LONG_${String(i + 1).padStart(2, "0")}：繁體中文測試。`,
    ).join("\n") + "\n不要使用工具。請只回覆 GB_LONG_CONFIRMED_40。";
    const calls = harness(() =>
      fixtureText(calls.length === 0 ? "grok--fresh-idle.txt" : "grok--draft-scrollbar-partial.txt"),
    );

    const out = await sendGuardedReply({ paneId: "w1:p1", text, agent: "grok", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text, submit: false },
      { text: "", submit: true },
    ]);
  });

  // RED-FIRST regression: the visible Codex composer used to be classified as absent when its queue
  // hint and context percentage shared one raw terminal row. This must still verify before submit.
  it("types, verifies, and submits on Codex's inline queue/context footer", async () => {
    const calls = harness(() => fixtureText("codex--queue-context-inline.txt"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "continue the release checklist",
      agent: "codex",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    // The submit carries the region the verifying read saw. Codex supplies `composerPrompt`, so the
    // binding applies here as it does on every other adapter that does — this assertion is the
    // meeting point of the two fixes and is written out rather than loosened.
    expect(calls).toEqual([
      { text: "continue the release checklist", submit: false },
      { text: "", submit: true, expected_prompt: "› continue the release checklist" },
    ]);
  });

  // The canary's busy send (M37/03): while Codex streams its first reply, the status row ends in a
  // spinner frame. That row used to hide the composer, so the pre-flight refused the send as
  // `blocked`, where Codex queues it. The pane holds the busy screen until the text is typed, then
  // the same pane with the draft in the box and the queue hint under it.
  it("types, verifies, and submits to a Codex that is still working", async () => {
    const text = "a draft typed while codex works";
    const calls = harness(() =>
      fixtureText(calls.length === 0 ? "codex--v0156-busy-streaming.txt" : "codex--v0156-busy-draft.txt"),
    );

    const out = await sendGuardedReply({ paneId: "w1:p1", text, agent: "codex", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text, submit: false },
      { text: "", submit: true, expected_prompt: `› ${text}` },
    ]);
  });

  // The 82-column stall: Claude's slash popup clipped a command name to "…ugin:…", the box went
  // undetected, and the guard typed the text and withheld Enter. The same screen now verifies.
  it("verifies a slash command under a popup with a clipped command name, then submits", async () => {
    const calls = harness(() => fixtureText("claude--autocomplete-slash-clipped.txt"));

    const out = await sendGuardedReply({ paneId: "w1:p1", text: "/model", agent: "claude", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "/model", submit: false },
      { text: "", submit: true },
    ]);
  });

  // A stale box echoed above a live dialog must never read as the composer: nothing is typed, and no
  // submit key can answer the dialog.
  it("refuses a dialog screen with a stale box triple above it, and never sends Enter", async () => {
    const dialog = fixtureText("claude--permission-bash.txt");
    const calls = harness(() => `● earlier\n${BOX_RULE}\n❯ please run the migration\n${BOX_RULE}\n\n${dialog}`);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please run the migration",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(calls.some((c) => c.submit)).toBe(false);
    expect(calls).toEqual([]);
  });

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

  it("submits a reply whose key the bridge masks on screen (M46)", async () => {
    const key = "sk-or-v1-your-key-here-0000000000";
    const sent = `set OPENROUTER_API_KEY=${key}`;
    const calls = harness(() => paneWithDraft(`set OPENROUTER_API_KEY=sk-o${"•".repeat(key.length - 4)}`));

    const out = await sendGuardedReply({ paneId: "w1:p1", text: sent, agent: "claude", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: sent, submit: false },
      { text: "", submit: true },
    ]);
  });

  it("binds submit to the verified region and preserves text when the prompt changes", async () => {
    const suggestion = "\x1b[38;2;111;115;119m to the deploy host\x1b[0m";
    const initial =
      `some output\n\x1b[38;2;74;80;88m╭── statusline ───╮\x1b[0m\n` +
      `\x1b[38;2;74;80;88m╰─ \x1b[0mship it please${suggestion}   \x1b[38;2;74;80;88m ─╯\x1b[0m`;
    const expectedPrompt = "╰─ ship it please to the deploy host    ─╯";
    const calls: Array<{ text: string; submit: boolean; expected_prompt?: string }> = [];
    let reads = 0;
    let promptChanged = false;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads++;
        // The second read is the successful post-type verification. The dialog appears immediately
        // after that read, before the submit request reaches the bridge.
        if (reads === 2) promptChanged = true;
        return HttpResponse.json({ paneId: "w1:p1", text: initial, truncated: false, revision: 1 });
      }),
      http.post<never, { text: string; submit: boolean; expected_prompt?: string }>(
        /\/api\/pane\/[^/]+\/reply$/,
        async ({ request }) => {
          const body = await request.json();
          calls.push(body);
          if (body.submit && promptChanged) {
            // A real bridge binding check returns this before its adapter sends any submit keys.
            return HttpResponse.json(
              { ok: false, error: "prompt changed", code: "prompt_changed" },
              { status: 409 },
            );
          }
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "omp",
      ...instant,
    });

    expect(out).toMatchObject({ status: "error", textDelivered: true });
    expect(out).toHaveProperty("error", expect.stringMatching(/screen changed/i));
    expect(calls).toEqual([
      { text: "ship it please", submit: false },
      { text: "", submit: true, expected_prompt: expectedPrompt },
    ]);
  });

  // GHOST TEXT must never vouch for a send. A newer Claude Code paints a generated "suggested next
  // prompt" into an otherwise empty box, faint (SGR 2). `draftCarriesSend` accepts any draft whose
  // visible characters appear contiguously in the sent text, so a suggestion that happens to be an
  // 8+-character substring of the message would satisfy the guard against a box our text never
  // reached — Collie would fire the submit key and report `sent` for a message that was lost.
  //
  // The defense is that the ghost never becomes a draft at all: the adapter classifies it by STYLE
  // and returns null, so `draftCarriesSend` is never handed one to be fooled by. This drives the whole
  // guard rather than the predicate, because the predicate on its own would still say `true` here —
  // the fix has to hold at the seam that produces its argument.
  it("a faint suggestion that is a substring of the send never verifies it", async () => {
    const SENT = "fix the parser bug in the tokenizer";
    // The suggestion is a clean 14-character prefix of what we typed: it clears MIN_MATCH_CHARS and
    // matches contiguously, so nothing but the ghost classification rejects it.
    expect(draftCarriesSend(SENT, "fix the parser")).toBe(true);
    const calls = harness(
      () => `some output\n${BOX_RULE}\n❯ \x1b[0m\x1b[2mfix the parser\x1b[0m\n${BOX_RULE}`,
    );

    const out = await sendGuardedReply({ paneId: "w1:p1", text: SENT, agent: "claude", ...instant });

    expect(out.status).toBe("stalled");
    // The text was typed (the pre-flight sees a real, typeable box — a ghost box IS one), but the
    // submit key was withheld and the caller keeps the draft.
    expect(calls).toEqual([{ text: SENT, submit: false }]);
  });

  // omp paints an inline completion suggestion after the operator's text, in its own colour. It is
  // not in the input buffer, but it IS on the row the guard reads back, so before `composerGhost`
  // (harness/omp/markers.ts) the verification could never match and EVERY send omp suggested for
  // stalled — while the message really was sitting in the box.
  it("submits on an omp pane whose composer shows an inline suggestion", async () => {
    const suggestion = "\x1b[38;2;111;115;119m to the deploy host\x1b[0m";
    const screen =
      `some output\n\x1b[38;2;74;80;88m╭── statusline ───╮\x1b[0m\n` +
      `\x1b[38;2;74;80;88m╰─ \x1b[0mship it please${suggestion}   \x1b[38;2;74;80;88m ─╯\x1b[0m`;
    const calls = harness(() => screen);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "omp",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "ship it please", submit: false },
      { text: "", submit: true, expected_prompt: "╰─ ship it please to the deploy host    ─╯" },
    ]);
  });

  // omp's `ask` tool swaps its composer for an answer editor when the operator picks `Other` or
  // presses `n` for a note. Before omp/answer-editor.ts the pre-flight saw no composer and refused,
  // and the only way through ("type anyway") typed the answer but could never verify it — so Enter
  // was withheld and the draft stayed on the phone.
  describe("omp's answer editor", () => {
    const empty = fixtureText("omp--answer-editor-empty.txt");
    const typed = fixtureText("omp--answer-editor-typed.txt");
    const composer = fixtureText("omp--fresh-idle.txt");

    it("types the answer, verifies it in the editor, then submits bound to its row", async () => {
      const calls = harness(() => (calls.length === 0 ? empty : typed));

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "a deep teal, like the sea at dusk",
        agent: "omp",
        ...instant,
      });

      expect(out).toEqual({ status: "sent" });
      expect(calls).toEqual([
        { text: "a deep teal, like the sea at dusk", submit: false },
        { text: "", submit: true, expected_prompt: expect.stringMatching(/^│ > a deep teal, like the sea at dusk +│$/) },
      ]);
    });

    // Live-probed: a raw newline SUBMITS this editor, so `line one\nline two` answered `line one` and
    // typed the rest into the composer behind it. No override can make that safe.
    it("refuses a multi-line answer before typing anything, force or not", async () => {
      const calls = harness(() => empty);

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "line one\nline two",
        agent: "omp",
        force: true,
        ...instant,
      });

      expect(out).toMatchObject({ status: "error", error: expect.stringMatching(/one line/i) });
      expect(calls).toEqual([]);
    });

    // The first read can see omp's composer, where a newline is fine, and a later read the answer
    // editor, if the operator opened it on the desktop in between. Every read that clears the text
    // to go out asks again.
    it("asks again on the read after the pre-clear sweep", async () => {
      let reads = 0;
      const calls = harness(() => (reads++ === 0 ? composer : empty));

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "line one\nline two",
        agent: "omp",
        onComposerSeen: async () => ({ ok: true as const, keysSent: true }),
        ...instant,
      });

      expect(reads).toBe(2);
      expect(out).toMatchObject({ status: "error", error: expect.stringMatching(/one line/i) });
      expect(calls).toEqual([]);
    });

    it("asks again on the read before a chunked send", async () => {
      let reads = 0;
      const calls = harness(() => (reads++ === 0 ? composer : empty));

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        // Five newlines: omp's transport plan splits this into two pastes (omp/reply-chunks.ts).
        text: "one\ntwo\nthree\nfour\nfive\nsix",
        agent: "omp",
        ...instant,
      });

      expect(reads).toBe(2);
      expect(out).toMatchObject({ status: "error", error: expect.stringMatching(/one line/i) });
      expect(calls).toEqual([]);
    });

    it("asks again on every read between chunks, and says the first one landed", async () => {
      let reads = 0;
      // The composer for the pre-flight and the chunk plan's own read, then the answer editor:
      // the operator opened it on the desktop while the first paste was in flight.
      const calls = harness(() => (reads++ < 2 ? composer : empty));

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "one\ntwo\nthree\nfour\nfive\nsix",
        agent: "omp",
        ...instant,
      });

      expect(out).toMatchObject({ status: "error", error: expect.stringMatching(/already in the pane/i), textDelivered: true });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ submit: false });
    });
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

  // #103. The refusal is the same refusal — what changes is that the caller is told WHICH screen it
  // refused at, because at a password prompt "a menu or dialog is probably up" sends the operator
  // looking for a dialog to answer and waiting for an echo that is never coming.
  it("#103: names the password prompt it refused at, and still types nothing", async () => {
    const calls = harness(() => "$ sudo systemctl restart collie\n[sudo] password for altan:");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hunter2hunter2",
      agent: "claude",
      ...instant,
    });

    expect(out).toMatchObject({
      status: "blocked",
      error: expect.stringMatching(/password prompt/i),
      noEcho: "[sudo] password for altan:",
    });
    expect(calls).toEqual([]);
  });

  it("#103: a stall at a password prompt says the text is already in the pane", async () => {
    // The path a `force` takes: the pre-flight was overridden, so the secret IS typed, and then the
    // verification can never succeed because the prompt shows nothing. The caller must hear that a
    // re-send types a SECOND copy rather than recovering a lost one.
    const calls = harness(() => "[sudo] password for altan:");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "hunter2hunter2",
      agent: "claude",
      force: true,
      ...instant,
    });

    expect(out).toMatchObject({
      status: "stalled",
      noEcho: "[sudo] password for altan:",
      error: expect.stringMatching(/already in the pane/i),
    });
    // Still no submit key — the guard's own contract is untouched by any of this.
    expect(calls).toEqual([{ text: "hunter2hunter2", submit: false }]);
  });

  it("#103: a stall on a screen the adapter still recognises is NOT called a password prompt", async () => {
    // The dangerous false positive: an agent whose last printed line happens to read "Enter
    // passphrase:" while its own input box is right there. The stall is then an ordinary one, and
    // calling it no-echo would have the UI advise pressing Enter — the #34 keystroke.
    harness(() => "[sudo] password for altan:");
    const real = registry.adapterFor("claude")!;
    // An adapter that says "my composer is right there" about the very screen the detector would
    // otherwise claim. Its draft never carries the send, so the send still stalls — the question this
    // pins is only whether the stall gets NAMED a password prompt. It must not be.
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({
      ...real,
      composerReady: () => true,
      extractInputDraft: () => null,
    });

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do the thing",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(out).not.toHaveProperty("noEcho");
    spy.mockRestore();
  }, 15000);

  it("#34: force overrides the pre-flight's refusal but still never sends the submit key blind", async () => {
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

  // The Navi stall: the /models-style overlay box holds the keyboard while the composer tail
  // stays intact, so the composer gate answers true although typing would land in the overlay's
  // filter. The pre-flight refuses on the box predicate, on the same terms as a missing composer
  // (force still overrides) — nothing is typed and Enter is never sent.
  it("refuses an overlay box the composer gate still calls a composer", async () => {
    const calls = harness(() => fixtureText("oc--slash-palette.txt"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "summarise the diff",
      agent: "opencode",
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(calls).toEqual([]);
  });

  // The companion case: the box opens AFTER the probe, while the pre-clear sweep's keys are on
  // the wire. The sweep's own re-confirming read consults the box predicate too, so the message
  // never goes out — the sweep ran, the type never happens. Reads: probe, re-confirm.
  it("refuses when the overlay box opens between the sweep and the message", async () => {
    let reads = 0;
    const idle = fixtureText("oc--fresh-idle.txt");
    const overlay = fixtureText("oc--slash-palette.txt");
    const log: string[] = [];
    const calls: Array<{ text: string; submit: boolean }> = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads++;
        return HttpResponse.json({
          paneId: "w1:p1",
          text: reads === 1 ? idle : overlay,
          truncated: false,
          revision: 1,
        });
      }),
      http.post<never, { text: string; submit: boolean }>(
        /\/api\/pane\/[^/]+\/reply$/,
        async ({ request }) => {
          const body = await request.json();
          calls.push(body);
          return HttpResponse.json({ ok: true });
        },
      ),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "summarise the diff",
      agent: "opencode",
      onComposerSeen: async () => {
        log.push("sweep");
        return { ok: true as const, keysSent: true };
      },
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(log).toEqual(["sweep"]);
    expect(calls).toEqual([]);
  });

  // The chunked-send read lands on a different screen than the probe (the operator opens the
  // box mid-plan), so it consults the box predicate too. Two chunks force the plan's own read;
  // read 1 probes the composer, read 2 plans on the overlay.
  it("refuses a chunked send when the overlay box owns the chunk-plan read", async () => {
    const real = registry.adapterFor("opencode")!;
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({
      ...real,
      replyChunks: () => ["summarise ", "the diff"],
    });
    try {
      let reads = 0;
      const idle = fixtureText("oc--fresh-idle.txt");
      const overlay = fixtureText("oc--slash-palette.txt");
      const calls = harness(() => (++reads === 1 ? idle : overlay));

      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "summarise the diff",
        agent: "opencode",
        ...instant,
      });

      expect(out.status).toBe("blocked");
      expect(calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  // `force` is the operator's deliberate "type anyway" after a `blocked`: it overrides the box
  // refusal exactly like a missing composer, the text is typed — and the verify loop still never
  // sees it in an input box, so the stall keeps the generic "that key likely landed" warning
  // rather than naming a dialog the operator already knew about. Enter stays home throughout.
  it("force overrides the overlay refusal, types, and the stall keeps the key-landed warning", async () => {
    const calls = harness(() => fixtureText("oc--slash-palette.txt"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "summarise the diff",
      agent: "opencode",
      force: true,
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(out).toMatchObject({ error: expect.stringMatching(/that key likely landed/i) });
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  // The companion case: the dialog opens AFTER typing, so the verify polls watch the text vanish
  // into it. The stall then names the dialog instead of guessing. Read 1 sees the composer
  // (pre-flight probe); every verify poll sees the permission dialog.
  it("names the dialog when the text vanishes into one mid-send", async () => {
    let reads = 0;
    const idle = fixtureText("oc--fresh-idle.txt");
    const dialog = fixtureText("oc--permission-bash.txt");
    const calls = harness(() => (++reads <= 2 ? idle : dialog));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "summarise the diff",
      agent: "opencode",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    expect(out).toMatchObject({ error: expect.stringMatching(/dialog, menu, or overlay/i) });
    expect(calls.some((c) => c.submit)).toBe(false);
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

  // A send long enough to trip Claude's paste heuristic never appears in the box as itself — the box
  // holds `[Pasted text #N +M lines]`, so the generic matcher can never see our words and the send
  // stalled forever, un-sendable, with every retry re-collapsing (.adr/0010). The adapter's
  // supplemental evidence is what closes that.
  it("submits when the box holds a paste placeholder consistent with a long multi-line send", async () => {
    const calls = harness(() => paneWithDraft("[Pasted text #3 +3 lines]"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "first line\nsecond line\nthird line\nfourth line",
      agent: "claude",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "first line\nsecond line\nthird line\nfourth line", submit: false },
      { text: "", submit: true },
    ]);
  });

  // Bare, a send this long reached Claude as ~1 KB reads and only the last one survived; that tail
  // verified, so Enter submitted it (claude/paste.ts → collapsesAsPaste). It now goes as ONE paste.
  it("types a long Claude send as one bracketed paste, then submits on its placeholder", async () => {
    const long = "a long voice note that goes on and on ".repeat(30);
    const calls = harness(() => paneWithDraft("[Pasted text #4]"));

    const out = await sendGuardedReply({ paneId: "w1:p1", text: long, agent: "claude", ...instant });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: `\x1b[200~${long}\x1b[201~`, submit: false },
      { text: "", submit: true },
    ]);
  });

  it("drops a paste marker already inside the text, so it cannot end the paste early", () => {
    expect(bracketPaste("a\x1b[201~\nb\x1b[200~")).toBe("\x1b[200~a\nb\x1b[201~");
  });

  it("strips until stable: removing an inner marker cannot assemble a new one", () => {
    expect(bracketPaste("\x1b[2\x1b[201~01~tail\nrm -rf")).toBe("\x1b[200~tail\nrm -rf\x1b[201~");
  });

  it("strips a start marker nested inside a start marker", () => {
    expect(bracketPaste("\x1b[20\x1b[200~0~body")).toBe("\x1b[200~body\x1b[201~");
  });

  it("strips the 8-bit CSI form, alone and mixed with the 7-bit form", () => {
    expect(bracketPaste("a\x9b201~b\x9b200~c")).toBe("\x1b[200~abc\x1b[201~");
    expect(bracketPaste("\x9b2\x1b[201~01~x")).toBe("\x1b[200~x\x1b[201~");
    expect(bracketPaste("\x1b[2\x9b201~01~x")).toBe("\x1b[200~x\x1b[201~");
  });

  it("frames an empty body when the text is only markers", () => {
    expect(bracketPaste("\x1b[200~\x1b[201~\x9b200~\x9b201~")).toBe("\x1b[200~\x1b[201~");
    expect(bracketPaste("\x1b[20\x1b[201~0~")).toBe("\x1b[200~\x1b[201~");
  });

  it("leaves every other byte alone, other escape sequences and newlines included", () => {
    const text = "line\n\x1b[31mred\x1b[0m\t\x1b[202~ \x9b1m end\r\n";
    expect(bracketPaste(text)).toBe(`\x1b[200~${text}\x1b[201~`);
  });

  it("never lets a marker survive between the outer pair, over random interleavings", () => {
    const fragments = ["\x1b", "\x1b[", "\x1b[2", "\x1b[20", "\x1b[200", "\x1b[201", "\x1b[200~", "\x1b[201~", "\x9b", "\x9b2", "\x9b20", "\x9b200", "\x9b201", "\x9b200~", "\x9b201~", "2", "0", "1", "~", "[", "x", "\n"];
    let seed = 0x2f6e2b1;
    const rand = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let i = 0; i < 400; i++) {
      let text = "";
      for (let k = 1 + rand(14); k > 0; k--) text += fragments[rand(fragments.length)]!;
      const framed = bracketPaste(text);
      expect(framed.startsWith("\x1b[200~")).toBe(true);
      expect(framed.endsWith("\x1b[201~")).toBe(true);
      const inner = framed.slice("\x1b[200~".length, framed.length - "\x1b[201~".length);
      for (const marker of ["\x1b[200~", "\x1b[201~", "\x9b200~", "\x9b201~"]) expect(inner).not.toContain(marker);
    }
  });

  it("stalls on a placeholder inconsistent with what we sent — no submit key", async () => {
    // `#N` is a session counter we cannot predict, so somebody else's leftover token looks exactly
    // like ours; the line count is the only thing tying it to THIS send. 9 lines were never typed.
    const calls = harness(() => paneWithDraft("[Pasted text #7 +9 lines]"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "first line\nsecond line\nthird line\nfourth line",
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
      http.post<never, { submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        calls.push(await request.json());
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
      http.post<never, { submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
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

  // The partial-echo stall (live audit trail, 2026-09-27): the first verify read after typing
  // caught the echo one character short ("…why" without the "?"), the substring matcher accepted
  // the prefix, and the submit bound that partial row — which the bridge's exact binding check
  // then refused as not_found. Three taps, three stalls, while the text sat delivered in the box.
  // The guard must wait for the echo's tail before it binds, exactly as the per-chunk loop does.
  it("waits for the complete echo on a single-chunk send instead of binding a prefix", async () => {
    const idle = fixtureText("muse--done.txt");
    const TIP = "Start a message with ! to run a shell command yourself";
    expect(idle).toContain(TIP);
    const screen = (draft: string) => idle.replace(TIP, draft);
    const reads = [idle, screen("actually this works... why"), screen("actually this works... why?")];
    let n = 0;
    const calls = harness(() => reads[Math.min(n++, reads.length - 1)]!);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "actually this works... why?",
      agent: "muse",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
    expect(calls).toEqual([
      { text: "actually this works... why?", submit: false },
      { text: "", submit: true, expected_prompt: "❯ actually this works... why?" },
    ]);
  });
});

// The destructive pre-type work — composer.tsx's `ctrl+k` + N×Backspace sweep of a stranded input
// line — is the one thing this module sends that NOTHING downstream can withhold. Once those keys are
// on the wire they have landed in whatever owns the keyboard; the type-then-verify guard below only
// ever protects the submit key. So the sweep gets a stricter rule than the message does: it runs only
// where a live read has POSITIVELY SEEN the composer, and it is enforced by the pre-flight handing
// back a runner on that one branch rather than by any condition at the call site. These are the paths
// that used to skip the read and sweep anyway.
describe("onComposerSeen — destructive pre-type work needs positive evidence", () => {
  /** The composer's callback shape, recording rather than sending. */
  function sweep(log: string[]) {
    return async () => {
      log.push("sweep");
      return { ok: true as const, keysSent: true };
    };
  }

  it("runs after the pre-flight's read and before the first byte typed", async () => {
    const log: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        log.push("read");
        return HttpResponse.json({
          paneId: "w1:p1",
          text: paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        });
      }),
      http.post<never, { submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
        log.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(out.status).toBe("sent");
    // read → sweep → (the re-confirming read the sweep's own `keysSent` asks for) → type → submit.
    expect(log.slice(0, 4)).toEqual(["read", "sweep", "read", "type"]);
  });

  it("force: overrides the refusal, and does NOT sweep the screen that just refused", async () => {
    // `force` is armed by composer.tsx exactly when a pre-flight answered `blocked` — the one moment
    // the app has proof a dialog owns the keyboard. The retry used to make the burst the first thing
    // on the wire, into that dialog.
    const log: string[] = [];
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      force: true,
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual([]);
    expect(out.status).toBe("stalled");
    expect(calls.some((c) => c.submit)).toBe(false);
  });

  it("a pre-flight read that throws fails open for the message and closed for the keys", async () => {
    // Falling through on a transient blip is right for the text — the submit key is still withheld
    // until the text is seen. It was never right for keys nothing downstream can take back.
    const log: string[] = [];
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => HttpResponse.error()),
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => HttpResponse.json({ ok: true })),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual([]);
    expect(out.status).toBe("stalled");
  });

  it("an adapter with no composerReady never sweeps", async () => {
    // Registered (so the legacy one-shot path is off) but with no pre-flight to order anything
    // behind. "Keeps today's behaviour exactly" used to include the unordered burst; it no longer
    // does, and the text-then-verify guard is unchanged.
    const log: string[] = [];
    const real = registry.adapterFor("claude")!;
    const spy = vi.spyOn(registry, "adapterFor").mockReturnValue({ ...real, composerReady: undefined });
    try {
      const calls = harness(() => paneWithDialog);
      const out = await sendGuardedReply({
        paneId: "w1:p1",
        text: "please do not approve anything",
        agent: "claude",
        onComposerSeen: sweep(log),
        ...instant,
      });
      expect(log).toEqual([]);
      expect(out.status).toBe("stalled");
      expect(calls.some((c) => c.submit)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("re-confirms the composer between the keys and the message", async () => {
    // The ordering fix moved the sweep BETWEEN the pre-flight and the type, which widened the gap the
    // pre-flight's evidence has to cover by a key-burst RPC plus the caller's TUI settle. A dialog
    // that opens inside that window would otherwise be handed the reply — the very outcome the
    // ordering exists to prevent, one step later.
    const log: string[] = [];
    let reads = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          text: reads === 1 ? paneWithDraft("") : paneWithDialog,
          truncated: false,
          revision: reads,
        });
      }),
      http.post<never, { submit?: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
        const body = await request.json();
        log.push(body.submit ? "submit" : "type");
        return HttpResponse.json({ ok: true });
      }),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      onComposerSeen: sweep(log),
      ...instant,
    });

    expect(log).toEqual(["sweep"]); // the sweep was authorised; the message was not
    expect(out.status).toBe("blocked");
    expect(out).toMatchObject({ error: expect.stringMatching(/while its input line was being cleared/i) });
  });

  it("skips the re-confirming read when the caller put nothing on the wire", async () => {
    // The common send: no stranded draft, so the callback sends no keys and the pre-flight's read is
    // still the freshest thing there is. Paying for a second read there would be pure latency.
    let reads = 0;
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () => {
        reads += 1;
        return HttpResponse.json({
          paneId: "w1:p1",
          text: paneWithDraft("ship it please"),
          truncated: false,
          revision: 1,
        });
      }),
      http.post(/\/api\/pane\/[^/]+\/reply$/, () => HttpResponse.json({ ok: true })),
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: async () => ({ ok: true as const, keysSent: false }),
      ...instant,
    });

    expect(out.status).toBe("sent");
    expect(reads).toBe(2); // the pre-flight and the verification poll — no re-confirm in between
  });

  it("aborts with nothing typed when the pre-type work fails or throws", async () => {
    const calls = harness(() => paneWithDraft(""));

    expect(
      await sendGuardedReply({
        paneId: "w1:p1",
        text: "ship it please",
        agent: "claude",
        onComposerSeen: async () => ({ ok: false as const, error: "Couldn't clear the terminal input" }),
        ...instant,
      }),
    ).toEqual({ status: "error", error: "Couldn't clear the terminal input" });

    expect(
      await sendGuardedReply({
        paneId: "w1:p1",
        text: "ship it please",
        agent: "claude",
        onComposerSeen: async () => {
          throw new Error("network down");
        },
        ...instant,
      }),
    ).toEqual({ status: "error", error: "network down" });

    expect(calls).toEqual([]);
  });
});

// Ordering is not a freshness bound. `runPreType` existing proves a read SAW the composer; it cannot
// prove the composer is still there when the keys land, because the read's answer describes the pane
// at the moment the bridge snapshotted it and the burst goes out a whole round-trip later (capped
// only by GET_TIMEOUT_MS). Every other keystroke path in the app already solves this the same way:
// bind the write to the region it was authorised against and let the bridge re-read and 409. So the
// pre-flight hands its evidence forward, not just its permission.
describe("the pre-type work is handed the region its keys must be bound to", () => {
  const ompPane = (draft: string, below: string[] = []): string => {
    const width = 120;
    const fill = (open: string, body: string, close: string, filler: string): string =>
      open + body + filler.repeat(Math.max(0, width - open.length - body.length - close.length)) + close;
    return [
      " ✔ New session started",
      "",
      fill("╭── ", "⬢ Auto > ⑂ master ", "╮", "─"),
      fill("╰─ ", draft, " ─╯", " "),
      ...below,
    ].join("\n");
  };

  it("passes omp's own `╰─ … ─╯` row, verbatim, from the screen the pre-flight read", async () => {
    let seenRegion: string | null | undefined;
    harness(() => ompPane("leftover draft"));

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "omp",
      onComposerSeen: async ({ promptRegion }) => {
        seenRegion = promptRegion;
        return { ok: true as const, keysSent: false };
      },
      ...instant,
    });

    // The reply itself stalls here (the fake screen never echoes our text back), which is beside the
    // point: what is pinned is that the region reached the caller at all, and that it is the exact
    // line the sweep is about to erase rather than a paraphrase of it.
    expect(out.status).toBe("stalled");
    expect(seenRegion).toContain("leftover draft");
    expect(seenRegion!.startsWith("╰─ ")).toBe(true);
    expect(seenRegion!.endsWith("─╯")).toBe(true);
    // Verbatim minus trailing padding — the bridge compares normalized rows, and a region we had
    // reshaped would not match the row it is meant to pin.
    expect(seenRegion).toBe(ompPane("leftover draft").split("\n")[3]!.replace(/\s+$/, ""));
  });

  it("passes null when the adapter cannot name a region, so the write stays unbound", async () => {
    // Claude's adapter has no `composerPrompt`: its prompt line sits above a statusline run and a
    // footer, i.e. too far from the tail for the bridge's binding window. Absence is the documented
    // default and keeps that path exactly as it was.
    let seenRegion: string | null | undefined = "unset";
    harness(() => paneWithDraft("ship it please"));

    await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "claude",
      onComposerSeen: async ({ promptRegion }) => {
        seenRegion = promptRegion;
        return { ok: true as const, keysSent: false };
      },
      ...instant,
    });

    expect(seenRegion).toBeNull();
  });

  it("never hands out a region for a screen it refused", async () => {
    // The runner is the permission and the region is the evidence; neither may exist without a live
    // read having positively seen the composer. A modal screen produces no runner at all.
    const log: string[] = [];
    harness(() => "╭─ Ask ─────╮\n│ Pick one  │\n╰───────────╯");

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "omp",
      onComposerSeen: async ({ promptRegion }) => {
        log.push(String(promptRegion));
        return { ok: true as const, keysSent: true };
      },
      ...instant,
    });

    expect(out.status).toBe("blocked");
    expect(log).toEqual([]);
  });
});
