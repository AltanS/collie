import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACTS } from "../../web/src/lib/tricks/fixtures/index.ts";
import { parseJson } from "../../web/src/lib/json.ts";
import { PLACE_KINDS, parseDecisionView, parseFacts, parseTrickDocumentText, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT, type TrickFacts } from "../../web/src/lib/tricks/schema.ts";
import { TRICK_HELPER } from "../../bridge/tricks/scan.ts";
import { sampleConfig, sampleManifest, sampleProgram } from "../trick.ts";
import { age, clip, CONTRACT, firstSentence, iso, mapText, minute, now, Trick, v, type Facts, type Node } from "./trick.ts";

// gated on Windows (b): a program that uses the helper (`./trick.ts`) prints nothing on Windows yet, so
// Collie gates tricks there (bridge/tricks/service.ts `gated`). Each `helperTest` runs such a program.
const helperTest = test.skipIf(process.platform === "win32");

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

const ALL_PLACES = [...PLACE_KINDS];

describe("the builders cannot drift from the schema", () => {
  test("the helper speaks the contract this Collie speaks: one number", () => {
    expect(CONTRACT).toBe(TRICK_CONTRACT);
    // SAFETY: the bridge's facts, through JSON, are exactly what a program reads on stdin, and the helper
    // reads that text as its Facts; the round trip drops the bridge-side types the helper does not name.
    const facts = JSON.parse(JSON.stringify(factsFor("/nonexistent", "/nonexistent"))) as Facts;
    expect(facts.contract).toBe(TRICK_CONTRACT_DEFAULT);
    expect(new Trick(facts).document().v).toBe(TRICK_CONTRACT_DEFAULT);
  });

  test("a run prints the contract its facts name as v: 1 for a trick that names none, 2 for a contract 2 trick", () => {
    // SAFETY: as above, the bridge's facts through JSON.
    const facts = JSON.parse(JSON.stringify({ ...factsFor("/nonexistent", "/nonexistent"), contract: 2 })) as Facts;
    const doc = new Trick(facts).document();
    expect(doc.v).toBe(2);
    expect(parseTrickDocumentText(JSON.stringify(doc)).refusals).toEqual([]);
  });

  test("every builder's node parses with the real parser, inside the container that holds it", () => {
    const inline = [v.run("plain "), v.run("bold", { style: "bold" }), v.run("now", { at: 1794130692000, clock: "ago" }), v.link("docs", "https://colliepwa.dev")];
    const view: Node[] = [
      v.card(
        [
          v.para("A paragraph.", { role: "heading" }),
          v.line(inline),
          v.chip("ok", { tone: "ok", icon: "check" }),
          v.chip(undefined, { at: 1794130692000, clock: "elapsed" }),
          v.button({ label: "Rerun", intent: "rerun", confirm: "Sure?" }),
          v.button({ label: "Copy", does: "copy", value: "npm test" }),
          v.meter({ value: 0.5, label: "Half" }),
          v.meter({ role: "progress", value: 3, max: 12 }),
          v.image("media/shot.png", "a shot", 390, 844),
          v.bar([v.chip("one", { state: "done" }), v.chip("two", { state: "working", current: true })], { role: "strip" }),
          v.group([v.row("Row", { end: "+12", badge: 3, tone: "warn", icon: "flag", cut: "mid" }, [v.para("second line"), v.chip("c"), v.button({ label: "Go", intent: "go" })])], { label: "Group", fold: "open", badge: 2 }),
          v.number("23/34", { label: "Legs", tone: "ok", unit: "cases" }),
          v.spacer("divider"),
        ],
        { tone: "accent" },
      ),
      v.list([v.row("in a list", { href: "https://example.com" }), v.group([v.row("nested")], { label: "inner" })]),
      v.list(),
      v.code("const a = 1;\n\nconst b = 2;", { lang: "ts", max: 4 }),
      v.code([v.line([v.run("+ added", { style: "fg-green" })]), v.line("plain")]),
      v.para([v.run("inline "), v.link("pane", "m_abcdefghij:p_1", { rel: "pane" })], { bullet: "-" }),
      v.spacer(),
    ];
    const parsed = parseTrickDocumentText(JSON.stringify({ v: 1, parts: [{ at: "session", id: "main", view }] }), { declared: ALL_PLACES });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.parts).toHaveLength(1);
  });

  test("the display builders make a Decision's view the parser takes", () => {
    const view: Node[] = [
      v.bar([v.chip("unit", { tone: "ok", icon: "check" }), v.chip("e2e", { tone: "danger", icon: "x" })]),
      v.list([v.row("src/app.ts", { end: "+12 \u22123" }, [v.para("the send path")])]),
      v.code("@@ -1,3 +1,4 @@\n+const a = 1;"),
      v.para([v.run("see "), v.link("the log", "https://ci.example.com/run/1")]),
      v.group([v.meter({ value: 3, max: 7, label: "Green" }), v.number("7", { label: "legs" })], { label: "Legs" }),
      v.spacer("divider"),
    ];
    const read = parseDecisionView(parseJson(JSON.stringify(view)));
    expect(read.refusals).toEqual([]);
    expect(read.view).toHaveLength(view.length);
  });

  test("the display kinds of 2026-11-10: each builder's node parses in a Session and in a Decision's view", () => {
    const session: Node[] = [
      v.image("media/shot.png", "a shot", 390, 844, { caption: "the card", fit: "cover", focus: { x: 50, y: 20, zoom: 2 } }),
      v.compare(v.image("media/a.png", "old", 390, 844), v.image("media/b.png", "new", 390, 844)),
      v.table({ columns: ["check", { label: "ms", align: "end" }], rows: [["lint", 812], ["types", { text: "4031", tone: "warn" }]] }),
      v.diff(["@@ -1 +1 @@", "-old", "+new"], { file: "src/app.ts" }),
      v.spark([4.2, 3.9, 4.8, 3.1], { label: "CI minutes", tone: "ok" }),
      v.card([v.table({ columns: ["a"], rows: [["one"]] }), v.spark([1, 2]), v.diff("+x"), v.compare(v.image("media/a.png", "a", 4, 3), v.image("media/b.png", "b", 4, 3))]),
    ];
    const parsed = parseTrickDocumentText(JSON.stringify({ v: 1, parts: [{ at: "session", id: "main", view: session }] }), { declared: ALL_PLACES });
    expect(parsed.refusals).toEqual([]);

    const view: Node[] = [
      v.image(0, { caption: "The card after the change", focus: { x: 50, y: 30 } }),
      v.compare(0, { ref: 1, label: "1.28", focus: { x: 50, y: 10, zoom: 1.5 } }),
      v.beforeAfter(0, 1, { before: "1.27", fit: "cover", focus: { x: 50, y: 0 } }),
      v.stat("34/34", "cases", { trend: [30, 32, 34], tone: "ok" }),
      v.stat(7, "minutes"),
      v.checks([{ label: "lint", ok: true }, { label: "e2e", ok: false, note: "two cases red on WebKit" }]),
      v.checks([{ label: "types", ok: true }], { label: "Checks" }),
      v.group([v.table({ columns: ["file", "lines"], rows: [["src/app.ts", "+12 -3"]] }), v.diff("@@ -1 +1 @@\n-a\n+b")], { label: "Changes" }),
      v.spark([1, -2.5, 0.000001], { label: "drift" }),
    ];
    const read = parseDecisionView(parseJson(JSON.stringify(view)), "/view", { images: 2 });
    expect(read.refusals).toEqual([]);
    expect(read.view).toHaveLength(view.length);
    // A ref past the Decision's pictures is refused, at write.
    expect(parseDecisionView(parseJson(JSON.stringify([v.image(2)])), "/view", { images: 2 }).refusals.map((r) => r.path)).toEqual(["/view/0/attrs/ref"]);
  });

  test("the new builders write the schema's words: focus and values as text, a table flat as heads then cells", () => {
    expect(v.image(1, { focus: { x: 50, y: 20 } })).toEqual({ kind: "image", attrs: { ref: "1", focus: "50 20" } });
    expect(v.image(0, { focus: { x: 12.5, y: 0, zoom: 2 } }).attrs?.focus).toBe("12.5 0 2");
    expect(v.spark([1, 0.1 + 0.2, -0]).attrs?.values).toBe("1 0.3 0");
    expect(v.table({ columns: ["a", "b"], rows: [["x", 1]] }).kids?.map((k) => `${k.kind}:${k.text ?? ""}`)).toEqual(["col:a", "col:b", "cell:x", "cell:1"]);
    expect(v.compare(0, 1).kids?.map((k) => k.attrs?.ref)).toEqual(["0", "1"]);
    expect(v.checks([{ label: "lint", ok: true }]).kids?.[0]).toEqual({ kind: "row", text: "lint", attrs: { icon: "check", tone: "ok" } });
    expect(v.checks([{ label: "lint", ok: true }], { label: "Checks" })).toMatchObject({ kind: "group", attrs: { label: "Checks" }, kids: [{ kind: "row" }] });
    expect(v.stat(7, "min")).toEqual({ kind: "number", text: "7", attrs: { label: "min" } });
  });

  helperTest("the sample program prints a document the parser takes whole, and it is about 25 lines", async () => {
    const { dir, state } = await trickFolder(sampleProgram("kit"), ["status", "dashboard", "session"]);
    await writeFile(join(dir, "config.toml"), sampleConfig("kit"));
    await writeFile(join(dir, "trick.toml"), sampleManifest("kit"));
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    const parsed = parseTrickDocumentText(ran.stdout, { declared: ["status", "dashboard", "session"] });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.parts.map((p) => p.part.at)).toEqual(["status", "dashboard", "session"]);
    expect(parsed.decisions).toEqual([]);
  });
});

