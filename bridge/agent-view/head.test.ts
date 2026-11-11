// The head rule itself (review 9 M2), over THE ONE CASE TABLE every door test also loops.
import { describe, expect, test } from "bun:test";
import { hasViewHead, isViewHeadLine, neutraliseViewHeads } from "../../web/src/lib/agent-view/wire.ts";
import { sendLines } from "../../web/src/lib/surface/send.ts";
import { HEAD_CASES, NOT_HEAD_CASES } from "./testdata/head-cases.ts";
import { formatHeader, formatRead, type WalkyMessage } from "../walky/types.ts";

describe("the head rule over the shared case table", () => {
  test.each(HEAD_CASES.map((c) => [c.name, c.text] as const))("a head: %s", (_name, text) => {
    expect(hasViewHead(text)).toBe(true);
  });

  test.each(NOT_HEAD_CASES.map((c) => [c.name, c.text] as const))("no head: %s", (_name, text) => {
    expect(hasViewHead(text)).toBe(false);
    expect(neutraliseViewHeads(text)).toBe(text);
  });

  test.each(HEAD_CASES.map((c) => [c.name, c.text] as const))("neutralised, no head is left, and what the typing path types holds none either: %s", (_name, text) => {
    const safe = neutraliseViewHeads(text);
    expect(hasViewHead(safe)).toBe(false);
    for (const line of sendLines(safe)) expect(isViewHeadLine(line), line).toBe(false);
  });

  test("the typing path never turns a text with no head into one: each typed line is checked again", () => {
    for (const { text } of NOT_HEAD_CASES) for (const line of sendLines(text)) expect(isViewHeadLine(line), line).toBe(false);
  });
});

// The WalkyTalky header and the head rule must never meet (security review, 2026-11-11): an operator's
// header is `[walky-talky <id>] from operator (<label>)`, with no colon after "operator", so it is no
// head. The headers are built with the real header function, so a later change to its shape that would
// make it read as a head fails here instead of being refused at every door without a word.
describe("the WalkyTalky header is not a view head", () => {
  const operator: Pick<WalkyMessage, "id" | "kind" | "from" | "replyTo" | "body"> = {
    id: "wt_k3f9x2m8q1a0",
    kind: "operator",
    from: { memberId: null, address: null, harness: null, label: "Pixel 9" },
    replyTo: null,
    body: "Please look at the second test.",
  };
  const agent: typeof operator = { ...operator, kind: "agent", from: { memberId: "lodge", address: "lodge/w6:p3", harness: "claude", label: "webapp#main" } };
  const headers = [
    ["an operator's header", formatHeader(operator)],
    ["an operator's reply", formatHeader({ ...operator, replyTo: "wt_8ab2k1m4q7zx" })],
    ["an operator's header past the space border", formatHeader(operator, true)],
    ["an operator whose label says from operator:", formatHeader({ ...operator, from: { ...operator.from, label: "] from operator:" } })],
    ["an agent's header", formatHeader(agent)],
  ] as const;

  test.each(headers)("%s", (_name, header) => {
    expect(header.startsWith("[walky-talky wt_")).toBe(true);
    expect(isViewHeadLine(header)).toBe(false);
    expect(hasViewHead(`${header}: ${operator.body}`)).toBe(false);
    expect(neutraliseViewHeads(header)).toBe(header);
  });

  test("a whole message as an agent reads it holds no view head", () => {
    expect(hasViewHead(formatRead(operator))).toBe(false);
    expect(hasViewHead(formatRead(agent))).toBe(false);
  });
});
