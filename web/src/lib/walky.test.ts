import { describe, expect, it } from "vitest";

import { fixtureWalkyAgent, fixtureWalkyOperator, fixtureWalkySelf, fixtureWalkySent } from "@/test/handlers";

import {
  bareAddress,
  directionOf,
  findWalkyIds,
  parseWalkyCommand,
  resultId,
  shellLineOf,
  splitWalkyIds,
  mintWalkyId,
  NUDGE_MARK,
  mirrorHeaderId,
  paneAddress,
  remoteMachineOf,
  parseEnvelopeHeader,
  signerOf,
  standingOf,
  stateWord,
  targetWord,
  verifiedWord,
  WALKY_LIST_LIMIT,
  walkyLog,
  type WalkyReceipt,
  type WalkyRow,
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

  it("claims nothing for an id a full list lacks: the bridge cut the list at the limit, and older messages are past it", () => {
    const full: WalkyRow[] = Array.from({ length: WALKY_LIST_LIMIT }, (_, i) => ({
      ...fixtureWalkyOperator,
      id: `wt_${String(i).padStart(12, "0")}`,
    }));
    const cut = walkyLog(full);
    expect(standingOf(cut, "wt_zzzzzzzzzzzz")).toEqual({ standing: "unchecked" });
    // An id the full list does hold still earns its card.
    expect(standingOf(cut, "wt_000000000007")).toMatchObject({ standing: "held" });
    // One short of the limit, the list is the whole log, and absence is a fact.
    expect(standingOf(walkyLog(full.slice(1)), "wt_zzzzzzzzzzzz")).toEqual({ standing: "absent" });
  });
});