describe("run, the places and the Decisions", () => {
  helperTest("every place method prints a part the parser takes; decisions default to [] and keepDecisions leaves the key out", async () => {
    const program = `import { run, v } from "./trick.ts";
run((t) => {
  t.status({ text: "3 red", icon: "flask", tone: "danger" });
  t.belt({ label: "23/34", icon: "flask", badge: 3, intent: "rerun" });
  t.dashboard({ label: "Legs", badge: 3, tone: "ok" });
  t.tabbar({ label: "Legs", icon: "flask", badge: "new" });
  t.session({ name: "Legs", subtitle: "23 of 34", badge: { count: 3 }, progress: { value: 2, max: 4 }, actions: [{ id: "rerun", label: "Rerun", intent: "rerun", icon: "refresh" }], view: [v.para("hi")] });
  t.fresh("90s");
  t.asOf(1794130692000);
  if (t.facts.trigger.kind === "tap") t.keepDecisions();
});
`;
    const { dir, state } = await trickFolder(program);
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    const doc = JSON.parse(ran.stdout);
    expect(doc.decisions).toEqual([]);
    expect(doc.fresh).toBe("90s");
    expect(doc.asOf).toBe("2026-11-08T09:38:12.000Z");
    const parsed = parseTrickDocumentText(ran.stdout, { declared: ALL_PLACES });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.parts.map((p) => p.part.id)).toEqual(["status", "belt", "dashboard", "tabbar", "main"]);
    const tapped = await runProgram(dir, factsFor(dir, state, { kind: "tap", rid: "0b9e8d7c-1111-4222-8333-444455556666", node: "belt", intent: "rerun" }));
    expect(JSON.parse(tapped.stdout)).not.toHaveProperty("decisions");
  });

  helperTest("decide adds a Decision the parser takes; a tap from any place reads as the one t.tap", async () => {
    const program = `import { run } from "./trick.ts";
run((t) => {
  t.decide({ key: "case-24", title: "Rerun case 24?", summary: "It failed twice.", options: [{ intent: "rerun", label: "Rerun" }, { intent: "skip", label: "Skip", confirm: "Skip it" }], recommends: { intent: "rerun", why: "It passed yesterday." }, priority: "now" });
  const tap = t.tap;
  t.status({ text: tap === null ? "none" : tap.decision === null ? "tap:" + tap.intent : tap.decision + ":" + tap.intent + ":" + tap.text });
  t.state.set("tap", tap);
});
`;
    const { dir, state } = await trickFolder(program);
    const plain = await runProgram(dir, factsFor(dir, state));
    const parsed = parseTrickDocumentText(plain.stdout, { declared: ALL_PLACES });
    expect(parsed.refusals).toEqual([]);
    expect(parsed.decisions.map((d) => d.key)).toEqual(["case-24"]);
    expect(JSON.parse(plain.stdout).parts[0].chip.text).toBe("none");
    const answer = await runProgram(dir, factsFor(dir, state, { kind: "tap", rid: "0b9e8d7c-1111-4222-8333-444455556666", node: "hill/case-24", intent: "rerun", value: { text: "go" }, seen: "944a71314b332828" }));
    expect(JSON.parse(answer.stdout).parts[0].chip.text).toBe("case-24:rerun:go");
    const answerTap: unknown = JSON.parse(await readFile(join(state, "tap.json"), "utf8"));
    expect(answerTap).toEqual({ rid: "0b9e8d7c-1111-4222-8333-444455556666", node: "hill/case-24", intent: "rerun", value: null, decision: "case-24", text: "go", from: null, seen: "944a71314b332828" });
    const tap = await runProgram(dir, factsFor(dir, state, { kind: "tap", rid: "0b9e8d7c-1111-4222-8333-444455556667", node: "main", intent: "rerun", value: "fast", from: { session: "lodge:w6X:3" } }));
    expect(JSON.parse(tap.stdout).parts[0].chip.text).toBe("tap:rerun");
    const partTap: unknown = JSON.parse(await readFile(join(state, "tap.json"), "utf8"));
    expect(partTap).toEqual({ rid: "0b9e8d7c-1111-4222-8333-444455556667", node: "main", intent: "rerun", value: "fast", decision: null, text: null, from: "lodge:w6X:3", seen: null });
  });

  helperTest("a thrown error: one warn card in the session and exit 0 when the trick has a session; exit 1 without one", async () => {
    const boom = `import { run } from "./trick.ts";\nrun(() => { throw new Error("the gh call failed"); });\n`;
    const withSession = await trickFolder(boom, ["session"]);
    const ran = await runProgram(withSession.dir, factsFor(withSession.dir, withSession.state));
    expect(ran.code).toBe(0);
    const parsed = parseTrickDocumentText(ran.stdout, { declared: ["session"] });
    expect(parsed.refusals).toEqual([]);
    expect(JSON.stringify(parsed.parts[0]?.part)).toContain("the gh call failed");
    expect(JSON.parse(ran.stdout)).not.toHaveProperty("decisions");
    expect(ran.stderr.trimEnd().split("\n").at(-1)).toBe("error: the gh call failed");
    const without = await trickFolder(boom, ["belt"]);
    const failed = await runProgram(without.dir, factsFor(without.dir, without.state));
    expect(failed.code).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr.trimEnd().split("\n").at(-1)).toBe("error: the gh call failed");
  });

  helperTest("the error card goes to the session id the run named", async () => {
    const program = `import { run, v } from "./trick.ts";\nrun((t) => { t.session({ id: "legs", view: [v.para("x")] }); throw new Error("late"); });\n`;
    const { dir, state } = await trickFolder(program, ["belt"]);
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout).parts[0].id).toBe("legs");
  });

  helperTest("config.toml is t.config; a broken one is the run's error", async () => {
    const program = `import { run } from "./trick.ts";\nrun((t) => { t.status({ text: String(t.config.repo ?? "none") }); });\n`;
    const { dir, state } = await trickFolder(program, ["status"]);
    expect(JSON.parse((await runProgram(dir, factsFor(dir, state))).stdout).parts[0].chip.text).toBe("none");
    await writeFile(join(dir, "config.toml"), 'repo = "collie"\n');
    expect(JSON.parse((await runProgram(dir, factsFor(dir, state))).stdout).parts[0].chip.text).toBe("collie");
    await writeFile(join(dir, "config.toml"), "repo = \n");
    expect((await runProgram(dir, factsFor(dir, state))).code).toBe(1);
  });
});

