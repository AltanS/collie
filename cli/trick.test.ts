import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { trickCodeHash } from "../bridge/tricks/code-hash.ts";
import { OFFICIAL_REPOS, shippedOfficialList } from "../bridge/tricks/official.ts";
import { ORIGIN_FILE, renderOrigin } from "../bridge/tricks/origin.ts";
import { approvedCopyDir, switchesPath } from "../bridge/tricks/paths.ts";
import { HILL_WRITING } from "./hill-rules.ts";
import { OFFICIAL_TRICKS_REPO } from "./trick-add.ts";
import { EXIT, type Io } from "./io.ts";
import { tricksFindings } from "./trick-findings.ts";
import { GROUP_CAPACITY_WORDS, GROUP_TOO_LARGE } from "../bridge/tricks/card-group.ts";
import { TAP_SHOWS_NOTHING, agentPaneRefusal, checkStatic, runAgainstFixture, cmdTrick, cmdTrickAuto, cmdTrickCheck, cmdTrickHelper, cmdTrickInit, sampleProgram, cmdTrickList, cmdTrickSkill, cmdTrickSwitch, sampleAgents, SKILL_BYTES_MAX, TRICK_WRITE_BRIEF, TRICK_SUBCOMMANDS, type TrickCheckReport, type TrickDeps } from "./trick.ts";
import { checkWarnings, HELPER_VERSION, helperVersion, isBareImport, isScannedFile, looksBinary, runsLines, shippedHelperVersion, TRICK_HELPER } from "../bridge/tricks/scan.ts";
import { realFiles } from "./sys.ts";
import { leadStore, member } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { inputsSentence, parseTrickDocument, TRICK_CONTRACT, TRICK_CONTRACT_DEFAULT, type TricksReply } from "../web/src/lib/tricks/schema.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-trick-cli-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

interface Captured {
  io: Io;
  out: string[];
  err: string[];
}
function capture(): Captured {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l) => out.push(l), err: (l) => err.push(l) }, out, err };
}

const KEY = "sk-or-v1-your-key-here-placeholder00";

/** Deps over a fresh config and state folder. `answer` is what the bridge's `GET /api/tricks` says. */
function fail(): never {
  throw new Error("the manifest did not parse");
}

async function deps(answer: TricksReply | null = null): Promise<TrickDeps & Captured & { configDir: string; stateDir: string; asked: string[] }> {
  const root = await tempDir();
  const configDir = join(root, "config");
  const stateDir = join(root, "state");
  await mkdir(configDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  const c = capture();
  const asked: string[] = [];
  return {
    ...c,
    configDir,
    stateDir,
    asked,
    ctx: {
      configDir,
      stateDir,
      port: 18_999,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, COLLIE_TOKEN: "tok-must-not-leak", OPENROUTER_API_KEY: KEY },
    },
    files: realFiles,
    fetch: async (url) => {
      asked.push(url);
      if (answer === null) throw new Error("connection refused");
      return new Response(JSON.stringify(answer), { status: 200 });
    },
    now: () => Date.parse("2026-11-08T09:00:00Z"),
  };
}

