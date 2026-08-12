import { describe, expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";

import { isPiSessionId, parsePiTranscript, PiTranscriptSource } from "./pi.ts";

// Row builders mirroring the verified on-disk shape (pi session logs, session format v3, 2026-07-29).
// Every row carries its own `id`, so unlike Codex there is nothing to synthesise for paging.
const row = (id: string, message: Record<string, unknown>) =>
  JSON.stringify({
    type: "message",
    id,
    parentId: "p0",
    timestamp: "2026-07-29T10:00:00.000Z",
    message,
  });

const speech = (id: string, role: "user" | "assistant", text: string) =>
  row(id, { role, content: [{ type: "text", text }] });

const header = () =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: "019f1827-bf99-7927-9684-76318de905b5",
    timestamp: "2026-07-29T10:00:00.000Z",
    cwd: "/repo",
  });

describe("isPiSessionId", () => {
  test.each([
    ["a v4 uuid", "715d7796-b4de-4f46-a11c-fbbdd8ca965b", true],
    ["a v7 uuid", "019f4665-7df0-7540-a64f-7068335f21af", true],
    ["a traversal attempt", "../../secrets", false],
  ])("%s → %s", (_label, value, expected) => {
    expect(isPiSessionId(value)).toBe(expected);
  });
});

describe("parsePiTranscript", () => {
  test("reads speech turns and ignores the session header", () => {
    const entries = parsePiTranscript(
      [header(), speech("a", "user", "go ahead"), speech("b", "assistant", "on it")].join("\n"),
    );
    expect(entries.map((e) => [e.uuid, e.role])).toEqual([
      ["a", "user"],
      ["b", "assistant"],
    ]);
  });

  test.each([
    ["model_change", { type: "model_change", id: "m", modelId: "x", provider: "y" }],
    ["thinking_level_change", { type: "thinking_level_change", id: "t", thinkingLevel: "high" }],
  ])("%s is bookkeeping and renders nothing", (_label, r) => {
    expect(parsePiTranscript(JSON.stringify(r))).toEqual([]);
  });

  test("a thinking block renders — pi persists real reasoning text", () => {
    const entries = parsePiTranscript(
      row("a", {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "**Identifying single subagent call**", thinkingSignature: "{}" },
        ],
      }),
    );
    expect(entries[0]!.parts).toEqual([
      { kind: "thinking", text: "**Identifying single subagent call**" },
    ]);
  });

  test("a toolCall summarises from its arguments OBJECT (no JSON string, unlike codex)", () => {
    const entries = parsePiTranscript(
      row("a", {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/repo/SKILL.md" } },
        ],
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({
      kind: "tool",
      name: "read",
      summary: "/repo/SKILL.md",
    });
  });

  // pi puts a tool result in its OWN row (Claude nests it inside a user turn), linked by toolCallId.
  test("a toolResult row folds onto the call that produced it", () => {
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "/x" } }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "read",
          content: [{ type: "text", text: "file contents" }],
        }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", result: { text: "file contents" } });
  });

  test("an errored toolResult keeps its error flag", () => {
    const entries = parsePiTranscript(
      [
        row("a", {
          role: "assistant",
          content: [{ type: "toolCall", id: "c", name: "read", arguments: {} }],
        }),
        row("b", {
          role: "toolResult",
          toolCallId: "c",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "ENOENT" }],
        }),
      ].join("\n"),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ result: { text: "ENOENT", isError: true } });
  });

  test("an orphan toolResult is kept unattached so the window never drops output", () => {
    const entries = parsePiTranscript(
      row("b", {
        role: "toolResult",
        toolCallId: "gone",
        toolName: "read",
        content: [{ type: "text", text: "stranded" }],
      }),
    );
    expect(entries[0]!.parts[0]).toMatchObject({ kind: "tool", name: "read", result: { text: "stranded" } });
  });

  test("a clipped or partial line is skipped, not thrown on", () => {
    expect(parsePiTranscript(['{"type":"mess', speech("a", "user", "hi")].join("\n"))).toHaveLength(1);
  });
});

