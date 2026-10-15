import { describe, expect, it } from "vitest";
import { offersFor, REQUEST_ID, reservedLead, SEND_REASONS, sendLines, wsFree } from "./send";

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

  it("offers submit and discard only on a framed typed_not_submitted", () => {
    expect(offersFor("typed_not_submitted", "changed", true)).toEqual(["submit", "discard", "keys"]);
    expect(offersFor("typed_not_submitted", "changed", false)).toEqual(["keys"]);
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
