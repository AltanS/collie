import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";

import { EXIT, type Io } from "./io.ts";
import { realFiles } from "./sys.ts";
import { cmdTrickDev, devTrigger, parseDevArgs, watchCounts, watchFolder } from "./trick-dev.ts";
import { cmdTrickInit, type TrickDeps } from "./trick.ts";
import { FACTS } from "../web/src/lib/tricks/fixtures/index.ts";

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

describe("the flags", () => {
  test("a folder, --tap with its --text and --node, --json and --watch", () => {
    expect(parseDevArgs(["."])).toEqual({ target: ".", tap: null, json: false, watch: false, facts: null, state: null, rid: null });
    expect(parseDevArgs(["look", "--tap", "rerun", "--text", "go on", "--node", "hill/case-24", "--json", "--watch"])).toEqual({
      target: "look",
      tap: { intent: "rerun", text: "go on", node: "hill/case-24" },
      json: true,
      watch: true,
      facts: null,
      state: null,
      rid: null,
    });
    expect(parseDevArgs(["--tap", "x"])).toEqual({ error: "name a trick folder or id" });
    expect(parseDevArgs([".", "--text", "x"])).toEqual({ error: "--text and --node go with --tap" });
    expect(parseDevArgs([".", "--tap"])).toEqual({ error: "--tap needs a value" });
    expect(parseDevArgs([".", "--bogus"])).toEqual({ error: "unknown flag --bogus" });
  });

  test("a tap on a hill node carries { text }; on a part, the text as its value", () => {
    expect(devTrigger({ intent: "rerun", text: "go", node: "hill/case-24" })).toMatchObject({ kind: "tap", node: "hill/case-24", intent: "rerun", value: { text: "go" } });
    expect(devTrigger({ intent: "skip", text: null, node: "hill/case-24" })).toMatchObject({ value: { text: null } });
    expect(devTrigger({ intent: "rerun", text: "3", node: "belt" })).toMatchObject({ node: "belt", value: "3" });
    expect(devTrigger({ intent: "rerun", text: null, node: "main" })).not.toHaveProperty("value");
  });

  test("--watch counts code and config.toml, never a log, a dot file, media/ or captures/", () => {
    for (const yes of ["program.ts", "config.toml", "lib/x.ts", "trick.toml"]) expect(watchCounts(yes)).toBe(true);
    for (const no of ["run.log", ".cache/x", "media/shot.png", "captures/a.png", "node_modules/x/index.js", "lib/.hidden", ""]) expect(watchCounts(no)).toBe(false);
  });
});

const RID = "0b9f6c1e-3d52-4c8a-9a47-5e1d2f7a8b90";

