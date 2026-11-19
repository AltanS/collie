import { describe, expect, test } from "bun:test";

import { displayModel } from "../pane-model.ts";
import { userRequest } from "./agy.ts";
import { classifyUserText, unwrapPastes } from "./claude.ts";
import { normaliseModel } from "./claude-resets.ts";
import { extractUserQuery } from "./grok.ts";
import { asyncResultStatus } from "./pi.ts";
import { dropBracketed } from "./text.ts";

// HOSTILE JOURNAL TEXT COSTS LINEAR TIME. The bridge is one event loop: a reader that takes seconds on
// one row stops every phone and every crew member meanwhile. A journal holds what a person typed or
// pasted, what an agent printed and what a tool read from a file or a web page, so each reader that
// looks for a tag or a bracket gets the texts that make a scan go far and fail: its opening repeated
// with no close (each one a new start), its opening and a megabyte of what may follow it, and a near
// miss repeated. Going quadratic, each takes seconds to minutes at 1 MB; linear, a few milliseconds.
//
// Measured on a desktop (16 cores, load about 2): the slowest 1 MB case below takes about 6 ms and the
// 8 MB paste case about 23 ms, so a slow CI runner has more than ten times the room. The released readers: the Grok query tag grew with
// the cube of the size (8 KB took 36 s), the paste tags, the envelope tags, the task-result tag and
// the model's brackets with the square (each more than 10 s at 1 MB).

const MB = 1 << 20;
const LIMIT_MS = 250;
const fill = (unit: string, size = MB): string => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const run = (head: string, char: string, tail = ""): string => head + char.repeat(MB - head.length - tail.length) + tail;

/** The cases that ran past the limit, with their time; empty when all were in time. */
function slowCases(cases: readonly [string, () => string][], read: (text: string) => void, limit = LIMIT_MS): string[] {
  const slow: string[] = [];
  for (const [name, make] of cases) {
    const text = make();
    const t0 = performance.now();
    read(text);
    const ms = performance.now() - t0;
    if (ms > limit) slow.push(`${name}: ${ms.toFixed(0)} ms`);
  }
  return slow;
}

describe("journal readers — hostile text costs linear time", () => {
  test("grok: the user_query tag", () => {
    const cases: [string, () => string][] = [
      ["an open tag and 1 MB of blanks", () => run("<user_query>", " ")],
      ["an open tag and 1 MB of line breaks", () => run("<user_query>", "\n")],
      ["open tags repeated", () => fill("<user_query> ")],
      ["an open tag, blanks, and a close cut short", () => run("<user_query>", " ", "</user_query")],
    ];
    expect(slowCases(cases, extractUserQuery)).toEqual([]);
  });

  test("claude: the paste tags", () => {
    const cases: [string, () => string][] = [
      ["open tags repeated", () => fill('\n<pasted_content id="1">')],
      ["open tags repeated, each on its own line", () => fill('\n<pasted_content id="1">\n')],
      ["open tags with a close of another id", () => fill('\n<pasted_content id="1">\nx\n</pasted_content id="2">')],
      ["open tags, each with its own id", () => Array.from({ length: MB / 32 }, (_, i) => `\n<pasted_content id="${i.toString(16)}">`).join("")],
      ["close tags cut short, repeated", () => fill("<pasted_content </pasted_content")],
      ["a close tag and 1 MB of blanks", () => run("<pasted_content \n</pasted_content", " ")],
    ];
    expect(slowCases(cases, unwrapPastes)).toEqual([]);
  });

  test("claude: open paste tags on 8 MB, quadratic would be minutes", () => {
    expect(slowCases([["open tags repeated, 8 MB", () => fill('\n<pasted_content id="1">', 8 * MB)]], unwrapPastes, 1_000)).toEqual([]);
  });

  test("claude: the envelope tags", () => {
    const cases: [string, () => string][] = [
      ["a command with its args tag repeated", () => `<command-name>/x</command-name>${fill("<command-args>")}`],
      ["a command's name tag repeated", () => fill("<command-name>")],
      ["command output with its tag repeated", () => fill("<local-command-stdout>")],
      ["a task notification with its summary tag repeated", () => `<task-notification>${fill("<summary>")}`],
    ];
    expect(slowCases(cases, classifyUserText)).toEqual([]);
  });

  test("pi: the task-result tag", () => {
    const cases: [string, () => string][] = [
      ["tags repeated with no >", () => fill("<task-result")],
      ["a tag and 1 MB of attributes with no >", () => run("<task-result ", "a")],
      ["a longer name repeated", () => fill("<task-results>")],
      ["tags repeated, each with an id and no >", () => fill('<task-result id="j1" ')],
    ];
    expect(slowCases(cases, (text) => asyncResultStatus(text, "j1"))).toEqual([]);
  });

  test("agy: the metadata after a request", () => {
    const head = "<USER_REQUEST>\nhi\n</USER_REQUEST>\n<ADDITIONAL_METADATA>";
    const cases: [string, () => string][] = [
      ["metadata closes, each with a settings open", () => head + fill("</ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>")],
      ["metadata closes repeated", () => head + fill("</ADDITIONAL_METADATA> ")],
      ["metadata closes, each with blanks and a settings open", () => head + fill("</ADDITIONAL_METADATA>\n  <USER_SETTINGS_CHANGE>x")],
    ];
    expect(slowCases(cases, userRequest)).toEqual([]);
  });

  test("model names: brackets with no close", () => {
    const cases: [string, () => string][] = [
      ["( repeated", () => fill("(")],
      ["[ repeated", () => fill("[")],
      ["[( repeated", () => fill("[(")],
    ];
    expect(slowCases(cases, normaliseModel)).toEqual([]);
    expect(slowCases(cases, displayModel)).toEqual([]);
  });
});

