import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject } from "../web/src/lib/json.ts";
import { CAPABILITY_FILE, MOSHI_ENTRY_COMMAND } from "./codex-moshi.ts";
import { cmdCodexNativeInstall, cmdCodexNativeUninstall, hooksJsonPath, nativeCommand, nativeStatusLines, ownedBinary, serializeHooks } from "./codex-native.ts";
import { recordPath, readRecord } from "./codex-native-record.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, type FakeFiles } from "./fakes.ts";
import { cmdHooksInstall, cmdHooksStatus, cmdHooksUninstall, type HooksDeps } from "./hooks.ts";
import { EXIT } from "./io.ts";

// `collie hooks install codex --native`. The operator's real hooks.json has other tools' hooks, a Moshi
// entry on four events, and Codex's trust keyed by position, so the tests are about what is NOT touched
// and about the refusals that must write nothing.

const BIN = "/opt/collie/bin/collie";
const CODEX = join(HOME, ".codex");
const HOOKS = hooksJsonPath({ home: HOME, env: {} });
const RECORD = recordPath({ home: HOME, env: {} });
const CONFIG_TOML = join(CODEX, "config.toml");
const MOSHI = "/opt/homebrew/bin/moshi";
const MOSHI_REAL = "/opt/homebrew/Cellar/moshi/1.0.0/bin/moshi";
const MOSHI_CMD = MOSHI_ENTRY_COMMAND;

/** The operator's notify command (a computer-use client) and Codex's trust state, which native mode must never open. */
const CONFIG = `model = "x"
notify = [
    "/Users/pat/computer-use/SkyComputerUseClient",
    "turn-ended",
]

[hooks.state."${HOOKS}:permission_request:0:0"]
trusted_hash = "sha256:aaa"
enabled = true
`;

const moshiHandler = (): JsonObject => ({ command: MOSHI_CMD, type: "command" });

/** A hooks.json document, typed so a test can add to an event's list. */
type Doc = { hooks: Record<string, JsonValue[]> };

/** A hooks.json like the real one: Moshi on four events, a deny-hook gate, status hooks of other tools. */
function operatorHooks(): Doc {
  return {
    hooks: {
      PermissionRequest: [{ hooks: [moshiHandler()] }],
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "python3 gate.py", timeout: 10 }] }],
      SessionStart: [{ hooks: [{ command: "bash herdr-agent-state.sh session", timeout: 10, type: "command" }] }, { hooks: [moshiHandler()] }],
      Stop: [{ hooks: [moshiHandler()] }],
      UserPromptSubmit: [{ hooks: [moshiHandler()] }],
    },
  };
}

function proof(over: Record<string, JsonValue> = {}): string {
  return JSON.stringify({
    schema: 1,
    provider: "moshi",
    command: MOSHI_CMD,
    executable: MOSHI_REAL,
    digest: new Bun.CryptoHasher("sha256").update("moshi 1.0.0").digest("hex"),
    cancel: { method: "sigterm", graceMs: 3000 },
    proof: { kind: "runtime-withdrawal", remoteWithdrawn: true, observer: "root", observedAt: "2026-10-25T18:00:00Z", detail: "Cancelled the loser on a phone; the pending prompt left the phone within 2 s." },
    ...over,
  });
}

interface Rig extends HooksDeps {
  readonly files: FakeFiles;
  readonly io: ReturnType<typeof capture>;
}

function rig(opts: { hooks?: Doc | null; text?: string; moshi?: boolean; proven?: boolean } = {}): Rig {
  const files = fakeFiles({ [CONFIG_TOML]: CONFIG });
  if (opts.text !== undefined) files.write(HOOKS, opts.text);
  else if (opts.hooks !== null) files.write(HOOKS, serializeHooks(opts.hooks ?? operatorHooks()));
  if (opts.moshi !== false) {
    files.write(MOSHI_REAL, "moshi 1.0.0");
    files.realPaths.set(MOSHI, MOSHI_REAL);
    files.write(MOSHI, "moshi 1.0.0");
  }
  if (opts.proven === true) files.write(join("/cfg", CAPABILITY_FILE), proof());
  return { ctx: context({}), io: capture(), files, fs: fakeLinkFs() };
}

