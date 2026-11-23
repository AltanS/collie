import { describe, expect, it } from "vitest";

import { askDecision } from "@/test/asks-fixtures";

import type { MarkedAnswer } from "./answers-message";
import { goneWords, refusalWords, sendRequest } from "./asks-send";

function marked(over: { id: string; text?: string }): MarkedAnswer {
  return { ask: askDecision({ id: over.id }), intent: "keep", text: over.text ?? null };
}

describe("the request of a Send", () => {
  it("names each answer and carries a note only where there is one", () => {
    const request = sendRequest("rid-1", [marked({ id: "dc_a" }), marked({ id: "dc_b", text: "but not for long" })]);
    expect(request).toEqual({ rid: "rid-1", answers: [{ id: "dc_a", intent: "keep" }, { id: "dc_b", intent: "keep", text: "but not for long" }] });
  });
});

describe("the words of a refused Send", () => {
  const refused = (refusal: Parameters<typeof refusalWords>[0]["refusal"], status = 409) => refusalWords({ ok: false, status, refusal });

  it("says too long with the count, and mixed sessions", () => {
    expect(refused({ code: "too_long", over: 12 })).toEqual({ ask: null, words: "The message is 12 characters too long. Shorten a note." });
    expect(refused({ code: "mixed_sessions" }).words).toBe("These answers belong to more than one session. Nothing was sent.");
  });

  it("names the machine that does not answer, or none", () => {
    expect(refused({ code: "not_answering", machine: "workshop" }).words).toBe("workshop is not answering. Nothing was sent.");
    expect(refused({ code: "not_answering" }).words).toBe("The machine of the session is not answering. Nothing was sent.");
  });

  it("puts a refusal about one ask on that ask", () => {
    expect(refused({ code: "not_an_ask", id: "dc_x" })).toEqual({ ask: "dc_x", words: "Collie no longer holds this ask. Nothing was sent." });
    expect(refused({ code: "bad_answer", id: "dc_y" }).ask).toBe("dc_y");
  });

  it("says a device that may not answer, and a Send with no readable reason", () => {
    expect(refusalWords({ ok: false, status: 403, refusal: null }).words).toBe("This device may not answer.");
    expect(refusalWords({ ok: false, status: 500, refusal: null }).words).toBe("The send was not accepted. Nothing was sent.");
  });
});

describe("what an ask that closed first says", () => {
  it("words it by the state the bridge reports, never by the bridge's own reason", () => {
    expect(goneWords({ state: "answered" })).toBe("This ask was already answered.");
    expect(goneWords({ state: "undeliverable" })).toBe("The session that asked has ended, so your answer was not sent.");
    expect(goneWords({ state: "withdrawn" })).toBe("This ask closed before your answer arrived.");
    expect(goneWords({ state: null })).toBe("This ask closed before your answer arrived.");
  });
});
