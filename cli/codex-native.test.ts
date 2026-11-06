import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { HOST } from "../bridge/host.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject } from "../web/src/lib/json.ts";
import { CODEX_HOOK_EVENTS } from "./codex-hook.ts";
import {
  documentCarriesNativeHooks,
  hooksJsonPath,
  NATIVE_FLAG,
  nativeCommand,
  nativeStateOf,
  ownedHandler,
  planNativeInstall,
  planNativeUninstall,
  serializeHooks,
} from "./codex-native.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, ROOT } from "./fakes.ts";
import { cmdHooksInstall, cmdHooksStatus, cmdHooksUninstall, type HooksDeps } from "./hooks.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";
import { collieBinary } from "./unit.ts";

// `collie hooks install codex --native` and its uninstall and status: Codex's own hooks in
// `$CODEX_HOME/hooks.json`. The merge is a pure function of the document, so its rules are pinned
// directly; the verbs are then asserted for the file they write, the file they refuse, and what the
// operator reads. Nothing here reaches a real `~/.codex`: the files and the link probe are fakes.

const CODEX_DIR = join(HOME, ".codex");
const HOOKS = join(CODEX_DIR, "hooks.json");
const BACKUP = `${HOOKS}.collie-backup`;
const CONFIG = join(CODEX_DIR, "config.toml");
/** This checkout's compiled binary, which an install pins to when nothing is published on PATH. */
const OWN = collieBinary(ROOT);
const MOVED = join("/srv", "old-checkout", "bin", "collie");
const EVENTS = CODEX_HOOK_EVENTS.map((row) => row.event);

/** A handler the OPERATOR wrote. Nothing Collie does may touch it, move it or remove it. */
const THEIRS = { hooks: [{ type: "command", command: "/usr/local/bin/ding.sh", timeout: 5 }] };

function deps(over: { env?: Environment; files?: Record<string, string> } = {}): HooksDeps & {
  io: ReturnType<typeof capture>;
  files: ReturnType<typeof fakeFiles>;
  fs: ReturnType<typeof fakeLinkFs>;
} {
  return { ctx: context(over.env ?? {}), io: capture(), files: fakeFiles(over.files ?? {}), fs: fakeLinkFs(), harnessVersion: () => "0.167.0" };
}

/** The groups of one event in a document. */
function groupsOf(document: JsonValue | null, event: string): JsonValue[] {
  const groups = asJsonObject(asJsonObject(document ?? undefined)?.hooks)?.[event];
  return Array.isArray(groups) ? groups : [];
}

/** A planned document, or a failed test. */
function planned(current: JsonValue | null, binary = OWN): JsonObject {
  const plan = planNativeInstall(current, binary);
  if (plan.kind !== "plan") throw new Error(`refused: ${plan.reason}`);
  return plan.document;
}

describe("codex native: the command and who owns it", () => {
  test("codex native: hooks.json lives in CODEX_HOME, else ~/.codex", () => {
    expect(hooksJsonPath(context({}))).toBe(HOOKS);
    expect(hooksJsonPath(context({ CODEX_HOME: join("/lab", "codex-home") }))).toBe(join("/lab", "codex-home", "hooks.json"));
  });

  test("codex native: the command is the binary as one shell word, the verb, and the marker", () => {
    expect(nativeCommand("/home/pat/.local/bin/collie")).toBe("'/home/pat/.local/bin/collie' beacon codex-hook # collie-codex v1");
  });

  test("codex native: a binary with a space or a quote reads back as itself", () => {
    for (const binary of ["/Users/pat/My Tools/collie", "/srv/pat's/collie", OWN]) {
      expect(ownedHandler(nativeCommand(binary))).toEqual({ binary, version: 1 });
    }
  });

  test("codex native: a command of another shape is not ours, however close", () => {
    for (const command of ["/usr/local/bin/ding.sh", "'/x/collie' beacon emit # collie-codex v1", "'/x/collie' beacon codex-hook", "/x/collie beacon codex-hook # collie-codex v1"]) {
      expect(ownedHandler(command)).toBeNull();
    }
    expect(ownedHandler(7)).toBeNull();
  });
});

