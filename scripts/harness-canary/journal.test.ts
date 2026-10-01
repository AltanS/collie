// The journal half of the canary, driven by a SYNTHETIC row stream.
//
// Nothing here reads a real session and nothing here starts an agent: the rows are built in the test,
// which is the same rule spec M41/05 set when it declined recorded sessions as fixtures. `readRows`
// and `judgeJournal` are pure, so the whole gate is testable without a model turn — only the pane's
// session ref and the disk read are not, and those are the two lines `Driver.judgeOwnJournal` holds.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { claudeJournal } from "../../bridge/journal/claude";
import { canaryJournalRoots, judgeJournal, readRows, type JournalReading } from "./journal";
import type { CaseResult } from "./verdict";

// Roots are irrelevant here: `readRows` never touches the source, and that is the point of it.
const claude = claudeJournal([]);

const PROMPT = "Read the file README.md in this folder, then reply with only the token it names.";

/** Any JSON document — the same local type the journal tests declare, for the same reason. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue | undefined };

const row = (o: Record<string, JsonValue>) => JSON.stringify(o);

/** A session shaped like the one the `sends` + `journal` scenarios make: prompt, tool call, reply. */
function session(extra: readonly string[] = []): string {
  return [
    row({ type: "user", uuid: "u1", timestamp: "2026-09-30T10:00:00.000Z", message: { role: "user", content: PROMPT } }),
    row({
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-09-30T10:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/collie-canary-project/README.md" } }],
      },
    }),
    row({
      type: "user",
      uuid: "u2",
      timestamp: "2026-09-30T10:00:02.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "# canary" }] },
    }),
    row({ type: "assistant", uuid: "a2", timestamp: "2026-09-30T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }),
    ...extra,
  ].join("\n");
}

function find(cases: readonly CaseResult[], id: string): CaseResult {
  const hit = cases.find((c) => c.id === id);
  if (hit === undefined) throw new Error(`no case ${id} in ${cases.map((c) => c.id).join(", ")}`);
  return hit;
}

describe("readRows", () => {
  test("reads the turns with the adapter's own grammar and reports nothing unrecognised", () => {
    const reading = readRows(claude, session());
    expect(reading.total).toBe(3);
    expect(reading.entries.map((e) => e.role)).toEqual(["user", "assistant", "assistant"]);
    expect(reading.tally.rows.size).toBe(0);
    expect(reading.tally.parts.size).toBe(0);
  });

  test("the tool result folded onto the call, so a tool item carries its own output", () => {
    const tool = readRows(claude, session()).entries[1]?.parts[0];
    expect(tool?.kind === "tool" && tool.result?.text).toBe("# canary");
  });
});

describe("judgeJournal: the kinds", () => {
  const cases = judgeJournal(readRows(claude, session()), [PROMPT], true);

  test("every case passes on the session the scenario makes", () => {
    expect(cases.filter((c) => c.verdict !== "pass")).toEqual([]);
    expect(find(cases, "session").detail).toBe("3 turns, 0 unrecognised");
    expect(find(cases, "user-item").detail).toBe("1/1 prompts read back");
  });

  test("a user item is matched on the prompt the canary itself typed", () => {
    const other = judgeJournal(readRows(claude, session()), ["Something nobody sent"], true);
    expect(find(other, "user-item").verdict).toBe("fail");
    expect(find(other, "user-item").detail).toContain("none carrying a prompt the canary sent");
  });

  test("a prompt whose whitespace the harness re-wrapped is still found", () => {
    const wrapped = PROMPT.replace(/ /gu, "\n");
    expect(find(judgeJournal(readRows(claude, session()), [wrapped], true), "user-item").verdict).toBe("pass");
  });

  test("no tool call is never a fail: the model may answer in words", () => {
    const noTool = [
      row({ type: "user", uuid: "u1", message: { role: "user", content: PROMPT } }),
      row({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }),
    ].join("\n");
    const judged = judgeJournal(readRows(claude, noTool), [PROMPT], true);
    expect(find(judged, "tool-item").verdict).toBe("not-reached");
    expect(judged.some((c) => c.verdict === "fail")).toBe(false);
  });

  test("a missing reply fails only when the screen saw one", () => {
    const noReply = row({ type: "user", uuid: "u1", message: { role: "user", content: PROMPT } });
    expect(find(judgeJournal(readRows(claude, noReply), [PROMPT], true), "reply").verdict).toBe("fail");
    expect(find(judgeJournal(readRows(claude, noReply), [PROMPT], false), "reply").verdict).toBe("not-reached");
  });

  test("a reply ABOVE the newest prompt does not count as its answer", () => {
    const stale = [
      row({ type: "assistant", uuid: "a0", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } }),
      row({ type: "user", uuid: "u1", message: { role: "user", content: PROMPT } }),
    ].join("\n");
    expect(find(judgeJournal(readRows(claude, stale), [PROMPT], true), "reply").verdict).toBe("fail");
  });
});

