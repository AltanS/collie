import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { BEACON_HOOKS } from "./beacon.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, posixKey, ROOT, STATE } from "./fakes.ts";
import {
  claudeSettingsTargets,
  cmdHooksInstall,
  cmdHooksStatus,
  cmdHooksUninstall,
  HOLD_FLAG,
  hooksAreBehind,
  HOOK_MARKER,
  HOOK_MARKER_PREFIX,
  type HooksDeps,
  installDocument,
  markedCommandIn,
  resolveHookCommand,
  serializeSettings,
  uninstallDocument,
} from "./hooks.ts";
import { codexConfigPath, installNotify, notifyState } from "./codex-hooks.ts";
import { wrapCommand } from "./statusline.ts";
import { HOST } from "../bridge/host.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";
import { collieBinary } from "./unit.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { asJsonObject } from "../web/src/lib/json.ts";
import { HOLD_CONNECT_MS, HOLD_GRACE_MS } from "../web/src/lib/surface/hold.ts";
import { loadProfiles } from "../web/src/lib/surface/profile.ts";
import { hookTargetFileName } from "../bridge/beacon/hook-targets.ts";
import { cmdBeaconHold, holdSocketPath, holdSocketPaths, type HoldDeps, type HoldSocket } from "./hold.ts";
import { HOLD_MARKER_PREFIX, holdCommandIn, settingsHold } from "./hold-entry.ts";

// `collie hooks install|uninstall|status`. Every decision is a pure function of the document on disk,
// so the merge rules are pinned directly; the verbs are then asserted for what they DO — which file
// is written, which is refused untouched, and what the operator reads.
//
// Nothing here may reach a real `~/.claude`: the filesystem and the symlink probe are both fakes.

// Paths the code under test BUILDS are spelled the way it builds them (`join`), so the expectation
// holds on Windows too, where a join comes back with backslashes. The fake filesystems fold every key
// to POSIX (`posixKey`), so a seed may use either spelling; only a recorded op log needs folding.
const CLAUDE_DIR = join(HOME, ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const BACKUP = `${SETTINGS}.collie-backup`;
const PUBLISHED = join(HOME, ".local", "bin", "collie");
/** This checkout's compiled binary: `bin/collie` on POSIX, `bin/collie.exe` on Windows. */
const OWN = collieBinary(ROOT);
const COMMAND = `${OWN} beacon emit ${HOOK_MARKER}`;
/** A second Claude profile, named by `COLLIE_TRANSCRIPT_ROOT`, and the settings file beside its journal. */
const OPS_PROFILE = join("/srv", "ops");
const OPS_SETTINGS = join(OPS_PROFILE, "settings.json");
/** Where a stow/chezmoi-style `~/.claude` link points. */
const DOTFILES = join("/dotfiles", "claude");
/** A path segment that only a version directory has — the hook command must never contain it. */
const VERSIONS_SEGMENT = /[/\\]versions[/\\]/;

/** A hook the OPERATOR wrote. Nothing Collie does may touch it, read it, or move it. */
const THEIRS = { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] };

function deps(
  over: { env?: Environment; files?: Record<string, string>; linked?: boolean } = {},
): HooksDeps & {
  io: ReturnType<typeof capture>;
  files: ReturnType<typeof fakeFiles>;
  fs: ReturnType<typeof fakeLinkFs>;
} {
  const io = capture();
  const files = fakeFiles(over.files ?? {});
  const fs = fakeLinkFs(over.linked === true ? { [PUBLISHED]: { kind: "symlink", target: OWN } } : {});
  // No test runs the real harness: its version is what the lab ran.
  return { ctx: context(over.env ?? {}), io, files, fs, harnessVersion: () => "2.1.301" };
}

const settingsOf = (d: ReturnType<typeof deps>, path = SETTINGS): JsonValue =>
  JSON.parse(d.files.entries.get(path)?.text ?? "null");

describe("the targets", () => {
  test("are ~/.claude, plus one per configured Claude journal root (issue #92)", () => {
    const work = join("/srv", "work");
    const roots = [join(work, "projects"), join(OPS_PROFILE, "projects")].join(",");
    expect(claudeSettingsTargets(context({ COLLIE_TRANSCRIPT_ROOT: roots }))).toEqual([
      { dir: CLAUDE_DIR, path: SETTINGS },
      { dir: work, path: join(work, "settings.json") },
      { dir: OPS_PROFILE, path: OPS_SETTINGS },
    ]);
  });

  test("never name a project settings file, and never repeat one", () => {
    const targets = claudeSettingsTargets(context({ COLLIE_TRANSCRIPT_ROOT: join(CLAUDE_DIR, "projects") }));
    expect(targets).toEqual([{ dir: CLAUDE_DIR, path: SETTINGS }]);
    for (const target of targets) expect(target.path).not.toContain("settings.local.json");
  });
});

describe("the command it writes", () => {
  test("is the published PATH name when it points at this checkout — a pointer, not a copy (ADR 0021)", () => {
    const d = deps({ linked: true });
    expect(resolveHookCommand(d.ctx, d.fs)).toEqual({
      binary: PUBLISHED,
      source: "path-link",
      command: `${PUBLISHED} beacon emit ${HOOK_MARKER}`,
    });
  });

  test("falls back to the checkout binary — absolute either way, because a hook has no login shell", () => {
    const d = deps();
    expect(resolveHookCommand(d.ctx, d.fs)).toEqual({ binary: OWN, source: "checkout", command: COMMAND });
    expect(isAbsolute(OWN)).toBe(true);
  });

  test("is pinned to the checkout when the published name is somebody else's", () => {
    const d = deps();
    d.fs.entries.set(PUBLISHED, { kind: "symlink", target: "/opt/collie-v1/bin/collie" });
    expect(resolveHookCommand(d.ctx, d.fs).source).toBe("checkout");
  });

  // ── A binary install: the hook must survive `collie update` (issue: dangling versioned hooks) ──
  //
  // The layout is `<root>/versions/X.Y.Z` with a `current` symlink beside it, and `update` keeps only
  // the PREVIOUS version — so a hook pinned to `versions/1.0.0-beta.49/bin/collie` is deleted out from
  // under itself after one or two updates and fires into nothing, silently. Nothing here may write a
  // `versions/` path.

  // `resolve`, not `join`: `publishedBinary` compares `resolve`d paths, and on Windows a resolved path
  // carries a drive. A root spelled without one would never equal its own `versions/` directory.
  const INSTALL_ROOT = resolve(HOME, ".local", "share", "collie");
  const VERSION_ROOT = join(INSTALL_ROOT, "versions", "1.0.0-beta.49");
  // `collieBinary`, not a bare `collie`: the published binary is `collie.exe` on Windows.
  const VERSIONED = collieBinary(VERSION_ROOT);
  const CURRENT = collieBinary(join(INSTALL_ROOT, "current"));

  /** A binary install: the process runs from the version directory, `current` points at it. */
  function binaryDeps(published?: string): ReturnType<typeof deps> {
    const d = deps();
    const ctx = context({}, { root: VERSION_ROOT });
    d.fs.entries.set(`${INSTALL_ROOT}/current`, { kind: "symlink", target: VERSION_ROOT });
    if (published !== undefined) d.fs.entries.set(PUBLISHED, { kind: "symlink", target: published });
    return { ...d, ctx };
  }

  test("on a binary install, prefers the published name — which resolves THROUGH `current` (realpath, not string equality)", () => {
    const d = binaryDeps(CURRENT);
    expect(resolveHookCommand(d.ctx, d.fs)).toEqual({
      binary: PUBLISHED,
      source: "path-link",
      command: `${PUBLISHED} beacon emit ${HOOK_MARKER}`,
    });
  });

  test("on a binary install with no published name, writes `current/bin/collie` — never the version directory", () => {
    const d = binaryDeps();
    const resolved = resolveHookCommand(d.ctx, d.fs);
    expect(resolved).toEqual({
      binary: CURRENT,
      source: "install-current",
      command: `${CURRENT} beacon emit ${HOOK_MARKER}`,
    });
    expect(resolved.command).not.toMatch(VERSIONS_SEGMENT);
  });

  test("a published name pointing straight at THIS version is still the published name, not the version path", () => {
    const d = binaryDeps(VERSIONED);
    const resolved = resolveHookCommand(d.ctx, d.fs);
    expect(resolved.binary).toBe(PUBLISHED);
    expect(resolved.command).not.toMatch(VERSIONS_SEGMENT);
  });

  test("a published name left over at a GC'd version falls back to `current`, never to the dangling path", () => {
    const d = binaryDeps(collieBinary(join(INSTALL_ROOT, "versions", "1.0.0-beta.47")));
    expect(resolveHookCommand(d.ctx, d.fs).binary).toBe(CURRENT);
  });

  test("a published name belonging to another install is refused on a binary install too", () => {
    const d = binaryDeps("/opt/collie-v1/bin/collie");
    expect(resolveHookCommand(d.ctx, d.fs).binary).toBe(CURRENT);
  });

  test("re-installing REPLACES a marked entry whose command is a stale versioned path", () => {
    const stale = `${VERSIONED} beacon emit ${HOOK_MARKER}`;
    const before: JsonValue = { hooks: { Stop: [THEIRS, { hooks: [{ type: "command", command: stale, timeout: 10 }] }] } };
    const outcome = installDocument(before, `${CURRENT} beacon emit ${HOOK_MARKER}`);
    const stop = outcome.kind === "document" ? JSON.parse(serializeSettings(outcome.document)).hooks.Stop : [];
    // The operator's own entry keeps its place; ours is replaced where it stood, not appended.
    expect(stop[0]).toEqual(THEIRS);
    expect(stop).toHaveLength(2);
    expect(markedCommandIn(stop[1])).toBe(`${CURRENT} beacon emit ${HOOK_MARKER}`);
    expect(JSON.stringify(stop)).not.toMatch(VERSIONS_SEGMENT);
  });

  test("carries a version-prefixed ownership marker", () => {
    expect(HOOK_MARKER).toMatch(/# collie-beacon v\d+$/);
    expect(markedCommandIn({ hooks: [{ type: "command", command: COMMAND }] })).toBe(COMMAND);
    expect(markedCommandIn({ hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] })).toBeNull();
    expect(markedCommandIn("not a group")).toBeNull();
  });
});