describe("codex native: the install plan", () => {
  test("codex native: an absent file gets one group per event, with the command and its timeout", () => {
    const document = planned(null);
    expect(Object.keys(asJsonObject(document.hooks) ?? {})).toEqual(EVENTS);
    for (const row of CODEX_HOOK_EVENTS) {
      expect(groupsOf(document, row.event)).toEqual([{ hooks: [{ type: "command", command: nativeCommand(OWN), timeout: row.timeout }] }]);
    }
    expect(groupsOf(document, "SessionEnd")).toEqual([{ hooks: [{ type: "command", command: nativeCommand(OWN), timeout: 3 }] }]);
  });

  test("codex native: every other key and handler stays, and ours goes LAST, so no other entry moves", () => {
    const current = { version: 1, hooks: { Stop: [THEIRS], PreToolUse: [THEIRS] } };
    const document = planned(current);
    expect(document.version).toBe(1);
    expect(groupsOf(document, "PreToolUse")).toEqual([THEIRS]);
    expect(groupsOf(document, "Stop")).toEqual([THEIRS, { hooks: [{ type: "command", command: nativeCommand(OWN), timeout: 10 }] }]);
  });

  test("codex native: the same install twice is the same bytes", () => {
    const once = planned({ hooks: { Stop: [THEIRS] } });
    expect(serializeHooks(planned(once))).toBe(serializeHooks(once));
  });

  test("codex native: a moved binary is re-pointed in its own slot, and an operator's handler beside it stays", () => {
    const old = { type: "command", command: nativeCommand(MOVED), timeout: 10 };
    const current = { hooks: { Stop: [{ hooks: [old, THEIRS.hooks[0]!] }, THEIRS] } };
    expect(groupsOf(planned(current), "Stop")).toEqual([{ hooks: [{ type: "command", command: nativeCommand(OWN), timeout: 10 }, THEIRS.hooks[0]!] }, THEIRS]);
  });

  test("codex native: an older marker heals in place", () => {
    const older = "'/x/collie' beacon codex-hook # collie-codex v0";
    expect(ownedHandler(older)).toEqual({ binary: "/x/collie", version: 0 });
    const current = { hooks: { Stop: [{ hooks: [{ type: "command", command: older }] }] } };
    expect(groupsOf(planned(current), "Stop")).toEqual([{ hooks: [{ type: "command", command: nativeCommand(OWN), timeout: 10 }] }]);
  });

  test("codex native: a file of another shape, or two of ours on one event, is refused", () => {
    const ours = { hooks: [{ type: "command", command: nativeCommand(OWN) }] };
    const cases: [JsonValue, string][] = [
      [[], "top level"],
      [{ hooks: [] }, "`hooks`"],
      [{ hooks: { Stop: {} } }, "hooks.Stop"],
      [{ hooks: { Stop: [ours, ours] } }, "2 Collie entries on Stop"],
    ];
    for (const [current, reason] of cases) {
      const plan = planNativeInstall(current, OWN);
      expect(plan.kind).toBe("refuse");
      expect(plan.kind === "refuse" ? plan.reason : "").toContain(reason);
    }
  });
});

describe("codex native: the uninstall plan", () => {
  test("codex native: ours go, the operator's stay, and an event or a section left empty goes too", () => {
    const installed = planned({ model: "x", hooks: { Stop: [THEIRS], PreToolUse: [THEIRS] } });
    const removal = planNativeUninstall(installed);
    expect(removal.removed).toBe(EVENTS.length);
    expect(removal.document).toEqual({ model: "x", hooks: { Stop: [THEIRS], PreToolUse: [THEIRS] } });
    expect(planNativeUninstall(planned(null))).toEqual({ document: {}, removed: EVENTS.length });
  });

  test("codex native: a group shared with the operator's handler keeps that handler", () => {
    const current = { hooks: { Stop: [{ matcher: "x", hooks: [THEIRS.hooks[0]!, { type: "command", command: nativeCommand(OWN) }] }] } };
    expect(planNativeUninstall(current).document).toEqual({ hooks: { Stop: [{ matcher: "x", hooks: [THEIRS.hooks[0]!] }] } });
  });

  test("codex native: a document with nothing of ours comes back unchanged", () => {
    const current = { hooks: { Stop: [THEIRS] } };
    expect(planNativeUninstall(current)).toEqual({ document: current, removed: 0 });
    expect(planNativeUninstall([])).toEqual({ document: [], removed: 0 });
  });
});

