import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { switchesPath } from "../bridge/mods/paths.ts";
import { EXIT, type Io } from "./io.ts";
import { modsFindings } from "./mod-findings.ts";
import { checkStatic, cmdMod, cmdModCheck, cmdModInit, cmdModList, cmdModSwitch, looksBinary, runsLines, type ModCheckReport, type ModDeps } from "./mod.ts";
import { realFiles } from "./sys.ts";
import type { ModsReply } from "../web/src/lib/mods/schema.ts";

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "collie-mod-cli-"));
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

/** Deps over a fresh config and state folder. `answer` is what the bridge's `GET /api/mods` says. */
async function deps(answer: ModsReply | null = null): Promise<ModDeps & Captured & { configDir: string; stateDir: string; asked: string[] }> {
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

describe("collie mod init", () => {
  test("writes mod.toml, an executable provider.sh and AGENTS.md, and refuses an existing folder", async () => {
    const d = await deps();
    expect(await cmdModInit(d, ["legs"])).toBe(EXIT.OK);
    const dir = join(d.configDir, "mods", "legs");
    expect(await readFile(join(dir, "mod.toml"), "utf8")).toContain('places = ["belt"]');
    expect((await stat(join(dir, "provider.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toContain("collie mod check --run .");
    expect((await stat(join(d.configDir, "mods"))).mode & 0o777).toBe(0o700);
    expect(d.out.join("\n")).toContain("The mod is off.");
    expect(await cmdModInit(d, ["legs"])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("exists already");
    expect(await cmdModInit(d, ["Bad_Id"])).toBe(EXIT.USAGE);
  });

  test("the folder init writes passes check --run", async () => {
    const d = await deps();
    await cmdModInit(d, ["hello"]);
    const dir = join(d.configDir, "mods", "hello");
    expect(await cmdModCheck(d, ["--run", dir])).toBe(EXIT.OK);
    expect(d.out.join("\n")).toContain("parts: belt belt");
    expect(d.out.at(-1)).toBe("ok: no problems.");
  });
});

describe("collie mod check", () => {
  async function folder(manifest: string, files: Record<string, string> = {}): Promise<string> {
    const root = await tempDir();
    const id = /id = "([^"]+)"/.exec(manifest)?.[1] ?? "x";
    const dir = join(root, id);
    await mkdir(dir);
    await writeFile(join(dir, "mod.toml"), manifest);
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text, { mode: 0o755 });
    return dir;
  }

  test("the checked-in fixture is clean", async () => {
    const d = await deps();
    expect(await cmdModCheck(d, [join(import.meta.dir, "..", "bridge", "mods", "fixtures", "hello")])).toBe(EXIT.OK);
  });

  test("usage is 2: no folder, or not a folder", async () => {
    const d = await deps();
    expect(await cmdModCheck(d, [])).toBe(EXIT.USAGE);
    expect(await cmdModCheck(d, ["/nonexistent/collie-mod"])).toBe(EXIT.USAGE);
  });

  test("a refused manifest is 1 with each refusal printed; a later field alone is 0 with a note", async () => {
    const d = await deps();
    const bad = await folder('id = "bad"\nname = "Bad"\nrun = "./p.sh"\nplaces = ["nowhere"]\ncolour = "red"\n', { "p.sh": "#!/bin/sh\n" });
    expect(await cmdModCheck(d, [bad])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("/places/0");
    expect(d.err.join("\n")).toContain("/colour");
    const later = await folder('id = "later"\nname = "Later"\nrun = "./p.sh"\nwatch = ["~/x.log"]\nplaces = ["belt"]\n', { "p.sh": "#!/bin/sh\necho '{}'\n" });
    const e = await deps();
    expect(await cmdModCheck(e, [later])).toBe(EXIT.OK);
    expect(e.out.join("\n")).toContain("note: mod.toml /watch");
  });

  test("runs: lists the command lines of the provider; a missing or binary provider is refused", async () => {
    const dir = await folder('id = "gh"\nname = "GH"\nrun = "./gh.sh"\nplaces = ["belt"]\n', {
      "gh.sh": "#!/bin/sh\n# lists my PRs\nprs=$(gh pr list --json number)\ncurl -s https://example.com\necho '{}'\n",
    });
    const report = checkStatic(dir, realFiles);
    expect(report.runs.map((r) => `${r.file}:${r.line}`)).toEqual(["gh.sh:3", "gh.sh:4"]);
    const missing = await folder('id = "m"\nname = "M"\nrun = "./gone.sh"\nplaces = ["belt"]\n');
    expect(checkStatic(missing, realFiles).problems).toEqual(["The run line names ./gone.sh, which is not in the folder."]);
    const binary = await folder('id = "b"\nname = "B"\nrun = "./b.sh"\nplaces = ["belt"]\n', { "b.sh": "\u007fELF\u0002\u0001\u0000\u0000" });
    const d = await deps();
    expect(await cmdModCheck(d, [binary])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("compiled program");
    expect(looksBinary("#!/bin/sh\n")).toBe(false);
    expect(runsLines([{ file: "p.ts", text: 'const r = Bun.spawn(["darius", "due"]);\n// gh comment\nconst x = 1;\n' }]).map((r) => r.line)).toEqual([1]);
  });

  test("--run runs the provider with the env scrub: no COLLIE_ variable, no key", async () => {
    const dir = await folder('id = "env"\nname = "Env"\nrun = "bun provider.ts"\nplaces = ["belt"]\n', {
      "provider.ts": [
        'const leaked = Object.keys(process.env).filter((k) => k.startsWith("COLLIE_") || k.includes("KEY"));',
        "const facts = JSON.parse(await Bun.stdin.text());",
        'if (leaked.length > 0 || facts.mod.id !== "env") process.exit(7);',
        'console.log(JSON.stringify({ v: 1, parts: [{ at: "belt", id: "belt", mark: { face: "ok" } }] }));',
      ].join("\n"),
    });
    const d = await deps();
    expect(await cmdModCheck(d, ["--run", "--json", dir])).toBe(EXIT.OK);
    // SAFETY: `--json` prints exactly one ModCheckReport, and the fields read below are checked by value.
    const report = JSON.parse(d.out.join("\n")) as ModCheckReport;
    expect(report.run?.outcome).toBe("exited");
    expect(report.run?.problem).toBeNull();
    expect(report.run?.parts).toEqual(["belt belt"]);
  });

  test("--run prints the refusals of the output, masked stderr of a failure, and exits 1", async () => {
    const d = await deps();
    const refused = await folder('id = "r"\nname = "R"\nrun = "./p.sh"\nplaces = ["belt"]\n', {
      "p.sh": `#!/bin/sh\necho '{"v":1,"parts":[{"at":"belt","id":"belt","mark":{"face":"far too long a face"}}]}'\n`,
    });
    expect(await cmdModCheck(d, ["--run", refused])).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("error: output /parts/0/mark/face");
    const e = await deps();
    const failing = await folder('id = "f"\nname = "F"\nrun = "./p.sh"\nplaces = ["belt"]\n', {
      "p.sh": `#!/bin/sh\necho "darius: not found ${KEY}" >&2\nexit 127\n`,
    });
    expect(await cmdModCheck(e, ["--run", failing])).toBe(EXIT.FAIL);
    const printed = e.err.join("\n");
    expect(printed).toContain("darius: not found");
    expect(printed).not.toContain(KEY);
  });
});

describe("collie mod on, off and list", () => {
  test("on writes the switch file at 0600, off removes the id; unknown or refused mods stay off", async () => {
    const d = await deps();
    await cmdModInit(d, ["legs"]);
    expect(await cmdModSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    const path = switchesPath(d.stateDir);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 1, on: { legs: "2026-11-08T09:00:00.000Z" } });
    expect(await cmdModSwitch(d, ["legs"], true)).toBe(EXIT.OK);
    expect(d.out.at(-1)).toBe("legs is already on.");
    expect(await cmdModSwitch(d, ["legs"], false)).toBe(EXIT.OK);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 1, on: {} });
    expect(await cmdModSwitch(d, ["ghost"], true)).toBe(EXIT.FAIL);
    await mkdir(join(d.configDir, "mods", "broken"));
    await writeFile(join(d.configDir, "mods", "broken", "mod.toml"), 'id = "broken"\n');
    expect(await cmdModSwitch(d, ["broken"], true)).toBe(EXIT.FAIL);
    expect(d.err.join("\n")).toContain("stays off");
    expect(await cmdModSwitch(d, [], true)).toBe(EXIT.USAGE);
  });

  test("list shows the bridge's state, last run and error when it answers", async () => {
    const d = await deps({
      rev: 5,
      mods: [{ host: "bluefin", id: "legs", name: "legs", icon: "plug", on: true, state: "failing", places: ["belt"], error: "The provider exited with 1", lastRunAt: "2026-11-08T09:41:00.000Z" }],
      parts: [],
      present: [],
      path: "/usr/bin",
    });
    await cmdModInit(d, ["legs"]);
    await cmdModSwitch(d, ["legs"], true);
    d.out.length = 0;
    expect(await cmdModList(d, [])).toBe(EXIT.OK);
    expect(d.out[0]).toMatch(/^ID\s+NAME\s+SWITCH\s+STATE\s+LAST RUN\s+LAST ERROR$/);
    expect(d.out[1]).toMatch(/^legs\s+legs\s+on\s+failing\s+2026-11-08T09:41:00.000Z\s+The provider exited with 1$/);
    expect(d.asked[0]).toBe("http://127.0.0.1:18999/api/mods");
  });

  test("list without a bridge says so, and with no folder points at init", async () => {
    const d = await deps(null);
    expect(await cmdModList(d, [])).toBe(EXIT.OK);
    expect(d.out[0]).toStartWith("No mods in");
    expect(d.asked).toEqual([]);
    await cmdModInit(d, ["legs"]);
    d.out.length = 0;
    await cmdModList(d, ["--json"]);
    // SAFETY: `list --json` prints one document with `bridge` and `mods`, checked by value below.
    const doc = JSON.parse(d.out.join("\n")) as { bridge: boolean; mods: { state: string }[] };
    expect(doc.bridge).toBe(false);
    expect(doc.mods[0]?.state).toBe("off");
  });

  test("a bare or unknown subcommand is usage", async () => {
    const c = capture();
    expect(cmdMod({ io: c.io }, [])).toBe(EXIT.USAGE);
    expect(cmdMod({ io: c.io }, ["add"])).toBe(EXIT.USAGE);
    expect(c.err.join("\n")).toContain('unknown mod subcommand "add"');
  });
});

describe("the doctor's mods row", () => {
  test("no mods folder, no row", async () => {
    expect(await modsFindings(await deps())).toEqual([]);
  });

  test("one row with each mod, its state and error, and the runner's PATH; warn when an on mod fails", async () => {
    const d = await deps({
      rev: 5,
      mods: [{ host: "bluefin", id: "legs", name: "legs", icon: "plug", on: true, state: "stopped", places: ["belt"], error: "darius: not found" }],
      parts: [],
      present: [],
      path: "/unit/bin:/usr/bin",
    });
    await cmdModInit(d, ["legs"]);
    await cmdModInit(d, ["quiet"]);
    await cmdModSwitch(d, ["legs"], true);
    const rows = await modsFindings(d);
    expect(rows.length).toBe(1);
    expect(rows[0]?.check).toBe("mods");
    expect(rows[0]?.status).toBe("warn");
    expect(rows[0]?.detail).toContain("2 mods in");
    expect(rows[0]?.detail).toContain("1 on");
    expect(rows[0]?.detail).toContain("legs on, stopped: darius: not found");
    expect(rows[0]?.detail).toContain("quiet off, off");
    expect(rows[0]?.detail).toContain("PATH /unit/bin:/usr/bin");
    expect(rows[0]?.remedy).toContain("collie mod check --run");
  });

  test("without a bridge the PATH is the shell's, said so", async () => {
    const d = await deps(null);
    await cmdModInit(d, ["legs"]);
    const rows = await modsFindings(d);
    expect(rows[0]?.status).toBe("ok");
    expect(rows[0]?.detail).toContain("(as this shell sees it; the service has its own)");
  });
});
