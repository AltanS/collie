import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { instanceAmbient, listInstances, loadContext } from "./context.ts";
import { chooseDoctorInstance } from "./doctor-instance.ts";
import { capture, posixKey } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { COMMANDS, run } from "./program.ts";

// M71 spec 04: `collie doctor --instance <name>`. The lane comes from the flag, wins over a
// different COLLIE_INSTANCE, and nothing exported for another lane leaks in. Doctor alone takes it.

const HOME = "/home/pat";
const ROOT = `${HOME}/.config/herdr/plugins/config`;

/** A fake config root: the dirs `readdir` lists, and the `.env` files that exist. */
function fakeFs(dirs: readonly string[], envs: readonly string[]) {
  const files = new Set(envs);
  // `listInstances` joins with the machine's separator, so a lookup folds to the POSIX spelling first.
  return {
    fileExists: (p: string) => files.has(posixKey(p)),
    listDir: (p: string): string[] => (posixKey(p) === ROOT ? [...dirs] : []),
  };
}

describe("listInstances", () => {
  test("lists each herdr.collie-<name> with a .env, and default first", () => {
    const fs = fakeFs(
      ["herdr.collie", "herdr.collie-zellij", "herdr.collie-next", "herdr.collie-tmux", "herdr.pouch"],
      [
        `${ROOT}/herdr.collie/.env`,
        `${ROOT}/herdr.collie-next/.env`,
        `${ROOT}/herdr.collie-tmux/.env`,
        `${ROOT}/herdr.collie-zellij/.env`,
      ],
    );
    expect(listInstances(HOME, fs.fileExists, fs.listDir)).toEqual(["default", "next", "tmux", "zellij"]);
  });

  test("skips a dir with no .env and a name that is not an instance shape", () => {
    const fs = fakeFs(
      ["herdr.collie-empty", "herdr.collie-Bad", "herdr.collie-next"],
      [`${ROOT}/herdr.collie-Bad/.env`, `${ROOT}/herdr.collie-next/.env`],
    );
    expect(listInstances(HOME, fs.fileExists, fs.listDir)).toEqual(["next"]);
  });

  test("the legacy ~/.config/collie/.env counts as default", () => {
    const fs = fakeFs([], [`${HOME}/.config/collie/.env`]);
    expect(listInstances(HOME, fs.fileExists, fs.listDir)).toEqual(["default"]);
  });

  test("no config at all is no instances", () => {
    const fs = fakeFs([], []);
    expect(listInstances(HOME, fs.fileExists, fs.listDir)).toEqual([]);
  });
});

describe("instanceAmbient", () => {
  const leaky = {
    COLLIE_INSTANCE: "other",
    HERDR_PLUGIN_CONFIG_DIR: "/elsewhere",
    COLLIE_STATE_DIR: "/elsewhere/state",
    COLLIE_PORT: "9999",
    HOME,
  };

  test("a name replaces COLLIE_INSTANCE and drops the three values that would leak", () => {
    expect(instanceAmbient(leaky, "next")).toEqual({ COLLIE_INSTANCE: "next", HOME });
  });

  test("default removes COLLIE_INSTANCE instead of setting it", () => {
    expect(instanceAmbient(leaky, "default")).toEqual({ HOME });
  });

  test("the input env is left alone", () => {
    instanceAmbient(leaky, "next");
    expect(leaky.COLLIE_INSTANCE).toBe("other");
  });
});

describe("chooseDoctorInstance", () => {
  const known = () => ["default", "next", "tmux", "zellij"];

  test("reads --instance <name> and --instance=<name>, and passes the other args through", () => {
    expect(chooseDoctorInstance(["--json", "--instance", "next"], known)).toEqual({
      ok: true,
      instance: "next",
      rest: ["--json"],
    });
    expect(chooseDoctorInstance(["--instance=tmux", "--json"], known)).toEqual({
      ok: true,
      instance: "tmux",
      rest: ["--json"],
    });
  });

  test("no flag leaves the lane to the environment", () => {
    expect(chooseDoctorInstance(["--json"], known)).toEqual({ ok: true, instance: undefined, rest: ["--json"] });
  });

  test("default is accepted even when no config lists it", () => {
    expect(chooseDoctorInstance(["--instance", "default"], () => [])).toEqual({
      ok: true,
      instance: "default",
      rest: [],
    });
  });

  test("an unknown name is refused with the list", () => {
    expect(chooseDoctorInstance(["--instance", "nxt"], known)).toEqual({
      ok: false,
      message: 'error: no instance "nxt" here; instances: default, next, tmux, zellij',
    });
  });

  test("a bad shape is refused with the list", () => {
    const r = chooseDoctorInstance(["--instance", "Next"], known);
    expect(r).toEqual({ ok: false, message: 'error: no instance "Next" here; instances: default, next, tmux, zellij' });
  });

  test("a missing value is refused, not read as the next flag", () => {
    for (const args of [["--instance"], ["--instance", "--json"]]) {
      const r = chooseDoctorInstance(args, known);
      expect(r.ok).toBe(false);
    }
  });

  test("no instances on the machine says none", () => {
    const r = chooseDoctorInstance(["--instance=next"], () => []);
    expect(r).toEqual({ ok: false, message: 'error: no instance "next" here; instances: none' });
  });
});

