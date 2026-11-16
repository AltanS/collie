import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hillSwitchRoute } from "../server.ts";
import { bridgeSkillFollower, runSkillSync, type SkillFollowDeps, type SkillSyncChild } from "./skill-follow.ts";
import { HillSwitch, readHillSwitch, setHillSwitch, writeHillSwitch } from "./switch.ts";

// THE SKILL FOLLOWS THE SWITCH (M96 spec 12): the one writer syncs only on a real change and never fails
// for it, and the bridge's follower spawns this build's own `skill sync --json` with nothing from the
// request, does not make the phone wait, runs one sync at a time, and logs one line. Every child here is
// a fake: nothing reaches a real harness file.

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "hill-skill-follow-"));
  roots.push(dir);
  return dir;
}

const SYNCED = JSON.stringify({ changed: [{ harness: "claude", path: "/h/.claude/skills/collie-walky-talky/SKILL.md", action: "updated" }], refused: [], skipped: [] });

interface Spawned {
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  finish(code: number, stdout: string, stderr?: string): void;
  killed: boolean;
}

/** A fake spawn: each child waits until the test finishes it. */
interface FakeSpawn {
  readonly spawned: Spawned[];
  readonly spawn: NonNullable<SkillFollowDeps["spawn"]>;
}

function fakeSpawn(): FakeSpawn {
  const spawned: Spawned[] = [];
  const spawn = (argv: readonly string[], env: Record<string, string>): SkillSyncChild => {
    let done: (v: [number, string, string]) => void = () => undefined;
    const result = new Promise<[number, string, string]>((resolve) => {
      done = resolve;
    });
    const record: Spawned = {
      argv,
      env,
      killed: false,
      finish: (code, stdout, stderr = "") => done([code, stdout, stderr]),
    };
    spawned.push(record);
    return {
      exited: result.then(([code]) => code),
      stdout: result.then(([, out]) => out),
      stderr: result.then(([, , err]) => err),
      kill: () => {
        record.killed = true;
        done([143, "", ""]);
      },
    };
  };
  return { spawned, spawn };
}

describe("the one writer of the switch", () => {
  test("follows only a real change of the value: a first off over no file, and a same-value write, sync nothing", () => {
    const dir = stateDir();
    const followed: boolean[] = [];
    const opts = { follow: (on: boolean) => void followed.push(on), warn: () => undefined };
    expect(setHillSwitch(dir, false, opts)).toBe(false);
    expect(setHillSwitch(dir, true, opts)).toBe(true);
    expect(setHillSwitch(dir, true, opts)).toBe(false);
    expect(setHillSwitch(dir, false, opts)).toBe(true);
    expect(followed).toEqual([true, false]);
  });

  test("a follower that throws is one warning; the switch is written and the change is reported", () => {
    const dir = stateDir();
    const warnings: string[] = [];
    const moved = setHillSwitch(dir, true, {
      follow: () => {
        throw new Error("EIO");
      },
      warn: (line) => warnings.push(line),
    });
    expect(moved).toBe(true);
    expect(readHillSwitch(dir)).toEqual({ on: true, problem: null });
    expect(warnings).toEqual(["the WalkyTalky skill did not follow the switch: EIO"]);
  });
});

describe("the phone's switch route", () => {
  /** The route over the real switch, as HillService.switchTo drives it. */
  function route(dir: string, follow: (on: boolean) => void) {
    const warnings: string[] = [];
    const sw = new HillSwitch(dir, follow, (line) => warnings.push(line));
    const hill = { isOn: () => sw.on(), switchTo: (on: boolean) => (sw.set(on) ? sw.on() : null) };
    const post = (on: boolean): Response => hillSwitchRoute(hill, { body: { on } }, { device: "phone", acceptEncoding: null });
    return { post, warnings };
  }

  test("answers at once while the sync still runs, and a same-value POST starts none", async () => {
    const dir = stateDir();
    const { spawned, spawn } = fakeSpawn();
    const logs: string[] = [];
    const follow = bridgeSkillFollower({ stateDir: dir, env: {}, log: (l) => logs.push(l), self: ["/opt/collie/bin/collie"], spawn });
    const { post } = route(dir, follow);
    const answer = post(true);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ on: true });
    expect(spawned.length).toBe(1);
    expect(await post(true).json()).toEqual({ on: true });
    expect(spawned.length).toBe(1);
    spawned[0]?.finish(0, SYNCED);
    await follow.idle();
    expect(logs).toEqual(["[hill] the Hill was switched on; WalkyTalky skill sync: updated claude"]);
  });

  test("a follower that throws does not fail the answer", async () => {
    const dir = stateDir();
    const { post, warnings } = route(dir, () => {
      throw new Error("spawn EACCES");
    });
    const answer = post(true);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ on: true });
    expect(warnings).toEqual(["the WalkyTalky skill did not follow the switch: spawn EACCES"]);
  });
});

