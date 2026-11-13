import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { linkedHarnesses } from "../bridge/inside/links.ts";
import {
  CLAUDE_MARKETPLACE,
  CLAUDE_PLUGIN_ID,
  claudePartDir,
  cmdHarnessLink,
  cmdHarnessUnlink,
  cmdLinkStatus,
  cmdLinkSync,
  filePartPath,
  linkState,
  PART_MARKER,
  partOnDisk,
  type HarnessLinkDeps,
  type PartTexts,
  unlinkAll,
} from "./harness-link.ts";
import { syncLinks } from "./update.ts";
import { claudeModVersion } from "./inside-embed.ts";
import { realExec, realFiles, type Exec } from "./sys.ts";

import { hostFor } from "../bridge/host.ts";
import { capture, context, fakeExec, fakeFiles, fakeLinkFs, HOME, posixKey, ROOT } from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  classifyLink,
  classifyUnlink,
  cmdLink,
  cmdUnlink,
  isCollieBinaryPath,
  type LinkDeps,
  linkDir,
  linkPath,
  onPath,
  resolveLinkTarget,
} from "./link.ts";
import { collieBinary } from "./unit.ts";

// `collie link` / `collie unlink`. The decisions are pure functions of what is at the destination
// (ADR 0021), so they are pinned directly; the two verbs are then only asserted for what they
// actually DO with a verdict — which write happens, which does not, and what the operator reads.

// Paths the code builds are spelled the way it builds them (`join`), so they hold on Windows too. The
// fake filesystems fold their keys to POSIX, which is why a recorded op is compared through `posixKey`.
const AT = join(HOME, ".local", "bin", "collie");
const DIR = join(HOME, ".local", "bin");
/** This checkout's compiled binary — `bin/collie` on POSIX, `bin/collie.exe` on Windows. */
const BINARY = collieBinary(ROOT);
/** Another instance's checkout — a real collie binary, and not ours. */
const OTHER = "/opt/collie-v1/bin/collie";

const symlink = (target: string) => ({ kind: "symlink", target }) as const;

function deps(
  over: {
    seed?: Record<string, ReturnType<typeof symlink> | { kind: "absent" } | { kind: "other"; what: string }>;
    built?: boolean;
    path?: string;
  } = {},
): LinkDeps & { io: ReturnType<typeof capture>; fs: ReturnType<typeof fakeLinkFs> } {
  const io = capture();
  const fs = fakeLinkFs(over.seed);
  const files = fakeFiles(over.built === false ? {} : { [BINARY]: "#!/bin/collie" });
  return { ctx: context({ PATH: over.path ?? ["/usr/bin", DIR].join(delimiter) }), io, files, fs };
}

describe("the published name", () => {
  test("is ~/.local/bin/collie", () => {
    expect(linkDir(HOME)).toBe(DIR);
    expect(linkPath(HOME)).toBe(AT);
  });

  test("a relative link target resolves against the link's own directory", () => {
    expect(resolveLinkTarget(AT, "../../src/collie/bin/collie")).toBe(resolve(HOME, "src", "collie", "bin", "collie"));
    expect(resolveLinkTarget(AT, BINARY)).toBe(BINARY);
  });

  test("a collie binary is recognised by its shape, on either separator", () => {
    expect(isCollieBinaryPath("/opt/collie/bin/collie")).toBe(true);
    expect(isCollieBinaryPath(OTHER)).toBe(true);
    expect(isCollieBinaryPath("C:\\src\\collie\\bin\\collie")).toBe(true);
    // Near misses: the name alone, a sibling, a different tool.
    expect(isCollieBinaryPath("/usr/local/bin/collie-helper")).toBe(false);
    expect(isCollieBinaryPath("/opt/collie/bin/collie.new")).toBe(false);
    expect(isCollieBinaryPath("/usr/bin/git")).toBe(false);
  });

  test("on win32 the `collie.exe` that Bun's compiler writes is recognised, on either separator", () => {
    expect(isCollieBinaryPath("C:\\Users\\pat\\.collie\\versions\\1.2.3\\bin\\collie.exe", hostFor("win32"))).toBe(true);
    expect(isCollieBinaryPath("C:/src/collie/bin/collie.exe", hostFor("win32"))).toBe(true);
    expect(isCollieBinaryPath("C:\\src\\collie\\bin\\collie", hostFor("win32"))).toBe(true);
    expect(isCollieBinaryPath("C:\\src\\collie\\bin\\collie.exe.bak", hostFor("win32"))).toBe(false);
    // Elsewhere the `.exe` spelling is not a name Collie publishes.
    expect(isCollieBinaryPath("/opt/collie/bin/collie.exe", hostFor("linux"))).toBe(false);
  });

  test("this platform's own binary name is recognised", () => {
    // `collieBinary` spells `collie.exe` on Windows; a link to it is a name Collie published.
    expect(isCollieBinaryPath(collieBinary("/opt/collie-v1"))).toBe(true);
  });
});

