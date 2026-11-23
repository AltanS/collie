import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { BEACON_HOOKS } from "./beacon.ts";
import { askReminderHook } from "./doctor.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, ROOT } from "./fakes.ts";
import {
  ASKS_EVENTS,
  ASKS_TIMEOUT_S,
  asksCommandFor,
  asksInstalledIn,
  behindReason,
  cmdHooksInstall,
  cmdHooksStatus,
  cmdHooksUninstall,
  HOOK_MARKER,
  type HooksDeps,
  oldCheckLeftIn,
  serializeSettings,
} from "./hooks.ts";
import { EXIT } from "./io.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { collieBinary } from "./unit.ts";
import { ASKS_LIMIT_MS } from "./beacon-asks.ts";

// The reminder of open asks in the installer (.adr/0178): `hooks install claude` writes `beacon asks` as a
// second entry in our UserPromptSubmit and SessionStart groups, takes the old check out of our Stop group,
// never doubles an entry, leaves the person's own hooks where they were, and `uninstall` takes all of ours
// out. `hooks status` and `doctor` give it one row. Scratch files only: the filesystem and the link probe are
// fakes, and nothing here can reach a real `~/.claude`.

const SETTINGS = join(HOME, ".claude", "settings.json");
const OWN = collieBinary(ROOT);
const EMIT = `${OWN} beacon emit ${HOOK_MARKER}`;
const ASKS = `${OWN} beacon asks ${HOOK_MARKER}`;
const CHECK = `${OWN} beacon check ${HOOK_MARKER}`;
const MINE_FIRST = { hooks: [{ type: "command", command: "/usr/local/bin/notify-me.sh" }] };
const MINE_LAST = { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/log-prompt.sh", timeout: 5 }] };

function deps(files: Record<string, string> = {}): HooksDeps & { io: ReturnType<typeof capture>; files: ReturnType<typeof fakeFiles> } {
  return { ctx: context({}), io: capture(), files: fakeFiles(files), fs: fakeLinkFs({}), harnessVersion: () => "2.1.301" };
}

function settingsOf(d: ReturnType<typeof deps>): JsonObject {
  return parseJsonObject(d.files.entries.get(SETTINGS)?.text ?? "") ?? {};
}

function hooksOf(document: JsonObject): JsonObject {
  return asJsonObject(document.hooks) ?? {};
}

function groupsOf(document: JsonObject, event: string): JsonValue[] {
  const groups = hooksOf(document)[event];
  return Array.isArray(groups) ? groups : [];
}

/** The file an older install wrote: every event with the emitter alone, and, with `check`, the old Stop check. */
function oldInstall(check: boolean, extra: { readonly event: string; readonly before: JsonValue[] } | null = null): string {
  const hooks: JsonObject = {};
  for (const registration of BEACON_HOOKS) hooks[registration.event] = [{ matcher: registration.matcher, hooks: [{ type: "command", command: EMIT, timeout: 10 }] }];
  if (check) hooks.Stop = [{ hooks: [{ type: "command", command: EMIT, timeout: 10 }, { type: "command", command: CHECK, timeout: 10 }] }];
  if (extra !== null) hooks[extra.event] = [...extra.before, ...groupsOf({ hooks }, extra.event)];
  return serializeSettings({ hooks });
}

const OURS = (event: string) => (ASKS_EVENTS.includes(event) ? [{ type: "command", command: EMIT, timeout: 10 }, { type: "command", command: ASKS, timeout: ASKS_TIMEOUT_S }] : [{ type: "command", command: EMIT, timeout: 10 }]);

describe("the installer and the reminder", () => {
  test("the timeout is small and above the verb's own limit of 1 s", () => {
    expect(ASKS_TIMEOUT_S * 1000).toBeGreaterThan(ASKS_LIMIT_MS);
    expect(ASKS_TIMEOUT_S).toBeLessThanOrEqual(5);
  });

  test("a fresh install writes the reminder beside the emitter in UserPromptSubmit and SessionStart, and nowhere else", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    const document = settingsOf(d);
    for (const event of ["UserPromptSubmit", "SessionStart"]) expect(groupsOf(document, event)).toEqual([{ hooks: OURS(event) }]);
    expect(groupsOf(document, "Stop")).toEqual([{ hooks: OURS("Stop") }]);
    expect(asksCommandFor(EMIT)).toBe(ASKS);
    expect(asksInstalledIn(document)).toBe(true);
    expect(oldCheckLeftIn(document)).toBe(false);
    expect(d.io.stdout.join("\n")).toContain(`UserPromptSubmit, SessionStart → \`${OWN} beacon asks\``);
    const others = Object.entries(hooksOf(document)).filter(([event]) => !ASKS_EVENTS.includes(event));
    expect(JSON.stringify(others)).not.toContain("beacon asks");
    expect(JSON.stringify(document)).not.toContain("beacon check");
  });

  test("an install with the old check: the check goes, the two entries come; behind before, current after", () => {
    const d = deps({ [SETTINGS]: oldInstall(true) });
    expect(oldCheckLeftIn(settingsOf(d))).toBe(true);
    expect(asksInstalledIn(settingsOf(d))).toBe(false);
    expect(behindReason(d)).toBe("hooks");
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    const document = settingsOf(d);
    expect(JSON.stringify(document)).not.toContain("beacon check");
    expect(groupsOf(document, "Stop")).toEqual([{ hooks: OURS("Stop") }]);
    expect(asksInstalledIn(document)).toBe(true);
    expect(behindReason(d)).toBeNull();
  });

  test("an install from before both reads as behind and gains the reminder", () => {
    const d = deps({ [SETTINGS]: oldInstall(false) });
    expect(behindReason(d)).toBe("hooks");
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    expect(asksInstalledIn(settingsOf(d))).toBe(true);
    expect(behindReason(d)).toBeNull();
  });

  test("a leftover check beside the reminder still reads as behind", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    const document = settingsOf(d);
    const hooks = hooksOf(document);
    const both = serializeSettings({ ...document, hooks: { ...hooks, Stop: [{ hooks: [{ type: "command", command: EMIT, timeout: 10 }, { type: "command", command: CHECK, timeout: 10 }] }] } });
    const left = deps({ [SETTINGS]: both });
    expect(behindReason(left)).toBe("hooks");
  });

  test("an install that already has both changes no bytes and never writes a second entry", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    const first = d.files.entries.get(SETTINGS)?.text;
    const again = deps({ [SETTINGS]: first! });
    expect(cmdHooksInstall(again, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    expect(again.files.entries.get(SETTINGS)?.text).toBe(first);
    expect(again.io.stdout[0]).toContain("no bytes changed");
    expect((again.files.entries.get(SETTINGS)?.text ?? "").split("beacon asks").length - 1).toBe(2);
  });

  test("the person's own UserPromptSubmit hooks stay untouched and in order, around ours", () => {
    const d = deps({ [SETTINGS]: oldInstall(true, { event: "UserPromptSubmit", before: [MINE_FIRST] }) });
    const document = settingsOf(d);
    d.files.entries.set(SETTINGS, { text: serializeSettings({ ...document, hooks: { ...hooksOf(document), UserPromptSubmit: [...groupsOf(document, "UserPromptSubmit"), MINE_LAST] } }) });
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    const groups = groupsOf(settingsOf(d), "UserPromptSubmit");
    expect(groups).toHaveLength(3);
    expect(groups[0]).toEqual(MINE_FIRST);
    expect(groups[1]).toEqual({ hooks: OURS("UserPromptSubmit") });
    expect(groups[2]).toEqual(MINE_LAST);
  });

  test("uninstall takes all of ours out and keeps the person's own", () => {
    const d = deps({ [SETTINGS]: oldInstall(true, { event: "SessionStart", before: [MINE_FIRST] }) });
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    const after = settingsOf(d);
    expect(JSON.stringify(after)).not.toContain("beacon asks");
    expect(JSON.stringify(after)).not.toContain("beacon check");
    expect(JSON.stringify(after)).not.toContain(HOOK_MARKER);
    expect(groupsOf(after, "SessionStart")).toEqual([MINE_FIRST]);
  });
});