describe("collie trick init", () => {
  test("AGENTS.md names every place this Collie draws, and its item example parses in both item places", () => {
    const text = sampleAgents("legs");
    for (const place of ["belt", "status", "session", "dashboard", "tabbar"]) expect(text).toContain(`\`${place}\``);
    const example = /`(\{ "label": [^`]+\})`/u.exec(text)?.[1];
    expect(example).toBeDefined();
    for (const at of ["dashboard", "tabbar"]) {
      const parsed = parseTrickDocument({ v: 1, parts: [{ at, id: "i", item: JSON.parse(example ?? "null") }] });
      expect(parsed.refusals).toEqual([]);
    }
  });

  test("AGENTS.md agrees with contract 1: the number, the facts field, one tap shape, the tolerant read, media/", () => {
    for (const form of ["ts", "sh"] as const) {
      const text = sampleAgents("legs", form);
      // init writes contract 1; the guide names the newest contract and what contract 2 adds.
      expect(text, form).toContain(`contract = ${String(TRICK_CONTRACT_DEFAULT)}`);
      expect(text, form).toContain("`contract` (the one `trick.toml` names)");
      expect(text, form).toContain(`{ "v": ${String(TRICK_CONTRACT_DEFAULT)}, "parts"`);
      expect(text, form).toContain(`contracts 1 to ${String(TRICK_CONTRACT)}`);
      expect(text, form).toContain("untrusted data");
      expect(text, form).toContain("t.inputs(session)");
      expect(text, form).toContain("left out");
      expect(text, form).toContain("is ignored");
      expect(text, form).toContain("`media/`");
      expect(text, form).not.toContain("hillAnswer");
      expect(text, form).not.toContain("Unknown keys are refused");
      expect(text, form).not.toMatch(/`v` \(1\)/u);
    }
    expect(sampleAgents("legs")).toContain("`decision` (its key)");
    // How to word a Decision, from the one list `collie hill post --help` prints too.
    for (const form of ["ts", "sh"] as const) for (const line of HILL_WRITING) expect(sampleAgents("legs", form), form).toContain(line);
    // The output example in AGENTS.md parses clean.
    const example = /```json\n(.+)\n```/u.exec(sampleAgents("legs"))?.[1];
    expect(parseTrickDocument(JSON.parse(example ?? "null")).refusals).toEqual([]);
  });

  test("writes a TypeScript trick by default: trick.toml, program.ts, the helper, config.toml and AGENTS.md", async () => {
    const d = await deps();
    expect(await cmdTrickInit(d, ["legs"])).toBe(EXIT.OK);
    const dir = join(d.configDir, "tricks", "legs");
    expect(await readFile(join(dir, "trick.toml"), "utf8")).toContain('run = "program.ts"');
    expect(await readFile(join(dir, "program.ts"), "utf8")).toContain('import { run, v } from "./trick.ts";');
    const helper = await readFile(join(dir, "trick.ts"), "utf8");
    expect(helper).toBe(TRICK_HELPER);
    expect(helperVersion(helper)).toBe(HELPER_VERSION);
    expect(await readFile(join(dir, "config.toml"), "utf8")).toContain("rows = 8");
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("collie trick helper legs");
    expect((await stat(join(d.configDir, "tricks"))).mode & 0o777).toBe(0o700);
    expect(d.out.join("\n")).toContain("The trick is off.");
    expect(await cmdTrickInit(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("exists already");
    expect(await cmdTrickInit(d, ["Bad_Id"])).toBe(EXIT.USAGE);
  });

  test("--sh writes the shell sample: an executable program.sh, no helper", async () => {
    const d = await deps();
    expect(await cmdTrickInit(d, ["--sh", "legs"])).toBe(EXIT.OK);
    const dir = join(d.configDir, "tricks", "legs");
    expect(await readFile(join(dir, "trick.toml"), "utf8")).toContain('places = ["belt"]');
    expect((await stat(join(dir, "program.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("collie trick check --run .");
    expect(await Bun.file(join(dir, "trick.ts")).exists()).toBe(false);
  });

  test("the sample program is short: about 25 lines", () => {
    expect(sampleProgram("legs").trimEnd().split("\n").length).toBeLessThanOrEqual(30);
  });

  test("the folder init writes passes check --run with no refusal, in both forms", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["hello"]);
    const dir = join(d.configDir, "tricks", "hello");
    const before = d.out.length;
    expect(await cmdTrickCheck(d, ["--run", "--json", dir])).toBe(EXIT.OK);
    // SAFETY: `--json` prints exactly one TrickCheckReport, and the fields read below are checked by value.
    const report = JSON.parse(d.out.slice(before).join("\n")) as TrickCheckReport;
    expect(report.refusals).toEqual([]);
    expect(report.problems).toEqual([]);
    expect(report.warnings.filter((w) => w.kind === "import")).toEqual([]);
    expect(report.run?.problem).toBeNull();
    expect(report.run?.refusals).toEqual([]);
    expect(report.run?.parts).toEqual(["status status", "dashboard dashboard", "session main"]);
    const e = await deps();
    await cmdTrickInit(e, ["--sh", "plain"]);
    expect(await cmdTrickCheck(e, ["--run", join(e.configDir, "tricks", "plain")])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("parts: belt belt");
    expect(e.out.at(-1)).toBe("ok: no problems.");
  });
});

describe("collie trick helper", () => {
  test("rewrites an old trick.ts with the current helper and says the new version waits for a yes", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    const dir = join(d.configDir, "tricks", "legs");
    await writeFile(join(dir, "trick.ts"), "// collie trick helper v0\nexport {};\n");
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(await cmdTrickHelper(d, ["legs"])).toBe(EXIT.OK);
    expect(await readFile(join(dir, "trick.ts"), "utf8")).toBe(TRICK_HELPER);
    expect(d.out.join("\n")).toContain("(it was v0)");
    expect(d.out.join("\n")).toContain("legs keeps running the version you approved; the new one waits for your yes: collie trick on legs");
  });

  test("a current helper is left alone; a missing folder fails; no argument is usage", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    expect(await cmdTrickHelper(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.at(-1)).toContain("is the current helper");
    expect(await cmdTrickHelper(d, [join(d.configDir, "tricks", "legs")])).toBe(EXIT.OK);
    expect(await cmdTrickHelper(d, ["nope"])).toBe(EXIT.FAIL);
    expect(await cmdTrickHelper(d, [])).toBe(EXIT.USAGE);
  });
});

describe("collie trick check", () => {
  async function folder(manifest: string, files: Record<string, string> = {}): Promise<string> {
    const root = await tempDir();
    const id = /id = "([^"]+)"/.exec(manifest)?.[1] ?? "x";
    const dir = join(root, id);
    await mkdir(dir);
    await writeFile(join(dir, "trick.toml"), manifest);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), text, { mode: 0o755 });
    }
    return dir;
  }

  test("it says how many cards the trick shows on as a proposal, with the capacity; the helper Collie ships is not counted (crew slice 8)", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["hello"]);
    const dir = join(d.configDir, "tricks", "hello");
    expect(await cmdTrickCheck(d, [dir])).toBe(EXIT.OK);
    // trick.ts (about 42 KB, a group's whole capacity) is Collie's own helper: card 1 names it, and only
    // program.ts, trick.toml and AGENTS.md take cards of code.
    expect(d.out.join("\n")).toMatch(/ {2}cards: {2}This trick shows as [2-8] cards\. /u);
    expect(d.out.join("\n")).toContain(GROUP_CAPACITY_WORDS);
    expect(GROUP_CAPACITY_WORDS).toContain("at most 8 cards");
    expect(d.out.at(-1)).toBe("ok: no problems.");
    const small = await folder('id = "tiny"\nname = "tiny"\nrun = "./tiny.sh"\nplaces = ["belt"]\n', { "tiny.sh": "#!/bin/sh\necho '{}'\n" });
    const e = await deps();
    expect(await cmdTrickCheck(e, [small])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("  cards:  This trick shows as 1 card.");
  });

  test("a trick larger than a group passes the check, with an error that it cannot be proposed", async () => {
    const big = Array.from({ length: 900 }, (_, i) => `echo "line ${String(i).padStart(4, "0")} of a long program, longer than a group of cards holds"`).join("\n");
    const dir = await folder('id = "huge"\nname = "huge"\nrun = "./huge.sh"\nplaces = ["belt"]\n', { "huge.sh": `#!/bin/sh\n${big}\n` });
    const d = await deps();
    expect(await cmdTrickCheck(d, [dir])).toBe(EXIT.OK);
    expect(d.err).toContain(`error: propose: ${GROUP_TOO_LARGE}`);
    expect(d.out.at(-1)).toBe("ok: it runs on this machine, but it cannot be proposed.");
  });

  test("--run notes a tile a tap leaves as it was; a tap that changes it, or a session page, gets no note", async () => {
    const still = await folder('id = "still"\nname = "S"\nrun = "./p.sh"\nplaces = ["belt"]\n', { "p.sh": `#!/bin/sh\necho '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"label":"3","intent":"refresh"}}]}'\n` });
    const d = await deps();
    expect(await cmdTrickCheck(d, ["--run", still])).toBe(EXIT.OK);
    expect(d.out).toContain(`  note: ${TAP_SHOWS_NOTHING}`);
    expect(d.out.at(-1)).toBe("ok: no problems.");
    // Without --run there is no output to judge: no note.
    const quiet = await deps();
    expect(await cmdTrickCheck(quiet, [still])).toBe(EXIT.OK);
    expect(quiet.out.join("\n")).not.toContain(TAP_SHOWS_NOTHING);
    const tapped = await folder('id = "tapped"\nname = "T"\nrun = "./p.sh"\nplaces = ["belt"]\n', {
      "p.sh": `#!/bin/sh\nread -r facts\ncase "$facts" in *'"kind":"tap"'*) n=4;; *) n=3;; esac\nprintf '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"label":"%s","intent":"refresh"}}]}\\n' "$n"\n`,
    });
    const e = await deps();
    expect(await cmdTrickCheck(e, ["--run", tapped])).toBe(EXIT.OK);
    expect(e.out.join("\n")).not.toContain(TAP_SHOWS_NOTHING);
    const paged = await folder('id = "paged"\nname = "P"\nrun = "./p.sh"\nplaces = ["belt", "session"]\n', { "p.sh": `#!/bin/sh\necho '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"label":"3"}}]}'\n` });
    const f = await deps();
    expect(await cmdTrickCheck(f, ["--run", paged])).toBe(EXIT.OK);
    expect(f.out.join("\n")).not.toContain(TAP_SHOWS_NOTHING);
  });

  test("the checked-in fixture is clean", async () => {
    const d = await deps();
    expect(await cmdTrickCheck(d, [join(import.meta.dir, "..", "bridge", "tricks", "fixtures", "hello")])).toBe(EXIT.OK);
  });

  test("usage is 2: no folder, or not a folder", async () => {
    const d = await deps();
    expect(await cmdTrickCheck(d, [])).toBe(EXIT.USAGE);
    expect(await cmdTrickCheck(d, ["/nonexistent/collie-trick"])).toBe(EXIT.USAGE);
  });

  test("a refused manifest is 1 with each refusal printed; a later field alone is 0 with a note", async () => {
    const d = await deps();
    const bad = await folder('id = "bad"\nname = "Bad"\nrun = "./p.sh"\nplaces = ["nowhere"]\ncolour = "red"\n', { "p.sh": "#!/bin/sh\n" });
    expect(await cmdTrickCheck(d, [bad])).toBe(EXIT.FAIL);
    // An unknown place word is left out with a note; with no place left, the manifest is refused.
    expect(d.out.join("\n")).toContain("note: trick.toml /places/0");
    expect(d.err.join("\n")).toContain("trick.toml /places: The trick lists no place");
    // The manifest stays strict: an unknown key is a typo, and it refuses.
    expect(d.err.join("\n")).toContain("/colour");
    const later = await folder('id = "later"\nname = "Later"\nrun = "./p.sh"\nwatch = ["~/x.log"]\nplaces = ["belt"]\n', { "p.sh": "#!/bin/sh\necho '{}'\n" });
    const e = await deps();
    expect(await cmdTrickCheck(e, [later])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("note: trick.toml /watch");
  });

  test("a manifest with no about gets one soft note; with an about it gets none; a long one is an error", async () => {
    const d = await deps();
    const without = await folder('id = "a"\nname = "A"\nrun = "./p.sh"\nplaces = ["belt"]\n', { "p.sh": "#!/bin/sh\n" });
    expect(await cmdTrickCheck(d, [without])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain("note: Add an `about` text so a person can read what this trick does before they switch it on.");
    expect(d.out.at(-1)).toBe("ok: no problems.");
    const e = await deps();
    const withAbout = await folder('id = "b"\nname = "B"\nrun = "./p.sh"\nplaces = ["belt"]\ndescription = "One line."\nabout = "Two\\n\\nparagraphs."\n', { "p.sh": "#!/bin/sh\n" });
    expect(await cmdTrickCheck(e, [withAbout])).toBe(EXIT.OK);
    expect(e.out.join("\n")).not.toContain("`about`");
    const f = await deps();
    const long = await folder(`id = "c"\nname = "C"\nrun = "./p.sh"\nplaces = ["belt"]\nabout = "${"a".repeat(1201)}"\n`, { "p.sh": "#!/bin/sh\n" });
    expect(await cmdTrickCheck(f, [long])).toBe(EXIT.FAIL);
    expect(f.err.join("\n")).toContain('trick.toml /about: "about" is 1201 characters. At most 1200.');
  });

  test("runs: lists the command lines of the program; a missing or binary program is refused", async () => {
    const dir = await folder('id = "gh"\nname = "GH"\nrun = "./gh.sh"\nplaces = ["belt"]\n', {
      "gh.sh": "#!/bin/sh\n# lists my PRs\nprs=$(gh pr list --json number)\ncurl -s https://example.com\necho '{}'\n",
    });
    const report = await checkStatic(dir, realFiles);
    expect(report.runs.map((r) => `${r.file}:${r.line}`)).toEqual(["gh.sh:3", "gh.sh:4"]);
    const missing = await folder('id = "m"\nname = "M"\nrun = "./gone.sh"\nplaces = ["belt"]\n');
    expect((await checkStatic(missing, realFiles)).problems).toEqual(["The run line names ./gone.sh, which is not in the folder."]);
    const binary = await folder('id = "b"\nname = "B"\nrun = "./b.sh"\nplaces = ["belt"]\n', { "b.sh": "\u007fELF\u0002\u0001\u0000\u0000" });
    const d = await deps();
    expect(await cmdTrickCheck(d, [binary])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("compiled program");
    expect(looksBinary("#!/bin/sh\n")).toBe(false);
    expect(runsLines([{ file: "p.ts", text: 'const r = Bun.spawn(["darius", "due"]);\n// gh comment\nconst x = 1;\n' }]).map((r) => r.line)).toEqual([1]);
  });

  test("the static half reads every source file in the folder and warns, never refuses", async () => {
    const dir = await folder('id = "w"\nname = "W"\nrun = "./run.sh"\nevery = "5m"\nplaces = ["belt"]\nenv = ["GH_TOKEN", "SSH_AUTH_SOCK", "HOME"]\n', {
      "run.sh": "#!/bin/sh\nexec bun ./lib/main.ts\n",
      "lib/main.ts": [
        'import { writeFileSync } from "node:fs";',
        'const out = Bun.spawnSync(["claude", "-p", "summarise"]);',
        'await fetch("https://api.openrouter.ai/v1");',
        'writeFileSync("/tmp/x", "y");',
        "writeFileSync(state + '/seen', 'y');",
        "console.log('{}');",
      ].join("\n"),
      "media/ignored.ts": 'Bun.spawn(["rm"]);',
      "config.toml": 'model = "claude"\n',
    });
    const report = await checkStatic(dir, realFiles);
    expect(report.warnings.map((w) => `${w.kind} ${w.file}:${w.line}`)).toEqual([
      "spawn lib/main.ts:2",
      "model lib/main.ts:2",
      "network lib/main.ts:3",
      "model lib/main.ts:3",
      "write lib/main.ts:4",
    ]);
    expect(report.env).toEqual([
      { name: "GH_TOKEN", passed: true },
      { name: "SSH_AUTH_SOCK", passed: false, reason: "never passed: a socket" },
      { name: "HOME", passed: true, reason: "passed to every trick anyway" },
    ]);
    expect(report.codeHash).toMatch(/^[0-9a-f]{64}$/);
    const d = await deps();
    expect(await cmdTrickCheck(d, [dir])).toBe(EXIT.OK);
    const printed = d.out.join("\n");
    expect(printed).toContain("a timer that calls a model spends your subscription with no session to show for it");
    expect(printed).toContain("a grep, not a proof");
    expect(printed).toContain("env:    GH_TOKEN, SSH_AUTH_SOCK (never passed: a socket), HOME (passed to every trick anyway)");
    // With no `every`, calling a model is the person's own tap: no model warning.
    const tapOnly = await folder('id = "t"\nname = "T"\nrun = "claude -p hi"\nplaces = ["belt"]\n');
    expect((await checkStatic(tapOnly, realFiles)).warnings).toEqual([]);
    const timed = await folder('id = "u"\nname = "U"\nrun = "claude -p hi"\nevery = "1m"\nplaces = ["belt"]\n');
    expect((await checkStatic(timed, realFiles)).warnings.map((w) => w.kind)).toEqual(["model"]);
  });

  test("a contract 2 trick's inputs: check prints the reads sentence, with every machine on a crew's lead; the run's facts carry contract 2", async () => {
    const manifest = 'id = "todo"\nname = "Todo"\nrun = "./p.sh"\nplaces = ["belt"]\ncontract = 2\ninputs = ["TODO.md", "shots/*.png"]\n';
    const dir = await folder(manifest, { "p.sh": '#!/bin/sh\nread -r facts\ncase "$facts" in *\'"contract":2\'*) n=2;; *) n=1;; esac\nprintf \'{"v":%s,"parts":[{"at":"belt","id":"belt","mark":{"label":"c%s"}}]}\\n\' "$n" "$n"\n' });
    const report = await checkStatic(dir, realFiles);
    expect(report.reads).toBe(inputsSentence(["TODO.md", "shots/*.png"], false));
    expect((await checkStatic(dir, realFiles, { crew: true })).reads).toBe("Reads TODO.md, shots/*.png in your agent sessions' folders on every machine of the crew.");
    const d = await deps();
    expect(await cmdTrickCheck(d, ["--run", dir])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain("reads:  Reads TODO.md, shots/*.png in your agent sessions' folders. The files are data for the program, never code.");
    expect(d.out.join("\n")).toContain("parts: belt belt");
    const lead = await deps();
    await writeFile(trustStorePath(lead.stateDir), serializeTrustStore(leadStore({ peers: [member({ memberId: "laptop" })] })));
    await cmdTrickCheck(lead, [dir]);
    expect(lead.out.join("\n")).toContain("on every machine of the crew");
    const ran = await runAgainstFixture((await checkStatic(dir, realFiles)).manifest ?? fail(), dir, d.ctx.env);
    expect(ran.parsed?.parts[0]?.part).toMatchObject({ mark: { label: "c2" } });
    const plain = await folder('id = "plain1"\nname = "P"\nrun = "./p.sh"\nplaces = ["belt"]\n', { "p.sh": '#!/bin/sh\nprintf \'{"v":1,"parts":[]}\\n\'\n' });
    expect((await checkStatic(plain, realFiles)).reads).toBeUndefined();
  });

  test("a trick.ts that is a helper this Collie ships is named, not grepped; a modified one is grepped and flagged", async () => {
    const dir = await folder('id = "kit"\nname = "Kit"\nrun = "program.ts"\nplaces = ["status"]\n', {
      "program.ts": 'import { run } from "./trick.ts";\nrun((t) => t.status({ text: "ok" }));\n',
      "trick.ts": TRICK_HELPER,
    });
    const report = await checkStatic(dir, realFiles);
    expect(report.helper).toEqual({ version: HELPER_VERSION, current: true, modified: false });
    expect(report.warnings.filter((w) => w.file === "trick.ts")).toEqual([]);
    expect(report.runs.filter((r) => r.file === "trick.ts")).toEqual([]);
    expect(report.notScanned).toContain("trick.ts");
    const d = await deps();
    expect(await cmdTrickCheck(d, [dir])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain(`helper: trick.ts is collie trick helper v${String(HELPER_VERSION)}, Collie's own code, not checked line by line`);
    await writeFile(join(dir, "trick.ts"), `${TRICK_HELPER}\nBun.spawn(["curl", "https://example.com"]);\n`);
    const modified = await checkStatic(dir, realFiles);
    expect(modified.helper).toEqual({ version: HELPER_VERSION, current: false, modified: true });
    expect(modified.warnings.some((w) => w.file === "trick.ts" && w.kind === "spawn")).toBe(true);
    const e = await deps();
    await cmdTrickCheck(e, [dir]);
    expect(e.out.join("\n")).toContain(`helper: trick.ts is a modified helper (its first line says v${String(HELPER_VERSION)}), so it is checked as the trick's own code`);
    expect(shippedHelperVersion(TRICK_HELPER)).toBe(HELPER_VERSION);
    expect(shippedHelperVersion("// collie trick helper v1\nexport {};\n")).toBeNull();
    const old = "// collie trick helper v1\nold text\n";
    const oldHash = new Bun.CryptoHasher("sha256").update(old).digest("hex");
    expect(shippedHelperVersion(old, new Map([[oldHash, 1]]))).toBe(1);
  });

  test("only code files are grepped: docs, data, tests and fixtures are listed as not grepped and still count in the code hash", async () => {
    const dir = await folder('id = "docs"\nname = "Docs"\nrun = "program.ts"\nevery = "5m"\nplaces = ["status"]\n', {
      "program.ts": 'console.log("{}");\n',
      "README.md": "Run `gh api user` and $(curl https://x) > out.txt, then node.\n",
      "SKILL.md": "claude -p hi\n",
      "notes.txt": "writeFileSync(x)\n",
      "data.json": '{ "cmd": "rm -rf" }\n',
      "test.sh": '#!/bin/sh\nout=$(bun ./program.ts) > "$tmp/x"\ncurl -s https://example.com\n',
      "program.test.ts": 'await fetch("https://example.com");\n',
      "fixtures/fake-gh.ts": 'Bun.spawn(["gh", "pr", "list"]);\n',
    });
    const report = await checkStatic(dir, realFiles);
    expect(report.warnings).toEqual([]);
    expect(report.runs).toEqual([]);
    expect(report.notScanned.toSorted()).toEqual(["README.md", "SKILL.md", "data.json", "fixtures/fake-gh.ts", "notes.txt", "program.test.ts", "test.sh"]);
    const before = report.codeHash;
    await writeFile(join(dir, "README.md"), "changed\n");
    expect((await checkStatic(dir, realFiles)).codeHash).not.toBe(before);
    expect(["a.ts", "lib/x.mjs", "run.sh", "AGENTS.md", "config.TOML", "x.test.tsx", "fixtures/a.sh", "deep/fixtures/b.ts"].map(isScannedFile)).toEqual([true, true, true, false, false, false, false, false]);
  });

  test("runs: and the warnings match command invocations in a code file, never a word in an identifier, a comment or a sentence", () => {
    const text = [
      'import { readFileSync } from "node:fs";',
      'const n = v.node("row");',
      "/** git and gh, in a comment */",
      'const sum = 1; // runs gh pr list',
      "const s = `the node ${n}`;",
      "const m = rest.match(/$(?![\\s\\S])/);",
      'notes.push("gh api user failed, node said no");',
      'await Bun.write(Bun.stdout, "{}");',
      'const gh = t.tool("gh");',
      'const r = await t.sh(gh, ["pr", "list"]);',
      'await Bun.write("/tmp/out", "x");',
    ].join("\n");
    expect(runsLines([{ file: "program.ts", text }]).map((r) => r.line)).toEqual([9, 10]);
    expect(checkWarnings([{ file: "program.ts", text }], true).map((w) => `${w.kind}:${String(w.line)}`)).toEqual(["network:9", "spawn:10", "write:11"]);
    // In a shell file a tool's bare name is in command position.
    expect(runsLines([{ file: "p.sh", text: "#!/bin/sh\nnode x.js\necho hi\n" }]).map((r) => r.line)).toEqual([2]);
  });

  test("--run runs the program with the env scrub: no COLLIE_ variable, no key", async () => {
    const dir = await folder('id = "env"\nname = "Env"\nrun = "bun program.ts"\nplaces = ["belt"]\n', {
      "program.ts": [
        'const leaked = Object.keys(process.env).filter((k) => k.startsWith("COLLIE_") || k.includes("KEY"));',
        "const facts = JSON.parse(await Bun.stdin.text());",
        'if (leaked.length > 0 || facts.trick.id !== "env") process.exit(7);',
        'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "ok" } }] }));',
      ].join("\n"),
    });
    const d = await deps();
    expect(await cmdTrickCheck(d, ["--run", "--json", dir])).toBe(EXIT.OK);
    // SAFETY: `--json` prints exactly one TrickCheckReport, and the fields read below are checked by value.
    const report = JSON.parse(d.out.join("\n")) as TrickCheckReport;
    expect(report.run?.outcome).toBe("exited");
    expect(report.run?.problem).toBeNull();
    expect(report.run?.parts).toEqual(["belt belt"]);
  });

  test("--run passes the TRICK_ test hooks of the environment; a manifest that lists one is told it is never passed", async () => {
    const dir = await folder('id = "hook"\nname = "Hook"\nrun = "bun program.ts"\nplaces = ["belt"]\nenv = ["TRICK_FIXTURE"]\n', {
      "program.ts": 'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: process.env.TRICK_NOW ?? "none" } }] }));\n',
    });
    const d = await deps();
    d.ctx.env = { ...d.ctx.env, TRICK_NOW: "1794225" };
    expect(await cmdTrickCheck(d, ["--run", "--json", dir])).toBe(EXIT.OK);
    // SAFETY: `--json` prints exactly one TrickCheckReport, and the fields read below are checked by value.
    const report = JSON.parse(d.out.join("\n")) as TrickCheckReport;
    expect(report.env).toEqual([{ name: "TRICK_FIXTURE", passed: false, reason: "never passed: a test hook, passed only by collie trick dev and check --run" }]);
    expect(report.run?.problem).toBeNull();
    const manifest = report.manifest;
    if (manifest === undefined) throw new Error("the manifest did not parse");
    const label = async (env: TrickDeps["ctx"]["env"]) => JSON.stringify((await runAgainstFixture(manifest, dir, env)).parsed?.parts[0]?.part);
    expect(await label(d.ctx.env)).toContain('"label":"1794225"');
    expect(await label({ PATH: process.env.PATH ?? "/usr/bin:/bin" })).toContain('"label":"none"');
  });

  test("--run prints the refusals of the output, masked stderr of a failure, and exits 1", async () => {
    const d = await deps();
    const refused = await folder('id = "r"\nname = "R"\nrun = "./p.sh"\nplaces = ["belt"]\n', {
      "p.sh": `#!/bin/sh\necho '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"label":"far too long a label"}}]}'\n`,
    });
    expect(await cmdTrickCheck(d, ["--run", refused])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("error: output /parts/0/mark/label");
    const e = await deps();
    const failing = await folder('id = "f"\nname = "F"\nrun = "./p.sh"\nplaces = ["belt"]\n', {
      "p.sh": `#!/bin/sh\necho "darius: not found ${KEY}" >&2\nexit 127\n`,
    });
    expect(await cmdTrickCheck(e, ["--run", failing])).toBe(EXIT.FAIL);
    const printed = e.err.join("\n");
    expect(printed).toContain("darius: not found");
    expect(printed).not.toContain(KEY);
  });

  test("--run prints a note for what the output holds that this Collie does not know, and stays 0", async () => {
    const d = await deps();
    const doc = { v: 1, glow: true, parts: [{ at: "sidebar", id: "x" }, { at: "belt", id: "belt", mark: { label: "1" } }, { at: "session", id: "s", view: [{ kind: "line", text: "a" }, { kind: "chart" }] }] };
    const newer = await folder('id = "n"\nname = "N"\nrun = "./p.sh"\nplaces = ["belt", "session"]\n', { "p.sh": `#!/bin/sh\necho '${JSON.stringify(doc)}'\n` });
    expect(await cmdTrickCheck(d, ["--run", newer])).toBe(EXIT.OK);
    const out = d.out.join("\n");
    expect(out).toContain("note: output /glow");
    expect(out).toContain("note: output /parts/0/at");
    expect(out).toContain("note: output /parts/2/view/1/kind");
    expect(d.err.join("\n")).not.toContain("error:");
  });
});

describe("collie trick check, a script Collie's runtime runs", () => {
  async function scriptFolder(files: Record<string, string>, run = "program.ts"): Promise<string> {
    const root = await tempDir();
    const dir = join(root, "rt");
    await mkdir(dir);
    await writeFile(join(dir, "trick.toml"), `id = "rt"\nname = "Rt"\nrun = "${run}"\nplaces = ["belt"]\n`);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true });
      await writeFile(join(dir, name), text);
    }
    return dir;
  }

  test("isBareImport: relative, node:, bun: and the built-ins need no install; a package name does", () => {
    for (const ok of ["./trick.ts", "../x.ts", "/abs.ts", "node:fs", "bun:sqlite", "bun", "fs", "path"]) expect(isBareImport(ok)).toBe(false);
    for (const bare of ["left-pad", "@scope/pkg", "zod", "lodash/fp"]) expect(isBareImport(bare)).toBe(true);
  });

  test("warns on each line that imports a package; relative, built-in and type imports pass", async () => {
    const dir = await scriptFolder({
      "program.ts": ['import { run } from "./trick.ts";', 'import { readFileSync } from "node:fs";', 'import type { X } from "some-types";', 'import { z } from "zod";', 'const m = await import("left-pad");', "run(async () => {});"].join("\n"),
      "trick.ts": 'export const run = (f: () => Promise<void>) => f();\nexport * from "chalk";\n',
    });
    const report = await checkStatic(dir, realFiles);
    const imports = report.warnings.filter((w) => w.kind === "import").map((w) => `${w.file}:${w.line}`);
    expect(imports).toEqual(["program.ts:4", "program.ts:5", "trick.ts:2"]);
    expect(report.problems).toEqual([]);
  });

  test("a shell-form trick gets no import warning; a script line that names a missing file is a problem", async () => {
    const shell = await scriptFolder({ "p.sh": "#!/bin/sh\n", "x.ts": 'import { z } from "zod";\n' }, "./p.sh");
    expect((await checkStatic(shell, realFiles)).warnings.filter((w) => w.kind === "import")).toEqual([]);
    const missing = await scriptFolder({});
    expect((await checkStatic(missing, realFiles)).problems).toEqual(["The run line names program.ts, which is not in the folder."]);
  });

  test("--run runs the script with the runtime that runs the tests, and parses what it prints", async () => {
    const dir = await scriptFolder({
      "program.ts": 'const facts = JSON.parse(await Bun.stdin.text());\nconsole.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: String(facts.sessions.length) } }] }));\n',
    });
    const d = await deps();
    expect(await cmdTrickCheck(d, ["--run", dir])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain("parts: belt belt");
  });

  test("--run warns about a Decision's wording as `collie hill post` does, and the check still passes", async () => {
    const doc = { v: 1, parts: [], decisions: [{ key: "kinds", title: "Are the new kinds right", summary: "Fine.", options: [{ intent: "yes", label: "Yes" }, { intent: "change", label: "Change them" }] }] };
    const dir = await scriptFolder({ "program.ts": `console.log(${JSON.stringify(JSON.stringify(doc))});\n` });
    const d = await deps();
    expect(await cmdTrickCheck(d, ["--run", dir])).toBe(EXIT.OK);
    const text = d.out.join("\n");
    expect(text).toContain("  warn: decision kinds: the title asks no question. Write the decision as a question the options answer.");
    expect(text).toContain('  warn: decision kinds: option "yes" says only "Yes". Start it with a verb that says what happens, such as "Ship it".');
    expect(text).toContain("ok: no problems.");
    d.out.length = 0;
    expect(await cmdTrickCheck(d, ["--run", "--json", dir])).toBe(EXIT.OK);
    // SAFETY: `--json` prints exactly one TrickCheckReport, and the fields read below are checked by value.
    const report = JSON.parse(d.out.join("\n")) as TrickCheckReport;
    expect(report.run?.wording.map((w) => w.key)).toEqual(["kinds", "kinds"]);
  });
});

describe("collie trick on, off and list", () => {
  test("on writes the switch file at 0600, off removes the id; unknown or refused tricks stay off", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    const path = switchesPath(d.stateDir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const code = await trickCodeHash(join(d.configDir, "tricks", "legs"));
    const hash = code.ok ? code.hash : "";
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2, layout: 3, on: { legs: { at: "2026-11-08T09:00:00.000Z", hash, auto: false, by: "cli", powers: expect.stringMatching(/^[0-9a-f]{16}$/) } } });
    expect(d.out.at(-1)).toBe(`Approved the code of legs as it is now: sha256 ${hash}. The bridge runs this copy; an edit of the folder waits for your yes.`);
    // The approved copy holds exactly the bytes approved.
    expect(await trickCodeHash(approvedCopyDir(d.configDir, "legs", hash))).toEqual(code);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(d.out.at(-1)).toBe(`legs is already on, with this code approved (sha256 ${hash}).`);
    // An edit, then on again: the new code is approved.
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho changed\n");
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path, "utf8")).on.legs).toMatchObject({ previous: { hash } });
    expect(JSON.parse(await readFile(path, "utf8")).on.legs.hash).not.toBe(hash);
    expect(await cmdTrickSwitch(d, ["legs"], false)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2, layout: 3, on: {} });
    expect(await cmdTrickSwitch(d, ["legs"], false)).toBe(EXIT.OK);
    expect(d.out.at(-1)).toBe("legs is already off.");
    expect(await cmdTrickSwitch(d, ["ghost"], true)).toBe(EXIT.FAIL);
    await mkdir(join(d.configDir, "tricks", "broken"));
    await writeFile(join(d.configDir, "tricks", "broken", "trick.toml"), 'id = "broken"\n');
    expect(await cmdTrickSwitch(d, ["broken"], true)).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("stays off");
    expect(await cmdTrickSwitch(d, [], true)).toBe(EXIT.USAGE);
  });

  test("on prints the check scan's warnings above its confirmation, says they are a text search, and still switches on", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["--sh", "legs"]);
    const dir = join(d.configDir, "tricks", "legs");
    await writeFile(join(dir, "program.sh"), '#!/bin/sh\ncurl -s https://example.com\nclaude -p "summarise"\nprintf \'{"v":1,"parts":[]}\\n\'\n');
    d.out.length = 0;
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    const on = d.out.findIndex((l) => l.startsWith("legs is on."));
    const warns = d.out.slice(0, on);
    expect(warns.some((l) => l.startsWith("warn: program.sh:2 reaches the network"))).toBe(true);
    expect(warns.some((l) => l.startsWith("warn: program.sh:3 calls an agent program or a model API"))).toBe(true);
    expect(warns.at(-1)).toContain("text search of the code, not a proof");
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on.legs).toBeDefined();
    // A clean trick prints no warning and no honesty line.
    const clean = await deps();
    await cmdTrickInit(clean, ["quiet"]);
    clean.out.length = 0;
    expect(await cmdTrickSwitch(clean, ["quiet"], true)).toBe(EXIT.OK);
    expect(clean.out[0]).toStartWith("quiet is on.");
  });

  test("list shows the bridge's state, last run and error when it answers", async () => {
    const d = await deps({
      rev: 5,
      tricks: [{ host: "lodge", id: "legs", name: "legs", icon: "plug", on: true, state: "failing", places: ["belt"], error: "The program exited with 1", lastRunAt: "2026-11-08T09:41:00.000Z" }],
      parts: [],
      present: [],
      path: "/usr/bin",
    });
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickSwitch(d, ["legs"], true);
    d.out.length = 0;
    expect(await cmdTrickList(d, [])).toBe(EXIT.OK);
    expect(d.out[0]).toMatch(/^ID\s+NAME\s+SWITCH\s+AUTO\s+SKILL\s+ORIGIN\s+VERSION\s+STATE\s+LAST RUN\s+LAST ERROR$/);
    expect(d.out[1]).toMatch(/^legs\s+legs\s+on\s+-\s+-\s+-\s+-\s+failing\s+2026-11-08T09:41:00.000Z\s+The program exited with 1$/);
    expect(d.asked[0]).toBe("http://127.0.0.1:18999/api/tricks");
  });

  test("B7: list on a machine whose crew's lead runs the tricks says so, by name, in text and in --json", async () => {
    const d = await deps({ rev: 5, tricks: [], parts: [], present: [], runsOn: { lead: "desk" } });
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickSwitch(d, ["legs"], true);
    d.out.length = 0;
    expect(await cmdTrickList(d, [])).toBe(EXIT.OK);
    expect(d.out).toContain("Tricks run on the lead of this crew (desk). This machine runs none.");
    d.out.length = 0;
    await cmdTrickList(d, ["--json"]);
    // SAFETY: `list --json` prints one document, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { runsOn?: { lead?: string } };
    expect(doc.runsOn).toEqual({ lead: "desk" });
    const solo = await deps({ rev: 5, tricks: [], parts: [], present: [] });
    await cmdTrickInit(solo, ["legs"]);
    solo.out.length = 0;
    await cmdTrickList(solo, []);
    expect(solo.out.join("\n")).not.toContain("This machine runs none");
  });

  test("list without a bridge says so, and with no folder points at init", async () => {
    const d = await deps(null);
    expect(await cmdTrickList(d, [])).toBe(EXIT.OK);
    expect(d.out[0]).toStartWith("No tricks in");
    expect(d.asked).toEqual([]);
    await cmdTrickInit(d, ["legs"]);
    d.out.length = 0;
    await cmdTrickList(d, ["--json"]);
    // SAFETY: `list --json` prints one document with `bridge` and `tricks`, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { bridge: boolean; tricks: { state: string }[] };
    expect(doc.bridge).toBe(false);
    expect(doc.tricks[0]?.state).toBe("off");
  });

  test("list --official prints the official list and each entry's state here; it fetches nothing", async () => {
    const list = shippedOfficialList();
    if (!list.ok) throw new Error(list.reason);
    const first = list.entries[0];
    const second = list.entries[1];
    if (first === undefined || second === undefined) throw new Error("the list holds fewer than two entries");
    const d = await deps(null);
    // A record of the list at its commit over code that is not the list's (an edit, or a record by hand),
    // one by hand under the same id, and one from the repository at a commit the list never named.
    await mkdir(join(d.configDir, "tricks", first.id), { recursive: true });
    await writeFile(join(d.configDir, "tricks", first.id, ORIGIN_FILE), renderOrigin({ url: first.repo, ref: first.commit, commit: first.commit, subdir: first.dir, at: "2026-11-11T09:00:00.000Z", official: true }));
    await mkdir(join(d.configDir, "tricks", second.id), { recursive: true });
    const third = list.entries[2];
    if (third === undefined) throw new Error("the list holds fewer than three entries");
    await mkdir(join(d.configDir, "tricks", third.id), { recursive: true });
    await writeFile(join(d.configDir, "tricks", third.id, ORIGIN_FILE), renderOrigin({ url: third.repo, ref: "refs/pull/4/head", commit: "4".repeat(40), subdir: third.dir, at: "2026-11-11T09:00:00.000Z" }));
    expect(await cmdTrickList(d, ["--official"])).toBe(EXIT.OK);
    expect(d.out[0]).toMatch(/^ID\s+NAME\s+COMMIT\s+STATE\s+WHAT IT DOES$/);
    expect(d.out[1]).toStartWith(first.id);
    expect(d.out[1]).toContain("taken: its files were edited, update it with collie trick update");
    expect(d.out[2]).toContain("taken: another trick has this id");
    expect(d.out[3]).toContain("taken: from the repository, not from the official list");
    expect(d.out.at(-1)).toBe("From AltanS/collie-tricks, at the commits this Collie release names. Add one on the phone: Settings, Tricks, Official tricks.");
    // The only request is the local bridge's own tricks list, for the crew line: nothing reaches GitHub.
    expect(d.asked).toEqual(["http://127.0.0.1:18999/api/tricks"]);
    d.out.length = 0;
    await cmdTrickList(d, ["--official", "--json"]);
    // SAFETY: `list --official --json` prints one document, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { official: { id: string; state: string }[] };
    expect(doc.official.map((e) => e.state)).toEqual(list.entries.map((e) => (e.id === first.id || e.id === second.id || e.id === third.id ? "taken" : "absent")));
    expect(await readdir(join(d.configDir, "tricks"))).toEqual([first.id, second.id, third.id].toSorted());
  });

  test("list --official on a crew member names the lead", async () => {
    const d = await deps({ rev: 5, tricks: [], parts: [], present: [], runsOn: { lead: "desk" } });
    expect(await cmdTrickList(d, ["--official"])).toBe(EXIT.OK);
    expect(d.out).toContain("Tricks run on the lead of this crew (desk). This machine runs none.");
  });

  test("the official list names the repository a bare `collie trick add <name>` reads", () => {
    expect(OFFICIAL_REPOS).toEqual([OFFICIAL_TRICKS_REPO]);
  });

  test("a bare or unknown subcommand is usage", async () => {
    const c = capture();
    expect(cmdTrick({ io: c.io }, [])).toBe(EXIT.USAGE);
    expect(cmdTrick({ io: c.io }, ["frob"])).toBe(EXIT.USAGE);
    expect(c.err.join("\n")).toContain('unknown trick subcommand "frob"');
  });
});

