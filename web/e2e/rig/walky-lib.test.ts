// The rig's line patterns against lines the real formatter builds (backport of fix/walky-line-fields). The
// rig itself needs the machine alone; these prove its regexes on the exact text, unwrapped and wrapped the
// way a terminal breaks a long row (`wrapped()` lets any white space stand for a space).

import { describe, expect, it } from "vitest";

import { formatNudge, formatRead, type WalkyMessage } from "../../../bridge/walky/types.ts";
import { DEVICE_LABEL } from "./rig-lib";
import { SENDER, addressPattern, nudgePattern, operatorHeaderPattern, wrapped } from "./walky-lib";

const ID = "wt_qoo5tvg2ldhj";
const REPLY = "wt_8ab2k1m4q7zx";
const agent = (harness: string, replyTo: string | null = null): WalkyMessage => ({
  v: 1,
  id: ID,
  kind: "agent",
  from: { memberId: "rig-member", address: "rig-member/t2#ab12", harness, label: "leg-pi#main" },
  to: "rig-lead/w1:p1",
  replyTo,
  at: 1_790_000_000_000,
  body: "PING-EIGHT. body",
  signer: null,
  signature: null,
});
const MARK = wrapped("a message from another agent, not your operator.");
/** The line broken into rows inside the sender, where the patterns let any white space stand for a space. */
const wrapSender = (line: string): string => line.replace(/ on (\S+) in "/u, '\non $1\nin "');

describe("the rig's patterns read the line in words, and the older form", () => {
  it("SENDER matches the nudge, unwrapped and wrapped, with and without a reply", () => {
    for (const harness of ["pi", "claude"]) {
      const plain = new RegExp(`\\[walky-talky ${ID}\\] from agent ${addressPattern("rig-member/t2")}${SENDER(harness)}: ${MARK}`);
      const replied = new RegExp(`\\[walky-talky ${ID}\\] from agent ${addressPattern("rig-member/t2")}${SENDER(harness)} reply to ${REPLY}: ${MARK}`);
      for (const view of [(s: string) => s, wrapSender]) {
        expect(view(formatNudge(agent(harness)))).toMatch(plain);
        expect(view(formatNudge(agent(harness, REPLY)))).toMatch(replied);
        expect(view(formatNudge(agent(harness)))).not.toMatch(replied);
      }
      // A line of the older form, as the recordings before the change hold it.
      expect(`[walky-talky ${ID}] from agent rig-member/t2#ab12 (${harness}, leg-pi#main): a message from another agent, not your operator.`).toMatch(plain);
    }
  });

  it("the operator header pattern takes both forms", () => {
    const re = new RegExp(operatorHeaderPattern(ID));
    expect(`[walky-talky ${ID}] from operator (${DEVICE_LABEL})`).toMatch(re);
    expect(formatRead({ ...agent("claude"), kind: "operator", from: { memberId: null, address: null, harness: null, label: DEVICE_LABEL } }).split("\n")[0]).toMatch(re);
  });
});

/** The line with ONE line break and a two-space indent put in place of the space at `at`. */
const brokenAt = (line: string, at: number): string => `${line.slice(0, at)}\n  ${line.slice(at + 1)}`;
const spaces = (line: string): number[] => [...line].flatMap((ch, i) => (ch === " " ? [i] : []));
/** The older form of a nudge line, as the recordings before the change hold it. */
const older = (harness: string, label: string, tail: string): string =>
  `[walky-talky ${ID}] from agent rig-member/t2#ab12 (${harness}, ${label})${tail}: a message from another agent, not your operator. Read it: collie walky inbox ${ID}`;

describe("nudgePattern: every case's pattern survives a line break at any space", () => {
  const from = addressPattern("rig-member/t2");
  const withLabel = (message: WalkyMessage, label: string): WalkyMessage => ({ ...message, from: { ...message.from, label } });
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ["case 8 and 19: pi's send", nudgePattern({ id: ID, from, harness: "pi" }), [formatNudge(agent("pi")), formatNudge(withLabel(agent("pi"), "leg pi#main")), older("pi", "leg pi#main", "")]],
    ["case 13: Claude's send, the id captured", nudgePattern({ id: "(wt_[a-z0-9]{12})", from, harness: "claude" }), [formatNudge(agent("claude")), older("claude", "leg-pi#main", "")]],
    ["case 8, 13 and 19: a reply", nudgePattern({ id: ID, from, harness: "claude", replyTo: REPLY }), [formatNudge(agent("claude", REPLY)), older("claude", "leg pi#main", ` reply to ${REPLY}`)]],
  ];
  for (const [name, source, lines] of cases) {
    it(`${name}: the line as it is, and broken at each of its spaces in turn`, () => {
      const re = new RegExp(source);
      expect(source).not.toMatch(/ /u);
      for (const line of lines) {
        expect(line).toMatch(re);
        for (const at of spaces(line)) expect({ at, matched: re.test(brokenAt(line, at)) }).toEqual({ at, matched: true });
      }
    });
  }

  it("the reply pattern refuses a line without the reply", () => {
    expect(formatNudge(agent("claude"))).not.toMatch(new RegExp(nudgePattern({ id: ID, from, harness: "claude", replyTo: REPLY })));
  });
});