describe("the bridge's follower", () => {
  test("spawns this build's own `skill sync --json`, with the bridge's environment and its state dir, and nothing else", async () => {
    const dir = stateDir();
    const { spawned, spawn } = fakeSpawn();
    const follow = bridgeSkillFollower({ stateDir: dir, env: { HOME: "/h", COLLIE_STATE_DIR: "/elsewhere", UNSET: undefined }, log: () => undefined, self: ["/usr/bin/bun", "/repo/cli/main.ts"], spawn });
    follow(true);
    expect(spawned[0]?.argv).toEqual(["/usr/bin/bun", "/repo/cli/main.ts", "skill", "sync", "--json"]);
    expect(spawned[0]?.env).toEqual({ HOME: "/h", COLLIE_STATE_DIR: dir });
    spawned[0]?.finish(0, SYNCED);
    await follow.idle();
  });

  test("one sync at a time: changes while one runs fold into one more run, which starts after the last change", async () => {
    const dir = stateDir();
    const { spawned, spawn } = fakeSpawn();
    const logs: string[] = [];
    const follow = bridgeSkillFollower({ stateDir: dir, env: {}, log: (l) => logs.push(l), self: ["collie"], spawn });
    follow(true);
    follow(false);
    follow(true);
    expect(spawned.length).toBe(1);
    spawned[0]?.finish(0, JSON.stringify({ changed: [], refused: [], skipped: [] }));
    for (let i = 0; i < 10 && spawned.length < 2; i += 1) await Promise.resolve();
    expect(spawned.length).toBe(2);
    spawned[1]?.finish(0, SYNCED);
    await follow.idle();
    expect(spawned.length).toBe(2);
    expect(logs).toEqual([
      "[hill] the Hill was switched on; WalkyTalky skill sync: nothing to change",
      "[hill] the Hill was switched on; WalkyTalky skill sync: updated claude",
    ]);
  });

  test("COLLIE_SKILL_SYNC=off starts nothing and says so in one line", () => {
    const { spawned, spawn } = fakeSpawn();
    const logs: string[] = [];
    const follow = bridgeSkillFollower({ stateDir: stateDir(), env: { COLLIE_SKILL_SYNC: "off" }, log: (l) => logs.push(l), self: ["collie"], spawn });
    follow(false);
    expect(spawned).toEqual([]);
    expect(logs.length).toBe(1);
    expect(logs[0]).toContain("COLLIE_SKILL_SYNC is off");
  });

  test("each fault is one journal line: a spawn that throws, a non-zero exit, no JSON, a timeout", async () => {
    const dir = stateDir();
    const logs: string[] = [];
    const base = { stateDir: dir, env: {}, log: (l: string) => logs.push(l), self: ["collie"] };
    await runSkillSync(
      {
        ...base,
        spawn: () => {
          throw new Error("ENOENT");
        },
      },
      true,
    );
    const failing = fakeSpawn();
    const run = runSkillSync({ ...base, spawn: failing.spawn }, false);
    failing.spawned[0]?.finish(1, "", "error: skill sync stopped\n");
    await run;
    const brief = fakeSpawn();
    const old = runSkillSync({ ...base, spawn: brief.spawn }, false);
    brief.spawned[0]?.finish(0, "the general brief\n");
    await old;
    const hanging = fakeSpawn();
    await runSkillSync({ ...base, spawn: hanging.spawn, timeoutMs: 5 }, true);
    expect(hanging.spawned[0]?.killed).toBe(true);
    expect(logs).toEqual([
      "[hill] the Hill was switched on, and the WalkyTalky skill sync did not start: ENOENT",
      "[hill] the Hill was switched off, and the WalkyTalky skill sync failed: error: skill sync stopped; run `collie skill sync`",
      "[hill] the Hill was switched off, and the WalkyTalky skill sync failed: it printed no sync result; run `collie skill sync`",
      "[hill] the Hill was switched on, and the WalkyTalky skill sync took longer than 0.005 s; run `collie skill sync`",
    ]);
  });

  test("a bridge start writes no switch, so a fresh switch object syncs nothing until a real change", () => {
    const dir = stateDir();
    writeHillSwitch(dir, true);
    const followed: boolean[] = [];
    const sw = new HillSwitch(dir, (on) => void followed.push(on), () => undefined);
    expect(sw.on()).toBe(true);
    expect(sw.set(true)).toBe(true);
    expect(followed).toEqual([]);
  });
});