describe("the merge", () => {
  test("adds exactly the registered events, with no Notification matcher", () => {
    const outcome = installDocument(null, COMMAND);
    expect(outcome.kind).toBe("document");
    const text = outcome.kind === "document" ? serializeSettings(outcome.document) : "";
    const hooks = JSON.parse(text).hooks;
    expect(Object.keys(hooks)).toEqual(BEACON_HOOKS.map((r) => r.event));
    // No matcher since M56 spec 11: the dialog kinds are hook edges too, and the emitter picks the kinds.
    expect(hooks.Notification[0].matcher).toBeUndefined();
    // A registration with no matcher writes no `matcher` key at all — not `null`, not `""`.
    expect(Object.keys(hooks.UserPromptSubmit[0])).toEqual(["hooks"]);
    expect(hooks.Stop[0].hooks).toEqual([{ type: "command", command: COMMAND, timeout: 10 }]);
  });

  test("never clobbers an unmarked entry, and never reorders one", () => {
    const before: JsonValue = { hooks: { Stop: [THEIRS, { hooks: [{ type: "command", command: "b.sh" }] }] } };
    const outcome = installDocument(before, COMMAND);
    const stop = outcome.kind === "document" ? JSON.parse(serializeSettings(outcome.document)).hooks.Stop : [];
    expect(stop.slice(0, 2)).toEqual([THEIRS, { hooks: [{ type: "command", command: "b.sh" }] }]);
    expect(markedCommandIn(stop[2])).toBe(COMMAND);
  });

  test("keeps every other setting in the file", () => {
    const outcome = installDocument({ model: "opus", permissions: { allow: ["Bash"] } }, COMMAND);
    const document = outcome.kind === "document" ? JSON.parse(serializeSettings(outcome.document)) : {};
    expect(document.model).toBe("opus");
    expect(document.permissions).toEqual({ allow: ["Bash"] });
  });

  test("replaces a stale marker version IN PLACE — the self-heal that does not reorder", () => {
    const stale = { hooks: [{ type: "command", command: "/old/bin/collie beacon emit # collie-beacon v0" }] };
    const outcome = installDocument({ hooks: { Stop: [stale, THEIRS] } }, COMMAND);
    const stop = outcome.kind === "document" ? JSON.parse(serializeSettings(outcome.document)).hooks.Stop : [];
    expect(markedCommandIn(stop[0])).toBe(COMMAND);
    expect(stop[1]).toEqual(THEIRS);
    expect(stop).toHaveLength(2);
  });

  test("refuses a document it cannot merge into rather than replacing it", () => {
    expect(installDocument(["not an object"], COMMAND).kind).toBe("refuse");
    expect(installDocument({ hooks: "off" }, COMMAND).kind).toBe("refuse");
    expect(installDocument({ hooks: { Stop: "off" } }, COMMAND).kind).toBe("refuse");
  });

  test("uninstall removes only marked entries", () => {
    const installed = installDocument({ hooks: { Stop: [THEIRS] } }, COMMAND);
    const document = installed.kind === "document" ? installed.document : {};
    const removed = uninstallDocument(document);
    expect(removed.kind === "document" ? removed.document : {}).toEqual({ hooks: { Stop: [THEIRS] } });
  });

  test("uninstall leaves no empty `hooks` section behind when it made it empty", () => {
    const installed = installDocument({ model: "opus" }, COMMAND);
    const removed = uninstallDocument(installed.kind === "document" ? installed.document : {});
    expect(removed.kind === "document" ? removed.document : {}).toEqual({ model: "opus" });
  });
});

