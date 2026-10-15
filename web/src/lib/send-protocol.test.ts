import { describe, expect, it } from "vitest";
import { keepsOldRoute, offerMode, readSend, readSendReply } from "./send-protocol";

describe("readSendReply", () => {
  it("reads the outcome, reason, offers and rows hash, and drops an offer it does not know", () => {
    expect(readSendReply({ receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["commit", "keys", "dance"], rowsHash: "0abc" })).toEqual({
      outcome: "refused",
      reason: "unconfirmed",
      offers: ["commit", "keys"],
      rowsHash: "0abc",
      replayed: false,
    });
  });

  it("answers null for a body that is not an answer", () => {
    expect(readSendReply("<html>")).toBeNull();
    expect(readSendReply({ receipt: {} })).toBeNull();
  });

  it("a prepare answer has no receipt: no outcome", () => {
    expect(readSendReply({ offers: [] })?.outcome).toBeNull();
  });
});

describe("readSend", () => {
  const reply = (outcome: string | null, reason: string | null, offers: string[] = []) => readSendReply({ receipt: { outcome, reason }, offers })!;

  it("only sent and effective clear the draft", () => {
    expect(readSend(reply("sent", null))).toEqual({ clear: true, note: "sent", offers: [] });
    expect(readSend(reply("effective", null)).clear).toBe(true);
    expect(readSend(reply("unknown", "bound")).clear).toBe(false);
  });

  it("a discard empties the box and keeps the phone's draft", () => {
    expect(readSend(reply("sent", "discarded"))).toEqual({ clear: false, note: "discarded", offers: [] });
  });

  it("each refusal gets its own sentence, and the key pad offer is not a strip button", () => {
    expect(readSend(reply("refused", "draft_present", ["append", "replace", "cancel"]))).toEqual({ clear: false, note: "draft", offers: ["append", "replace", "cancel"] });
    expect(readSend(reply("refused", "stale_surface", ["keys"]))).toEqual({ clear: false, note: "moved", offers: [] });
    expect(readSend(reply("refused", "crash")).note).toBe("refused");
    expect(readSend(reply("typed_not_submitted", "modal_cue", ["submit", "discard", "keys"])).offers).toEqual(["submit", "discard"]);
  });
});

describe("offerMode and keepsOldRoute", () => {
  it("commit sends again as a send; cancel and keys send nothing", () => {
    expect(offerMode("commit")).toBe("send");
    expect(offerMode("replace")).toBe("replace");
    expect(offerMode("cancel")).toBeNull();
    expect(offerMode("keys")).toBeNull();
  });

  it("a reserved lead keeps the old route; a mention later in the text does not", () => {
    expect(keepsOldRoute(" /model")).toBe(true);
    expect(keepsOldRoute("@src/app.ts look here")).toBe(true);
    expect(keepsOldRoute("look at @src/app.ts")).toBe(false);
  });
});
