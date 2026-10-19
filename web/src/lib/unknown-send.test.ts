import { describe, expect, it } from "vitest";

import type { TranscriptEntry } from "@/lib/types";
import { findUnknownSendMatch, type UnknownSend } from "./unknown-send";

const AT = Date.parse("2026-10-18T12:00:00.000Z");

function pending(over: Partial<UnknownSend> = {}): UnknownSend {
  return { sentText: "hello there", draftText: "hello there", isDraft: true, at: AT, seenUserUuids: new Set(["seen-1"]), ...over };
}

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    uuid: "new-1",
    ts: "2026-10-18T12:00:05.000Z",
    role: "user",
    parts: [{ kind: "text", text: "hello there" }],
    ...over,
  };
}

describe("findUnknownSendMatch (#511)", () => {
  it("matches a new user turn with the sent text after the send", () => {
    expect(findUnknownSendMatch(pending(), [entry()])?.uuid).toBe("new-1");
  });

  it("matches however late the turn lands: manual recovery has no clock", () => {
    expect(findUnknownSendMatch(pending(), [entry({ ts: "2026-10-18T13:30:00.000Z" })])).not.toBeUndefined();
  });

  it("never matches a turn already on screen before the send", () => {
    expect(findUnknownSendMatch(pending(), [entry({ uuid: "seen-1" })])).toBeUndefined();
  });

  it("never matches a turn timestamped before the send", () => {
    expect(findUnknownSendMatch(pending(), [entry({ ts: "2026-10-18T11:59:00.000Z" })])).toBeUndefined();
  });

  it("never matches different text, an assistant turn, or an abandoned turn", () => {
    expect(findUnknownSendMatch(pending(), [entry({ parts: [{ kind: "text", text: "other words" }] })])).toBeUndefined();
    expect(findUnknownSendMatch(pending(), [entry({ role: "assistant" })])).toBeUndefined();
    expect(findUnknownSendMatch(pending(), [entry({ abandoned: true })])).toBeUndefined();
  });

  it("never text-matches a turn that carries another send's request id", () => {
    expect(findUnknownSendMatch(pending(), [entry({ requestId: "some-other-send" })])).toBeUndefined();
  });

  it("reads the turn's text parts joined, with line breaks normalised as the bridge hashes them", () => {
    const send = pending({ sentText: "first line\nsecond line" });
    const turn = entry({ parts: [{ kind: "text", text: "first line" }, { kind: "text", text: "second line" }] });
    expect(findUnknownSendMatch(send, [turn])).not.toBeUndefined();
    const crlf = entry({ parts: [{ kind: "text", text: "first line\r\nsecond line" }] });
    expect(findUnknownSendMatch(send, [crlf])).not.toBeUndefined();
  });

  it("an unparseable time never matches: no evidence, no retirement", () => {
    expect(findUnknownSendMatch(pending(), [entry({ ts: "not a time" })])).toBeUndefined();
  });
});