const read = (d: Rig, path: string): string | null => d.files.entries.get(path)?.text ?? null;
const parsed = (d: Rig): Doc => JSON.parse(read(d, HOOKS) ?? "{}");
/** The handler objects of one group. */
function handlers(group: JsonValue | undefined): JsonObject[] {
  const list = asJsonObject(group)?.hooks;
  const out: JsonObject[] = [];
  if (!Array.isArray(list)) return out;
  for (const handler of list) {
    const node = asJsonObject(handler);
    if (node !== undefined) out.push(node);
  }
  return out;
}
const commands = (groups: JsonValue[] | undefined): string[] => (groups ?? []).flatMap((group) => handlers(group).map((handler) => String(handler.command)));

describe("native install: edges", () => {
  test("adds the five edge events as their own groups at the END, and leaves every other entry where it was", () => {
    const d = rig();
    const before = parsed(d);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.OK);
    const after = parsed(d);
    for (const [event, groups] of Object.entries(before.hooks)) {
      // Codex keys trust by `event:group:handler`: the groups already there keep their index and bytes.
      expect(after.hooks[event]?.slice(0, groups.length)).toEqual(groups);
    }
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"]) {
      expect(ownedBinary(handlers(after.hooks[event]!.at(-1))[0]?.command)).toBe(BIN);
    }
    expect(after.hooks.SessionStart).toHaveLength(3);
    expect(after.hooks.PermissionRequest).toEqual(before.hooks.PermissionRequest);
    expect(after.hooks.PostToolUse).toBeUndefined();
    expect(handlers(after.hooks.Interrupt![0])[0]).toEqual({ type: "command", command: nativeCommand(BIN), timeout: 3 });
  });

  test("never reads or writes config.toml: the operator's notify and the trust state stay byte for byte", () => {
    const d = rig();
    cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false });
    cmdCodexNativeUninstall(d);
    expect(read(d, CONFIG_TOML)).toBe(CONFIG);
    expect(d.files.ops.filter((op) => op.includes("config.toml"))).toEqual([]);
  });

  test("installing twice writes no bytes and says so", () => {
    const d = rig({ hooks: { hooks: { Stop: [] } }, moshi: false });
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false })).toBe(EXIT.OK);
    const once = [read(d, HOOKS), read(d, RECORD)];
    d.files.ops.length = 0;
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false })).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("no bytes changed");
    expect(d.files.ops).toEqual([]);
    expect([read(d, HOOKS), read(d, RECORD)]).toEqual(once);
  });

  test("a changed binary path is re-pointed in place: still one entry per event", () => {
    const d = rig();
    cmdCodexNativeInstall(d, "/old/collie", { hold: false, moshi: false });
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.OK);
    const stop = commands(parsed(d).hooks.Stop);
    expect(stop.filter((c) => ownedBinary(c) !== null)).toEqual([nativeCommand(BIN)]);
  });

  test("a hooks.json that does not exist is created; one that is not JSON, or is a symlink, is left alone", () => {
    const fresh = rig({ hooks: null });
    expect(cmdCodexNativeInstall(fresh, BIN, { hold: false, moshi: false })).toBe(EXIT.OK);
    expect(Object.keys(parsed(fresh).hooks)).toEqual(["SessionStart", "UserPromptSubmit", "Stop", "Interrupt", "SessionEnd"]);

    const junk = rig({ text: "{ not json" });
    expect(cmdCodexNativeInstall(junk, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(read(junk, HOOKS)).toBe("{ not json");

    const linked = rig();
    linked.files.entryTypes.set(HOOKS, "symlink");
    expect(cmdCodexNativeInstall(linked, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(read(linked, RECORD)).toBeNull();
  });

  test("a document with an event that is not an array refuses and writes nothing", () => {
    const d = rig({ text: JSON.stringify({ hooks: { Stop: "oops" } }) });
    const text = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(read(d, HOOKS)).toBe(text);
  });
});

describe("native install: duplicates are refused, never merged", () => {
  test("two entries of ours on one event", () => {
    const d = rig();
    cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false });
    const doc = parsed(d);
    doc.hooks.Stop!.push({ hooks: [{ type: "command", command: nativeCommand("/other/collie"), timeout: 10 }] });
    d.files.write(HOOKS, serializeHooks(doc));
    const text = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("2 Collie entries on Stop");
    expect(read(d, HOOKS)).toBe(text);
  });

  test("two entries that are exactly Moshi's on PermissionRequest", () => {
    const doc = operatorHooks();
    doc.hooks.PermissionRequest!.push({ hooks: [moshiHandler()] });
    const d = rig({ hooks: doc, proven: true });
    const text = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("nothing says which one");
    expect(read(d, HOOKS)).toBe(text);
    expect(read(d, RECORD)).toBeNull();
  });

  test("a Collie entry and Moshi's together on PermissionRequest", () => {
    const doc = operatorHooks();
    doc.hooks.PermissionRequest!.push({ hooks: [{ type: "command", command: nativeCommand(BIN), timeout: 300 }] });
    const d = rig({ hooks: doc, proven: true });
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("both registered");
  });
});

