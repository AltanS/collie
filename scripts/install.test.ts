import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { platformId } from "../cli/update.ts";

// The curl-piped installer, driven the way scripts/collie-ctl.test.sh drives the shim: every case
// runs against a THROWAWAY $HOME with a scratch PATH holding a fake `curl` that serves a fake
// GitHub release off disk. Nothing here reaches github.com, and nothing touches the real
// ~/.local/bin.
//
// What is pinned is the script's CONTRACT, which survived the change from clone-and-build to
// download-and-verify: refuse an option it does not have, refuse without the tools it needs, never
// clobber an existing install, take the newest STRICT tag unless --beta, VERIFY the download and
// install nothing on a mismatch, lay the payload into `versions/<X.Y.Z>` with a `current` symlink,
// publish the name through `collie link`, and end by printing next steps instead of starting
// anything.

const SCRIPT = join(import.meta.dir, "install.sh");
const VERSION = "0.36.0";
const BETA_VERSION = "1.0.0-beta.10";
const PLATFORM = platformId(process.platform, process.arch) ?? "linux-x64";

interface Run {
  code: number;
  out: string;
  dir: string;
  home: string;
  /** Whether a payload landed — read BEFORE the scratch tree is thrown away, so "nothing was
   *  installed" is an assertion about the run rather than about the cleanup. */
  installed: boolean;
}

/** The externals the script and its fakes genuinely need, symlinked into the scratch PATH one by
 *  one. The whole point of the scratch PATH is that a case can withhold `curl` or `sha256sum` and
 *  have the absence be REAL — appending the system PATH would hand the script the host's own copies
 *  back. */
const SYS_TOOLS = [
  "sh",
  "uname",
  "mkdir",
  "cat",
  "cp",
  "mv",
  "rm",
  "ln",
  "chmod",
  "grep",
  "sed",
  "sort",
  "tail",
  "tr",
  "cut",
  "tar",
  "gzip",
  "sha256sum",
  "shasum",
] as const;

function linkSystemTools(dir: string, without: readonly string[]): void {
  for (const tool of SYS_TOOLS) {
    if (without.includes(tool)) continue;
    for (const base of ["/usr/bin", "/bin"]) {
      if (existsSync(`${base}/${tool}`)) {
        symlinkSync(`${base}/${tool}`, join(dir, tool));
        break;
      }
    }
  }
}

function fakeBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A fake `curl` that serves a directory of files as if it were a GitHub release: the tags API
 * answers with `tags.json`, and every other URL is served by its last path segment. A file that is
 * not there is a 404 — `curl -f` exits 22, which is exactly what the script branches on.
 */
const FAKE_CURL = `
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  *api.github.com*) src="$COLLIE_TEST_RELEASE/tags.json" ;;
  *) src="$COLLIE_TEST_RELEASE/\${url##*/}" ;;
esac
[ -f "$src" ] || exit 22
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
exit 0
`;

const sha256 = (path: string): string =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** One release on disk: a real gzipped tarball, its coreutils-format sidecar, and a manifest whose
 *  digest agrees with both. */