// pi is the harness that reports a kind-`path` ref: its herdr integration prefers
// `agent_session_path` (an absolute path chosen by a process we don't control) over an id. That path
// is treated as hostile input, so containment is the security boundary and it needs real files.
describe("PiTranscriptSource — path refs are confined to the root", () => {
  const SID = "019f4665-7df0-7540-a64f-7068335f21af";

  /**
   * Everything lives under one `base` so cleanup takes the "outside" file with it:
   *   base/sessions/--repo--/<ts>_<uuid>.jsonl   the real log
   *   base/outside.jsonl                          a file the root must never reach
   *   base/sessions/--repo--/sneaky.jsonl → ../../outside.jsonl   a symlink out of the root
   */
  async function fixture() {
    const created = `${tmpdir()}/collie-pi-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const root = `${base}/sessions`;
    const project = `${root}/--var-home-you-repo--`;
    await mkdir(project, { recursive: true });
    const log = `${project}/2026-07-29T10-00-00-000Z_${SID}.jsonl`;
    await Bun.write(log, speech("a", "user", "hi"));
    const outside = `${base}/outside.jsonl`;
    await Bun.write(outside, speech("z", "user", "secrets"));
    const sneaky = `${project}/2026-07-29T11-00-00-000Z_${OUTSIDE_SID}.jsonl`;
    await symlink(outside, sneaky);
    return { base, root, log, sneaky };
  }

  const OUTSIDE_SID = "ffffffff-1111-2222-3333-444444444444";

  test("resolves a path ref that really is inside the root", async () => {
    const { base, root, log } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: log })).toBe(log);
    await rm(base, { recursive: true, force: true });
  });

  test("refuses a path ref pointing outside the root", async () => {
    const { base, root, log } = await fixture();
    const escape = `${log}/../../../../etc/hosts`;
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: escape })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  // Symlink resolution is the ENTIRE reason containment runs on realpaths rather than on the strings
  // we were handed: `..` traversal would be caught by plain normalisation, this would not. The file
  // sits inside the root, has a plausible session filename, and still must not be readable.
  test("refuses a symlink inside the root that points outside it", async () => {
    const { base, root, sneaky } = await fixture();
    const src = new PiTranscriptSource(root);
    expect(await src.resolve({ kind: "path", value: sneaky })).toBeNull();
    // …and the id fallback must not be a way around the same check.
    expect(await src.resolve({ kind: "id", value: OUTSIDE_SID })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("refuses a path ref that isn't a session log at all", async () => {
    const { base, root } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "path", value: "/etc/passwd" })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("resolves the id fallback by scanning the per-cwd directories", async () => {
    const { base, root, log } = await fixture();
    expect(await new PiTranscriptSource(root).resolve({ kind: "id", value: SID })).toBe(log);
    await rm(base, { recursive: true, force: true });
  });

  test("an unknown id resolves to null rather than guessing", async () => {
    const { base, root } = await fixture();
    const src = new PiTranscriptSource(root);
    expect(await src.resolve({ kind: "id", value: "ffffffff-ffff-ffff-ffff-ffffffffffff" })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});

// pi with more than one sessions root (a second PI_CODING_AGENT_DIR) — the same multi-home case
// CLAUDE_CONFIG_DIR raised for Claude (issue #92). pi is the interesting one because its ref is
// usually a free-form PATH: no root built that name, so every configured root is asked whether the
// file is its own, and the union of the roots is exactly the readable area — nothing wider.
describe("PiTranscriptSource — several sessions roots", () => {
  const A = "019f4665-7df0-7540-a64f-7068335f21af";
  const B = "019f4665-7df0-7540-a64f-7068335f21b0";

  async function fixture() {
    const created = `${tmpdir()}/collie-pi-roots-${Math.floor(performance.now() * 1000)}`;
    await mkdir(created, { recursive: true });
    const base = await realpath(created);
    const first = `${base}/first`;
    const second = `${base}/second`;
    await mkdir(`${first}/--repo--`, { recursive: true });
    await mkdir(`${second}/--side--`, { recursive: true });
    const logA = `${first}/--repo--/2026-08-11T09-00-00-000Z_${A}.jsonl`;
    const logB = `${second}/--side--/2026-08-11T10-00-00-000Z_${B}.jsonl`;
    await Bun.write(logA, speech("a", "user", "one"));
    await Bun.write(logB, speech("b", "user", "two"));
    const outside = `${base}/outside.jsonl`;
    await Bun.write(outside, speech("z", "user", "secrets"));
    return { base, first, second, logA, logB, outside };
  }

  test("a single root string still refuses the other root's log", async () => {
    const { base, first, logB } = await fixture();
    const src = new PiTranscriptSource(first);
    expect(await src.resolve({ kind: "path", value: logB })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("a path ref resolves under whichever configured root really contains it", async () => {
    const { base, first, second, logA, logB } = await fixture();
    const src = new PiTranscriptSource([first, second]);
    expect(await src.resolve({ kind: "path", value: logA })).toBe(logA);
    expect(await src.resolve({ kind: "path", value: logB })).toBe(logB);
    await rm(base, { recursive: true, force: true });
  });

  test("a path outside EVERY root is still refused", async () => {
    const { base, first, second, outside } = await fixture();
    const src = new PiTranscriptSource([first, second]);
    expect(await src.resolve({ kind: "path", value: outside })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });

  test("the id fallback scans every root", async () => {
    const { base, first, second, logB } = await fixture();
    expect(await new PiTranscriptSource([first, second]).resolve({ kind: "id", value: B })).toBe(logB);
    await rm(base, { recursive: true, force: true });
  });
});