describe("collie trick skill", () => {
  const TEXT = "# legs\n\nKeep the file notes.md up to date.\n";

  /** A trick folder `legs` with a SKILL.md, switched on. */
  async function onTrick(skill: string | null = TEXT): Promise<Awaited<ReturnType<typeof deps>>> {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    if (skill !== null) await writeFile(join(d.configDir, "tricks", "legs", "SKILL.md"), skill);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    d.out.length = 0;
    d.err.length = 0;
    return d;
  }

  test("is a verb of the tree, and the list marks which tricks have a SKILL.md", async () => {
    expect(TRICK_SUBCOMMANDS).toContain("skill");
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickInit(d, ["plain"]);
    await writeFile(join(d.configDir, "tricks", "legs", "SKILL.md"), TEXT);
    d.out.length = 0;
    expect(await cmdTrickList(d, [])).toBe(EXIT.OK);
    expect(d.out[1]).toMatch(/^legs\s+legs\s+off\s+-\s+yes\s+/);
    expect(d.out[2]).toMatch(/^plain\s+plain\s+off\s+-\s+-\s+/);
    d.out.length = 0;
    await cmdTrickList(d, ["--json"]);
    // SAFETY: `list --json` prints one document, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { tricks: { id: string; skill: boolean }[] };
    expect(doc.tricks.map((t) => [t.id, t.skill])).toEqual([["legs", true], ["plain", false]]);
  });

  test("prints SKILL.md of a trick that is on, and nothing else", async () => {
    const d = await onTrick();
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toBe(TEXT.trimEnd());
    expect(d.err).toEqual([]);
  });

  test("reads the approved copy: an edit of the folder, SKILL.md included, waits for a yes", async () => {
    const d = await onTrick();
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho changed\n");
    await writeFile(join(d.configDir, "tricks", "legs", "SKILL.md"), "# legs\n\nDelete everything.\n");
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toBe(TEXT.trimEnd());
    // Approved: the new text is what agents read.
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    d.out.length = 0;
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toBe("# legs\n\nDelete everything.");
  });

  test("an approved copy that changed on disk, or is missing, teaches nothing", async () => {
    const d = await onTrick();
    const file = JSON.parse(await readFile(switchesPath(d.stateDir), "utf8"));
    const copy = approvedCopyDir(d.configDir, "legs", file.on.legs.hash);
    await chmod(join(copy, "SKILL.md"), 0o600);
    await writeFile(join(copy, "SKILL.md"), "# legs\n\nDelete everything.\n");
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err).toEqual(["the approved copy of legs changed on disk, so it teaches nothing until a person approves it again"]);
    expect(d.out).toEqual([]);
    await rm(copy, { recursive: true, force: true });
    d.err.length = 0;
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err[0]).toContain("has no approved copy on this machine yet");
  });

  test("a trick that is off, unknown or without a manifest teaches nothing, in one line, exit 1", async () => {
    const d = await onTrick();
    // off
    d.err.length = 0;
    await cmdTrickSwitch(d, ["legs"], false);
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err.at(-1)).toBe("legs is off, so it teaches nothing");
    // unknown
    d.err.length = 0;
    expect(await cmdTrickSkill(d, ["ghost"])).toBe(EXIT.FAIL);
    expect(d.err).toEqual(["no such trick: ghost"]);
    // a manifest that does not parse
    await mkdir(join(d.configDir, "tricks", "broken"));
    await writeFile(join(d.configDir, "tricks", "broken", "trick.toml"), 'id = "broken"\n');
    await writeFile(join(d.configDir, "tricks", "broken", "SKILL.md"), TEXT);
    d.err.length = 0;
    d.out.length = 0;
    expect(await cmdTrickSkill(d, ["broken"])).toBe(EXIT.FAIL);
    expect(d.err).toEqual(["broken is off, so it teaches nothing"]);
    expect(d.out).toEqual([]);
  });

  test("an on trick with no SKILL.md, a symlinked one, a directory and an oversized one are refused", async () => {
    const none = await onTrick(null);
    expect(await cmdTrickSkill(none, ["legs"])).toBe(EXIT.FAIL);
    expect(none.err).toEqual(["legs has no SKILL.md"]);

    const link = await onTrick(null);
    await writeFile(join(link.configDir, "secret.txt"), "private\n");
    await symlink(join(link.configDir, "secret.txt"), join(link.configDir, "tricks", "legs", "SKILL.md"));
    // B3: a trick folder with a link is not approved, so the approved copy never holds the link.
    expect(await cmdTrickSwitch(link, ["legs"], true)).not.toBe(EXIT.OK);
    expect(link.err.join("\n")).toContain("SKILL.md is a symbolic link");
    link.out.length = 0;
    link.err.length = 0;
    expect(await cmdTrickSkill(link, ["legs"])).toBe(EXIT.FAIL);
    expect(link.out).toEqual([]);
    expect(link.err[0]).toBe("legs has no SKILL.md");

    const big = await onTrick("x".repeat(SKILL_BYTES_MAX + 1));
    expect(await cmdTrickSkill(big, ["legs"])).toBe(EXIT.FAIL);
    expect(big.err).toEqual(["legs has a SKILL.md larger than 32 KiB, so it is not read"]);
    expect(big.out).toEqual([]);

    const edge = await onTrick("y".repeat(SKILL_BYTES_MAX));
    expect(await cmdTrickSkill(edge, ["legs"])).toBe(EXIT.OK);
    expect(edge.out[0]?.length).toBe(SKILL_BYTES_MAX);
  });

  test("the text goes through the secret mask", async () => {
    const d = await onTrick(`Use the key ${KEY} for the call.\n`);
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.join("\n")).not.toContain(KEY);
    expect(d.out.join("\n")).toContain("Use the key ");
  });

  test("with no id it prints the brief for writing a trick; a bad id is usage", async () => {
    const d = await deps();
    expect(await cmdTrickSkill(d, [])).toBe(EXIT.OK);
    expect(d.out).toEqual([...TRICK_WRITE_BRIEF]);
    const text = d.out.join("\n");
    expect(text).toContain("collie trick init <id>");
    expect(text).toContain("AGENTS.md");
    expect(text).toContain("collie trick check --run <folder>");
    expect(await cmdTrickSkill(d, ["Bad Id"])).toBe(EXIT.USAGE);
  });
});