describe("native install: the permission hold and Moshi", () => {
  test("a hold beside Moshi's own PermissionRequest entry is refused: two handlers, either can deny", () => {
    const d = rig({ proven: true });
    const text = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("--with-moshi");
    expect(d.io.stderr.join("\n")).toContain("#595");
    expect(read(d, HOOKS)).toBe(text);
  });

  test("--with-moshi with no recorded proof writes NOTHING: Moshi-only routing stays", () => {
    const d = rig();
    const text = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("no recorded proof");
    expect(read(d, HOOKS)).toBe(text);
    expect(read(d, RECORD)).toBeNull();
    expect(d.files.ops).toEqual([]);
  });

  test("--with-moshi with a proof made on another build writes nothing either", () => {
    const d = rig({ proven: true });
    d.files.write(MOSHI_REAL, "moshi 1.1.0");
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("changed since the proof");
    expect(read(d, RECORD)).toBeNull();
  });

  test("--with-moshi without --hold-permissions is a usage error", () => {
    const d = rig({ proven: true });
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: true })).toBe(EXIT.USAGE);
  });

  test("--with-moshi with no Moshi entry has nothing to take over", () => {
    const d = rig({ hooks: { hooks: { Stop: [] } }, proven: true });
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("nothing to take over");
  });

  test("with a proof: the broker takes ONLY Moshi's PermissionRequest slot, and Moshi's status hooks stay", () => {
    const d = rig({ proven: true });
    const before = parsed(d);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.OK);
    const after = parsed(d);
    // One handler on PermissionRequest, in the slot Moshi's was in, and no Moshi command left there.
    expect(after.hooks.PermissionRequest).toEqual([{ hooks: [{ type: "command", command: nativeCommand(BIN), timeout: 300 }] }]);
    expect(commands(after.hooks.PermissionRequest).some((c) => c === MOSHI_CMD)).toBe(false);
    // Moshi's three status hooks are untouched, in their own slots.
    expect(after.hooks.SessionStart![1]).toEqual(before.hooks.SessionStart![1]!);
    expect(after.hooks.Stop![0]).toEqual(before.hooks.Stop![0]!);
    expect(after.hooks.UserPromptSubmit![0]).toEqual(before.hooks.UserPromptSubmit![0]!);
    expect(after.hooks.PreToolUse).toEqual(before.hooks.PreToolUse!);
    expect(after.hooks.PostToolUse).toHaveLength(1);
    const record = readRecord(d.files, RECORD)!;
    expect(record.moshi).toEqual({ original: moshiHandler(), command: MOSHI_CMD, group: 0, handler: 0 });
    expect(record.hold).toBe(true);
  });

  test("a broker already installed re-installs to the same bytes, and keeps the saved Moshi entry", () => {
    const d = rig({ proven: true });
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true });
    const hooks = read(d, HOOKS);
    const record = read(d, RECORD);
    d.files.ops.length = 0;
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.OK);
    expect(read(d, HOOKS)).toBe(hooks);
    expect(read(d, RECORD)).toBe(record);
    expect(d.files.ops).toEqual([]);
  });

  test("dropping --with-moshi over an installed broker is refused, not a silent second handler", () => {
    const d = rig({ proven: true });
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true });
    const hooks = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false })).toBe(EXIT.FAIL);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(read(d, HOOKS)).toBe(hooks);
  });

  test("a hold with no Moshi at all adds PermissionRequest and PostToolUse and nothing else is replaced", () => {
    const d = rig({ hooks: { hooks: { Stop: [] } }, moshi: false });
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false })).toBe(EXIT.OK);
    expect(commands(parsed(d).hooks.PermissionRequest)).toEqual([nativeCommand(BIN)]);
    expect(readRecord(d.files, RECORD)?.moshi).toBeNull();
  });

  test("dropping --hold-permissions from a hold-only install removes the hold entries and keeps the edges", () => {
    const d = rig({ hooks: { hooks: {} }, moshi: false });
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: false });
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.OK);
    const hooks = parsed(d).hooks;
    expect(hooks.PermissionRequest).toBeUndefined();
    expect(hooks.PostToolUse).toBeUndefined();
    expect(hooks.Stop).toHaveLength(1);
  });
});

