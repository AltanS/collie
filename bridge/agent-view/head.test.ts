// The head rule itself (review 9 M2), over THE ONE CASE TABLE every door test also loops.
import { describe, expect, test } from "bun:test";
import { hasViewHead, isViewHeadLine, neutraliseViewHeads } from "../../web/src/lib/agent-view/wire.ts";
import { sendLines } from "../../web/src/lib/surface/send.ts";
import { HEAD_CASES, NOT_HEAD_CASES } from "./testdata/head-cases.ts";

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