describe("codex native: the verdict status and doctor read", () => {
  test("codex native: not installed, partly installed, two on one event, another binary, an older marker, installed", () => {
    const full = planned({ hooks: { Stop: [THEIRS] } });
    expect(nativeStateOf(null, OWN)).toEqual({ kind: "not-installed" });
    expect(nativeStateOf({ hooks: { Stop: [THEIRS] } }, OWN)).toEqual({ kind: "not-installed" });
    expect(nativeStateOf({ hooks: { Stop: groupsOf(full, "Stop") } }, OWN)).toEqual({ kind: "partial", missing: ["SessionStart", "UserPromptSubmit", "SessionEnd"] });
    const ours = { hooks: [{ type: "command", command: nativeCommand(OWN) }] };
    expect(nativeStateOf({ hooks: { ...asJsonObject(full.hooks), Stop: [ours, ours] } }, OWN)).toEqual({ kind: "duplicate", event: "Stop" });
    expect(nativeStateOf(full, MOVED)).toEqual({ kind: "behind", binary: OWN, version: 1 });
    expect(nativeStateOf(full, OWN)).toEqual({ kind: "installed", binary: OWN });
  });

  test("codex native: the bridge's probe says yes for one handler of ours, and no for anything else", () => {
    expect(documentCarriesNativeHooks(serializeHooks(planned(null)))).toBe(true);
    expect(documentCarriesNativeHooks(JSON.stringify({ hooks: { Stop: [THEIRS] } }))).toBe(false);
    for (const text of ["", "{", "[]", "null", '{"hooks":"yes"}', '{"hooks":{"Stop":"no"}}']) {
      expect(documentCarriesNativeHooks(text)).toBe(false);
    }
  });
});

