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
  statSync,
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
  /** Every URL the fake `curl` was asked for, newest last — read the same way and for the same
   *  reason as `installed`. It is how "a pinned run never asks GitHub anything" is an assertion
   *  about traffic rather than about output. */
  curl: string;
  /** Every header the fake `curl` was handed, one per line. It is how "the token goes with the
   *  tags call and with no download" is an assertion about traffic (#254). */
  headers: string;
  /** The octal mode of the curl config file the token travelled in, when there was one. */
  curlrcMode: string;
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
    const resolved = Bun.which(tool);
    if (resolved) {
      symlinkSync(resolved, join(dir, tool));
      continue;
    }
    // FHS fallback for hosts where the process PATH doesn't cover it (shouldn't normally
    // trigger, since Bun.which() already walks $PATH — this is a last resort for a tool that
    // is genuinely only ever found at a fixed FHS path).
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
 *
 * It also honours the two things the script asks of the tags call specifically: `-w '%{http_code}'`
 * prints the status on stdout, and `$COLLIE_TEST_API_CODE` makes that status anything the case
 * wants — a 403 with an empty body is how GitHub actually answers a rate-limited caller. Every URL
 * is appended to `$COLLIE_TEST_CURL_LOG`, so a case can assert on the requests that were NOT made.
 */
const FAKE_CURL = `
out=""; url=""; w=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -H) if [ -n "\${COLLIE_TEST_HEADER_LOG:-}" ]; then echo "$2" >> "$COLLIE_TEST_HEADER_LOG"; fi; shift 2 ;;
    -K) if [ -n "\${COLLIE_TEST_HEADER_LOG:-}" ]; then sed -n 's/^header = "\\(.*\\)"$/\\1/p' "$2" >> "$COLLIE_TEST_HEADER_LOG"; fi
        if [ -n "\${COLLIE_TEST_CURLRC_COPY:-}" ]; then cp -p "$2" "$COLLIE_TEST_CURLRC_COPY"; fi; shift 2 ;;
    -w) w="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
if [ -n "\${COLLIE_TEST_CURL_LOG:-}" ]; then echo "$url" >> "$COLLIE_TEST_CURL_LOG"; fi
code=200
case "$url" in
  *api.github.com*) src="$COLLIE_TEST_RELEASE/tags.json"; code="\${COLLIE_TEST_API_CODE:-200}" ;;
  *) src="$COLLIE_TEST_RELEASE/\${url##*/}" ;;
esac
if [ "$code" != 200 ]; then
  if [ -n "$out" ]; then : > "$out"; fi
  if [ -n "$w" ]; then printf '%s' "$code"; fi
  exit 0
fi
[ -f "$src" ] || exit 22
if [ -n "$out" ]; then cp "$src" "$out"; else cat "$src"; fi
if [ -n "$w" ]; then printf '%s' "$code"; fi
exit 0
`;

const sha256 = (path: string): string =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** One release on disk: a real gzipped tarball, its coreutils-format sidecar, and a manifest whose
 *  digest agrees with both. */
