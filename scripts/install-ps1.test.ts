import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostFor } from "../bridge/host.ts";
import { binaryLayout, classifyInstall, probeInstall, publishedBinary } from "../cli/install-kind.ts";
import { realLinkFs } from "../cli/link.ts";
import { realExec, realFiles } from "../cli/sys.ts";
import { currentVersionDir } from "../cli/update.ts";

// The Windows installer, scripts/install.ps1 (M43 spec 07).
//
// Two halves. The first reads the script as TEXT, so it runs on every host, Linux CI included: the
// promises in the header, plain ASCII (Windows PowerShell 5.1 reads a file with no byte-order mark as
// the ANSI code page, so one non-ASCII byte would change what it runs), and the one entry call as the
// last line, so a download of `irm | iex` that stops half way runs nothing. The second half runs the
// script in Windows PowerShell 5.1 against a release mirror served from this process, and only runs
// on Windows.

const SCRIPT = join(import.meta.dir, "install.ps1");
const TEXT = readFileSync(SCRIPT, "utf8");
const LINES = TEXT.split(/\r?\n/);
/** The comment block at the top: everything before the first line that is not a comment. */
const HEADER = LINES.slice(0, LINES.findIndex((l) => l.trim() !== "" && !l.startsWith("#"))).join("\n");
/** The lines that are code, not comments. */
const CODE = LINES.filter((l) => !l.trimStart().startsWith("#"));
/** The code lines with every double-quoted string blanked, so a printed hint such as Herdr's own
 *  `irm ... | iex` is not read as a call. A backtick escapes a quote in PowerShell. */
const BARE = CODE.map((l) => l.replace(/"(?:[^"`]|`.)*"/g, '""'));
const offending = (pattern: RegExp): string[] => BARE.filter((l) => pattern.test(l));
const ENTRY = "Install-Collie $args";

describe("scripts/install.ps1, read as text", () => {
  test("the header states what it will never do, as install.sh does", () => {
    expect(HEADER).toMatch(/never asks for admin rights/);
    expect(HEADER).toMatch(/never writes outside COLLIE_DIR, except one entry in your user PATH/);
    expect(HEADER).toMatch(/never starts a service or a task\. It runs one program once: the new collie\.exe/);
    expect(HEADER).toMatch(/never sends anything anywhere/);
    expect(HEADER).toMatch(/never installs a download whose sha256 does not match/);
    expect(HEADER).toMatch(/ends by PRINTING the next steps/);
    expect(HEADER).toContain("irm https://colliepwa.dev/install.ps1 | iex");
  });

  test("the same three steering variables as install.sh, and the two test switches, are named", () => {
    for (const name of ["COLLIE_DIR", "COLLIE_UPDATE_REPO", "COLLIE_TAG", "COLLIE_NO_PATH_EDIT", "COLLIE_INSTALL_MIRROR"]) {
      expect(HEADER).toContain(name);
    }
    const sh = readFileSync(join(import.meta.dir, "install.sh"), "utf8");
    for (const name of ["COLLIE_DIR", "COLLIE_UPDATE_REPO", "COLLIE_TAG"]) expect(sh).toContain(name);
  });

  test("is plain ASCII, with no byte-order mark and no dash a reader cannot type", () => {
    const bytes = readFileSync(SCRIPT);
    expect(bytes[0]).not.toBe(0xef);
    const wide = [...bytes].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d));
    expect(wide).toBe(-1);
  });

  test("ends with the one entry call, and every other top-level line is a function", () => {
    const lastLine = LINES.findLast((l) => l.trim() !== "");
    expect(lastLine).toBe(ENTRY);
    const topLevel = CODE.filter((l) => l !== "" && !l.startsWith(" ") && !l.startsWith("\t"));
    const strays = topLevel.filter((l) => !/^function [A-Za-z-]+( *\(.*\))? *\{$/.test(l) && l !== "}" && l !== ENTRY);
    expect(strays).toEqual([]);
    expect(TEXT.split(ENTRY).length - 1).toBe(1);
  });

  test("calls exit only when it runs as a file, never under `irm | iex`, where it would close the terminal", () => {
    // The one `exit` sits behind the $PSCommandPath check, which is empty under `iex`.
    expect(offending(/\bexit\b/i)).toEqual([
      `  if ($global:LASTEXITCODE -ne 0 -and "" -ne '') { exit $global:LASTEXITCODE }`,
    ]);
    expect(CODE.filter((l) => /\{ exit /.test(l))).toEqual([
      `  if ($global:LASTEXITCODE -ne 0 -and "$PSCommandPath" -ne '') { exit $global:LASTEXITCODE }`,
    ]);
    expect(TEXT).toContain("$global:LASTEXITCODE = 1");
  });

  test("puts back the TLS setting it changes, and refuses Constrained Language Mode first", () => {
    expect(TEXT).toMatch(/finally \{\s*\[Net\.ServicePointManager\]::SecurityProtocol = \$tls\s*\}/);
    const entry = TEXT.slice(TEXT.indexOf("function Invoke-CollieEntry("));
    expect(entry.indexOf("LanguageMode")).toBeLessThan(entry.indexOf("ServicePointManager"));
  });

  test("every regex is case-sensitive and anchored with \\A and \\z, never ^ and $", () => {
    // `-match` ignores case, and `$` lets a trailing newline through.
    expect(offending(/-(not)?match\b|-imatch|-inotmatch/)).toEqual([]);
    const patterns = CODE.join("\n").match(/-c(not)?match '[^']*'/g) ?? [];
    expect(patterns.length).toBeGreaterThan(5);
    for (const p of patterns) {
      expect(p).toContain("'\\A");
      expect(p).not.toMatch(/'\^|\$'/);
    }
  });

  test("every web call works in Windows PowerShell 5.1: basic parsing, TLS 1.2, no progress bar", () => {
    const calls = BARE.filter((l) => /Invoke-WebRequest|Invoke-RestMethod|\birm\b/.test(l));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("-UseBasicParsing");
    expect(TEXT).toContain("[Net.SecurityProtocolType]::Tls12");
    expect(TEXT).toContain('$ProgressPreference = "SilentlyContinue"');
  });

  test("runs nothing it downloads, starts nothing, and asks for no admin", () => {
    expect(offending(/Invoke-Expression|\biex\b/)).toEqual([]);
    expect(offending(/Start-Process|Start-ScheduledTask|Register-ScheduledTask|schtasks|Start-Service|New-Service/i)).toEqual([]);
    // The one program it runs: `collie.exe version`, through cmd.exe, from one function.
    expect(offending(/Diagnostics\.Process\]::Start/)).toHaveLength(1);
    expect(TEXT).toContain('version < NUL > ');
    expect(offending(/RunAs|HKLM|LocalMachine|SymbolicLink/i)).toEqual([]);
    // "Machine" is a string, so it is looked for in the code with its strings left in.
    expect(CODE.filter((l) => /"Machine"|'Machine'/.test(l))).toEqual([]);
    // No line calls a program with `&`, so no line runs the collie.exe it laid down.
    expect(offending(/(^|[\s(;])&\s/)).toEqual([]);
  });

  test("a junction is removed by itself, never through a recursive delete", () => {
    // `Remove-Item -Recurse` walks into a junction in Windows PowerShell 5.1. None is left.
    expect(offending(/-Recurse/)).toEqual([]);
    const deletes = CODE.filter((l) => l.includes("Directory]::Delete("));
    expect(deletes.length).toBeGreaterThan(0);
    for (const line of deletes) expect(line).toContain(", $false)");
  });

  test("the token goes with the tags call alone, never with a download", () => {
    expect(offending(/Authorization/)).toHaveLength(1);
    expect(offending(/Authorization/)[0]).toContain("$mirror -eq ''");
    const withHeaders = CODE.filter((l) => /-Headers/.test(l));
    expect(withHeaders).toHaveLength(1);
    expect(withHeaders[0]).toContain("/tags?per_page=100");
  });

  test("unpacks with its own checked loop, never with Expand-Archive alone", () => {
    expect(offending(/Expand-Archive/)).toEqual([]);
    expect(TEXT).toContain("[System.IO.Compression.ZipFile]::OpenRead($Zip)");
    expect(offending(/Add-Type(?! -AssemblyName)/)).toEqual([]);
  });

  test("never says 'verified': the checksum comes from the same place as the zip", () => {
    expect(CODE.filter((l) => /\bverified\b/i.test(l))).toEqual([]);
    expect(TEXT).toContain("matches the checksum published with the release");
  });

  test("stops on a missing sidecar and on a digest that does not match", () => {
    expect(TEXT).toContain("so a download could not be checked");
    expect(TEXT).toContain("CHECKSUM MISMATCH");
    expect(TEXT).toContain("[StringComparison]::OrdinalIgnoreCase");
  });
});

// ── On Windows: the script itself, against a release mirror served from this process ─────────────
//
// Every case runs Windows PowerShell 5.1 (`powershell.exe`, the one every Windows 11 has) on the
// script with `-File`, steered by COLLIE_INSTALL_MIRROR at a Bun.serve on 127.0.0.1. Nothing here
// reaches github.com. Every case sets COLLIE_NO_PATH_EDIT=1, so no test writes the real user PATH;
// the PATH logic is tested through its pure function, and the real registry round trip is checked on
// the Windows VM by hand (M43 spec 07). The child writes to a log FILE, never to a pipe: a child left
// behind could hold a pipe open and hang the run.
//
// The profile folders (USERPROFILE, LOCALAPPDATA, APPDATA, TEMP) point into the scratch root too, so
// "it never writes outside COLLIE_DIR" is an assertion about the disk.

const IS_WINDOWS = process.platform === "win32";
const SYSTEM_ROOT = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
const POWERSHELL = join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
/** Windows' own bsdtar, which writes a zip. A GNU tar from Git, often first on PATH, cannot. */
const TAR = join(SYSTEM_ROOT, "System32", "tar.exe");
const REPO = "AltanS/collie";
const PLATFORM = "windows-x64";
/** PowerShell's own caches. Windows PowerShell writes them when it loads a module (Expand-Archive). */
const POWERSHELL_CACHE = /[\\/]Microsoft[\\/]Windows[\\/]PowerShell[\\/]/i;

interface Asset {
  zip: Uint8Array<ArrayBuffer>;
  digest: string;
}

/** A release mirror: the tags API and the download path, both as GitHub spells them. */
class Mirror {
  readonly requests: string[] = [];
  /** Every Authorization header the mirror was sent. A token must never reach it. */
  readonly authorizations: string[] = [];
  /** The tags API's status, so a case can be rate-limited. */
  tagsStatus = 200;
  readonly files = new Map<string, Uint8Array<ArrayBuffer> | string>();
  tags: string[] = [];
  private server: ReturnType<typeof Bun.serve> | null = null;

  get url(): string {
    if (this.server === null) throw new Error("the mirror is not running");
    return `http://127.0.0.1:${this.server.port}`;
  }

  start(): void {
    this.server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) => {
        const path = new URL(req.url).pathname;
        this.requests.push(path);
        const auth = req.headers.get("authorization");
        if (auth !== null) this.authorizations.push(auth);
        if (/^\/repos\/[^/]+\/[^/]+\/tags$/.test(path)) {
          if (this.tagsStatus !== 200) return new Response("rate limited", { status: this.tagsStatus });
          return new Response(JSON.stringify(this.tags.map((name) => ({ name, commit: { sha: `sha-${name}` } }))), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        // Any owner/name, so a case can steer COLLIE_UPDATE_REPO at it too.
        const download = /^\/[^/]+\/[^/]+\/releases\/download\/(.+)$/.exec(path);
        const body = download?.[1] === undefined ? undefined : this.files.get(download[1]);
        if (body === undefined) return new Response("Not Found", { status: 404 });
        return new Response(body, { headers: { "content-type": "application/octet-stream" } });
      },
    });
  }

  stop(): void {
    this.server?.stop(true);
    this.server = null;
  }

  /** Serve `file` under `tag`. */
  put(tag: string, file: string, body: Uint8Array<ArrayBuffer> | string): void {
    this.files.set(`${tag}/${file}`, body);
  }

  drop(tag: string, file: string): void {
    this.files.delete(`${tag}/${file}`);
  }
}

