import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { collieBinaryStaging } from "../cli/build.ts";
import { BINARY, capture, fakeExec, fakeFiles, ROOT } from "../cli/fakes.ts";

import { buildCli, parseCompileCliArgs } from "./build-cli.ts";

const root = join(import.meta.dir, "..");
// SAFETY: this checked-in manifest defines `scripts`; the assertions below verify the exact entries.
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const release = readFileSync(join(root, ".github", "workflows", "release.yml"), "utf8");
const aurVmTest = readFileSync(join(root, "packaging", "aur", "vm-install.test.sh"), "utf8");

describe("build-cli arguments", () => {
  test("keeps ordinary build:cli on the helper defaults", () => {
    expect(parseCompileCliArgs([])).toEqual({});
  });

  test("passes a release-selected Bun, target and artifact path through unchanged", () => {
    expect(
      parseCompileCliArgs([
        "--bun",
        "/tmp/upstream/bun",
        "--target",
        "bun-linux-x64-baseline",
        "--outfile",
        "/tmp/collie-1.9.1-linux-x64/bin/collie",
      ]),
    ).toEqual({
      bun: "/tmp/upstream/bun",
      target: "bun-linux-x64-baseline",
      outfile: "/tmp/collie-1.9.1-linux-x64/bin/collie",
    });
  });

  test("rejects incomplete or unrecognised overrides", () => {
    expect(() => parseCompileCliArgs(["--outfile"])).toThrow("--outfile needs a value");
    expect(() => parseCompileCliArgs(["--unknown", "value"])).toThrow("unknown argument: --unknown");
  });
});

function cliHarness() {
  const io = capture();
  const exec = fakeExec();
  const files = fakeFiles({ [BINARY]: "OLD BINARY" });
  const runIn = exec.runIn.bind(exec);
  exec.runIn = (tool, args, cwd, pathPrefix) => {
    const result = runIn(tool, args, cwd, pathPrefix);
    if (args.includes("--compile")) {
      const output = args[args.indexOf("--outfile") + 1];
      if (output === undefined) throw new Error("compiler invocation lacks --outfile");
      files.write(output, "NEW BINARY");
    }
    return result;
  };
  return { deps: { root: ROOT, io, exec, files }, io, exec, files };
}

const compilerOutfiles = (calls: readonly string[]): string[] =>
  calls
    .filter((call) => call.includes(" build --compile "))
    .map((call) => call.slice(call.lastIndexOf("--outfile ") + "--outfile ".length));

