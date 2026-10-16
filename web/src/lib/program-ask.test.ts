import { describe, expect, it } from "vitest";

import type { AskTapReply } from "./ask-reply";
import { answerOfAskReply, contractOptionFor, type ProgramContractAsk } from "./program-ask";
import { programContract } from "./surface/program";
import type { Ask } from "./types";

// The program's own card against the contract ask the bridge's driver publishes (M56 spec 14).

const CARD: Ask = {
  id: "pa-1",
  kind: "permission",
  toolCallId: "tc-1",
  revision: 2,
  title: "Save the file?",
  itemId: "item-1",
  tool: { name: "write", summary: "notes.md" },
  options: [
    { id: "save", label: "Save", effect: "allow" },
    { id: "always", label: "Always save", effect: "allow-always" },
    { id: "skip", label: "Don't save", effect: "deny" },
  ],
};

function contractOf(card: Ask, oldest = card.id): ProgramContractAsk {
  const shown = programContract(card)!;
  return {
    oldest,
    ask: { id: "ask-0123456789abcd", kind: shown.kind, options: shown.labels.map((label, i) => ({ id: String(i + 1), label })), channel: "program", hash: shown.hash },
  };
}

function reply(over: Partial<AskTapReply>): AskTapReply {
  return { outcome: "refused", reason: null, ask: null, surface: null, detail: null, replayed: false, ...over };
}

describe("contractOptionFor", () => {
  it("maps a tap on the oldest ask to the contract's numbered option, skipping Always allow", () => {
    const contract = contractOf(CARD);
    expect(contractOptionFor(CARD, contract, "save")).toBe("1");
    expect(contractOptionFor(CARD, contract, "skip")).toBe("2");
  });

  it("keeps Always allow on the program's route", () => {
    expect(contractOptionFor(CARD, contractOf(CARD), "always")).toBeNull();
  });

  it("keeps a later ask on the program's route, even with the same words", () => {
    expect(contractOptionFor({ ...CARD, id: "pa-2" }, contractOf(CARD), "save")).toBeNull();
  });

  it("keeps a card whose words differ from the contract ask on the program's route", () => {
    expect(contractOptionFor({ ...CARD, title: "Delete the file?" }, contractOf(CARD), "save")).toBeNull();
  });

  it("keeps a text ask, a form and a choice of several on the program's own card", () => {
    const text: Ask = { ...CARD, kind: "text", options: [] };
    const several: Ask = { ...CARD, kind: "choice", multiple: true };
    const form: Ask = { ...CARD, kind: "form", options: [] };
    const contract = contractOf(CARD);
    for (const card of [text, several, form]) expect(contractOptionFor(card, contract, "save")).toBeNull();
  });

  it("maps a one-pick choice as a question", () => {
    const choice: Ask = { ...CARD, kind: "choice", options: [{ id: "a", label: "Red" }, { id: "b", label: "Blue" }] };
    const contract = contractOf(choice);
    expect(contract.ask.kind).toBe("question");
    expect(contractOptionFor(choice, contract, "b")).toBe("2");
  });

  it("refuses a contract ask from another channel", () => {
    const contract = contractOf(CARD);
    expect(contractOptionFor(CARD, { ...contract, ask: { ...contract.ask, channel: "keys" } }, "save")).toBeNull();
  });
});

describe("answerOfAskReply", () => {
  it("sent closes the card, a replay too", () => {
    expect(answerOfAskReply(reply({ outcome: "sent" }))).toEqual({ outcome: "taken" });
    expect(answerOfAskReply(reply({ outcome: "sent", replayed: true }))).toEqual({ outcome: "taken", replayed: true });
  });

  it("a question answered or closed first is too late", () => {
    expect(answerOfAskReply(reply({ reason: "ask_answered" }))).toEqual({ outcome: "too-late" });
    expect(answerOfAskReply(reply({ reason: "ask_gone" }))).toEqual({ outcome: "too-late" });
  });

  it("a question that changed asks for a fresh tap", () => {
    expect(answerOfAskReply(reply({ reason: "ask_changed" }))).toEqual({ outcome: "stale" });
    expect(answerOfAskReply(reply({ reason: "ask_unknown" }))).toEqual({ outcome: "stale" });
  });

  it("unknown stays unknown, and another refusal shows the bridge's words", () => {
    expect(answerOfAskReply(reply({ outcome: "unknown", reason: "no_evidence" }))).toEqual({ outcome: "unknown" });
    expect(answerOfAskReply(reply({ reason: "busy", detail: "Another send runs." }))).toEqual({ outcome: "refused", detail: "Another send runs." });
  });
});
