import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  type BuildDeps,
  bunCompileSandboxPrefix,
  cmdBuild,
  compileCli,
  collieBinaryStaging,
  ensureBuild,
  webDist,
  webStaging,
} from "./build.ts";
import {
  BINARY,
  capture,
  context,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  ROOT,
  type Scripted,
  type SeededFiles,
} from "./fakes.ts";
import type { Environment } from "./context.ts";
import { EXIT } from "./io.ts";
import type { ExecResult } from "./sys.ts";
import { realFiles } from "./sys.ts";

// `build` against the two seams. What is asserted here is ORDER and the swap invariant: the shell
// got both right by accident of `set -e` plus a trailing `mv`, and a port that merely produced the
// same artifacts on the happy path would silently lose the property that matters — a build that
// fails leaves the previously served `web/dist` byte-identical.

const WEB = `${ROOT}/web`;
const DIST = webDist(ROOT);
const STAGING = webStaging(ROOT);
const BINARY_NEW = collieBinaryStaging(ROOT);
const SANDBOX_PREFIX = bunCompileSandboxPrefix(ROOT);
const SIDECAR = ".dfca361f92216413-00000000.bun-build";
const compilerCall = (call: string): boolean => call.includes(" build --compile ");
const compilerCwd = (call: string): string => call.slice(0, call.indexOf("$"));
const hasCompilerSandbox = (root: string): boolean => {
  const bin = join(root, "bin");
  return existsSync(bin) && readdirSync(bin).some((name) => name.startsWith(".bun-compile-"));
};
const GATE = `${ROOT}/scripts/check-version.sh`;

interface Harness {
  deps: BuildDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
}

function harness(
  over: Partial<Scripted & { env: Environment; files: SeededFiles }> = {},
): Harness {
  const io = capture();
  const exec = fakeExec(over);
  // A previously built, live bundle — the thing every failure path must leave untouched.
  const files = fakeFiles({
    [`${DIST}/index.html`]: "<!doctype html>OLD",
    [`${DIST}/assets/app.js`]: "OLD BUNDLE",
    [BINARY]: "OLD BINARY",
    ...over.files,
  });
  return { deps: { ctx: context(over.env ?? {}), io, exec, files }, io, exec, files };
}

/** The live bundle, as a comparable snapshot. */
const servedBundle = (files: FakeFiles): SeededFiles =>
  Object.fromEntries(
    [...files.entries].filter(([p]) => p.startsWith(`${DIST}/`)).map(([p, v]) => [p, v.text]),
  );

// This fixture is a real Git checkout. The minimal Vite module shims only host vite.config.ts's
// build-info plugin; the config and its `git status --porcelain` call remain the production source.
const sourceRoot = join(import.meta.dir, "..");

interface GitFixture {
  readonly root: string;
  readonly home: string;
  readonly env: Record<string, string>;
}

/** The copied Vite configuration's authoritative package version. */
function vitePackageVersion(root: string): string {
  // SAFETY: this is the checked-in manifest copied into the fixture; Vite reads its `version` as a
  // string, and scripts/check-version.sh requires it to agree with the other release manifests.
  return (JSON.parse(readFileSync(join(root, "web", "package.json"), "utf8")) as { version: string }).version;
}

/** A private Git environment: no inherited Git variables, system config, or global config. */
function gitFixtureEnv(root: string): GitFixture {
  const home = join(root, ".git-home");
  mkdirSync(home, { recursive: true });
  const global = join(home, "empty.gitconfig");
  writeFileSync(global, "");
  // This is the reviewer's hostile configuration. `GIT_CONFIG_GLOBAL` below deliberately ignores
  // it, while the successful fixture commit proves signing is not inherited from a developer's HOME.
  writeFileSync(join(home, ".gitconfig"), "[commit]\n\tgpgSign = true\n");
  return {
    root,
    home,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([name, value]) => !name.startsWith("GIT_") && value !== undefined),
      ),
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: global,
    },
  };
}

function git(fixture: GitFixture, args: readonly string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgSign=false",
      "-c",
      "tag.gpgSign=false",
      "-C",
      fixture.root,
      ...args,
    ],
    { encoding: "utf8", env: fixture.env, stdio: "pipe" },
  ).trim();
}

