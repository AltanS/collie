import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { BEACON_HOOKS } from "./beacon.ts";
import { askCheckHook } from "./doctor.ts";
import { capture, context, fakeFiles, fakeLinkFs, HOME, ROOT } from "./fakes.ts";
import {
  behindReason,
  checkCommandFor,
  checkInstalledIn,
  cmdHooksInstall,
  cmdHooksStatus,
  cmdHooksUninstall,
  HOOK_MARKER,
  type HooksDeps,
  serializeSettings,
} from "./hooks.ts";
import { EXIT } from "./io.ts";
import { asJsonObject, parseJsonObject } from "../web/src/lib/json.ts";
import { collieBinary } from "./unit.ts";

// The check at the end of a turn in the installer (.adr/0177): `hooks install claude` writes it as a second
// entry in our Stop group, heals an older install, never doubles it, leaves the person's own Stop hooks where
// they were, and `uninstall` takes it out. `hooks status` and `doctor` give it one row. Scratch files only:
// the filesystem and the link probe are fakes, and nothing here can reach a real `~/.claude`.

const SETTINGS = join(HOME, ".claude", "settings.json");
const OWN = collieBinary(ROOT);
const EMIT = `${OWN} beacon emit ${HOOK_MARKER}`;
const CHECK = `${OWN} beacon check ${HOOK_MARKER}`;
const MINE_FIRST = { hooks: [{ type: "command", command: "/usr/local/bin/notify-me.sh" }] };
const MINE_LAST = { matcher: "", hooks: [{ type: "command", command: "/usr/local/bin/log-stop.sh", timeout: 5 }] };

function deps(files: Record<string, string> = {}): HooksDeps & { io: ReturnType<typeof capture>; files: ReturnType<typeof fakeFiles> } {
  return { ctx: context({}), io: capture(), files: fakeFiles(files), fs: fakeLinkFs({}), harnessVersion: () => "2.1.301" };
}

function settingsOf(d: ReturnType<typeof deps>): JsonObject {
  return parseJsonObject(d.files.entries.get(SETTINGS)?.text ?? "") ?? {};
}

function hooksOf(document: JsonObject): JsonObject {
  return asJsonObject(document.hooks) ?? {};
}

function stopOf(document: JsonObject): JsonValue[] {
  const stop = hooksOf(document).Stop;
  return Array.isArray(stop) ? stop : [];
}

/** The file an install from before the check wrote: every event, the Stop group with the emitter alone. */
function oldInstall(extraStop: JsonValue[] = []): string {
  const hooks: JsonObject = {};
  for (const registration of BEACON_HOOKS) hooks[registration.event] = [{ matcher: registration.matcher, hooks: [{ type: "command", command: EMIT, timeout: 10 }] }];
  hooks.Stop = [...extraStop, { hooks: [{ type: "command", command: EMIT, timeout: 10 }] }];
  return serializeSettings({ hooks });
}