describe("state, sh and the sessions", () => {
  helperTest("t.state keeps JSON files in the state folder, written whole; a bad name is the run's error", async () => {
    const program = `import { run } from "./trick.ts";
run((t) => {
  const n = t.state.get("count", 0) + 1;
  t.state.set("count", n);
  t.status({ text: String(n) });
});
`;
    const { dir, state } = await trickFolder(program, ["status"]);
    for (const want of ["1", "2"]) expect(JSON.parse((await runProgram(dir, factsFor(dir, state))).stdout).parts[0].chip.text).toBe(want);
    expect(await readdir(state)).toEqual(["count.json"]);
    expect(await readFile(join(state, "count.json"), "utf8")).toBe("2\n");
    const bad = await trickFolder(`import { run } from "./trick.ts";\nrun((t) => { t.state.set("../up", 1); });\n`, ["status"]);
    const ran = await runProgram(bad.dir, factsFor(bad.dir, bad.state));
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain('state name "../up" is not plain names joined by "/"');
  });

  // POSIX tools: echo, head, sleep and env are programs on POSIX and not on a Windows PATH, and /dev/zero is POSIX.
  test.skipIf(process.platform === "win32")("t.sh runs without a shell, never throws, caps its output, stops on time, and hides BUN_BE_BUN from the child", async () => {
    const program = `import { run } from "./trick.ts";
run(async (t) => {
  const echo = await t.sh("echo", ["$HOME", "a b"]);
  const missing = await t.sh("collie-no-such-tool-here");
  const big = await t.sh("head", ["-c", "400000", "/dev/zero"]);
  const slow = await t.sh("sleep", ["5"], { timeoutMs: 100 });
  const env = await t.sh("env");
  t.status({ text: "ok" });
  t.session({ view: [], subtitle: JSON.stringify([echo.stdout, echo.ok, missing.ok, missing.code, big.stdout.length, slow.ok, env.stdout.includes("BUN_BE_BUN")]) } as never);
});
`;
    const { dir, state } = await trickFolder(program, ["status", "session"]);
    const started = performance.now();
    const ran = await runProgram(dir, factsFor(dir, state), { BUN_BE_BUN: "1" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(ran.code).toBe(0);
    const subtitle = JSON.parse(ran.stdout).parts[1].subtitle;
    expect(JSON.parse(subtitle)).toEqual(["$HOME a b\n", true, false, -1, 256 * 1024, false, false]);
  });

  helperTest("sessionAt compares real paths; sessionNamed finds by name", async () => {
    const root = await tempDir();
    const real = join(root, "repo");
    await mkdir(real);
    // A junction on Windows, which needs no privilege; the type is ignored elsewhere.
    await symlink(real, join(root, "link"), "junction");
    const program = `import { run } from "./trick.ts";
run((t) => {
  const at = t.sessionAt(${JSON.stringify(join(root, "link"))});
  const named = t.sessionNamed("api");
  t.status({ text: (at?.paneId ?? "none").slice(0, 12) });
  t.belt({ label: named === null ? "none" : "found" });
});
`;
    const { dir, state } = await trickFolder(program, ["status", "belt"]);
    const facts = factsFor(dir, state);
    const first = facts.sessions[0];
    if (first === undefined) throw new Error("the fixture facts hold no session");
    facts.sessions = [{ ...first, cwd: real, name: "api" }];
    const doc = JSON.parse((await runProgram(dir, facts)).stdout);
    expect(doc.parts[0].chip.text).toBe(first.paneId.slice(0, 12));
    expect(doc.parts[1].mark.label).toBe("found");
  });
});

/** A Trick made in this process, on a temp trick folder (with `config` as its config.toml) and its own state folder. */
async function trickHere(opts: { config?: string; places?: readonly string[]; trigger?: TrickFacts["trigger"] } = {}): Promise<{ t: Trick; dir: string; state: string }> {
  const { dir, state } = await trickFolder("", opts.places);
  if (opts.config !== undefined) await writeFile(join(dir, "config.toml"), opts.config);
  // SAFETY: the schema's facts and the helper's `Facts` are the same document; the round trip drops the readonly marks.
  const facts = JSON.parse(JSON.stringify(factsFor(dir, state, opts.trigger))) as Facts;
  return { t: new Trick(facts), dir, state };
}

/** A copy of the helper loaded now, apart from the one this file imports: it reads the environment as it is at this call. */
async function freshHelper(): Promise<typeof import("./trick.ts")> {
  const specifier = `./trick.ts?fresh=${Date.now()}`;
  // SAFETY: the same file as the static import above; the query only makes Bun load it again.
  return (await import(specifier)) as typeof import("./trick.ts");
}

/** Run `body` with these environment variables set, then put the old values back. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T> | T): Promise<T> {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  const put = (from: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(from)) {
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
    }
  };
  put(vars);
  try {
    return await body();
  } finally {
    put(old);
  }
}

const NOW_S = 1794225600;

describe("helper v2: time and words", () => {
  test("now() reads TRICK_NOW (epoch seconds); iso, minute and age speak it", async () => {
    await withEnv({ TRICK_NOW: String(NOW_S) }, () => {
      expect(now()).toBe(NOW_S * 1000);
      expect(iso()).toBe("2026-11-09T12:00:00Z");
      expect(minute(now())).toBe("2026-11-09 12:00 UTC");
    });
    await withEnv({ TRICK_NOW: undefined }, () => expect(Math.abs(now() - Date.now())).toBeLessThan(1000));
    expect([age(30_000), age(12 * 60_000), age(5 * 3_600_000), age(3 * 86_400_000)]).toEqual(["just now", "12 min", "5 h", "3 d"]);
  });

  test("clip masks before it cuts, folds to one line; mask hides keys and the home folder; firstSentence", async () => {
    const key = "sk-or-v1-0000000000fakefakefake0000000000";
    expect(clip(`a\n\tb ${key}`, 200)).toBe("a b sk-o****");
    expect(clip("x".repeat(50), 10)).toBe("xxxxxxx...");
    // The helper reads HOME once, when it loads; the bridge always hands a trick its HOME. The test
    // process may have none (the GitHub Windows runner sets USERPROFILE only), so the mask is read from
    // a fresh copy of the helper, loaded with a HOME this test picks.
    const home = await tempDir();
    const fresh = await withEnv({ HOME: home }, () => freshHelper());
    expect(fresh.mask(`${home}/secret and ${home}`)).toBe("~/secret and ~");
    expect(firstSentence("One here. Two there.")).toBe("One here.");
    expect(firstSentence("no stop at all")).toBe("no stop at all");
    expect(mapText({ a: ["x", 1, { b: "y" }], c: null }, (s) => s.toUpperCase())).toEqual({ a: ["X", 1, { b: "Y" }], c: null });
  });
});

describe("helper v2: the state folder", () => {
  test("t.log appends JSON lines, skips a torn line, once writes one entry per rid, last reads the newest", async () => {
    const { t, state } = await trickHere();
    const log = t.log<{ rid?: string; n: number }>("records/given");
    expect(log.all()).toEqual([]);
    expect(log.once("r-1", { n: 1 })).toBe(true);
    expect(log.once("r-1", { n: 2 })).toBe(false);
    expect(log.once("", { n: 3 })).toBe(false);
    log.append({ n: 4 });
    await writeFile(join(state, "records/given.jsonl"), `${await readFile(join(state, "records/given.jsonl"), "utf8")}{"torn":\n`);
    log.append({ rid: "r-5", n: 5 });
    expect(log.all()).toEqual([{ n: 1, rid: "r-1" }, { n: 4 }, { rid: "r-5", n: 5 }]);
    expect(log.has("r-5")).toBe(true);
    expect(log.has("r-2")).toBe(false);
    expect(log.last(2).map((e) => e.n)).toEqual([4, 5]);
    expect(log.last(0)).toEqual([]);
  });

  test("t.cached serves a fresh value, reads again past its age, and serves the old value as stale when the read fails", async () => {
    const { t } = await trickHere();
    let reads = 0;
    const ok = () => {
      reads += 1;
      return { n: reads };
    };
    const fails = (): { n: number } => {
      throw new Error("gh read failed");
    };
    await withEnv({ TRICK_NOW: String(NOW_S) }, async () => {
      expect(await t.cached("cache-ci", 60_000, fails)).toEqual({ value: null, at: NOW_S * 1000, stale: false, error: "gh read failed" });
      expect(await t.cached("cache-ci", 60_000, ok)).toEqual({ value: { n: 1 }, at: NOW_S * 1000, stale: false, error: null });
      expect((await t.cached("cache-ci", 60_000, ok)).value).toEqual({ n: 1 });
    });
    expect(reads).toBe(1);
    await withEnv({ TRICK_NOW: String(NOW_S + 61) }, async () => {
      expect(await t.cached("cache-ci", 60_000, fails)).toEqual({ value: { n: 1 }, at: NOW_S * 1000, stale: true, error: "gh read failed" });
      expect((await t.cached("cache-ci", Infinity, ok)).value).toEqual({ n: 1 });
      expect((await t.cached("cache-ci", 60_000, ok)).value).toEqual({ n: 2 });
    });
  });

  test("t.closedUntil closes a key until a time; t.isClosed says until when", async () => {
    const { t } = await trickHere();
    await withEnv({ TRICK_NOW: String(NOW_S) }, () => {
      t.closedUntil("reply-7", NOW_S * 1000 + 86_400_000);
      expect(t.isClosed("reply-7")).toBe(NOW_S * 1000 + 86_400_000);
      expect(t.isClosed("reply-8")).toBeNull();
    });
    await withEnv({ TRICK_NOW: String(NOW_S + 86_401) }, () => expect(t.isClosed("reply-7")).toBeNull());
  });

  test("t.state takes names with folders; a dot first, a .. and an empty segment are refused", async () => {
    const { t, state } = await trickHere();
    t.state.set("cache/ci", { a: 1 });
    expect(t.state.get<{ a: number } | null>("cache/ci", null)).toEqual({ a: 1 });
    expect(await readFile(join(state, "cache/ci.json"), "utf8")).toBe('{"a":1}\n');
    for (const bad of ["../up", "a/../b", ".hidden", "a//b", "/abs"]) expect(() => t.state.set(bad, 1)).toThrow("is not plain names");
  });
});

describe("helper v2: tools, show and onPrint", () => {
  // POSIX tool folders: `sh` on /usr/bin:/bin, and a `#!/bin/sh` tool found by its executable bit, which Windows has neither of.
  test.skipIf(process.platform === "win32")("t.tool finds a program on PATH, else in the extra and user folders, PATH only under TRICK_TOOLS_ONLY_PATH=1", async () => {
    const { t } = await trickHere();
    const bin = await tempDir();
    await writeFile(join(bin, "fake-tool-kit"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
    await writeFile(join(bin, "not-runnable-kit"), "x", { mode: 0o644 });
    await withEnv({ PATH: "/usr/bin:/bin", TRICK_TOOLS_ONLY_PATH: undefined }, async () => {
      expect(t.tool("sh")).toMatch(/\/sh$/);
      expect(t.tool("fake-tool-kit")).toBeNull();
      expect(t.tool("fake-tool-kit", [bin])).toBe(join(bin, "fake-tool-kit"));
      expect(t.tool("not-runnable-kit", [bin])).toBeNull();
      expect((await t.sh(t.tool("fake-tool-kit", [bin]))).stdout).toBe("hi\n");
      expect(await t.sh(t.tool("no-such-tool-kit"))).toEqual({ ok: false, code: -1, stdout: "", stderr: "the program was not found" });
    });
    await withEnv({ PATH: "/usr/bin:/bin", TRICK_TOOLS_ONLY_PATH: "1" }, () => expect(t.tool("fake-tool-kit", [bin])).toBeNull());
  });

  test("t.path makes a config path absolute: ~/ is home, a relative path is the trick folder's", async () => {
    const { t, dir } = await trickHere();
    // A HOME of the test's own: the test process may have none (the GitHub Windows runner), a trick always has one.
    const home = await tempDir();
    const paths = await withEnv({ HOME: home }, () => [t.path("/abs/x"), t.path("~/notes"), t.path("~"), t.path("drafts"), t.path("")]);
    expect(paths).toEqual(["/abs/x", join(home, "notes"), home, join(dir, "drafts"), ""]);
  });

  test("t.show reads show from config.toml within the declared places; an unknown word is one warn row at the end of the session", async () => {
    const fallback = await trickHere();
    expect([...fallback.t.show(["dashboard"])]).toEqual(["dashboard"]);
    const { t } = await trickHere({ config: 'show = ["status", "sparkle", "dashboard", "tab"]\n', places: ["dashboard", "status", "session"] });
    const shown = t.show(["dashboard"]);
    expect([...shown].toSorted()).toEqual(["dashboard", "status"]);
    t.configWarn("mark is gone");
    t.put(shown, { label: "Look", icon: "eye", badge: 0, word: null, tone: "accent" });
    t.session({ view: [v.para("body")] });
    const doc = t.document();
    expect(doc.parts.map((p) => p.at)).toEqual(["dashboard", "session"]);
    expect(JSON.stringify(doc.parts[0])).not.toContain("badge");
    const parsed = parseTrickDocumentText(JSON.stringify(doc), { declared: ["dashboard", "status", "session"] });
    expect(parsed.refusals).toEqual([]);
    const last = JSON.stringify(doc.parts[1]);
    expect(last).toContain('show names \\"sparkle\\", \\"tab\\", which this trick ignores: use dashboard, status. mark is gone.');
    expect(last.indexOf("body")).toBeLessThan(last.indexOf("config.toml"));
    const counted = await trickHere({ places: ["dashboard", "tabbar", "status", "belt", "session"] });
    counted.t.put(new Set(["dashboard", "tabbar", "status", "belt"]), { label: "Tag", icon: "tag", badge: "5/7", word: "tag 5/7", tone: "danger", itemTone: "warn" });
    expect(counted.t.document().parts).toEqual([
      { at: "dashboard", id: "dashboard", item: { label: "Tag", icon: "tag", tone: "warn", badge: "5/7" } },
      { at: "tabbar", id: "tabbar", item: { label: "Tag", icon: "tag", tone: "warn", badge: "5/7" } },
      { at: "status", id: "status", chip: { text: "tag 5/7", icon: "tag", tone: "danger" } },
      { at: "belt", id: "belt", mark: { label: "tag 5/7", icon: "tag", tone: "danger" } },
    ]);
  });

  helperTest("t.onPrint changes the whole document before it prints, the error card too", async () => {
    const key = "sk-or-v1-0000000000fakefakefake0000000000";
    const program = `import { mapText, mask, run, v } from "./trick.ts";
run((t) => {
  t.onPrint((doc) => mapText(doc, mask));
  t.onPrint((doc) => ({ ...doc, fresh: "5m" }));
  t.session({ subtitle: "in " + process.env.HOME + "/repo", view: [v.para("the key ${key}")] });
  t.decide({ key: "k", title: "a " + process.env.HOME, summary: "s" });
  if (t.config.boom === true) throw new Error("failed in " + process.env.HOME + "/x with ${key}");
});
`;
    const { dir, state } = await trickFolder(program, ["session"]);
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    expect(ran.stdout).not.toContain(key);
    expect(ran.stdout).not.toContain(process.env.HOME ?? "/nowhere");
    const doc = JSON.parse(ran.stdout);
    expect([doc.parts[0].subtitle, doc.decisions[0].title, doc.fresh]).toEqual(["in ~/repo", "a ~", "5m"]);
    await writeFile(join(dir, "config.toml"), "boom = true\n");
    const failed = await runProgram(dir, factsFor(dir, state));
    expect(failed.code).toBe(0);
    expect(failed.stdout).toContain("failed in ~/x with sk-o****");
    expect(failed.stderr).not.toContain(key);
  });
});

describe("helper v4: a session's inputs", () => {
  test("t.inputs reads text and pictures from inputs/, and leaves out a path outside it, a missing copy and a changed one", async () => {
    const { t, dir } = await trickHere();
    await mkdir(join(dir, "inputs", "m", "p"), { recursive: true });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    await writeFile(join(dir, "inputs", "m", "p", "TODO.md"), "- ship it\n");
    await writeFile(join(dir, "inputs", "m", "p", "shot.png"), png);
    await writeFile(join(dir, "inputs", "m", "p", "changed.md"), "now\n");
    await writeFile(join(dir, "secret.txt"), "not an input\n");
    const sha = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const file = (rel: string, kind: "text" | "image", hash: string, path = `inputs/m/p/${rel}`) => ({ rel, path, bytes: 1, sha256: hash, mtime: "2026-11-10T00:00:00Z", kind });
    const first = t.facts.sessions[0];
    if (first === undefined) throw new Error("the fixture facts hold no session");
    const session = {
      ...first,
      inputs: {
        state: "ok" as const,
        files: [
          file("TODO.md", "text", sha("- ship it\n")),
          file("shot.png", "image", sha(png)),
          file("changed.md", "text", sha("before\n")),
          file("gone.md", "text", sha("x")),
          file("secret.txt", "text", sha("not an input\n"), "secret.txt"),
          file("up.txt", "text", sha("not an input\n"), "inputs/../secret.txt"),
        ],
      },
    };
    const read = t.inputs(session);
    expect(read.map((f) => f.rel)).toEqual(["TODO.md", "shot.png"]);
    expect(read[0]?.text).toBe("- ship it\n");
    expect(read[0]?.data).toBeNull();
    expect(read[1]?.text).toBeNull();
    expect([...(read[1]?.data ?? [])]).toEqual([...png]);
    expect(t.inputs(first)).toEqual([]);
  });
});
