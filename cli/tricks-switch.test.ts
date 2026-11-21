// `collie tricks on|off|status` (cli/tricks-switch.ts) and the refusals of the trick verbs while tricks as a
// whole are switched off (cli/trick.ts `refuseWhileTricksOff`). No switch file is off.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTricksFeature, tricksFeaturePath, writeTricksFeature } from "../bridge/tricks/feature-switch.ts";
import { parseSwitches } from "../bridge/tricks/switches.ts";
import { switchesPath } from "../bridge/tricks/paths.ts";
import { TRICKS_OFF_LINE, TRICKS_WINDOWS_LINE } from "../web/src/lib/tricks/schema.ts";
import { realFiles } from "./sys.ts";
import { EXIT, type Io } from "./io.ts";
import { cmdTrickAdd, cmdTrickUpdate } from "./trick-add.ts";
import { cmdTrickCheck, cmdTrickInit, cmdTrickList, cmdTrickSwitch, type TrickDeps } from "./trick.ts";
import { cmdTricks, cmdTricksOn, cmdTricksStatus, cmdTricksSwitch, TRICKS_OFF_WORDS, TRICKS_ON_WORDS } from "./tricks-switch.ts";

const dirs: string[] = [];
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface Rig extends TrickDeps {
  out: string[];
  err: string[];
  configDir: string;
  stateDir: string;
}

async function rig(platform?: NodeJS.Platform): Promise<Rig> {
  const root = await mkdtemp(join(tmpdir(), "collie-tricks-cli-"));
  dirs.push(root);
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line) => out.push(line), err: (line) => err.push(line) };
  const deps: Rig = {
    out,
    err,
    configDir,
    stateDir,
    io,
    ctx: { configDir, stateDir, port: 18_997, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/home/dev" } },
    files: realFiles,
    fetch: async () => {
      throw new Error("no bridge in this test");
    },
    now: () => Date.parse("2026-11-17T09:00:00Z"),
  };
  if (platform !== undefined) deps.platform = platform;
  return deps;
}

const clear = (r: Rig): void => {
  r.out.length = 0;
  r.err.length = 0;
};

