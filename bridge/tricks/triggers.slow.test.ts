// The slow cases of triggers.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventBus } from "../events/bus.ts";
import { powersOfDir } from "./approved.ts";
import { trickCodeHash } from "./code-hash.ts";
import { TRICKS_DIR } from "./paths.ts";
import type { RunOutcome, RunSpec } from "./run.ts";
import { TricksService, type TricksServiceDeps } from "./service.ts";
import { withSwitch, writeSwitches, type Switches } from "./switches.ts";
import { type WatchOptions } from "./watch.ts";

// `on` and `watch` (M105 spec 03, decisions 9 to 11). Two layers: TrickReactions against a fake host (the
// folding, one rule at a time), and the whole TricksService with a real bus and a real folder (the gates,
// the road a run takes, the switch-off, the card). The wire a program receives has its own contract test.

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-tricks-triggers-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const HOST = "lodge";

const MACHINE = HOST;

const tick = (ms = 0): Promise<void> => Bun.sleep(ms);

// A manifest's `watch` path starts with `/` or `~/` (web/src/lib/tricks/schema.ts), so the temp-folder path of a
// real file on Windows (`C:\...`) is refused with "A watched path starts with / or ~/." and the trick never
// watches. Tricks are closed on Windows behind the gate, so no Windows path form is defined yet; a test that
// writes a real file path into a manifest is POSIX only before the Windows gate for tricks opens. The watcher
// itself (bridge/tricks/watch.test.ts) runs on Windows.
const watchTest = test.skipIf(process.platform === "win32");

const FAST: WatchOptions = { debounceMs: 40, maxWaitMs: 160, pollMs: 60 };

function newBus(): EventBus {
  return new EventBus({ machine: () => MACHINE });
}

// ── The whole service, a real bus and a real folder ──────────────────────────────────────────────────

interface Rig {
  root: string;
  configDir: string;
  stateDir: string;
  clock: { t: number };
  warnings: string[];
  service: TricksService;
  specs: RunSpec[];
  bus: EventBus;
  set: { active: boolean };
}

const T0 = Date.parse("2026-11-08T09:00:00Z");

const exited = (stdout: string, code = 0): RunOutcome => ({ kind: "exited", code, stdout, stderr: "", ms: 5 });

const belt = (label: string): string => JSON.stringify({ v: 1, asOf: "2026-11-08T09:00:00Z", parts: [{ at: "belt", id: "belt", mark: { label, intent: "x" } }] });

const OK = exited(belt("ok"));

type Scripted = RunOutcome | { later: () => Promise<RunOutcome> };

async function rig(outcomes: Scripted[] | null, extra: Partial<TricksServiceDeps> = {}): Promise<Rig> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const clock = { t: T0 };
  const warnings: string[] = [];
  const specs: RunSpec[] = [];
  const set = { active: true };
  const bus = newBus();
  let i = 0;
  const deps: TricksServiceDeps = {
    configDir,
    stateDir,
    memberId: HOST,
    world: (memberId) => ({
      machine: "desk",
      sessions: [{ id: `${memberId}:w6X:3`, memberId, sessionId: `${memberId}:w6X:3`, paneId: "w6X:3", host: "desk", name: "composer", agent: "claude", status: "working" }],
      spaces: [{ name: "collie", folder: "/work/collie" }],
    }),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    now: () => clock.t,
    warn: (line) => warnings.push(line),
    revBase: 1000,
    active: () => set.active,
    bus,
    watchOptions: FAST,
    // Tricks as a whole switched on (feature-switch.ts); the test of the big switch passes its own.
    feature: { on: () => true },
    ...extra,
  };
  if (outcomes !== null) {
    deps.run = async (spec: RunSpec): Promise<RunOutcome> => {
      specs.push(spec);
      const next = outcomes[Math.min(i, outcomes.length - 1)];
      i += 1;
      if (next === undefined) throw new Error("no outcome scripted");
      return "later" in next ? await next.later() : next;
    };
  }
  return { root, configDir, stateDir, clock, warnings, service: new TricksService(deps), specs, bus, set };
}

async function makeTrick(configDir: string, id: string, manifest: string, files: Record<string, string> = {}): Promise<string> {
  const dir = join(configDir, TRICKS_DIR, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "trick.toml"), manifest);
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o755 });
  return dir;
}

async function switchOn(stateDir: string, ...ids: string[]): Promise<void> {
  let switches: Switches = { on: new Map() };
  for (const id of ids) {
    const dir = join(dirname(stateDir), "config", TRICKS_DIR, id);
    const code = await trickCodeHash(dir);
    switches = withSwitch(switches, id, true, "2026-11-08T09:00:00Z", code.ok ? code.hash : null, await powersOfDir(dir, id));
  }
  await writeSwitches(stateDir, switches);
}

async function tickAt(r: Rig, t: number, watch = true): Promise<void> {
  r.clock.t = t;
  if (watch) r.service.noteWatched();
  await r.service.refresh(true);
  await r.service.tick();
}

const watchManifest = (...paths: string[]): string => `id = "react"\nname = "React"\nrun = "./react.sh"\nplaces = ["belt"]\nwatch = [${paths.map((p) => JSON.stringify(p)).join(", ")}]\n`;

describe("`watch` runs a trick, and never loops on its own writes", () => {
  watchTest("a trick that writes the file it watches runs once for an outside change, not again for its own write", async () => {
    const dir = await tempDir();
    const file = join(dir, "state.json");
    await writeFile(file, "{}");
    let runs = 0;
    // Every run, the start run too, rewrites the file it watches, as a trick keeping its state in it would.
    const own = await rig(null, {
      run: async () => {
        runs += 1;
        await writeFile(file, `{"run":${String(runs)}}`);
        return OK;
      },
    });
    await makeTrick(own.configDir, "react", watchManifest(file));
    await switchOn(own.stateDir, "react");
    await tickAt(own, T0);
    await tick(250);
    // The start run's own write is absorbed.
    expect(runs).toBe(1);
    await writeFile(file, '{"outside":true}');
    await tick(400);
    // One run for the outside change; the write that run made did not start another.
    expect(runs).toBe(2);
    await tick(400);
    expect(runs).toBe(2);
    own.service.stop();
  });
});
