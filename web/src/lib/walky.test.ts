import { describe, expect, it } from "vitest";

import { fixtureWalkyAgent, fixtureWalkyOperator } from "@/test/handlers";

import {
  mintWalkyId,
  mirrorHeaderId,
  paneAddress,
  parseEnvelopeHeader,
  standingOf,
  stateWord,
  verifiedWord,
  walkyLog,
} from "./walky";

describe("parseEnvelopeHeader", () => {
  it("reads an agent header", () => {
    const header = "[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, collie-workspace#fix-465)";
    expect(parseEnvelopeHeader(header)).toEqual({ id: "wt_k3f9x2m8q1a0", kind: "agent", replyTo: null });
  });

  it("reads an operator header and its reply suffix", () => {
    const header = "[walky-talky wt_k3f9x2m8q1a0] from operator (phone-altan) reply to wt_8ab2c3d4e5f6";
    expect(parseEnvelopeHeader(header)).toEqual({ id: "wt_k3f9x2m8q1a0", kind: "operator", replyTo: "wt_8ab2c3d4e5f6" });
  });

  it.each([
    "hello [walky-talky wt_k3f9x2m8q1a0] from agent x (y)",
    "[walky-talky wt_SHORT] from agent x (y)",
    "[walky-talky wt_k3f9x2m8q1a0] from robot x (y)",
    "[walky-talky wt_k3f9x2m8q1a0] from agent",
    " [walky-talky wt_k3f9x2m8q1a0] from agent x (y)",
  ])("refuses %j", (line) => {
    expect(parseEnvelopeHeader(line)).toBeNull();
  });
});

describe("mirrorHeaderId", () => {
  it("finds the id behind a prompt glyph", () => {
    expect(mirrorHeaderId("❯ [walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, x)")).toBe("wt_k3f9x2m8q1a0");
    expect(mirrorHeaderId("[walky-talky wt_k3f9x2m8q1a0] from operator")).toBe("wt_k3f9x2m8q1a0");
  });

  it("accepts a row the terminal cut inside the label", () => {
    expect(mirrorHeaderId("> [walky-talky wt_k3f9x2m8q1a0] from agent blue")).toBe("wt_k3f9x2m8q1a0");
  });

  it("ignores ordinary rows, prose that quotes the header, and a bad id", () => {
    expect(mirrorHeaderId("tests are green")).toBeNull();
    expect(mirrorHeaderId("The header is [walky-talky wt_k3f9x2m8q1a0] from agent in the log")).toBeNull();
    expect(mirrorHeaderId("[walky-talky wt_K3F9X2M8Q1A0] from agent x")).toBeNull();
  });
});

describe("standingOf", () => {
  const log = walkyLog([fixtureWalkyAgent, fixtureWalkyOperator]);

  it("holds an id the list has", () => {
    expect(standingOf(log, fixtureWalkyAgent.id)).toEqual({ standing: "held", row: fixtureWalkyAgent });
  });

  it("calls an id the list lacks absent", () => {
    expect(standingOf(log, "wt_zzzzzzzzzzzz")).toEqual({ standing: "absent" });
    expect(standingOf(walkyLog([]), fixtureWalkyAgent.id)).toEqual({ standing: "absent" });
  });

  it("claims nothing when the list was not read", () => {
    expect(standingOf(null, fixtureWalkyAgent.id)).toEqual({ standing: "unchecked" });
  });
});

describe("mintWalkyId", () => {
  it("makes wt_ and twelve lowercase letters or digits, and not the same twice", () => {
    const ids = Array.from({ length: 200 }, () => mintWalkyId());
    for (const id of ids) expect(id).toMatch(/^wt_[a-z0-9]{12}$/);
    expect(new Set(ids).size).toBe(200);
  });
});

describe("paneAddress", () => {
  it("names the machine: the scope's host, else the lead, else local", () => {
    expect(paneAddress("w1:p1", { host: "minibuch" }, "bluefin")).toBe("minibuch/w1:p1");
    expect(paneAddress("w1:p1", undefined, "bluefin")).toBe("bluefin/w1:p1");
    expect(paneAddress("w1:p1", undefined, undefined)).toBe("local/w1:p1");
  });
});

describe("the words", () => {
  it("names who verified a message, and calls a local one local", () => {
    expect(verifiedWord(fixtureWalkyAgent.receipt)).toBe("verified by bluefin");
    expect(verifiedWord(fixtureWalkyOperator.receipt)).toBe("local");
    expect(verifiedWord({ ...fixtureWalkyAgent.receipt, verified: "none" })).toBe("not verified");
  });

  it("gives a refusal its reason", () => {
    expect(stateWord(fixtureWalkyOperator.receipt)).toBe("In the inbox");
    expect(stateWord({ ...fixtureWalkyAgent.receipt, state: "refused", reason: "rate limit" })).toBe("Refused: rate limit");
    expect(stateWord({ ...fixtureWalkyAgent.receipt, state: "refused" })).toBe("Refused");
  });
});
