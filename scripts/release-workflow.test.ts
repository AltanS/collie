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
  readonly shell?: string;
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
  test("stay in `payload`, behind the gate, with fail-fast true and the same four rows", () => {
    const payload = job("payload");
    expect(payload.needs).toBe("gate");
    expect(payload.strategy?.["fail-fast"]).toBe(true);
    expect(payload.strategy?.matrix?.include).toEqual([
      { platform: "linux-x64", "runs-on": "ubuntu-latest", "bun-target": "bun-linux-x64-baseline" },
      { platform: "macos-arm64", "runs-on": "macos-15", "bun-target": "bun-darwin-arm64" },
      { platform: "linux-arm64", "runs-on": "ubuntu-24.04-arm", "bun-target": "bun-linux-arm64" },
      { platform: "macos-x64", "runs-on": "macos-15", "bun-target": "bun-darwin-x64-baseline" },
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

describe("release.yml: an Edge tag (M60 spec 01)", () => {
  const stamp = 'bun scripts/release-version.ts --tag "$GITHUB_REF_NAME" --stamp';

  test("matches the same trigger as a Stable tag", () => {
    // SAFETY: plain data from Bun's YAML parser, compared against literals below.
    const on = (Bun.YAML.parse(text) as { on: { push: { tags: string[] } } }).on;
    expect(on.push.tags).toEqual(["v*.*.*"]);
    // GitHub's glob: `*` crosses everything but `/`, so `v1.23.0-edge.1` is `v` `1` `.` `23` `.` `0-edge.1`.
    const glob = new RegExp(`^${on.push.tags[0]?.replaceAll(".", "\\.").replaceAll("*", "[^/]*") ?? ""}$`);
    expect(glob.test("v1.23.0-edge.1")).toBe(true);
    expect(glob.test("v1.23.0")).toBe(true);
  });

  test("every job that builds stamps the tag's version before the version gate reads the files", () => {
    const build = scripts(job("payload"));
    expect(build).toContain(stamp);
    expect(build.indexOf(stamp)).toBeLessThan(build.indexOf("bash scripts/check-version.sh"));
    expect(build.indexOf(stamp)).toBeLessThan(build.indexOf("bun run build"));

    const windows = job("payload-windows").steps ?? [];
    const windowsStamp = windows.findIndex((s) => s.run === stamp);
    const windowsBuild = windows.findIndex((s) => s.run?.includes("scripts\\build-windows-payload.ps1") === true);
    expect(windowsStamp).toBeGreaterThan(0);
    expect(windows[windowsStamp]?.shell).toBe("bash");
    expect(windowsStamp).toBeLessThan(windowsBuild);

    const release = job("release").steps ?? [];
    const releaseStamp = release.findIndex((s) => s.run === `nix develop --command ${stamp}`);
    const webDist = release.findIndex((s) => s.name === "Build and package web/dist");
    expect(releaseStamp).toBeGreaterThan(0);
    expect(releaseStamp).toBeLessThan(webDist);
  });

  test("publishes as a pre-release that never takes the Latest badge, and the site and packages stay home", () => {
    const create = (job("release").steps ?? []).find((s) => s.name === "Create GitHub release");
    expect(create?.run).toContain("case \"$GITHUB_REF_NAME\" in *-*) flags=(--prerelease --latest=false) ;; esac");
    // The manifest's `prerelease` follows the same hyphen.
    expect(scripts(job("release"))).toContain('case "$GITHUB_REF_NAME" in *-*) prerelease=true ;; esac');
    for (const name of ["notify-website", "refresh-packages"]) expect(job(name).if).toContain("!contains(github.ref_name, '-')");
  });

  test("the sidecar is the same step for both lines, handed the tag's whole version", () => {
    const reading = (job("release").steps ?? []).find((s) => s.name === "Write the release reading");
    expect(reading?.run).toContain('version="${GITHUB_REF_NAME#v}"');
    expect(reading?.run).toContain('bun scripts/release-reading.ts --version "$version"');
  });

  test("a Stable page compares against the Stable release before it, never its Edge builds", () => {
    const notes = (job("release").steps ?? []).find((s) => s.id === "notes");
    expect(notes?.run).toContain("case \"$GITHUB_REF_NAME\" in *-edge.*) ;; *) exclude=(--exclude '*-edge.*') ;; esac");
    expect(notes?.run).toContain(`git describe --tags --abbrev=0 --match 'v*' "\${exclude[@]}" "\${GITHUB_REF_NAME}^"`);
  });
});

// ADR 0132: the math engines are one release asset the host downloads, and no install carries them.
describe("release.yml: the math pack", () => {
  const steps = job("release").steps ?? [];
  const step = (name: string): Step => {
    const found = steps.find((s) => s.name === name);
    if (found === undefined) throw new Error(`the release job has no step ${name}`);
    return found;
  };
  const at = (name: string): number => steps.findIndex((s) => s.name === name);

  test("every payload drops web/dist/math after it copies web/dist, and so does the Windows script", () => {
    const build = scripts(job("payload"));
    expect(build.indexOf('rm -rf "$stage/web/dist/math"')).toBeGreaterThan(build.indexOf('cp -R web/dist "$stage/web/dist"'));
    const ps1 = readFileSync(join(import.meta.dir, "build-windows-payload.ps1"), "utf8");
    expect(ps1.indexOf('Join-Path $stage "web\\dist\\math"')).toBeGreaterThan(ps1.indexOf('Copy-Item -Recurse -LiteralPath (Join-Path $repo "web\\dist")'));
  });

  test("the web-dist asset leaves the engines out", () => {
    expect(step("Build and package web/dist").run).toContain(`"$RUNNER_TEMP/assets/web-dist-$version.tar.gz" --exclude='dist/math' -C web dist`);
  });

  test("the pack is built from the release job's own web/dist, reproducibly, under its one name", () => {
    const run = step("Build the math pack").run ?? "";
    expect(run).toContain("--format=ustar --sort=name --owner=0 --group=0 --numeric-owner --mtime=@0");
    expect(run).toContain('-cf - -C web/dist math | gzip -9n > "$RUNNER_TEMP/assets/collie-math-$version.tar.gz"');
    expect(at("Build the math pack")).toBeGreaterThan(at("Build and package web/dist"));
  });

  test("the tested check reads every payload, the Windows zip and the web-dist asset before the manifest", () => {
    const run = step("Check the math pack against every payload").run ?? "";
    expect(run).toContain('"$RUNNER_TEMP"/assets/collie-"$version"-*.tar.gz');
    expect(run).toContain('"$RUNNER_TEMP"/assets/*.zip');
    expect(run).toContain('web-dist-$version.tar.gz');
    expect(run).toContain("bun scripts/math-pack.ts check");
    expect(at("Check the math pack against every payload")).toBeGreaterThan(at("Build the math pack"));
    expect(at("Check the math pack against every payload")).toBeLessThan(at("Write the integrity manifest"));
  });

  test("the manifest lists the pack under extras with role math-pack, its size and its sha256", () => {
    const run = step("Write the integrity manifest").run ?? "";
    expect(run).toContain(`printf '      "name": "collie-math-%s.tar.gz",\\n' "$version"`);
    expect(run).toContain(`printf '      "role": "math-pack",\\n'`);
    expect(run).toContain(`"$(wc -c < "collie-math-$version.tar.gz" | tr -d ' ')"`);
    expect(run).toContain(`"$(sha256sum "collie-math-$version.tar.gz" | cut -d' ' -f1)"`);
    // Every .tar.gz gets a sidecar, the pack included.
    expect(run).toContain("for f in *.tar.gz *.manifest.json; do");
  });
});
