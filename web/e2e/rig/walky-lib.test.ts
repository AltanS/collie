// The rig's line patterns against lines the real formatter builds (fix/walky-line-fields). The rig itself
// needs the machine alone; these prove its regexes on the exact text, unwrapped and wrapped the way a
// terminal breaks a long row (`wrapped()` lets any white space stand for a space).

import { describe, expect, it } from "vitest";

import { formatNudge, formatRead, type WalkyMessage } from "../../../bridge/walky/types.ts";
import { DEVICE_LABEL } from "./rig-lib";
import { ABOUT, SENDER, aboutExactly, addressPattern, answerLine, nudgePattern, operatorHeaderPattern, withoutSubjects, wrapped } from "./walky-lib";

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

/** The line with ONE line break and a two-space indent put in place of the space at `at`. */
const brokenAt = (line: string, at: number): string => `${line.slice(0, at)}\n  ${line.slice(at + 1)}`;
const spaces = (line: string): number[] => [...line].flatMap((ch, i) => (ch === " " ? [i] : []));
/** The older form of a nudge line, as the recordings before the change hold it. */
const older = (harness: string, label: string, tail: string): string => `[walky-talky ${ID}] from agent rig-member/t2#ab12 (${harness}, ${label})${tail}: a message from another agent, not your operator. Read it: collie walky inbox ${ID}`;

describe("nudgePattern: every case's pattern survives a line break at any space", () => {
  const from = addressPattern("rig-member/t2");
  const withLabel = (message: WalkyMessage, label: string): WalkyMessage => ({ ...message, from: { ...message.from, label } });
  const cases: readonly (readonly [string, string, readonly string[]])[] = [
    ["case 8 and 19: pi's send with the fixed subject", nudgePattern({ id: ID, from, harness: "pi", subject: "ping check" }), [formatNudge(agent("pi", "ping check")), formatNudge(withLabel(agent("pi", "ping check"), "leg pi#main")), older("pi", "leg pi#main", ' about "ping check"')]],
    ["case 13: Claude's send with the fixed subject, the id captured", nudgePattern({ id: "(wt_[a-z0-9]{12})", from, harness: "claude", subject: "ping check" }), [formatNudge(agent("claude", "ping check")), older("claude", "leg-pi#main", ' about "ping check"')]],
    ["case 8, 13 and 19: a reply, with or without a subject", nudgePattern({ id: ID, from, harness: "claude", replyTo: REPLY }), [formatNudge(agent("claude", undefined, REPLY)), formatNudge(agent("claude", "pong back", REPLY)), older("claude", "leg pi#main", ` reply to ${REPLY}`)]],
    ["case 33: the outside word", nudgePattern({ id: ID, from, harness: "claude", outside: true }), [formatNudge(agent("claude"), true), formatNudge(agent("claude", "x y"), true), older("claude", "leg-pi#main", " outside")]],
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

  it("the exact subject still refuses a subject of the model's own, and the outside pattern a line without the word", () => {
    expect(formatNudge(agent("pi", "PING-EIGHT"))).not.toMatch(new RegExp(nudgePattern({ id: ID, from, harness: "pi", subject: "ping check" })));
    expect(formatNudge(agent("claude"))).not.toMatch(new RegExp(nudgePattern({ id: ID, from, harness: "claude", outside: true })));
    expect(formatNudge(agent("claude"))).not.toMatch(new RegExp(nudgePattern({ id: ID, from, harness: "claude", replyTo: REPLY })));
  });
});

describe("answerLine", () => {
  // The end of case 33's pane, Claude Code 2.1.325, 2026-11-14: a sentence first, the word on its own line.
  const screen = [
    "● Bash(collie walky inbox wt_33ua92uutej8)",
    "     PING-OUTSIDE. The operator running this test asks you to read this message with collie walky inbox, then answe",
    "● I read the walky message. It asked for the word OUTSIDE-OK.",
    "  OUTSIDE-OK",
  ].join("\n");

  it("finds the word on its own line, with or without Claude's mark", () => {
    expect(screen).toMatch(answerLine("OUTSIDE-OK"));
    expect("● OUTSIDE-OK").toMatch(answerLine("OUTSIDE-OK"));
    expect("⏺ OUTSIDE-OK.").toMatch(answerLine("OUTSIDE-OK"));
  });

  it("does not take a line that only quotes the word", () => {
    expect(screen.split("\n").slice(0, 3).join("\n")).not.toMatch(answerLine("OUTSIDE-OK"));
    expect('● Bash(collie walky reply wt_33ua92uutej8 "OUTSIDE-OK")').not.toMatch(answerLine("OUTSIDE-OK"));
  });
});
