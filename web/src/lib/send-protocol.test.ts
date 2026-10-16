import { describe, expect, it } from "vitest";
import { parseJsonObject, type JsonObject } from "./json";
import { capSentence, isCommand, offerMode, readSend, readSendReceipts, readSendReply, readSurface, receiptLabelKey, receiptSentence, sendNote, surfaceNote } from "./send-protocol";
import type { SendReceiptRow } from "./surface/send";
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
    expect(readSend(reply("discarded", null))).toMatchObject({ clear: false, note: "discarded", offers: [] });
  });

  it("each refusal gets its own sentence, bound and not_free included, and the key pad offer is not a strip button", () => {
    expect(readSend(reply("refused", "draft_present", ["append", "replace", "cancel"]))).toMatchObject({ clear: false, note: "draft", offers: ["append", "replace", "cancel"] });
    expect(readSend(reply("refused", "stale_surface", ["keys"]))).toMatchObject({ clear: false, note: "moved", offers: [] });
    expect(readSend(reply("refused", "not_free")).note).toBe("notFree");
    expect(readSend(reply("refused", "bound")).note).toBe("bound");
    expect(readSend(reply("refused", "crash")).note).toBe("refused");
    expect(readSend(reply("typed_not_submitted", "modal_cue", ["submit", "discard", "keys"])).offers).toEqual(["submit", "discard"]);
  });

  it("typed_not_submitted with the person's own text in the box says Submit or discard, never that the box held a draft (send drill a6)", () => {
    const DRAFT: Surface = { revision: 4, turn: "idle", modal: "none", composer: "draft" };
    const changed = readSend(reply("typed_not_submitted", "changed", ["submit", "discard", "keys"], { surface: DRAFT }));
    expect(changed).toMatchObject({ note: "typed", surface: null, offers: ["submit", "discard"] });
    expect(readSend(reply("typed_not_submitted", "modal_cue", [], { surface: DRAFT })).surface).toBeNull();
    // Other text than was typed stands in the box: that one is a draft the person did not write.
    expect(readSend(reply("typed_not_submitted", "mismatch", [], { surface: DRAFT }))).toMatchObject({ note: "typed", surface: "draft" });
    // A refusal on a draft keeps the screen word; a typed answer with another screen keeps it too.
    expect(readSend(reply("refused", "not_free", [], { surface: DRAFT })).surface).toBe("draft");
    expect(readSend(reply("typed_not_submitted", "changed", [], { surface: MENU })).surface).toBe("askMenu");
  });

  it("a multi-line text on a pane with no profile is refused multiline: the plain refusal, and the bridge's sentence says one line at a time", () => {
    const detail = "This harness has no profile, so its newline key is unknown; send one line at a time.";
    expect(readSend(reply("refused", "multiline", ["keys"], { detail }))).toMatchObject({ note: "refused", detail, offers: [] });
  });

  it("sendNote is the one map from an outcome and its reason to a sentence key", () => {
    expect(sendNote("sent", null)).toBe("sent");
    expect(sendNote("discarded", null)).toBe("discarded");
    expect(sendNote("typed_not_submitted", "changed")).toBe("typed");
    expect(sendNote("refused", "not_free")).toBe("notFree");
    expect(sendNote("refused", "probe_failed")).toBe("probeFailed");
    expect(sendNote("refused", "multiline")).toBe("refused");
    expect(sendNote("unknown", "no_evidence")).toBe("unknown");
    expect(sendNote(null, null)).toBe("unknown");
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

describe("capSentence", () => {
  const say = (vars: { count: string; harness: string; version: string }) => `Collie could not read this screen on ${vars.harness} ${vars.version} ${vars.count} times today.`;

  it("names the harness and its version when the bridge read one", () => {
    expect(capSentence({ count: 5, limit: 5, harness: "codex", version: "0.163.0" }, say)).toBe("Collie could not read this screen on codex 0.163.0 5 times today.");
  });

  it("names the harness alone when there is no version: no dash, no double space (send drill 3, `codex -`)", () => {
    for (const version of ["-", ""]) {
      const sentence = capSentence({ count: 5, limit: 5, harness: "codex", version }, say);
      expect(sentence).toBe("Collie could not read this screen on codex 5 times today.");
      expect(sentence).not.toMatch(/ - | {2}/u);
    }
  });

  it("takes the space in front of the placeholder with it, so a word glued to it stays glued", () => {
    expect(capSentence({ count: 5, limit: 5, harness: "codex", version: "-" }, (v) => `${v.harness} ${v.version}で${v.count}`)).toBe("codexで5");
  });
});

describe("the session page's rows (send drill 3)", () => {
  const base = { requestId: "req00001", at: 1, mode: "send" as const, keys: [], gapsMs: {}, harness: "codex", version: null };
  const say = (key: string, vars?: Record<string, string>) => (vars === undefined ? key : `${key} ${JSON.stringify(vars)}`);

  it("a discard wears the Discard word and its own sentence, never Sent", () => {
    const row: SendReceiptRow = { ...base, mode: "discard", outcome: "discarded" };
    expect(receiptLabelKey(row.outcome)).toBe("composer.protocol.discard");
    expect(receiptLabelKey("sent")).toBe("sendReceipts.outcome.sent");
    expect(receiptSentence(row, say)).toBe("composer.protocol.discarded");
  });

  it("the cap's refusal reads as the cap's sentence with the receipt's numbers; a plain unconfirmed one keeps the generic sentence", () => {
    const plain: SendReceiptRow = { ...base, outcome: "refused", reason: "unconfirmed" };
    const capped: SendReceiptRow = { ...plain, cap: { count: 5, limit: 5, harness: "codex", version: "-" } };
    expect(receiptSentence(plain, say)).toBe("composer.protocol.unconfirmed");
    expect(receiptSentence(capped, say)).toBe(`composer.protocol.capConfirm ${JSON.stringify({ count: "5", harness: "codex", version: "\u0000" })}`);
    expect(receiptSentence({ ...base, outcome: "sent" }, say)).toBeNull();
  });

  it("reads the cap of a row off the wire and drops one that is not whole", () => {
    const row = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "refused", reason: "unconfirmed", keys: [], gapsMs: {}, harness: "codex", version: null };
    const rows = readSendReceipts({ receipts: [{ ...row, cap: { count: 5, limit: 5, harness: "codex", version: "-" } }, { ...row, requestId: "r2abcdefgh", cap: { count: "x" } }] });
    expect(rows.receipts[0]).toMatchObject({ cap: { count: 5, limit: 5, harness: "codex", version: "-" } });
    expect(rows.receipts[1]!.cap).toBeUndefined();
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