describe("the reminder's row", () => {
  test("hooks status: installed, missing, beside the old check, and none where our hooks are not installed", () => {
    const fresh = deps();
    cmdHooksInstall(fresh, ["claude", "--no-statusline"]);
    const text = fresh.files.entries.get(SETTINGS)!.text;
    const installed = deps({ [SETTINGS]: text });
    cmdHooksStatus(installed);
    expect(installed.io.stdout).toContain("  the reminder of open asks: installed");

    const old = deps({ [SETTINGS]: oldInstall(true) });
    cmdHooksStatus(old);
    expect(old.io.stdout).toContain("  the reminder of open asks: missing — re-run `collie hooks install claude` to add it");

    const document = parseJsonObject(text) ?? {};
    const both = deps({ [SETTINGS]: serializeSettings({ ...document, hooks: { ...hooksOf(document), Stop: [{ hooks: [{ type: "command", command: EMIT, timeout: 10 }, { type: "command", command: CHECK, timeout: 10 }] }] } }) });
    cmdHooksStatus(both);
    expect(both.io.stdout.join("\n")).toContain("the reminder of open asks: installed, beside the old check at the end of a turn");

    const none = deps({ [SETTINGS]: serializeSettings({ hooks: { Stop: [MINE_FIRST] } }) });
    cmdHooksStatus(none);
    expect(none.io.stdout.join("\n")).not.toContain("the reminder of open asks");
  });

  test("doctor: ok when every file with our hooks has it, a warn naming the file when one does not or keeps the check, no row without hooks", () => {
    const fresh = deps();
    cmdHooksInstall(fresh, ["claude", "--no-statusline"]);
    const target = { dir: join(HOME, ".claude"), path: SETTINGS };
    const ok = askReminderHook({ files: fakeFiles({ [SETTINGS]: fresh.files.entries.get(SETTINGS)!.text }) }, [{ target }]);
    expect(ok.map((finding) => [finding.check, finding.status])).toEqual([["ask-reminder-claude", "ok"]]);
    for (const check of [true, false]) {
      const old = askReminderHook({ files: fakeFiles({ [SETTINGS]: oldInstall(check) }) }, [{ target }]);
      expect(old[0]?.status).toBe("warn");
      expect(old[0]?.detail).toContain(SETTINGS);
      expect(old[0]?.remedy).toContain("collie hooks install claude");
    }
    const document = parseJsonObject(fresh.files.entries.get(SETTINGS)!.text) ?? {};
    const both = serializeSettings({ ...document, hooks: { ...hooksOf(document), Stop: [{ hooks: [{ type: "command", command: EMIT, timeout: 10 }, { type: "command", command: CHECK, timeout: 10 }] }] } });
    const left = askReminderHook({ files: fakeFiles({ [SETTINGS]: both }) }, [{ target }]);
    expect(left[0]?.status).toBe("warn");
    expect(left[0]?.detail).toContain("check at the end of a turn");
    expect(askReminderHook({ files: fakeFiles({}) }, [])).toEqual([]);
  });
});