describe("the installer and the check", () => {
  test("a fresh install writes the check beside the emitter, in one Stop group of ours", () => {
    const d = deps();
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    const stop = stopOf(settingsOf(d));
    expect(stop).toEqual([
      {
        hooks: [
          { type: "command", command: EMIT, timeout: 10 },
          { type: "command", command: CHECK, timeout: 10 },
        ],
      },
    ]);
    expect(checkCommandFor(EMIT)).toBe(CHECK);
    expect(checkInstalledIn(settingsOf(d))).toBe(true);
    expect(d.io.stdout.join("\n")).toContain(`Stop → \`${OWN} beacon check\``);
    // No other event carries it.
    const others = Object.entries(hooksOf(settingsOf(d))).filter(([event]) => event !== "Stop");
    expect(JSON.stringify(others)).not.toContain("beacon check");
  });

  test("an old install gains the entry, reads as behind before, and as current after", () => {
    const d = deps({ [SETTINGS]: oldInstall() });
    expect(checkInstalledIn(settingsOf(d))).toBe(false);
    expect(behindReason(d)).toBe("hooks");
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    expect(checkInstalledIn(settingsOf(d))).toBe(true);
    expect(behindReason(d)).toBeNull();
  });

  test("an install that has it already changes no bytes and never writes a second entry", () => {
    const d = deps();
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    const first = d.files.entries.get(SETTINGS)?.text;
    const again = deps({ [SETTINGS]: first! });
    expect(cmdHooksInstall(again, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    expect(again.files.entries.get(SETTINGS)?.text).toBe(first);
    expect(again.io.stdout[0]).toContain("no bytes changed");
    expect((again.files.entries.get(SETTINGS)?.text ?? "").split("beacon check").length - 1).toBe(1);
  });

  test("the person's own Stop hooks stay untouched and in order, around ours", () => {
    const d = deps({ [SETTINGS]: oldInstall([MINE_FIRST]) });
    const document = settingsOf(d);
    d.files.entries.set(SETTINGS, { text: serializeSettings({ ...document, hooks: { ...hooksOf(document), Stop: [...stopOf(document), MINE_LAST] } }) });
    expect(cmdHooksInstall(d, ["claude", "--no-statusline"])).toBe(EXIT.OK);
    const stop = stopOf(settingsOf(d));
    expect(stop).toHaveLength(3);
    expect(stop[0]).toEqual(MINE_FIRST);
    expect(JSON.stringify(stop[1])).toContain("beacon check");
    expect(stop[2]).toEqual(MINE_LAST);
  });

  test("uninstall takes the check out with the emitter and keeps the person's own", () => {
    const d = deps({ [SETTINGS]: oldInstall([MINE_FIRST]) });
    cmdHooksInstall(d, ["claude", "--no-statusline"]);
    expect(cmdHooksUninstall(d, ["claude"])).toBe(EXIT.OK);
    const after = settingsOf(d);
    expect(JSON.stringify(after)).not.toContain("beacon check");
    expect(stopOf(after)).toEqual([MINE_FIRST]);
  });
});

describe("the check's row", () => {
  test("hooks status: installed, missing, and none where our hooks are not installed", () => {
    const fresh = deps();
    cmdHooksInstall(fresh, ["claude", "--no-statusline"]);
    const installed = deps({ [SETTINGS]: fresh.files.entries.get(SETTINGS)!.text });
    cmdHooksStatus(installed);
    expect(installed.io.stdout).toContain("  the check at the end of a turn: installed");

    const old = deps({ [SETTINGS]: oldInstall() });
    cmdHooksStatus(old);
    expect(old.io.stdout).toContain("  the check at the end of a turn: missing — re-run `collie hooks install claude` to add it");

    const none = deps({ [SETTINGS]: serializeSettings({ hooks: { Stop: [MINE_FIRST] } }) });
    cmdHooksStatus(none);
    expect(none.io.stdout.join("\n")).not.toContain("the check at the end of a turn");
  });

  test("doctor: ok when every file with our hooks has it, a warn naming the file when one does not, no row without hooks", () => {
    const fresh = deps();
    cmdHooksInstall(fresh, ["claude", "--no-statusline"]);
    const target = { dir: join(HOME, ".claude"), path: SETTINGS };
    const ok = askCheckHook({ files: fakeFiles({ [SETTINGS]: fresh.files.entries.get(SETTINGS)!.text }) }, [{ target }]);
    expect(ok.map((finding) => [finding.check, finding.status])).toEqual([["ask-check-claude", "ok"]]);
    const old = askCheckHook({ files: fakeFiles({ [SETTINGS]: oldInstall() }) }, [{ target }]);
    expect(old[0]?.status).toBe("warn");
    expect(old[0]?.detail).toContain(SETTINGS);
    expect(old[0]?.remedy).toContain("collie hooks install claude");
    expect(askCheckHook({ files: fakeFiles({}) }, [])).toEqual([]);
  });
});
