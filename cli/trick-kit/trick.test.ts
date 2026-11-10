import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FACTS } from "../../web/src/lib/tricks/fixtures/index.ts";
import { parseJson } from "../../web/src/lib/json.ts";
import { PLACE_KINDS, parseDecisionView, parseFacts, parseTrickDocumentText, type TrickFacts } from "../../web/src/lib/tricks/schema.ts";
import { sampleConfig, sampleManifest, sampleProgram, TRICK_HELPER } from "../trick.ts";
import { v, type Node } from "./trick.ts";

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

  test("the sample program prints a document the parser takes whole, and it is about 25 lines", async () => {
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
  test("every place method prints a part the parser takes; decisions default to [] and keepDecisions leaves the key out", async () => {
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

  test("decide adds a Decision the parser takes; a hill tap reads as hillAnswer, another tap as tap", async () => {
    const program = `import { run } from "./trick.ts";
run((t) => {
  t.decide({ key: "case-24", title: "Rerun case 24?", summary: "It failed twice.", options: [{ intent: "rerun", label: "Rerun" }, { intent: "skip", label: "Skip", confirm: "Skip it" }], recommends: { intent: "rerun", why: "It passed yesterday." }, priority: "now" });
  t.status({ text: t.hillAnswer === null ? (t.tap === null ? "none" : "tap:" + t.tap.intent) : t.hillAnswer.key + ":" + t.hillAnswer.intent + ":" + t.hillAnswer.text });
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
    const tap = await runProgram(dir, factsFor(dir, state, { kind: "tap", rid: "0b9e8d7c-1111-4222-8333-444455556667", node: "belt", intent: "rerun" }));
    expect(JSON.parse(tap.stdout).parts[0].chip.text).toBe("tap:rerun");
  });

  test("a thrown error: one warn card in the session and exit 0 when the trick has a session; exit 1 without one", async () => {
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

  test("the error card goes to the session id the run named", async () => {
    const program = `import { run, v } from "./trick.ts";\nrun((t) => { t.session({ id: "legs", view: [v.para("x")] }); throw new Error("late"); });\n`;
    const { dir, state } = await trickFolder(program, ["belt"]);
    const ran = await runProgram(dir, factsFor(dir, state));
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout).parts[0].id).toBe("legs");
  });

  test("config.toml is t.config; a broken one is the run's error", async () => {
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
  test("t.state keeps JSON files in the state folder, written whole; a bad name is the run's error", async () => {
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
    expect(ran.stderr).toContain('state name "../up" is not a plain file name');
  });

  test("t.sh runs without a shell, never throws, caps its output, stops on time, and hides BUN_BE_BUN from the child", async () => {
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

  test("sessionAt compares real paths; sessionNamed finds by name", async () => {
    const root = await tempDir();
    const real = join(root, "repo");
    await mkdir(real);
    await symlink(real, join(root, "link"));
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