describe.skipIf(HOST.platform === "win32")("codex native: the verbs", () => {
  const OPERATOR = serializeHooks({ hooks: { Stop: [THEIRS] } });

  test("codex native: install writes hooks.json, says how Codex comes to run it, and leaves config.toml alone", () => {
    const d = deps({ files: { [CONFIG]: 'model = "gpt-6-luna"\n' } });
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    expect(nativeStateOf(JSON.parse(d.files.read(HOOKS)!), OWN)).toEqual({ kind: "installed", binary: OWN });
    expect(d.files.read(CONFIG)).toBe('model = "gpt-6-luna"\n');
    // No file was there, so there was nothing to back up.
    expect(d.files.exists(BACKUP)).toBe(false);
    const said = d.io.stdout.join("\n");
    expect(said).toContain("Hooks need review");
    expect(said).toContain("codex --no-daemon");
    expect(said).toContain(`${OWN} beacon codex-hook`);
  });

  test("codex native: install keeps the operator's hook, backs the file up once, and a second run writes nothing", () => {
    const d = deps({ files: { [HOOKS]: OPERATOR } });
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    const once = d.files.read(HOOKS)!;
    expect(groupsOf(JSON.parse(once), "Stop")[0]).toEqual(THEIRS);
    expect(d.files.read(BACKUP)).toBe(OPERATOR);
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    expect(d.files.read(HOOKS)).toBe(once);
    expect(d.io.stdout.join("\n")).toContain("No bytes changed");
  });

  test("codex native: uninstall gives the operator's bytes back, and removes a file the install created", () => {
    const theirs = deps({ files: { [HOOKS]: OPERATOR } });
    cmdHooksInstall(theirs, ["codex", NATIVE_FLAG]);
    expect(cmdHooksUninstall(theirs, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    expect(theirs.files.read(HOOKS)).toBe(OPERATOR);
    const fresh = deps();
    cmdHooksInstall(fresh, ["codex", NATIVE_FLAG]);
    expect(cmdHooksUninstall(fresh, ["codex"])).toBe(EXIT.OK);
    expect(fresh.files.exists(HOOKS)).toBe(false);
    expect(fresh.io.stdout.join("\n")).toContain("The install had created it");
  });

  test("codex native: `uninstall codex --native` leaves the notify line; `uninstall codex` removes both", () => {
    const both = deps({ files: { [HOOKS]: OPERATOR } });
    cmdHooksInstall(both, ["codex"]);
    cmdHooksInstall(both, ["codex", NATIVE_FLAG]);
    const notify = both.files.read(CONFIG)!;
    expect(cmdHooksUninstall(both, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    expect(both.files.read(CONFIG)).toBe(notify);
    expect(both.files.read(HOOKS)).toBe(OPERATOR);
    cmdHooksInstall(both, ["codex", NATIVE_FLAG]);
    expect(cmdHooksUninstall(both, ["codex"])).toBe(EXIT.OK);
    expect(both.files.exists(CONFIG)).toBe(false);
    expect(both.files.read(HOOKS)).toBe(OPERATOR);
  });

  test("codex native: a symlinked file, a file that is not JSON and two entries of ours are refused untouched", () => {
    const linked = deps();
    linked.fs.entries.set(HOOKS, { kind: "symlink", target: "/dotfiles/hooks.json" });
    expect(cmdHooksInstall(linked, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(linked.io.stderr.join("\n")).toContain("is a symlink");
    expect(linked.files.entries.size).toBe(0);
    const broken = deps({ files: { [HOOKS]: "{ oops" } });
    expect(cmdHooksInstall(broken, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(broken.files.read(HOOKS)).toBe("{ oops");
    const ours = { hooks: [{ type: "command", command: nativeCommand(OWN) }] };
    const twice = serializeHooks({ hooks: { Stop: [ours, ours] } });
    const dup = deps({ files: { [HOOKS]: twice } });
    expect(cmdHooksInstall(dup, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(dup.files.read(HOOKS)).toBe(twice);
  });

  test("codex native: a file that changes while the install writes is left as the other writer left it", () => {
    const d = deps({ files: { [HOOKS]: OPERATOR } });
    const write = d.files.write;
    const theirsNow = serializeHooks({ hooks: { Stop: [THEIRS, THEIRS] } });
    d.files.write = (path, text, mode) => {
      write(path, text, mode);
      // Codex, or the operator's editor, saves the file between Collie's temp write and its rename.
      if (path.endsWith(".collie-tmp")) write(HOOKS, theirsNow);
    };
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(d.files.read(HOOKS)).toBe(theirsNow);
    expect(d.files.exists(`${HOOKS}.collie-tmp`)).toBe(false);
    expect(d.io.stderr.join("\n")).toContain("Nothing was written");
  });

  test("codex native: a hooks file that is there but cannot be read is refused by install, uninstall and status, untouched", () => {
    const d = deps({ files: { [HOOKS]: OPERATOR } });
    const read = d.files.read;
    // A file the operator's user may not read: the entry is there, every read of it fails.
    d.files.read = (path) => (path === HOOKS ? null : read(path));
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("cannot read it");
    expect(cmdHooksUninstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`${HOOKS}: unreadable, Collie cannot read the file`);
    expect(read(HOOKS)).toBe(OPERATOR);
    expect(d.files.exists(BACKUP)).toBe(false);
    expect(d.files.exists(`${HOOKS}.collie-tmp`)).toBe(false);
  });

  test("codex native: a file that is not JSON reads as invalid in status, not as unreadable", () => {
    const d = deps({ files: { [HOOKS]: "{ oops" } });
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`${HOOKS}: not valid JSON`);
  });

  test("codex native: a file the install created is not removed when someone saved a hook into it meanwhile", () => {
    const d = deps();
    cmdHooksInstall(d, ["codex", NATIVE_FLAG]);
    const read = d.files.read;
    const write = d.files.write;
    const theirsNow = serializeHooks({ hooks: { Stop: [THEIRS] } });
    let first = true;
    d.files.read = (path) => {
      const text = read(path);
      // The operator's editor saves a hook of theirs right after the uninstall read the file.
      if (path === HOOKS && first) {
        first = false;
        write(HOOKS, theirsNow);
      }
      return text;
    };
    expect(cmdHooksUninstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(read(HOOKS)).toBe(theirsNow);
    expect(d.io.stderr.join("\n")).toContain("Nothing was removed");
    // Run again, the uninstall reads the file as it is now and takes out nothing of theirs.
    d.files.read = read;
    expect(cmdHooksUninstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.OK);
    expect(read(HOOKS)).toBe(theirsNow);
  });

  test("codex native: no permission hold, and no option but --native", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG, "--hold-permissions"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("`codex` has no permission hold. Run `collie hooks install codex --native` without `--hold-permissions`.");
    expect(cmdHooksInstall(d, ["codex", "--with-moshi"])).toBe(EXIT.USAGE);
    expect(cmdHooksUninstall(d, ["codex", "--everything"])).toBe(EXIT.USAGE);
    expect(cmdHooksInstall(d, ["claude", NATIVE_FLAG])).toBe(EXIT.USAGE);
    expect(d.files.entries.size).toBe(0);
  });

  test("codex native: status names the hooks file, before and after, and reads only", () => {
    const d = deps();
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`${HOOKS}: no hooks file. \`collie hooks install codex --native\` creates one`);
    cmdHooksInstall(d, ["codex", NATIVE_FLAG]);
    d.io.stdout.length = 0;
    const before = d.files.read(HOOKS);
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`${HOOKS}: native hooks installed. Codex runs them once you trust them`);
    expect(d.files.read(HOOKS)).toBe(before);
    d.files.write(HOOKS, serializeHooks(planned(null, MOVED)));
    d.io.stdout.length = 0;
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`native hooks installed for ${MOVED}`);
  });
});

describe.skipIf(HOST.platform !== "win32")("codex native: on Windows", () => {
  test("codex native: the install refuses, because its command is a POSIX shell line", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["codex", NATIVE_FLAG])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
  });
});
