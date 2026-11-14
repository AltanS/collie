import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { COMMAND_PROBE_CACHE_MS, documentCarriesOurHooks, hooksInstalledProbe, HOOKS_PROBE_TTL_MS, procBeaconLiveness, readStartTimeSync } from "./beacon-io.ts";
import { HOOK_MARKER } from "../cli/hooks.ts";
import { nativeCommand } from "../cli/codex-native.ts";
import { parseHookTarget } from "./beacon/hook-targets.ts";
import { parseLstart, type StartTimeCommand } from "./beacon/liveness.ts";
import { beaconFileName, beaconKey } from "./beacon/paths.ts";
import { readBeacons } from "./beacon/reader.ts";
import { BEACON_SCHEMA_VERSION } from "./beacon/types.ts";

// The one question the bridge asks about the agent's settings: are OUR hooks in it? The filesystem
// half of this module needs a real disk and is exercised by the CLI's own suite; what is pinned here
// is the answer's shape and the cache in front of it.

const HOME = "/home/dev";

/** A settings document with one marked entry, as `collie hooks install claude` writes it. */
function installed(): string {
  return JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: `/home/dev/.local/bin/collie beacon emit ${HOOK_MARKER}` }] }],
    },
  });
}

describe("documentCarriesOurHooks", () => {
  test("an installed settings file says yes", () => {
    expect(documentCarriesOurHooks(installed())).toBe(true);
  });

  test("the operator's own hooks are not ours", () => {
    const theirs = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] } });
    expect(documentCarriesOurHooks(theirs)).toBe(false);
  });

  test("a settings file with no hooks at all says no", () => {
    expect(documentCarriesOurHooks(JSON.stringify({ model: "opus" }))).toBe(false);
  });

  test("garbage says no rather than throwing — a file we cannot read holds nothing of ours", () => {
    for (const text of ["", "{", "[]", "null", '{"hooks":"yes"}', '{"hooks":{"Stop":"nope"}}']) {
      expect(documentCarriesOurHooks(text)).toBe(false);
    }
  });
});

describe("hooksInstalledProbe", () => {
  test("one profile carrying the marker is enough", () => {
    // The target path is built with `join`, so it carries this platform's separator.
    const workSettings = join("/home/dev/.claude-work", "settings.json");
    const probe = hooksInstalledProbe({
      home: HOME,
      env: { COLLIE_TRANSCRIPT_ROOT: "/home/dev/.claude-work/projects" },
      readFile: (path) => (path === workSettings ? installed() : null),
    });
    expect(probe()).toBe(true);
  });

  test("no settings file anywhere is a no, not a throw", () => {
    expect(hooksInstalledProbe({ home: HOME, env: {}, readFile: () => null })()).toBe(false);
  });

  test("Codex's own hooks count, from the bridge's CODEX_HOME, else ~/.codex; its notify line does not", () => {
    const native = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: nativeCommand("/home/dev/.local/bin/collie") }] }] } });
    const at = (file: string, text: string) => (path: string) => (path === file ? text : null);
    expect(hooksInstalledProbe({ home: HOME, env: {}, readFile: at(join(HOME, ".codex", "hooks.json"), native) })()).toBe(true);
    expect(hooksInstalledProbe({ home: HOME, env: { CODEX_HOME: "/srv/codex" }, readFile: at(join("/srv/codex", "hooks.json"), native) })()).toBe(true);
    expect(hooksInstalledProbe({ home: HOME, env: {}, readFile: at(join(HOME, ".codex", "hooks.json"), JSON.stringify({ hooks: {} })) })()).toBe(false);
    const notify = 'notify = ["/home/dev/.local/bin/collie","beacon","emit","codex"]\n';
    expect(hooksInstalledProbe({ home: HOME, env: {}, readFile: at(join(HOME, ".codex", "config.toml"), notify) })()).toBe(false);
  });

  test("the answer is cached, then re-read — installing the hooks needs no restart", () => {
    let text: string | null = null;
    let clock = 1000;
    const probe = hooksInstalledProbe({ home: HOME, env: {}, now: () => clock, readFile: () => text });
    expect(probe()).toBe(false);
    text = installed();
    // Inside the window the cached answer stands — the declaration must not cost a disk read per call.
    clock += HOOKS_PROBE_TTL_MS - 1;
    expect(probe()).toBe(false);
    clock += 2;
    expect(probe()).toBe(true);
  });
});

describe("parseHookTarget, the optional identity fields (M76 spec 02)", () => {
  const base = { schemaVersion: 1, stateDir: "/srv/a", pid: 4242, pidStartTime: 7, bootedAt: 1 };

  test("a record without mux, instance and port still parses, and reads them as unknown", () => {
    expect(parseHookTarget(JSON.stringify(base))).toEqual({ ...base, mux: null, instance: null, port: null });
  });

  test("a record with all three carries them", () => {
    expect(parseHookTarget(JSON.stringify({ ...base, mux: "herdr", instance: "next", port: 8788 }))).toMatchObject({ mux: "herdr", instance: "next", port: 8788 });
  });

  test("a field of the wrong type or range is dropped, never a reason to refuse the record", () => {
    const wrong = { ...base, mux: 7, instance: "", port: 70000 };
    expect(parseHookTarget(JSON.stringify(wrong))).toEqual({ ...base, mux: null, instance: null, port: null });
    expect(parseHookTarget(JSON.stringify({ ...base, mux: "x".repeat(200), port: 1.5 }))).toMatchObject({ mux: null, port: null });
    expect(parseHookTarget(JSON.stringify({ ...base, mux: ["herdr"], instance: {}, port: "8788" }))).toMatchObject({ mux: null, instance: null, port: null });
  });

  test("the required fields still decide: a record with no state dir is not a record", () => {
    expect(parseHookTarget(JSON.stringify({ ...base, stateDir: "", mux: "herdr" }))).toBeNull();
  });
});

