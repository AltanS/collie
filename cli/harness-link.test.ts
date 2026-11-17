import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkedHarnesses } from "../bridge/inside/links.ts";
import { CLAUDE_MARKETPLACE, CLAUDE_PLUGIN_ID, claudePartDir, cmdHarnessLink, cmdHarnessStatus, cmdHarnessSync, cmdHarnessUnlink, filePartPath, linkState, PART_MARKER, partOnDisk, type HarnessLinkDeps, type PartTexts, unlinkAll } from "./harness-link.ts";
import { syncLinks } from "./update.ts";
import { claudeModVersion } from "./inside-embed.ts";
import { realExec, realFiles, type Exec } from "./sys.ts";
import { capture, context, fakeExec } from "./fakes.ts";
import { EXIT } from "./io.ts";

// ── `collie harness link <harness>`, `harness unlink <harness>`, `harness status`, `harness sync` (M99 spec 09) ──
//
// Run against a scratch HOME, a scratch CLAUDE_CONFIG_DIR and a fake `claude` on PATH that records its
// arguments and keeps its own little state (which marketplace and plugin it was told to add). The
// real filesystem and the real Exec, so what the verbs write is what lands on disk.

describe("harness verbs for the data path (M99 spec 09)", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // The verbs' logic is the same on every platform, so a test pins `platform: "linux"` through the `deps.platform`
  // seam (the verbs refuse on win32, and "on Windows link refuses" below proves that refusal on every platform).
  // The fake `claude` below is a `#!/bin/bash` script, which Windows cannot run from a PATH lookup, so each test
  // that runs it is `claudeTest`, a skip on win32.
  const claudeTest = test.skipIf(process.platform === "win32");

  /** The fake `claude`: one line per call into `calls.log`, and the answers a real one gives as JSON. */
  const FAKE_CLAUDE = [
    "#!/bin/bash",
    // Builtins only: the PATH holds this folder alone. A state file says yes or no.
    'state="${0%/*}"',
    'printf "%s\\n" "$*" >> "$state/calls.log"',
    'has() { [[ -f "$state/$1" && "$(<"$state/$1")" == yes ]]; }',
    // A test makes one call fail by writing its leading words into `fail`.
    'if [[ -f "$state/fail" && "$*" == "$(<"$state/fail")"* ]]; then echo "it failed" >&2; exit 1; fi',
    'case "$*" in',
    '  "plugin marketplace list --json") if has market; then printf \'[{"name":"collie-inside"}]\\n\'; else printf "[]\\n"; fi ;;',
    '  "plugin marketplace add "*) printf yes > "$state/market" ;;',
    '  "plugin marketplace remove "*) printf no > "$state/market" ;;',
    '  "plugin list --json") if has plugin; then printf \'[{"id":"collie@collie-inside"}]\\n\'; else printf "[]\\n"; fi ;;',
    '  "plugin install "*) has market || { echo "no marketplace" >&2; exit 1; }; printf yes > "$state/plugin" ;;',
    '  "plugin uninstall "*) printf no > "$state/plugin" ;;',
    '  *) echo "unexpected: $*" >&2; exit 9 ;;',
    "esac",
  ].join("\n");

  function lab(options: { readonly claude?: boolean; readonly managed?: string; readonly version?: string; readonly parts?: PartTexts } = {}) {
    const root = mkdtempSync(join(tmpdir(), "collie-link-"));
    scratchDirs.push(root);
    const home = join(root, "home");
    const bin = join(root, "bin");
    const claudeDir = join(root, "claude-config");
    mkdirSync(home, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
    if (options.claude !== false) {
      writeFileSync(join(bin, "claude"), `${FAKE_CLAUDE}\n`, { mode: 0o755 });
    }
    const managed = join(root, "managed-settings.json");
    if (options.managed !== undefined) writeFileSync(managed, options.managed);
    const env = { PATH: bin, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, COLLIE_INSTANCE: "lab", HERDR_PLUGIN_CONFIG_DIR: join(root, "herdr-config") };
    const io = capture();
    const real = realExec(env, home);
    const tools: string[] = [];
    const exec: Exec = {
      ...real,
      capture: (tool, args, ...rest) => {
        tools.push(`${tool} ${args.join(" ")}`);
        return real.capture(tool, args, ...rest);
      },
    };
    const linkDeps: HarnessLinkDeps = {
      ctx: context(env, { home }),
      io,
      files: realFiles,
      exec,
      managedSettings: managed,
      now: () => 1_786_000_000_000,
      version: options.version,
      parts: options.parts,
      platform: "linux",
    };
    const calls = (): string[] => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
    const failNext = (words: string | null): void => {
      if (words === null) rmSync(join(bin, "fail"), { force: true });
      else writeFileSync(join(bin, "fail"), words);
    };
    return { root, home, bin, claudeDir, deps: linkDeps, io, calls, tools, failNext };
  }

  const isLinkedNow = (r: { deps: HarnessLinkDeps }): boolean => linkedHarnesses(r.deps.ctx.env, r.deps.ctx.home, realFiles).includes("claude");

  const PARTS: PartTexts = { pi: "export default function collie() {}\n", omp: "export default function collie() {}\n", opencode: "export const Collie = async () => ({})\n" };

  claudeTest("link claude: writes the mod into the parts folder and registers it at the user scope, then status says linked", () => {
    const r = lab();
    const code = cmdHarnessLink(r.deps, "claude");
    expect(r.io.stderr).toEqual([]);
    expect(code).toBe(EXIT.OK);
    const dir = claudePartDir(r.deps.ctx);
    expect(dir).toBe(join(r.home, ".config", "collie", "inside", "claude"));
    expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "marketplace.json"), "utf8"))).toMatchObject({ name: CLAUDE_MARKETPLACE, plugins: [{ name: "collie", source: "./" }] });
    expect(r.calls()).toEqual([
      "plugin marketplace list --json",
      `plugin marketplace add ${dir} --scope user --json`,
      "plugin list --json",
      `plugin install ${CLAUDE_PLUGIN_ID} --scope user --json`,
    ]);
    expect(r.io.stdout.join("\n")).toContain("linked claude: plugin");
    expect(linkedHarnesses(r.deps.ctx.env, r.home, realFiles)).toEqual(["claude"]);
    const status = capture();
    cmdHarnessStatus({ ...r.deps, io: status });
    expect(status.stdout[0]).toMatch(/^claude: linked, plugin \d+\.\d+\.\d+/u);
    expect(status.stdout.slice(1)).toEqual(["pi: not linked", "omp: not linked", "opencode: not linked"]);
  });

  claudeTest("link claude twice: the second run registers nothing new", () => {
    const r = lab();
    cmdHarnessLink(r.deps, "claude");
    const before = r.calls().length;
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.OK);
    expect(r.calls().slice(before)).toEqual(["plugin marketplace list --json", "plugin list --json"]);
  });

  claudeTest("unlink claude: uninstalls, removes the marketplace and the folder, and status says not linked", () => {
    const r = lab();
    cmdHarnessLink(r.deps, "claude");
    const before = r.calls().length;
    expect(cmdHarnessUnlink(r.deps, "claude")).toBe(EXIT.OK);
    expect(r.calls().slice(before)).toEqual([
      "plugin list --json",
      `plugin uninstall ${CLAUDE_PLUGIN_ID} --scope user --json`,
      "plugin marketplace list --json",
      `plugin marketplace remove ${CLAUDE_MARKETPLACE} --scope user --json`,
    ]);
    expect(existsSync(claudePartDir(r.deps.ctx))).toBe(false);
    expect(linkedHarnesses(r.deps.ctx.env, r.home, realFiles)).toEqual([]);
    expect(linkState(r.deps, "claude")).toEqual({ kind: "not-linked" });
  });

  test("no claude on PATH: link refuses and writes nothing", () => {
    const r = lab({ claude: false });
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.FAIL);
    expect(r.io.stderr.join("\n")).toContain("claude is not on PATH");
    expect(existsSync(join(r.home, ".config"))).toBe(false);
  });

  claudeTest("a managed setting that stops user plugin hooks: linked, with a note, and status says blocked by policy", () => {
    const r = lab({ managed: '{"allowManagedHooksOnly":true}' });
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.OK);
    expect(r.io.stdout.join("\n")).toContain("allowManagedHooksOnly");
    expect(linkState(r.deps, "claude").kind).toBe("blocked");
  });

  test("a folder at the parts path that is not ours is refused untouched", () => {
    const r = lab();
    const dir = claudePartDir(r.deps.ctx);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "notes.txt"), "mine");
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.FAIL);
    expect(readFileSync(join(dir, "notes.txt"), "utf8")).toBe("mine");
    expect(r.calls()).toEqual([]);
  });

  claudeTest("an interrupted first link leaves only our temporary folder, and the next link repairs it", () => {
    const r = lab();
    const dir = claudePartDir(r.deps.ctx);
    // The kill came between the files and the rename: a half folder under our temporary name.
    mkdirSync(join(`${dir}.collie-tmp`, ".claude-plugin"), { recursive: true });
    writeFileSync(join(`${dir}.collie-tmp`, ".claude-plugin", "plugin.json"), "{");
    let renames = 0;
    const broken: HarnessLinkDeps = {
      ...r.deps,
      files: {
        ...realFiles,
        rename: () => {
          renames += 1;
          throw new Error("killed");
        },
      },
    };
    expect(() => cmdHarnessLink(broken, "claude")).toThrow("killed");
    expect(renames).toBe(1);
    expect(existsSync(dir)).toBe(false);
    expect(linkState(r.deps, "claude")).toEqual({ kind: "not-linked" });
    // A rerun: the temporary folder is ours by its name, so it goes, and the part lands whole.
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.OK);
    expect(existsSync(`${dir}.collie-tmp`)).toBe(false);
    expect(partOnDisk(r.deps, "claude")).toBe(claudeModVersion());
    // A relink replaces the folder by rename too, and leaves no old copy behind.
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.OK);
    expect(readdirSync(join(dir, "..")).filter((name) => name.startsWith("claude.collie"))).toEqual([]);
  });

  claudeTest("unlink while `claude plugin list` fails: a warning, exit 1, and the folder is kept; a rerun finishes", () => {
    const r = lab();
    cmdHarnessLink(r.deps, "claude");
    for (const words of ["plugin list", "plugin marketplace list"]) {
      if (words === "plugin marketplace list") cmdHarnessLink(r.deps, "claude");
      r.failNext(words);
      const io = capture();
      expect(cmdHarnessUnlink({ ...r.deps, io }, "claude")).toBe(EXIT.FAIL);
      expect(io.stderr.join("\n")).toContain("the plugin's folder is kept");
      expect(existsSync(claudePartDir(r.deps.ctx))).toBe(true);
      // The record went first: the bridge stops sending by data at once.
      expect(isLinkedNow(r)).toBe(false);
      r.failNext(null);
    }
    expect(cmdHarnessUnlink(r.deps, "claude")).toBe(EXIT.OK);
    expect(existsSync(claudePartDir(r.deps.ctx))).toBe(false);
  });

  test("on Windows link refuses with one plain line and writes nothing", () => {
    const r = lab();
    const io = capture();
    expect(cmdHarnessLink({ ...r.deps, io, platform: "win32" }, "claude")).toBe(EXIT.FAIL);
    expect(io.stderr).toEqual(["error: sending by data is not available on Windows yet. Collie keeps the screen path there."]);
    expect(existsSync(join(r.home, ".config"))).toBe(false);
    expect(r.calls()).toEqual([]);
  });

  test("marker: a file part carries the Collie marker on its first line; unlink removes only a marked file", () => {
    const r = lab({ parts: PARTS });
    expect(cmdHarnessLink(r.deps, "pi")).toBe(EXIT.OK);
    const pi = filePartPath(r.deps.ctx, "pi");
    expect(pi).toBe(join(r.home, ".pi", "agent", "extensions", "collie-inside.ts"));
    expect(readFileSync(pi, "utf8").split("\n")[0]).toMatch(new RegExp(`^${PART_MARKER} pi \\d+\\.\\d+\\.\\d+`, "u"));
    expect(cmdHarnessUnlink(r.deps, "pi")).toBe(EXIT.OK);
    expect(existsSync(pi)).toBe(false);
    // No harness CLI is run for a file part.
    expect(r.tools).toEqual([]);
  });

  test("marker: a file without the marker is somebody else's: link refuses it and unlink leaves it", () => {
    const r = lab({ parts: PARTS });
    const omp = filePartPath(r.deps.ctx, "omp");
    mkdirSync(join(omp, ".."), { recursive: true });
    writeFileSync(omp, "// my own extension\n");
    expect(cmdHarnessLink(r.deps, "omp")).toBe(EXIT.FAIL);
    expect(cmdHarnessUnlink(r.deps, "omp")).toBe(EXIT.OK);
    expect(readFileSync(omp, "utf8")).toBe("// my own extension\n");
  });

  test("marker: opencode's part goes to its plugin folder; a harness with no part in this build is refused", () => {
    const r = lab({ parts: PARTS });
    expect(cmdHarnessLink(r.deps, "opencode")).toBe(EXIT.OK);
    expect(filePartPath(r.deps.ctx, "opencode")).toBe(join(r.home, ".config", "opencode", "plugin", "collie-inside.js"));
    const none = lab();
    expect(cmdHarnessLink(none.deps, "pi")).toBe(EXIT.FAIL);
    expect(none.io.stderr.join("\n")).toContain("no plugin for pi");
  });

  claudeTest("update: harness sync rewrites an older linked part with this build's", () => {
    const old = lab({ version: "1.28.0", parts: PARTS });
    cmdHarnessLink(old.deps, "claude");
    cmdHarnessLink(old.deps, "pi");
    expect(partOnDisk(old.deps, "claude")).not.toBeNull();
    // The same machine, a newer build.
    const io = capture();
    const newer: HarnessLinkDeps = { ...old.deps, io, version: "1.29.0" };
    expect(linkState(newer, "pi")).toMatchObject({ kind: "older", version: "1.28.0" });
    expect(cmdHarnessSync(newer)).toBe(EXIT.OK);
    expect(partOnDisk(newer, "pi")).toBe("1.29.0");
    expect(io.stdout).toContain("harness sync: pi plugin 1.29.0");
    // The Claude mod's version is its manifest's: this build's mod.
    expect(partOnDisk(newer, "claude")).toBe(claudeModVersion());
  });

  test("update: a newer part is never replaced by an older build, by link or by sync", () => {
    const newer = lab({ version: "9.0.0", parts: PARTS });
    cmdHarnessLink(newer.deps, "pi");
    const io = capture();
    const older: HarnessLinkDeps = { ...newer.deps, io, version: "1.29.0" };
    expect(cmdHarnessSync(older)).toBe(EXIT.OK);
    expect(partOnDisk(older, "pi")).toBe("9.0.0");
    expect(io.stdout).toContain("harness sync: pi kept the newer plugin 9.0.0");
    expect(cmdHarnessLink(older, "pi")).toBe(EXIT.OK);
    expect(partOnDisk(older, "pi")).toBe("9.0.0");
  });

  test("update: sync leaves an unlinked harness alone", () => {
    const r = lab({ parts: PARTS });
    expect(cmdHarnessSync(r.deps)).toBe(EXIT.OK);
    expect(existsSync(filePartPath(r.deps.ctx, "pi"))).toBe(false);
    expect(r.io.stdout).toEqual([]);
  });

  claudeTest("touches nothing else: no settings file, no unit, no restart; only `claude plugin` runs", () => {
    const r = lab({ parts: PARTS });
    const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).toSorted() : []);
    const claudeBefore = tree(r.claudeDir);
    cmdHarnessLink(r.deps, "claude");
    cmdHarnessLink(r.deps, "pi");
    cmdHarnessStatus(r.deps);
    cmdHarnessSync(r.deps);
    cmdHarnessUnlink(r.deps, "claude");
    cmdHarnessUnlink(r.deps, "pi");
    // The harness's own config folder is written only by the harness's own CLI (here: the fake, which writes nothing there).
    expect(tree(r.claudeDir)).toEqual(claudeBefore);
    // Nothing under HOME but the parts folder (now empty of parts) and the folders a part goes in.
    const left = tree(r.home).filter((path) => !path.startsWith(join(".config", "collie", "inside")));
    expect(left.filter((path) => path.includes("systemd") || path.endsWith("settings.json") || path.endsWith(".service"))).toEqual([]);
    // The only program the verbs run is `claude plugin ...`: no systemctl, no collie, no herdr.
    expect(r.tools.every((call) => call.startsWith("claude plugin "))).toBe(true);
  });
});