describe("install", () => {
  test("creates a settings file that did not exist, and says what it registered", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const hooks = JSON.parse(d.files.entries.get(SETTINGS)!.text).hooks;
    expect(Object.keys(hooks)).toEqual(BEACON_HOOKS.map((r) => r.event));
    expect(d.io.stdout.join("\n")).toContain("UserPromptSubmit");
    expect(d.io.stdout.join("\n")).toContain(join(HOME, ".local", "state", "collie", "hook-targets"));
    expect(d.io.stdout.join("\n")).not.toMatch(/Restart them/u);
    expect(d.io.stderr).toEqual([]);
  });

  test("is atomic — the live file is renamed into place, never written through", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude"]);
    expect(d.files.ops.filter((op) => op.startsWith("mv "))).toEqual([`mv ${posixKey(`${SETTINGS}.collie-tmp`)} ${posixKey(SETTINGS)}`]);
    expect([...d.files.entries.keys()].filter((p) => p.endsWith(".collie-tmp"))).toEqual([]);
  });

  test("backs the file up once, with the ORIGINAL bytes, before the first modification", () => {
    const original = `{"model":"opus"}\n`;
    const d = deps({ files: { [SETTINGS]: original } });
    cmdHooksInstall(d, ["claude"]);
    expect(d.files.entries.get(BACKUP)?.text).toBe(original);
    // A later modification does not take a second backup — the first is the one worth keeping.
    const moved = { ...d, ctx: context({}, { root: "/opt/collie-2" }) };
    cmdHooksInstall(moved, ["claude"]);
    expect(d.files.entries.get(BACKUP)?.text).toBe(original);
  });

  test("is idempotent: the second run changes no bytes and writes nothing", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude"]);
    const after = d.files.entries.get(SETTINGS)!.text;
    d.files.ops.length = 0;
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.entries.get(SETTINGS)!.text).toBe(after);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("no bytes changed");
  });

  test("adds an event an OLDER build never registered, and leaves the ones it did where they are", () => {
    // What `~/.claude/settings.json` looks like after an install from a build whose BEACON_HOOKS was
    // missing today's first row — the `SessionStart` case, expressed so it survives the next row too.
    const [missing, ...older] = BEACON_HOOKS;
    const previous = serializeSettings({
      hooks: Object.fromEntries(
        older.map((r) => [r.event, [THEIRS, { matcher: r.matcher, hooks: [{ type: "command", command: COMMAND }] }]]),
      ),
    });
    const d = deps({ files: { [SETTINGS]: previous } });

    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const hooks = JSON.parse(d.files.entries.get(SETTINGS)!.text).hooks;
    expect(markedCommandIn(hooks[missing!.event][0])).toBe(COMMAND);
    for (const r of older) {
      expect(hooks[r.event][0]).toEqual(THEIRS);
      expect(markedCommandIn(hooks[r.event][1])).toBe(COMMAND);
      expect(hooks[r.event]).toHaveLength(2);
    }
    // Reconciled, not re-installed: the marker version never moved, and a second run changes nothing.
    expect(d.files.entries.get(SETTINGS)!.text).toContain(HOOK_MARKER);
    d.files.ops.length = 0;
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("no bytes changed");
  });

  test("heals an installed v1 entry that predates `timeout` — the command did not change, only the sibling field", () => {
    // Every event carries a v1 entry with no `timeout`, exactly what an older build wrote, plus one
    // operator row that must survive untouched.
    const previous = serializeSettings({
      hooks: Object.fromEntries(
        BEACON_HOOKS.map((r) => [r.event, [THEIRS, { matcher: r.matcher, hooks: [{ type: "command", command: COMMAND }] }]]),
      ),
    });
    const d = deps({ files: { [SETTINGS]: previous } });

    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const hooks = JSON.parse(d.files.entries.get(SETTINGS)!.text).hooks;
    for (const r of BEACON_HOOKS) {
      expect(hooks[r.event][0]).toEqual(THEIRS);
      expect(hooks[r.event][1].hooks[0]).toEqual({ type: "command", command: COMMAND, timeout: 10 });
      expect(hooks[r.event]).toHaveLength(2);
    }
    // Still v1 — the command string is unchanged, so no marker bump was needed to heal this.
    expect(d.files.entries.get(SETTINGS)!.text).toContain(HOOK_MARKER);

    // A second run changes no bytes.
    d.files.ops.length = 0;
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("no bytes changed");
  });

  test("writes every configured profile, not just ~/.claude", () => {
    const d = deps({ env: { COLLIE_TRANSCRIPT_ROOT: join(OPS_PROFILE, "projects") } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.entries.has(SETTINGS)).toBe(true);
    expect(d.files.entries.has(OPS_SETTINGS)).toBe(true);
  });

  test("refuses a symlinked settings file, untouched, with a remedy", () => {
    const d = deps({ files: { [SETTINGS]: "{}\n" } });
    d.fs.entries.set(SETTINGS, { kind: "symlink", target: join("/elsewhere", "settings.json") });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.get(SETTINGS)!.text).toBe("{}\n");
    expect(d.io.stderr.join("\n")).toContain("is a symlink");
    expect(d.io.stderr.join("\n")).toContain("re-run");
  });

  test("writes through a symlinked parent directory (stow, chezmoi) — install and uninstall both follow it", () => {
    const d = deps();
    d.fs.entries.set(CLAUDE_DIR, { kind: "symlink", target: DOTFILES });
    d.fs.entries.set(DOTFILES, { kind: "other", what: "a directory" });

    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.entries.has(join(DOTFILES, "settings.json"))).toBe(true);
    expect(d.files.entries.has(SETTINGS)).toBe(false);

    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    expect(settingsOf(d, join(DOTFILES, "settings.json"))).toEqual({});
  });

  test("a dangling directory link fails with a worded error, never a raw write error (#190)", () => {
    const d = deps();
    d.fs.entries.set(CLAUDE_DIR, { kind: "symlink", target: DOTFILES });
    // The dotfiles directory is never seeded, so the fake reports it absent — the link's target is gone,
    // the way an unmounted drive or a home-manager generation nobody built yet would read.
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    const said = d.io.stderr.join("\n");
    expect(said).toContain(CLAUDE_DIR);
    expect(said).toContain(DOTFILES);
    expect(said).toContain("does not exist");
    expect(said).toContain("re-run");
  });

  test("a resolved directory this process cannot write to fails with a worded error (#190)", () => {
    // Not meaningful against this fake (`writable` is a plain Set, not a real permission bit), but
    // matches the guard shape used elsewhere in this suite in case that ever changes.
    if (process.getuid?.() === 0) return;
    const d = deps();
    d.fs.entries.set(CLAUDE_DIR, { kind: "symlink", target: DOTFILES });
    d.fs.entries.set(DOTFILES, { kind: "other", what: "a directory" });
    d.files.readOnly.add(DOTFILES);
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
    const said = d.io.stderr.join("\n");
    expect(said).toContain(CLAUDE_DIR);
    expect(said).toContain(DOTFILES);
    expect(said).toContain("cannot write");
  });

  test("refuses a settings file that is not valid JSON rather than losing it", () => {
    const d = deps({ files: { [SETTINGS]: "{ oops" } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.get(SETTINGS)!.text).toBe("{ oops");
    expect(d.io.stderr.join("\n")).toContain("not valid JSON");
  });

  test("names the harness, and refuses an unknown one", () => {
    for (const args of [[], ["opencode"]]) {
      const d = deps();
      expect(cmdHooksInstall(d, args)).toBe(EXIT.USAGE);
      expect(d.files.entries.size).toBe(0);
      expect(d.io.stderr.join("\n")).toContain("collie hooks install {claude|codex}");
    }
  });
});