function writeViteStub(web: string, name: string, source: string): void {
  const dir = join(web, "node_modules", ...name.split("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"type":"module","exports":"./index.js"}\n');
  writeFileSync(join(dir, "index.js"), source);
}

function buildInfoHost(root: string): void {
  writeFileSync(
    join(root, "identity-host.ts"),
    `import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import config from "./web/vite.config.ts";

const plugin = config.plugins.find((candidate) => candidate?.name === "collie-build-info");
if (plugin === undefined || typeof plugin.generateBundle !== "function") {
  throw new Error("vite.config.ts did not expose the build-info plugin");
}
let source: unknown;
plugin.generateBundle.call({
  emitFile(asset: { fileName?: unknown; source?: unknown }) {
    if (asset.fileName === "build-info.json") source = asset.source;
  },
});
if (typeof source !== "string") throw new Error("build-info plugin did not emit JSON");
const output = join(import.meta.dir, "web", "dist-staging", "build-info.json");
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, source);
`,
  );
}

interface GitFixtureOptions {
  readonly commitArgs?: readonly string[];
  readonly observeRoot?: (root: string) => void;
}

/**
 * Create, use, and remove a real tagged Git checkout. The `try` starts immediately after mkdtemp,
 * before any setup or commit can fail, so even a broken Git installation cannot leak its root.
 */
function withGitBuildFixture<T>(
  run: (fixture: GitFixture) => T,
  options: GitFixtureOptions = {},
): T {
  const root = mkdtempSync(join(tmpdir(), "collie-build-"));
  try {
    options.observeRoot?.(root);
    const fixture = gitFixtureEnv(root);
    const web = join(root, "web");
    mkdirSync(join(root, "cli"), { recursive: true });
    mkdirSync(web, { recursive: true });
    writeFileSync(
      join(root, ".gitignore"),
      `${readFileSync(join(sourceRoot, ".gitignore"), "utf8")}\n/.git-home/\n`,
    );
    writeFileSync(join(root, "cli", "main.ts"), "export {};\n");
    copyFileSync(join(sourceRoot, "web", "vite.config.ts"), join(web, "vite.config.ts"));
    copyFileSync(join(sourceRoot, "web", "vite-icons.ts"), join(web, "vite-icons.ts"));
    copyFileSync(join(sourceRoot, "web", "package.json"), join(web, "package.json"));
    const version = vitePackageVersion(root);
    writeFileSync(join(root, "herdr-plugin.toml"), `version = "${version}"\n`);
    buildInfoHost(root);

    // vite.config.ts only needs these factories to construct its plugin list. Its build-info plugin,
    // and the Git calls it makes at module evaluation, are the actual checkout sources above.
    writeViteStub(web, "vite", "export const defineConfig = (config) => config;\n");
    writeViteStub(web, "@vitejs/plugin-react", "export default () => ({ name: 'react' });\n");
    writeViteStub(web, "@tailwindcss/vite", "export default () => ({ name: 'tailwind' });\n");
    writeViteStub(web, "vite-plugin-pwa", "export const VitePWA = () => ({ name: 'pwa' });\n");

    git(fixture, ["init", "-q"]);
    git(fixture, ["config", "user.email", "test@example.com"]);
    git(fixture, ["config", "user.name", "Test"]);
    git(fixture, ["add", "."]);
    git(fixture, options.commitArgs ?? ["commit", "-qm", "fixture"]);
    git(fixture, ["tag", "-a", `v${version}`, "-m", "fixture release"]);
    return run(fixture);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

interface HermeticBuild {
  readonly deps: BuildDeps;
  readonly compilerCwds: string[];
  readonly webBuilds: () => number;
  readonly identitySawCleanSandbox: () => boolean;
}

function hermeticBuild(fixture: GitFixture, compilerCode: number): HermeticBuild {
  const { root, env } = fixture;
  const compilerCwds: string[] = [];
  let webBuilds = 0;
  let identitySawCleanSandbox = false;
  const exec = fakeExec();
  const result = (code: number, stdout = "", stderr = ""): ExecResult => ({
    code,
    stdout,
    stderr,
    found: true,
  });
  exec.which = (tool) => (tool === "bun" ? process.execPath : null);
  exec.capture = (tool, args) => {
    if (tool !== "git") return { code: 127, stdout: "", stderr: "", found: false };
    const run = Bun.spawnSync(["git", ...args], { env });
    return result(run.exitCode ?? 127, run.stdout.toString(), run.stderr.toString());
  };
  exec.runIn = (tool, args, cwd) => {
    if (tool !== "bun") return { code: 127, stdout: "", stderr: "", found: false };
    if (args[0] === "install") return result(EXIT.OK);
    if (args[0] === "build" && args[1] === "--compile") {
      const outputAt = args.indexOf("--outfile");
      const output = outputAt < 0 ? undefined : args[outputAt + 1];
      if (output === undefined) throw new Error("compiler invocation lacks --outfile");
      compilerCwds.push(cwd);
      writeFileSync(join(cwd, SIDECAR), "Bun compiler scratch\n");
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, "NEW BINARY\n");
      return result(compilerCode);
    }
    if (args[0] === "run" && args[1] === "build") {
      identitySawCleanSandbox = !hasCompilerSandbox(root);
      const run = Bun.spawnSync([process.execPath, join(root, "identity-host.ts")], {
        cwd,
        env,
      });
      if (run.exitCode !== 0) {
        throw new Error(`vite identity host failed: ${run.stderr.toString()}`);
      }
      webBuilds += 1;
      return result(EXIT.OK);
    }
    throw new Error(`unexpected build command: ${[tool, ...args].join(" ")}`);
  };

  return {
    deps: {
      ctx: context({ SKIP_VERSION_CHECK: "1", SKIP_TYPECHECK: "1" }, { root }),
      io: capture(),
      exec,
      files: realFiles,
    },
    compilerCwds,
    webBuilds: () => webBuilds,
    identitySawCleanSandbox: () => identitySawCleanSandbox,
  };
}

describe("build: the ordered steps", () => {
  test("gate → install both trees → typecheck both sides → compile the CLI → build the web UI", () => {
    const h = harness();
    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    const compile = h.exec.calls.find(compilerCall);
    expect(compile).toBeDefined();
    expect(compilerCwd(compile!)).toStartWith(SANDBOX_PREFIX);
    expect(compile).toEndWith(`bun build --compile --target=bun ${ROOT}/cli/main.ts --outfile ${BINARY_NEW}`);
    expect(h.exec.calls.filter((call) => !compilerCall(call))).toEqual([
      `${ROOT}$ bash ${GATE}`,
      `${ROOT}$ bun install`,
      `${WEB}$ bun install`,
      `${ROOT}$ bun run typecheck`,
      `${WEB}$ bun run typecheck`,
      `${WEB}$ bun run build -- --outDir dist-staging --emptyOutDir`,
    ]);
  });

  test("the swaps are LAST, and both are renames", () => {
    const h = harness({ files: { [`${STAGING}/index.html`]: "<!doctype html>NEW" } });
    // The staging dir is cleared before the build writes it, and the two swaps come after every
    // step that can fail.
    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    const sandboxCleanup = h.files.ops.find((op) => op.startsWith(`rm -rf ${SANDBOX_PREFIX}`));
    expect(sandboxCleanup).toBeDefined();
    expect(h.files.ops.filter((op) => op.startsWith(`rm -rf ${SANDBOX_PREFIX}`))).toHaveLength(1);
    expect(h.files.ops.slice(-4)).toEqual([
      `rm -rf ${STAGING}`,
      `mv ${BINARY_NEW} ${BINARY}`,
      `rm -rf ${DIST}`,
      `mv ${STAGING} ${DIST}`,
    ]);
  });

  test("the compiled binary is renamed into place, never written there", () => {
    // A Bun single-file executable carries its payload inside the file, and the supervised daemon
    // may be executing it: the compile MUST target another path.
    const h = harness();
    cmdBuild(h.deps);
    const compile = h.exec.calls.find(compilerCall)!;
    expect(compile).toContain(`${ROOT}/cli/main.ts`);
    expect(compile).toContain(`--outfile ${BINARY_NEW}`);
    expect(compilerCwd(compile)).toStartWith(SANDBOX_PREFIX);
    expect(compile.endsWith(`--outfile ${BINARY}`)).toBe(false);
    expect(h.files.ops).toContain(`mv ${BINARY_NEW} ${BINARY}`);
  });

  test("SKIP_VERSION_CHECK=1 and SKIP_TYPECHECK=1 drop exactly their own step", () => {
    const h = harness({ env: { SKIP_VERSION_CHECK: "1", SKIP_TYPECHECK: "1" } });
    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.some((c) => c.includes("check-version.sh"))).toBe(false);
    expect(h.exec.calls.some((c) => c.includes("typecheck"))).toBe(false);
    expect(h.exec.calls).toContain(`${ROOT}$ bun install`);
    expect(h.exec.calls).toContain(`${WEB}$ bun run build -- --outDir dist-staging --emptyOutDir`);
  });

  test("the operator build issues NO lint invocation at all — a lint gate here aborted installs on hosts under ~7 GB of RAM", () => {
    // The regression this fix exists to prevent. `build` is what a clean install (Herdr's
    // `[[build]]`) and `update` run on the OPERATOR'S machine; oxlint's allocator SIGABRTs below
    // roughly 7 GB, so a lint step here ended installs with `Plugin was not installed.` and left
    // upgrades with no `bin/collie`. No env var may re-arm it, so the empty environment is the
    // case that matters — and nothing named SKIP_LINT exists to turn it back off.
    for (const env of [{}, { SKIP_LINT: "1" }, { SKIP_LINT: "0" }]) {
      const h = harness({ env });
      expect(cmdBuild(h.deps)).toBe(EXIT.OK);
      expect(h.exec.calls.some((c) => c.includes("lint"))).toBe(false);
      expect(h.exec.calls.some((c) => c.includes("oxlint"))).toBe(false);
      expect(h.exec.calls.some((c) => c.includes("check-mux-names.sh"))).toBe(false);
    }
  });

  test("bun missing is a legible hard failure, not an ENOENT", () => {
    const h = harness({ absent: ["bun"] });
    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("bun not found");
    expect(h.exec.calls).toEqual([]);
    expect(h.files.ops).toEqual([]);
  });
});

describe("build: CLI-only compiler", () => {
  test("creates a missing bin directory before validating its canonical path", () => {
    const io = capture();
    const files = fakeFiles({ [`${ROOT}/cli/main.ts`]: "export {};" });

    expect(compileCli({ root: ROOT, io, exec: fakeExec(), files })).toBe(true);
    expect(files.entryType(`${ROOT}/bin`)).toBe("directory");
  });

  test("uses an invocation-owned sandbox without building the web UI", () => {
    const h = harness();
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) h.files.write(join(cwd, SIDECAR), "Bun compiler scratch");
      return result;
    };

    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(true);
    const compile = h.exec.calls.find(compilerCall)!;
    const sandbox = compilerCwd(compile);
    expect(sandbox).toStartWith(SANDBOX_PREFIX);
    expect(compile).toEndWith(`bun build --compile --target=bun ${ROOT}/cli/main.ts --outfile ${BINARY}`);
    expect(h.files.exists(sandbox)).toBe(false);
    expect(h.files.entries.has(`${ROOT}/${SIDECAR}`)).toBe(false);
  });

  test("uses a release-selected Bun, target and artifact path from that sandbox", () => {
    const h = harness();

    expect(
      compileCli(
        { root: ROOT, io: h.io, exec: h.exec, files: h.files },
        {
          bun: "/tool/upstream-bun",
          target: "bun-linux-x64-baseline",
          outfile: "/artifacts/collie",
        },
      ),
    ).toBe(true);
    const compile = h.exec.calls.find(compilerCall)!;
    expect(compilerCwd(compile)).toStartWith(SANDBOX_PREFIX);
    expect(compile).toEndWith(
      "/tool/upstream-bun build --compile --target=bun-linux-x64-baseline /opt/collie/cli/main.ts --outfile /artifacts/collie",
    );
  });

  test("cleans compiler scratch after a failed CLI-only compile", () => {
    const h = harness();
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (!args.includes("--compile")) return result;
      h.files.write(join(cwd, SIDECAR), "Bun compiler scratch");
      return { ...result, code: 1 };
    };

    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(false);
    const sandbox = compilerCwd(h.exec.calls.find(compilerCall)!);
    expect(h.files.exists(sandbox)).toBe(false);
    expect(h.files.entries.has(`${ROOT}/${SIDECAR}`)).toBe(false);
  });

  test("does not touch a pre-existing fixed sandbox", () => {
    const fixed = join(ROOT, "bin", ".bun-compile");
    const sentinel = join(fixed, "sentinel");
    const h = harness({ files: { [sentinel]: "UNOWNED" } });

    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(true);
    expect(h.files.entries.get(sentinel)?.text).toBe("UNOWNED");
    expect(h.files.ops).not.toContain(`rm -rf ${fixed}`);
  });

  test("gives overlapping compiler calls separate sandboxes", () => {
    const h = harness();
    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(true);
    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(true);

    const sandboxes = h.exec.calls.filter(compilerCall).map(compilerCwd);
    expect(sandboxes).toHaveLength(2);
    expect(new Set(sandboxes).size).toBe(2);
    expect(sandboxes.every((sandbox) => sandbox.startsWith(SANDBOX_PREFIX))).toBe(true);
  });

  test("fails closed when the checkout root cannot be listed", () => {
    const h = harness();
    h.files.unlistable.add(ROOT);

    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(false);
    expect(h.exec.calls).toEqual([]);
    expect(h.io.stderr.join("\n")).toContain("could not list the checkout root");
  });

  test("refuses a bin whose canonical path is outside the checkout", () => {
    const h = harness({ files: { ["/external/bin/.bun-compile/sentinel"]: "EXTERNAL" } });
    h.files.realPaths.set(`${ROOT}/bin`, "/external/bin");

    expect(compileCli({ root: ROOT, io: h.io, exec: h.exec, files: h.files })).toBe(false);
    expect(h.files.entries.get("/external/bin/.bun-compile/sentinel")?.text).toBe("EXTERNAL");
    expect(h.exec.calls).toEqual([]);
    expect(h.io.stderr.join("\n")).toContain("resolves outside its canonical path");
  });

  test("refuses an external bin symlink without touching its contents", () => {
    const root = mkdtempSync(join(tmpdir(), "collie-sandbox-root-"));
    const external = mkdtempSync(join(tmpdir(), "collie-sandbox-external-"));
    try {
      mkdirSync(join(external, ".bun-compile"), { recursive: true });
      const sentinel = join(external, ".bun-compile", "sentinel");
      writeFileSync(sentinel, "EXTERNAL");
      symlinkSync(external, join(root, "bin"), process.platform === "win32" ? "junction" : "dir");
      const io = capture();

      expect(compileCli({ root, io, exec: fakeExec(), files: realFiles })).toBe(false);
      expect(readFileSync(sentinel, "utf8")).toBe("EXTERNAL");
      expect(io.stderr.join("\n")).toContain("not a real directory");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("build: a failure never empties the live web/dist", () => {
  const cases: [name: string, prefix: string][] = [
    ["the version gate", `${ROOT}$ bash ${GATE}`],
    ["the root install", `${ROOT}$ bun install`],
    ["the web typecheck", `${WEB}$ bun run typecheck`],
    ["the web build", `${WEB}$ bun run build --`],
  ];

  for (const [name, prefix] of cases) {
    test(`${name} failing aborts before both swaps`, () => {
      const h = harness({ answers: [[prefix, { code: 1 }]] });
      const before = servedBundle(h.files);
      expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
      // The served bundle is byte-identical and the running binary is the one that started.
      expect(servedBundle(h.files)).toEqual(before);
      expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
      expect(h.files.ops).not.toContain(`rm -rf ${DIST}`);
      expect(h.files.ops).not.toContain(`mv ${BINARY_NEW} ${BINARY}`);
      expect(h.io.stderr.join("\n")).toContain("failed");
    });
  }

  test("a failed CLI compile aborts before both swaps", () => {
    const h = harness();
    const before = servedBundle(h.files);
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      return args.includes("--compile") ? { ...result, code: 1 } : result;
    };

    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(servedBundle(h.files)).toEqual(before);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.files.ops).not.toContain(`rm -rf ${DIST}`);
  });

  test("a failed web build leaves no half-compiled binary lying around", () => {
    const h = harness({
      answers: [[`${WEB}$ bun run build --`, { code: 1 }]],
      files: { [BINARY_NEW]: "HALF" },
    });
    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.files.entries.has(BINARY_NEW)).toBe(false);
  });
});

describe("build: Bun compiler sidecars", () => {
  test("snapshots legacy sidecars, leaves them untouched, and lets Vite see the same root", () => {
    const stale = `${ROOT}/${SIDECAR}`;
    const h = harness({ files: { [stale]: "OLD BUN SCRATCH" } });
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) h.files.write(join(cwd, SIDECAR), "NEW BUN SCRATCH");
      if (cwd === WEB && args.includes("--outDir")) expect(h.files.entries.get(stale)?.text).toBe("OLD BUN SCRATCH");
      return result;
    };

    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    expect(h.files.entries.get(stale)?.text).toBe("OLD BUN SCRATCH");
    expect(h.files.ops.some((op) => op.startsWith(`mv ${stale}`))).toBe(false);
    expect(h.exec.calls.some((call) => call.startsWith("git -C"))).toBe(false);
  });

  test("a new root sidecar emitted despite the sandbox aborts before Vite and preserves live artifacts", () => {
    const h = harness();
    const before = servedBundle(h.files);
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) h.files.write(`${ROOT}/${SIDECAR}`, "ESCAPED");
      return result;
    };

    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.exec.calls.some((call) => call.startsWith(`${WEB}$ bun run build`))).toBe(false);
    expect(servedBundle(h.files)).toEqual(before);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.io.stderr.join("\n")).toContain("new root-level Bun sidecar escaped");
  });

  test("a sandbox cleanup failure aborts before Vite and preserves live artifacts", () => {
    const h = harness();
    const before = servedBundle(h.files);
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) {
        const stuck = join(cwd, "stuck");
        h.files.write(stuck, "STUCK");
        h.files.undeletable.add(stuck);
      }
      return result;
    };

    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.exec.calls.some((call) => call.startsWith(`${WEB}$ bun run build`))).toBe(false);
    expect(servedBundle(h.files)).toEqual(before);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.io.stderr.join("\n")).toContain("could not clean Bun's compile sandbox");
  });
});