describe("judgeJournal: the unknown gate", () => {
  test("a row type the vendor added fails the run and names it", () => {
    const cases = judgeJournal(readRows(claude, session([row({ type: "time-travel", uuid: "z" })])), [PROMPT], true);
    expect(find(cases, "unknown-rows").verdict).toBe("fail");
    expect(find(cases, "unknown-rows").detail).toBe("unrecognised row types time-travel (1)");
    // The kinds are still judged: a format change must not hide behind one red case.
    expect(find(cases, "user-item").verdict).toBe("pass");
  });

  test("a content block the vendor added fails on its own case", () => {
    const added = row({ type: "assistant", uuid: "a3", message: { role: "assistant", content: [{ type: "video", url: "x" }] } });
    const cases = judgeJournal(readRows(claude, session([added])), [PROMPT], true);
    expect(find(cases, "unknown-rows").verdict).toBe("pass");
    expect(find(cases, "unknown-parts").detail).toBe("unrecognised part types video (1)");
  });

  test("the rubbish a tail read produces is not a type", () => {
    const rubbish = ["", "12", "null", '"a string"', '{"type":"user","mess'];
    const cases = judgeJournal(readRows(claude, session(rubbish)), [PROMPT], true);
    expect(cases.filter((c) => c.verdict !== "pass")).toEqual([]);
  });
});

describe("judgeJournal: nothing to read is never a fail", () => {
  test("no send means no turn of this run's own", () => {
    const cases = judgeJournal(readRows(claude, session()), [], true);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.verdict).toBe("not-reached");
    expect(cases[0]?.detail).toContain("no send of this run reached the agent");
  });

  test("an unresolvable ref, and a log that parsed to no turn", () => {
    expect(judgeJournal(null, [PROMPT], true)[0]?.verdict).toBe("not-reached");
    const empty: JournalReading = { total: 0, entries: [], tally: { rows: new Map(), parts: new Map() } };
    expect(judgeJournal(empty, [PROMPT], true)[0]?.detail).toContain("read no turn");
  });

  test("a case list with nothing to read carries no gate either, so a run stays green", () => {
    for (const cases of [judgeJournal(null, [PROMPT], true), judgeJournal(readRows(claude, session()), [], false)]) {
      expect(cases.some((c) => c.verdict === "fail")).toBe(false);
    }
  });
});

// The roots are built with `join`, so they carry the host's separator: `/tmp/profile/projects` on
// POSIX and `\\tmp\\profile\\projects` on Windows. The expectations are built the same way.
describe("canaryJournalRoots", () => {
  test("a Claude profile config dir becomes a root, ahead of the default", () => {
    const roots = canaryJournalRoots({ CLAUDE_CONFIG_DIR: "/tmp/profile" }, "/home/me");
    expect(roots.claude).toEqual([join("/tmp/profile", "projects"), join("/home/me", ".claude", "projects")]);
  });

  test("without one, the bridge's own answer is used unchanged", () => {
    expect(canaryJournalRoots({}, "/home/me").claude).toEqual([join("/home/me", ".claude", "projects")]);
    expect(canaryJournalRoots({ CLAUDE_CONFIG_DIR: "" }, "/home/me").claude).toHaveLength(1);
  });

  test("a root the operator already configured is not added twice", () => {
    const configured = join("/tmp/profile", "projects");
    const env = { CLAUDE_CONFIG_DIR: "/tmp/profile", COLLIE_TRANSCRIPT_ROOT: configured };
    expect(canaryJournalRoots(env, "/home/me").claude).toEqual([configured]);
  });

  test("every harness gets a root, so no agent is silently journal-less", () => {
    const roots = canaryJournalRoots({}, "/home/me");
    for (const [agent, list] of Object.entries(roots)) expect(list.length, agent).toBeGreaterThan(0);
  });
});
