import { describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

import type { ResetEvent } from "../cache/claims.ts";
import { evaluate } from "../cache/engine.ts";
import { allResetRules, resetRulesFor, ruleForProbe } from "../cache/rules/index.ts";
import type { JsonObject } from "../json.ts";
import { claudeJournal } from "./claude.ts";
import {
  CLAUDE_RESET_IDS,
  claudeResets,
  lastTwoTurns,
  modelSetBy,
  normaliseModel,
  resetsBetween,
} from "./claude-resets.ts";

// Claude Code actions that drop the cache between turns (issue #236). The chip said "52m" after a
// `/model` switch, and the next turn was billed as a full rebuild. Every case names the misreading it
// prevents. The record SHAPES are Claude Code's own (a `user` string, a `system` `local_command`, the
// ANSI-bold build, `compact_boundary`); the contents are made up, because the repo is public.

const PATH = "/t.jsonl";
const ESC = String.fromCodePoint(0x1b);

const stdout = (text: string, at: string, version = "2.1.267"): JsonObject => ({
  type: "user",
  timestamp: at,
  version,
  message: { role: "user", content: `<local-command-stdout>${text}</local-command-stdout>` },
});

const reload = (args: string, at = "2026-09-17T10:00:00Z"): JsonObject => ({
  type: "user",
  timestamp: at,
  message: {
    role: "user",
    content: `<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>\n<command-args>${args}</command-args>`,
  },
});

const ids = (events: readonly ResetEvent[]) => events.map((e) => e.ruleId);

const turn = (id: string, at: string, model: string, extra: JsonObject = {}): string =>
  JSON.stringify({
    type: "assistant",
    timestamp: at,
    message: { id, model, usage: { cache_read_input_tokens: 9000, cache_creation_input_tokens: 10 } },
    ...extra,
  });

describe("normaliseModel", () => {
  test("meets display names and API ids in the middle", () => {
    const table: Array<[string | undefined, string | null]> = [
      ["Opus 5 (1M context)", "opus5"],
      ["claude-opus-5", "opus5"],
      ["claude-opus-5[1m]", "opus5"],
      ["Fable 5.1", "fable51"],
      ["claude-fable-5-1", "fable51"],
      ["claude-haiku-4-5-20251001", "haiku45"],
      ["Sonnet 5", "sonnet5"],
      // A name that does not reduce to a family is a sentence Collie cannot read, never a switch.
      ["Default (recommended)", null],
      ["opusplan", null],
      ["<synthetic>", null],
      [undefined, null],
    ];
    for (const [input, want] of table) expect(normaliseModel(input)).toBe(want);
  });
});

describe("modelSetBy", () => {
  test("reads every /model stdout shape on disk, and nothing else", () => {
    expect(modelSetBy("<local-command-stdout>Set model to `Opus 5 (1M context)` for this session only")).toBe(
      "Opus 5 (1M context)",
    );
    expect(
      modelSetBy("<local-command-stdout>Set model to `Fable 5.1` and saved as your default for new sessions"),
    ).toBe("Fable 5.1");
    // One build bolded the name with ANSI instead of backticks; the caller strips the escapes first.
    expect(modelSetBy("<local-command-stdout>Set model to Fable 5 for this session only")).toBe("Fable 5");
    expect(modelSetBy("<local-command-stdout>Kept model as `Opus 5`")).toBeNull();
    expect(modelSetBy("<local-command-stdout>Cancelled")).toBeNull();
  });
});

describe("resetsBetween", () => {
  test("switching to another model is a reset", () => {
    const events = resetsBetween(
      [stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T10:00:00Z")],
      "claude-opus-5",
      PATH,
    );
    expect(ids(events)).toEqual([CLAUDE_RESET_IDS.model]);
    expect(events[0]?.at).toBe(Date.parse("2026-09-17T10:00:00Z"));
  });

  test("switching away and back again is not a reset: only the newest /model counts", () => {
    const events = resetsBetween(
      [
        stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T10:00:00Z"),
        stdout("Set model to `Opus 5 (1M context)` for this session only", "2026-09-17T10:00:05Z"),
      ],
      "claude-opus-5",
      PATH,
    );
    expect(events).toEqual([]);
  });

  test("an ANSI-bold /model stdout reads like the backtick one", () => {
    const record = stdout(`Set model to ${ESC}[1mFable 5${ESC}[22m for this session only`, "2026-09-17T10:00:00Z");
    expect(ids(resetsBetween([record], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.model]);
  });

  test("a /model Collie cannot read claims nothing, rather than a reset", () => {
    const record = stdout("Set model to `Default (recommended)` for this session only", "2026-09-17T10:00:00Z");
    expect(resetsBetween([record], "claude-opus-5", PATH)).toEqual([]);
    // Nor does a switch measured against a turn whose model is unreadable.
    const fine = stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T10:00:00Z");
    expect(resetsBetween([fine], undefined, PATH)).toEqual([]);
  });

  test("an effort change on Opus is a reset", () => {
    const record = stdout("Set effort level to xhigh (this session only): Deeper reasoning", "2026-09-17T10:00:00Z");
    expect(ids(resetsBetween([record], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.effort]);
  });

  test("an effort change on Fable 5.1 keeps the cache only from Claude Code 2.1.260", () => {
    const change = (version: string) =>
      stdout("Set effort level to xhigh (this session only): Deeper", "2026-09-17T10:00:00Z", version);
    expect(resetsBetween([change("2.1.260")], "claude-fable-5-1", PATH)).toEqual([]);
    expect(resetsBetween([change("2.1.278")], "claude-fable-5-1", PATH)).toEqual([]);
    expect(ids(resetsBetween([change("2.1.259")], "claude-fable-5-1", PATH))).toEqual([CLAUDE_RESET_IDS.effort]);
    // A version Collie cannot read keeps the reset: the pessimistic answer.
    expect(ids(resetsBetween([change("next")], "claude-fable-5-1", PATH))).toEqual([CLAUDE_RESET_IDS.effort]);
    // Fable 5, not 5.1, is not exempt at any version.
    expect(ids(resetsBetween([change("2.1.278")], "claude-fable-5", PATH))).toEqual([CLAUDE_RESET_IDS.effort]);
  });

  test("a compaction boundary is a reset", () => {
    const record: JsonObject = { type: "system", subtype: "compact_boundary", timestamp: "2026-09-17T10:00:00Z" };
    expect(ids(resetsBetween([record], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.compaction]);
  });

  test("plain /reload-plugins and --force are two different rules", () => {
    expect(ids(resetsBetween([reload("")], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.reload]);
    expect(ids(resetsBetween([reload("--force")], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.reloadForced]);
  });

  test("the system local_command shape reads too", () => {
    const system: JsonObject = {
      type: "system",
      subtype: "local_command",
      timestamp: "2026-09-17T10:00:00Z",
      content: "<local-command-stdout>Set effort level to low (this session only): Fast</local-command-stdout>",
    };
    expect(ids(resetsBetween([system], "claude-opus-5", PATH))).toEqual([CLAUDE_RESET_IDS.effort]);
  });

  test("text that only MENTIONS a command is not the command", () => {
    // A background task's notification quoting a transcript, and a human pasting one: neither opens
    // with the envelope, so neither is a /model.
    const quoted: JsonObject = {
      type: "user",
      timestamp: "2026-09-17T10:00:00Z",
      message: {
        role: "user",
        content: "<task-notification>saw <local-command-stdout>Set model to `Fable 5.1` for this session only</task-notification>",
      },
    };
    const queued: JsonObject = {
      type: "queue-operation",
      timestamp: "2026-09-17T10:00:00Z",
      content: "<local-command-stdout>Set model to `Fable 5.1` for this session only</local-command-stdout>",
    };
    expect(resetsBetween([quoted, queued], "claude-opus-5", PATH)).toEqual([]);
  });

  test("a subagent's record is its own conversation, and is skipped", () => {
    const side: JsonObject = { ...stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T10:00:00Z"), isSidechain: true };
    const compact: JsonObject = { type: "system", subtype: "compact_boundary", timestamp: "2026-09-17T10:00:00Z", isSidechain: true };
    expect(resetsBetween([side, compact], "claude-opus-5", PATH)).toEqual([]);
  });
});

describe("lastTwoTurns", () => {
  test("pairs the newest turn with the one before it, across the records one response writes", () => {
    const lines = [
      turn("msg_a", "2026-09-17T09:00:00Z", "claude-opus-5"),
      JSON.stringify(stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T09:01:00Z")),
      turn("msg_b", "2026-09-17T09:02:00Z", "claude-fable-5-1"),
      // One API response, two content blocks, one message id.
      turn("msg_b", "2026-09-17T09:02:01Z", "claude-fable-5-1"),
    ];
    const turns = lastTwoTurns(lines);
    expect(turns?.newest.index).toBe(3);
    expect(turns?.previous?.index).toBe(0);
  });

  test("skips a subagent's turn and a <synthetic> notice, since neither is a request on this cache", () => {
    const lines = [
      turn("msg_a", "2026-09-17T09:00:00Z", "claude-opus-5"),
      turn("msg_limit", "2026-09-17T09:05:00Z", "<synthetic>"),
      turn("msg_side", "2026-09-17T09:06:00Z", "claude-haiku-4-5", { isSidechain: true }),
    ];
    const turns = lastTwoTurns(lines);
    expect(turns?.newest.index).toBe(0);
    expect(turns?.previous).toBeUndefined();
  });

  test("is null when the window holds no turn at all", () => {
    expect(lastTwoTurns([JSON.stringify(stdout("Cancelled", "2026-09-17T09:00:00Z")), "not json", ""])).toBeNull();
  });
});

describe("claudeResets", () => {
  test("a model change between two turns with no /model behind it still explains the newer turn", () => {
    // An automatic fallback, or a skill that names its own model: nothing on disk but the turns.
    const lines = [turn("msg_a", "2026-09-17T09:00:00Z", "claude-opus-5"), turn("msg_b", "2026-09-17T09:02:00Z", "claude-sonnet-5")];
    const turns = lastTwoTurns(lines);
    expect(turns).not.toBeNull();
    if (turns === null) return;
    const events = claudeResets(turns, PATH);
    expect(ids(events)).toEqual([CLAUDE_RESET_IDS.model]);
    // At the newer turn's own time, which the engine reads as history, never as a warning.
    expect(events[0]?.at).toBe(turns.newest.at);
  });

  test("a /model that explains the change is not reported twice", () => {
    const lines = [
      turn("msg_a", "2026-09-17T09:00:00Z", "claude-opus-5"),
      JSON.stringify(stdout("Set model to `Sonnet 5` for this session only", "2026-09-17T09:01:00Z")),
      turn("msg_b", "2026-09-17T09:02:00Z", "claude-sonnet-5"),
    ];
    const turns = lastTwoTurns(lines);
    if (turns === null) throw new Error("no turns");
    const events = claudeResets(turns, PATH);
    expect(ids(events)).toEqual([CLAUDE_RESET_IDS.model]);
    expect(events[0]?.at).toBe(Date.parse("2026-09-17T09:01:00Z"));
  });

  test("an action after the newest turn is compared with the newest turn's model", () => {
    const lines = [
      turn("msg_a", "2026-09-17T09:00:00Z", "claude-opus-5"),
      JSON.stringify(stdout("Set model to `Opus 5 (1M context)` for this session only", "2026-09-17T09:01:00Z")),
      JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-09-17T09:02:00Z" }),
    ];
    const turns = lastTwoTurns(lines);
    if (turns === null) throw new Error("no turns");
    // The /model kept the model, so only the compaction counts.
    expect(ids(claudeResets(turns, PATH))).toEqual([CLAUDE_RESET_IDS.compaction]);
  });
});

test("every id this module reports is a shipped claude rule", () => {
  const shipped = new Set(allResetRules().map((r) => r.id));
  for (const id of Object.values(CLAUDE_RESET_IDS)) {
    expect(shipped.has(id)).toBe(true);
    expect(id.startsWith("claude.reset.")).toBe(true);
  }
});

// The whole path on real files: the probe reads the tail, the engine turns a pending `/model` into a
// cold chip with the clock still running, and the label that rides the wire is the rule's own.
describe("the Claude probe, end to end", () => {
  const SESSION = "11111111-2222-4333-8444-555555555555";

  async function fixture(lines: readonly string[]) {
    const dir = `${tmpdir()}/collie-resets-${Math.floor(performance.now() * 1000)}`;
    const project = `${dir}/-home-you-repo`;
    await mkdir(project, { recursive: true });
    await Bun.write(`${project}/${SESSION}.jsonl`, `${lines.join("\n")}\n`);
    return dir;
  }

  test("reports a /model made after the newest turn, and the engine reads it as pending", async () => {
    const dir = await fixture([
      turn("msg_1", "2026-09-17T09:00:00Z", "claude-opus-5"),
      turn("msg_2", "2026-09-17T09:01:00Z", "claude-opus-5"),
      JSON.stringify(stdout("Set model to `Fable 5.1` for this session only", "2026-09-17T09:02:00Z")),
    ]);
    const probe = await claudeJournal(dir).cacheProbe?.({ kind: "id", value: SESSION });
    await rm(dir, { recursive: true, force: true });
    expect(probe?.turnId).toBe("msg_2");
    expect(ids(probe?.resets ?? [])).toEqual([CLAUDE_RESET_IDS.model]);

    if (probe === null || probe === undefined) throw new Error("no probe");
    const out = evaluate({
      rule: ruleForProbe("claude", probe),
      probe,
      resetRules: resetRulesFor("claude"),
      now: Date.parse("2026-09-17T09:03:00Z"),
    });
    expect(out?.cache.state).toBe("cold");
    expect(out?.cache.coldReason).toBe("reset");
    expect(out?.cache.reset?.label).toBe("The model changed");
    expect((out?.cache.expiresAt ?? 0) > Date.parse("2026-09-17T09:03:00Z")).toBe(true);
  });

  test("a session with no action since its last turn reports no resets at all", async () => {
    const dir = await fixture([turn("msg_1", "2026-09-17T09:00:00Z", "claude-opus-5")]);
    const probe = await claudeJournal(dir).cacheProbe?.({ kind: "id", value: SESSION });
    await rm(dir, { recursive: true, force: true });
    expect(probe?.turnId).toBe("msg_1");
    expect(probe?.resets).toBeUndefined();
  });
});
