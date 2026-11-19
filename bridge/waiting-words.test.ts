import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeJournal } from "./journal/claude.ts";
import type { JournalAdapter } from "./journal/types.ts";
import type { JsonObject } from "./json.ts";
import { PUSH_LINE_MAX, PUSH_TITLE_MAX } from "./mux/durable/clean.ts";
import type { AgentStatus, AgentView } from "./types.ts";
import { callWords, openCall, WaitingWords } from "./waiting-words.ts";

const SID = "1d8a30f9-fe99-4897-8c2b-0cb9b0e4d8cd";
const root = mkdtempSync(join(tmpdir(), "collie-waiting-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
const call = (id: string, name: string, input: JsonObject) =>
  JSON.stringify({ type: "assistant", uuid: uuid(), timestamp: "2026-11-14T10:00:00Z", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
const result = (id: string) =>
  JSON.stringify({ type: "user", uuid: uuid(), timestamp: "2026-11-14T10:00:01Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } });
const prompt = (text: string) =>
  JSON.stringify({ type: "user", uuid: uuid(), timestamp: "2026-11-14T10:00:02Z", message: { role: "user", content: text } });
const reply = (text: string) =>
  JSON.stringify({ type: "assistant", uuid: uuid(), timestamp: "2026-11-14T10:00:03Z", message: { role: "assistant", content: [{ type: "text", text }] } });

const claude = claudeJournal(root);
const wordsOf = (...lines: string[]) => {
  const open = openCall(claude.parse(lines.join("\n")));
  return open === undefined ? undefined : callWords(open);
};

const RESET = { command: "bun run db:migrate", description: "Run the database migrations" };
const ASK = { questions: [{ question: "Which branch should I deploy?", header: "Branch", multiSelect: false, options: [{ label: "staging" }, { label: "main" }] }] };

describe("what a blocked pane waits on", () => {
  test("a command it wants to run: its description, then the command", () => {
    expect(wordsOf(call("c1", "Bash", RESET))).toEqual({ title: "Run the database migrations", line: "bun run db:migrate" });
  });

  test("a command with no description: the command alone, as the title", () => {
    expect(wordsOf(call("c1", "Bash", { command: "git push" }))).toEqual({ title: "git push" });
  });

  test("a question: its text, then its options", () => {
    expect(wordsOf(call("q1", "AskUserQuestion", ASK))).toEqual({ title: "Which branch should I deploy?", line: "staging, main" });
  });

  test("any other call: the tool's name and the journal's gist of its input", () => {
    const words = wordsOf(call("e1", "Edit", { file_path: "/w/app/main.ts", old_string: "a", new_string: "b" }));
    expect(words?.title).toStartWith("Edit: ");
    expect(words?.title).toContain("main.ts");
  });

  test("the newest open call of the newest turn, never an answered one", () => {
    expect(wordsOf(call("c1", "Bash", { command: "ls" }), result("c1"), call("c2", "Bash", RESET))?.title).toBe(RESET.description);
    expect(wordsOf(call("c1", "Bash", RESET), result("c1"))).toBeUndefined();
  });

  test("nothing when the person or the agent spoke after the call", () => {
    expect(wordsOf(call("c1", "Bash", RESET), prompt("never mind"))).toBeUndefined();
    expect(wordsOf(call("c1", "Bash", RESET), result("c1"), reply("Done. Anything else?"))).toBeUndefined();
  });

  test("the words are one line each and cut to a durable ask's lengths", () => {
    const words = wordsOf(call("c1", "Bash", { command: `echo ${"x".repeat(300)}`, description: `Line one\nline two ${"y".repeat(100)}` }));
    expect(words?.title?.length).toBeLessThanOrEqual(PUSH_TITLE_MAX);
    expect(words?.line?.length).toBeLessThanOrEqual(PUSH_LINE_MAX);
    expect(words?.title).not.toContain("\n");
  });
});

describe("WaitingWords, on the poll", () => {
  const log = join(root, "-w-app", `${SID}.jsonl`);
  mkdirSync(join(root, "-w-app"), { recursive: true });
  const pane = (status: AgentStatus, over: Partial<AgentView> = {}): AgentView => ({
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "app",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    agentSession: { kind: "id", value: SID },
    status,
    cwd: "/w/app",
    focused: false,
    kind: "agent",
    ...over,
  });
  const registry = { claude } satisfies Record<string, JournalAdapter>;

  test("a blocked pane's words are read from its journal, and dropped once it is not blocked", async () => {
    writeFileSync(log, `${call("c1", "Bash", RESET)}\n`);
    const waiting = new WaitingWords(registry);
    await waiting.refresh([pane("blocked")]);
    expect(waiting.get("w1:p1")).toEqual({ title: RESET.description, line: RESET.command });
    await waiting.refresh([pane("working")]);
    expect(waiting.get("w1:p1")).toBeUndefined();
  });

  test("only a blocked pane is read, and an unchanged log is not read again", async () => {
    writeFileSync(log, `${call("q1", "AskUserQuestion", ASK)}\n`);
    let reads = 0;
    const waiting = new WaitingWords(registry, {
      tail: async (source, ref, bytes) => {
        reads++;
        const { probeTail } = await import("./journal/cache-probe.ts");
        return probeTail(source, ref, bytes);
      },
    });
    await waiting.refresh([pane("working"), pane("idle", { paneId: "w1:p2" })]);
    expect(reads).toBe(0);
    await waiting.refresh([pane("blocked")]);
    await waiting.refresh([pane("blocked")]);
    expect(reads).toBe(1);
    expect(waiting.get("w1:p1")?.title).toBe("Which branch should I deploy?");
  });

  test("a pane with no session, or a harness with no journal, has no words and never throws", async () => {
    const waiting = new WaitingWords(registry);
    const { agentSession: _gone, ...noSession } = pane("blocked");
    await waiting.refresh([noSession, pane("blocked", { paneId: "w1:p3", agent: "aider" })]);
    expect(waiting.get("w1:p1")).toBeUndefined();
    expect(waiting.get("w1:p3")).toBeUndefined();
  });
});