describe("native install: a configuration that changes under it", () => {
  /** A files fake whose hooks.json reads differently from the nth read on, as another writer's save would. */
  function racing(d: Rig, changeFrom: number): void {
    const real = d.files.read;
    let reads = 0;
    d.files.read = (path) => {
      if (path !== HOOKS) return real(path);
      reads += 1;
      return reads >= changeFrom ? `${real(path)}\n` : real(path);
    };
  }

  test("a change after the plan is made aborts before any rename, and nothing is written", () => {
    const d = rig();
    racing(d, 2);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("changed while the install was running");
    expect(d.files.ops.filter((op) => op.startsWith("mv "))).toEqual([]);
    expect(read(d, RECORD)).toBeNull();
  });

  test("a change in the last instant, after the temp file is written, still aborts and cleans up", () => {
    const d = rig();
    racing(d, 3);
    expect(cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false })).toBe(EXIT.FAIL);
    expect(d.files.ops.filter((op) => op.startsWith("mv ") && op.endsWith("hooks.json"))).toEqual([]);
    expect(d.files.list(CODEX).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(read(d, RECORD)).toBeNull();
  });

  test("a hooks write that fails puts the record back", () => {
    const d = rig({ proven: true });
    d.files.unrenamable.add(HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.FAIL);
    expect(read(d, RECORD)).toBeNull();
  });
});

