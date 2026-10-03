import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// The two invariants of M43 spec 06 that only the workflow file holds, read as YAML (Bun's own
// parser), so a reformat cannot fool them and a moved line cannot hide from them:
//   1. the Linux and macOS rows stay in `payload`, with `fail-fast: true`, exactly as they were;
//   2. Windows builds in a job of its own, and `release` runs when that job failed or was skipped,
//      but never when a `payload` row failed.
// What GitHub does with these conditions was checked once on a throwaway branch (2026-10-02); this
// keeps the file saying what was checked.

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, string>;
  readonly env?: Record<string, string>;
}

interface Job {
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly "runs-on"?: string;
  readonly "timeout-minutes"?: number;
  readonly strategy?: {
    readonly "fail-fast"?: boolean;
    readonly matrix?: { readonly include?: readonly Record<string, string>[] };
  };
  readonly steps?: readonly Step[];
}

const text = readFileSync(join(import.meta.dir, "..", ".github", "workflows", "release.yml"), "utf8").replaceAll(
  "\r\n",
  "\n",
);
// SAFETY: `Bun.YAML.parse` answers plain data. Every field read below is compared against a literal,
// so a missing or differently shaped one fails the assertion that reads it.
const jobs = (Bun.YAML.parse(text) as { jobs: Record<string, Job> }).jobs;
const job = (name: string): Job => {
  const found = jobs[name];
  if (found === undefined) throw new Error(`release.yml has no job ${name}`);
  return found;
};
const scripts = (j: Job): string => (j.steps ?? []).map((s) => s.run ?? "").join("\n");

describe("release.yml: the Linux and macOS rows", () => {
  test("stay in `payload`, behind the gate, with fail-fast true and the same three rows", () => {
    const payload = job("payload");
    expect(payload.needs).toBe("gate");
    expect(payload.strategy?.["fail-fast"]).toBe(true);
    expect(payload.strategy?.matrix?.include).toEqual([
      { platform: "linux-x64", "runs-on": "ubuntu-latest", "bun-target": "bun-linux-x64-baseline" },
      { platform: "macos-arm64", "runs-on": "macos-14", "bun-target": "bun-darwin-arm64" },
      { platform: "linux-arm64", "runs-on": "ubuntu-24.04-arm", "bun-target": "bun-linux-arm64" },
    ]);
  });
});

describe("release.yml: the Windows payload", () => {
  test("is a job of its own, behind the gate, on windows-latest, bounded to 15 minutes", () => {
    const windows = job("payload-windows");
    expect(windows.needs).toBe("gate");
    expect(windows["runs-on"]).toBe("windows-latest");
    expect(windows["timeout-minutes"]).toBe(15);
    expect(windows.strategy?.["fail-fast"]).toBe(false);
    expect(windows.strategy?.matrix?.include).toEqual([{ platform: "windows-x64" }]);
  });

  test("builds with the one script the VM runs, on the pinned Bun, and publishes nothing itself", () => {
    const windows = job("payload-windows");
    expect(scripts(windows)).toContain("scripts\\build-windows-payload.ps1");
    expect(scripts(windows)).toContain("-StrictBun");
    expect(scripts(windows)).not.toMatch(/\bnix (develop|build)\b/);
    expect((windows.steps ?? []).some((s) => s.uses?.includes("nix-installer") === true)).toBe(false);
    expect(scripts(windows)).not.toContain("gh release");
    // The pinned Bun is fetched and checked against its release's SHASUMS256.txt; no setup action.
    expect(scripts(windows)).toContain("SHASUMS256.txt");
    expect((windows.steps ?? []).some((s) => s.uses?.includes("setup-bun") === true)).toBe(false);
    expect(scripts(windows)).toContain('[[ "$v" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+$ ]]');
    const upload = (windows.steps ?? []).find((s) => s.uses?.startsWith("actions/upload-artifact@") === true);
    // The name the release job's `payload-*` pattern collects.
    expect(upload?.with?.name).toBe("payload-${{ matrix.platform }}");
    const download = (job("release").steps ?? []).find((s) => s.uses?.startsWith("actions/download-artifact@") === true);
    expect(download?.with?.pattern).toBe("payload-*");
  });
});

describe("release.yml: a Windows failure never stops a release", () => {
  test("`release` needs both payload jobs, and runs unless a `payload` row failed or the run was cancelled", () => {
    const release = job("release");
    expect(release.needs).toEqual(["payload", "payload-windows"]);
    expect(release.if).toBe("${{ !cancelled() && needs.payload.result == 'success' }}");
  });

  test("the asset check runs the tested script, which alone decides when the tolerance closes", () => {
    // The verdicts themselves (warn on failure/skipped/cancelled, fail on a lost asset after
    // success, fail with the tolerance closed) and the closing rule (the date, an earlier release
    // with the zip, an API that does not answer, the override) are pinned in scripts/windows-asset.test.ts.
    const step = (job("release").steps ?? []).find((s) => s.name === "Check for the Windows asset");
    expect(step?.id).toBe("windows");
    expect(step?.run).toContain("bun scripts/windows-asset.ts --dir");
    expect(step?.run).toContain('--result "$WINDOWS_RESULT" --repo "$GITHUB_REPOSITORY"');
    // The escape: a repository variable, read by the workflow, passed through untouched.
    expect(step?.env?.WINDOWS_ASSET_OVERRIDE).toBe("${{ vars.COLLIE_WINDOWS_ASSET_OVERRIDE }}");
    expect(step?.run).toContain('--override "$WINDOWS_ASSET_OVERRIDE"');
    expect(step?.env?.WINDOWS_RESULT).toBe("${{ needs.payload-windows.result }}");
    // The same token the gate job hands `gh`; the script asks the releases API with it.
    expect(step?.env?.GH_TOKEN).toBe("${{ github.token }}");
    // No second copy of the rule: no switch, no date, no `--optional`.
    expect(text).not.toContain("WINDOWS_ASSET_OPTIONAL");
    expect(text).not.toContain("--optional");
    expect(text).not.toContain("2026-11-15");
  });

  test("the release notes keep the script's whole body and only append the Windows block", () => {
    const step = (job("release").steps ?? []).find((s) => s.id === "notes");
    const run = step?.run ?? "";
    const body = run.indexOf('"${previous[@]}" > "$notes"');
    const block = run.indexOf('bun scripts/windows-asset.ts --notes "$WINDOWS_PRESENT" >> "$notes"');
    expect(run).toContain("nix develop --command bun scripts/release-notes.ts \\");
    expect(body).toBeGreaterThan(0);
    expect(block).toBeGreaterThan(body);
    expect(step?.env?.WINDOWS_PRESENT).toBe("${{ steps.windows.outputs.present }}");
  });

  test("the jobs after `release` read its result by name, so a failed Windows job does not skip them", () => {
    for (const name of ["notify-website", "refresh-packages"]) {
      expect(job(name).needs).toBe("release");
      expect(job(name).if).toBe("${{ !cancelled() && needs.release.result == 'success' && !contains(github.ref_name, '-') }}");
    }
  });
});