describe("classifyLink", () => {
  test("nothing there → create", () => {
    expect(classifyLink({ kind: "absent" }, BINARY)).toEqual({ action: "create" });
  });

  test("already ours → keep, so a second `link` is a no-op", () => {
    expect(classifyLink(symlink(BINARY), BINARY)).toEqual({ action: "keep" });
  });

  test("another checkout's binary → replace, naming what it pointed at", () => {
    expect(classifyLink(symlink(OTHER), BINARY)).toEqual({ action: "replace", previous: OTHER });
  });

  test("a foreign symlink → refuse, naming it", () => {
    const v = classifyLink(symlink("/usr/local/bin/some-tool"), BINARY);
    expect(v.action).toBe("refuse");
    expect(v.action === "refuse" && v.reason).toContain("/usr/local/bin/some-tool");
  });

  test("a regular file or a directory → refuse in the words the probe read", () => {
    expect(classifyLink({ kind: "other", what: "a regular file" }, BINARY)).toEqual({
      action: "refuse",
      reason: "a regular file",
    });
    expect(classifyLink({ kind: "other", what: "a directory" }, BINARY)).toEqual({
      action: "refuse",
      reason: "a directory",
    });
  });
});

describe("classifyUnlink", () => {
  test("ours → remove", () => {
    expect(classifyUnlink(symlink(BINARY), BINARY)).toEqual({ action: "remove" });
  });

  test("nothing there → absent, which is not a failure", () => {
    expect(classifyUnlink({ kind: "absent" }, BINARY)).toEqual({ action: "absent" });
  });

  test("another checkout's link → refuse, and say whose it is", () => {
    const v = classifyUnlink(symlink(OTHER), BINARY);
    expect(v.action).toBe("refuse");
    expect(v.action === "refuse" && v.reason).toContain(OTHER);
    expect(v.action === "refuse" && v.reason).toContain("owns the name");
  });

  test("a name Collie never published → refuse, however it got there", () => {
    expect(classifyUnlink({ kind: "other", what: "a regular file" }, BINARY).action).toBe("refuse");
    expect(classifyUnlink(symlink("/usr/local/bin/some-tool"), BINARY).action).toBe("refuse");
  });
});

describe("onPath", () => {
  test("an exact entry, anywhere in the list", () => {
    expect(onPath(DIR, ["/usr/bin", DIR, "/bin"].join(delimiter))).toBe(true);
    expect(onPath(DIR, DIR)).toBe(true);
  });

  test("a trailing separator on either side still matches", () => {
    expect(onPath(DIR, ["/usr/bin", `${DIR}/`].join(delimiter))).toBe(true);
    expect(onPath(`${DIR}/`, ["/usr/bin", DIR].join(delimiter))).toBe(true);
  });

  test("a prefix is not a match, and neither is an empty or unset PATH", () => {
    expect(onPath(DIR, ["/usr/bin", join(HOME, ".local")].join(delimiter))).toBe(false);
    expect(onPath(DIR, `${DIR}-other`)).toBe(false);
    expect(onPath(DIR, "")).toBe(false);
    expect(onPath(DIR, undefined)).toBe(false);
    // An empty entry means "the current directory" to a shell; it is never our directory.
    expect(onPath(DIR, `${delimiter}${delimiter}`)).toBe(false);
  });
});