describe("codex: the notify setting in config.toml (M56 spec 13)", () => {
  const CODEX_DIR = join(HOME, ".codex");
  const CONFIG = join(CODEX_DIR, "config.toml");
  const LAB_HOME = join("/lab", "codex-home");
  const NOTIFY = `notify = ["${OWN.replace(/\\/g, "\\\\")}","beacon","emit","codex"]`;
  const OPERATOR = ['model = "gpt-6-luna"', 'approval_policy = "on-request"', "", "[projects.\"/srv/work\"]", 'trust_level = "trusted"', ""].join("\n");

  test("codex: the config lives in CODEX_HOME, else ~/.codex", () => {
    expect(codexConfigPath(context({}))).toBe(CONFIG);
    expect(codexConfigPath(context({ CODEX_HOME: LAB_HOME }))).toBe(join(LAB_HOME, "config.toml"));
  });

  test("codex: install puts one notify line at the top of the file, before the first statement, and backs the file up once", () => {
    const d = deps({ files: { [CONFIG]: OPERATOR } });
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
    const text = d.files.entries.get(CONFIG)!.text;
    expect(text.split("\n").slice(0, 4)).toEqual([NOTIFY, 'model = "gpt-6-luna"', 'approval_policy = "on-request"', ""]);
    expect(text).toContain('[projects."/srv/work"]');
    expect(d.files.entries.get(`${CONFIG}.collie-backup`)?.text).toBe(OPERATOR);
    expect(notifyState(text.split("\n"))).toMatchObject({ kind: "ours", binary: OWN });
  });

  test("codex: --hold-permissions is refused with a message, and nothing is written", () => {
    const d = deps({ files: { [CONFIG]: OPERATOR } });
    expect(cmdHooksInstall(d, ["codex", "--hold-permissions"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("`codex` has no permission hold. Run `collie hooks install codex` without `--hold-permissions`.");
    expect(d.files.entries.get(CONFIG)?.text).toBe(OPERATOR);
  });

  test("codex: installing twice changes no bytes, and uninstall gives the operator's bytes back", () => {
    const d = deps({ files: { [CONFIG]: OPERATOR } });
    cmdHooksInstall(d, ["codex"]);
    const once = d.files.entries.get(CONFIG)!.text;
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
    expect(d.files.entries.get(CONFIG)!.text).toBe(once);
    expect(d.io.stdout.join("\n")).toContain("No bytes changed");
    expect(cmdHooksUninstall(d, ["codex"])).toBe(EXIT.OK);
    expect(d.files.entries.get(CONFIG)!.text).toBe(OPERATOR);
  });

  test("codex: a notify command of the operator's own is refused, and the file is untouched", () => {
    const theirs = `notify = ["/usr/local/bin/ding.sh"]\n${OPERATOR}`;
    const d = deps({ files: { [CONFIG]: theirs } });
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.FAIL);
    expect(d.files.entries.get(CONFIG)!.text).toBe(theirs);
    expect(d.io.stderr.join("\n")).toContain("Codex runs one notify command");
    expect(cmdHooksUninstall(d, ["codex"])).toBe(EXIT.OK);
    expect(d.files.entries.get(CONFIG)!.text).toBe(theirs);
  });

  test("codex: a notify key inside a table is not the setting; a multi-line notify array is refused", () => {
    expect(notifyState(["[profiles.fast]", 'notify = ["x"]'])).toEqual({ kind: "none", insertAt: 0 });
    expect(installNotify('notify = [\n  "x",\n]\n', OWN)).toMatchObject({ refuse: expect.stringContaining("cannot read") });
  });

  test("codex: the line goes after the leading comments and blank lines, before the first key", () => {
    const text = ["# my Codex config", "# second comment", "", 'model = "gpt-6-luna"', ""].join("\n");
    const done = installNotify(text, OWN);
    expect(done).toEqual({ text: ["# my Codex config", "# second comment", "", NOTIFY, 'model = "gpt-6-luna"', ""].join("\n") });
  });

  test("codex: a nested multi-line array with `[` rows is one statement, not a table header (K4)", () => {
    const text = ["matrix = [", "  [1, 2],", "  [3, 4],", "]", 'model = "gpt-6-luna"', "", "[projects.x]", 'notify = ["inside a table"]', ""].join("\n");
    expect(notifyState(text.split("\n"))).toEqual({ kind: "none", insertAt: 0 });
    const done = installNotify(text, OWN);
    expect(done).toEqual({ text: `${NOTIFY}\n${text}` });
    // A notify after the array, before the first table, is the top-level setting.
    const theirs = ["matrix = [", "  [1, 2],", "]", 'notify = ["/bin/ding"]', "[projects.x]", ""].join("\n");
    expect(notifyState(theirs.split("\n"))).toMatchObject({ kind: "theirs", line: 3 });
  });

  test("codex: a multi-line string that holds a `[` row and a notify row is one statement (K4)", () => {
    const text = ['instructions = """', "Do this first.", "[not a table]", 'notify = ["not a setting"]', '"""', "literal = '''", "[also not a table]", "'''", 'model = "gpt-6-luna"', ""].join("\n");
    expect(notifyState(text.split("\n"))).toEqual({ kind: "none", insertAt: 0 });
    expect(installNotify(text, OWN)).toEqual({ text: `${NOTIFY}\n${text}` });
    const after = `${text}notify = ["/bin/ding"]\n`;
    expect(notifyState(after.split("\n"))).toMatchObject({ kind: "theirs", line: 9 });
  });

  test("codex: a table whose path starts with notify is refused with its line, and nothing is written (N1)", () => {
    for (const header of ["[notify]", "[notify.desktop]", '["notify".x]', "[[notify]]"]) {
      const text = ['model = "gpt-6-luna"', "", "[projects.x]", 'trust_level = "trusted"', "", header, 'sound = "ding"', ""].join("\n");
      const d = deps({ files: { [CONFIG]: text } });
      expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.FAIL);
      expect(d.io.stderr.join("\n")).toContain("table named notify at line 6");
      expect(d.files.entries.get(CONFIG)!.text).toBe(text);
      expect(d.files.entries.has(`${CONFIG}.collie-backup`)).toBe(false);
    }
    // A table that only starts with the same letters is no clash.
    expect(installNotify('[notifications]\nsound = "ding"\n', OWN)).toEqual({ text: `${NOTIFY}\n[notifications]\nsound = "ding"\n` });
  });

  test("codex: a file the scanner cannot read is refused with the line, and nothing is written (K4)", () => {
    for (const broken of ['matrix = [\n  1,\n', 'instructions = """\nno end\n', 'name = "no end\n', "x = ]\n"]) {
      const d = deps({ files: { [CONFIG]: broken } });
      expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.FAIL);
      expect(d.io.stderr.join("\n")).toMatch(/cannot read its TOML at line \d+/u);
      expect(d.files.entries.get(CONFIG)!.text).toBe(broken);
      expect(d.files.entries.has(`${CONFIG}.collie-backup`)).toBe(false);
    }
  });

  test("codex: uninstall gives back the exact bytes of a file with no final line break (K5)", () => {
    for (const original of ['model = "gpt-6-luna"', "# only a comment", '# a comment\nmodel = "x"\n[projects.y]\ntrust_level = "trusted"']) {
      const d = deps({ files: { [CONFIG]: original } });
      expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
      expect(d.files.entries.get(CONFIG)!.text).toContain(NOTIFY);
      expect(d.files.entries.get(CONFIG)!.text.endsWith("\n")).toBe(false);
      expect(cmdHooksUninstall(d, ["codex"])).toBe(EXIT.OK);
      expect(d.files.entries.get(CONFIG)!.text).toBe(original);
    }
  });

  test("codex: uninstall removes a file the install created, and keeps an empty file that was there (K5)", () => {
    const created = deps({ env: { CODEX_HOME: LAB_HOME } });
    const path = join(LAB_HOME, "config.toml");
    expect(cmdHooksInstall(created, ["codex"])).toBe(EXIT.OK);
    expect(cmdHooksUninstall(created, ["codex"])).toBe(EXIT.OK);
    expect(created.files.entries.has(path)).toBe(false);
    expect(created.io.stdout.join("\n")).toContain("The install had created it.");
    const empty = deps({ files: { [CONFIG]: "" } });
    expect(cmdHooksInstall(empty, ["codex"])).toBe(EXIT.OK);
    expect(cmdHooksUninstall(empty, ["codex"])).toBe(EXIT.OK);
    expect(empty.files.entries.get(CONFIG)?.text).toBe("");
  });

  test("codex: an old install for another binary is healed in place", () => {
    const old = `notify = ["/old/collie","beacon","emit","codex"]\n${OPERATOR}`;
    const d = deps({ files: { [CONFIG]: old } });
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
    expect(d.files.entries.get(CONFIG)!.text).toBe(`${NOTIFY}\n${OPERATOR}`);
  });

  test("codex: no config yet creates one with the line; a symlinked config is refused", () => {
    const d = deps({ env: { CODEX_HOME: LAB_HOME } });
    expect(cmdHooksInstall(d, ["codex"])).toBe(EXIT.OK);
    expect(d.files.entries.get(join(LAB_HOME, "config.toml"))?.text).toBe(`${NOTIFY}\n`);
    expect(d.files.entries.has(join(CONFIG))).toBe(false);
    const linked = deps();
    linked.fs.entries.set(CONFIG, { kind: "symlink", target: "/nix/store/config.toml" });
    expect(cmdHooksInstall(linked, ["codex"])).toBe(EXIT.FAIL);
    expect(linked.files.entries.size).toBe(0);
  });

  test("codex: status names the config file and what it carries, and installing Codex never touches Claude's settings", () => {
    const d = deps({ files: { [CONFIG]: OPERATOR } });
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain(`${CONFIG}: not installed`);
    cmdHooksInstall(d, ["codex"]);
    expect(d.files.entries.has(SETTINGS)).toBe(false);
    const after = deps({ files: { [CONFIG]: d.files.entries.get(CONFIG)!.text } });
    cmdHooksStatus(after);
    expect(after.io.stdout.join("\n")).toContain(`${CONFIG}: installed`);
  });
});

describe("uninstall", () => {
  test("removes only the marked entries, leaving the operator's own", () => {
    const d = deps({ files: { [SETTINGS]: serializeSettings({ hooks: { Stop: [THEIRS] }, model: "opus" }) } });
    cmdHooksInstall(d, ["claude"]);
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    expect(settingsOf(d)).toEqual({ model: "opus", hooks: { Stop: [THEIRS] } });
  });

  test("says so when there is nothing of ours anywhere", () => {
    const d = deps({ files: { [SETTINGS]: serializeSettings({ hooks: { Stop: [THEIRS] } }) } });
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain("nothing to remove");
    expect(d.files.ops).toEqual([]);
  });

  test("refuses to follow a symlink on the way out too", () => {
    const d = deps({ files: { [SETTINGS]: serializeSettings({ hooks: {} }) } });
    d.fs.entries.set(SETTINGS, { kind: "symlink", target: join("/elsewhere", "settings.json") });
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.FAIL);
  });
});

