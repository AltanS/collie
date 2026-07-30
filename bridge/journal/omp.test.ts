import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ompJournal, parseOmpTranscript } from "./omp.ts";

const SID = "019fb2b1-3060-7000-a086-4e7b785fd895";
const OUTSIDE_SID = "ffffffff-1111-2222-3333-444444444444";
const timestamp = "2026-07-30T11:03:04.544Z";

const message = (id: string, body: Record<string, unknown>) =>
  JSON.stringify({ type: "message", id, parentId: "p0", timestamp, message: body });

const speech = (id: string, role: "user" | "assistant", text: string) =>
  message(id, { role, content: [{ type: "text", text }] });

const notice = (id: string, content: string, display: boolean | undefined = true) =>
  JSON.stringify({
    type: "custom_message",
    customType: "advisor",
    content,
    ...(display === undefined ? {} : { display }),
    id,
    timestamp,
  });

const title = () => JSON.stringify({ type: "title", v: 1, title: "OMP session", source: "auto" });
const session = () =>
  JSON.stringify({ type: "session", version: 3, id: SID, timestamp, cwd: "/repo" });

describe("parseOmpTranscript", () => {
  test("keeps ordinary v3 speech, tools, and visible notices in original log order", () => {
    const entries = parseOmpTranscript(
      [
        // OMP can rewrite the title into the first physical row, before the v3 session header.
        title(),
        session(),
        speech("user-1", "user", "start"),
        notice("note-1", "\u001b[33mcheck this\u001b[0m"),
        message("assistant-1", {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "considering" },
            { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/repo/a.ts" } },
          ],
        }),
        notice("hidden-1", "must stay hidden", false),
        message("result-1", {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "contents" }],
        }),
        notice("note-2", "finished"),
      ].join("\n"),
    );

    expect(entries.map(({ uuid, role }) => [uuid, role])).toEqual([
      ["user-1", "user"],
      ["note-1", "note"],
      ["assistant-1", "assistant"],
      ["note-2", "note"],
    ]);
    expect(entries[1]!.parts).toEqual([{ kind: "text", text: "check this" }]);
    expect(entries[2]!.parts).toEqual([
      { kind: "thinking", text: "considering" },
      {
        kind: "tool",
        name: "read",
        summary: "/repo/a.ts",
        result: { text: "contents" },
      },
    ]);
  });

  test("renders only display:true custom_message rows", () => {
    const rows = [
      notice("visible", "shown"),
      notice("false", "hidden false", false),
      JSON.stringify({ type: "custom_message", customType: "advisor", content: "hidden missing", id: "missing", timestamp }),
      JSON.stringify({
        type: "custom",
        customType: "tool_execution_start",
        content: "control row",
        display: true,
        id: "control",
        timestamp,
      }),
      JSON.stringify({ type: "credential_pin", id: "credential", provider: "openai", hash: "secret" }),
      JSON.stringify({ type: "model_change", id: "model", model: "provider/model" }),
      JSON.stringify({ type: "service_tier_change", id: "service", serviceTier: "priority" }),
      JSON.stringify({ type: "custom_message", id: "wrong-content", display: true, content: { text: "no" } }),
      notice("", "empty id"),
      notice("x".repeat(101), "long id"),
      JSON.stringify({ type: "custom_message", content: "missing id", display: true, timestamp }),
      notice("duplicate", "first duplicate"),
      notice("duplicate", "second duplicate"),
    ];

    expect(parseOmpTranscript(rows.join("\n"))).toEqual([
      {
        uuid: "visible",
        ts: timestamp,
        role: "note",
        parts: [{ kind: "text", text: "shown" }],
      },
    ]);
  });

  test("drops injected developer, system, and unknown message roles", () => {
    const rows = [
      message("developer", { role: "developer", content: [{ type: "text", text: "internal policy" }] }),
      message("system", { role: "system", content: [{ type: "text", text: "hidden system prompt" }] }),
      message("unknown", { role: "custom", content: [{ type: "text", text: "unknown role" }] }),
      speech("user", "user", "operator text"),
    ];

    expect(parseOmpTranscript(rows.join("\n")).map(({ uuid, role }) => [uuid, role])).toEqual([
      ["user", "user"],
    ]);
  });

  test("skips malformed partial rows without losing later messages or notices", () => {
    expect(
      parseOmpTranscript(
        ['{"type":"custom_message","display":tr', speech("user", "user", "hello"), notice("note", "ready")].join(
          "\n",
        ),
      ).map(({ uuid, role }) => [uuid, role]),
    ).toEqual([
      ["user", "user"],
      ["note", "note"],
    ]);
  });

  test("a real id resembling the placeholder namespace remains an ordinary turn", () => {
    const entries = parseOmpTranscript(
      [
        speech("__collie_omp_note__1", "user", "ordinary"),
        notice("notice", "visible"),
      ].join("\n"),
    );
    expect(entries.map(({ uuid, role }) => [uuid, role])).toEqual([
      ["__collie_omp_note__1", "user"],
      ["notice", "note"],
    ]);
  });

  test("bounds visible notice text through the shared v3 text limits", () => {
    const [entry] = parseOmpTranscript(notice("large", "x".repeat(100_000)));
    const part = entry?.parts[0];
    expect(entry?.role).toBe("note");
    expect(part).toMatchObject({ kind: "text", truncated: true });
    expect(part?.kind === "text" ? part.text.length : 0).toBeLessThan(100_000);
  });

  test("adapter identifies itself exactly as Herdr's omp agent", () => {
    expect(ompJournal("/sessions").agent).toBe("omp");
  });
});

describe("OMP source — id and path refs stay inside COLLIE_OMP_ROOT", () => {
  async function fixture() {
    const base = await mkdtemp(join(tmpdir(), "collie-omp-"));
    const root = join(base, "sessions");
    const project = join(root, "-repo-");
    await mkdir(project, { recursive: true });
    const log = join(project, `2026-07-30T11-03-04-544Z_${SID}.jsonl`);
    await Bun.write(log, [title(), session(), speech("user", "user", "hi")].join("\n"));
    const outside = join(base, `outside_${OUTSIDE_SID}.jsonl`);
    await Bun.write(outside, speech("secret", "user", "secret"));
    const sneaky = join(project, `2026-07-30T11-03-05-544Z_${OUTSIDE_SID}.jsonl`);
    await symlink(outside, sneaky);
    return { base, root, log, outside, sneaky };
  }

  test("resolves both contained path refs and the v3 id suffix", async () => {
    const { base, root, log } = await fixture();
    const source = ompJournal(root).source;
    const canonicalLog = await realpath(log);
    expect(await source.resolve({ kind: "path", value: log })).toBe(canonicalLog);
    expect(await source.resolve({ kind: "id", value: SID })).toBe(canonicalLog);
    await rm(base, { recursive: true, force: true });
  });

  test("rejects direct and symlink escapes for both ref kinds", async () => {
    const { base, root, outside, sneaky } = await fixture();
    const source = ompJournal(root).source;
    expect(await source.resolve({ kind: "path", value: outside })).toBeNull();
    expect(await source.resolve({ kind: "path", value: sneaky })).toBeNull();
    expect(await source.resolve({ kind: "id", value: OUTSIDE_SID })).toBeNull();
    await rm(base, { recursive: true, force: true });
  });
});
