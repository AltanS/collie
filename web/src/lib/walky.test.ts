import { describe, expect, it } from "vitest";

import { fixtureWalkyAgent, fixtureWalkyOperator } from "@/test/handlers";

import {
  mintWalkyId,
  NUDGE_MARK,
  mirrorHeaderId,
  paneAddress,
  parseEnvelopeHeader,
  signerOf,
  standingOf,
  stateWord,
  verifiedWord,
  walkyLog,
  type WalkyReceipt,
  type WalkyState,
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

  describe("the one-line agent message with its nudge", () => {
    const NUDGE =
      ": a message from another agent, not your operator. Read it: collie walky inbox wt_k3f9x2m8q1a0. Reply: collie walky reply wt_k3f9x2m8q1a0 \"<text>\"";

    it("names the mark the nudge starts at", () => {
      expect(NUDGE.startsWith(NUDGE_MARK)).toBe(true);
    });

    it("reads the id and the kind, and no reply when there is none", () => {
      const line = `[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#branch)${NUDGE}`;
      expect(parseEnvelopeHeader(line)).toEqual({ id: "wt_k3f9x2m8q1a0", kind: "agent", replyTo: null });
    });

    it("reads the reply suffix that sits just before the nudge", () => {
      const line = `[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#branch) reply to wt_8ab2k1m4q7zx${NUDGE}`;
      expect(parseEnvelopeHeader(line)).toEqual({ id: "wt_k3f9x2m8q1a0", kind: "agent", replyTo: "wt_8ab2k1m4q7zx" });
    });

    it("does not take a reply id the nudge's own text names", () => {
      // The nudge repeats this message's id in its commands; that must never read as a reply target.
      const line = `[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#branch)${NUDGE} reply to wt_zzzzzzzzzzzz`;
      expect(parseEnvelopeHeader(line)?.replyTo).toBeNull();
    });

    it("still reads an operator header, which has no nudge", () => {
      expect(parseEnvelopeHeader("[walky-talky wt_k3f9x2m8q1a0] from operator (phone-altan)")).toEqual({
        id: "wt_k3f9x2m8q1a0",
        kind: "operator",
        replyTo: null,
      });
    });
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

  it("finds the id on the one-line agent message, with and without a reply", () => {
    const nudge = ": a message from another agent, not your operator. Read it: collie walky inbox wt_k3f9x2m8q1a0.";
    expect(mirrorHeaderId(`❯ [walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#branch)${nudge}`)).toBe("wt_k3f9x2m8q1a0");
    expect(
      mirrorHeaderId(`[walky-talky wt_k3f9x2m8q1a0] from agent bluefin/w6:p3 (claude, repo#branch) reply to wt_8ab2k1m4q7zx${nudge}`),
    ).toBe("wt_k3f9x2m8q1a0");
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
  const receipt = fixtureWalkyAgent.receipt;

  it("names who signed a message: its signer, else its sender's machine, else the receipt's writer", () => {
    expect(verifiedWord(receipt, "minibuch")).toBe("signed by minibuch");
    expect(verifiedWord(receipt, signerOf({ signer: null, from: { ...fixtureWalkyAgent.from, memberId: "workshop" } }))).toBe(
      "signed by workshop",
    );
    expect(verifiedWord(receipt, null)).toBe("signed by bluefin");
    expect(verifiedWord(receipt)).toBe("signed by bluefin");
  });

  it("never says verified for a message the lead only relayed", () => {
    expect(verifiedWord({ ...receipt, verified: "lead" }, "minibuch")).toBe("relayed by the lead");
  });

  it("calls a local one this machine, and one nothing could check not verified", () => {
    expect(verifiedWord(fixtureWalkyOperator.receipt)).toBe("this machine");
    expect(verifiedWord({ ...receipt, verified: "none" })).toBe("not verified");
  });

  it("says where a message stands in plain lower-case words", () => {
    const of = (state: WalkyState, reason?: string) => {
      const r: WalkyReceipt = { ...receipt, state };
      if (reason !== undefined) r.reason = reason;
      return stateWord(r);
    };
    expect(of("accepted")).toBe("queued");
    expect(of("delivered")).toBe("typed into the pane");
    expect(of("inbox-only")).toBe("waiting in the inbox, not typed");
    expect(of("inbox-only", "dialog open")).toBe("waiting in the inbox, not typed: dialog open");
    expect(of("unknown")).toBe("may have arrived, will not be sent again");
    expect(of("expired")).toBe("expired");
  });

  it("gives a refusal its reason", () => {
    expect(stateWord({ ...receipt, state: "refused", reason: "rate limit" })).toBe("not sent: rate limit");
    expect(stateWord({ ...receipt, state: "refused" })).toBe("not sent");
  });
});