describe("status", () => {
  test("reports each target and writes absolutely nothing", () => {
    const d = deps({ env: { COLLIE_TRANSCRIPT_ROOT: join(OPS_PROFILE, "projects") } });
    expect(cmdHooksStatus(d)).toBe(EXIT.OK);
    const said = d.io.stdout.join("\n");
    expect(said).toContain(`${SETTINGS}: no settings file`);
    expect(said).toContain(`${OPS_SETTINGS}: no settings file`);
    expect(said).toContain(OWN);
    expect(d.files.entries.size).toBe(0);
    expect(d.files.ops).toEqual([]);
  });

  test("tells an installed file from an un-installed one", () => {
    const d = deps({ files: { [SETTINGS]: serializeSettings({ hooks: { Stop: [THEIRS] } }) } });
    expect(cmdHooksStatus(d)).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain(`${SETTINGS}: not installed`);
    cmdHooksInstall(d, ["claude"]);
    const after = deps({ files: { [SETTINGS]: d.files.entries.get(SETTINGS)!.text } });
    cmdHooksStatus(after);
    expect(after.io.stdout.join("\n")).toContain(`${SETTINGS}: installed (v1)`);
  });

  test("calls a file that carries only some of the events partly installed, and names the remedy", () => {
    const older = BEACON_HOOKS.slice(1);
    const document = {
      hooks: Object.fromEntries(older.map((r) => [r.event, [{ hooks: [{ type: "command", command: COMMAND }] }]])),
    };
    const d = deps({ files: { [SETTINGS]: serializeSettings(document) } });
    cmdHooksStatus(d);
    const said = d.io.stdout.join("\n");
    expect(said).toContain(`partly installed (v1, ${older.length}/${BEACON_HOOKS.length} events)`);
    expect(said).toContain("re-run install to add the rest");
  });

  test("names a stale marker version as something install would heal", () => {
    const stale = { hooks: [{ type: "command", command: "/old/collie beacon emit # collie-beacon v0" }] };
    const document = { hooks: Object.fromEntries(BEACON_HOOKS.map((r) => [r.event, [stale]])) };
    const d = deps({ files: { [SETTINGS]: serializeSettings(document) } });
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain("re-run install to heal it");
  });
});

// `--check` is what `collie update` runs on the binary it has just installed: no output at all, and
// the exit code is the whole answer. "Behind" is narrower than "install would change something" —
// a file with none of our entries opted out, and nothing may nag it.
describe("status --check", () => {
  const partial = () => {
    const older = BEACON_HOOKS.slice(1);
    return serializeSettings({
      hooks: Object.fromEntries(older.map((r) => [r.event, [{ hooks: [{ type: "command", command: COMMAND }] }]])),
    });
  };
  const staleDoc = () => {
    const stale = { hooks: [{ type: "command", command: "/old/collie beacon emit # collie-beacon v0" }] };
    return serializeSettings({ hooks: Object.fromEntries(BEACON_HOOKS.map((r) => [r.event, [stale]])) });
  };
  const installed = () => {
    const d = deps();
    cmdHooksInstall(d, ["claude"]);
    return d.files.entries.get(SETTINGS)!.text;
  };

  test("says behind for a partial install, and prints nothing at all", () => {
    const d = deps({ files: { [SETTINGS]: partial() } });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.STATE);
    expect(d.io.stdout).toEqual([]);
    expect(d.io.stderr).toEqual([]);
    expect(d.files.ops).toEqual([]);
  });

  test("says behind for an install from before M56 spec 11, whose Notification still matches idle_prompt, and install heals it", () => {
    const groups = (r: (typeof BEACON_HOOKS)[number]) =>
      r.event === "Notification" ? [{ matcher: "idle_prompt", hooks: [{ type: "command", command: COMMAND }] }] : [{ hooks: [{ type: "command", command: COMMAND }] }];
    const before = serializeSettings({ hooks: Object.fromEntries(BEACON_HOOKS.map((r) => [r.event, groups(r)])) });
    const d = deps({ files: { [SETTINGS]: before } });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.STATE);
    cmdHooksStatus(d);
    expect(d.io.stdout.join("\n")).toContain("4/5 events");
    cmdHooksInstall(d, ["claude"]);
    const healed = JSON.parse(d.files.entries.get(SETTINGS)!.text).hooks;
    expect(healed.Notification).toHaveLength(1);
    expect(healed.Notification[0].matcher).toBeUndefined();
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.OK);
  });

  test("says behind for entries at a marker version this build no longer writes", () => {
    const d = deps({ files: { [SETTINGS]: staleDoc() } });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.STATE);
  });

  test("stays quiet when the hooks were never installed — that is an opt-out, not a gap", () => {
    const never = deps({ files: { [SETTINGS]: serializeSettings({ hooks: { Stop: [THEIRS] } }) } });
    expect(cmdHooksStatus(never, ["--check"])).toBe(EXIT.OK);
    const nofile = deps();
    expect(cmdHooksStatus(nofile, ["--check"])).toBe(EXIT.OK);
  });

  test("stays quiet when every registration is present at this version", () => {
    const d = deps({ files: { [SETTINGS]: installed() } });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([]);
  });

  test("is behind when ANY configured profile is, not only ~/.claude (issue #92)", () => {
    const d = deps({
      env: { COLLIE_TRANSCRIPT_ROOT: join(OPS_PROFILE, "projects") },
      files: { [SETTINGS]: installed(), [OPS_SETTINGS]: partial() },
    });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.STATE);
  });

  test("does not answer `behind` for a file it cannot read — that is doctor's business", () => {
    const d = deps({ files: { [SETTINGS]: "{ not json" } });
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.OK);
  });
});

// ── The permission hold (M56 spec 12) ────────────────────────────────────────
//
// `collie hooks install claude --hold-permissions` adds two entries: the hold on PermissionRequest and
// the tool edge on PostToolUse. The hook script itself, `collie beacon hold`, is driven here through
// fake sockets: it must print nothing and exit 0 on every error, and hold only for PermissionRequest.

const HOLD_PROFILE = loadProfiles().get("claude")!.hold!;
const HOLD_COMMAND = `${OWN} beacon hold ${HOOK_MARKER}`;
const HOLD_PID = 4242;
const HOLD_STAT = `${HOLD_PID} (claude) S 4200 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} 987654 0 0`;
const HOLD_ENV: Environment = { TMUX_PANE: "%7", TMUX: "/tmp/tmux-1000/default,3311,0" };

/** The `hooks` section of a settings document, or an empty one. */
function hooksOf(document: JsonValue): JsonObject {
  return asJsonObject(asJsonObject(document)?.hooks) ?? {};
}

function permissionPayload(over: Record<string, JsonValue> = {}): string {
  return JSON.stringify({
    session_id: "s-1",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "rm -rf build", description: "clean" },
    ...over,
  });
}

/** A scripted bridge socket: what the hook sent, and a decision line the test pushes back. */
class FakeHoldSocket implements HoldSocket {
  sent: string[] = [];
  closed = false;
  private lines: ((line: string) => void)[] = [];
  private closes: (() => void)[] = [];
  send(line: string): void {
    this.sent.push(line);
  }
  onLine(listener: (line: string) => void): void {
    this.lines.push(listener);
  }
  onClose(listener: () => void): void {
    this.closes.push(listener);
  }
  close(): void {
    this.closed = true;
  }
  push(line: string): void {
    for (const l of this.lines) l(line);
  }
  drop(): void {
    for (const l of this.closes) l();
  }
}

