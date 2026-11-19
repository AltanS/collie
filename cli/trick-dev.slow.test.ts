// The slow cases of trick-dev.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, type Io } from "./io.ts";
import { realFiles } from "./sys.ts";
import { cmdTrickDev } from "./trick-dev.ts";
import { cmdTrickInit, type TrickDeps } from "./trick.ts";

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-trick-dev-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function deps(): Promise<TrickDeps & { out: string[]; err: string[]; configDir: string }> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l) => out.push(l), err: (l) => err.push(l) };
  return {
    io,
    out,
    err,
    configDir,
    ctx: { configDir, stateDir, port: 18_999, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root } },
    files: realFiles,
    fetch: async () => {
      throw new Error("trick dev never talks to the bridge");
    },
    now: () => Date.parse("2026-11-08T09:00:00Z"),
  };
}

/** A trick folder `id` in the config dir, a TypeScript program with the helper, its source replaced by `program`. */
async function trickWith(d: Awaited<ReturnType<typeof deps>>, id: string, program: string, places = '["status", "dashboard", "session", "belt"]'): Promise<string> {
  await cmdTrickInit(d, [id]);
  const dir = join(d.configDir, "tricks", id);
  await writeFile(join(dir, "program.ts"), program);
  await writeFile(join(dir, "trick.toml"), `id = "${id}"\nname = "${id}"\nrun = "program.ts"\nplaces = ${places}\n`);
  d.out.length = 0;
  return dir;
}

describe("--watch", () => {
  test("cmdTrickDev --watch runs once, runs again on a change, and returns when told to stop", async () => {
    const d = await deps();
    const dir = await trickWith(d, "watched", `import { run } from "./trick.ts";\nrun((t) => { t.belt({ label: "one" }); });\n`, '["belt"]');
    let stopWatching = (): void => {};
    const until = new Promise<void>((done) => {
      stopWatching = done;
    });
    const running = cmdTrickDev(d, [dir, "--watch"], until);
    await Bun.sleep(800);
    expect(d.out.join("\n")).toContain('"one"');
    await writeFile(join(dir, "program.ts"), `import { run } from "./trick.ts";\nrun((t) => { t.belt({ label: "two" }); });\n`);
    for (let i = 0; i < 40 && !d.out.join("\n").includes('"two"'); i += 1) await Bun.sleep(100);
    stopWatching();
    expect(await running).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain('"two"');
  });
});