describe("build: real Git identity", () => {
  test("removes its fixture when setup's commit fails", () => {
    let root = "";
    expect(() =>
      withGitBuildFixture(
        () => {
          throw new Error("the failed commit must not invoke the fixture");
        },
        {
          commitArgs: ["commit", "--this-option-must-fail"],
          observeRoot: (created) => {
            root = created;
          },
        },
      ),
    ).toThrow();
    expect(root).not.toBe("");
    expect(existsSync(root)).toBe(false);
  });

  test("contains compiler cwd scratch before release build-info samples a clean checkout", () => {
    let fixtureRoot = "";
    withGitBuildFixture(
      (fixture) => {
        const { root } = fixture;
        const binary = join(root, "bin", "collie");
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, "OLD BINARY\n");
        mkdirSync(join(root, "web", "dist"), { recursive: true });
        writeFileSync(join(root, "web", "dist", "index.html"), "OLD BUNDLE\n");
        // The fixture HOME deliberately asks Git to sign commits. Its isolated Git environment
        // ignores that global config, and the tag is the exact release evidence Vite consumes.
        expect(readFileSync(join(fixture.home, ".gitconfig"), "utf8")).toContain("gpgSign = true");
        expect(git(fixture, ["tag", "--points-at", "HEAD"])).toBe(`v${vitePackageVersion(root)}`);
        expect(git(fixture, ["status", "--porcelain"])).toBe("");

        const h = hermeticBuild(fixture, EXIT.OK);
        expect(cmdBuild(h.deps)).toBe(EXIT.OK);

        expect(h.compilerCwds).toHaveLength(1);
        expect(h.compilerCwds[0]).toStartWith(bunCompileSandboxPrefix(realFiles.realpath(root)!));
        expect(h.identitySawCleanSandbox()).toBe(true);
        expect(h.webBuilds()).toBe(1);
        expect(hasCompilerSandbox(root)).toBe(false);
        expect(existsSync(join(root, SIDECAR))).toBe(false);
        expect(readdirSync(root).filter((name) => name.endsWith(".bun-build"))).toEqual([]);
        const info = JSON.parse(readFileSync(join(root, "web", "dist", "build-info.json"), "utf8"));
        expect(info).toMatchObject({ channel: "release", version: vitePackageVersion(root) });
        expect(info.sha).toBe(git(fixture, ["rev-parse", "--short", "HEAD"]));
        expect(info.id).toStartWith(`${info.version}+${info.sha}.`);
        expect(info.sha).not.toContain("-dirty");
        expect(info.id).not.toContain("-dirty");
        expect(git(fixture, ["status", "--porcelain"])).toBe("");
      },
      {
        observeRoot: (created) => {
          fixtureRoot = created;
        },
      },
    );
    expect(existsSync(fixtureRoot)).toBe(false);
  });

  test("keeps an ignored legacy Bun sidecar through the first fixed build", () => {
    withGitBuildFixture((fixture) => {
      const { root } = fixture;
      const binary = join(root, "bin", "collie");
      const legacy = join(root, SIDECAR);
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, "OLD BINARY\n");
      mkdirSync(join(root, "web", "dist"), { recursive: true });
      writeFileSync(join(root, "web", "dist", "index.html"), "OLD BUNDLE\n");
      writeFileSync(legacy, "LEGACY BUN SCRATCH\n");

      expect(git(fixture, ["check-ignore", "-q", "--", SIDECAR])).toBe("");
      expect(git(fixture, ["status", "--porcelain"])).toBe("");
      const h = hermeticBuild(fixture, EXIT.OK);
      expect(cmdBuild(h.deps)).toBe(EXIT.OK);

      expect(readFileSync(legacy, "utf8")).toBe("LEGACY BUN SCRATCH\n");
      expect(h.identitySawCleanSandbox()).toBe(true);
      expect(git(fixture, ["status", "--porcelain"])).toBe("");
    });
  });

  test("cleans a compiler scratch on failure and leaves the real source root and live artifacts alone", () => {
    let fixtureRoot = "";
    withGitBuildFixture(
      (fixture) => {
        const { root } = fixture;
        const binary = join(root, "bin", "collie");
        const liveBundle = join(root, "web", "dist", "index.html");
        mkdirSync(dirname(binary), { recursive: true });
        mkdirSync(dirname(liveBundle), { recursive: true });
        writeFileSync(binary, "OLD BINARY\n");
        writeFileSync(liveBundle, "OLD BUNDLE\n");

        const h = hermeticBuild(fixture, EXIT.FAIL);
        expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);

        expect(h.compilerCwds).toHaveLength(1);
        expect(h.compilerCwds[0]).toStartWith(bunCompileSandboxPrefix(realFiles.realpath(root)!));
        expect(h.webBuilds()).toBe(0);
        expect(hasCompilerSandbox(root)).toBe(false);
        expect(existsSync(join(root, SIDECAR))).toBe(false);
        expect(readdirSync(root).filter((name) => name.endsWith(".bun-build"))).toEqual([]);
        expect(readFileSync(binary, "utf8")).toBe("OLD BINARY\n");
        expect(readFileSync(liveBundle, "utf8")).toBe("OLD BUNDLE\n");
        expect(git(fixture, ["status", "--porcelain"])).toBe("");
      },
      {
        observeRoot: (created) => {
          fixtureRoot = created;
        },
      },
    );
    expect(existsSync(fixtureRoot)).toBe(false);
  });
});

