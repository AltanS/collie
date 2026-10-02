import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  lookupPriorWindowsRelease,
  priorWindowsRelease,
  RELEASES_JQ,
  WINDOWS_ASSET_MANDATORY_FROM,
  windowsFiles,
  windowsNotes,
  windowsTolerance,
  windowsVerdict,
  type GhRunner,
  type PriorWindowsRelease,
} from "./windows-asset.ts";

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

describe("the tolerance closes on its own", () => {
  const BEFORE = new Date("2026-11-14T23:59:59Z");
  const ON = new Date(`${WINDOWS_ASSET_MANDATORY_FROM}T00:00:00Z`);
  const answer = (prior: PriorWindowsRelease) => () => prior;
  const line = (tag: string, assets: string[], extra: { draft?: boolean; prerelease?: boolean } = {}) =>
    [tag, String(extra.draft ?? false), String(extra.prerelease ?? false), assets.join(",")].join("\t");

  test("the date is one constant, 2026-11-15", () => {
    expect(WINDOWS_ASSET_MANDATORY_FROM).toBe("2026-11-15");
  });

  test("before the date, with no earlier Windows zip, a missing asset is optional", () => {
    const t = windowsTolerance(BEFORE, answer({ kind: "none" }));
    expect(t).toEqual({ optional: true, dateOnly: false, why: expect.stringContaining("no earlier release") });
  });

  test("on and after the date it is mandatory, and GitHub is not asked", () => {
    for (const now of [ON, new Date("2027-03-01T12:00:00Z")]) {
      let asked = 0;
      const t = windowsTolerance(now, () => {
        asked++;
        return { kind: "none" };
      });
      expect(t.optional).toBe(false);
      expect(t.why).toContain(`on or after ${WINDOWS_ASSET_MANDATORY_FROM}`);
      expect(asked).toBe(0);
    }
  });

  test("an earlier release with the Windows zip makes it mandatory before the date", () => {
    const t = windowsTolerance(BEFORE, answer({ kind: "found", tag: "v1.16.0" }));
    expect(t.optional).toBe(false);
    expect(t.why).toBe("release v1.16.0 already carries the Windows zip");
  });

  test("an API that does not answer falls back to the date rule, and says so", () => {
    const failing: GhRunner = () => ({ code: 1, stdout: "", stderr: "HTTP 502: Bad Gateway\nmore" });
    const before = windowsTolerance(BEFORE, () => lookupPriorWindowsRelease("AltanS/collie", "v1.16.0", failing));
    expect(before.optional).toBe(true);
    expect(before.dateOnly).toBe(true);
    expect(before.why).toContain("the releases API did not answer (gh api exited 1: HTTP 502: Bad Gateway)");
    expect(before.why).toContain("the date rule alone decides");
    expect(windowsTolerance(ON, () => lookupPriorWindowsRelease("AltanS/collie", "v1.16.0", failing)).optional).toBe(false);
  });

  test("a gh that cannot start, or a timeout, is an API that did not answer", () => {
    const missing: GhRunner = () => {
      throw new Error("Executable not found in $PATH: \"gh\"");
    };
    expect(lookupPriorWindowsRelease("o/r", "v1.0.0", missing)).toEqual({
      kind: "unknown",
      reason: 'gh did not start: Executable not found in $PATH: "gh"',
    });
    const killed: GhRunner = () => ({ code: null, stdout: "", stderr: "" });
    expect(lookupPriorWindowsRelease("o/r", "v1.0.0", killed)).toEqual({
      kind: "unknown",
      reason: "gh api exited on a signal or timeout",
    });
  });

  test("the lookup asks every page of the repository's releases through gh api", () => {
    const seen: (readonly string[])[] = [];
    const gh: GhRunner = (args) => {
      seen.push(args);
      return { code: 0, stdout: `${line("v1.15.0", ["collie-1.15.0-linux-x64.tar.gz"])}\n`, stderr: "" };
    };
    expect(lookupPriorWindowsRelease("AltanS/collie", "v1.16.0", gh)).toEqual({ kind: "none" });
    expect(seen).toEqual([["api", "--paginate", "repos/AltanS/collie/releases?per_page=100", "--jq", RELEASES_JQ]]);
  });

  test("a published release with the zip counts; a draft, a prerelease and this very tag do not", () => {
    const zip = (v: string) => [`collie-${v}-linux-x64.tar.gz`, `collie-${v}-windows-x64.zip`, `collie-${v}-windows-x64.zip.sha256`];
    expect(priorWindowsRelease([line("v1.17.0", zip("1.17.0")), line("v1.16.0", zip("1.16.0"))].join("\n"), "v1.18.0")).toEqual({
      kind: "found",
      tag: "v1.17.0",
    });
    const ignored = [
      line("v1.17.0", zip("1.17.0")),
      line("v1.17.0-rc.1", zip("1.17.0-rc.1"), { prerelease: true }),
      line("v1.18.0", zip("1.18.0"), { draft: true }),
      line("v1.15.0", ["collie-1.15.0-linux-x64.tar.gz", "collie-1.15.0-windows-x64.zip.sha256"]),
      "",
    ].join("\n");
    expect(priorWindowsRelease(ignored, "v1.17.0")).toEqual({ kind: "none" });
    expect(priorWindowsRelease("", "v1.17.0")).toEqual({ kind: "none" });
  });

  test("an answer that is not one release per line is unknown, never a decision", () => {
    expect(priorWindowsRelease('[{"tag_name":"v1"}]', "v2").kind).toBe("unknown");
    expect(priorWindowsRelease("v1\tyes\tfalse\tcollie-1-windows-x64.zip", "v2").kind).toBe("unknown");
    expect(priorWindowsRelease(`${line("v1", [])}\textra`, "v2").kind).toBe("unknown");
    // A good line first does not rescue a broken one after it.
    expect(priorWindowsRelease(`${line("v1", ["a"])}\nnot a line`, "v2").kind).toBe("unknown");
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
  // No `--repo`, so these runs never reach GitHub: the date rule alone decides, through `--now`.
  const BEFORE = "2026-10-03T12:00:00Z";
  const AFTER = `${WINDOWS_ASSET_MANDATORY_FROM}T00:00:00Z`;
  const run = (dir: string, result: string, now: string) => {
    const out = join(dir, "github-output");
    const p = Bun.spawnSync(
      ["bun", join(import.meta.dir, "windows-asset.ts"), "--dir", dir, "--version", "9.9.9", "--result", result, "--now", now],
      { env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(dir, "summary") } },
    );
    return { code: p.exitCode, out: p.stdout.toString(), github: existsSync(out) ? readFileSync(out, "utf8") : "" };
  };
  const f = windowsFiles("9.9.9");

  test("a partial set after a failed job is removed whole, and the run warns and goes on", () => {
    const dir = assets();
    writeFileSync(join(dir, f.zip), "zip bytes");
    const r = run(dir, "failure", BEFORE);
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning title=No Windows asset::");
    expect(r.out).toContain("::notice title=Windows asset tolerance::the releases API did not answer (no --repo was given)");
    expect(r.out).toContain("Windows asset optional:");
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
    const r = run(dir, "success", AFTER);
    expect(r.code).toBe(0);
    expect(r.github).toBe("present=true\n");
    expect(existsSync(join(dir, f.zip))).toBe(true);
  });

  test("a missing set after a SUCCESSFUL job fails the run with an error", () => {
    const r = run(assets(), "success", BEFORE);
    expect(r.code).toBe(1);
    expect(r.out).toContain("::error title=Windows asset::");
  });

  test("from the date on, a failed job without its asset fails the run", () => {
    const r = run(assets(), "failure", AFTER);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`Windows asset mandatory: it is ${WINDOWS_ASSET_MANDATORY_FROM}, on or after`);
    expect(r.out).toContain("the Windows asset is no longer optional");
    expect(r.github).toBe("present=false\n");
  });
});