function holdDeps(over: {
  env?: Environment;
  stdin?: string;
  /** Reading stdin fails, as on a closed pipe. */
  stdinFails?: boolean;
  proc?: string | null;
  sockets?: Record<string, FakeHoldSocket | null | "throw">;
  onSent?: ((path: string, socket: FakeHoldSocket) => void) | undefined;
  /** Find the sockets through the hook target registry, as production does, not from `sockets`. */
  registry?: boolean;
} = {}): HoldDeps & { files: ReturnType<typeof fakeFiles>; printed: string[]; connects: { path: string; ms: number }[]; timers: (() => void)[] } {
  const printed: string[] = [];
  const connects: { path: string; ms: number }[] = [];
  const timers: (() => void)[] = [];
  const sockets = over.sockets ?? {};
  const stdin = over.stdin ?? permissionPayload();
  const built: HoldDeps & { files: ReturnType<typeof fakeFiles>; printed: string[]; connects: { path: string; ms: number }[]; timers: (() => void)[] } = {
    ctx: context(over.env ?? HOLD_ENV),
    files: fakeFiles(over.proc === null ? {} : { [`/proc/${HOLD_PID}/stat`]: over.proc ?? HOLD_STAT }),
    readStdin: () => (over.stdinFails === true ? Promise.reject(new Error("EPIPE")) : Promise.resolve(stdin)),
    agentPid: HOLD_PID,
    connect: (path, ms) => {
      connects.push({ path, ms });
      const socket = sockets[path];
      if (socket === "throw") return Promise.reject(new Error("boom"));
      if (socket !== null && socket !== undefined) {
        const send = socket.send.bind(socket);
        socket.send = (line) => {
          send(line);
          over.onSent?.(path, socket);
        };
      }
      return Promise.resolve(socket ?? null);
    },
    print: (text) => {
      printed.push(text);
      return Promise.resolve();
    },
    now: () => 1_000,
    after: (_ms, run) => {
      timers.push(run);
      return () => undefined;
    },
    printed,
    connects,
    timers,
  };
  // Each socket a test names is a real socket in a private folder, as the bridge makes it.
  for (const path of Object.keys(sockets)) {
    built.files.entryTypes.set(posixKey(dirname(dirname(path))), "directory");
    built.files.entryTypes.set(posixKey(dirname(path)), "directory");
    built.files.entryTypes.set(posixKey(path), "other");
  }
  // The registry walk runs when no fixed list is given, as in production.
  return over.registry === true ? built : { ...built, sockets: () => Object.keys(sockets) };
}

describe("hold: the install", () => {
  test("--hold-permissions adds the hold on PermissionRequest with the profile's timeout, and the tool edge", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude", HOLD_FLAG])).toBe(EXIT.OK);
    const hooks = hooksOf(settingsOf(d));
    expect(hooks[HOLD_PROFILE.event]).toEqual([{ hooks: [{ type: "command", command: HOLD_COMMAND, timeout: HOLD_PROFILE.hookTimeoutS }] }]);
    expect(hooks[HOLD_PROFILE.toolEvent]).toEqual([{ hooks: [{ type: "command", command: COMMAND, timeout: 10 }] }]);
    // The hold limit plus the grace stays below the hook timeout the harness enforces.
    expect(HOLD_PROFILE.limitMs + HOLD_GRACE_MS).toBeLessThan(HOLD_PROFILE.hookTimeoutS * 1000);
    expect(d.io.stdout.join("\n")).toContain("PermissionRequest");
  });

  test("an install without the flag takes the hold back out, and keeps the operator's own entries", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude", HOLD_FLAG]);
    const before = hooksOf(settingsOf(d));
    const held = before[HOLD_PROFILE.event];
    const withTheirs = { hooks: { ...before, [HOLD_PROFILE.event]: [...(Array.isArray(held) ? held : []), THEIRS] } };
    d.files.entries.set(posixKey(SETTINGS), { text: JSON.stringify(withTheirs), mode: 0o600 });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const hooks = hooksOf(settingsOf(d));
    expect(hooks[HOLD_PROFILE.event]).toEqual([THEIRS]);
    expect(hooks[HOLD_PROFILE.toolEvent]).toBeUndefined();
    expect(holdCommandIn(settingsOf(d), HOLD_PROFILE.event)).toBeNull();
  });

  test("the hold entry is found by the edge emitter's reader; uninstall removes it", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude", HOLD_FLAG]);
    expect(settingsHold(d.files.entries.get(posixKey(SETTINGS))!.text, HOLD_PROFILE.event)).toBe(true);
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    expect(settingsHold(d.files.entries.get(posixKey(SETTINGS))?.text ?? null, HOLD_PROFILE.event)).toBe(false);
  });

  test("a hold: a Claude older than the profile's minVersion is refused, and nothing is written", () => {
    const d = { ...deps(), harnessVersion: () => "2.0.44" };
    expect(cmdHooksInstall(d, ["claude", HOLD_FLAG])).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain(`does not run the PermissionRequest hook. The hold needs ${HOLD_PROFILE.minVersion} or later.`);
    expect(d.files.entries.get(posixKey(SETTINGS))).toBeUndefined();
    // Without the flag the version does not matter.
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
  });

  test("a hold: an unreadable Claude version installs, and the output says what the hold needs", () => {
    const d = { ...deps(), harnessVersion: () => null };
    expect(cmdHooksInstall(d, ["claude", HOLD_FLAG])).toBe(EXIT.OK);
    expect(d.io.stdout.join("\n")).toContain(`Collie could not read the claude version. The hold needs ${HOLD_PROFILE.minVersion} or later.`);
  });

  test("an unknown option is refused, and the marker prefix matches the one the emitter writes", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude", "--hold"])).toBe(EXIT.USAGE);
    expect(d.files.entries.get(posixKey(SETTINGS))).toBeUndefined();
    expect(HOLD_MARKER_PREFIX).toBe(HOOK_MARKER_PREFIX);
  });
});

describe("hold: the hook script is inert on every error", () => {
  const SOCK = "/state/hold/sock";
  const cases: [string, Parameters<typeof holdDeps>[0]][] = [
    ["outside a multiplexer", { env: {}, sockets: { [SOCK]: new FakeHoldSocket() } }],
    ["stdin that is not JSON", { stdin: "{oops", sockets: { [SOCK]: new FakeHoldSocket() } }],
    ["stdin that throws", { stdinFails: true, sockets: { [SOCK]: new FakeHoldSocket() } }],
    ["no /proc entry for the agent", { proc: null, sockets: { [SOCK]: new FakeHoldSocket() } }],
    ["no bridge socket at all", { sockets: {} }],
    ["a socket that does not accept in time", { sockets: { [SOCK]: null } }],
    ["a connect that throws", { sockets: { [SOCK]: "throw" } }],
    ["a tool name that is not plain text", { stdin: permissionPayload({ tool_name: "Bash\u001b[2J" }), sockets: { [SOCK]: new FakeHoldSocket() } }],
  ];
  for (const [name, over] of cases) {
    test(`prints nothing and exits 0: ${name}`, async () => {
      const d = holdDeps(over);
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(d.printed).toEqual([]);
    });
  }

  test("each socket gets the 200 ms connect limit", async () => {
    const d = holdDeps({ sockets: { [SOCK]: null, "/other/hold/sock": null } });
    await cmdBeaconHold(d);
    expect(d.connects).toEqual([
      { path: SOCK, ms: HOLD_CONNECT_MS },
      { path: "/other/hold/sock", ms: HOLD_CONNECT_MS },
    ]);
    expect(HOLD_CONNECT_MS).toBe(200);
  });

  test("a bridge that dies mid-hold: no decision, nothing printed, exit 0", async () => {
    const socket = new FakeHoldSocket();
    const d = holdDeps({ sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.drop()) });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.printed).toEqual([]);
    expect(socket.closed).toBe(true);
  });

  test("the hold limit: no decision, nothing printed", async () => {
    const socket = new FakeHoldSocket();
    const d = holdDeps({ sockets: { [SOCK]: socket }, onSent: () => queueMicrotask(() => d.timers[0]?.()) });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.printed).toEqual([]);
  });

  test("a reply that is not a decision is not one", async () => {
    const socket = new FakeHoldSocket();
    const d = holdDeps({
      sockets: { [SOCK]: socket },
      onSent: (_p, s) =>
        queueMicrotask(() => {
          s.push('{"decision":"ask"}');
          s.push("garbage");
          s.drop();
        }),
    });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.printed).toEqual([]);
  });
});

