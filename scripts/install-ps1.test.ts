import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  closeSync,
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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
const ENTRY = "Install-Collie $MyInvocation.MyCommand.Path $args";

describe("scripts/install.ps1, read as text", () => {
  test("the header states what it will never do, as install.sh does", () => {
    expect(HEADER).toMatch(/never asks for admin rights/);
    expect(HEADER).toMatch(/never writes outside COLLIE_DIR, except one entry in your user PATH/);
    expect(HEADER).toMatch(/never starts a service, a task or a program/);
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
    expect(offending(/RunAs|HKLM|LocalMachine|SymbolicLink/i)).toEqual([]);
    // "Machine" is a string, so it is looked for in the code with its strings left in.
    expect(CODE.filter((l) => /"Machine"|'Machine'/.test(l))).toEqual([]);
    // No line calls a program with `&`, so no line runs the collie.exe it laid down.
    expect(offending(/(^|[\s(;])&\s/)).toEqual([]);
  });

  test("a junction is removed by itself, never through a recursive delete", () => {
    for (const line of CODE.filter((l) => l.includes("-Recurse"))) {
      expect(line).not.toMatch(/\$current|\$staged|current"/);
    }
    expect(TEXT).toContain("[System.IO.Directory]::Delete($Path, $false)");
  });

  test("stops on a missing sidecar and on a digest that does not match", () => {
    expect(TEXT).toContain("Refusing to install an unverified binary");
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
        if (path === `/repos/${REPO}/tags`) {
          return new Response(JSON.stringify(this.tags.map((name) => ({ name, commit: { sha: `sha-${name}` } }))), {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
        const prefix = `/${REPO}/releases/download/`;
        const body = path.startsWith(prefix) ? this.files.get(path.slice(prefix.length)) : undefined;
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

/** A zip shaped like the real one: one folder `collie-<v>-windows-x64` with `bin\collie.exe` in it.
 *  The exe is a stub: nothing in the installer runs it, and a case below proves that. */
function buildZip(scratch: string, version: string): Asset {
  const root = `collie-${version}-${PLATFORM}`;
  const stage = join(scratch, `stage-${version}`);
  mkdirSync(join(stage, root, "bin"), { recursive: true });
  mkdirSync(join(stage, root, "web", "dist"), { recursive: true });
  mkdirSync(join(stage, root, "docs"), { recursive: true });
  writeFileSync(join(stage, root, "bin", "collie.exe"), `stub collie ${version}\n`);
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

/** Run a PowerShell command line and wait. Output goes to a log file through file handles. */
async function runPowerShell(box: Box, args: readonly string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  const log = join(box.root, `run-${++runs}.log`);
  const fd = openSync(log, "w");
  try {
    const child = spawn(POWERSHELL, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
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
  const r = await runPowerShell(box, ["-File", SCRIPT, ...(opts.args ?? [])], childEnv(box, mirror, opts.env ?? {}, opts.herdr ?? false));
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
    expect(r.out).toContain(`Collie v${v1} is installed at ${b.dir}`);
    expect(r.code).toBe(0);
    expect(existsSync(join(b.dir, "versions", v1, "bin", "collie.exe"))).toBe(true);
    expect(lstatSync(join(b.dir, "current")).isSymbolicLink()).toBe(true);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
    expect(readdirSync(b.dir).toSorted()).toEqual(["current", "versions"]);
    // The tags call, then the zip, its sidecar and the manifest. Nothing else is asked.
    expect(r.asked).toEqual([
      `/repos/${REPO}/tags`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}-${PLATFORM}.zip`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}-${PLATFORM}.zip.sha256`,
      `/${REPO}/releases/download/v${v1}/collie-${v1}.manifest.json`,
    ]);
  }, 60_000);

  test("ends by printing the next steps, and starts nothing", async () => {
    const b = box();
    const r = await install(b, mirror);
    expect(r.code).toBe(0);
    const tail = r.out.trimEnd().split(/\r?\n/).slice(-14).join("\n");
    expect(tail).toContain("1. Open a new terminal");
    expect(tail).toContain("2. Start Herdr");
    expect(tail).toContain(`${b.dir}\\current\\bin\\collie.exe start`);
    expect(tail).toContain(`${b.dir}\\current\\bin\\collie.exe url`);
    expect(tail).toContain("cannot join a crew in this release");
    expect(tail).toContain("Smart App Control");
    expect(r.out).toContain("COLLIE_NO_PATH_EDIT=1 is set, so your PATH was not changed.");
    // No herdr on this PATH: the script says where Herdr comes from, and goes on.
    expect(r.out).toContain("herdr is not on your PATH");
    expect(r.out).toContain("https://herdr.dev");
    // The `collie` on PATH leaves a mark when run. There is none.
    expect(existsSync(join(b.root, "collie-ran.txt"))).toBe(false);
  }, 60_000);

  test("names no Herdr download when herdr is on PATH", async () => {
    const b = box();
    const r = await install(b, mirror, { herdr: true });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("herdr is not on your PATH");
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
    expect(again.out).toContain("Collie is already installed at");
    expect(again.out).toContain("Leaving it alone.");
    expect(again.out).toContain("collie update");
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
    expect(r.code).toBe(1);
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
    expect(r.code).toBe(1);
    expect(r.out).toContain("Refusing to install an unverified binary");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a manifest that does not name the digest stops the install", async () => {
    const b = box();
    const v = "0.40.0";
    publish(mirror, buildZip(scratch, v), v);
    mirror.put(`v${v}`, `collie-${v}.manifest.json`, manifest(v, "a".repeat(64)));
    const r = await install(b, mirror, { env: { COLLIE_TAG: `v${v}` } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not the one release");
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a release with no Windows zip is a plain refusal", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_TAG: "v0.35.0" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`release v0.35.0 has no ${PLATFORM} artifact (HTTP 404)`);
    expect(existsSync(b.dir)).toBe(false);
  }, 60_000);

  test("a COLLIE_TAG of the wrong shape dies before any request", async () => {
    const b = box();
    const r = await install(b, mirror, { env: { COLLIE_TAG: "1.0.0" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not a release tag");
    expect(r.asked).toEqual([]);
  }, 60_000);

  test("refuses an option, since `irm | iex` cannot pass one", async () => {
    const b = box();
    const r = await install(b, mirror, { args: ["--beta"] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("install.ps1 takes no options");
    expect(r.asked).toEqual([]);
  }, 60_000);

  test("refuses a folder that holds something else, and leaves a git checkout alone", async () => {
    const other = box();
    mkdirSync(other.dir, { recursive: true });
    writeFileSync(join(other.dir, "notes.txt"), "mine\n");
    const r = await install(other, mirror);
    expect(r.code).toBe(1);
    expect(r.out).toContain("is not a Collie install");
    expect(readdirSync(other.dir)).toEqual(["notes.txt"]);

    const git = box();
    mkdirSync(join(git.dir, ".git"), { recursive: true });
    const g = await install(git, mirror);
    expect(g.code).toBe(0);
    expect(g.out).toContain("Leaving it alone.");
    expect(g.asked).toEqual([]);
    const pinned = await install(git, mirror, { env: { COLLIE_TAG: `v${v1}` } });
    expect(pinned.code).toBe(1);
    expect(pinned.out).toContain(`git -C ${git.dir} checkout v${v1}`);
  }, 90_000);

  test("runs through `irm <url> | iex`, the documented entry", async () => {
    const b = box();
    mirror.put("script", "install.ps1", new Uint8Array(readFileSync(SCRIPT)));
    const url = `${mirror.url}/${REPO}/releases/download/script/install.ps1`;
    const r = await runPowerShell(b, ["-Command", `irm -UseBasicParsing ${url} | iex`], childEnv(b, mirror, {}, false));
    expect(r.out).toContain(`Collie v${v1} is installed at ${b.dir}`);
    expect(r.code).toBe(0);
    expect(currentTarget(b)).toBe(versionDir(b, v1));
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
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split(/\r?\n/)).toEqual([
      "VALUE C:\\a;%USERPROFILE%\\b;C:\\Users\\u\\AppData\\Local\\collie\\current\\bin",
      "VALUE C:\\a;C:\\Users\\u\\AppData\\Local\\collie\\current\\bin",
      "VALUE C:\\Users\\u\\AppData\\Local\\collie\\current\\bin",
      "NULL",
      "NULL",
    ]);
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
        "Show (Select-CollieNewestTag @('v1.9.0', 'v1.10.0', 'v1.11.0-rc.1', 'v1.2.0', 'nightly'))",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    const lines = r.out.trim().split(/\r?\n/);
    expect(lines[0]).toBe("NULL");
    expect(lines[1]).toBe("VALUE CHECKSUM MISMATCH for x.zip");
    expect(lines[2]).toContain("names y.zip");
    expect(lines[3]).toContain("is not one");
    expect(lines[4]).toBe("VALUE v1.10.0");
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
        "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message }",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("ERR collie install: could not point");
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
        "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message }",
      ].join("\r\n"),
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain("putting it back failed too");
    expect(r.out).toContain(`cmd /c mklink /J "${b.dir}\\current" "${b.dir}\\versions\\${v1}"`);
    expect(existsSync(join(b.dir, "versions", v1, "bin", "sentinel.txt"))).toBe(true);
  }, 60_000);

  test("a real folder named `current` is not Collie's to remove", async () => {
    const b = box();
    twoVersions(b);
    mkdirSync(join(b.dir, "current"));
    writeFileSync(join(b.dir, "current", "mine.txt"), "mine\n");
    const r = await helpers(
      b,
      [`$dir = '${b.dir}'`, "try { Set-CollieCurrent $dir \"$dir\\versions\\" + v2 + "\"; 'NO ERROR' } catch { 'ERR ' + $_.Exception.Message }"].join(
        "\r\n",
      ),
    );
    expect(r.out).toContain("is a real folder or file, not a junction");
    expect(existsSync(join(b.dir, "current", "mine.txt"))).toBe(true);
  }, 60_000);
});