describe("--facts, --state and --rid", () => {
  test("the flags parse, and each error says what is wrong", () => {
    expect(parseDevArgs([".", "--facts", "f.json", "--state", "keep"])).toMatchObject({ facts: "f.json", state: "keep", rid: null });
    expect(parseDevArgs([".", "--tap", "go", "--rid", RID])).toMatchObject({ tap: { intent: "go" }, rid: RID });
    expect(parseDevArgs([".", "--facts"])).toEqual({ error: "--facts needs a value" });
    expect(parseDevArgs([".", "--state"])).toEqual({ error: "--state needs a value" });
    expect(parseDevArgs([".", "--tap", "go", "--rid"])).toEqual({ error: "--rid needs a value" });
    expect(parseDevArgs([".", "--rid", RID])).toEqual({ error: "--rid goes with --tap" });
    expect(parseDevArgs([".", "--tap", "go", "--rid", "abc"])).toEqual({ error: '--rid must be a UUID, not "abc"' });
  });

  test("devTrigger uses the rid it is given, else a fresh UUID each time", () => {
    const tap = { intent: "go", text: null, node: "main" };
    expect(devTrigger(tap, RID)).toMatchObject({ kind: "tap", rid: RID });
    const a = devTrigger(tap);
    const b = devTrigger(tap);
    expect(a.kind === "tap" && /^[0-9a-f-]{36}$/u.test(a.rid)).toBe(true);
    expect(a).not.toEqual(b);
  });

  /** A program that reads the facts from stdin itself and prints one status chip made from `chip(f)`. */
  const echo = (chip: string): string => `const f = JSON.parse(await Bun.stdin.text());
const text = String(${chip}).slice(0, 12);
console.log(JSON.stringify({ v: 1, parts: [{ at: "status", id: "status", chip: { text } }] }));
`;

  test("--facts: the program sees the file's facts, with this run's folder and state in place of the file's", async () => {
    const d = await deps();
    const dir = await trickWith(d, "mine", echo("f.host + \"/\" + f.sessions.length + (f.trick.id === \"mine\" ? \"+\" : \"!\")"), '["status"]');
    const file = join(await tempDir(), "facts.json");
    const own = { ...FACTS.timer, host: "lonehost", sessions: [], trick: { id: "other", dir: "/nowhere", state: "/nowhere/state" } };
    await writeFile(file, JSON.stringify(own));
    expect(await cmdTrickDev(d, [dir, "--facts", file])).toBe(EXIT.OK);
    const text = d.out.join("\n");
    expect(d.out[0]).toContain(`facts from ${file}, a timer run`);
    expect(text).toContain('"lonehost/0+"');
    d.out.length = 0;
    expect(await cmdTrickDev(d, [dir, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).parts[0].part.chip.text).toBe("bluefin/2+");
  });

  test("--facts: the file's own tap trigger runs, and --tap replaces it", async () => {
    const d = await deps();
    const dir = await trickWith(d, "trig", echo("f.trigger.kind + \":\" + (f.trigger.rid ?? \"-\")"), '["status"]');
    const file = join(await tempDir(), "facts.json");
    const tapFacts = { ...FACTS.timer, trigger: { kind: "tap", rid: RID, node: "main", intent: "again" } };
    await writeFile(file, JSON.stringify(tapFacts));
    expect(await cmdTrickDev(d, [dir, "--facts", file, "--json"])).toBe(EXIT.OK);
    const body = JSON.parse(d.out.join("\n"));
    expect(body.trigger).toBe("tap");
    expect(body.parts[0].part.chip.text).toBe(`tap:${RID}`.slice(0, 12));
    d.out.length = 0;
    const other = "7c1d0e52-8a3b-4f6e-b2d9-14a5c6e7f890";
    expect(await cmdTrickDev(d, [dir, "--facts", file, "--tap", "skip", "--rid", other, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).parts[0].part.chip.text).toBe(`tap:${other}`.slice(0, 12));
  });

  test("--facts: a missing file, a file that is not JSON and a refused file are usage errors that name the file and the path, and nothing runs", async () => {
    const d = await deps();
    const marker = join(await tempDir(), "ran");
    const dir = await trickWith(d, "never", `await Bun.write(${JSON.stringify(marker)}, "x");\nconsole.log(JSON.stringify({ v: 1, parts: [] }));\n`, '["status"]');
    const folder = await tempDir();
    const missing = join(folder, "missing.json");
    expect(await cmdTrickDev(d, [dir, "--facts", missing])).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toContain(`error: --facts ${missing}: cannot read the file`);
    const junk = join(folder, "junk.json");
    await writeFile(junk, "{ not json");
    d.err.length = 0;
    expect(await cmdTrickDev(d, [dir, "--facts", junk])).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toContain(`error: --facts ${junk}: not JSON`);
    const refused = join(folder, "refused.json");
    await writeFile(refused, JSON.stringify(FACTS.timer).replace('"status":"working"', '"status":"napping"'));
    d.err.length = 0;
    expect(await cmdTrickDev(d, [dir, "--facts", refused])).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toMatch(new RegExp(`error: --facts ${refused.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}: /sessions/0/status: .+`, "u"));
    expect(existsSync(marker)).toBe(false);
  });

  test("--state: the folder is kept and shared by two runs, and shown in --json only when given", async () => {
    const d = await deps();
    const dir = await trickWith(
      d,
      "counter",
      `import { appendFileSync, readFileSync } from "node:fs";
const f = JSON.parse(await Bun.stdin.text());
const file = f.trick.state + "/runs";
appendFileSync(file, "x");
const n = readFileSync(file, "utf8").length;
console.log(JSON.stringify({ v: 1, parts: [{ at: "status", id: "status", chip: { text: "run " + n } }] }));
`,
      '["status"]',
    );
    const keep = join(await tempDir(), "nested", "state");
    expect(await cmdTrickDev(d, [dir, "--state", keep, "--json"])).toBe(EXIT.OK);
    const first = JSON.parse(d.out.join("\n"));
    expect(first.state).toBe(keep);
    expect(first.parts[0].part.chip.text).toBe("run 1");
    d.out.length = 0;
    expect(await cmdTrickDev(d, [dir, "--state", keep, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).parts[0].part.chip.text).toBe("run 2");
    expect(await readFile(join(keep, "runs"), "utf8")).toBe("xx");
    d.out.length = 0;
    expect(await cmdTrickDev(d, [dir, "--json"])).toBe(EXIT.OK);
    const plain = JSON.parse(d.out.join("\n"));
    expect(plain).not.toHaveProperty("state");
    expect(plain.parts[0].part.chip.text).toBe("run 1");
  });

  test("--state resolves a relative path against the working directory", async () => {
    const d = await deps();
    const dir = await trickWith(d, "rel", echo("f.trick.state"), '["status"]');
    const name = `collie-dev-state-${String(process.pid)}-${String(Date.now())}`;
    const expected = resolve(name);
    dirs.push(expected);
    expect(await cmdTrickDev(d, [dir, "--state", name, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).state).toBe(expected);
    expect(existsSync(expected)).toBe(true);
  });

  test("--rid reaches the program as the tap's rid; without it each run gets a fresh one", async () => {
    const d = await deps();
    const dir = await trickWith(d, "ridder", echo("f.trigger.rid"), '["status"]');
    expect(await cmdTrickDev(d, [dir, "--tap", "go", "--rid", RID, "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).parts[0].part.chip.text).toBe(RID.slice(0, 12));
    d.out.length = 0;
    expect(await cmdTrickDev(d, [dir, "--tap", "go", "--json"])).toBe(EXIT.OK);
    expect(JSON.parse(d.out.join("\n")).parts[0].part.chip.text).not.toBe(RID.slice(0, 12));
    expect(await cmdTrickDev(d, [dir, "--rid", RID])).toBe(EXIT.USAGE);
    expect(d.err.join("\n")).toContain("error: --rid goes with --tap");
  });
});

describe("one run", () => {
  test("the init sample: each part with its place, id and shape, the decisions line, the run against the caps", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    d.out.length = 0;
    expect(await cmdTrickDev(d, ["legs"])).toBe(EXIT.OK);
    const text = d.out.join("\n");
    expect(d.out[0]).toStartWith("trick legs (legs) in ");
    expect(d.out[0]).toEndWith("fixture facts, a timer run");
    expect(text).toMatch(/status\s+status\s+"\d+ busy"\s+icon plug\s+tone (accent|muted)/u);
    expect(text).toMatch(/dashboard\s+dashboard\s+"legs"\s+badge \d+/u);
    expect(text).toMatch(/session\s+main\s+\(the manifest's name\)\s+subtitle ".+"\s+view \d+ nodes \(list\)/u);
    expect(text).toContain("decisions: none, so the open ones are withdrawn");
    expect(text).toMatch(/ran in \d+ ms of 10 s, exit 0, stdout [\d.]+ (B|KiB) of 64\.0 KiB/u);
  });

  test("a Decision, a refusal with its path, and a tap on a hill node", async () => {
    const d = await deps();
    const dir = await trickWith(
      d,
      "ask",
      `import { run } from "./trick.ts";
run((t) => {
  t.belt({ label: "far too long a face word" });
  t.status({ text: t.hillAnswer === null ? "asking" : "got " + t.hillAnswer.intent });
  t.decide({ key: "case-24", title: "Rerun case 24?", summary: "It failed twice.", options: [{ intent: "rerun", label: "Rerun" }, { intent: "skip", label: "Skip" }], recommends: { intent: "rerun", why: "It passed yesterday." }, media: [{ file: "media/a.png" }] });
});
`,
    );
    expect(await cmdTrickDev(d, [dir])).toBe(EXIT.FAIL);
    const text = d.out.join("\n");
    expect(text).toContain('decision  case-24  "Rerun case 24?"  options rerun, skip  recommends rerun  images 1');
    expect(text).toMatch(/refused {2}\/parts\/0\/mark\/label {2}/u);
    d.out.length = 0;
    expect(await cmdTrickDev(d, [dir, "--tap", "skip", "--node", "hill/case-24", "--json"])).toBe(EXIT.FAIL);
    const body = JSON.parse(d.out.join("\n"));
    expect(body.trigger).toBe("tap");
    expect(body.parts.map((p: { part: { id: string } }) => p.part.id)).toEqual(["status"]);
    expect(body.parts[0].part.chip.text).toBe("got skip");
    expect(body.decisions[0].key).toBe("case-24");
    expect(body.refusals[0].path).toBe("/parts/0/mark/label");
  });

  test("a failed run prints the problem and the stderr tail; keepDecisions says they stay", async () => {
    const d = await deps();
    const dir = await trickWith(d, "boom", `import { run } from "./trick.ts";\nrun(() => { throw new Error("no gh on PATH"); });\n`, '["belt"]');
    expect(await cmdTrickDev(d, [dir])).toBe(EXIT.FAIL);
    expect(d.out.join("\n")).toContain("problem: The provider exited with 1: error: no gh on PATH");
    const e = await deps();
    const kept = await trickWith(e, "keep", `import { run } from "./trick.ts";\nrun((t) => { t.belt({ label: "ok" }); t.keepDecisions(); });\n`, '["belt"]');
    expect(await cmdTrickDev(e, [kept])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("decisions: none listed, so the open ones stay as they are");
  });

  test("a folder that is not a trick, or a refused manifest, runs nothing", async () => {
    const d = await deps();
    expect(await cmdTrickDev(d, ["/nonexistent/collie-trick"])).toBe(EXIT.USAGE);
    expect(await cmdTrickDev(d, [])).toBe(EXIT.USAGE);
    const dir = await trickWith(d, "bad", "", '["nowhere"]');
    expect(await cmdTrickDev(d, [dir])).toBe(EXIT.FAIL);
    expect(d.out.join("\n")).toContain("not run");
  });
});

describe("--watch", () => {
  test("watchFolder calls once after a burst of changes, and not for a log", async () => {
    const dir = await tempDir();
    let calls = 0;
    const stop = watchFolder(dir, () => (calls += 1), 100);
    await Bun.sleep(50);
    await writeFile(join(dir, "run.log"), "x");
    await Bun.sleep(250);
    expect(calls).toBe(0);
    for (const n of [1, 2, 3]) await writeFile(join(dir, "program.ts"), `// ${String(n)}\n`);
    await Bun.sleep(400);
    stop();
    expect(calls).toBe(1);
  });

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