describe("hold: the socket is checked before the connect", () => {
  const SOCK = "/state/hold/sock";
  const cases: [string, (d: ReturnType<typeof holdDeps>) => void][] = [
    ["a folder others can write", (d) => d.files.modes.set("/state/hold", 0o777)],
    ["a folder another user owns", (d) => d.files.rootOwned.add("/state/hold")],
    ["a state dir others can write", (d) => d.files.modes.set("/state", 0o777)],
    ["a state dir another user owns", (d) => d.files.rootOwned.add("/state")],
    ["a socket another user owns", (d) => d.files.rootOwned.add(SOCK)],
    ["a link in the socket's place", (d) => d.files.entryTypes.set(SOCK, "symlink")],
    ["a plain file in the socket's place", (d) => d.files.entryTypes.delete(SOCK)],
  ];
  for (const [name, spoil] of cases) {
    test(`${name}: no connect, nothing printed`, async () => {
      const d = { ...holdDeps({ sockets: { [SOCK]: new FakeHoldSocket() } }), uid: 1000 };
      if (name.startsWith("a plain file")) d.files.write(SOCK, "");
      spoil(d);
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(d.connects).toEqual([]);
      expect(d.printed).toEqual([]);
    });
  }

  test("this user's socket in a private folder: the hook connects", async () => {
    const socket = new FakeHoldSocket();
    const d = { ...holdDeps({ sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.drop()) }), uid: 1000 };
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.connects.map((c) => c.path)).toEqual([SOCK]);
  });
});

describe("hold: only PermissionRequest is held", () => {
  const SOCK = "/state/hold/sock";
  test("every other event exits at once, with no connect", async () => {
    for (const event of ["PreToolUse", "PostToolUse", "Notification", "Stop", "UserPromptSubmit"]) {
      const d = holdDeps({ stdin: permissionPayload({ hook_event_name: event }), sockets: { [SOCK]: new FakeHoldSocket() } });
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(d.connects).toEqual([]);
      expect(d.printed).toEqual([]);
    }
  });

  test("a screen-only tool is sent as an edge and never held", async () => {
    for (const tool of HOLD_PROFILE.screenOnly) {
      const socket = new FakeHoldSocket();
      const d = holdDeps({ stdin: permissionPayload({ tool_name: tool }), sockets: { [SOCK]: socket } });
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(JSON.parse(socket.sent[0]!)).toMatchObject({ tool, hold: false });
      expect(d.timers).toEqual([]);
      expect(d.printed).toEqual([]);
    }
  });

  test("a hold: a cut input is sent as an edge and never held, with the cut mark", async () => {
    const socket = new FakeHoldSocket();
    const long = `echo ${"x".repeat(2000)}`;
    const d = holdDeps({ stdin: permissionPayload({ tool_input: { command: long } }), sockets: { [SOCK]: socket } });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({ hold: false, cut: true });
    expect(request.input.endsWith(" [cut]")).toBe(true);
    expect(d.timers).toEqual([]);
    expect(d.printed).toEqual([]);
  });

  test("a hold: the request shows the risky Bash flags and drops the characters that hide text", async () => {
    const socket = new FakeHoldSocket();
    const d = holdDeps({ stdin: permissionPayload({ tool_input: { command: "rm -rf \u202ebuild\u202c", dangerouslyDisableSandbox: true } }), sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.push('{"decision":"deny"}')) });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(JSON.parse(socket.sent[0]!).input).toBe("rm -rf build\n[dangerouslyDisableSandbox: true]");
  });

  test("a hold: a subagent's request carries its type, and the main session's never does", async () => {
    const cases: [Record<string, JsonValue>, string | undefined][] = [
      [{ agent_id: "a1", agent_type: "general-purpose" }, "general-purpose"],
      [{ agent_type: "general-purpose" }, undefined],
      [{ agent_id: "a1" }, undefined],
    ];
    for (const [over, sent] of cases) {
      const socket = new FakeHoldSocket();
      const d = holdDeps({ stdin: permissionPayload(over), sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.drop()) });
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(JSON.parse(socket.sent[0]!).agentType).toBe(sent);
    }
  });

  test("a hold: the request carries the agent's folder, so the bridge can match a path the dialog prints below it", async () => {
    for (const [cwd, sent] of [["/var/home/me/proj", "/var/home/me/proj"], ["relative", undefined], ["/a\u202eb", undefined]] as const) {
      const socket = new FakeHoldSocket();
      const d = holdDeps({ stdin: permissionPayload({ cwd }), sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.drop()) });
      expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
      expect(JSON.parse(socket.sent[0]!).cwd).toBe(sent);
    }
  });

  test("a decision from the bridge is printed in the harness's shape; the request carries the input shown, never the whole input", async () => {
    const socket = new FakeHoldSocket();
    const d = holdDeps({ sockets: { [SOCK]: socket }, onSent: (_p, s) => queueMicrotask(() => s.push('{"decision":"allow"}')) });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    const request = JSON.parse(socket.sent[0]!);
    expect(request).toMatchObject({ v: 1, harness: "claude", pid: HOLD_PID, pidStartTime: 987654, tool: "Bash", input: "rm -rf build", agent: null, hold: true });
    expect(request.markers).toEqual([{ namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" }]);
    expect(d.printed.map((p) => JSON.parse(p))).toEqual([{ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }]);
  });

  test("two bridges: the first decision wins, the other bridge hears answered elsewhere", async () => {
    const a = new FakeHoldSocket();
    const b = new FakeHoldSocket();
    const d = holdDeps({
      sockets: { "/a/hold/sock": a, "/b/hold/sock": b },
      onSent: (path, s) => {
        if (path === "/b/hold/sock" && s.sent.length === 1) queueMicrotask(() => s.push('{"decision":"deny"}'));
      },
    });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(a.sent.at(-1)).toBe(`${JSON.stringify({ done: "elsewhere" })}\n`);
    expect(b.sent).toHaveLength(1);
    expect(a.closed && b.closed).toBe(true);
    expect(JSON.parse(d.printed[0]!).hookSpecificOutput.decision).toEqual({ behavior: "deny", message: HOLD_PROFILE.denyMessage, interrupt: true });
  });
});

describe("no secret", () => {
  // The hold carries no token: the socket is a file in the bridge's own state folder, mode 0600, and
  // the settings entry names only the binary, the verb and the marker.
  const SECRET = /(token|secret|password|bearer|api[_-]?key|sk-[a-z0-9]|COLLIE_[A-Z_]*KEY)/iu;

  test("the settings entries the hold install writes hold no secret", () => {
    const d = deps({ env: { COLLIE_TOKEN: "sk-or-v1-your-key-here", COLLIE_ACCESS_KEY: "placeholder-key" } });
    cmdHooksInstall(d, ["claude", HOLD_FLAG]);
    const text = d.files.entries.get(posixKey(SETTINGS))!.text;
    expect(text).not.toMatch(SECRET);
    expect(text).not.toContain("sk-or-v1-your-key-here");
    expect(text).not.toContain("placeholder-key");
  });

  test("the hook script source reads no secret and sends none", async () => {
    const source = readFileSync(join(import.meta.dir, "hold.ts"), "utf8") + readFileSync(join(import.meta.dir, "hold-entry.ts"), "utf8");
    for (const line of source.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/u.test(l))) expect(line).not.toMatch(SECRET);
    const socket = new FakeHoldSocket();
    const d = holdDeps({
      env: { ...HOLD_ENV, COLLIE_TOKEN: "sk-or-v1-your-key-here" },
      sockets: { "/state/hold/sock": socket },
      onSent: (_p, s) => queueMicrotask(() => s.drop()),
    });
    await cmdBeaconHold(d);
    expect(socket.sent.join("")).not.toContain("sk-or-v1-your-key-here");
    expect(socket.sent.join("")).not.toMatch(SECRET);
  });
});

