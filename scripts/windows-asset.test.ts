import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { windowsFiles, windowsNotes, windowsVerdict } from "./windows-asset.ts";

const D = "a".repeat(64);
const ZIP = "collie-9.9.9-windows-x64.zip";
const whole = { zip: D, sidecar: D, entry: D };
const none = { zip: null, sidecar: null, entry: null };

describe("the Windows asset verdict", () => {
  test("a whole set whose three digests agree is present, whatever the tolerance", () => {
    expect(windowsVerdict(whole, "success", true, ZIP)).toEqual({ kind: "present" });
    expect(windowsVerdict(whole, "success", false, ZIP)).toEqual({ kind: "present" });
  });

  test("a whole set that disagrees with itself fails the release", () => {
    expect(windowsVerdict({ ...whole, sidecar: "b".repeat(64) }, "success", true, ZIP).kind).toBe("fail");
    expect(windowsVerdict({ ...whole, entry: "" }, "success", true, ZIP).kind).toBe("fail");
  });

  test("a job that SUCCEEDED and lost its asset is a bug: it fails, even with the tolerance on", () => {
    for (const set of [none, { ...whole, sidecar: null }, { ...whole, entry: null }]) {
      const v = windowsVerdict(set, "success", true, ZIP);
      expect(v.kind).toBe("fail");
      expect(v.kind === "fail" ? v.reason : "").toContain("bug in this pipeline");
    }
  });

  test("a failed, skipped or cancelled Windows job warns while the tolerance is on", () => {
    for (const result of ["failure", "skipped", "cancelled"]) {
      const v = windowsVerdict(none, result, true, ZIP);
      expect(v.kind).toBe("warn");
      expect(v.kind === "warn" ? v.reason : "").toContain(`payload-windows: ${result}`);
    }
  });

  test("with the tolerance off, a missing asset fails the release", () => {
    for (const result of ["failure", "skipped", "cancelled"]) {
      expect(windowsVerdict(none, result, false, ZIP).kind).toBe("fail");
    }
  });
});

describe("the release-notes block", () => {
  test("says what the zip is when it is there, and that it was not built when it is not", () => {
    expect(windowsNotes(true)).toBe(
      "Windows zip: experimental, unsigned, for testing only. There is no installer yet. Windows 11 Smart App Control may block it and that cannot be overridden. Linux and macOS are not affected.",
    );
    expect(windowsNotes(false)).toBe("The Windows zip was not built for this release.");
    expect(`${windowsNotes(true)}${windowsNotes(false)}`).not.toContain("http");
  });
});

describe("the script, as the release job runs it", () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const assets = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "collie-windows-asset-"));
    made.push(dir);
    writeFileSync(join(dir, "collie-9.9.9-linux-x64.tar.gz"), "linux");
    return dir;
  };
  const run = (dir: string, result: string, optional: string) => {
    const out = join(dir, "github-output");
    const p = Bun.spawnSync(
      ["bun", join(import.meta.dir, "windows-asset.ts"), "--dir", dir, "--version", "9.9.9", "--result", result, "--optional", optional],
      { env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, "summary") } },
    );
    return { code: p.exitCode, out: p.stdout.toString(), github: existsSync(out) ? readFileSync(out, "utf8") : "" };
  };
  const f = windowsFiles("9.9.9");

  test("a partial set after a failed job is removed whole, and the run warns and goes on", () => {
    const dir = assets();
    writeFileSync(join(dir, f.zip), "zip bytes");
    const r = run(dir, "failure", "true");
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning title=No Windows asset::");
    expect(r.github).toBe("present=false\n");
    expect(existsSync(join(dir, f.zip))).toBe(false);
    expect(existsSync(join(dir, "collie-9.9.9-linux-x64.tar.gz"))).toBe(true);
  });

  test("a whole set stays and is reported present", () => {
    const dir = assets();
    writeFileSync(join(dir, f.zip), "zip bytes");
    const digest = new Bun.CryptoHasher("sha256").update("zip bytes").digest("hex");
    writeFileSync(join(dir, f.sidecar), `${digest}  ${f.zip}\n`);
    writeFileSync(join(dir, f.entry), JSON.stringify({ name: f.zip, sha256: digest }));
    const r = run(dir, "success", "true");
    expect(r.code).toBe(0);
    expect(r.github).toBe("present=true\n");
    expect(existsSync(join(dir, f.zip))).toBe(true);
  });

  test("a missing set after a SUCCESSFUL job fails the run with an error", () => {
    const r = run(assets(), "success", "true");
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error title=Windows asset::");
  });
});
