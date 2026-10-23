// Tests of web/e2e/rig/bins.ts: where the leg finds pi, and where pi's example extensions are. No rig,
// no browser. The files are made in a temp dir. It sits in scripts/ for the reason browser-leg-nightly.test.ts gives.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { inNvm, onPath, piExamplesDir, piExtensions } from "../web/e2e/rig/bins";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bins-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function exe(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\n");
  chmodSync(path, 0o755);
  return path;
}

describe("onPath", () => {
  test("skips a node_modules/.bin entry at any depth, however it ends", () => {
    exe(join(root, "home", "node_modules", ".bin"), "pi");
    exe(join(root, "proj", "web", "node_modules", ".bin"), "pi");
    const real = exe(join(root, "nvm", "bin"), "pi");
    const pathVar = [join(root, "home", "node_modules", ".bin") + "/", join(root, "proj", "web", "node_modules", ".bin"), join(root, "nvm", "bin")].join(delimiter);
    expect(onPath("pi", pathVar)).toBe(real);
  });

  test("returns null when only a node_modules/.bin entry has it", () => {
    exe(join(root, "node_modules", ".bin"), "pi");
    expect(onPath("pi", join(root, "node_modules", ".bin"))).toBeNull();
  });

  test("keeps a directory whose name only looks alike", () => {
    const near = exe(join(root, "my_node_modules", ".bin"), "pi");
    expect(onPath("pi", join(root, "my_node_modules", ".bin"))).toBe(near);
  });
});

describe("inNvm", () => {
  test("takes the newest version that holds the binary and skips a version whose link is dead", () => {
    const old = exe(join(root, "v22.9.0", "bin"), "pi");
    const mid = exe(join(root, "v24.9.0", "bin"), "pi");
    mkdirSync(join(root, "v24.22.1", "bin"), { recursive: true });
    symlinkSync(join(root, "gone"), join(root, "v24.22.1", "bin", "pi"));
    expect(inNvm("pi", root)).toBe(mid);
    rmSync(join(root, "v24.9.0"), { recursive: true });
    expect(inNvm("pi", root)).toBe(old);
  });

  test("sorts versions by number, not by text", () => {
    exe(join(root, "v9.0.0", "bin"), "pi");
    const newest = exe(join(root, "v24.0.0", "bin"), "pi");
    expect(inNvm("pi", root)).toBe(newest);
  });

  test("returns null when the folder is missing or holds no binary", () => {
    expect(inNvm("pi", join(root, "none"))).toBeNull();
    mkdirSync(join(root, "v24.0.0", "bin"), { recursive: true });
    expect(inNvm("pi", root)).toBeNull();
  });
});

/** A pi package laid out as the node version manager installs it, with a link in bin/. */
interface PiInstall {
  readonly bin: string;
  readonly pkg: string;
}

function installPi(packageName: string): PiInstall {
  const pkg = join(root, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(pkg, "dist", "bundle"), { recursive: true });
  mkdirSync(join(pkg, "examples", "extensions"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: packageName }));
  writeFileSync(join(pkg, "dist", "bundle", "cli.js"), "");
  mkdirSync(join(root, "elsewhere"), { recursive: true });
  const bin = join(root, "elsewhere", "pi");
  symlinkSync(join(pkg, "dist", "bundle", "cli.js"), bin);
  return { bin, pkg };
}

describe("piExamplesDir", () => {
  test("walks up from the real path of the binary to the package root", () => {
    const { bin, pkg } = installPi("@earendil-works/pi-coding-agent");
    expect(piExamplesDir(bin)).toBe(join(pkg, "examples", "extensions"));
  });

  test("falls back to the guess beside the binary when the package name differs", () => {
    const { bin } = installPi("something-else");
    expect(piExamplesDir(bin)).toBe(join(bin, "..", "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions"));
  });

  test("falls back when the binary does not exist", () => {
    const bin = join(root, "gone", "bin", "pi");
    expect(piExamplesDir(bin)).toBe(join(root, "gone", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "examples", "extensions"));
  });
});

describe("piExtensions", () => {
  test("returns the files that exist and no note", () => {
    const { bin, pkg } = installPi("@earendil-works/pi-coding-agent");
    writeFileSync(join(pkg, "examples", "extensions", "question.ts"), "");
    writeFileSync(join(pkg, "examples", "extensions", "permission-gate.ts"), "");
    const found = piExtensions(bin, ["question.ts", "permission-gate.ts"]);
    expect(found.paths).toHaveLength(2);
    expect(found.notes).toEqual([]);
  });

  test("names the missing files and the folder it tried", () => {
    const { bin, pkg } = installPi("@earendil-works/pi-coding-agent");
    writeFileSync(join(pkg, "examples", "extensions", "question.ts"), "");
    const found = piExtensions(bin, ["question.ts", "permission-gate.ts"]);
    expect(found.paths).toEqual([join(pkg, "examples", "extensions", "question.ts")]);
    expect(found.notes).toEqual([`pi examples not found at ${join(pkg, "examples", "extensions")}: permission-gate.ts missing`]);
  });
});