describe("collie link", () => {
  test("creates the link, and says it is a pointer rather than a copy", () => {
    const d = deps();
    expect(cmdLink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([`mkdirp ${posixKey(DIR)}`, `symlink ${posixKey(BINARY)} ${posixKey(AT)}`]);
    expect(d.fs.probe(AT)).toEqual({ kind: "symlink", target: BINARY });
    expect(d.io.stdout.join("\n")).toContain(`${AT} → ${BINARY}`);
    expect(d.io.stdout.join("\n")).toContain("not a copy");
  });

  test("refuses to link a checkout that has not been built", () => {
    const d = deps({ built: false });
    expect(cmdLink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stderr.join("\n")).toContain("run the build first");
  });

  test("is idempotent — a second run writes nothing and says so", () => {
    const d = deps({ seed: { [AT]: symlink(BINARY) } });
    expect(cmdLink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("already links");
  });

  test("takes the name over from another checkout, naming what it pointed at", () => {
    const d = deps({ seed: { [AT]: symlink(OTHER) } });
    expect(cmdLink(d)).toBe(EXIT.OK);
    // Remove then create: a symlink cannot be made over an existing name.
    expect(d.fs.ops).toEqual([
      `mkdirp ${posixKey(DIR)}`,
      `rm ${posixKey(AT)}`,
      `symlink ${posixKey(BINARY)} ${posixKey(AT)}`,
    ]);
    expect(d.io.stdout.join("\n")).toContain(OTHER);
    expect(d.io.stdout.join("\n")).toContain("no longer owns the name");
  });

  test("refuses a regular file, a directory and a foreign symlink — and touches none of them", () => {
    for (const there of [
      { kind: "other", what: "a regular file" } as const,
      { kind: "other", what: "a directory" } as const,
      symlink("/usr/local/bin/some-tool"),
    ]) {
      const d = deps({ seed: { [AT]: there } });
      expect(cmdLink(d)).toBe(EXIT.FAIL);
      expect(d.fs.ops).toEqual([]);
      expect(d.fs.probe(AT)).toEqual(there);
      expect(d.io.stderr.join("\n")).toContain("leaving it alone");
    }
  });

  test("warns when the directory is not on PATH — and never edits a profile", () => {
    const d = deps({ path: ["/usr/bin", "/bin"].join(delimiter) });
    expect(cmdLink(d)).toBe(EXIT.OK);
    const out = d.io.stdout.join("\n");
    expect(out).toContain(`${DIR} is not on your PATH`);
    expect(out).toContain("shell profile");
    // The only writes are the link's own.
    expect(d.fs.ops).toEqual([`mkdirp ${posixKey(DIR)}`, `symlink ${posixKey(BINARY)} ${posixKey(AT)}`]);
  });

  test("says nothing about PATH when the directory is already on it", () => {
    const d = deps();
    cmdLink(d);
    expect(d.io.stdout.join("\n")).not.toContain("not on your PATH");
  });

  test("a filesystem that refuses the write is an operational failure, not a crash", () => {
    const d = deps();
    d.fs.readonly.add(AT);
    expect(cmdLink(d)).toBe(EXIT.FAIL);
    expect(d.io.stderr.join("\n")).toContain("could not link");
  });
});

describe("collie unlink", () => {
  test("removes our own link, and says the checkout is untouched", () => {
    const d = deps({ seed: { [AT]: symlink(BINARY) } });
    expect(cmdUnlink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([`rm ${posixKey(AT)}`]);
    expect(d.fs.probe(AT)).toEqual({ kind: "absent" });
    expect(d.io.stdout.join("\n")).toContain(ROOT);
  });

  test("not linked at all is success, not a failure", () => {
    const d = deps();
    expect(cmdUnlink(d)).toBe(EXIT.OK);
    expect(d.fs.ops).toEqual([]);
    expect(d.io.stdout.join("\n")).toContain("not linked");
  });

  test("refuses another checkout's link — that instance owns it", () => {
    const d = deps({ seed: { [AT]: symlink(OTHER) } });
    expect(cmdUnlink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
    expect(d.fs.probe(AT)).toEqual(symlink(OTHER));
    expect(d.io.stderr.join("\n")).toContain(OTHER);
    expect(d.io.stderr.join("\n")).toContain("unlink` from there");
  });

  test("refuses whatever else is at the name, and needs no build to say so", () => {
    const d = deps({ built: false, seed: { [AT]: { kind: "other", what: "a regular file" } } });
    expect(cmdUnlink(d)).toBe(EXIT.FAIL);
    expect(d.fs.ops).toEqual([]);
  });
});

// ── `collie link <harness>`, `collie unlink <harness>`, `collie link status` (M99 spec 09) ──
//
// Run against a scratch HOME, a scratch CLAUDE_CONFIG_DIR and a fake `claude` on PATH that records its
// arguments and keeps its own little state (which marketplace and plugin it was told to add). The
// real filesystem and the real Exec, so what the verbs write is what lands on disk.

describe("link verbs for the data path (M99 spec 09)", () => {
  const scratchDirs: string[] = [];
  afterEach(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /** The fake `claude`: one line per call into `calls.log`, and the answers a real one gives as JSON. */
  const FAKE_CLAUDE = [
    "#!/bin/bash",
    // Builtins only: the PATH holds this folder alone. A state file says yes or no.
    'state="${0%/*}"',
    'printf "%s\\n" "$*" >> "$state/calls.log"',
    'has() { [[ -f "$state/$1" && "$(<"$state/$1")" == yes ]]; }',
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
    };
    const calls = (): string[] => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
    return { root, home, bin, claudeDir, deps: linkDeps, io, calls, tools };
  }

  const PARTS: PartTexts = { pi: "export default function collie() {}\n", omp: "export default function collie() {}\n", opencode: "export const Collie = async () => ({})\n" };

  test("link claude: writes the mod into the parts folder and registers it at the user scope, then status says linked", () => {
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
    expect(r.io.stdout.join("\n")).toContain("linked claude: part");
    expect(linkedHarnesses(r.deps.ctx.env, r.home, realFiles)).toEqual(["claude"]);
    const status = capture();
    cmdLinkStatus({ ...r.deps, io: status });
    expect(status.stdout[0]).toMatch(/^claude: linked, part \d+\.\d+\.\d+/u);
    expect(status.stdout.slice(1)).toEqual(["pi: not linked", "omp: not linked", "opencode: not linked"]);
  });

  test("link claude twice: the second run registers nothing new", () => {
    const r = lab();
    cmdHarnessLink(r.deps, "claude");
    const before = r.calls().length;
    expect(cmdHarnessLink(r.deps, "claude")).toBe(EXIT.OK);
    expect(r.calls().slice(before)).toEqual(["plugin marketplace list --json", "plugin list --json"]);
  });

  test("unlink claude: uninstalls, removes the marketplace and the folder, and status says not linked", () => {
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

  test("a managed setting that stops user plugin hooks: linked, with a note, and status says blocked by policy", () => {
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
    expect(none.io.stderr.join("\n")).toContain("no part for pi yet");
  });

  test("update: link sync rewrites an older linked part with this build's", () => {
    const old = lab({ version: "1.28.0", parts: PARTS });
    cmdHarnessLink(old.deps, "claude");
    cmdHarnessLink(old.deps, "pi");
    expect(partOnDisk(old.deps, "claude")).not.toBeNull();
    // The same machine, a newer build.
    const io = capture();
    const newer: HarnessLinkDeps = { ...old.deps, io, version: "1.29.0" };
    expect(linkState(newer, "pi")).toMatchObject({ kind: "older", version: "1.28.0" });
    expect(cmdLinkSync(newer)).toBe(EXIT.OK);
    expect(partOnDisk(newer, "pi")).toBe("1.29.0");
    expect(io.stdout).toContain("link sync: pi part 1.29.0");
    // The Claude mod's version is its manifest's: this build's mod.
    expect(partOnDisk(newer, "claude")).toBe(claudeModVersion());
  });

  test("update: a newer part is never replaced by an older build, by link or by sync", () => {
    const newer = lab({ version: "9.0.0", parts: PARTS });
    cmdHarnessLink(newer.deps, "pi");
    const io = capture();
    const older: HarnessLinkDeps = { ...newer.deps, io, version: "1.29.0" };
    expect(cmdLinkSync(older)).toBe(EXIT.OK);
    expect(partOnDisk(older, "pi")).toBe("9.0.0");
    expect(io.stdout).toContain("link sync: pi kept the newer part 9.0.0");
    expect(cmdHarnessLink(older, "pi")).toBe(EXIT.OK);
    expect(partOnDisk(older, "pi")).toBe("9.0.0");
  });

  test("update: sync leaves an unlinked harness alone", () => {
    const r = lab({ parts: PARTS });
    expect(cmdLinkSync(r.deps)).toBe(EXIT.OK);
    expect(existsSync(filePartPath(r.deps.ctx, "pi"))).toBe(false);
    expect(r.io.stdout).toEqual([]);
  });

  test("touches nothing else: no settings file, no unit, no restart; only `claude plugin` runs", () => {
    const r = lab({ parts: PARTS });
    const tree = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).toSorted() : []);
    const claudeBefore = tree(r.claudeDir);
    cmdHarnessLink(r.deps, "claude");
    cmdHarnessLink(r.deps, "pi");
    cmdLinkStatus(r.deps);
    cmdLinkSync(r.deps);
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
        ["/opt/collie/bin/collie link sync", { stdout: "link sync: pi part 1.29.0\n" }],
      ],
    });
    const along: HarnessLinkDeps = { ctx, io, files: realFiles, exec, parts: { pi: "x\n", omp: null, opencode: null }, version: "1.29.0" };
    return { deps: along, io, ran: exec.calls, setVersion: (v: string) => (version = v) };
  }

  test("update: the new binary's `link sync` runs only when a harness is linked, and only on a build that knows it", () => {
    const r = linkedHome();
    syncLinks(r.deps, "/opt/collie/bin/collie");
    expect(r.ran).toEqual([]);
    cmdHarnessLink(r.deps, "pi");
    syncLinks(r.deps, "/opt/collie/bin/collie");
    expect(r.ran).toEqual(["/opt/collie/bin/collie --version", "/opt/collie/bin/collie link sync"]);
    expect(r.io.stdout).toContain("link sync: pi part 1.29.0");
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
