import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { parseUsageRecord, usageFileName } from "../bridge/usage.ts";
import { takeContextReading, takeSessionStart } from "./context-reading.ts";
import { context, fakeFiles, HOME, STATE } from "./fakes.ts";

const SESSION = "ff2dd3c2-e3d5-40db-9474-eea02e606c6c";
const NOW = 1_800_000_000_000;
const USAGE = `${STATE}/usage/${usageFileName(SESSION)}`;

describe("context-reading configDir tracking", () => {
  test("takeSessionStart records a custom CLAUDE_CONFIG_DIR even without a model, and omits default ~/.claude", () => {
    const customFiles = fakeFiles({});
    const customDeps = { files: customFiles, uid: 1000, ctx: context({ CLAUDE_CONFIG_DIR: "/profiles/work" }) };
    takeSessionStart(
      customDeps,
      { session: SESSION, harness: "claude", source: "startup", model: undefined, contextTokens: undefined },
      () => [STATE],
      NOW,
    );
    expect(parseUsageRecord(customFiles.read(USAGE) ?? "")).toEqual({
      schemaVersion: 1,
      harness: "claude",
      at: NOW,
      configDir: join("/profiles", "work"),
    });

    const defaultFiles = fakeFiles({});
    const defaultDeps = { files: defaultFiles, uid: 1000, ctx: context({ CLAUDE_CONFIG_DIR: join(HOME, ".claude") }) };
    takeSessionStart(
      defaultDeps,
      { session: SESSION, harness: "claude", source: "startup", model: "claude-opus-5-5", contextTokens: undefined },
      () => [STATE],
      NOW,
    );
    expect(parseUsageRecord(defaultFiles.read(USAGE) ?? "")).toEqual({
      schemaVersion: 1,
      harness: "claude",
      at: NOW,
      window: 200_000,
    });
  });

  test("takeContextReading attaches custom CLAUDE_CONFIG_DIR to the usage record", () => {
    const customRoot = "/profiles/work";
    const transcript = join(customRoot, "projects", "-x", "session.jsonl");
    const files = fakeFiles({
      [transcript]: `${JSON.stringify({ type: "assistant", message: { model: "claude-opus-5-5", usage: { input_tokens: 50_000 } } })}\n`,
      [USAGE]: JSON.stringify({ schemaVersion: 1, harness: "claude", at: NOW - 1000, window: 200_000 }),
    });
    const deps = { files, uid: 1000, ctx: context({ CLAUDE_CONFIG_DIR: customRoot }) };
    takeContextReading(deps, { session: SESSION, transcriptPath: transcript, harness: "claude" }, () => [STATE], NOW);
    expect(parseUsageRecord(files.read(USAGE) ?? "")).toEqual({
      schemaVersion: 1,
      harness: "claude",
      at: NOW,
      window: 200_000,
      context: 25,
      configDir: join("/profiles", "work"),
    });

    // Even when no model window is known yet, a custom CLAUDE_CONFIG_DIR is recorded on the turn.
    const noWindowFiles = fakeFiles({
      [transcript]: `${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`,
    });
    takeContextReading(
      { files: noWindowFiles, uid: 1000, ctx: context({ CLAUDE_CONFIG_DIR: customRoot }) },
      { session: SESSION, transcriptPath: transcript, harness: "claude" },
      () => [STATE],
      NOW,
    );
    expect(parseUsageRecord(noWindowFiles.read(USAGE) ?? "")).toEqual({
      schemaVersion: 1,
      harness: "claude",
      at: NOW,
      configDir: join("/profiles", "work"),
    });
  });
});