describe("the update and the uninstall take the parts along (M99 spec 09)", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function linkedHome() {
    const root = mkdtempSync(join(tmpdir(), "collie-link-along-"));
    made.push(root);
    const home = join(root, "home");
    const ctx = context({ HOME: home }, { home });
    const io = capture();
    let version = "collie 1.29.0\n";
    const exec = fakeExec({
      answers: [
        ["/opt/collie/bin/collie --version", { perCall: () => ({ stdout: version }) }],
        ["/opt/collie/bin/collie harness sync", { stdout: "harness sync: pi plugin 1.29.0\n" }],
      ],
    });
    const along: HarnessLinkDeps = { ctx, io, files: realFiles, exec, parts: { pi: "x\n", omp: null, opencode: null }, version: "1.29.0", platform: "linux" };
    return { deps: along, io, ran: exec.calls, setVersion: (v: string) => (version = v) };
  }

  test("update: the new binary's `harness sync` runs only when a harness is linked, and only on a build that knows it", () => {
    const r = linkedHome();
    syncLinks(r.deps, "/opt/collie/bin/collie");
    expect(r.ran).toEqual([]);
    cmdHarnessLink(r.deps, "pi");
    syncLinks(r.deps, "/opt/collie/bin/collie");
    expect(r.ran).toEqual(["/opt/collie/bin/collie --version", "/opt/collie/bin/collie harness sync"]);
    expect(r.io.stdout).toContain("harness sync: pi plugin 1.29.0");
    // An older build reads `link` as the PATH name: it is never asked.
    r.ran.length = 0;
    r.setVersion("collie 1.28.3\n");
    syncLinks(r.deps, "/opt/collie/bin/collie");
    expect(r.ran).toEqual(["/opt/collie/bin/collie --version"]);
  });

  test("uninstall: every linked harness is unlinked", () => {
    const r = linkedHome();
    cmdHarnessLink(r.deps, "pi");
    expect(linkedHarnesses(r.deps.ctx.env, r.deps.ctx.home, realFiles)).toEqual(["pi"]);
    unlinkAll(r.deps);
    expect(linkedHarnesses(r.deps.ctx.env, r.deps.ctx.home, realFiles)).toEqual([]);
    expect(existsSync(filePartPath(r.deps.ctx, "pi"))).toBe(false);
    expect(r.io.stdout).toContain("  unlinked pi");
  });
});