function stageRelease(
  dir: string,
  opts: { version: string; platform?: string; corrupt?: boolean; schemaVersion?: number; windows?: boolean },
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
        artifacts: [
          // The Windows entry a release carries from M43 spec 06 on, listed FIRST so a reader that
          // took the first entry, or any unknown one, would be caught here.
          ...(opts.windows === true
            ? [
                {
                  name: `collie-${opts.version}-windows-x64.zip`,
                  platform: "windows-x64",
                  sha256: "f".repeat(64),
                  size: 1,
                  payloadRoot: `collie-${opts.version}-windows-x64`,
                  signed: false,
                },
              ]
            : []),
          { name, platform, sha256: digest, size: 1, payloadRoot: root },
        ],
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
  /** Extra environment, which is the whole surface of `COLLIE_TAG` — it is an env var and not an
   *  option precisely because `curl … | sh` has no way to pass one. */
  env?: Readonly<Record<string, string>>;
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
      // The default release lists a `windows-x64` entry FIRST, as every release does from M43 spec 06
      // on, so every case below also proves that install.sh ignores it.
      stageRelease(d, { version: VERSION, windows: true });
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
    const curlLog = join(root, "curl.log");
    const headerLog = join(root, "headers.log");
    const curlrcCopy = join(root, "auth.curlrc");
    const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...(opts.args ?? [])], {
      cwd: root,
      env: {
        HOME: home,
        PATH: opts.onPath === true ? `${bin}:${join(home, ".local", "bin")}` : bin,
        COLLIE_DIR: dir,
        COLLIE_TEST_RELEASE: release,
        COLLIE_TEST_CURL_LOG: curlLog,
        COLLIE_TEST_HEADER_LOG: headerLog,
        COLLIE_TEST_CURLRC_COPY: curlrcCopy,
        ...opts.env,
      },
    });
    return {
      code: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      dir,
      home,
      curl: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
      headers: existsSync(headerLog) ? readFileSync(headerLog, "utf8") : "",
      curlrcMode: existsSync(curlrcCopy) ? (statSync(curlrcCopy).mode & 0o777).toString(8) : "",
      installed: existsSync(join(dir, "versions")),
    };
  } finally {
    // The layout cases keep the tree (see `runKeeping`); everything else has already read what it
    // asserts on, so the scratch root goes now.
    rmSync(root, { recursive: true, force: true });
  }
}

