import { describe, expect, test } from "bun:test";

import {
  type BuildDeps,
  cmdBuild,
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

// `build` against the two seams. What is asserted here is ORDER and the swap invariant: the shell
// got both right by accident of `set -e` plus a trailing `mv`, and a port that merely produced the
// same artifacts on the happy path would silently lose the property that matters — a build that
// fails leaves the previously served `web/dist` byte-identical.

const WEB = `${ROOT}/web`;
const DIST = webDist(ROOT);
const STAGING = webStaging(ROOT);
const BINARY_NEW = collieBinaryStaging(ROOT);
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

describe("build: the five ordered steps", () => {
  test("gate → install both trees → typecheck both sides → compile the CLI → build the web UI", () => {
    const h = harness();
    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toEqual([
      `${ROOT}$ bash ${GATE}`,
      `${ROOT}$ bun install`,
      `${WEB}$ bun install`,
      `${ROOT}$ bun run typecheck`,
      `${WEB}$ bun run typecheck`,
      `${ROOT}$ bun build --compile --target=bun ./cli/main.ts --outfile ${BINARY_NEW}`,
      `${WEB}$ bun run build -- --outDir dist-staging --emptyOutDir`,
    ]);
  });

  test("the swaps are LAST, and both are renames", () => {
    const h = harness({ files: { [`${STAGING}/index.html`]: "<!doctype html>NEW" } });
    // The staging dir is cleared before the build writes it, and the two swaps come after every
    // step that can fail.
    expect(cmdBuild(h.deps)).toBe(EXIT.OK);
    expect(h.files.ops).toEqual([
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
    const compile = h.exec.calls.find((c) => c.includes("--compile"))!;
    expect(compile).toContain(`--outfile ${BINARY_NEW}`);
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

  test("bun missing is a legible hard failure, not an ENOENT", () => {
    const h = harness({ absent: ["bun"] });
    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("bun not found");
    expect(h.exec.calls).toEqual([]);
    expect(h.files.ops).toEqual([]);
  });
});

describe("build: a failure never empties the live web/dist", () => {
  const cases: [name: string, prefix: string][] = [
    ["the version gate", `${ROOT}$ bash ${GATE}`],
    ["the root install", `${ROOT}$ bun install`],
    ["the web typecheck", `${WEB}$ bun run typecheck`],
    ["the CLI compile", `${ROOT}$ bun build --compile`],
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

  test("a failed web build leaves no half-compiled binary lying around", () => {
    const h = harness({
      answers: [[`${WEB}$ bun run build --`, { code: 1 }]],
      files: { [BINARY_NEW]: "HALF" },
    });
    expect(cmdBuild(h.deps)).toBe(EXIT.FAIL);
    expect(h.files.entries.has(BINARY_NEW)).toBe(false);
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