const sha256 = (bytes: Uint8Array): string => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A zip shaped like the real one: one folder `collie-<v>-windows-x64` with `bin\collie.exe` in it. */
function buildZip(scratch: string, version: string, stub = false): Asset {
  const root = `collie-${version}-${PLATFORM}`;
  const stage = join(scratch, `stage-${version}`);
  mkdirSync(join(stage, root, "bin"), { recursive: true });
  mkdirSync(join(stage, root, "web", "dist"), { recursive: true });
  mkdirSync(join(stage, root, "docs"), { recursive: true });
  // A real program, because the installer runs `collie.exe version` once: a copy of cmd.exe, which
  // starts, reads NUL as its input, and exits 0. `stub` swaps in a text file Windows will not run.
  if (stub) writeFileSync(join(stage, root, "bin", "collie.exe"), `stub collie ${version}\n`);
  else copyFileSync(join(SYSTEM_ROOT, "System32", "cmd.exe"), join(stage, root, "bin", "collie.exe"));
  writeFileSync(join(stage, root, "web", "dist", "index.html"), "<html></html>\n");
  writeFileSync(join(stage, root, "herdr-plugin.toml"), `version = "${version}"\n`);
  writeFileSync(join(stage, root, "package.json"), `{"version":"${version}"}\n`);
  writeFileSync(join(stage, root, "docs", "security.md"), "# security\n");
  const out = join(scratch, `${root}.zip`);
  const tar = Bun.spawnSync([TAR, "-a", "-c", "-f", out, "-C", stage, root], { stdout: "ignore", stderr: "pipe" });
  if (tar.exitCode !== 0) throw new Error(`could not build the fixture zip: ${tar.stderr.toString()}`);
  const zip = new Uint8Array(readFileSync(out));
  return { zip, digest: sha256(zip) };
}

/** A zip with the real payload's root and one extra entry named `bad`, written by .NET's own
 *  ZipArchive, which (unlike tar.exe) writes any name it is given. */