describe("ensureBuild", () => {
  test("a built UI is left alone", () => {
    const h = harness();
    expect(ensureBuild(h.deps)).toBe(true);
    expect(h.exec.calls).toEqual([]);
  });

  test("builds on first run when web/dist is missing", () => {
    const h = harness();
    h.files.entries.delete(`${DIST}/index.html`);
    h.files.entries.delete(`${DIST}/assets/app.js`);
    expect(ensureBuild(h.deps)).toBe(true);
    expect(h.io.stdout.join("\n")).toContain("building web UI (first run)");
    expect(h.exec.calls).toContain(`${WEB}$ bun run build -- --outDir dist-staging --emptyOutDir`);
  });

  test("warns rather than fails when the build cannot run or does not work", () => {
    // The API runs and the UI 503s — a 503 is legible where a refused `start` is not.
    const noBun = harness({ absent: ["bun"], files: {} });
    noBun.files.entries.delete(`${DIST}/index.html`);
    expect(ensureBuild(noBun.deps)).toBe(false);
    expect(noBun.io.stderr.join("\n")).toContain("bun not found");

    const broken = harness({ answers: [[`${WEB}$ bun run build --`, { code: 1 }]] });
    broken.files.entries.delete(`${DIST}/index.html`);
    expect(ensureBuild(broken.deps)).toBe(false);
    expect(broken.io.stderr.join("\n")).toContain("the UI will 503");
  });
});