function stageRelease(
  dir: string,
  opts: { version: string; platform?: string; corrupt?: boolean; schemaVersion?: number },
): void {
  const platform = opts.platform ?? PLATFORM;
  const root = `collie-${opts.version}-${platform}`;
  const stage = join(dir, "stage", root);
  mkdirSync(join(stage, "bin"), { recursive: true });
  mkdirSync(join(stage, "web", "dist"), { recursive: true });
  mkdirSync(join(stage, "docs"), { recursive: true });
  writeFileSync(
    join(stage, "bin", "collie"),
    `#!/bin/sh\ncase "$1" in\n  link) echo "linked" ;;\n  version) echo "${opts.version}" ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(stage, "bin", "collie"), 0o755);
  writeFileSync(join(stage, "herdr-plugin.toml"), `version = "${opts.version}"\n`);
  writeFileSync(join(stage, "package.json"), `{"version":"${opts.version}"}\n`);
  writeFileSync(join(stage, ".env.example"), "COLLIE_MUX=herdr\n");
  writeFileSync(join(stage, "web", "dist", "index.html"), "<html></html>\n");
  writeFileSync(join(stage, "docs", "multiplexers.md"), "# multiplexers\n");

  const name = `${root}.tar.gz`;
  const tarball = join(dir, name);
  const tar = Bun.spawnSync(["tar", "-czf", tarball, "-C", join(dir, "stage"), root]);
  if (tar.exitCode !== 0) throw new Error(`could not stage the fixture tarball: ${tar.stderr.toString()}`);
  const digest = sha256(tarball);
  // The sidecar is written from the REAL digest even when the tarball is then corrupted, which is
  // how the mismatch case reaches the verification rather than a torn download.
  writeFileSync(join(dir, `${name}.sha256`), `${digest}  ${name}\n`);
  if (opts.corrupt === true) writeFileSync(tarball, "not a tarball at all\n");
  writeFileSync(
    join(dir, `collie-${opts.version}.manifest.json`),
    `${JSON.stringify(
      {
        schemaVersion: opts.schemaVersion ?? 1,
        repo: "AltanS/collie",
        tag: `v${opts.version}`,
        version: opts.version,
        artifacts: [{ name, platform, sha256: digest, size: 1, payloadRoot: root }],
      },
      null,
      2,
    )}\n`,
  );
}

interface Options {
  args?: readonly string[];
  without?: readonly string[];
  onPath?: boolean;
  /** Seed `$COLLIE_DIR` before the run — the "leave an existing install alone" cases. */
  seed?: (dir: string) => void;
  release?: (dir: string) => void;
}

function run(opts: Options = {}): Run {
  const root = mkdtempSync(join(tmpdir(), "collie-install-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "path-bin");
    const release = join(root, "release");
    const dir = join(home, "collie");
    mkdirSync(bin, { recursive: true });
    mkdirSync(release, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    linkSystemTools(bin, opts.without ?? []);
    if (!(opts.without ?? []).includes("curl")) fakeBin(bin, "curl", FAKE_CURL);
    (opts.release ?? ((d: string) => {
      stageRelease(d, { version: VERSION });
      stageRelease(d, { version: BETA_VERSION });
      writeFileSync(
        join(d, "tags.json"),
        JSON.stringify(
          ["v0.36.0", "v1.0.0-beta.5", "v1.0.0-beta.10"].map((name) => ({
            name,
            commit: { sha: `sha-${name}` },
          })),
        ),
      );
    }))(release);
    opts.seed?.(dir);
    const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...(opts.args ?? [])], {
      cwd: root,
      env: {
        HOME: home,
        PATH: opts.onPath === true ? `${bin}:${join(home, ".local", "bin")}` : bin,
        COLLIE_DIR: dir,
        COLLIE_TEST_RELEASE: release,
      },
    });
    return {
      code: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      dir,
      home,
      installed: existsSync(join(dir, "versions")),
    };
  } finally {
    // The layout cases keep the tree (see `runKeeping`); everything else has already read what it
    // asserts on, so the scratch root goes now.
    rmSync(root, { recursive: true, force: true });
  }
}

/** The layout cases need the tree to still exist, so they run the script themselves and inspect. */
function runKeeping(opts: Options, inspect: (r: Omit<Run, "installed">) => void): void {
  const root = mkdtempSync(join(tmpdir(), "collie-install-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "path-bin");
    const release = join(root, "release");
    const dir = join(home, "collie");
    mkdirSync(bin, { recursive: true });
    mkdirSync(release, { recursive: true });
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    linkSystemTools(bin, opts.without ?? []);
    fakeBin(bin, "curl", FAKE_CURL);
    (opts.release ?? ((d: string) => {
      stageRelease(d, { version: VERSION });
      writeFileSync(join(d, "tags.json"), JSON.stringify([{ name: `v${VERSION}`, commit: { sha: "x" } }]));
    }))(release);
    opts.seed?.(dir);
    const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...(opts.args ?? [])], {
      cwd: root,
      env: { HOME: home, PATH: bin, COLLIE_DIR: dir, COLLIE_TEST_RELEASE: release },
    });
    inspect({
      code: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      dir,
      home,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("scripts/install.sh", () => {
  test("is valid POSIX sh", () => {
    const proc = Bun.spawnSync(["/bin/sh", "-n", SCRIPT]);
    expect(proc.exitCode).toBe(0);
  });

  test("refuses an option it does not have, rather than ignoring it", () => {
    const r = run({ args: ["--nightly"] });
    expect(r.code).toBe(2);
    expect(r.out).toContain("--beta");
  });

  test("stops when curl is missing, and says how to get it", () => {
    const r = run({ without: ["curl"] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("curl is required");
  });

  test("refuses to install unverified: no sha256 tool means no install", () => {
    const r = run({ without: ["sha256sum", "shasum"] });
    expect(r.code).toBe(1);
    expect(r.out).toContain("sha256");
    expect(r.installed).toBe(false);
  });

  test("takes the newest STRICT release by default — a prerelease is never inherited", () => {
    const r = run();
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Collie v${VERSION}`);
    expect(r.out).not.toContain("beta");
  });

  test("--beta is the opt-in, and it takes the newest prerelease by semver, not by string", () => {
    const r = run({ args: ["--beta"] });
    expect(r.code).toBe(0);
    // beta.10 sorts ABOVE beta.5 — the comparison a naive sort gets backwards.
    expect(r.out).toContain(`Collie v${BETA_VERSION}`);
  });

  test("a checksum mismatch installs NOTHING and says so loudly", () => {
    const r = run({
      release: (d) => {
        stageRelease(d, { version: VERSION, corrupt: true });
        writeFileSync(join(d, "tags.json"), JSON.stringify([{ name: `v${VERSION}`, commit: { sha: "x" } }]));
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("CHECKSUM MISMATCH");
    expect(r.installed).toBe(false);
  });

  test("a manifest schema it does not understand stops the install", () => {
    const r = run({
      release: (d) => {
        stageRelease(d, { version: VERSION, schemaVersion: 2 });
        writeFileSync(join(d, "tags.json"), JSON.stringify([{ name: `v${VERSION}`, commit: { sha: "x" } }]));
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("manifest");
    expect(r.installed).toBe(false);
  });

  test("no artifact for this platform is an honest refusal, not a wrong binary", () => {
    const r = run({
      release: (d) => {
        stageRelease(d, { version: VERSION, platform: "solaris-sparc" });
        writeFileSync(join(d, "tags.json"), JSON.stringify([{ name: `v${VERSION}`, commit: { sha: "x" } }]));
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("from source");
    expect(r.installed).toBe(false);
  });

  test("lays the payload into versions/<X.Y.Z> under a relative `current` symlink", () => {
    runKeeping({}, (r) => {
      expect(r.code).toBe(0);
      expect(existsSync(join(r.dir, "versions", VERSION, "bin", "collie"))).toBe(true);
      expect(lstatSync(join(r.dir, "current")).isSymbolicLink()).toBe(true);
      // RELATIVE, so the whole install root stays movable.
      expect(readlinkSync(join(r.dir, "current"))).toBe(`versions/${VERSION}`);
      // Nothing is left behind: the download scratch is a sibling of the install root and is swept.
      expect(existsSync(`${r.dir}.download`)).toBe(false);
    });
  });

  test("publishes the name through `collie link`, never by copying the binary", () => {
    const r = run();
    expect(r.out).toContain("linked");
  });

  test("warns — never fails — when ~/.local/bin is not on PATH", () => {
    expect(run().out).toContain("is not on your PATH");
    expect(run({ onPath: true }).out).not.toContain("is not on your PATH");
  });

  test("ends by printing the next steps, and starts nothing", () => {
    const r = run();
    expect(r.out).toContain("nothing is running yet");
    expect(r.out).toContain("COLLIE_MUX");
    expect(r.out).toContain("collie start");
    expect(r.out).toContain("docs/security.md");
  });

  test("never clobbers an existing Collie install — it names `collie update` and exits clean", () => {
    const r = run({
      seed: (dir) => {
        mkdirSync(join(dir, "versions", "0.35.0"), { recursive: true });
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("collie update");
  });

  test("leaves a git checkout at COLLIE_DIR alone too", () => {
    const r = run({
      seed: (dir) => {
        mkdirSync(join(dir, ".git"), { recursive: true });
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("leaving it alone");
  });

  test("refuses a target directory that holds something else", () => {
    const r = run({
      seed: (dir) => {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "somebody-elses-file"), "x\n");
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("COLLIE_DIR");
  });
});
