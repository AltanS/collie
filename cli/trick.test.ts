import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { trickCodeHash } from "../bridge/tricks/code-hash.ts";
import { switchesPath } from "../bridge/tricks/paths.ts";
import { EXIT, type Io } from "./io.ts";
import { tricksFindings } from "./trick-findings.ts";
import { checkStatic, cmdTrick, cmdTrickCheck, cmdTrickInit, cmdTrickList, cmdTrickSkill, cmdTrickSwitch, looksBinary, runsLines, sampleAgents, SKILL_BYTES_MAX, TRICK_WRITE_BRIEF, TRICK_SUBCOMMANDS, type TrickCheckReport, type TrickDeps } from "./trick.ts";
import { realFiles } from "./sys.ts";
import { parseTrickDocument, type TricksReply } from "../web/src/lib/tricks/schema.ts";

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

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

/** Deps over a fresh config and state folder. `answer` is what the bridge's `GET /api/tricks` says. */
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

  test("writes trick.toml, an executable provider.sh and AGENTS.md, and refuses an existing folder", async () => {
    const d = await deps();
    expect(await cmdTrickInit(d, ["legs"])).toBe(EXIT.OK);
    const dir = join(d.configDir, "tricks", "legs");
    expect(await readFile(join(dir, "trick.toml"), "utf8")).toContain('places = ["belt"]');
    expect((await stat(join(dir, "provider.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("collie trick check --run .");
    expect((await stat(join(d.configDir, "tricks"))).mode & 0o777).toBe(0o700);
    expect(d.out.join("\n")).toContain("The trick is off.");
    expect(await cmdTrickInit(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("exists already");
    expect(await cmdTrickInit(d, ["Bad_Id"])).toBe(EXIT.USAGE);
  });

  test("the folder init writes passes check --run", async () => {
    const d = await deps();
    await cmdTrickInit(d, ["hello"]);
    const dir = join(d.configDir, "tricks", "hello");
    expect(await cmdTrickCheck(d, ["--run", dir])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain("parts: belt belt");
    expect(d.out.at(-1)).toBe("ok: no problems.");
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
    expect(d.err.join("\n")).toContain("/places/0");
    expect(d.err.join("\n")).toContain("/colour");
    const later = await folder('id = "later"\nname = "Later"\nrun = "./p.sh"\nwatch = ["~/x.log"]\nplaces = ["belt"]\n', { "p.sh": "#!/bin/sh\necho '{}'\n" });
    const e = await deps();
    expect(await cmdTrickCheck(e, [later])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("note: trick.toml /watch");
  });

  test("runs: lists the command lines of the provider; a missing or binary provider is refused", async () => {
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

  test("--run runs the provider with the env scrub: no COLLIE_ variable, no key", async () => {
    const dir = await folder('id = "env"\nname = "Env"\nrun = "bun provider.ts"\nplaces = ["belt"]\n', {
      "provider.ts": [
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
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2, on: { legs: { at: "2026-11-08T09:00:00.000Z", hash } } });
    expect(d.out.at(-1)).toBe(`Approved the code of legs as it is now: sha256 ${hash}. An edit to its code stops it until you switch it on again.`);
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(d.out.at(-1)).toBe(`legs is already on, with this code approved (sha256 ${hash}).`);
    // An edit, then on again: the new code is approved.
    await writeFile(join(d.configDir, "tricks", "legs", "provider.sh"), "#!/bin/sh\necho changed\n");
    expect(await cmdTrickSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path, "utf8")).on.legs.hash).not.toBe(hash);
    expect(await cmdTrickSwitch(d, ["legs"], false)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2, on: {} });
    expect(await cmdTrickSwitch(d, ["legs"], false)).toBe(EXIT.OK);
    expect(d.out.at(-1)).toBe("legs is already off.");
    expect(await cmdTrickSwitch(d, ["ghost"], true)).toBe(EXIT.FAIL);
    await mkdir(join(d.configDir, "tricks", "broken"));
    await writeFile(join(d.configDir, "tricks", "broken", "trick.toml"), 'id = "broken"\n');
    expect(await cmdTrickSwitch(d, ["broken"], true)).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("stays off");
    expect(await cmdTrickSwitch(d, [], true)).toBe(EXIT.USAGE);
  });

  test("list shows the bridge's state, last run and error when it answers", async () => {
    const d = await deps({
      rev: 5,
      tricks: [{ host: "bluefin", id: "legs", name: "legs", icon: "plug", on: true, state: "failing", places: ["belt"], error: "The provider exited with 1", lastRunAt: "2026-11-08T09:41:00.000Z" }],
      parts: [],
      present: [],
      path: "/usr/bin",
    });
    await cmdTrickInit(d, ["legs"]);
    await cmdTrickSwitch(d, ["legs"], true);
    d.out.length = 0;
    expect(await cmdTrickList(d, [])).toBe(EXIT.OK);
    expect(d.out[0]).toMatch(/^ID\s+NAME\s+SWITCH\s+SKILL\s+STATE\s+LAST RUN\s+LAST ERROR$/);
    expect(d.out[1]).toMatch(/^legs\s+legs\s+on\s+-\s+failing\s+2026-11-08T09:41:00.000Z\s+The provider exited with 1$/);
    expect(d.asked[0]).toBe("http://127.0.0.1:18999/api/tricks");
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

  test("a bare or unknown subcommand is usage", async () => {
    const c = capture();
    expect(cmdTrick({ io: c.io }, [])).toBe(EXIT.USAGE);
    expect(cmdTrick({ io: c.io }, ["add"])).toBe(EXIT.USAGE);
    expect(c.err.join("\n")).toContain('unknown trick subcommand "add"');
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
    expect(d.out[1]).toMatch(/^legs\s+legs\s+off\s+yes\s+/);
    expect(d.out[2]).toMatch(/^plain\s+plain\s+off\s+-\s+/);
    d.out.length = 0;
    await cmdTrickList(d, ["--json"]);
    // SAFETY: `list --json` prints one document, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { tricks: { id: string; skill: boolean }[] };
    expect(doc.tricks.map((t) => [t.id, t.skill])).toEqual([["legs", true], ["plain", false]]);
  });

  test("prints SKILL.md of a trick that is on and unchanged, and nothing else", async () => {
    const d = await onTrick();
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toBe(TEXT.trimEnd());
    expect(d.err).toEqual([]);
  });

  test("a trick that is off, changed, unknown or without a manifest teaches nothing, in one line, exit 1", async () => {
    const d = await onTrick();
    // changed: an edit to the code after the switch
    await writeFile(join(d.configDir, "tricks", "legs", "provider.sh"), "#!/bin/sh\necho changed\n");
    expect(await cmdTrickSkill(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err).toEqual(["legs changed since it was switched on, so it teaches nothing until you switch it on again"]);
    expect(d.out).toEqual([]);
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
    expect(d.err).toEqual(["broken has a manifest that does not parse, so it teaches nothing"]);
    expect(d.out).toEqual([]);
  });

  test("an on trick with no SKILL.md, a symlinked one, a directory and an oversized one are refused", async () => {
    const none = await onTrick(null);
    expect(await cmdTrickSkill(none, ["legs"])).toBe(EXIT.FAIL);
    expect(none.err).toEqual(["legs has no SKILL.md"]);

    const link = await onTrick(null);
    await writeFile(join(link.configDir, "secret.txt"), "private\n");
    await symlink(join(link.configDir, "secret.txt"), join(link.configDir, "tricks", "legs", "SKILL.md"));
    // The symlink is part of the code: switch on again so the trick is not "changed", then ask.
    await cmdTrickSwitch(link, ["legs"], true);
    link.out.length = 0;
    link.err.length = 0;
    expect(await cmdTrickSkill(link, ["legs"])).toBe(EXIT.FAIL);
    expect(link.out).toEqual([]);
    expect(link.err[0]).toBe("legs has no SKILL.md (it is not a regular file)");

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
      tricks: [{ host: "bluefin", id: "legs", name: "legs", icon: "plug", on: true, state: "stopped", places: ["belt"], error: "darius: not found" }],
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