describe("targetWord", () => {
  it("reads a broadcast's bare `all` as every machine, and leaves a real address as it is", () => {
    expect(targetWord("all")).toBe("every machine");
    expect(targetWord("bluefin/all")).toBe("bluefin/all");
    expect(targetWord("bluefin/w1:p1")).toBe("bluefin/w1:p1");
    // A token is never split off: a target that carries one is shown whole.
    expect(targetWord("bluefin/w1:p1#k3f9")).toBe("bluefin/w1:p1#k3f9");
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

  it("appends #<token> when the pane carries an instance, and sends the bare address when it does not", () => {
    expect(paneAddress("w1:p1", { host: "minibuch" }, "bluefin", "k3f9")).toBe("minibuch/w1:p1#k3f9");
    expect(paneAddress("w1:p1", undefined, "bluefin", "k3f9")).toBe("bluefin/w1:p1#k3f9");
    expect(paneAddress("w1:p1", undefined, undefined, "a0b1")).toBe("local/w1:p1#a0b1");
    expect(paneAddress("w1:p1", undefined, "bluefin", undefined)).toBe("bluefin/w1:p1");
    expect(paneAddress("w1:p1", undefined, "bluefin", "")).toBe("bluefin/w1:p1");
  });
});

describe("bareAddress", () => {
  it("drops the session token and leaves every other address as it is", () => {
    expect(bareAddress("bluefin/w1:p1#k3f9")).toBe("bluefin/w1:p1");
    expect(bareAddress("bluefin/w1:p1")).toBe("bluefin/w1:p1");
    expect(bareAddress("all")).toBe("all");
    expect(bareAddress("bluefin/all")).toBe("bluefin/all");
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

  it("reads a held message as held, with what holds it (M62 spec 02)", () => {
    expect(stateWord({ ...receipt, state: "accepted", reason: "draft present" })).toBe("held: draft present");
    expect(stateWord({ ...receipt, state: "accepted", reason: "turn running" })).toBe("held: turn running");
    expect(stateWord({ ...receipt, state: "accepted", reason: "" })).toBe("queued");
  });

  it("gives a refusal its reason", () => {
    expect(stateWord({ ...receipt, state: "refused", reason: "rate limit" })).toBe("not sent: rate limit");
    expect(stateWord({ ...receipt, state: "refused" })).toBe("not sent");
    // The bridge's words show as they are, in every translation: a replaced pane reads like a busy one.
    expect(stateWord({ ...receipt, state: "refused", reason: "pane replaced" })).toBe("not sent: pane replaced");
  });
});

describe("findWalkyIds", () => {
  it("finds each id in running text, with its place", () => {
    const text = "see wt_k3f9x2m8q1a0, then (wt_p0q9r8s7t6u5).";
    const hits = findWalkyIds(text);
    expect(hits.map((h) => h.id)).toEqual(["wt_k3f9x2m8q1a0", "wt_p0q9r8s7t6u5"]);
    expect(hits.map((h) => text.slice(h.start, h.end))).toEqual(["wt_k3f9x2m8q1a0", "wt_p0q9r8s7t6u5"]);
  });

  it("finds an id at the very start, the very end, and inside a header", () => {
    expect(findWalkyIds("wt_k3f9x2m8q1a0")).toHaveLength(1);
    expect(findWalkyIds("[walky-talky wt_k3f9x2m8q1a0] from agent x")).toHaveLength(1);
  });

  it.each([
    "wt_short",
    "wt_K3F9X2M8Q1A0",
    "wt_k3f9x2m8q1a0b",
    "xwt_k3f9x2m8q1a0",
    "wt_k3f9x2m8q1a0_",
    "wt_k3f9x2m8q1a",
    "no ids here",
    "",
  ])("finds nothing in %j", (text) => {
    expect(findWalkyIds(text)).toEqual([]);
  });

  it("is stable across calls: the global pattern keeps no position", () => {
    expect(findWalkyIds("wt_k3f9x2m8q1a0")).toHaveLength(1);
    expect(findWalkyIds("wt_k3f9x2m8q1a0")).toHaveLength(1);
  });
});

describe("splitWalkyIds", () => {
  const held = (id: string) => id === "wt_k3f9x2m8q1a0";

  it("cuts at the ids the caller accepts and leaves the rest in the text around them", () => {
    const text = "a wt_k3f9x2m8q1a0 b wt_zzzzzzzzzzzz c";
    expect(splitWalkyIds(text, held)).toEqual([
      { kind: "text", text: "a " },
      { kind: "id", id: "wt_k3f9x2m8q1a0" },
      { kind: "text", text: " b wt_zzzzzzzzzzzz c" },
    ]);
  });

  it("returns one text part when no id is accepted, and joins back to the input", () => {
    const text = "only wt_zzzzzzzzzzzz here";
    expect(splitWalkyIds(text, held)).toEqual([{ kind: "text", text }]);
    const parts = splitWalkyIds("wt_k3f9x2m8q1a0 and wt_k3f9x2m8q1a0", held);
    expect(parts.map((p) => (p.kind === "id" ? p.id : p.text)).join("")).toBe("wt_k3f9x2m8q1a0 and wt_k3f9x2m8q1a0");
  });

  it("returns no part for an empty text", () => {
    expect(splitWalkyIds("", held)).toEqual([]);
  });
});

describe("resultId", () => {
  it("reads an id that is the whole first line of a send's output", () => {
    expect(resultId("wt_k3f9x2m8q1a0\nto local/w6:p3#k3f9, claude, repo#fix\ntyped into the pane")).toBe("wt_k3f9x2m8q1a0");
    expect(resultId("wt_k3f9x2m8q1a0")).toBe("wt_k3f9x2m8q1a0");
    expect(resultId("wt_k3f9x2m8q1a0  \r\nrest")).toBe("wt_k3f9x2m8q1a0");
  });

  it.each([undefined, "", "\nwt_k3f9x2m8q1a0", "sent wt_k3f9x2m8q1a0", "wt_k3f9x2m8q1a0 sent", "wt_SHORT\nrest"])("reads nothing from %j", (output) => {
    expect(resultId(output)).toBeNull();
  });
});

describe("parseWalkyCommand", () => {
  it("reads the verb of a command that starts with collie walky", () => {
    expect(parseWalkyCommand('collie walky send local/w6:p3#k3f9 "Tests are green."')).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand('  collie   walky reply wt_k3f9x2m8q1a0 "ok"')).toEqual({ verb: "reply", id: null });
  });

  it("reads the id an inbox command names", () => {
    expect(parseWalkyCommand("collie walky inbox wt_k3f9x2m8q1a0")).toEqual({ verb: "inbox", id: "wt_k3f9x2m8q1a0" });
    expect(parseWalkyCommand("collie walky inbox wt_k3f9x2m8q1a0 --json")).toEqual({ verb: "inbox", id: "wt_k3f9x2m8q1a0" });
  });

  it("is a walky command without a card for the other forms", () => {
    expect(parseWalkyCommand("collie walky inbox")).toEqual({ verb: "inbox", id: null });
    expect(parseWalkyCommand("collie walky inbox --all")).toEqual({ verb: "inbox", id: null });
    expect(parseWalkyCommand("collie walky inbox wt_short")).toEqual({ verb: "inbox", id: null });
    expect(parseWalkyCommand("collie walky who")).toEqual({ verb: "other", id: null });
    expect(parseWalkyCommand("collie walky")).toEqual({ verb: "other", id: null });
    expect(parseWalkyCommand("collie walky status wt_k3f9x2m8q1a0")).toEqual({ verb: "other", id: null });
  });

  it("names no id on send or reply, even when the text holds one", () => {
    expect(parseWalkyCommand("collie walky send wt_k3f9x2m8q1a0 hi")).toEqual({ verb: "send", id: null });
  });

  it.each([
    "echo collie walky send x y",
    'echo "a; collie walky send x y"',
    "git commit -m 'collie walky' && ls",
    "cat notes | grep collie walky",
    "/usr/bin/collie-walky send a b",
    "xcollie walky send a b",
    "collie walkyx send a b",
    "collie walky-send a b",
    "ls collie",
    "",
  ])("is not a walky command: %j", (command) => {
    expect(parseWalkyCommand(command)).toBeNull();
  });

  it("reads the CLI named by an absolute path, as the installed skill writes it", () => {
    expect(parseWalkyCommand('/var/home/altan/.local/bin/collie walky send local/w6:p3#k3f9 "hi"')).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand("/var/home/altan/.cache/collie-lab/next-1.22/bin/collie walky who")).toEqual({ verb: "other", id: null });
    expect(parseWalkyCommand("/opt/collie/bin/collie walky inbox wt_k3f9x2m8q1a0")).toEqual({ verb: "inbox", id: "wt_k3f9x2m8q1a0" });
    expect(parseWalkyCommand("C:\\tools\\collie.exe walky send a b")).toEqual({ verb: "send", id: null });
  });

  it("reads the ~/.local/bin/collie form and a relative path", () => {
    expect(parseWalkyCommand('~/.local/bin/collie walky reply wt_k3f9x2m8q1a0 "ok"')).toEqual({ verb: "reply", id: null });
    expect(parseWalkyCommand("./bin/collie walky who")).toEqual({ verb: "other", id: null });
  });

  it("reads the command after a cd, an assignment or an env prefix", () => {
    expect(parseWalkyCommand('cd /repo && collie walky send a "x"')).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand('cd /repo; /usr/local/bin/collie walky inbox wt_k3f9x2m8q1a0')).toEqual({ verb: "inbox", id: "wt_k3f9x2m8q1a0" });
    expect(parseWalkyCommand('env COLLIE_X=1 collie walky send a "x"')).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand('COLLIE_X="a b" FOO=1 collie walky who')).toEqual({ verb: "other", id: null });
    expect(parseWalkyCommand('(cd /repo && collie walky send a "x")')).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand("export A=1\ncollie walky who")).toEqual({ verb: "other", id: null });
  });

  it("reads a body piped into send", () => {
    expect(parseWalkyCommand("git log --oneline -5 | collie walky send local/w6:p3#k3f9")).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand("git log | /home/me/.local/bin/collie walky send a")).toEqual({ verb: "send", id: null });
    expect(parseWalkyCommand("cat msg.txt | tee /tmp/x | collie walky reply wt_k3f9x2m8q1a0")).toEqual({ verb: "reply", id: null });
  });

  it("does not read a walky mention that is only an argument of another command", () => {
    expect(parseWalkyCommand("echo collie walky")).toBeNull();
    expect(parseWalkyCommand("echo collie walky send a b | cat")).toBeNull();
    expect(parseWalkyCommand("man collie walky")).toBeNull();
  });

  it("does not take the id of a longer word as the inbox id", () => {
    expect(parseWalkyCommand("collie walky inbox wt_k3f9x2m8q1a0x")).toEqual({ verb: "inbox", id: null });
  });
});