describe("build:cli publication", () => {
  test("publishes the default output only after a unique staged compile", () => {
    const h = cliHarness();

    expect(buildCli(h.deps, { bun: "bun" })).toBe(true);
    const [outfile] = compilerOutfiles(h.exec.calls);
    expect(outfile).toStartWith(`${ROOT}/bin/.collie-cli-`);
    expect(outfile).toEndWith("/collie");
    expect(outfile).not.toBe(collieBinaryStaging(ROOT));
    expect(h.files.entries.get(BINARY)?.text).toBe("NEW BINARY");
    expect(h.files.ops).toContain(`mv ${outfile} ${BINARY}`);
    expect(h.files.ops).not.toContain(`rm -rf ${collieBinaryStaging(ROOT)}`);
  });

  test("keeps the old live binary when compile verification finds a new root sidecar", () => {
    const h = cliHarness();
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) h.files.write(`${ROOT}/.new.bun-build`, "ESCAPED");
      return result;
    };

    expect(buildCli(h.deps, { bun: "bun" })).toBe(false);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.files.ops.some((op) => op.startsWith(`mv ${ROOT}/bin/.collie-cli-`))).toBe(false);
    expect(h.io.stderr.join("\n")).toContain("new root-level Bun sidecar escaped");
  });

  test("keeps the old live binary when compiler sandbox cleanup fails", () => {
    const h = cliHarness();
    const runIn = h.exec.runIn.bind(h.exec);
    h.exec.runIn = (tool, args, cwd, pathPrefix) => {
      const result = runIn(tool, args, cwd, pathPrefix);
      if (args.includes("--compile")) {
        const stuck = `${cwd}/stuck`;
        h.files.write(stuck, "STUCK");
        h.files.undeletable.add(stuck);
      }
      return result;
    };

    expect(buildCli(h.deps, { bun: "bun" })).toBe(false);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.files.ops.some((op) => op.startsWith(`mv ${ROOT}/bin/.collie-cli-`))).toBe(false);
    expect(h.io.stderr.join("\n")).toContain("could not clean Bun's compile sandbox");
  });

  test("keeps the old live binary and removes only its staging directory when publication fails", () => {
    const h = cliHarness();
    h.files.unrenamable.add(BINARY);

    expect(buildCli(h.deps, { bun: "bun" })).toBe(false);
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.files.ops.some((op) => op.startsWith(`rm -rf ${ROOT}/bin/.collie-cli-`))).toBe(true);
    expect(h.io.stderr.join("\n")).toContain("could not publish");
  });

  test("uses separate output staging paths for overlapping helpers and never uses collie.new", () => {
    const h = cliHarness();
    expect(buildCli(h.deps, { bun: "bun" })).toBe(true);
    expect(buildCli(h.deps, { bun: "bun" })).toBe(true);

    const outfiles = compilerOutfiles(h.exec.calls);
    expect(outfiles).toHaveLength(2);
    expect(new Set(outfiles).size).toBe(2);
    expect(outfiles.every((outfile) => outfile.startsWith(`${ROOT}/bin/.collie-cli-`))).toBe(true);
    expect(outfiles).not.toContain(collieBinaryStaging(ROOT));
    expect(h.files.ops.some((op) => op.includes(collieBinaryStaging(ROOT)))).toBe(false);
  });

  test("leaves an unowned previous output sandbox alone", () => {
    const previous = `${ROOT}/bin/.collie-cli-previous/sentinel`;
    const h = cliHarness();
    h.files.write(previous, "UNOWNED");

    expect(buildCli(h.deps, { bun: "bun" })).toBe(true);
    expect(h.files.entries.get(previous)?.text).toBe("UNOWNED");
    expect(h.files.ops).not.toContain(`rm -rf ${ROOT}/bin/.collie-cli-previous`);
  });

  test("preserves an explicit artifact path without publishing the live binary", () => {
    const h = cliHarness();
    const artifact = "/artifacts/collie";

    expect(buildCli(h.deps, { bun: "/tool/bun", target: "bun-linux-x64", outfile: artifact })).toBe(true);
    expect(compilerOutfiles(h.exec.calls)).toEqual([artifact]);
    expect(h.files.entries.get(artifact)?.text).toBe("NEW BINARY");
    expect(h.files.entries.get(BINARY)?.text).toBe("OLD BINARY");
    expect(h.files.ops.some((op) => op.endsWith(` ${BINARY}`))).toBe(false);
  });
});

describe("release and AUR local-binary compile routes", () => {
  test("the package CLI-only command delegates to build-cli", () => {
    expect(packageJson.scripts.build).toBe("bun run cli/main.ts build");
    expect(packageJson.scripts["build:cli"]).toBe("bun run scripts/build-cli.ts");
  });

  test("the release passes its selected Bun, target and artifact path to build-cli", () => {
    expect(release).toMatch(
      /bun run scripts\/build-cli\.ts \\\n            --bun "\$upstream_bun" \\\n            --target "\$BUN_TARGET" \\\n            --outfile "\$stage\/bin\/collie"/,
    );
    expect(release).not.toMatch(/^\s*"\$upstream_bun" build --compile/m);
  });

  test("the AUR VM instruction keeps its local artifact on build-cli", () => {
    expect(aurVmTest).toContain("bun run scripts/build-cli.ts --target bun --outfile /tmp/collie-local");
    expect(aurVmTest).not.toMatch(/^#\s+bun build --compile/m);
  });
});
