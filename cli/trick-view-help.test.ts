import { describe, expect, test } from "bun:test";

import { viewHelp, viewScopeLine } from "./trick-view.ts";
import { framedRulesLines, rulesIdOf, viewHelpWithRules, viewRulesIdOf, viewRulesSource, VIEW_FRAME } from "./trick-view-help.ts";

// The help a session gets for one trick's agent view (cli/trick-view-help.ts): Collie's core help, then the
// trick's own rules between two frame lines, and the rules id, a hash of every rule text an agent is given.
// The old Morph skill template and its render are gone, so their tests are gone with them.

const BIN = "/home/op/apps/collie/bin/collie";
const T = "morph";
const RULES = "Draw one calm screen.\nKeep it short.\nNo emoji.\n";

describe("the frame", () => {
  test("is three heavy horizontal box characters, never ASCII", () => {
    expect(VIEW_FRAME).toBe("━━━");
    expect(VIEW_FRAME).toHaveLength(3);
    expect(/^[\x20-\x7e]*$/u.test(VIEW_FRAME)).toBe(false);
  });
});

describe("framedRulesLines", () => {
  test("the length line says how many lines the rules have, and names the frame", () => {
    const lines = framedRulesLines(T, RULES);
    expect(lines[0]).toContain(`The rules of the trick "${T}" follow: 3 lines`);
    expect(lines[0]).toContain(`start with ${VIEW_FRAME}`);
  });

  test("one line is `1 line`, not `1 lines`", () => {
    expect(framedRulesLines(T, "Only one.\n")[0]).toContain("follow: 1 line,");
    expect(framedRulesLines(T, "Only one.")[0]).toContain("follow: 1 line,");
  });

  test("the two frame lines start with the frame, name the trick, and hold the rules between them as written", () => {
    const lines = framedRulesLines(T, RULES);
    const frames = lines.filter((line) => line.startsWith(VIEW_FRAME));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toContain("begin");
    expect(frames[1]).toContain("end");
    for (const frame of frames) expect(frame).toContain(`the rules of the trick "${T}"`);
    const open = lines.indexOf(frames[0]!);
    const close = lines.indexOf(frames[1]!);
    expect(lines.slice(open + 1, close)).toEqual(["Draw one calm screen.", "Keep it short.", "No emoji."]);
  });

  test("a blank line inside the rules stays, and only the last empty piece is dropped", () => {
    const lines = framedRulesLines(T, "One.\n\nTwo.\n");
    const open = lines.findIndex((line) => line.startsWith(VIEW_FRAME));
    const close = lines.findLastIndex((line) => line.startsWith(VIEW_FRAME));
    expect(lines.slice(open + 1, close)).toEqual(["One.", "", "Two."]);
    expect(lines[0]).toContain("follow: 3 lines");
  });

  test("ends with Collie's own sentences: its rules still hold, and the scope line", () => {
    const lines = framedRulesLines(T, RULES);
    expect(lines.at(-2)).toBe("Collie's rules above still hold where the trick's rules say otherwise.");
    expect(lines.at(-1)).toBe(viewScopeLine(T));
  });
});

describe("viewHelpWithRules", () => {
  test("is the core help for the session and the id, then the binary, then the framed rules", () => {
    const rulesId = viewRulesIdOf(T, RULES);
    const lines = viewHelpWithRules({ binary: BIN, trick: T, session: "local/%1#aaaa", rules: RULES, rulesId });
    const core = viewHelp({ trick: T, session: "local/%1#aaaa", rulesId });
    expect(lines.slice(0, core.length)).toEqual(core);
    expect(lines.slice(core.length)).toEqual(["", `Collie on this machine: ${BIN}`, "", ...framedRulesLines(T, RULES)]);
    expect(lines.join("\n")).toContain(`--rules ${rulesId}`);
  });
});

describe("the rules id", () => {
  test("is 8 hex characters, the hash of the rules source, and the same on every call", () => {
    const id = viewRulesIdOf(T, RULES);
    expect(id).toMatch(/^[0-9a-f]{8}$/u);
    expect(id).toBe(rulesIdOf(viewRulesSource(T, RULES)));
    expect(viewRulesIdOf(T, RULES)).toBe(id);
  });

  test("differs for two rules texts and for two tricks", () => {
    const id = viewRulesIdOf(T, RULES);
    expect(viewRulesIdOf(T, `${RULES}One more rule.\n`)).not.toBe(id);
    expect(viewRulesIdOf(T, "Another text.\n")).not.toBe(id);
    expect(viewRulesIdOf("notes", RULES)).not.toBe(id);
    expect(viewRulesIdOf("notes", RULES)).toMatch(/^[0-9a-f]{8}$/u);
  });

  test("the source holds the id as a placeholder, not an id, and no session or binary", () => {
    const source = viewRulesSource(T, RULES);
    expect(source).toContain("{{VIEW_RULES_ID}}");
    expect(source).not.toContain(viewRulesIdOf(T, RULES));
    expect(source).not.toContain("<session>=");
    expect(source.endsWith(`\n${RULES}`)).toBe(true);
  });

  test("a change to a core rule changes the id", () => {
    const source = viewRulesSource(T, RULES);
    const rule = viewHelp({ trick: T }).find((line) => line.startsWith("- FIRST"))!;
    expect(source).toContain(rule);
    expect(rulesIdOf(source.replace(rule, `${rule} `))).not.toBe(viewRulesIdOf(T, RULES));
    expect(rulesIdOf(`${source}\n`)).not.toBe(viewRulesIdOf(T, RULES));
  });

  test("the help's text carries no em dash", () => {
    expect(viewHelpWithRules({ binary: BIN, trick: T, session: "local/%1#aaaa", rules: RULES, rulesId: viewRulesIdOf(T, RULES) }).join("\n")).not.toContain(String.fromCharCode(0x2014));
  });
});