/** The layout cases need the tree to still exist, so they run the script themselves and inspect. */
function runKeeping(opts: Options, inspect: (r: Omit<Run, "installed" | "headers" | "curlrcMode">) => void): void {
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
    const curlLog = join(root, "curl.log");
    const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...(opts.args ?? [])], {
      cwd: root,
      env: {
        HOME: home,
        PATH: bin,
        COLLIE_DIR: dir,
        COLLIE_TEST_RELEASE: release,
        COLLIE_TEST_CURL_LOG: curlLog,
        ...opts.env,
      },
    });
    inspect({
      code: proc.exitCode,
      out: `${proc.stdout.toString()}${proc.stderr.toString()}`,
      dir,
      home,
      curl: existsSync(curlLog) ? readFileSync(curlLog, "utf8") : "",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// install.sh is a POSIX shell installer driven through /bin/sh, symlinks and a fake `curl`. A Windows
// host has no /bin/sh, so these cases stay skipped there. Windows installs with install.ps1, which has
// its own tests in install-ps1.test.ts, run on Windows against a local release mirror.
describe.skipIf(process.platform === "win32")("scripts/install.sh", () => {
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
    // The manifest's `windows-x64` entry is never fetched: this platform's tarball is.
    expect(r.curl).toContain(`collie-${VERSION}-${PLATFORM}.tar.gz`);
    expect(r.curl).not.toContain("windows");
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
    // Pairing is always on (ADR 0086): the install names `collie pair` as a step of its own.
    expect(r.out).toContain("collie pair");
    expect(r.out).toContain("docs/security.md");
    // The steps follow the five-minute guide: start, open on the phone, then pair. A `cp` of
    // `.env.example` after a start overwrites the saved COLLIE_MUX, so the steps never ask for one.
    expect(r.out.indexOf("collie start")).toBeLessThan(r.out.indexOf("collie qr"));
    expect(r.out.indexOf("collie qr")).toBeLessThan(r.out.indexOf("collie pair"));
    expect(r.out).not.toContain(".env.example");
  });

  test("never clobbers an existing Collie install — it names `collie update` and exits clean", () => {
    const r = run({
      seed: (dir) => {
        mkdirSync(join(dir, "versions", "0.35.0"), { recursive: true });
      },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("collie update");
    // …and the two ways forward when that verb is itself the thing that is broken.
    expect(r.out).toContain("COLLIE_TAG=vX.Y.Z");
    expect(r.out).toContain('docs/upgrading.md, section "When collie will not run"');
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

  // ── COLLIE_TAG ─────────────────────────────────────────────────────────────
  // The pin is both an ordinary "give me that version" and the rescue for an install whose own
  // `collie update` will not run. What is pinned here is that it never asks GitHub which version to
  // take, that it lays down beside rather than over, and that it refuses where it cannot help.

  test("COLLIE_TAG installs the exact tag it names, and asks the tags API nothing at all", () => {
    const r = run({ env: { COLLIE_TAG: `v${BETA_VERSION}` } });
    expect(r.code).toBe(0);
    // A prerelease, with no --beta anywhere: naming the tag IS the opt-in.
    expect(r.out).toContain(`Collie v${BETA_VERSION}`);
    expect(r.curl).not.toContain("api.github.com");
    expect(r.curl).toContain(`collie-${BETA_VERSION}-${PLATFORM}.tar.gz`);
    expect(r.installed).toBe(true);
  });

  test("a COLLIE_TAG of the wrong shape dies before any request, and shows the shape", () => {
    const r = run({ env: { COLLIE_TAG: "1.0.0" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("v1.0.0-beta.49");
    expect(r.curl).toBe("");
    expect(r.installed).toBe(false);
  });

  test("COLLIE_TAG lays the pinned version BESIDE an existing install and flips `current`", () => {
    runKeeping(
      {
        env: { COLLIE_TAG: `v${VERSION}` },
        seed: (dir) => {
          mkdirSync(join(dir, "versions", "0.35.0"), { recursive: true });
        },
      },
      (r) => {
        expect(r.code).toBe(0);
        expect(r.out).toContain("beside it");
        // The version that was already there survives — a rescue is never a clobber.
        expect(existsSync(join(r.dir, "versions", "0.35.0"))).toBe(true);
        expect(existsSync(join(r.dir, "versions", VERSION, "bin", "collie"))).toBe(true);
        expect(readlinkSync(join(r.dir, "current"))).toBe(`versions/${VERSION}`);
      },
    );
  });

  test("COLLIE_TAG for a version already on disk is a symlink flip, and downloads nothing", () => {
    runKeeping(
      {
        env: { COLLIE_TAG: `v${VERSION}` },
        seed: (dir) => {
          mkdirSync(join(dir, "versions", VERSION, "bin"), { recursive: true });
          writeFileSync(join(dir, "versions", VERSION, "bin", "collie"), '#!/bin/sh\necho "linked"\n');
          chmodSync(join(dir, "versions", VERSION, "bin", "collie"), 0o755);
        },
      },
      (r) => {
        expect(r.code).toBe(0);
        expect(r.out).toContain("nothing was downloaded");
        expect(r.out).toContain("linked");
        expect(r.curl).toBe("");
        expect(readlinkSync(join(r.dir, "current"))).toBe(`versions/${VERSION}`);
      },
    );
  });

  test("COLLIE_TAG over a git checkout refuses, and hands the job to git", () => {
    const r = run({
      env: { COLLIE_TAG: `v${VERSION}` },
      seed: (dir) => {
        mkdirSync(join(dir, ".git"), { recursive: true });
      },
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("git -C");
    expect(r.out).toContain(`checkout v${VERSION}`);
  });

  test("a rate-limited tags API is named as one, with the pin that skips the call", () => {
    const r = run({ env: { COLLIE_TEST_API_CODE: "403" } });
    expect(r.code).toBe(1);
    expect(r.out).toContain("rate limit");
    expect(r.out).toContain("60 calls an hour");
    expect(r.out).toContain("Set GH_TOKEN");
    expect(r.out).toContain("COLLIE_TAG=vX.Y.Z");
    expect(r.headers).not.toContain("Authorization");
    expect(r.installed).toBe(false);
  });

  test("a GitHub token in the env goes with the tags call alone, and a message names the variable, never the value (#254)", () => {
    const ok = run({ env: { GH_TOKEN: "ghp_secret" } });
    expect(ok.code).toBe(0);
    // One bearer header for the whole run: the tags call. The three downloads carry none. It travels
    // in a curl config file at mode 600, never as a `-H` argument `ps` would show.
    expect(ok.headers.split("\n").filter((line) => line.startsWith("Authorization: "))).toEqual([
      "Authorization: Bearer ghp_secret",
    ]);
    expect(ok.curlrcMode).toBe("600");
    const limited = run({ env: { COLLIE_TEST_API_CODE: "403", GITHUB_TOKEN: "ghp_secret" } });
    expect(limited.code).toBe(1);
    expect(limited.out).toContain("even with the token in GITHUB_TOKEN");
    expect(limited.out).not.toContain("Set GH_TOKEN");
    expect(limited.out).not.toContain("ghp_secret");
    const refused = run({
      env: { COLLIE_TEST_API_CODE: "401", COLLIE_GITHUB_TOKEN: "ghp_bad", GH_TOKEN: "ghp_second" },
    });
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("refused the token in COLLIE_GITHUB_TOKEN");
    expect(refused.out).not.toContain("ghp_bad");
    expect(refused.installed).toBe(false);
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

// Both installers print colliepwa.dev docs links in their last lines. The site publishes
// `docs/<slug>.md` at `/docs/<slug>`, so a renamed page or heading breaks a link in a terminal
// nobody re-reads. Each link must name a page in docs/ and, with an anchor, one of its headings.
// It reads files only, so it runs on Windows too, outside the POSIX-only block above.
test("the docs links the installers print name a real page and heading", () => {
  const slug = (heading: string) =>
    heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");
  const link = /https:\/\/colliepwa\.dev\/docs\/([a-z0-9-]+)(?:#([a-z0-9-]+))?/g;
  const links = ["install.sh", "install.ps1"].flatMap((file) =>
    Array.from(readFileSync(join(import.meta.dir, file), "utf8").replace(/\r\n/g, "\n").matchAll(link)),
  );
  expect(links.length).toBeGreaterThan(0);
  for (const [, page, anchor] of links) {
    const doc = readFileSync(join(import.meta.dir, "..", "docs", `${page}.md`), "utf8").replace(/\r\n/g, "\n");
    if (anchor === undefined) continue;
    const headings = [...doc.matchAll(/^#+ (.+)$/gm)].map((m) => slug(m[1] ?? ""));
    expect(headings).toContain(anchor);
  }
});

// Both installers end by printing the commands a user types next. The five-minute guide
// (docs/five-minute-install.md) holds the one numbered path per system, so every command an
// installer prints must also be a command in a fenced code block of that system's section, or the
// terminal and the guide drift apart. The shared phone section counts for every system, because
// `collie qr` and `collie pair` live there. It reads files only, so it runs on Windows too, outside
// the POSIX-only block above.
//
// To extend it: a command line in an installer's next-steps block is found by its INDENT, so a new
// command needs no change here while it keeps the current wording style. install.sh prints a
// command indented seven spaces inside the closing heredoc, after "What is left, which is yours".
// install.ps1 prints it as `Write-CollieLine "       <command>"` (seven spaces) after "Next steps.".
// Prose lines use fewer spaces. If an installer changes that style, change the two readers below.
describe("the installers' next steps match the five-minute guide", () => {
  const root = join(import.meta.dir, "..");
  // A Windows checkout may hold `\r\n` line endings, which would leave a `\r` at the end of every
  // matched line and break the `\nEOF\n` and `\n}\n` cuts. Every file this block reads goes through here.
  const read = (path: string): string => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const slug = (heading: string) =>
    heading.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ /g, "-");

  /** The text of a `## ` section, from its heading to the next `## ` heading. */
  const section = (doc: string, heading: string): string => {
    const lines = doc.split("\n");
    const start = lines.findIndex(
      (line) => line.startsWith("## ") && slug(line.slice(3)) === slug(heading),
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("## "));
    return rest.slice(0, end === -1 ? undefined : end).join("\n");
  };

  /** Normalise one command line for comparison: no trailing `# comment`, no prompt, one space. */
  const clean = (line: string): string =>
    line
      .replace(/\s+#.*$/, "")
      .replace(/^(\$|PS>)\s+/, "")
      .replace(/\s+/g, " ")
      .trim();

  /** Every command line inside a fenced code block of `text`, cleaned. */
  const commandLines = (text: string): Set<string> => {
    const found = new Set<string>();
    let fenced = false;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        fenced = !fenced;
        continue;
      }
      if (fenced && line.trim() !== "") found.add(clean(line));
    }
    return found;
  };

  /** The commands install.sh prints in its closing heredoc. */
  const shCommands = (): string[] => {
    const script = read(join(import.meta.dir, "install.sh"));
    const block = script.split("# ── What is left, which is yours")[1]?.split("\nEOF\n")[0] ?? "";
    return [...block.matchAll(/^ {7}(\S.*)$/gm)].map((m) => clean(m[1] ?? ""));
  };

  /**
   * The commands install.ps1 prints after "Next steps.". The script names its own binary with
   * `$collie`, which is `collie` or a full path to `collie.exe`, so a leading `$collie ` is
   * normalised to `collie ` here: the guide always spells the bare name.
   */
  const psCommands = (): string[] => {
    const script = read(join(import.meta.dir, "install.ps1"));
    const block = script.split('Write-CollieLine "Next steps.')[1]?.split("\n}\n")[0] ?? "";
    return [...block.matchAll(/Write-CollieLine " {7}(\S[^"]*)"/g)].map((m) =>
      clean((m[1] ?? "").replace(/^\$collie /, "collie ")),
    );
  };

  const guide = read(join(root, "docs", "five-minute-install.md"));
  const phone = section(guide, "Put Collie on your phone and pair it");

  const cases: Array<[string, string, () => string[]]> = [
    ["install.sh", "Linux", shCommands],
    ["install.sh", "macOS", shCommands],
    ["install.ps1", "Windows", psCommands],
  ];

  for (const [file, os, printed] of cases) {
    test(`${file} prints only commands that the ${os} section of the guide shows`, () => {
      const commands = printed();
      // Rot guard: a changed print style must not turn this into an empty, passing test.
      expect(commands.length).toBeGreaterThanOrEqual(4);
      const known = commandLines(`${section(guide, os)}\n${phone}`);
      for (const command of commands) expect(known).toContain(command);
    });
  }

  // The README is the GitHub front door and keeps a short copy of the setup. It prints no command
  // that the guide does not. This checks the command lines in fenced blocks of its phone section,
  // plus the inline spans for the verbs the section names in prose. To extend it: add a verb to
  // INLINE_VERBS when the README names another command inline that the guide also prints.
  const INLINE_VERBS = /^collie (qr|pair|url|start)$/;

  test("the README quick setup prints only commands the guide prints", () => {
    const readme = read(join(root, "README.md"));
    const quick = section(readme, "Get it on your phone in 3 steps");
    const fenced = [...commandLines(quick)];
    const inline = [...quick.matchAll(/`([^`\n]+)`/g)]
      .map((m) => clean(m[1] ?? ""))
      .filter((span) => INLINE_VERBS.test(span));
    // Rot guard: the section must still hold the install, start, qr and pair commands.
    expect(fenced.length).toBeGreaterThanOrEqual(2);
    expect(inline).toContain("collie qr");
    expect(inline).toContain("collie pair");
    const known = commandLines(guide);
    for (const command of [...fenced, ...inline]) expect(known).toContain(command);
  });
});
