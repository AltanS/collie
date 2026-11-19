// The slow cases of trick.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS } from "../../web/src/lib/tricks/fixtures/index.ts";
import { parseFacts, type TrickFacts } from "../../web/src/lib/tricks/schema.ts";
import { TRICK_HELPER } from "../../bridge/tricks/scan.ts";

// The helper (cli/trick-kit/trick.ts) is copied into a trick folder as text, so nothing in the schema's
// own tests sees it. These tests hold it to the schema: every builder's node and every place's part
// parses with the real parser, and the helper's run behaves as its comments say when a real Bun runs a
// small program on it, as the bridge would.

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-trick-kit-"));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** The schema's timer facts with this folder and a state folder of its own. */
function factsFor(dir: string, state: string, trigger?: TrickFacts["trigger"]): TrickFacts {
  const parsed = parseFacts(FACTS.timer);
  if (parsed.facts === undefined) throw new Error("the fixture facts do not parse");
  const facts: TrickFacts = { ...parsed.facts, trick: { id: "kit", dir, state } };
  if (trigger !== undefined) facts.trigger = trigger;
  return facts;
}

interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** A trick folder with the helper, `program.ts` and a manifest naming `places`. */
async function trickFolder(program: string, places: readonly string[] = ["status", "dashboard", "session", "belt", "tabbar"]): Promise<{ dir: string; state: string }> {
  const root = await tempDir();
  const dir = join(root, "kit");
  await mkdir(dir);
  await writeFile(join(dir, "trick.ts"), TRICK_HELPER);
  await writeFile(join(dir, "program.ts"), program);
  await writeFile(join(dir, "trick.toml"), `id = "kit"\nname = "Kit"\nrun = "program.ts"\nplaces = ${JSON.stringify(places)}\n`);
  return { dir, state: join(root, "state") };
}

/** Run `program.ts` with the Bun that runs the tests, the facts on stdin. */
async function runProgram(dir: string, facts: TrickFacts, env: Record<string, string> = {}): Promise<Ran> {
  const child = Bun.spawn([process.execPath, "--no-install", join(dir, "program.ts")], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", ...env },
    stdin: new Blob([JSON.stringify(facts)]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

describe("helper v6: a run ends after the pipe took its output (Windows fault b)", () => {
  test("a big document arrives whole, and a timer the trick left open does not hold the run", async () => {
    const program = `import { run, v } from "./trick.ts";\nrun((t) => { setInterval(() => {}, 60_000); t.session({ id: "big", view: [v.para("x".repeat(60_000))] }); });\n`;
    const { dir, state } = await trickFolder(program, ["session"]);
    const started = Date.now();
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout).parts[0].id).toBe("big");
    expect(Date.now() - started).toBeLessThan(8000);
  });
});