describe("shellLineOf", () => {
  it("reads the command of an execute call and the summary of an unrecognised tool", () => {
    expect(shellLineOf({ kind: "execute", command: "collie walky who" })).toBe("collie walky who");
    expect(shellLineOf({ kind: "other", summary: "collie walky send a b\nmore" })).toBe("collie walky send a b");
  });

  it("reads nothing from any other kind", () => {
    expect(shellLineOf({ kind: "read" })).toBeNull();
    expect(shellLineOf({ kind: "search", summary: "collie walky who" })).toBeNull();
    expect(shellLineOf({ kind: "execute" })).toBeNull();
  });
});

describe("directionOf", () => {
  it("reads a row this pane sent as sent: its sender is the pane and its receipt's target is another", () => {
    expect(directionOf(fixtureWalkySent, fixtureWalkySelf)).toBe("sent");
  });

  it("reads rows that reached the pane as received", () => {
    expect(directionOf(fixtureWalkyAgent, fixtureWalkySelf)).toBe("received");
    expect(directionOf(fixtureWalkyOperator, fixtureWalkySelf)).toBe("received");
  });

  it("ignores the session token on either side", () => {
    expect(directionOf(fixtureWalkySent, `${fixtureWalkySelf}#k3f9`)).toBe("sent");
    const tokened = { ...fixtureWalkySent, from: { ...fixtureWalkySent.from, address: "bluefin/w1:p1#zz99" } };
    expect(directionOf(tokened, fixtureWalkySelf)).toBe("sent");
  });

  it("reads a message the pane sent to itself as received", () => {
    const toSelf = { ...fixtureWalkySent, receipt: { ...fixtureWalkySent.receipt, target: "bluefin/w1:p1" } };
    expect(directionOf(toSelf, fixtureWalkySelf)).toBe("received");
  });

  it("reads another pane's message to a third pane as received: only the pane's own sends are sent", () => {
    expect(directionOf(fixtureWalkySent, "bluefin/w9:p9")).toBe("received");
  });

  it("reads every row as received with no pane address, or a sender with no address", () => {
    expect(directionOf(fixtureWalkySent, undefined)).toBe("received");
    expect(directionOf(fixtureWalkyOperator, fixtureWalkySelf)).toBe("received");
  });

  it("reads a broadcast receipt (`all`) from this pane as sent", () => {
    const broadcast = { ...fixtureWalkySent, receipt: { ...fixtureWalkySent.receipt, target: "all" } };
    expect(directionOf(broadcast, fixtureWalkySelf)).toBe("sent");
  });
});

describe("remoteMachineOf", () => {
  const away = { ...fixtureWalkyAgent, from: { ...fixtureWalkyAgent.from, memberId: "minibuch", address: "minibuch/w11:p4#8h9h" } };

  it("names the sender's machine when it is not the pane's own", () => {
    expect(remoteMachineOf(away, fixtureWalkySelf)).toBe("minibuch");
  });

  it("is null for the pane's own machine, with or without a token on either address", () => {
    expect(remoteMachineOf(fixtureWalkyAgent, fixtureWalkySelf)).toBeNull();
    expect(remoteMachineOf(fixtureWalkyAgent, `${fixtureWalkySelf}#aaaa`)).toBeNull();
  });

  it("is null for an operator, a solo sender, and a mount with no self", () => {
    expect(remoteMachineOf(fixtureWalkyOperator, fixtureWalkySelf)).toBeNull();
    expect(remoteMachineOf({ ...away, from: { ...away.from, memberId: null, address: null } }, fixtureWalkySelf)).toBeNull();
    expect(remoteMachineOf(away, undefined)).toBeNull();
  });
});
