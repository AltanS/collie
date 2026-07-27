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

  it("#34: never sends the submit key when a dialog swallowed the text", async () => {
    const calls = harness(() => paneWithDialog);

    const out = await sendGuardedReply({
      paneId: "w1:p1",
      text: "please do not approve anything",
      agent: "claude",
      ...instant,
    });

    expect(out.status).toBe("stalled");
    // THE regression assertion. The old path sent Enter here, which approved the highlighted "Yes".
    expect(calls.some((c) => c.submit)).toBe(false);
    expect(calls).toEqual([{ text: "please do not approve anything", submit: false }]);
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
