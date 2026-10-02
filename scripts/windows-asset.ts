import { existsSync, readFileSync, rmSync, appendFileSync } from "node:fs";
import { join } from "node:path";

// The release job's one decision about the Windows asset (M43 spec 06), out of the YAML so it can be
// tested. The Windows set is three files the `payload-windows` job uploads together: the zip, its
// `.sha256` sidecar and `windows-x64.artifact.json`, the zip's manifest entry. It is all or nothing.
//
//   bun scripts/windows-asset.ts --dir <assets> --version <X.Y.Z> --result <payload-windows result> \
//     --optional <true|false>
//       decides, removes a partial set, prints a GitHub `::warning::` or `::error::`, writes
//       `present=true|false` to $GITHUB_OUTPUT, and exits 1 only on a failure
//   bun scripts/windows-asset.ts --notes <true|false>
//       prints the block the release notes end with
//
// The rules, in order:
//   * all three files there, and the three digests agree: present;
//   * all three there, and a digest disagrees: FAIL, the set is corrupt;
//   * not all there, and `payload-windows` SUCCEEDED: FAIL, a job that built the zip and lost it is
//     a bug in this pipeline, never a Windows build problem;
//   * not all there, and the tolerance is off: FAIL;
//   * not all there otherwise (failure, skipped, cancelled): a WARNING, and the release ships without it.

/** What is on disk, read by {@link readSet} or written by a test. `null` is a missing file. */
export interface WindowsSet {
  /** The zip's own sha256. */
  readonly zip: string | null;
  /** The first word of the sidecar. */
  readonly sidecar: string | null;
  /** The `sha256` field of the manifest entry. */
  readonly entry: string | null;
}

export type WindowsVerdict =
  | { readonly kind: "present" }
  | { readonly kind: "warn"; readonly reason: string }
  | { readonly kind: "fail"; readonly reason: string };

export function windowsVerdict(set: WindowsSet, result: string, optional: boolean, zipName: string): WindowsVerdict {
  const complete = set.zip !== null && set.sidecar !== null && set.entry !== null;
  if (complete) {
    if (set.zip === set.sidecar && set.zip === set.entry) return { kind: "present" };
    return { kind: "fail", reason: `the Windows set disagrees with itself: zip ${set.zip}, sidecar ${set.sidecar}, manifest entry ${set.entry}` };
  }
  if (result === "success") {
    return { kind: "fail", reason: `payload-windows succeeded, and ${zipName} or its sidecar or its manifest entry is missing; that is a bug in this pipeline` };
  }
  if (!optional) {
    return { kind: "fail", reason: `${zipName} is missing (payload-windows: ${result}), and WINDOWS_ASSET_OPTIONAL is not true` };
  }
  return { kind: "warn", reason: `${zipName} is not in this release (payload-windows: ${result}). Linux and macOS publish as usual.` };
}

/** The block the release notes end with. Appended after the Linux and macOS part, which it never changes. */
export function windowsNotes(present: boolean): string {
  return present
    ? "Windows zip: experimental, unsigned, for testing only. There is no installer yet. Windows 11 Smart App Control may block it and that cannot be overridden. Linux and macOS are not affected."
    : "The Windows zip was not built for this release.";
}

/** The three file names of the set for one version. */
export interface WindowsFileNames {
  readonly zip: string;
  readonly sidecar: string;
  readonly entry: string;
}

export function windowsFiles(version: string): WindowsFileNames {
  const zip = `collie-${version}-windows-x64.zip`;
  return { zip, sidecar: `${zip}.sha256`, entry: "windows-x64.artifact.json" };
}

function readSet(dir: string, version: string): WindowsSet {
  const f = windowsFiles(version);
  const at = (name: string): string | null => (existsSync(join(dir, name)) ? join(dir, name) : null);
  const zip = at(f.zip);
  const sidecar = at(f.sidecar);
  const entry = at(f.entry);
  // The entry is the one the build script wrote and read back; only its `sha256` value matters here,
  // so it is matched as text. A field that is not there reads as "", which disagrees with any digest.
  const entryDigest =
    entry === null ? null : (/"sha256"\s*:\s*"([0-9a-f]{64})"/.exec(readFileSync(entry, "utf8"))?.[1] ?? "");
  return {
    zip: zip === null ? null : new Bun.CryptoHasher("sha256").update(readFileSync(zip)).digest("hex"),
    sidecar: sidecar === null ? null : (readFileSync(sidecar, "utf8").split(/\s+/)[0] ?? ""),
    entry: entryDigest,
  };
}

function arg(args: readonly string[], name: string): string | null {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
}

function main(args: readonly string[]): number {
  const notes = arg(args, "--notes");
  if (notes !== null) {
    process.stdout.write(`${windowsNotes(notes === "true")}\n`);
    return 0;
  }
  const dir = arg(args, "--dir");
  const version = arg(args, "--version");
  const result = arg(args, "--result");
  const optional = arg(args, "--optional");
  if (dir === null || version === null || result === null || (optional !== "true" && optional !== "false")) {
    process.stderr.write("usage: windows-asset.ts --dir <assets> --version <X.Y.Z> --result <result> --optional true|false\n");
    return 2;
  }
  const files = windowsFiles(version);
  const verdict = windowsVerdict(readSet(dir, version), result, optional === "true", files.zip);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `present=${verdict.kind === "present"}\n`);
  if (verdict.kind === "present") {
    process.stdout.write(`✓ ${files.zip} is here (payload-windows: ${result})\n`);
    return 0;
  }
  if (verdict.kind === "fail") {
    process.stdout.write(`::error title=Windows asset::${verdict.reason}\n`);
    return 1;
  }
  // All or nothing: a part of the set without the rest goes, so the manifest never names a file
  // that is not published.
  for (const name of [files.zip, files.sidecar, files.entry]) rmSync(join(dir, name), { force: true });
  process.stdout.write(`::warning title=No Windows asset::${verdict.reason}\n`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    appendFileSync(summary, `### No Windows asset\n\n${verdict.reason}\nWindows users keep their version until the next release.\n`);
  }
  return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
