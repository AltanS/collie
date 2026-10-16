import { describe, expect, it } from "vitest";
import { parseJsonObject, type JsonObject } from "./json";
import { isCommand, offerMode, readSend, readSendReceipts, readSendReply, readSurface, surfaceNote } from "./send-protocol";
import type { Surface } from "./surface/surface";

const RUNNING: Surface = { revision: 3, turn: "running", modal: "none", composer: "empty" };
const MENU: Surface = {
  revision: 5,
  turn: "idle",
  modal: { ask: { id: "a1", kind: "menu", options: [{ id: "1", label: "Default" }], channel: "keys", hash: "abc" } },
  composer: "unknown",
};

describe("readSendReply", () => {
  it("reads the outcome, reason, offers, rows hash, surface and detail, and drops an offer it does not know", () => {
    expect(
      readSendReply({
        receipt: { outcome: "refused", reason: "unconfirmed" },
        offers: ["commit", "keys", "dance"],
        rowsHash: "0abc",
        surface: { revision: 2, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" },
        detail: "No input box was found.",
      }),
    ).toEqual({
      outcome: "refused",
      reason: "unconfirmed",
      offers: ["commit", "keys"],
      rowsHash: "0abc",
      replayed: false,
      surface: { revision: 2, turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" },
      detail: "No input box was found.",
      cap: null,
    });
  });

  it("reads the cap's answer field by field and drops one that is not whole", () => {
    const cap = { count: 5, limit: 5, harness: "agent", version: "2.1.301" };
    expect(readSendReply({ receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["commit"], cap })?.cap).toEqual(cap);
    expect(readSendReply({ offers: [], cap: { count: 5, limit: 5, harness: "agent" } })?.cap).toBeNull();
    expect(readSendReply({ offers: [], cap: { count: -1, limit: 5, harness: "agent", version: "1" } })?.cap).toBeNull();
    expect(readSendReply({ offers: [], cap: { count: 1.5, limit: 5, harness: "agent", version: "1" } })?.cap).toBeNull();
  });

  it("answers null for a body that is not an answer", () => {
    expect(readSendReply("<html>")).toBeNull();
    expect(readSendReply({ receipt: {} })).toBeNull();
  });

  it("a prepare answer has no receipt: no outcome", () => {
    expect(readSendReply({ offers: [] })?.outcome).toBeNull();
  });
});

describe("readSurface", () => {
  it("reads every word and an ask, and refuses a shape it does not know", () => {
    expect(readSurface({ revision: 3, turn: "running", modal: "none", composer: "empty" })).toEqual(RUNNING);
    expect(readSurface(JSON.parse(JSON.stringify(MENU)))).toEqual(MENU);
    expect(readSurface({ revision: 3, turn: "dancing", modal: "none", composer: "empty" })).toBeNull();
    expect(readSurface({ revision: 3, turn: "idle", modal: { ask: { id: "x" } }, composer: "empty" })).toBeNull();
    expect(readSurface(undefined)).toBeNull();
  });

  it("surfaceNote names what owns the keyboard first", () => {
    expect(surfaceNote(MENU)).toBe("askMenu");
    expect(surfaceNote(RUNNING)).toBe("running");
    expect(surfaceNote({ revision: 1, turn: "idle", modal: "unreadable", composer: "empty" })).toBe("unreadable");
    expect(surfaceNote({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", reason: "stale" })).toBe("stale");
    expect(surfaceNote({ revision: 1, turn: "idle", modal: "none", composer: "empty" })).toBe("free");
  });
});

describe("readSend", () => {
  const reply = (outcome: string | null, reason: string | null, offers: string[] = [], extra: { surface?: Surface; detail?: string } = {}) => {
    const body: JsonObject = { receipt: { outcome, reason }, offers };
    if (extra.surface !== undefined) body.surface = parseJsonObject(JSON.stringify(extra.surface)) ?? {};
    if (extra.detail !== undefined) body.detail = extra.detail;
    return readSendReply(body)!;
  };

  it("only sent and effective clear the draft, and a cleared send says nothing about the screen", () => {
    expect(readSend(reply("sent", null))).toEqual({ clear: true, note: "sent", offers: [], surface: null, detail: null, toCard: false, cap: null });
    expect(readSend(reply("effective", null)).clear).toBe(true);
    expect(readSend(reply("unknown", "bound")).clear).toBe(false);
  });

  it("a discard empties the box and keeps the phone's draft", () => {
    expect(readSend(reply("sent", "discarded"))).toMatchObject({ clear: false, note: "discarded", offers: [] });
  });

  it("each refusal gets its own sentence, bound and not_free included, and the key pad offer is not a strip button", () => {
    expect(readSend(reply("refused", "draft_present", ["append", "replace", "cancel"]))).toMatchObject({ clear: false, note: "draft", offers: ["append", "replace", "cancel"] });
    expect(readSend(reply("refused", "stale_surface", ["keys"]))).toMatchObject({ clear: false, note: "moved", offers: [] });
    expect(readSend(reply("refused", "not_free")).note).toBe("notFree");
    expect(readSend(reply("refused", "bound")).note).toBe("bound");
    expect(readSend(reply("refused", "crash")).note).toBe("refused");
    expect(readSend(reply("typed_not_submitted", "modal_cue", ["submit", "discard", "keys"])).offers).toEqual(["submit", "discard"]);
  });

  it("passes the receipt's surface and the bridge's sentence to the person, and an ask points to the card", () => {
    const running = readSend(reply("refused", "not_free", [], { surface: RUNNING, detail: "A turn is running." }));
    expect(running).toMatchObject({ surface: "running", detail: "A turn is running.", toCard: false });
    const menu = readSend(reply("refused", "not_free", ["keys"], { surface: MENU }));
    expect(menu).toMatchObject({ surface: "askMenu", toCard: true });
    const overlay = readSend(reply("refused", "unconfirmed", ["commit"], { surface: { revision: 1, turn: "idle", modal: "unreadable", composer: "empty" } }));
    expect(overlay).toMatchObject({ note: "unconfirmed", surface: "unreadable", toCard: true, offers: ["commit"] });
  });
});

describe("the cap's extra confirm", () => {
  const CAP = { count: 5, limit: 5, harness: "agent", version: "2.1.301" };
  const body = (reason: string, cap: typeof CAP | undefined): JsonObject => {
    const out: JsonObject = { receipt: { outcome: "refused", reason }, offers: ["commit", "keys"], detail: "The bridge's own English." };
    if (cap !== undefined) out.cap = { ...cap };
    return out;
  };

  it("an unconfirmed refusal with a cap is the cap's own note, with the commit offer and none of the bridge's English", () => {
    const reading = readSend(readSendReply(body("unconfirmed", CAP))!);
    expect(reading).toMatchObject({ clear: false, note: "capConfirm", offers: ["commit"], cap: CAP, detail: null });
  });

  it("an unconfirmed refusal with no cap stays the ordinary one", () => {
    const reading = readSend(readSendReply(body("unconfirmed", undefined))!);
    expect(reading).toMatchObject({ note: "unconfirmed", cap: null, detail: "The bridge's own English." });
  });

  it("a cap on any other refusal is ignored", () => {
    expect(readSend(readSendReply(body("not_free", CAP))!)).toMatchObject({ note: "notFree", cap: null });
  });
});

describe("readSendReceipts", () => {
  it("reads the rows of the list and leaves out one that is not whole", () => {
    const rows = readSendReceipts({
      receipts: [
        { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["probe", "Backspace", "Enter"], gapsMs: { s0: 120, probe: 160, nope: 9 }, harness: "agent", version: "2.1.301" },
        { requestId: "r2abcdefgh", at: 6, mode: "send", outcome: "refused", reason: "not_free", keys: [], gapsMs: {}, harness: "agent", version: null },
        { requestId: "r3abcdefgh", at: 7, mode: "dance", outcome: "refused", keys: [], gapsMs: {}, harness: "agent" },
        "text",
      ],
    });
    expect(rows.receipts).toEqual([
      { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["probe", "Backspace", "Enter"], gapsMs: { s0: 120, probe: 160 }, harness: "agent", version: "2.1.301" },
      { requestId: "r2abcdefgh", at: 6, mode: "send", outcome: "refused", reason: "not_free", keys: [], gapsMs: {}, harness: "agent", version: null },
    ]);
  });

  it("answers an empty list for a body that is not one", () => {
    expect(readSendReceipts("<html>").receipts).toEqual([]);
    expect(readSendReceipts({ receipts: "x" }).receipts).toEqual([]);
  });
});

describe("offerMode and isCommand", () => {
  it("commit sends again as a send, or as a command for a reserved lead; cancel and keys send nothing", () => {
    expect(offerMode("commit")).toBe("send");
    expect(offerMode("commit", "/compact")).toBe("command");
    expect(offerMode("replace")).toBe("replace");
    expect(offerMode("cancel")).toBeNull();
    expect(offerMode("keys")).toBeNull();
  });

  it("a reserved lead at the start is a command; a mention later in the text is not", () => {
    expect(isCommand(" /model")).toBe(true);
    expect(isCommand("@src/app.ts look here")).toBe(true);
    expect(isCommand("look at @src/app.ts")).toBe(false);
  });
});