describe("the doctor's tricks row", () => {
  test("no tricks folder, no row", async () => {
    expect(await tricksFindings(await deps())).toEqual([]);
  });

  test("one row with each trick, its state and error, and the runner's PATH; warn when an on trick fails", async () => {
    const d = await deps({
      rev: 5,
      tricks: [{ host: "lodge", id: "legs", name: "legs", icon: "plug", on: true, state: "stopped", places: ["belt"], error: "darius: not found" }],
      parts: [],
      present: [],
      path: "/unit/bin:/usr/bin",
    });
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickInit(d, ["quiet"]);
    await cmdTrickSwitch(d, ["legs"], true);
    const rows = await tricksFindings(d);
    expect(rows.length).toBe(1);
    expect(rows[0]?.check).toBe("tricks");
    expect(rows[0]?.status).toBe("warn");
    expect(rows[0]?.detail).toContain("2 tricks in");
    expect(rows[0]?.detail).toContain("1 on");
    expect(rows[0]?.detail).toContain("legs on, stopped: darius: not found");
    expect(rows[0]?.detail).toContain("quiet off, off");
    expect(rows[0]?.detail).toContain("PATH /unit/bin:/usr/bin");
    expect(rows[0]?.remedy).toContain("collie trick check --run");
  });

  test("without a bridge the PATH is the shell's, said so", async () => {
    const d = await deps(null);
    await cmdTrickInit(d, ["legs"]);
    const rows = await tricksFindings(d);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.detail).toContain("(as this shell sees it; the service has its own)");
  });
});

