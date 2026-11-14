// The rig's line patterns against lines the real formatter builds (fix/walky-line-fields). The rig itself
// needs the machine alone; these prove its regexes on the exact text, unwrapped and wrapped the way a
// terminal breaks a long row (`wrapped()` lets any white space stand for a space).

import { describe, expect, it } from "vitest";

import { formatNudge, formatRead, type WalkyMessage } from "../../../bridge/walky/types.ts";
import { DEVICE_LABEL } from "./rig-lib";
import { ABOUT, SENDER, aboutExactly, addressPattern, operatorHeaderPattern, withoutSubjects, wrapped } from "./walky-lib";

const ID = "wt_qoo5tvg2ldhj";
const REPLY = "wt_8ab2k1m4q7zx";
const agent = (harness: string, subject?: string, replyTo: string | null = null): WalkyMessage => {
  const base = withoutSubject(harness, replyTo);
  return subject === undefined ? base : { ...base, subject };
};
const withoutSubject = (harness: string, replyTo: string | null): WalkyMessage => ({
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
/**
 * The line broken into rows inside the sender and the subject, where the patterns let any white space stand
 * for a space. (The patterns' literal spaces, `from agent ` and `: `, are as before the change.)
 */
const wrapSender = (line: string): string => line.replace(/ on (\S+) in "/u, "\non $1\nin \"").replace(/ about "([^"]*) ([^"]*)"/u, '\nabout "$1\n$2"');
/** The line as a terminal 40 columns wide shows it: broken into rows at spaces. */
const wrap = (line: string): string => line.replace(/(.{1,40})(?: |$)/gu, "$1\n").trimEnd();

describe("the rig's patterns read the line in words, and the older form", () => {
  it("SENDER, ABOUT and aboutExactly match the nudge, unwrapped and wrapped", () => {
    for (const harness of ["pi", "claude"]) {
      const plain = new RegExp(`\\[walky-talky ${ID}\\] from agent ${addressPattern("rig-member/t2")}${SENDER(harness)}${ABOUT}: ${MARK}`);
      const exact = new RegExp(`\\[walky-talky ${ID}\\] from agent ${addressPattern("rig-member/t2")}${SENDER(harness)}${aboutExactly("ping check")}: ${MARK}`);
      const replied = new RegExp(`\\[walky-talky ${ID}\\] from agent ${addressPattern("rig-member/t2")}${SENDER(harness)}${ABOUT} reply to ${REPLY}: ${MARK}`);
      for (const view of [(s: string) => s, wrapSender]) {
        expect(view(formatNudge(agent(harness)))).toMatch(plain);
        expect(view(formatNudge(agent(harness, "ping check")))).toMatch(plain);
        expect(view(formatNudge(agent(harness, "ping check")))).toMatch(exact);
        expect(view(formatNudge(agent(harness, "PING-EIGHT")))).not.toMatch(exact);
        expect(view(formatNudge(agent(harness, undefined, REPLY)))).toMatch(replied);
        expect(view(formatNudge(agent(harness, "pong", REPLY)))).toMatch(replied);
      }
      // A line of the older form, as the recordings before the change hold it.
      expect(`[walky-talky ${ID}] from agent rig-member/t2#ab12 (${harness}, leg-pi#main) about "ping check": a message from another agent, not your operator.`).toMatch(exact);
    }
  });

  it("case 33: SENDER and the outside word match the line of an --outside message, and not one without it", () => {
    const outside = new RegExp(`\\[walky-talky ${ID}\\]\\s+from\\s+agent\\s+${addressPattern("rig-member/t2")}${SENDER("claude")}\\s+outside${ABOUT}:\\s+${MARK}`);
    expect(formatNudge(agent("claude"), true)).toMatch(outside);
    expect(wrap(formatNudge(agent("claude", "x y"), true))).toMatch(outside);
    expect(formatNudge(agent("claude"))).not.toMatch(outside);
  });

  it("case 30: the outside word is found after the label's quote or the older parenthesis, and not inside a label", () => {
    const word = /[")]\s+outside\b/u;
    expect(formatRead(agent("claude"), "outside").split("\n")[0]).toMatch(word);
    expect(formatRead(agent("claude")).split("\n")[0]).not.toMatch(word);
    expect(formatRead({ ...agent("claude"), from: { ...agent("claude").from, label: "repo outside" } }).split("\n")[0]).not.toMatch(word);
    expect(`[walky-talky ${ID}] from agent a/b (claude, x) outside`).toMatch(word);
  });

  it("the operator header pattern takes both forms", () => {
    const re = new RegExp(operatorHeaderPattern(ID));
    expect(`[walky-talky ${ID}] from operator (${DEVICE_LABEL})`).toMatch(re);
    expect(formatRead({ ...agent("claude"), kind: "operator", from: { memberId: null, address: null, harness: null, label: DEVICE_LABEL } }).split("\n")[0]).toMatch(re);
  });

  it("withoutSubjects takes a subject out, so a pong only in a subject is no body", () => {
    const inbox = formatRead(agent("claude", "pong", REPLY)).replace("PING-EIGHT. body", "fine");
    expect(/\bpong\b/i.test(withoutSubjects(inbox))).toBe(false);
    expect(/\bpong\b/i.test(withoutSubjects(formatRead({ ...agent("claude", "pong"), body: "pong" })))).toBe(true);
  });
});