describe("collie tricks", () => {
  test("status with no file says off and that tricks are off by default; on and off write the whole value", async () => {
    const r = await rig();
    expect(cmdTricksStatus(r, [])).toBe(EXIT.OK);
    expect(r.out).toEqual([`${TRICKS_OFF_LINE} (No switch was written yet; tricks are off by default.)`]);
    clear(r);
    expect(cmdTricksStatus(r, ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(r.out.join(""))).toEqual({ on: false, reading: "unset" });
    clear(r);
    expect(cmdTricksSwitch(r, "on", [])).toBe(EXIT.OK);
    expect(r.out).toEqual([TRICKS_ON_WORDS]);
    expect(JSON.parse(await readFile(tricksFeaturePath(r.stateDir), "utf8"))).toEqual({ v: 1, on: true, at: "2026-11-17T09:00:00.000Z" });
    clear(r);
    expect(cmdTricksSwitch(r, "on", [])).toBe(EXIT.OK);
    expect(r.out).toEqual(["Tricks are already on."]);
    clear(r);
    expect(cmdTricksSwitch(r, "off", ["--json"])).toBe(EXIT.OK);
    expect(JSON.parse(r.out.join(""))).toEqual({ on: false });
    expect(readTricksFeature(r.stateDir).reading).toBe("off");
    clear(r);
    expect(cmdTricksSwitch(r, "off", [])).toBe(EXIT.OK);
    expect(r.out).toEqual(["Tricks are already off."]);
    clear(r);
    // With no file, off still writes one, so `status` no longer says "never written".
    const fresh = await rig();
    expect(cmdTricksSwitch(fresh, "off", [])).toBe(EXIT.OK);
    expect(fresh.out).toEqual([TRICKS_OFF_WORDS]);
  });

  test("a stray argument, a bare verb and --help", async () => {
    const r = await rig();
    expect(cmdTricksSwitch(r, "on", ["now"])).toBe(EXIT.USAGE);
    expect(r.err[0]).toBe("error: unknown argument `now`");
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
    clear(r);
    expect(cmdTricks(r, [])).toBe(EXIT.USAGE);
    expect(cmdTricks(r, ["--help"])).toBe(EXIT.OK);
    expect(r.out[0]).toBe("usage: collie tricks <on|off|status> [--json]");
  });

  test("tricks on in an agent's pane is refused with the person-only sentence and writes nothing; a shell pane and off still write", async () => {
    const r = await rig();
    const pane = { ...r, ctx: { ...r.ctx, env: { ...r.ctx.env, HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock" } } };
    expect(await cmdTricksOn({ ...pane, paneKind: async () => "agent" as const }, [])).toBe(EXIT.REFUSED);
    expect(r.err[0]).toBe("error: collie tricks on is your person's choice, and this runs in a pane where an agent works.");
    expect(r.err[1]).toContain("in Settings, Tricks and the Hill");
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
    clear(r);
    expect(cmdTricksSwitch(pane, "off", [])).toBe(EXIT.OK);
    expect(await cmdTricksOn({ ...pane, paneKind: async () => "shell" as const }, [])).toBe(EXIT.OK);
    expect(readTricksFeature(r.stateDir).reading).toBe("on");
  });

  test("counsel A2: tricks on fails closed when pane markers exist and the pane is not proven a shell; no markers still write", async () => {
    const r = await rig();
    const pane = { ...r, ctx: { ...r.ctx, env: { ...r.ctx.env, HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock" } } };
    // The check throws: refused with the same sentence, nothing written.
    expect(await cmdTricksOn({ ...pane, paneKind: async () => Promise.reject(new Error("socket gone")) }, [])).toBe(EXIT.REFUSED);
    expect(r.err[0]).toBe("error: collie tricks on is your person's choice, and this runs in a pane where an agent works.");
    expect(r.err[1]).toContain("in Settings, Tricks and the Hill");
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
    // The bridge does not know the pane: refused too.
    clear(r);
    expect(await cmdTricksOn({ ...pane, paneKind: async () => "unknown" as const }, [])).toBe(EXIT.REFUSED);
    expect(r.err[0]).toBe("error: collie tricks on is your person's choice, and this runs in a pane where an agent works.");
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
    // No markers: a person's own terminal. The check is not asked, and a throwing one changes nothing.
    clear(r);
    expect(await cmdTricksOn({ ...r, paneKind: async () => Promise.reject(new Error("never asked")) }, [])).toBe(EXIT.OK);
    expect(readTricksFeature(r.stateDir).reading).toBe("on");
  });

  test("Windows: on says the Windows line and writes nothing; off still writes; status says the line", async () => {
    const r = await rig("win32");
    expect(cmdTricksSwitch(r, "on", [])).toBe(EXIT.FAIL);
    expect(r.err).toEqual([`error: ${TRICKS_WINDOWS_LINE}`]);
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
    expect(cmdTricksSwitch(r, "off", [])).toBe(EXIT.OK);
    clear(r);
    expect(cmdTricksStatus(r, [])).toBe(EXIT.OK);
    expect(r.out).toEqual([TRICKS_WINDOWS_LINE]);
  });
});

describe("the trick verbs while tricks are switched off", () => {
  test("trick add and trick update answer one sentence that says where to switch tricks on, and fetch nothing", async () => {
    const r = await rig();
    expect(await cmdTrickAdd(r, ["https://example.com/o/r"])).toBe(EXIT.FAIL);
    expect(r.err).toEqual([`error: ${TRICKS_OFF_LINE}`]);
    clear(r);
    expect(await cmdTrickUpdate(r, ["legs"])).toBe(EXIT.FAIL);
    expect(r.err).toEqual([`error: ${TRICKS_OFF_LINE}`]);
    expect(TRICKS_OFF_LINE).toContain("Settings, Tricks and the Hill");
    expect(TRICKS_OFF_LINE).toContain("collie tricks on");
  });

  test("trick on still writes the trick's own switch, and says that nothing runs before collie tricks on; list says it too", async () => {
    const r = await rig();
    expect(await cmdTrickInit(r, ["legs"])).toBe(EXIT.OK);
    clear(r);
    expect(await cmdTrickSwitch(r, ["legs"], true)).toBe(EXIT.OK);
    expect(r.out).toContain("Tricks are switched off on this machine, so it runs only after collie tricks on.");
    expect(parseSwitches(await readFile(switchesPath(r.stateDir), "utf8")).switches.on.has("legs")).toBe(true);
    clear(r);
    expect(await cmdTrickList(r, [])).toBe(EXIT.OK);
    expect(r.out).toContain(TRICKS_OFF_LINE);
    // On: neither line.
    writeTricksFeature(r.stateDir, true);
    clear(r);
    expect(await cmdTrickList(r, [])).toBe(EXIT.OK);
    expect(r.out).not.toContain(TRICKS_OFF_LINE);
  });

  // The `--sh` sample is a `#!/bin/sh` program, and a shell run line does not run on Windows (bridge/tricks/run.ts).
  test.skipIf(process.platform === "win32")("check --run is a developer's tool: it runs a folder once in the terminal with tricks off", async () => {
    const r = await rig();
    expect(await cmdTrickInit(r, ["--sh", "plain"])).toBe(EXIT.OK);
    clear(r);
    expect(await cmdTrickCheck(r, ["--run", join(r.configDir, "tricks", "plain")])).toBe(EXIT.OK);
    expect(r.out.join("\n")).toContain("parts: belt belt");
    expect(readTricksFeature(r.stateDir).reading).toBe("unset");
  });
});