describe("native uninstall", () => {
  test("removes only the owned entries and gives the file back as the operator had it", () => {
    const d = rig({ moshi: false });
    const original = read(d, HOOKS);
    cmdCodexNativeInstall(d, BIN, { hold: false, moshi: false });
    expect(cmdCodexNativeUninstall(d)).toBe(EXIT.OK);
    // The file did not create `Interrupt`/`SessionEnd` before, and no empty array stays behind.
    expect(read(d, HOOKS)).toBe(original);
    expect(read(d, RECORD)).toBeNull();
  });

  test("puts Moshi's entry back exactly as it was, in its slot, and keeps Moshi's other hooks", () => {
    const d = rig({ proven: true });
    const original = read(d, HOOKS);
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true });
    expect(cmdCodexNativeUninstall(d)).toBe(EXIT.OK);
    expect(read(d, HOOKS)).toBe(original);
    expect(read(d, RECORD)).toBeNull();
  });

  test("restores the object byte for byte even when Moshi's entry carried extra keys and sat in a matcher group", () => {
    const doc = operatorHooks();
    const odd = { type: "command", command: MOSHI_CMD, statusMessage: "approving", timeout: 280 };
    doc.hooks.PermissionRequest = [{ matcher: "Bash", hooks: [odd] }];
    const d = rig({ hooks: doc, proven: true });
    const original = read(d, HOOKS);
    expect(cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true })).toBe(EXIT.OK);
    expect(parsed(d).hooks.PermissionRequest).toEqual([{ matcher: "Bash", hooks: [{ type: "command", command: nativeCommand(BIN), timeout: 300 }] }]);
    expect(cmdCodexNativeUninstall(d)).toBe(EXIT.OK);
    expect(read(d, HOOKS)).toBe(original);
  });

  test("a broker whose record is gone is left in place and the verb says so: it will not guess Moshi's entry", () => {
    const d = rig({ proven: true });
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true });
    d.files.remove(RECORD);
    expect(cmdCodexNativeUninstall(d)).toBe(EXIT.FAIL);
    expect(commands(parsed(d).hooks.PermissionRequest)).toEqual([nativeCommand(BIN)]);
    expect(commands(parsed(d).hooks.Stop).filter((c) => ownedBinary(c) !== null)).toEqual([]);
  });

  test("with nothing installed it prints nothing and changes nothing", () => {
    const d = rig();
    const text = read(d, HOOKS);
    expect(cmdCodexNativeUninstall(d)).toBe(EXIT.OK);
    expect(read(d, HOOKS)).toBe(text);
    expect(d.io.stdout).toEqual([]);
  });
});

describe("hooks install codex: the flags", () => {
  test("--native reaches the native install, and the legacy notify line is not written", () => {
    const d = rig({ hooks: null });
    expect(cmdHooksInstall(d, ["codex", "--native"])).toBe(EXIT.OK);
    expect(read(d, HOOKS)).not.toBeNull();
    expect(read(d, CONFIG_TOML)).toBe(CONFIG);
  });

  test("--with-moshi without --native, and --hold-permissions without --native, say how to ask for the native hooks", () => {
    const d = rig();
    expect(cmdHooksInstall(d, ["codex", "--with-moshi"])).toBe(EXIT.USAGE);
    expect(cmdHooksInstall(d, ["codex", "--hold-permissions"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("--native --hold-permissions");
    expect(read(d, CONFIG_TOML)).toBe(CONFIG);
  });

  test("claude has no native hooks", () => {
    const d = rig();
    expect(cmdHooksInstall(d, ["claude", "--native"])).toBe(EXIT.USAGE);
  });

  test("uninstall codex removes both halves, status reports the native one", () => {
    const d = rig({ hooks: null });
    cmdHooksInstall(d, ["codex", "--native", "--hold-permissions"]);
    const status = capture();
    cmdHooksStatus({ ...d, io: status }, []);
    expect(status.stdout.join("\n")).toContain("native Codex hooks: installed");
    expect(cmdHooksUninstall(d, ["codex"])).toBe(EXIT.OK);
    expect(commands(parsed(d).hooks.Stop ?? []).filter((c) => ownedBinary(c) !== null)).toEqual([]);
    expect(nativeStatusLines(d, BIN)).toEqual([]);
  });
});

describe("nativeStatusLines", () => {
  test("names a missing event, a re-pointed binary and the Moshi routing the proof allows", () => {
    const d = rig({ proven: true });
    cmdCodexNativeInstall(d, BIN, { hold: true, moshi: true });
    expect(nativeStatusLines(d, BIN).join("\n")).toContain("the broker answers beside Moshi");
    expect(nativeStatusLines(d, "/moved/collie").join("\n")).toContain("run another binary");
    d.files.write(MOSHI_REAL, "moshi 1.1.0");
    expect(nativeStatusLines(d, BIN).join("\n")).toContain("Moshi-only routing");
    const doc = parsed(d);
    delete doc.hooks.Interrupt;
    d.files.write(HOOKS, serializeHooks(doc));
    expect(nativeStatusLines(d, BIN).join("\n")).toContain("missing Interrupt");
  });
});