describe("approving from inside an agent's pane, auto, and a version waiting", () => {
  const PANE = { HERDR_PANE_ID: "w1:p2", HERDR_SOCKET_PATH: "/run/user/1000/herdr.sock" };

  test("on refuses in a pane the bridge says runs an agent, and tells the agent to hand it to its operator; off still works there", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    const asked: string[] = [];
    const inPane = (kind: "agent" | "shell" | "unknown"): typeof d => ({
      ...d,
      ctx: { ...d.ctx, env: { ...d.ctx.env, ...PANE } },
      paneKind: async () => {
        asked.push(kind);
        return kind;
      },
    });
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho changed\n");
    const before = await readFile(switchesPath(d.stateDir), "utf8");
    d.err.length = 0;
    expect(await cmdTrickSwitch(inPane("agent"), ["legs"], true)).toBe(EXIT.REFUSED);
    expect(d.err).toEqual(agentPaneRefusal("legs"));
    expect(d.err.join("\n")).toContain("Tell your operator that legs is ready to switch on.");
    expect(await readFile(switchesPath(d.stateDir), "utf8")).toBe(before);
    // A shell pane in the multiplexer is a person's terminal: the yes goes through.
    expect(await cmdTrickSwitch(inPane("shell"), ["legs"], true)).toBe(EXIT.OK);
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho again\n");
    // No bridge answers, or it does not know the pane: a speed bump, not a wall, so allowed.
    expect(await cmdTrickSwitch(inPane("unknown"), ["legs"], true)).toBe(EXIT.OK);
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho thrice\n");
    const broken: typeof d = { ...inPane("agent"), paneKind: async () => Promise.reject(new Error("socket gone")) };
    expect(await cmdTrickSwitch(broken, ["legs"], true)).toBe(EXIT.OK);
    expect(asked).toEqual(["agent", "shell", "unknown"]);
    // Outside any pane the bridge is not asked at all. A pane marker without its scope variable is no marker (cli/beacon.ts).
    const half: typeof d = { ...inPane("agent"), ctx: { ...d.ctx, env: { ...d.ctx.env, HERDR_PANE_ID: "w1:p2" } } };
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho four\n");
    expect(await cmdTrickSwitch(half, ["legs"], true)).toBe(EXIT.OK);
    expect(asked).toEqual(["agent", "shell", "unknown"]);
    expect(await cmdTrickSwitch(inPane("agent"), ["legs"], false)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on).toEqual({});
  });

  test("auto on|off is kept in the switch, shown in list, refused for a trick that is off, and 'on' is refused in an agent's pane", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    expect(await cmdTrickAuto(d, ["legs", "on"])).toBe(EXIT.FAIL);
    expect(d.err.at(-1)).toBe("error: legs is off. Switch it on first: collie trick on legs");
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(await cmdTrickAuto(d, ["legs", "on"])).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on.legs.auto).toBe(true);
    d.out.length = 0;
    await cmdTrickList(d, []);
    expect(d.out[1]).toMatch(/^legs\s+legs\s+on\s+on\s+/);
    // Switching on again keeps the choice.
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho changed\n");
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on.legs.auto).toBe(true);
    const inPane: typeof d = { ...d, ctx: { ...d.ctx, env: { ...d.ctx.env, ...PANE } }, paneKind: async () => "agent" };
    expect(await cmdTrickAuto(inPane, ["legs", "on"])).toBe(EXIT.REFUSED);
    expect(await cmdTrickAuto({ ...inPane, paneKind: async () => "shell" }, ["legs", "on"])).toBe(EXIT.OK);
    expect(await cmdTrickAuto(inPane, ["legs", "off"])).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on.legs.auto).toBe(false);
    expect(await cmdTrickAuto(d, ["legs"])).toBe(EXIT.USAGE);
    expect(await cmdTrickAuto(d, ["legs", "maybe"])).toBe(EXIT.USAGE);
    expect(TRICK_SUBCOMMANDS).toContain("auto");
  });

  test("list marks a trick whose folder moved past its approved version, with one hint", async () => {
    const d = await deps(null);
    await cmdTrickInit(d, ["legs"]);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    await writeFile(join(d.configDir, "tricks", "legs", "program.sh"), "#!/bin/sh\necho changed\n");
    d.out.length = 0;
    await cmdTrickList(d, []);
    expect(d.out[0]).toContain("VERSION");
    expect(d.out[1]).toMatch(/ NEW +on, not seen by the bridge/);
    expect(d.out).toContain("NEW: a new version waits for your yes. Approve it on the Hill, or with collie trick on <id>.");
    d.out.length = 0;
    await cmdTrickList(d, ["--json"]);
    // SAFETY: `list --json` prints one document, checked by value below.
    expect((JSON.parse(d.out.join("\n")) as { tricks: { pending: boolean; auto: boolean }[] }).tricks[0]).toMatchObject({ pending: true, auto: false });
  });

  test("on over a version 2 switch file migrates it first: the other trick keeps its consent and gets its copy", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickInit(d, ["other"]);
    const other = await trickCodeHash(join(d.configDir, "tricks", "other"));
    const hash = other.ok ? other.hash : "";
    await mkdir(dirname(switchesPath(d.stateDir)), { recursive: true });
    await writeFile(switchesPath(d.stateDir), JSON.stringify({ v: 2, on: { other: { at: "t", hash } } }));
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    const file = JSON.parse(await readFile(switchesPath(d.stateDir), "utf8"));
    expect([file.v, file.layout]).toEqual([2, 3]);
    expect(file.on.other).toMatchObject({ hash, by: "migrated" });
    expect(await trickCodeHash(approvedCopyDir(d.configDir, "other", hash))).toEqual(other);
  });
});