function hostileZip(scratch: string, version: string, bad: string): Asset {
  const root = `collie-${version}-${PLATFORM}`;
  const out = join(scratch, `hostile-${version}.zip`);
  const names = [`${root}/bin/collie.exe`, `${root}/herdr-plugin.toml`, bad];
  const ps1 = join(scratch, `hostile-${version}.ps1`);
  writeFileSync(
    ps1,
    [
      "Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem",
      `$z = [System.IO.Compression.ZipFile]::Open(${psQuote(out)}, 'Create')`,
      `foreach ($n in @(${names.map(psQuote).join(", ")})) { $w = New-Object System.IO.StreamWriter($z.CreateEntry($n).Open()); $w.Write('x'); $w.Dispose() }`,
      "$z.Dispose()",
    ].join("\r\n"),
  );
  const made = Bun.spawnSync([POWERSHELL, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", ps1], { stdout: "ignore", stderr: "pipe" });
  if (made.exitCode !== 0 || !existsSync(out)) throw new Error(`could not build the hostile zip: ${made.stderr.toString()}`);
  const zip = new Uint8Array(readFileSync(out));
  return { zip, digest: sha256(zip) };
}

function manifest(version: string, digest: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      repo: REPO,
      tag: `v${version}`,
      version,
      artifacts: [
        { name: `collie-${version}-linux-x64.tar.gz`, platform: "linux-x64", sha256: "e".repeat(64), size: 1 },
        { name: `collie-${version}-${PLATFORM}.zip`, platform: PLATFORM, sha256: digest, size: 1, signed: false },
      ],
    },
    null,
    2,
  )}\n`;
}

/** Publish one release on the mirror: the zip, its sidecar and the manifest. */
function publish(mirror: Mirror, asset: Asset, version: string, opts: { sidecar?: string } = {}): void {
  const tag = `v${version}`;
  const name = `collie-${version}-${PLATFORM}.zip`;
  mirror.put(tag, name, asset.zip);
  mirror.put(tag, `${name}.sha256`, opts.sidecar ?? `${asset.digest}  ${name}\n`);
  mirror.put(tag, `collie-${version}.manifest.json`, manifest(version, asset.digest));
}

interface Box {
  root: string;
  dir: string;
  profile: string;
  fakeBin: string;
}

function newBox(scratch: string, name: string): Box {
  const root = join(scratch, name);
  const profile = join(root, "profile");
  for (const sub of ["Local", "Roaming", "Temp"]) mkdirSync(join(profile, sub), { recursive: true });
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  // A `collie` on PATH that leaves a mark when anything runs it. The script must only PRINT `collie start`.
  writeFileSync(join(fakeBin, "collie.cmd"), `@echo off\r\necho ran %* > "${join(root, "collie-ran.txt")}"\r\n`);
  return { root, dir: join(root, "install"), profile, fakeBin };
}

/** The child's environment: this process's, minus everything that could steer the script or reach
 *  the real profile, plus the case's own. `Path` and `PATH` are one name on Windows, so every name
 *  is compared without case. */
function childEnv(box: Box, mirror: Mirror, extra: Readonly<Record<string, string | undefined>>, withHerdr: boolean) {
  const drop = /^(PATH|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|PSMODULEPATH|GH_TOKEN|GITHUB_TOKEN|COLLIE_.*)$/i;
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.test(k)) env[k] = v;
  if (withHerdr) writeFileSync(join(box.fakeBin, "herdr.cmd"), "@echo off\r\n");
  const sys = join(SYSTEM_ROOT, "System32");
  Object.assign(env, {
    PATH: [sys, SYSTEM_ROOT, join(sys, "Wbem"), join(sys, "WindowsPowerShell", "v1.0"), box.fakeBin].join(";"),
    USERPROFILE: box.profile,
    LOCALAPPDATA: join(box.profile, "Local"),
    APPDATA: join(box.profile, "Roaming"),
    TEMP: join(box.profile, "Temp"),
    TMP: join(box.profile, "Temp"),
    COLLIE_DIR: box.dir,
    COLLIE_INSTALL_MIRROR: mirror.url,
    COLLIE_NO_PATH_EDIT: "1",
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

interface Result {
  code: number;
  out: string;
  /** The mirror paths this run asked for. */
  asked: string[];
}

let runs = 0;

/** A PowerShell single-quoted string. */
const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** The last line a run printed that is not blank. */
const lastLine = (out: string): string => out.trimEnd().split(/\r?\n/).at(-1) ?? "";

/** A failed run: the code the script set, and "Install failed." with one fix as the LAST line. */
function expectFailed(r: { code: number; out: string }, code = 1): void {
  expect(r.code).toBe(code);
  expect(lastLine(r.out)).toMatch(/^Install failed\. \S/);
  expect(r.out).not.toMatch(/Next steps|steps are left/);
}

/** Run a PowerShell command line and wait. Output goes to a log file through file handles. */
async function runPowerShell(
  box: Box,
  args: readonly string[],
  env: Record<string, string>,
  shell: string = POWERSHELL,
): Promise<{ code: number; out: string }> {
  const log = join(box.root, `run-${++runs}.log`);
  const fd = openSync(log, "w");
  try {
    const child = spawn(shell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
      cwd: box.root,
      env,
      stdio: ["ignore", fd, fd],
      windowsHide: true,
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (c) => resolve(c ?? -1));
    });
    return { code, out: readFileSync(log, "utf8") };
  } finally {
    closeSync(fd);
  }
}

async function install(
  box: Box,
  mirror: Mirror,
  opts: { env?: Record<string, string | undefined>; args?: readonly string[]; herdr?: boolean } = {},
): Promise<Result> {
  const before = mirror.requests.length;
  // `& script; exit $LASTEXITCODE`: the script ends a failure with `exit` when run as a file, and
  // $LASTEXITCODE carries the code either way. The `-File` cases below check the process exit code.
  const call = [`& ${psQuote(SCRIPT)}`, ...(opts.args ?? [])].join(" ");
  const r = await runPowerShell(box, ["-Command", `${call}; exit $LASTEXITCODE`], childEnv(box, mirror, opts.env ?? {}, opts.herdr ?? false));
  return { ...r, asked: mirror.requests.slice(before) };
}

const norm = (p: string): string => p.replace(/[\\/]+$/, "").toLowerCase();
/** The folder `current` names, through the junction. */
const currentTarget = (box: Box): string => norm(realpathSync(join(box.dir, "current")));
const versionDir = (box: Box, v: string): string => norm(realpathSync(join(box.dir, "versions", v)));

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else out.push(full);
  }
  return out;
}

/** A snapshot of the install folder: names and modification times, `current`'s target included. */
function snapshot(box: Box): string {
  const lines = filesUnder(box.dir)
    .filter((f) => !f.includes(`${join(box.dir, "current")}\\`))
    .map((f) => `${f} ${statSync(f).mtimeMs}`);
  lines.push(`current -> ${currentTarget(box)}`);
  return lines.toSorted().join("\n");
}

describe.skipIf(!IS_WINDOWS)("scripts/install.ps1 on Windows, against a local mirror", () => {
  let scratch = "";
  const mirror = new Mirror();
  const v1 = "0.36.0";
  const v2 = "0.37.0";
  let a1: Asset;
  let a2: Asset;
  let boxes = 0;
  const box = (): Box => newBox(scratch, `case-${++boxes}`);

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "collie-install-ps1-"));
    a1 = buildZip(scratch, v1);
    a2 = buildZip(scratch, v2);
    mirror.start();
    mirror.tags = [`v${v1}`, "v1.0.0-beta.10", "v0.9.0"];
    publish(mirror, a1, v1);
    // The sidecar of v2 is UPPER case: the digest is compared without case.
    publish(mirror, a2, v2, { sidecar: `${a2.digest.toUpperCase()}  collie-${v2}-${PLATFORM}.zip\n` });
  });

  afterAll(() => {
    mirror.stop();
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  test("installs the newest strict release into versions\\<X.Y.Z> under a `current` junction", async () => {
    const b = box();
    const r = await install(b, mirror);
    expect(r.out).toContain(`Collie ${v1} is installed in ${b.dir}`);
    expect(r.code).toBe(0);
    expect(existsSync(join(b.dir, "versions", v1, "bin", "collie.exe"))).toBe(true);
    expect(lstatSync(join(b.dir, "current")).isSymbolicLink()).toBe(true);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(readdirSync(b.dir).toSorted()).toEqual(["current", "versions"]);
    // The tags call, then the zip, its sidecar and the manifest. Nothing else is asked.
    expect(r.asked).toEqual([
      `/repos/${REPO}/tags`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}-${PLATFORM}.zip.sha256`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}-${PLATFORM}.zip`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}.manifest.json`,
    ]);
  }, 60_000);

  test("ends by printing the next steps, and starts nothing", async () => {
    const b = box();
    const r = await install(b, mirror);
    expect(r.code).toBe(0);
    const exe = `${b.dir}\\current\\bin\\collie.exe`;
    const tail = r.out.trimEnd().split(/\r?\n/).slice(-20).join("\n");
    expect(tail).toContain("Next steps. This script does not take them for you:");
    expect(tail).toContain("1. Open a NEW terminal window.");
    expect(tail).toContain("2. Start Herdr in another terminal window, and leave it running.");
    expect(tail).toContain("Get Herdr at https://herdr.dev");
    expect(tail).toContain(`${exe} start`);
    expect(tail).toContain(`${exe} url`);
    expect(tail).toContain("Linking several machines (crew) does not work on Windows yet. Collie on one machine works fine.");
    expect(tail).toContain("collie.exe is unsigned: Windows does not know the publisher of this file.");
    expect(r.out).toContain("COLLIE_NO_PATH_EDIT=1 is set, so your PATH was not changed.");
    // No herdr on this PATH: the PATH check says so, and the install goes on.
    expect(r.out).toContain("Herdr not found on your PATH.");
    // The `collie` on PATH leaves a mark when run. There is none.
    expect(existsSync(join(b.root, "collie-ran.txt"))).toBe(false);
  }, 60_000);

  test("names no Herdr download when herdr is on PATH", async () => {
    const b = box();
    const r = await install(b, mirror, { herdr: true });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Herdr found: ${join(b.fakeBin, "herdr.cmd")}`);
    expect(r.out).not.toContain("Herdr not found");
  }, 60_000);

  test("writes nothing outside COLLIE_DIR, and leaves no scratch folder in it", async () => {
    const b = box();
    const r = await install(b, mirror);
    expect(r.code).toBe(0);
    const outside = filesUnder(b.profile).filter((f) => !POWERSHELL_CACHE.test(f));
    expect(outside).toEqual([]);
    expect(existsSync(join(b.dir, ".staging"))).toBe(false);
    expect(existsSync(join(b.dir, ".current.new"))).toBe(false);
  }, 60_000);

  test("installs into %LOCALAPPDATA%\\collie when COLLIE_DIR is not set", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_DIR: undefined } });
    expect(r.code).toBe(0);
    expect(existsSync(join(b.profile, "Local", "collie", "versions", v1, "bin", "collie.exe"))).toBe(true);
  }, 60_000);

  test("a second run changes nothing, says so, and downloads nothing", async () => {
    const b = box();
    expect((await install(b, mirror)).code).toBe(0);
    const before = snapshot(b);
    const again = await install(b, mirror);
    expect(again.code).toBe(0);
    expect(again.out).toContain(`Collie ${v1} is already installed in ${b.dir}. To update, run: collie update`);
    expect(again.asked).toEqual([]);
    expect(snapshot(b)).toBe(before);
    // The same pinned tag again: still nothing changed, nothing downloaded.
    const pinned = await install(b, mirror, { env: { COLLIE_TAG: `v${v1}` } });
    expect(pinned.code).toBe(0);
    expect(pinned.out).toContain("Nothing was changed, and nothing was downloaded.");
    expect(pinned.out).not.toContain("Laying");
    expect(pinned.asked).toEqual([]);
    expect(snapshot(b)).toBe(before);
  }, 90_000);

  test("COLLIE_TAG lays a newer version down beside the old one and flips `current`, with no tags call", async () => {
    const b = box();
    expect((await install(b, mirror)).code).toBe(0);
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v2}` } });
    expect(r.out).toContain(`Laying v${v2} down beside it`);
    expect(r.code).toBe(0);
    expect(readdirSync(join(b.dir, "versions")).toSorted()).toEqual([v1, v2]);
    expect(currentTarget(b)).toBe(versionDir(b, v2));
    expect(r.asked.some((p) => p.includes("/tags"))).toBe(false);
    expect(existsSync(join(b.dir, ".current.new"))).toBe(false);
    // Back to v1, which is on disk: a junction flip, and nothing is downloaded.
    const back = await install(b, mirror, { env: { COLLIE_TAG: `v${v1}` } });
    expect(back.code).toBe(0);
    expect(back.out).toContain("nothing was downloaded");
    expect(back.asked).toEqual([]);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
  }, 90_000);

  test("a sha256 mismatch stops, installs nothing, and leaves the previous version live", async () => {
    const b = box();
    expect((await install(b, mirror)).code).toBe(0);
    const bad = "0.38.0";
    const good = buildZip(scratch, bad);
    publish(mirror, good, bad);
    // The bytes change after the sidecar and the manifest were written from the real ones.
    const corrupt = new Uint8Array(good.zip);
    const at = corrupt.length - 30;
    corrupt.set([(corrupt[at] ?? 0) ^ 0xff], at);
    mirror.put(`v${bad}`, `collie-${bad}-${PLATFORM}.zip`, corrupt);
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${bad}` } });
    expectFailed(r);
    expect(r.out).toContain(`CHECKSUM MISMATCH for collie-${bad}-${PLATFORM}.zip`);
    expect(r.out).toContain("nothing was installed");
    expect(readdirSync(join(b.dir, "versions"))).toEqual([v1]);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(existsSync(join(b.dir, ".staging"))).toBe(false);
  }, 90_000);

  test("a missing sidecar stops before anything is unpacked, and leaves no folder behind", async () => {
    const b = box();
    const v = "0.39.0";
    publish(mirror, buildZip(scratch, v), v);
    mirror.drop(`v${v}`, `collie-${v}-${PLATFORM}.zip.sha256`);
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v}` } });
    expectFailed(r);
    expect(r.out).toContain("so a download could not be checked");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a manifest that does not name the digest stops the install", async () => {
    const b = box();
    const v = "0.40.0";
    publish(mirror, buildZip(scratch, v), v);
    mirror.put(`v${v}`, `collie-${v}.manifest.json`, manifest(v, "a".repeat(64)));
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v}` } });
    expectFailed(r);
    expect(r.out).toContain("is not the one release");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a release with no Windows zip is a plain refusal", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_TAG: "v0.35.0" } });
    expectFailed(r);
    expect(r.out).toContain(`release v0.35.0 has no collie-0.35.0-${PLATFORM}.zip.sha256 (HTTP 404)`);
    expect(r.out).toContain("Either that release has no Windows build");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a tag the API returns is checked like a typed one: a hostile tag never reaches a path", async () => {
    const b = box();
    const saved = mirror.tags;
    mirror.tags = ["v9.9.9\\..\\..\\x", "v9.9.10\n", "V9.9.11", "v9.9.12/../x", `v${v1}`];
    try {
      const r = await install(b, mirror);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`Collie ${v1} is installed`);
      expect(r.asked.filter((p) => p.includes("v9."))).toEqual([]);
      expect(readdirSync(join(b.dir, "versions"))).toEqual([v1]);
    } finally {
      mirror.tags = saved;
    }
  }, 60_000);

  test("a hostile COLLIE_TAG or COLLIE_UPDATE_REPO stops before any request", async () => {
    for (const env of [
      { COLLIE_TAG: "v1.0.0/../x" },
      { COLLIE_TAG: "v1.0.0-..x" },
      { COLLIE_TAG: "v1.0.0\\..\\x" },
      { COLLIE_UPDATE_REPO: "AltanS/collie/../x" },
      { COLLIE_UPDATE_REPO: "../.." },
      { COLLIE_UPDATE_REPO: "AltanS/.." },
      { COLLIE_UPDATE_REPO: "a b/c" },
    ]) {
      const b = box();
      const r = await install(b, mirror, { env });
      expectFailed(r);
      expect(r.asked).toEqual([]);
      expect(existsSync(b.dir)).toBe(false);
    }
  }, 120_000);

  test("COLLIE_DIR must be a full path on a drive, not a share, not a drive root, with no ';' or '%'", async () => {
    const b = box();
    for (const dir of ["install", "\\\\server\\share\\collie", "C:\\", `${b.root}\\a;b`, `${b.root}\\a%b%`]) {
      const r = await install(b, mirror, { env: { COLLIE_DIR: dir } });
      expectFailed(r);
      expect(r.out).toContain("COLLIE_DIR=");
      expect(r.asked).toEqual([]);
    }
    expect(existsSync(join(b.root, "install"))).toBe(false);
  }, 120_000);

  test("a folder with a space, an '&' and a non-ASCII letter installs", async () => {
    const b = box();
    const dir = join(b.root, "inst a&b \u00fc");
    const r = await install(b, mirror, { env: { COLLIE_DIR: dir } });
    expect(r.out).toContain(`Collie ${v1} is installed in ${dir}`);
    expect(r.code).toBe(0);
    expect(norm(realpathSync(join(dir, "current")))).toBe(norm(realpathSync(join(dir, "versions", v1))));
  }, 60_000);

  test("a repository other than AltanS/collie is named in a loud line", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_UPDATE_REPO: "someone/collie-fork" } });
    expect(r.code).toBe(0);
    expect(r.out).toContain("WARNING: COLLIE_UPDATE_REPO is set. This installs Collie from github.com/someone/collie-fork");
    expect(r.asked[0]).toBe("/repos/someone/collie-fork/tags");
  }, 60_000);

  test("COLLIE_INSTALL_MIRROR takes only file:/// and loopback http, and says loudly that it is set", async () => {
    for (const url of ["https://example.com", "http://10.0.0.1:8080", "http://127.0.0.1.evil.example", "http://user@127.0.0.1", "ftp://127.0.0.1", "\\\\server\\share"]) {
      const b = box();
      const r = await install(b, mirror, { env: { COLLIE_INSTALL_MIRROR: url } });
      expectFailed(r);
      expect(r.out).toContain("It is a test seam");
      expect(r.asked).toEqual([]);
    }
    const ok = await install(box(), mirror);
    expect(ok.out).toContain(`WARNING: COLLIE_INSTALL_MIRROR is set. This is a test seam: everything comes from ${mirror.url}`);
  }, 120_000);

  test("a file:/// mirror folder works the same way", async () => {
    const b = box();
    const root = join(b.root, "mirror-folder");
    mkdirSync(join(root, "repos", ...REPO.split("/")), { recursive: true });
    writeFileSync(join(root, "repos", ...REPO.split("/"), "tags"), JSON.stringify([{ name: `v${v1}` }]));
    const release = join(root, ...REPO.split("/"), "releases", "download", `v${v1}`);
    mkdirSync(release, { recursive: true });
    for (const [key, body] of mirror.files) {
      if (key.startsWith(`v${v1}/`)) writeFileSync(join(release, key.slice(`v${v1}/`.length)), body);
    }
    const url = `file:///${root.replace(/\\/g, "/")}`;
    const r = await install(b, mirror, { env: { COLLIE_INSTALL_MIRROR: url } });
    expect(r.out).toContain(`Collie ${v1} is installed in ${b.dir}`);
    expect(r.code).toBe(0);
    expect(r.asked).toEqual([]);
  }, 60_000);

  test("without a pin, a newest release with no Windows build is skipped for the next older one", async () => {
    const b = box();
    const saved = mirror.tags;
    mirror.tags = ["v0.38.5", "v0.38.4", `v${v1}`, "v0.1.0"];
    try {
      const r = await install(b, mirror);
      expect(r.code).toBe(0);
      expect(r.out).toContain("v0.38.5 has no Windows build. Trying the next older release.");
      expect(r.out).toContain("v0.38.4 has no Windows build. Trying the next older release.");
      expect(r.out).toContain(`Collie ${v1} is installed`);
      expect(r.asked.filter((p) => p.endsWith(".sha256"))).toEqual([
        `/${REPO}/releases/download/v0.38.5/collie-0.38.5-${PLATFORM}.zip.sha256`,
        `/${REPO}/releases/download/v0.38.4/collie-0.38.4-${PLATFORM}.zip.sha256`,
        `/${REPO}/releases/download/v${v1}/collie-${v1}-${PLATFORM}.zip.sha256`,
      ]);
    } finally {
      mirror.tags = saved;
    }
  }, 60_000);

  test("when no recent release has a Windows build, it says so plainly and names the pin", async () => {
    const b = box();
    const saved = mirror.tags;
    mirror.tags = ["v2.0.5", "v2.0.4", "v2.0.3", "v2.0.2", "v2.0.1", `v${v1}`];
    try {
      const r = await install(b, mirror);
      expectFailed(r);
      expect(r.out).toContain("none of the newest 5 releases of AltanS/collie carries a Windows build yet");
      expect(lastLine(r.out)).toContain("COLLIE_TAG");
      expect(r.out).not.toContain("HTTP 404");
      expect(existsSync(b.dir)).toBe(false);
    } finally {
      mirror.tags = saved;
    }
  }, 60_000);

  test("a rate-limited tags API is named as one, with the pin that skips the call", async () => {
    const b = box();
    mirror.tagsStatus = 403;
    try {
      const r = await install(b, mirror);
      expectFailed(r);
      expect(r.out).toContain("rate limit says no (HTTP 403)");
      expect(lastLine(r.out)).toContain("$env:COLLIE_TAG = 'vX.Y.Z'");
    } finally {
      mirror.tagsStatus = 200;
    }
  }, 60_000);

  test("a GitHub token in the environment never reaches a mirror", async () => {
    const before = mirror.authorizations.length;
    const r = await install(box(), mirror, { env: { GH_TOKEN: "ghp_secret", COLLIE_GITHUB_TOKEN: "ghp_secret2" } });
    expect(r.code).toBe(0);
    expect(mirror.authorizations.slice(before)).toEqual([]);
    expect(r.out).not.toContain("ghp_secret");
  }, 60_000);

  test("a zip with an entry that climbs out, or names a drive, is refused before anything is written", async () => {
    let n = 0;
    for (const bad of ["collie-0.42.0-windows-x64/../../evil.txt", "C:/evil.txt", "/evil.txt", "other-root/evil.txt"]) {
      const v = `0.42.${n++}`;
      const asset = hostileZip(scratch, v, bad.replace("0.42.0", v));
      publish(mirror, asset, v);
      const b = box();
      const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v}` } });
      expectFailed(r);
      expect(r.out).toContain("the zip is not safe to unpack");
      expect(existsSync(b.dir)).toBe(false);
      expect(filesUnder(b.root).filter((f) => f.endsWith("evil.txt"))).toEqual([]);
    }
  }, 120_000);

  test("a `.staging` left by a stopped run is emptied, and one that is a junction is removed by itself", async () => {
    const left = box();
    mkdirSync(join(left.dir, ".staging", "install-999", "unpacked"), { recursive: true });
    writeFileSync(join(left.dir, ".staging", "install-999", "unpacked", "junk.txt"), "half\n");
    const r = await install(left, mirror);
    expect(r.code).toBe(0);
    expect(existsSync(join(left.dir, ".staging"))).toBe(false);

    const linked = box();
    const precious = join(linked.root, "precious");
    mkdirSync(precious, { recursive: true });
    writeFileSync(join(precious, "sentinel.txt"), "keep\n");
    mkdirSync(linked.dir, { recursive: true });
    symlinkSync(precious, join(linked.dir, ".staging"), "junction");
    const j = await install(linked, mirror);
    expect(j.code).toBe(0);
    expect(existsSync(join(linked.dir, ".staging"))).toBe(false);
    expect(readdirSync(precious)).toEqual(["sentinel.txt"]);
  }, 90_000);

  test("a real folder named `current` stops a pinned run before any download, and is kept", async () => {
    const b = box();
    expect((await install(b, mirror)).code).toBe(0);
    rmSync(join(b.dir, "current"));
    mkdirSync(join(b.dir, "current"));
    writeFileSync(join(b.dir, "current", "mine.txt"), "mine\n");
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v2}` } });
    expectFailed(r);
    expect(r.out).toContain("is a real folder or file, not a junction");
    expect(r.asked).toEqual([]);
    expect(readdirSync(join(b.dir, "current"))).toEqual(["mine.txt"]);
    expect(readdirSync(join(b.dir, "versions"))).toEqual([v1]);
  }, 90_000);

  test("a half-moved version folder is not an install, and a junction in its place is refused", async () => {
    const b = box();
    expect((await install(b, mirror)).code).toBe(0);
    mkdirSync(join(b.dir, "versions", v2, "web"), { recursive: true });
    const half = await install(b, mirror, { env: { COLLIE_TAG: `v${v2}` } });
    expectFailed(half);
    expect(half.out).toContain("holds no bin\\collie.exe");
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(half.asked).toEqual([]);

    rmSync(join(b.dir, "versions", v2), { recursive: true });
    const elsewhere = join(b.root, "elsewhere");
    mkdirSync(join(elsewhere, "bin"), { recursive: true });
    writeFileSync(join(elsewhere, "bin", "collie.exe"), "not ours\n");
    symlinkSync(elsewhere, join(b.dir, "versions", v2), "junction");
    const linked = await install(b, mirror, { env: { COLLIE_TAG: `v${v2}` } });
    expectFailed(linked);
    expect(linked.out).toContain("is a junction or a link");
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(existsSync(join(elsewhere, "bin", "collie.exe"))).toBe(true);
  }, 90_000);

  test("a collie.exe Windows will not run stops the install with the causes, and no next steps", async () => {
    const v = "0.43.0";
    publish(mirror, buildZip(scratch, v, true), v);
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v}` } });
    expectFailed(r);
    for (const words of ["did not let collie.exe run", "Smart App Control", "Microsoft Defender", "whoever manages this computer", "safe to leave in place", "turning it off is permanent", "More info, then Run anyway"]) {
      expect(r.out).toContain(words);
    }
    expect(lastLine(r.out)).toContain("https://github.com/AltanS/collie/issues");
    expect(r.out).not.toContain("is installed in");
    // The files stay: the install is safe to leave in place.
    expect(existsSync(join(b.dir, "current", "bin", "collie.exe"))).toBe(true);
    expect(existsSync(join(b.dir, ".collie-version-check.txt"))).toBe(false);
  }, 60_000);

  // THE DRIFT CONTRACT. install.ps1 and the CLI describe one layout in two languages. A tree the
  // script lays down is read here by the CLI's own helpers, on the real filesystem, as a binary
  // install would read itself (its process root is versions\<v>: Bun resolves execPath through the
  // junction). install.sh writes no marker file, and neither does install.ps1: `classifyInstall`
  // reads a binary install from the `versions` parent and the `current` link alone.
  test("the tree it lays down is the binary install `collie` reads, path for path", async () => {
    const b = box();
    const r = await install(b, mirror);
    expect(r.code).toBe(0);
    const host = hostFor("win32");
    const root = join(b.dir, "versions", v1);
    const deps = {
      ctx: { home: b.profile },
      exec: realExec(process.env, b.profile),
      files: realFiles,
      link: realLinkFs,
      host,
    };
    expect(classifyInstall(probeInstall(deps, root))).toEqual({ kind: "binary" });
    const layout = binaryLayout(root, host);
    expect(layout.installRoot).toBe(b.dir);
    expect(layout.versionsDir).toBe(join(b.dir, "versions"));
    expect(layout.currentLink).toBe(join(b.dir, "current"));
    expect(layout.version).toBe(v1);
    expect(currentVersionDir({ link: realLinkFs }, layout)).toBe(v1);
    expect(publishedBinary(root, realLinkFs, host)).toBe(join(b.dir, "current", "bin", "collie.exe"));
  }, 60_000);

  test("a COLLIE_TAG of the wrong shape dies before any request", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_TAG: "1.0.0" } });
    expectFailed(r);
    expect(r.out).toContain("is not a release tag");
    expect(r.asked).toEqual([]);
  }, 60_000);

  test("refuses an option, since `irm | iex` cannot pass one", async () => {
    const b = box();
    const r = await install(b, mirror, { args: ["--beta"] });
    expectFailed(r, 2);
    expect(r.out).toContain("install.ps1 takes no options");
    expect(r.asked).toEqual([]);
  }, 60_000);

  test("refuses a folder that holds something else, and leaves a git checkout alone", async () => {
    const other = box();
    mkdirSync(other.dir, { recursive: true });
    writeFileSync(join(other.dir, "notes.txt"), "mine\n");
    const r = await install(other, mirror);
    expectFailed(r);
    expect(r.out).toContain("is not a Collie install");
    expect(readdirSync(other.dir)).toEqual(["notes.txt"]);

    const git = box();
    mkdirSync(join(git.dir, ".git"), { recursive: true });
    const g = await install(git, mirror);
    expect(g.code).toBe(0);
    expect(g.out).toContain(`Collie (a git checkout) is already installed in ${git.dir}. To update, run: collie update`);
    expect(g.asked).toEqual([]);
    const pinned = await install(git, mirror, { env: { COLLIE_TAG: `v${v1}` } });
    expectFailed(pinned);
    expect(pinned.out).toContain(`git -C ${git.dir} checkout v${v1}`);
  }, 90_000);

  test("runs through `irm <url> | iex`, and leaves the session as it found it", async () => {
    const b = box();
    mirror.put("script", "install.ps1", new Uint8Array(readFileSync(SCRIPT)));
    const url = `${mirror.url}/${REPO}/releases/download/script/install.ps1`;
    // What the session had before, against what it has after: preferences, the TLS protocols, and
    // every function whose name does not say Collie.
    const command = [
      "$fn = @(Get-ChildItem function: | Where-Object { $_.Name -notlike '*Collie*' } | ForEach-Object Name)",
      "$eap = $ErrorActionPreference; $pp = $ProgressPreference; $tls = [Net.ServicePointManager]::SecurityProtocol",
      `irm -UseBasicParsing ${url} | iex`,
      "$code = $LASTEXITCODE",
      // A module PowerShell loads on its own (Expand-Archive's) brings its functions; those are not the script's.
      "$new = @(Get-ChildItem function: | Where-Object { $_.Name -notlike '*Collie*' -and -not $_.ModuleName -and $fn -notcontains $_.Name })",
      "'LEAK functions=' + $new.Count + ' eap=' + ($eap -eq $ErrorActionPreference) + ' progress=' + ($pp -eq $ProgressPreference) + ' tls=' + ($tls -eq [Net.ServicePointManager]::SecurityProtocol)",
      "exit $code",
    ].join("; ");
    const r = await runPowerShell(b, ["-Command", command], childEnv(b, mirror, {}, false));
    expect(r.out).toContain(`Collie ${v1} is installed in ${b.dir}`);
    expect(r.code).toBe(0);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(r.out).toContain("LEAK functions=0 eap=True progress=True tls=True");
  }, 60_000);

  test("run with -File, a failure exits 1 and a success exits 0", async () => {
    const v = "0.44.0";
    const good = buildZip(scratch, v);
    publish(mirror, good, v);
    const corrupt = new Uint8Array(good.zip);
    const at = corrupt.length - 30;
    corrupt.set([(corrupt[at] ?? 0) ^ 0xff], at);
    mirror.put(`v${v}`, `collie-${v}-${PLATFORM}.zip`, corrupt);
    const bad = box();
    const failed = await runPowerShell(bad, ["-File", SCRIPT], childEnv(bad, mirror, { COLLIE_TAG: `v${v}` }, false));
    expect(failed.code).toBe(1);
    expect(lastLine(failed.out)).toMatch(/^Install failed\. /);
    expect(failed.out).toContain("CHECKSUM MISMATCH");

    const ok = box();
    const installed = await runPowerShell(ok, ["-File", SCRIPT], childEnv(ok, mirror, {}, false));
    expect(installed.out).toContain(`Collie ${v1} is installed in ${ok.dir}`);
    expect(installed.code).toBe(0);
  }, 90_000);

  test("a failure under `irm | iex` returns to the prompt with $LASTEXITCODE 1, and keeps the window open", async () => {
    const b = box();
    mirror.put("script", "install.ps1", new Uint8Array(readFileSync(SCRIPT)));
    const url = `${mirror.url}/${REPO}/releases/download/script/install.ps1`;
    const r = await runPowerShell(
      b,
      ["-Command", `irm -UseBasicParsing ${url} | iex; 'STILL HERE ' + $LASTEXITCODE; exit $LASTEXITCODE`],
      childEnv(b, mirror, { COLLIE_TAG: "v0.35.0" }, false),
    );
    expect(r.code).toBe(1);
    expect(r.out).toContain("Install failed.");
    expect(lastLine(r.out)).toBe("STILL HERE 1");
  }, 60_000);

  test("a 32-bit PowerShell on 64-bit Windows installs, and is not refused as x86", async () => {
    const b = box();
    const wow = join(SYSTEM_ROOT, "SysWOW64", "WindowsPowerShell", "v1.0", "powershell.exe");
    const r = await runPowerShell(b, ["-Command", `& ${psQuote(SCRIPT)}; exit $LASTEXITCODE`], childEnv(b, mirror, {}, false), wow);
    expect(r.out).toContain(`Collie ${v1} is installed in ${b.dir}`);
    expect(r.code).toBe(0);
  }, 60_000);

  test("refuses Constrained Language Mode with a plain message, before it touches anything", async () => {
    const b = box();
    // The text is read before the mode changes: a .NET call is what the mode forbids.
    const r = await runPowerShell(
      b,
      ["-Command", `$text = [IO.File]::ReadAllText(${psQuote(SCRIPT)}); $ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; Invoke-Expression $text; exit $LASTEXITCODE`],
      childEnv(b, mirror, {}, false),
    );
    expectFailed(r);
    expect(r.out).toContain("ConstrainedLanguage mode");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  // ── The helpers, called one by one ──────────────────────────────────────────────────────────
  // The script's functions are read out of it with PowerShell's own parser and defined in a fresh
  // session, WITHOUT the last line, so nothing installs. A case can then replace one helper to make
  // a step fail, because PowerShell finds a function by name when it is called.

  async function helpers(b: Box, body: string): Promise<{ code: number; out: string }> {
    const file = join(b.root, `helpers-${++runs}.ps1`);
    const prelude = [
      "$ErrorActionPreference = 'Stop'",
      "$parseErrors = $null",
      `$ast = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$null, [ref]$parseErrors)`,
      "if (@($parseErrors).Count -gt 0) { 'PARSE ' + $parseErrors[0]; exit 3 }",
      "foreach ($f in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) { . ([scriptblock]::Create($f.Extent.Text)) }",
      "function Show($v) { if ($null -eq $v) { 'NULL' } else { 'VALUE ' + $v } }",
    ].join("\r\n");
    writeFileSync(file, `${prelude}\r\n${body}\r\n`);
    return runPowerShell(b, ["-File", file], childEnv(b, mirror, {}, false));
  }

  test("the PATH entry is appended once, and the value keeps every byte it had", async () => {
    const b = box();
    const r = await helpers(
      b,
      [
        "$e = 'C:\\Users\\u\\AppData\\Local\\collie\\current\\bin'",
        "Show (Add-CollieUserPathEntry 'C:\\a;%USERPROFILE%\\b' $e)",
        "Show (Add-CollieUserPathEntry 'C:\\a;' $e)",
        "Show (Add-CollieUserPathEntry '' $e)",
        "Show (Add-CollieUserPathEntry 'C:\\a;c:\\users\\U\\appdata\\local\\COLLIE\\current\\bin\\;C:\\b' $e)",
        "$env:SPEC07_HOME = 'C:\\Users\\u\\AppData\\Local'",
        "Show (Add-CollieUserPathEntry 'C:\\a;%SPEC07_HOME%\\collie\\current\\bin' $e)",
        // The line `collie uninstall` prints removes the entry again: the value comes back byte for byte.
        "foreach ($v in @('C:\\a;', 'C:\\a', '%USERPROFILE%\\x;C:\\b;')) { $n = Add-CollieUserPathEntry $v $e; 'ROUNDTRIP ' + (((($n -split ';') | Where-Object { $_.TrimEnd('\\') -ne $e }) -join ';') -ceq $v) }",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/)).toEqual([
      "VALUE C:\\a;%USERPROFILE%\\b;C:\\Users\\u\\AppData\\Local\\collie\\current\\bin",
      "VALUE C:\\a;C:\\Users\\u\\AppData\\Local\\collie\\current\\bin;",
      "VALUE C:\\Users\\u\\AppData\\Local\\collie\\current\\bin",
      "NULL",
      "NULL",
      "ROUNDTRIP True",
      "ROUNDTRIP True",
      "ROUNDTRIP True",
    ]);
  }, 60_000);

  test("this window's PATH gets the entry too, and the steps spell `collie` only when it finds this install", async () => {
    const b = box();
    const bin = join(b.root, "inst", "current", "bin");
    mkdirSync(bin, { recursive: true });
    copyFileSync(join(SYSTEM_ROOT, "System32", "cmd.exe"), join(bin, "collie.exe"));
    const other = join(b.root, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "collie.cmd"), "@echo off\r\n");
    const r = await helpers(
      b,
      [
        // The registry write is replaced: no test edits the real user PATH.
        "function Set-CollieUserPath($Entry) { return $true }",
        "Remove-Item Env:COLLIE_NO_PATH_EDIT",
        `$env:Path = 'C:\\Windows\\System32'`,
        `Publish-CollieName ${psQuote(join(b.root, "inst"))}`,
        "'PATH ' + $env:Path",
        `'NAME ' + (Get-CollieCommandName ${psQuote(join(bin, "collie.exe"))})`,
        `Publish-CollieName ${psQuote(join(b.root, "inst"))} | Out-Null`,
        "'ONCE ' + @($env:Path -split ';' | Where-Object { $_ -like '*current\\bin' }).Count",
        `$env:Path = ${psQuote(other)} + ';' + $env:Path`,
        `'SHADOWED ' + (Get-CollieCommandName ${psQuote(join(bin, "collie.exe"))})`,
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("Added ");
    expect(r.out).toContain(`PATH C:\\Windows\\System32;${bin}`);
    expect(r.out).toContain("NAME collie\r\n");
    expect(r.out).toContain("ONCE 1");
    expect(r.out).toContain(`SHADOWED ${join(bin, "collie.exe")}`);
  }, 60_000);

  test("refuses a machine that is not x64 or is older than build 19041", async () => {
    const b = box();
    const r = await helpers(
      b,
      [
        "Show (Get-CollieHostProblem 'Arm64' 26100)",
        "Show (Get-CollieHostProblem 'X86' 26100)",
        "Show (Get-CollieHostProblem 'AMD64' 18363)",
        "Show (Get-CollieHostProblem 'X64' 22631)",
        "Show (Get-CollieHostProblem 'AMD64' 19041)",
        "Show (Get-CollieHostProblem (Get-CollieArch) ([Environment]::OSVersion.Version.Build))",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    const lines = r.out.trim().split(/\r?\n/);
    expect(lines[0]).toContain("no Windows binary for Arm64");
    expect(lines[1]).toContain("no Windows binary for X86");
    expect(lines[2]).toContain("build 18363");
    expect(lines.slice(3)).toEqual(["NULL", "NULL", "NULL"]);
  }, 60_000);

  test("the digest compares without case, and the newest tag is picked by number", async () => {
    const b = box();
    const d = "ab".repeat(32);
    const r = await helpers(
      b,
      [
        `Show (Get-CollieDigestProblem '${d.toUpperCase()}  x.zip' 'x.zip' '${d}')`,
        `Show (Get-CollieDigestProblem '${d}  x.zip' 'x.zip' '${"cd".repeat(32)}')`,
        `Show (Get-CollieDigestProblem '${d}  y.zip' 'x.zip' '${d}')`,
        "Show (Get-CollieDigestProblem '' 'x.zip' 'aa')",
        `Show (Get-CollieDigestProblem '${d}' 'x.zip' '${d}')`,
        `Show (Get-CollieDigestProblem '${d}  *x.zip' 'x.zip' '${d}')`,
        `Show (Get-CollieDigestProblem '${d}  x.zip extra' 'x.zip' '${d}')`,
        `Show (Get-CollieDigestProblem '${d.slice(1)}  x.zip' 'x.zip' '${d}')`,
        "$r = 'collie-1.0.0-windows-x64'",
        "foreach ($n in @(\"$r/bin/collie.exe\", \"$r/\", \"$r/../x\", \"$r/a/../../x\", 'C:/x', \"$r/a:b\", '/x', '\\x', \"$r\\..\\x\", 'other/x', '')) { Show (Get-CollieEntryProblem $n $r) }",
        "Show ((Sort-CollieTags @('v1.9.0', 'v1.15.0', 'v1.10.0', 'v1.16.0-rc.1', 'v1.2.0', 'nightly')) -join ',')",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    const lines = r.out.trim().split(/\r?\n/);
    expect(lines[0]).toBe("NULL");
    expect(lines[1]).toBe("VALUE CHECKSUM MISMATCH for x.zip");
    expect(lines[2]).toContain("names y.zip");
    expect(lines[3]).toContain("is not one");
    // The name may be left out, a `*` (binary mode) is read through, anything more is refused.
    expect(lines.slice(4, 8).map((l) => l === "NULL")).toEqual([true, true, false, false]);
    // Zip entries: two under the root pass; every other one names its reason.
    expect(lines.slice(8, 10)).toEqual(["NULL", "NULL"]);
    expect(lines.slice(10, 19)).toHaveLength(9);
    for (const line of lines.slice(10, 19)) expect(line).toMatch(/^VALUE /);
    expect(lines[19]).toBe("VALUE v1.15.0,v1.10.0,v1.9.0,v1.2.0");
    expect(lines).toHaveLength(20);
  }, 60_000);

  /** An install folder with two versions and `current` on the first, plus a sentinel file. */
  function twoVersions(b: Box): void {
    for (const v of [v1, v2]) mkdirSync(join(b.dir, "versions", v, "bin"), { recursive: true });
    writeFileSync(join(b.dir, "versions", v1, "bin", "sentinel.txt"), "keep\n");
  }

  test("a flip that fails after the old junction is gone puts the old one back", async () => {
    const b = box();
    twoVersions(b);
    const r = await helpers(
      b,
      [
        `$dir = '${b.dir}'`,
        "New-CollieJunction \"$dir\\current\" \"$dir\\versions\\" + v1 + "\"",
        "function Move-CollieItem($From, $To) { throw 'simulated: the rename was refused' }",
        "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message; 'FIX ' + $_.Exception.Data['CollieFix'] }",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("ERR could not point");
    expect(r.out).toContain("simulated: the rename was refused");
    expect(r.out).toContain("still names");
    expect(r.out).toContain("Nothing was changed.");
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(existsSync(join(b.dir, ".current.new"))).toBe(false);
    expect(existsSync(join(b.dir, "versions", v1, "bin", "sentinel.txt"))).toBe(true);
  }, 60_000);

  test("when putting it back fails too, the exact mklink command is printed", async () => {
    const b = box();
    twoVersions(b);
    const r = await helpers(
      b,
      [
        `$dir = '${b.dir}'`,
        "New-CollieJunction \"$dir\\current\" \"$dir\\versions\\" + v1 + "\"",
        "function Move-CollieItem($From, $To) { throw 'simulated: the rename was refused' }",
        "$real = ${function:New-CollieJunction}",
        "function New-CollieJunction($Path, $Target) { if ($Path.EndsWith('\\current')) { throw 'simulated: no junction' }; & $real $Path $Target }",
        "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message; 'FIX ' + $_.Exception.Data['CollieFix'] }",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("putting it back failed too");
    expect(r.out).toContain(`FIX Make it again by hand:  cmd /c mklink /J "${b.dir}\\current" "${b.dir}\\versions\\${v1}"`);
    expect(existsSync(join(b.dir, "versions", v1, "bin", "sentinel.txt"))).toBe(true);
  }, 60_000);

  test("a real folder named `current` is not Collie's to remove", async () => {
    const b = box();
    twoVersions(b);
    mkdirSync(join(b.dir, "current"));
    writeFileSync(join(b.dir, "current", "mine.txt"), "mine\n");
    const r = await helpers(
      b,
      [`$dir = '${b.dir}'`, "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message; 'FIX ' + $_.Exception.Data['CollieFix'] }"].join(
        "\r\n",
      ),
    );
    expect(r.out).toContain("is a real folder or file, not a junction");
    expect(existsSync(join(b.dir, "current", "mine.txt"))).toBe(true);
  }, 60_000);
});