// The real pid probe's two platform paths (M80 spec 11, issue 647), with the file read and the `ps`
// run injected: no test here reads a real `/proc` or forks a process.
describe("procBeaconLiveness", () => {
  const PID = 4242;
  const LSTART = "Mon Nov  2 10:15:33 2026\n";
  const STORED = parseLstart(LSTART)!;
  const MARKER = { namespace: "herdr-core", scope: "/Users/pat/.local/state/herdr-core/default.sock", pane: "t3" };
  const NOW = Date.parse("2026-11-02T12:00:00.000Z");

  /** A `ps` that answers `answer` for every pid and counts its runs. */
  function fakePs(answer: () => string | null) {
    const runs: string[][] = [];
    const run = (command: StartTimeCommand, pid: number): Promise<string | null> => {
      runs.push([command.file, ...command.args(pid)]);
      return Promise.resolve(answer());
    };
    return { runs, run };
  }

  /** One sweep over one beacon that stored {@link STORED}, with the given probe. */
  async function sweepOne(liveness: ReturnType<typeof procBeaconLiveness>): Promise<string | undefined> {
    const document = {
      schemaVersion: BEACON_SCHEMA_VERSION,
      harness: "claude",
      session: { kind: "id", value: "0f9d1c2e-1111-4222-8333-444455556666" },
      status: "working",
      pid: PID,
      pidStartTime: STORED,
      markers: [MARKER],
      heartbeatMs: NOW - 60_000,
    };
    const name = beaconFileName(beaconKey(document.markers));
    const directory = { list: () => Promise.resolve([name]), read: () => Promise.resolve(JSON.stringify(document)) };
    const [reading] = await readBeacons({ directory, liveness, now: () => NOW });
    return reading?.liveness;
  }

  test("on macOS a beacon is live while ps returns the stored lstart", async () => {
    const ps = fakePs(() => LSTART);
    expect(await sweepOne(procBeaconLiveness({ platform: "darwin", readText: () => null, run: ps.run }))).toBe("live");
    expect(ps.runs).toEqual([["/bin/ps", "-o", "lstart=", "-p", String(PID)]]);
  });

  test("on macOS a beacon is expired once the start differs (a reused pid) or ps answers nothing", async () => {
    for (const answer of ["Mon Nov  2 10:15:34 2026\n", "", null]) {
      expect(await sweepOne(procBeaconLiveness({ platform: "darwin", readText: () => null, run: fakePs(() => answer).run }))).toBe("expired");
    }
  });

  test("on macOS one pid runs ps once per cache window, so a herd poll does not fork per beacon per pass", async () => {
    let clock = 1000;
    const ps = fakePs(() => LSTART);
    const liveness = procBeaconLiveness({ platform: "darwin", readText: () => null, run: ps.run, now: () => clock });
    expect(await liveness.startTimeOf(PID)).toBe(STORED);
    clock += COMMAND_PROBE_CACHE_MS - 1;
    expect(await liveness.startTimeOf(PID)).toBe(STORED);
    expect(ps.runs).toHaveLength(1);
    clock += 1;
    expect(await liveness.startTimeOf(PID)).toBe(STORED);
    expect(ps.runs).toHaveLength(2);
  });

  test("Linux reads the stat file and never runs ps; no stat file is null", async () => {
    const stat = `${String(PID)} (claude) S ${Array.from({ length: 18 }, (_v, i) => i).join(" ")} 987654 0 0`;
    const ps = fakePs(() => LSTART);
    const linux = procBeaconLiveness({ platform: "linux", readText: (path) => (path === `/proc/${String(PID)}/stat` ? stat : null), run: ps.run });
    expect(await linux.startTimeOf(PID)).toBe(987_654);
    expect(await linux.startTimeOf(PID + 1)).toBeNull();
    expect(ps.runs).toEqual([]);
  });

  test("Windows has no probe: null, and nothing runs", async () => {
    const ps = fakePs(() => LSTART);
    expect(await procBeaconLiveness({ platform: "win32", readText: () => null, run: ps.run }).startTimeOf(PID)).toBeNull();
    expect(ps.runs).toEqual([]);
  });

  test("the hook target registration reads its own start with the same probe", () => {
    expect(readStartTimeSync(PID, { platform: "darwin", readText: () => null, run: () => LSTART })).toBe(STORED);
    expect(readStartTimeSync(PID, { platform: "darwin", readText: () => null, run: () => null })).toBeNull();
    expect(readStartTimeSync(PID, { platform: "win32", readText: () => null, run: () => LSTART })).toBeNull();
  });
});