describe("an agent view (contract 2)", () => {
  const VIEW_TOML = 'id = "morph"\nname = "Morph"\ncontract = 2\nplaces = ["agent-view"]\nrules = "rules.md"\n';

  async function viewFolder(configDir: string, rules = "Draw one screen.\n"): Promise<string> {
    const dir = join(configDir, "tricks", "morph");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trick.toml"), VIEW_TOML);
    await writeFile(join(dir, "rules.md"), rules);
    return dir;
  }

  test("check prints the rights lines, the rules file, the later note and no program", async () => {
    const d = await deps();
    const dir = await viewFolder(d.configDir);
    expect(await cmdTrickCheck(d, ["--run", dir])).toBe(EXIT.OK);
    const out = d.out.join("\n");
    expect(out).toContain("Adds a view of a session that the session's own agent draws. You switch it on per session.");
    expect(out).toContain("A tap in that view sends a message in your name to that session only.");
    expect(out).toContain("rules.md. Gives your agents instructions written by its author.");
    expect(out).toContain("Agent views come with a later build of this version.");
    expect(out).toContain("none: this trick is an agent view and has no program, so nothing runs.");
    expect(d.err).toEqual([]);
  });

  test("check prints each break of the rules' content rule, naming the line, and fails", async () => {
    const d = await deps();
    const dir = await viewFolder(d.configDir, "Draw.\n\tTab.\nTrailing \nToo   many.\n");
    expect(await cmdTrickCheck(d, [dir])).toBe(EXIT.FAIL);
    const err = d.err.join("\n");
    expect(err).toContain("rules.md line 2 holds a tab. Use spaces.");
    expect(err).toContain("rules.md line 3 ends with a space.");
    expect(err).toContain("rules.md line 4 holds a run of more than 2 spaces.");
  });

  test("auto on is refused for a trick with rules, in the folder or the approved copy; off is fine", async () => {
    const d = await deps();
    await viewFolder(d.configDir);
    expect(await cmdTrickSwitch(d, ["morph"], true)).toBe(EXIT.OK);
    expect(await cmdTrickAuto(d, ["morph", "on"])).toBe(EXIT.REFUSED);
    expect(d.err.slice(-2)).toEqual([
      "error: A trick that gives your agents instructions never takes a new version without asking: every change of its code waits for your yes.",
      "error: morph keeps asking.",
    ]);
    expect(JSON.parse(await readFile(switchesPath(d.stateDir), "utf8")).on.morph.auto).toBe(false);
    // The folder drops the keys, but the approved copy still gives instructions: still refused.
    await writeFile(join(d.configDir, "tricks", "morph", "trick.toml"), 'id = "morph"\nname = "Morph"\nrun = "./p.sh"\nplaces = ["belt"]\n');
    expect(await cmdTrickAuto(d, ["morph", "on"])).toBe(EXIT.REFUSED);
    expect(await cmdTrickAuto(d, ["morph", "off"])).toBe(EXIT.OK);
  });
});