describe("loadContext with an instance", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** A real temp HOME with a default lane (no state or port set) and two named lanes. */
  function machine(): string {
    const home = mkdtempSync(join(tmpdir(), "collie-doctor-instance-"));
    dirs.push(home);
    const lane = (suffix: string, env: string) => {
      const dir = join(home, ".config", "herdr", "plugins", "config", `herdr.collie${suffix}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, ".env"), env, { mode: 0o600 });
    };
    lane("", "COLLIE_MUX=herdr\n");
    lane("-next", `COLLIE_PORT=8788\nCOLLIE_STATE_DIR=${home}/state-next\n`);
    lane("-tmux", `COLLIE_PORT=8789\nCOLLIE_STATE_DIR=${home}/state-tmux\n`);
    return home;
  }

  const quiet = () => {};

  test("the flag beats a different COLLIE_INSTANCE, and nothing exported for it leaks", () => {
    const home = machine();
    const ctx = loadContext(quiet, {
      instance: "next",
      ambient: {
        HOME: home,
        PATH: "",
        COLLIE_INSTANCE: "tmux",
        HERDR_PLUGIN_CONFIG_DIR: join(home, ".config", "herdr", "plugins", "config", "herdr.collie-tmux"),
        COLLIE_STATE_DIR: `${home}/state-leaked`,
        COLLIE_PORT: "9999",
      },
    });
    expect(ctx.instance).toBe("next");
    expect(ctx.configDir).toBe(join(home, ".config", "herdr", "plugins", "config", "herdr.collie-next"));
    expect(ctx.stateDir).toBe(`${home}/state-next`);
    expect(ctx.env.COLLIE_PORT).toBe("8788");
  });

  test("default clears the instance the environment named", () => {
    const home = machine();
    const ctx = loadContext(quiet, {
      instance: "default",
      ambient: {
        HOME: home,
        PATH: "",
        COLLIE_INSTANCE: "tmux",
        COLLIE_PORT: "9999",
        COLLIE_STATE_DIR: `${home}/state-leaked`,
      },
    });
    expect(ctx.instance).toBeNull();
    expect(ctx.configDir).toBe(join(home, ".config", "herdr", "plugins", "config", "herdr.collie"));
    expect(ctx.stateDir).not.toContain("state-leaked");
  });

  test("without the option the ambient environment still decides", () => {
    const home = machine();
    const ctx = loadContext(quiet, { ambient: { HOME: home, PATH: "", COLLIE_INSTANCE: "tmux", COLLIE_PORT: "8789" } });
    expect(ctx.instance).toBe("tmux");
  });
});

describe("the doctor verb", () => {
  const dirs: string[] = [];
  const saved = { HOME: process.env.HOME, COLLIE_INSTANCE: process.env.COLLIE_INSTANCE };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function machineWithNext(): void {
    const home = mkdtempSync(join(tmpdir(), "collie-doctor-instance-"));
    dirs.push(home);
    const dir = join(home, ".config", "herdr", "plugins", "config", "herdr.collie-next");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), "COLLIE_PORT=8788\n", { mode: 0o600 });
    process.env.HOME = home;
    delete process.env.COLLIE_INSTANCE;
  }

  test("an unknown name exits 2 before any check and lists the instances", async () => {
    machineWithNext();
    const io = capture();
    expect(await run(["doctor", "--instance", "nxt"], io, COMMANDS)).toBe(EXIT.USAGE);
    expect(io.stdout).toEqual([]);
    expect(io.stderr).toEqual(['error: no instance "nxt" here; instances: next']);
  });

  test("a bad shape exits 2", async () => {
    machineWithNext();
    const io = capture();
    expect(await run(["doctor", "--instance=Next"], io, COMMANDS)).toBe(EXIT.USAGE);
    expect(io.stderr.join("\n")).toContain('no instance "Next" here');
  });

  test("the help summary names the flag", () => {
    expect(COMMANDS.find((c) => c.name === "doctor")?.summary).toBe(
      "check this install for the traps that fail silently (--json, --instance <name>)",
    );
  });
});
