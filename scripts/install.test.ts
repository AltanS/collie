import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The curl-piped bootstrap installer, driven the way scripts/collie-ctl.test.sh drives the shim:
// every case runs against a THROWAWAY $HOME with a scratch PATH holding fake `git` and `bun`
// binaries, so nothing here clones from GitHub, builds anything, or touches the real ~/.local/bin.
//
// What is worth pinning is the script's CONTRACT, because M14 will replace the clone-and-build body
// with a downloaded artifact and must keep it: refuse without git or bun, never clobber an existing
// checkout, take the newest STRICT tag unless --beta, build through the shim, link the binary, and
// end by printing next steps instead of starting anything.

const SCRIPT = join(import.meta.dir, "install.sh");

interface Run {
  code: number;
  out: string;
}

/**
 * The externals the script and its fakes genuinely need, symlinked into the scratch PATH one by one.
 * The whole point of the scratch PATH is that a case can withhold `git` or `bun` and have the
 * absence be REAL — appending the system PATH would hand the script the host's own copies back.
 */
const SYS_TOOLS = ["sh", "mkdir", "dirname", "grep", "sort", "tail", "cat", "cp", "chmod"] as const;

function linkSystemTools(dir: string): void {
  for (const tool of SYS_TOOLS) {
    for (const base of ["/usr/bin", "/bin"]) {
      if (existsSync(`${base}/${tool}`)) {
        symlinkSync(`${base}/${tool}`, join(dir, tool));
        break;
      }
    }
  }
}

/** A scratch PATH holding only the fakes a case asks for — so "git is missing" is a real absence. */
function fakeBin(dir: string, name: string, body: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/**
 * A fake `git` that clones by copying a fixture checkout, and reports a fixed tag list. It records
 * nothing it is not asked about: the assertions read the script's own output, not the fake's.
 */
const FAKE_GIT = `
case "$1" in
  clone) shift; while [ "\${1#--}" != "$1" ]; do shift; done; cp -R "$COLLIE_TEST_FIXTURE" "$2"; mkdir -p "$2/.git" ;;
  tag)   printf '%s\\n' $COLLIE_TEST_TAGS ;;
  checkout) echo "$*" >> "$COLLIE_TEST_CALLS" ;;
  *) : ;;
esac
exit 0
`;

function run(args: readonly string[], opts: { git?: boolean; bun?: boolean; tags?: string; binary?: boolean; onPath?: boolean } = {}): Run {
  const root = mkdtempSync(join(tmpdir(), "collie-install-"));
  try {
    const home = join(root, "home");
    const bin = join(root, "path-bin");
    const fixture = join(root, "fixture");
    mkdirSync(join(fixture, "scripts"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    linkSystemTools(bin);
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(fixture, "herdr-plugin.toml"), 'version = "1.0.0"\n');
    writeFileSync(join(fixture, ".env.example"), "COLLIE_MUX=herdr\n");
    // The shim stands in for the real build: it makes a binary only when the case wants one, so the
    // "this release predates the compiled CLI" branch is reachable.
    writeFileSync(
      join(fixture, "scripts", "collie-ctl.sh"),
      opts.binary === false
        ? "#!/bin/sh\necho built\n"
        : "#!/bin/sh\nmkdir -p bin\nprintf '#!/bin/sh\\necho linked\\n' > bin/collie\nchmod +x bin/collie\necho built\n",
    );
    if (opts.git !== false) fakeBin(bin, "git", FAKE_GIT);
    if (opts.bun !== false) fakeBin(bin, "bun", "exit 0");
    const proc = Bun.spawnSync(["/bin/sh", SCRIPT, ...args], {
      cwd: root,
      env: {
        HOME: home,
        PATH: opts.onPath === true ? `${bin}:${join(home, ".local", "bin")}` : bin,
        COLLIE_DIR: join(home, "collie"),
        COLLIE_TEST_FIXTURE: fixture,
        COLLIE_TEST_TAGS: opts.tags ?? "v0.36.0 v1.0.0-beta.5 v1.0.0-beta.10",
        COLLIE_TEST_CALLS: join(root, "calls"),
      },
    });
    return { code: proc.exitCode, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
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
    const r = run(["--nightly"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--beta");
  });

  test("stops when git is missing, and says how to get it", () => {
    const r = run([], { git: false });
    expect(r.code).toBe(1);
    expect(r.out).toContain("git is required");
  });

  test("stops when Bun is missing, and points at bun.sh rather than installing it", () => {
    const r = run([], { bun: false });
    expect(r.code).toBe(1);
    expect(r.out).toContain("https://bun.sh");
  });

  test("takes the newest STRICT release by default — a prerelease is never inherited", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Checking out v0.36.0");
    expect(r.out).not.toContain("beta");
  });

  test("--beta is the opt-in, and it takes the newest prerelease by semver, not by string", () => {
    const r = run(["--beta"]);
    expect(r.code).toBe(0);
    // beta.10 sorts ABOVE beta.5 — the comparison that a naive sort gets backwards.
    expect(r.out).toContain("Checking out v1.0.0-beta.10");
  });

  test("builds through the shim and links the binary", () => {
    const r = run([]);
    expect(r.out).toContain("built");
    expect(r.out).toContain("linked");
  });

  test("says so instead of failing when the release predates the compiled CLI", () => {
    const r = run([], { binary: false });
    expect(r.code).toBe(0);
    expect(r.out).toContain("collie-ctl.sh <verb>");
  });

  test("warns — never fails — when ~/.local/bin is not on PATH", () => {
    expect(run([]).out).toContain("is not on your PATH");
    expect(run([], { onPath: true }).out).not.toContain("is not on your PATH");
  });

  test("ends by printing the next steps, and starts nothing", () => {
    const r = run([]);
    expect(r.out).toContain("nothing is running yet");
    expect(r.out).toContain("COLLIE_MUX");
    expect(r.out).toContain("collie start");
    expect(r.out).toContain("docs/security.md");
  });

  test("never clobbers an existing Collie checkout — it names `collie update` and exits clean", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-install-"));
    try {
      const home = join(root, "home");
      const dir = join(home, "collie");
      mkdirSync(join(dir, ".git"), { recursive: true });
      writeFileSync(join(dir, "herdr-plugin.toml"), 'version = "1.0.0"\n');
      const bin = join(root, "path-bin");
      mkdirSync(bin, { recursive: true });
      linkSystemTools(bin);
      fakeBin(bin, "git", "exit 0");
      fakeBin(bin, "bun", "exit 0");
      const proc = Bun.spawnSync(["/bin/sh", SCRIPT], {
        cwd: root,
        env: { HOME: home, PATH: bin, COLLIE_DIR: dir },
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString()).toContain("bin/collie update");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses a target directory that holds something else", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-install-"));
    try {
      const home = join(root, "home");
      const dir = join(home, "not-collie");
      mkdirSync(dir, { recursive: true });
      const bin = join(root, "path-bin");
      mkdirSync(bin, { recursive: true });
      linkSystemTools(bin);
      fakeBin(bin, "git", "exit 0");
      fakeBin(bin, "bun", "exit 0");
      const proc = Bun.spawnSync(["/bin/sh", SCRIPT], {
        cwd: root,
        env: { HOME: home, PATH: bin, COLLIE_DIR: dir },
      });
      expect(proc.exitCode).toBe(1);
      expect(proc.stderr.toString()).toContain("COLLIE_DIR");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