describe("the tag readers keep their grammar", () => {
  test("grok: the first pair only, its inner text trimmed, an empty one is no query", () => {
    expect(extractUserQuery("<user_query> one </user_query><user_query>two</user_query>")).toBe("one");
    expect(extractUserQuery("x <user_query>\n\t a\nb \n</user_query> y")).toBe("a\nb");
    expect(extractUserQuery("<user_query> \n </user_query>")).toBeNull();
    expect(extractUserQuery("<user_query></user_query>")).toBeNull();
    expect(extractUserQuery("<user_query>no close")).toBeNull();
    expect(extractUserQuery("</user_query><user_query>a")).toBeNull();
    expect(extractUserQuery("<user_query>a<user_query>b</user_query>")).toBe("a<user_query>b");
  });

  test("claude: an open tag with no close is left, and a later paste still unwraps", () => {
    expect(unwrapPastes('<pasted_content id="1">\nopen\n<pasted_content id="2">\nB\n</pasted_content id="2">')).toBe(
      '<pasted_content id="1">\nopen\nB',
    );
  });

  test("claude: a close of another id is pasted text, the paste runs to its own close", () => {
    expect(unwrapPastes('<pasted_content id="1">\nx\n</pasted_content id="2">\ny\n</pasted_content id="1">')).toBe(
      'x\n</pasted_content id="2">\ny',
    );
  });

  test("claude: an unlabelled close ends any paste, and blanks may stand before the id", () => {
    expect(unwrapPastes('<pasted_content id="1">\nx\n</pasted_content>\ny\n</pasted_content id="1">')).toBe(
      'x\ny\n</pasted_content id="1">',
    );
    expect(unwrapPastes('<pasted_content id="1">\nx\n</pasted_content \n id="1">')).toBe("x");
  });

  test("claude: an open tag inside a paste is pasted text", () => {
    expect(unwrapPastes('<pasted_content id="1">\n<pasted_content id="2">\n</pasted_content id="1">')).toBe(
      '<pasted_content id="2">',
    );
  });

  test("agy: the request unwraps only before metadata and at most one settings block", () => {
    const req = "<USER_REQUEST>\nhi\n</USER_REQUEST>";
    expect(userRequest(`${req}\n<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>\n`)).toBe("hi");
    expect(userRequest(`${req}<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>s</USER_SETTINGS_CHANGE>`)).toBe("hi");
    expect(userRequest(`${req}<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>x`)).toBe(`${req}<ADDITIONAL_METADATA>m</ADDITIONAL_METADATA>x`);
    expect(userRequest(`${req}<ADDITIONAL_METADATA></ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>`)).toBe(
      `${req}<ADDITIONAL_METADATA></ADDITIONAL_METADATA><USER_SETTINGS_CHANGE>`,
    );
    expect(userRequest(`${req}<ADDITIONAL_METADATA></ADDITIONAL_METADATA><USER_SETTINGS_CHANGE></USER_SETTINGS_CHANGE>`)).toBe("hi");
  });

  test("brackets: each open runs to the first close after it", () => {
    expect(dropBracketed("a(b(c)d)e", "(", ")")).toBe("ad)e");
    expect(dropBracketed("a(b", "(", ")")).toBe("a(b");
    expect(dropBracketed("(x)(y)z(", "(", ")")).toBe("z(");
    expect(normaliseModel("Opus 5 (1M context)")).toBe("opus5");
    expect(displayModel("claude-opus-5[1m] (beta)")).toBe("claude-opus-5");
  });
});
