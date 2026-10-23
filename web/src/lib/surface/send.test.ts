import { describe, expect, it } from "vitest";
import { offersFor, REQUEST_ID, reservedLead, SEND_MODES, SEND_REASONS, sendLines, takesManualSend, wsFree } from "./send";
import type { Surface } from "./surface";

describe("sendLines", () => {
  it("splits on every line break and drops trailing blank lines, keeping the empty ones in between", () => {
    expect(sendLines("one\r\ntwo\n\nthree\n\n  \n")).toEqual(["one", "two", "", "three"]);
  });

  it("cuts paste markers, turns a Tab into one space and drops every other control byte", () => {
    expect(sendLines("\u001b[200~a\tb\u0007c\u007fd\u009be\u001b[201~")).toEqual(["a bcde"]);
  });

  it("keeps every printable character, wide ones and emoji included", () => {
    expect(sendLines("Grüße ✓ 日本 🙂")).toEqual(["Grüße ✓ 日本 🙂"]);
  });
});

describe("reservedLead", () => {
  it("finds a lead after leading blanks, and nothing in the middle of the text", () => {
    expect(reservedLead("  /model", ["/", "!", "@"])).toBe("/");
    expect(reservedLead("see @file", ["/", "!", "@"])).toBeNull();
  });
});

describe("offersFor", () => {
  it("offers append, replace and cancel on a framed draft, and the key pad without a frame", () => {
    expect(offersFor("refused", "draft_present", true)).toEqual(["append", "replace", "cancel"]);
    expect(offersFor("refused", "draft_present", false)).toEqual(["keys"]);
  });

  it("offers a command onto a framed draft Replace and Cancel only, and the key pad without a frame", () => {
    expect(offersFor("refused", "draft_present", true, true)).toEqual(["replace", "cancel"]);
    expect(offersFor("refused", "draft_present", false, true)).toEqual(["keys"]);
  });

  it("offers submit and discard on every typed_not_submitted, with a frame or without", () => {
    expect(offersFor("typed_not_submitted", "changed", true)).toEqual(["submit", "discard", "keys"]);
    expect(offersFor("typed_not_submitted", "changed", false)).toEqual(["submit", "discard", "keys"]);
    expect(offersFor("typed_not_submitted", "mismatch", false)).toEqual(["submit", "discard", "keys"]);
  });

  it("offers the commit tap on unconfirmed, nothing after a send", () => {
    expect(offersFor("refused", "unconfirmed", false)).toEqual(["commit", "keys"]);
    expect(offersFor("sent", undefined, true)).toEqual([]);
  });
});

describe("the closed lists", () => {
  it("a request id names a file only when it is a plain token", () => {
    expect(REQUEST_ID.test("a1b2c3d4-e5f6")).toBe(true);
    expect(REQUEST_ID.test("../../x")).toBe(false);
    expect(REQUEST_ID.test("short")).toBe(false);
  });

  it("no reason appears twice", () => {
    expect(new Set(SEND_REASONS).size).toBe(SEND_REASONS.length);
  });

  it("wsFree removes every white-space character", () => {
    expect(wsFree(" a b\n c\t")).toBe("abc");
  });
});

describe("takesManualSend (M56 spec 06)", () => {
  const at = (over: Partial<Surface>): Surface => ({ revision: 1, turn: "unknown", modal: "unknown", composer: "unknown", ...over });

  it("opens on unknown(no-match), on a weak cue and on an unreadable overlay", () => {
    expect(takesManualSend(at({ reason: "no-match" }))).toBe(true);
    expect(takesManualSend(at({ turn: "idle", composer: "empty" }))).toBe(true);
    expect(takesManualSend(at({ modal: "unreadable" }))).toBe(true);
    expect(takesManualSend(at({ turn: "idle", modal: "unreadable", composer: "empty" }))).toBe(true);
  });

  it("stays closed on a free box, an ask, a draft, a running turn, a box out of reach, and a read that is stale, torn or contested", () => {
    expect(takesManualSend(at({ turn: "idle", modal: "none", composer: "empty" }))).toBe(false);
    expect(takesManualSend(at({ modal: { ask: { id: "a", kind: "menu", options: [], channel: "keys", hash: "h" } } }))).toBe(false);
    expect(takesManualSend(at({ composer: "draft" }))).toBe(false);
    expect(takesManualSend(at({ turn: "running", modal: "unreadable" }))).toBe(false);
    expect(takesManualSend(at({ composer: "unreachable" }))).toBe(false);
    for (const reason of ["stale", "torn", "contested"] as const) expect(takesManualSend(at({ reason }))).toBe(false);
  });

  it("the modes include command, for a text with a reserved lead", () => {
    expect(SEND_MODES).toContain("command");
  });
});
