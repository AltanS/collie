import { describe, expect, it } from "vitest";
import { parseJsonObject, type JsonObject } from "./json";
import { capSentence, isCommand, offerMode, readHeldCancelAnswer, readSend, readSendReceipts, readSendReply, readSurface, receiptLabelKey, noteKey, receiptSentence, sendNote, surfaceNote, type SendReply } from "./send-protocol";
import { STALE_SCREEN, type SendReceiptRow } from "./surface/send";
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
      queued: false,
      cause: null,
    });
  });

  it("reads the notice cause, and drops a cause it does not know", () => {
    expect(readSendReply({ receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["commit", "keys"], cause: "notice_key" })?.cause).toBe("notice_key");
    expect(readSendReply({ receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["commit", "keys"], cause: "dance" })?.cause).toBeNull();
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

  // The review's F3: the bridge's English detail is dropped for every `unconfirmed`, so the notice's own
  // sentence travels as a cause the phone translates. An answer without it keeps the generic sentence.
  it("a refusal with the notice cause says the number would answer the notice, and keeps the commit offer", () => {
    const body: JsonObject = { receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["commit", "keys"], cause: "notice_key", detail: "That message would answer the notice above the box." };
    expect(readSend(readSendReply(body)!)).toMatchObject({ clear: false, note: "noticeKey", offers: ["commit"], detail: null });
    const running: JsonObject = { receipt: { outcome: "refused", reason: "unconfirmed" }, offers: ["keys"], cause: "notice_key" };
    // No commit offered (a running turn, a Replace): the sentence names the card and the turn's end, not Type here.
    expect(readSend(readSendReply(running)!)).toMatchObject({ note: "noticeKeyHeld", offers: [], detail: null });
    expect(readSend(reply("refused", "unconfirmed", ["commit", "keys"])).note).toBe("unconfirmed");
  });

  // 2026-10-25: a box that did not take the probe, and a second read of the same rows. The phone says it in
  // its own words; the line that adds a probe character that may remain gets its own sentence.
  it("a refusal with the stale-screen cause has its own sentence, with or without the probe that may remain", () => {
    const plain: JsonObject = { receipt: { outcome: "refused", reason: "probe_failed" }, offers: ["keys"], cause: "stale_screen", detail: STALE_SCREEN };
    expect(readSend(readSendReply(plain)!)).toMatchObject({ clear: false, note: "staleScreen", detail: null });
    const probe: JsonObject = { ...plain, detail: `${STALE_SCREEN} A probe character (⌁) may remain in the box. Check the pane before you type.` };
    expect(readSend(readSendReply(probe)!)).toMatchObject({ clear: false, note: "staleScreenProbe", detail: null });
    // Without the cause a probe_failed keeps its old sentence.
    expect(readSend(reply("refused", "probe_failed", ["keys"])).note).toBe("probeFailed");
  });

  it("a Surface carries staleFrame only as true", () => {
    expect(readSurface({ revision: 3, turn: "idle", modal: "none", composer: "draft", staleFrame: true })).toEqual({ revision: 3, turn: "idle", modal: "none", composer: "draft", staleFrame: true });
    expect(readSurface({ revision: 3, turn: "idle", modal: "none", composer: "draft", staleFrame: "yes" })).toEqual({ revision: 3, turn: "idle", modal: "none", composer: "draft" });
  });

  it("a send queued behind the running turn clears the draft and says it waits for the turn; the receipt's queued is read off the wire", () => {
    const body: JsonObject = { receipt: { outcome: "sent", queued: true }, offers: [] };
    const queued = readSendReply(body)!;
    expect(queued.queued).toBe(true);
    expect(readSend(queued)).toEqual({ clear: true, note: "queued", offers: [], surface: null, detail: null, toCard: false, cap: null });
    expect(readSendReply({ receipt: { outcome: "sent", queued: "yes" }, offers: [] })!.queued).toBe(false);
    expect(reply("sent", null).queued).toBe(false);
  });

  it("a queued send whose Enter met a dialog is unknown and points to the card, with the bridge's sentence", () => {
    const read = readSend(reply("unknown", "dialog_after_enter", ["keys"], { surface: RUNNING, detail: "A dialog opened as the message went in. Check the card before you answer it." }));
    expect(read).toMatchObject({ clear: false, note: "unknown", offers: [], toCard: true, detail: "A dialog opened as the message went in. Check the card before you answer it." });
  });

  // The 2026-10-16 field case: "Collie cannot read this screen" stood twice, the phone's sentence and
  // the bridge's English under it.
  it("drops the bridge's sentence only where it repeats the phone's own, and keeps it everywhere else", () => {
    const detail = "Collie cannot read this screen. Check the pane, then tap Type here.";
    const unreadable: Surface = { revision: 1, turn: "idle", modal: "unreadable", composer: "empty" };
    expect(readSend(reply("refused", "unconfirmed", ["commit", "keys"], { surface: unreadable, detail })).detail).toBeNull();
    for (const reason of ["stale_surface", "busy", "pane_gone", "draft_present"]) {
      expect(readSend(reply("refused", reason, ["commit"], { detail: "The bridge's line." })).detail).toBeNull();
    }
    // not_free: the plain line goes, a line that names what is open stays.
    expect(readSend(reply("refused", "not_free", [], { surface: RUNNING, detail: "The input box is not free." })).detail).toBeNull();
    expect(readSend(reply("refused", "not_free", [], { surface: RUNNING, detail: "Something is open at the input box." })).detail).toBe("Something is open at the input box.");
    expect(readSend(reply("refused", "turn_running", [], { surface: RUNNING, detail: "A command waits until the turn ends." })).detail).toBe("A command waits until the turn ends.");
    expect(readSend(reply("refused", "multiline", ["keys"], { detail: "Send one line at a time." })).detail).toBe("Send one line at a time.");
    expect(readSend(reply("refused", "a_reason_from_a_newer_bridge", ["keys"], { detail: "A newer bridge's reason." })).detail).toBe("A newer bridge's reason.");
    expect(readSend(reply("unknown", "a_reason_from_a_newer_bridge", ["keys"], { detail: "A newer bridge's reason." })).detail).toBe("A newer bridge's reason.");
  });

  it("turn_running is the agent at work, its own sentence, never that the box is not free", () => {
    expect(readSend(reply("refused", "turn_running", ["keys"], { surface: RUNNING }))).toMatchObject({ clear: false, note: "agentBusy", offers: [], surface: "running" });
    expect(sendNote("refused", "turn_running")).toBe("agentBusy");
  });

  it("a discard empties the box and keeps the phone's draft", () => {
    expect(readSend(reply("discarded", null))).toMatchObject({ clear: false, note: "discarded", offers: [] });
  });

  it("each refusal gets its own sentence, bound and not_free included, and the key pad offer is not a strip button", () => {
    expect(readSend(reply("refused", "draft_present", ["append", "replace", "cancel"]))).toMatchObject({ clear: false, note: "draft", offers: ["append", "replace", "cancel"] });
    // A command onto a draft is offered Replace and Cancel only, and its sentence names only those.
    expect(readSend(reply("refused", "draft_present", ["replace", "cancel"]))).toMatchObject({ clear: false, note: "draftCommand", offers: ["replace", "cancel"] });
    // A draft the bridge found no frame for offers the key pad alone: no strip button, so the plain sentence stays.
    expect(readSend(reply("refused", "draft_present", ["keys"]))).toMatchObject({ note: "draft", offers: [] });
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

describe("a held send (M56 spec 15)", () => {
  const reply = (outcome: string) => readSendReply({ receipt: { outcome }, offers: [], detail: "The agent is working. The bridge holds it." })!;

  it("a held answer clears the draft, says held, and carries no offers, no detail and no refusal", () => {
    expect(readSend(reply("held"))).toEqual({ clear: true, note: "held", offers: [], surface: null, detail: null, toCard: false, cap: null });
  });

  it("expired and cancelled keep the draft and say so, with no offers", () => {
    expect(readSend(reply("expired"))).toMatchObject({ clear: false, note: "expired", offers: [] });
    expect(readSend(reply("cancelled"))).toMatchObject({ clear: false, note: "cancelled", offers: [] });
  });

  it("the three outcomes map to their sentence and their list label", () => {
    expect(sendNote("held", null)).toBe("held");
    expect(sendNote("expired", null)).toBe("expired");
    expect(sendNote("cancelled", null)).toBe("cancelled");
    expect(receiptLabelKey("held")).toBe("sendReceipts.outcome.held");
    expect(receiptLabelKey("expired")).toBe("sendReceipts.outcome.expired");
    expect(receiptLabelKey("cancelled")).toBe("sendReceipts.outcome.cancelled");
    const row: SendReceiptRow = { requestId: "r1abcdefgh", at: 1, mode: "send", keys: [], gapsMs: {}, harness: "codex", version: null, outcome: "expired", reason: "turn_running" };
    expect(receiptSentence(row, (key) => key)).toBe("composer.protocol.expired");
  });

  it("reads the DELETE answer field by field and refuses a body that is not one", () => {
    expect(readHeldCancelAnswer({ result: "cancelled", receipt: { outcome: "cancelled" } })).toEqual({ result: "cancelled" });
    expect(readHeldCancelAnswer({ result: "dismissed" })).toEqual({ result: "dismissed" });
    expect(readHeldCancelAnswer({ result: "refused", reason: "busy", receipt: { outcome: "sent" } })).toEqual({ result: "refused", reason: "busy", receipt: { outcome: "sent" } });
    expect(readHeldCancelAnswer({ result: "refused", reason: "busy", receipt: { outcome: "nonsense" } })).toEqual({ result: "refused", reason: "busy" });
    expect(readHeldCancelAnswer({ result: "refused", reason: "busy" })).toEqual({ result: "refused", reason: "busy" });
    expect(readHeldCancelAnswer({ result: "refused", reason: "nonsense" })).toEqual({ result: "refused" });
    expect(readHeldCancelAnswer({ result: "maybe" })).toBeNull();
    expect(readHeldCancelAnswer("<html>")).toBeNull();
    expect(readHeldCancelAnswer(undefined)).toBeNull();
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

  it("an unconfirmed refusal with no cap stays the ordinary one, its own sentence with no English under it", () => {
    const reading = readSend(readSendReply(body("unconfirmed", undefined))!);
    expect(reading).toMatchObject({ note: "unconfirmed", cap: null, detail: null });
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

  it("a queued send that Stop gave back wears Sent and says it is back in the box; `late` is read off the wire only as a known word (ADR 0122)", () => {
    const row: SendReceiptRow = { ...base, outcome: "sent", queued: true, late: "returned" };
    expect(receiptLabelKey(row.outcome)).toBe("sendReceipts.outcome.sent");
    expect(receiptSentence(row, say)).toBe("sendReceipts.returned");
    const wire = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["ctrl+q"], gapsMs: {}, harness: "omp", version: "18.6.1", queued: true };
    const rows = readSendReceipts({ receipts: [{ ...wire, late: "returned" }, { ...wire, requestId: "r2abcdefgh", late: "teleported" }] });
    expect(rows.receipts[0]?.late).toBe("returned");
    expect(rows.receipts[1] && "late" in rows.receipts[1]).toBe(false);
    expect(rows.receipts[1] && receiptSentence(rows.receipts[1], say)).toBe("sendReceipts.queued");
  });

  it("a send queued behind the turn wears Sent and says it was queued; queued is read off the wire only when true", () => {
    const row: SendReceiptRow = { ...base, outcome: "sent", queued: true };
    expect(receiptLabelKey(row.outcome)).toBe("sendReceipts.outcome.sent");
    expect(receiptSentence(row, say)).toBe("sendReceipts.queued");
    const wire = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["Enter"], gapsMs: {}, harness: "claude", version: "2.1.301" };
    const rows = readSendReceipts({ receipts: [{ ...wire, queued: true }, { ...wire, requestId: "r2abcdefgh", queued: 1 }] });
    expect(rows.receipts[0]!.queued).toBe(true);
    expect(rows.receipts[1]!.queued).toBeUndefined();
  });

  it("reads a refusal's line and Surface words off the wire, and drops words that are not whole (2026-10-17)", () => {
    const row = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"], gapsMs: {}, harness: "claude", version: "2.1.302" };
    const saw = { turn: "idle", modal: "none", composer: "empty" };
    const rows = readSendReceipts({
      receipts: [
        { ...row, detail: "The probe character changed more than the box.", saw },
        { ...row, requestId: "r2abcdefgh", detail: 7, saw: { turn: "idle", modal: "open", composer: "empty" } },
        { ...row, requestId: "r3abcdefgh", detail: "x".repeat(400) },
      ],
    });
    expect(rows.receipts[0]).toMatchObject({ detail: "The probe character changed more than the box.", saw });
    expect(rows.receipts[1]!.detail).toBeUndefined();
    expect(rows.receipts[1]!.saw).toBeUndefined();
    expect(rows.receipts[2]!.detail).toHaveLength(240);
  });

  it("reads the line of a row off the wire, and leaves out one that is empty or not a string (2026-10-21)", () => {
    const row = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["Enter"], gapsMs: {}, harness: "claude", version: "2.1.302" };
    const rows = readSendReceipts({
      receipts: [
        { ...row, line: "ok check please it's past 2pm" },
        { ...row, requestId: "r2abcdefgh", line: "" },
        { ...row, requestId: "r3abcdefgh", line: 7 },
        { ...row, requestId: "r4abcdefgh" },
      ],
    });
    expect(rows.receipts[0]!.line).toBe("ok check please it's past 2pm");
    expect(rows.receipts[1]!.line).toBeUndefined();
    expect(rows.receipts[2]!.line).toBeUndefined();
    expect(rows.receipts[3]!.line).toBeUndefined();
  });

  it("reads the reader profile and its status off the wire, and drops a status it does not know (ADR 0123)", () => {
    const row = { requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "sent", keys: ["Enter"], gapsMs: {}, harness: "claude", version: "2.1.302" };
    const rows = readSendReceipts({
      receipts: [
        { ...row, profileId: "claude@2.1", profileStatus: "verified" },
        { ...row, requestId: "r2abcdefgh", profileId: "", profileStatus: "trusted" },
        { ...row, requestId: "r3abcdefgh" },
      ],
    });
    expect(rows.receipts[0]).toMatchObject({ profileId: "claude@2.1", profileStatus: "verified" });
    expect(rows.receipts[1]!.profileId).toBeUndefined();
    expect(rows.receipts[1]!.profileStatus).toBeUndefined();
    expect(rows.receipts[2]!.profileId).toBeUndefined();
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

describe("a steer (M69)", () => {
  const reply = (outcome: string, reason?: string): SendReply => {
    const receipt: JsonObject = reason === undefined ? { outcome, keys: [] } : { outcome, reason, keys: [] };
    const read = readSendReply({ receipt, offers: [], surface: { revision: 2, turn: "running", modal: "none", composer: "empty" } });
    if (read === null) throw new Error("the wire answer was not readable");
    return read;
  };

  it("steered clears the draft and has its own sentence key, the same words as the outcome word", () => {
    const reading = readSend(reply("steered"));
    expect(reading).toMatchObject({ clear: true, note: "steered", offers: [] });
    expect(noteKey("steered")).toBe("composer.steer.steered");
    expect(receiptLabelKey("steered")).toBe("sendReceipts.outcome.steered");
  });

  it("the two refusals keep the draft and name their own sentences", () => {
    const unsupported = readSend(reply("refused", "steer_unsupported"));
    expect(unsupported).toMatchObject({ clear: false, note: "steerUnsupported" });
    expect(noteKey(unsupported.note)).toBe("composer.steer.unsupported");
    const notAllowed = readSend(reply("refused", "steer_not_allowed"));
    expect(notAllowed).toMatchObject({ clear: false, note: "steerNotAllowed" });
    expect(noteKey(notAllowed.note)).toBe("composer.steer.notAllowed");
  });

  it("Recent sends: a steered row says nothing under its label, a refused steer row says its sentence", () => {
    const base = { requestId: "req00001", at: 1, mode: "send" as const, keys: [], gapsMs: {}, harness: "pi", version: null };
    const say = (key: string) => key;
    expect(receiptSentence({ ...base, outcome: "steered" }, say)).toBeNull();
    expect(receiptSentence({ ...base, outcome: "refused", reason: "steer_not_allowed" }, say)).toBe("composer.steer.notAllowed");
    const rows = readSendReceipts({ receipts: [{ requestId: "r1abcdefgh", at: 5, mode: "send", outcome: "steered", keys: ["Enter"], gapsMs: {}, harness: "pi", version: "1.3.0" }] });
    expect(rows.receipts[0]?.outcome).toBe("steered");
  });
});
