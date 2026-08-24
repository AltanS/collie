import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import * as registry from "./harness/registry";
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
    http.post<never, { text: string; submit: boolean }>(/\/api\/pane\/[^/]+\/reply$/, async ({ request }) => {
      const body = await request.json();
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
    const calls = harness(
      () =>
        `some output\n\x1b[38;2;74;80;88m╭── statusline ───╮\x1b[0m\n` +
        `\x1b[38;2;74;80;88m╰─ \x1b[0mship it please${suggestion}   \x1b[38;2;74;80;88m ─╯\x1b[0m`,
    );

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "ship it please",
      agent: "omp",
      ...instant,
    });

    expect(out).toEqual({ status: "sent" });
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
