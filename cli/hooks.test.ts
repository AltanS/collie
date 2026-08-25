import { describe, expect, test } from "bun:test";

import { BEACON_HOOKS } from "./beacon.ts";
import { BINARY, capture, context, fakeFiles, fakeLinkFs, HOME } from "./fakes.ts";
import {
  claudeSettingsTargets,
  cmdHooksInstall,
  cmdHooksStatus,
  cmdHooksUninstall,
  HOOK_MARKER,
  type HooksDeps,
  installDocument,
  markedCommandIn,
  resolveHookCommand,
  serializeSettings,
  uninstallDocument,
} from "./hooks.ts";
import { EXIT } from "./io.ts";
import type { Environment } from "./context.ts";
import type { JsonValue } from "../bridge/json.ts";

// `collie hooks install|uninstall|status`. Every decision is a pure function of the document on disk,
// so the merge rules are pinned directly; the verbs are then asserted for what they DO — which file
// is written, which is refused untouched, and what the operator reads.
//
// Nothing here may reach a real `~/.claude`: the filesystem and the symlink probe are both fakes.

const SETTINGS = `${HOME}/.claude/settings.json`;
const BACKUP = `${SETTINGS}.collie-backup`;
const PUBLISHED = `${HOME}/.local/bin/collie`;
const COMMAND = `${BINARY} beacon emit ${HOOK_MARKER}`;

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
  const fs = fakeLinkFs(over.linked === true ? { [PUBLISHED]: { kind: "symlink", target: BINARY } } : {});
  return { ctx: context(over.env ?? {}), io, files, fs };
}

const settingsOf = (d: ReturnType<typeof deps>, path = SETTINGS): JsonValue =>
  JSON.parse(d.files.entries.get(path)?.text ?? "null");

describe("the targets", () => {
  test("are ~/.claude, plus one per configured Claude journal root (issue #92)", () => {
    expect(claudeSettingsTargets(context({ COLLIE_TRANSCRIPT_ROOT: "/srv/work/projects,/srv/ops/projects" }))).toEqual([
      { dir: `${HOME}/.claude`, path: SETTINGS },
      { dir: "/srv/work", path: "/srv/work/settings.json" },
      { dir: "/srv/ops", path: "/srv/ops/settings.json" },
    ]);
  });

  test("never name a project settings file, and never repeat one", () => {
    const targets = claudeSettingsTargets(context({ COLLIE_TRANSCRIPT_ROOT: `${HOME}/.claude/projects` }));
    expect(targets).toEqual([{ dir: `${HOME}/.claude`, path: SETTINGS }]);
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
    expect(resolveHookCommand(d.ctx, d.fs)).toEqual({ binary: BINARY, source: "checkout", command: COMMAND });
    expect(COMMAND.startsWith("/")).toBe(true);
  });

  test("is pinned to the checkout when the published name is somebody else's", () => {
    const d = deps();
    d.fs.entries.set(PUBLISHED, { kind: "symlink", target: "/opt/collie-v1/bin/collie" });
    expect(resolveHookCommand(d.ctx, d.fs).source).toBe("checkout");
  });

  test("carries a version-prefixed ownership marker", () => {
    expect(HOOK_MARKER).toMatch(/# collie-beacon v\d+$/);
    expect(markedCommandIn({ hooks: [{ type: "command", command: COMMAND }] })).toBe(COMMAND);
    expect(markedCommandIn({ hooks: [{ type: "command", command: "/usr/local/bin/audit.sh" }] })).toBeNull();
    expect(markedCommandIn("not a group")).toBeNull();
  });
});

describe("the merge", () => {
  test("adds exactly the registered events, matcher included", () => {
    const outcome = installDocument(null, COMMAND);
    expect(outcome.kind).toBe("document");
    const text = outcome.kind === "document" ? serializeSettings(outcome.document) : "";
    const hooks = JSON.parse(text).hooks;
    expect(Object.keys(hooks)).toEqual(BEACON_HOOKS.map((r) => r.event));
    expect(hooks.Notification[0].matcher).toBe("idle_prompt");
    // A registration with no matcher writes no `matcher` key at all — not `null`, not `""`.
    expect(Object.keys(hooks.UserPromptSubmit[0])).toEqual(["hooks"]);
    expect(hooks.Stop[0].hooks).toEqual([{ type: "command", command: COMMAND }]);
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
    expect(d.io.stderr).toEqual([]);
  });

  test("is atomic — the live file is renamed into place, never written through", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude"]);
    expect(d.files.ops.filter((op) => op.startsWith("mv "))).toEqual([`mv ${SETTINGS}.collie-tmp ${SETTINGS}`]);
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

  test("writes every configured profile, not just ~/.claude", () => {
    const d = deps({ env: { COLLIE_TRANSCRIPT_ROOT: "/srv/ops/projects" } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.OK);
    expect(d.files.entries.has(SETTINGS)).toBe(true);
    expect(d.files.entries.has("/srv/ops/settings.json")).toBe(true);
  });

  test("refuses a symlinked settings file, untouched, with a remedy", () => {
    const d = deps({ files: { [SETTINGS]: "{}\n" } });
    d.fs.entries.set(SETTINGS, { kind: "symlink", target: "/elsewhere/settings.json" });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.get(SETTINGS)!.text).toBe("{}\n");
    expect(d.io.stderr.join("\n")).toContain("is a symlink");
    expect(d.io.stderr.join("\n")).toContain("re-run");
  });

  test("refuses a symlinked parent directory the same way", () => {
    const d = deps();
    d.fs.entries.set(`${HOME}/.claude`, { kind: "symlink", target: "/dotfiles/claude" });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.size).toBe(0);
  });

  test("refuses a settings file that is not valid JSON rather than losing it", () => {
    const d = deps({ files: { [SETTINGS]: "{ oops" } });
    expect(cmdHooksInstall(d, ["claude"])).toBe(EXIT.FAIL);
    expect(d.files.entries.get(SETTINGS)!.text).toBe("{ oops");
    expect(d.io.stderr.join("\n")).toContain("not valid JSON");
  });

  test("names the harness, and refuses an unknown one", () => {
    for (const args of [[], ["codex"]]) {
      const d = deps();
      expect(cmdHooksInstall(d, args)).toBe(EXIT.USAGE);
      expect(d.files.entries.size).toBe(0);
      expect(d.io.stderr.join("\n")).toContain("collie hooks install {claude}");
    }
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
    d.fs.entries.set(SETTINGS, { kind: "symlink", target: "/elsewhere/settings.json" });
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.FAIL);
  });
});

describe("status", () => {
  test("reports each target and writes absolutely nothing", () => {
    const d = deps({ env: { COLLIE_TRANSCRIPT_ROOT: "/srv/ops/projects" } });
    expect(cmdHooksStatus(d)).toBe(EXIT.OK);
    const said = d.io.stdout.join("\n");
    expect(said).toContain(`${SETTINGS}: no settings file`);
    expect(said).toContain("/srv/ops/settings.json: no settings file");
    expect(said).toContain(BINARY);
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
