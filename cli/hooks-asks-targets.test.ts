import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { JsonValue } from "../bridge/json.ts";
import { BEACON_HOOKS } from "./beacon.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, ROOT } from "./fakes.ts";
import { asksCommandFor, cmdHooksInstall, HOOK_MARKER, HOOK_HARNESSES, installDocument, type HooksDeps } from "./hooks.ts";
import { EXIT } from "./io.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { collieBinary } from "./unit.ts";

// `asksCommandFor` cannot write a second emitter, and only the Claude Code settings document ever gets a
// `beacon asks` entry (the review of the Edge build, 2026-11-23). Scratch files only: the filesystem and the
// link probe are fakes, and nothing here can reach a real `~/.claude` or `~/.codex`.

const OWN = collieBinary(ROOT);
const EMIT = `${OWN} beacon emit ${HOOK_MARKER}`;
const EXTRA = "/var/lab/claude-two";

function deps(env: Record<string, string> = {}): HooksDeps & { io: ReturnType<typeof capture>; files: ReturnType<typeof fakeFiles> } {
  return { ctx: context(env), io: capture(), files: fakeFiles({}), fs: fakeLinkFs({}), harnessVersion: () => "2.1.301" };
}

function commandsIn(document: JsonValue): string[] {
  return JSON.stringify(document).match(/"command":"[^"]*"/gu) ?? [];
}

describe("asksCommandFor", () => {
  test("the emitter's command becomes the reminder's, same binary and marker", () => {
    expect(asksCommandFor(EMIT)).toBe(`${OWN} beacon asks ${HOOK_MARKER}`);
  });

  test("a command without the emitter's verb throws instead of writing a second emitter", () => {
    for (const command of [`${OWN} beacon hold ${HOOK_MARKER}`, `${OWN} beaconemit ${HOOK_MARKER}`, "", `${OWN} beacon asks ${HOOK_MARKER}`]) {
      expect(() => asksCommandFor(command)).toThrow();
    }
  });

  test("the installer then writes the emitter's entries and no reminder entry", () => {
    const odd = `${OWN} beacon emitter-of-another-shape ${HOOK_MARKER}`;
    const outcome = installDocument(null, odd);
    expect(outcome.kind).toBe("document");
    if (outcome.kind !== "document") return;
    const commands = commandsIn(outcome.document);
    expect(commands).toHaveLength(BEACON_HOOKS.length);
    for (const command of commands) expect(command).toBe(`"command":"${odd}"`);
    expect(JSON.stringify(outcome.document)).not.toContain("beacon asks");
  });
});

describe("only the Claude Code settings document gets a beacon asks entry", () => {
  test("the installer knows these harnesses", () => {
    expect([...HOOK_HARNESSES]).toEqual(["claude", "codex"]);
  });

  test("claude (with and without the hold) and codex: every file written outside a Claude settings.json holds no beacon asks", () => {
    const d = deps({ COLLIE_TRANSCRIPT_ROOT: join(EXTRA, "projects") });
    expect(cmdHooksInstall(d, ["claude", "--no-statusline", "--hold-permissions"])).toBe(EXIT.OK);
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
    const claudeFiles = [join(HOME, ".claude", "settings.json"), join(EXTRA, "settings.json")];
    const written = [...d.files.entries].map(([path, entry]) => ({ path, text: entry.text }));
    for (const path of claudeFiles) expect(written.find((file) => file.path === path)?.text).toContain("beacon asks");
    const others = written.filter((file) => !claudeFiles.includes(file.path));
    expect(others.length).toBeGreaterThan(0);
    for (const file of others) expect(file.text).not.toContain("beacon asks");
  });

  test("in a Claude settings document the reminder sits only in UserPromptSubmit and SessionStart, never in the hold's events", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude", "--no-statusline", "--hold-permissions"])).toBe(EXIT.OK);
    const hooks = asJsonObject(parseJsonObject(d.files.entries.get(join(HOME, ".claude", "settings.json"))?.text ?? "{}")?.hooks) ?? {};
    const withAsks = Object.entries(hooks)
      .filter(([, groups]) => JSON.stringify(groups).includes("beacon asks"))
      .map(([event]) => event);
    expect(withAsks.toSorted()).toEqual(["SessionStart", "UserPromptSubmit"]);
  });
});
