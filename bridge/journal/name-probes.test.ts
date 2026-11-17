import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonObject } from "../json.ts";
import { claudeJournal, claudeNamesOf } from "./claude.ts";
import { piJournal, piNamesOf } from "./pi.ts";
import { NAME_HEAD_BYTES } from "./name-probe.ts";

// Each harness's nameProbe (JournalAdapter.nameProbe): which rows name a session, and whether the
// person or the agent set the name. The row shapes are copied from real logs, 2026-11-13: Claude Code
// 2.1.3xx and Oh My Pi 18.10; pi's `session_info` from the harness canary (2026-10-12).

const SID = "73ab965f-6236-4e88-9de9-f981b8a880af";
const row = (value: JsonObject): string => JSON.stringify(value);

describe("Claude Code: claudeNamesOf", () => {
  test("custom-title is the person's name, ai-title the agent's, newest wins", () => {
    const lines = [
      row({ type: "ai-title", aiTitle: "Lodge Silverblue to NixOS migration", sessionId: SID }),
      row({ type: "custom-title", customTitle: "old name", sessionId: SID }),
      row({ type: "custom-title", customTitle: "migrate lodge", sessionId: SID }),
      row({ type: "agent-name", agentName: "migrate lodge", sessionId: SID }),
    ];
    expect(claudeNamesOf(lines)).toEqual({ person: "migrate lodge", agent: "Lodge Silverblue to NixOS migration" });
  });

  test("agent-name alone is the person's name; a window with neither row says nothing", () => {
    expect(claudeNamesOf([row({ type: "agent-name", agentName: "bay lead" })])).toEqual({ person: "bay lead" });
    expect(claudeNamesOf([row({ type: "user", message: { content: "hi" } }), "not json"])).toEqual({});
  });

  test("an empty title clears the name it names", () => {
    expect(claudeNamesOf([row({ type: "custom-title", customTitle: "" })])).toEqual({ person: null });
  });

  test("the adapter reads the rows off a real log", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "collie-claude-names-")));
    const project = join(dir, "-home-you-demo");
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, `${SID}.jsonl`),
      `${[row({ type: "ai-title", aiTitle: "Fact check", sessionId: SID }), row({ type: "custom-title", customTitle: "dialog pings", sessionId: SID })].join("\n")}\n`,
    );
    const journal = claudeJournal(dir);
    expect(await journal.nameProbe?.({ kind: "id", value: SID })).toEqual({ person: "dialog pings", agent: "Fact check" });
    expect(await journal.nameProbe?.({ kind: "id", value: "00000000-0000-0000-0000-000000000000" })).toBeNull();
    await rm(dir, { recursive: true, force: true });
  });
});

describe("pi and Oh My Pi: piNamesOf", () => {
  const header = (title: string, source = "auto") => ({ type: "title", v: 1, title, source, updatedAt: "2026-10-25T09:27:57.324Z", pad: " ".repeat(40) });

  test("Oh My Pi's header title with source auto is the agent's title", () => {
    expect(piNamesOf(header("Clarify Explanation Input and Output Languages"), [])).toEqual({
      agent: "Clarify Explanation Input and Output Languages",
    });
  });

  test("a header title from the user source is the person's name", () => {
    expect(piNamesOf(header("release prep", "user"), [])).toEqual({ person: "release prep" });
  });

  test("an unknown or missing source is the agent's title, so the mask covers it", () => {
    expect(piNamesOf(header("Rotate the key", "imported"), [])).toEqual({ agent: "Rotate the key" });
    const { source: _none, ...bare } = header("No source");
    expect(piNamesOf(bare, [])).toEqual({ agent: "No source" });
    expect(piNamesOf(null, [row({ type: "title_change", title: "From a plugin", source: "plugin" })])).toEqual({ agent: "From a plugin" });
  });

  test("a tail with no title rows names nothing, so the tracker keeps the last name", () => {
    expect(piNamesOf({ type: "session", id: "x" }, [row({ type: "message", id: "m1" })])).toEqual({});
  });

  test("an empty header title clears the agent's title, and outranks an older title_change in the tail", () => {
    const tail = [row({ type: "title_change", title: "Old title", source: "auto" })];
    expect(piNamesOf(header(""), tail)).toEqual({ agent: null });
  });

  test("with no header, the newest title_change stands in", () => {
    const tail = [row({ type: "title_change", title: "First", source: "auto" }), row({ type: "title_change", title: "Second", source: "auto" })];
    expect(piNamesOf(null, tail)).toEqual({ agent: "Second" });
  });

  test("pi's session_info name is the person's name", () => {
    const tail = [row({ type: "session_info", id: "n1", parentId: "p0", name: "a name" })];
    expect(piNamesOf({ type: "session", id: "x" }, tail)).toEqual({ person: "a name" });
  });

  test("a first row longer than the 4 KB head window is no header: the tail's title_change stands in", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "collie-pi-names-")));
    const folder = join(root, "--home-you-demo--");
    await mkdir(folder, { recursive: true });
    const file = join(folder, "2026-10-25T09-26-39-663Z_01a17262-2f2f-76c6-879e-042be1195276.jsonl");
    // Oh My Pi's title slot is 256 bytes (SESSION_TITLE_SLOT_BYTES); a longer first row is not its slot.
    const long = { ...header("Head title"), pad: " ".repeat(NAME_HEAD_BYTES + 100) };
    await writeFile(file, `${[row(long), row({ type: "title_change", title: "Tail title", source: "auto" })].join("\n")}\n`);
    expect(await piJournal(root).nameProbe?.({ kind: "path", value: file })).toEqual({ agent: "Tail title" });
    await rm(root, { recursive: true, force: true });
  });

  test("the adapter reads the header and the tail off a real log", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "collie-pi-names-")));
    const folder = join(root, "--home-you-demo--");
    await mkdir(folder, { recursive: true });
    const file = join(folder, "2026-10-25T09-26-39-663Z_01a17262-2f2f-76c6-879e-042be1195276.jsonl");
    const lines = [row(header("Colour prompt")), row({ type: "session", id: "01a17262-2f2f-76c6-879e-042be1195276", cwd: "/home/you/demo" }), row({ type: "session_info", id: "n1", name: "colours" })];
    await writeFile(file, `${lines.join("\n")}\n`);
    const journal = piJournal(root);
    expect(await journal.nameProbe?.({ kind: "path", value: file })).toEqual({ agent: "Colour prompt", person: "colours" });
    await rm(root, { recursive: true, force: true });
  });
});