describe("hold: the sockets come from the hook target registry", () => {
  const REGISTRY = join(HOME, ".local", "state", "collie", "hook-targets");
  const A = { dir: "/srv/collie-a", pid: 5001, start: 11 };
  const B = { dir: "/srv/collie-b", pid: 5002, start: 22 };
  const statOf = (pid: number, start: number): string => `${String(pid)} (bun) S 1 ${Array.from({ length: 17 }, (_v, i) => i).join(" ")} ${String(start)} 0 0`;
  const sockOf = (dir: string): string => join(dir, "hold", "sock");

  function registered(targets: { dir: string; pid: number; start: number; alive?: boolean }[], sockets: Record<string, FakeHoldSocket | null>, onSent?: (path: string, socket: FakeHoldSocket) => void) {
    const d = holdDeps({ registry: true, sockets, onSent });
    const files = d.files;
    files.mkdirp(REGISTRY, 0o700);
    for (const t of targets) {
      files.write(join(REGISTRY, hookTargetFileName(t.dir)), JSON.stringify({ schemaVersion: 1, stateDir: t.dir, pid: t.pid, pidStartTime: t.start, bootedAt: 1 }), 0o600);
      if (t.alive !== false) files.write(`/proc/${String(t.pid)}/stat`, statOf(t.pid, t.start));
    }
    return { d, files };
  }

  test("two live targets: the hook holds with both, the first decision wins, the other hears answered elsewhere", async () => {
    const a = new FakeHoldSocket();
    const b = new FakeHoldSocket();
    const { d } = registered([A, B], { [sockOf(A.dir)]: a, [sockOf(B.dir)]: b }, (path, s) => {
      if (path === sockOf(A.dir) && s.sent.length === 1) queueMicrotask(() => s.push('{"decision":"allow"}'));
    });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.connects.map((c) => c.path).toSorted()).toEqual([sockOf(A.dir), sockOf(B.dir)].toSorted());
    expect(d.connects.every((c) => c.ms === HOLD_CONNECT_MS)).toBe(true);
    expect(b.sent.at(-1)).toBe(`${JSON.stringify({ done: "elsewhere" })}\n`);
    expect(JSON.parse(d.printed[0]!).hookSpecificOutput.decision).toEqual({ behavior: "allow" });
  });

  test("a dead target is skipped and its file deleted; the live one holds alone", async () => {
    const a = new FakeHoldSocket();
    const { d, files } = registered([A, { ...B, alive: false }], { [sockOf(A.dir)]: a }, (_p, s) => queueMicrotask(() => s.push('{"decision":"deny"}')));
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.connects.map((c) => c.path)).toEqual([sockOf(A.dir)]);
    expect(files.read(join(REGISTRY, hookTargetFileName(B.dir)))).toBeNull();
    expect(d.printed).toHaveLength(1);
  });

  test("no registry: the hook connects to the socket in its own state dir", async () => {
    const own = new FakeHoldSocket();
    const d = holdDeps({ registry: true, sockets: { [holdSocketPath(STATE)]: own }, onSent: (_p, s) => queueMicrotask(() => s.drop()) });
    expect(await cmdBeaconHold(d)).toBe(EXIT.OK);
    expect(d.connects.map((c) => c.path)).toEqual([holdSocketPath(STATE)]);
    expect(holdSocketPaths(d)).toEqual([holdSocketPath(STATE)]);
    expect(d.printed).toEqual([]);
  });
});

describe("the statusLine wrap (.adr/0115, opt-in since 2026-10-24)", () => {
  const MINE = "bash /home/pat/.claude/statusline-command.sh";
  const withLine = (line: JsonObject): string => `${JSON.stringify({ model: "opus", statusLine: line }, null, 2)}\n`;
  // Windows keeps the operator's command as it is: the wrapper's shell is not the one Claude Code uses there.
  const wraps = HOST.platform !== "win32";

  test("install WITHOUT the flag leaves a plain statusLine byte for byte and says nothing about it", () => {
    const before = withLine({ type: "command", command: MINE, padding: 0 });
    const d = deps({ files: { [SETTINGS]: before } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const line = asJsonObject(asJsonObject(settingsOf(d))?.statusLine);
    expect(line).toEqual({ type: "command", command: MINE, padding: 0 });
    expect(d.io.stdout.join("\n").toLowerCase()).not.toContain("statusline");
    expect(d.io.stderr).toEqual([]);
  });

  test("install WITHOUT the flag on a file with no statusLine adds none and says nothing", () => {
    const d = deps({ files: { [SETTINGS]: `{"model":"opus"}\n` } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(asJsonObject(settingsOf(d))?.statusLine).toBeUndefined();
    expect(d.io.stdout.join("\n").toLowerCase()).not.toContain("statusline");
  });

  test("--statusline wraps the operator's statusLine, keeps its other keys, and says so", () => {
    const d = deps({ files: { [SETTINGS]: withLine({ type: "command", command: MINE, padding: 0 }) } });
    expect(cmdHooksInstall(d, ["claude", "--statusline"])).toBe(EXIT.OK);
    const line = asJsonObject(asJsonObject(settingsOf(d))?.statusLine);
    expect(line?.padding).toBe(0);
    if (!wraps) {
      expect(line?.command).toBe(MINE);
      expect(d.io.stdout.join("\n")).toContain("statusLine not wrapped on Windows");
      return;
    }
    expect(line?.command).toBe(wrapCommand(OWN, MINE));
    expect(d.io.stdout.join("\n")).toContain("your own command still runs");
  });

  test("--statusline adds no statusLine where there is none, and says so", () => {
    const d = deps({ files: { [SETTINGS]: `{"model":"opus"}\n` } });
    expect(cmdHooksInstall(d, ["claude", "--statusline"])).toBe(EXIT.OK);
    expect(asJsonObject(settingsOf(d))?.statusLine).toBeUndefined();
    if (wraps) expect(d.io.stdout.join("\n")).toContain("Collie never adds a statusLine");
  });

  test("an install without the flag keeps a wrap that is already there and re-points it to this binary", () => {
    if (!wraps) return;
    const old = "/opt/collie-old/bin/collie";
    const d = deps({ files: { [SETTINGS]: withLine({ type: "command", command: wrapCommand(old, MINE), padding: 2 }) } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    const line = asJsonObject(asJsonObject(settingsOf(d))?.statusLine);
    expect(line?.command).toBe(wrapCommand(OWN, MINE));
    expect(line?.padding).toBe(2);
    expect(d.io.stdout.join("\n")).toContain("your own command still runs");
  });

  test("the install refuses --statusline for codex, and names both options for an unknown one", () => {
    const d = deps({});
    expect(cmdHooksInstall(d, ["codex", "--statusline"])).toBe(EXIT.USAGE);
    expect(d.io.stderr.join("\n")).toContain("no statusLine to wrap");
    const e = deps({});
    expect(cmdHooksInstall(e, ["claude", "--bogus"])).toBe(EXIT.USAGE);
    expect(e.io.stderr.join("\n")).toContain("`--hold-permissions` and `--statusline`");
  });

  test("uninstall puts the operator's command back byte for byte, with the hooks gone", () => {
    const before = withLine({ type: "command", command: MINE });
    const d = deps({ files: { [SETTINGS]: before } });
    cmdHooksInstall(d, ["claude", "--statusline"]);
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.entries.get(SETTINGS)?.text).toBe(before);
  });

  test("an unwrapped statusLine is NOT behind; a wrapped one that names another binary is", () => {
    const d = deps({ files: { [SETTINGS]: withLine({ type: "command", command: MINE }) } });
    cmdHooksInstall(d, ["claude"]);
    expect(hooksAreBehind(d)).toBe(false);
    d.io.stdout.length = 0;
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.OK);
    expect(d.io.stdout).toEqual([]);
    if (!wraps) return;
    // A wrap written by another binary prints nothing until it is re-pointed.
    const doc = asJsonObject(settingsOf(d)) ?? {};
    d.files.entries.set(SETTINGS, { text: `${JSON.stringify({ ...doc, statusLine: { type: "command", command: wrapCommand("/opt/gone/collie", MINE) } }, null, 2)}\n` });
    expect(hooksAreBehind(d)).toBe(true);
    d.io.stdout.length = 0;
    // `--check` says which thing is behind in one word, for the updater's nudge, and only then.
    expect(cmdHooksStatus(d, ["--check"])).toBe(EXIT.STATE);
    expect(d.io.stdout).toEqual(["statusline"]);
    // The install re-points it, with no flag.
    cmdHooksInstall(d, ["claude"]);
    expect(hooksAreBehind(d)).toBe(false);
  });

  test("status names the wrap when the statusLine is wrapped", () => {
    const d = deps({ files: { [SETTINGS]: withLine({ type: "command", command: MINE }) } });
    cmdHooksInstall(d, ["claude", "--statusline"]);
    d.io.stdout.length = 0;
    cmdHooksStatus(d);
    if (wraps) expect(d.io.stdout.join("\n")).toContain("wraps the statusLine");
    expect(hooksAreBehind(d)).toBe(false);
  });
});
