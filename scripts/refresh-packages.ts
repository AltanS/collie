#!/usr/bin/env bun
// Rewrites the package files under `packaging/` from a release's integrity manifest.
//
//   bun scripts/refresh-packages.ts --manifest collie-1.5.5.manifest.json
//   bun scripts/refresh-packages.ts --manifest https://…/collie-1.5.5.manifest.json --check
//
// `collie-<version>.manifest.json` is the ONLY input. Every version and every hash written here is
// copied out of that document; nothing in this file downloads a payload, hashes a payload, or
// builds anything. That is the whole point: the release job already hashed each tarball, and a
// package that re-derives a hash is a second answer to a question with one answer.
//
// Exactly two files are written, and in each one only the declared fields move:
//
//   packaging/aur/PKGBUILD      `pkgver`, `sha256sums_x86_64`, `sha256sums_aarch64`
//   packaging/nix/sources.json  `version`, and `url` + `sha256` per platform
//
// After writing, both files are READ BACK and every written field is compared against the
// manifest. A rewrite that does not verify exits non-zero and says which field disagreed, because
// pushing a package with a stale hash is the one failure that reaches a user as an unexplained
// refusal to unpack.
//
// `--check` verifies and writes nothing. It is what the release job runs a second time, after the
// rewrite, so the job proves the file on disk rather than the intention that produced it.
//
// `.SRCINFO` is regenerated with `makepkg --printsrcinfo` when `makepkg` is on PATH, and left
// alone with a printed notice when it is not. The AUR reads `.SRCINFO`, so a stale one publishes
// the wrong version — but this script runs on machines that are not Arch, and refusing there would
// stop the rewrite for no gain.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// ── The manifest, and the two shapes it feeds ──────────────────────────────

interface ManifestArtifact {
  readonly name: string;
  readonly platform: string;
  readonly sha256: string;
}

interface Manifest {
  readonly version: string;
  readonly repo: string;
  readonly tag: string;
  readonly artifacts: readonly ManifestArtifact[];
}

/**
 * The PKGBUILD's two `sha256sums_*` arrays, keyed by the manifest platform each one takes its
 * value from. `arch=('x86_64' 'aarch64')` is the Arch spelling of the same two payloads.
 */
const AUR_ARCHES = [
  { arrayName: "sha256sums_x86_64", platform: "linux-x64" },
  { arrayName: "sha256sums_aarch64", platform: "linux-arm64" },
] as const;

/**
 * `sources.json`'s platform keys, and the manifest platform each one reads. The names differ on
 * one row: the release workflow's matrix says `macos-arm64`, Nix says `darwin`, and this table is
 * where that translation lives so neither file has to know about the other's spelling.
 */
const NIX_PLATFORMS = [
  { key: "linux-x64", platform: "linux-x64" },
  { key: "linux-arm64", platform: "linux-arm64" },
  { key: "darwin-arm64", platform: "macos-arm64" },
] as const;

interface NixPlatform {
  url: string;
  sha256: string;
}

interface NixSources {
  version: string;
  platforms: Record<string, NixPlatform>;
}

// ── Reading the manifest ───────────────────────────────────────────────────

async function loadManifest(source: string): Promise<Manifest> {
  const text = source.startsWith("http://") || source.startsWith("https://")
    ? await fetchManifest(source)
    : readFileSync(source, "utf8");

  // SAFETY: the assertion is immediately followed by a CONTENT check on every field this script
  // reads — a semver for `version`, `owner/name` for `repo`, `v<semver>` for `tag`, a non-empty
  // array for `artifacts`, and 64 lowercase hex digits plus an asset name in `artifactFor`. Each
  // check coerces through `String(...)`, so a field that is absent or of the wrong JSON type reads
  // as a value that fails its pattern and is rejected by name. No malformed manifest survives.
  const m = JSON.parse(text) as Manifest;
  if (!/^\d+\.\d+\.\d+/.test(String(m.version))) {
    throw new Error(`${source}: "version" is not a version, it reads ${JSON.stringify(m.version)}`);
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(m.repo))) {
    throw new Error(`${source}: "repo" is not owner/name, it reads ${JSON.stringify(m.repo)}`);
  }
  if (!/^v\d+\.\d+\.\d+/.test(String(m.tag))) {
    throw new Error(`${source}: "tag" is not a v-prefixed version, it reads ${JSON.stringify(m.tag)}`);
  }
  if (!Array.isArray(m.artifacts) || m.artifacts.length === 0) {
    throw new Error(`${source}: the manifest lists no artifacts`);
  }
  return { version: m.version, repo: m.repo, tag: m.tag, artifacts: m.artifacts };
}

async function fetchManifest(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return await res.text();
}

/** The artifact a platform names, or a refusal that says which platform is missing. */
function artifactFor(manifest: Manifest, platform: string): ManifestArtifact {
  const hit = manifest.artifacts.find((a) => a.platform === platform);
  if (hit === undefined) {
    throw new Error(`the manifest has no artifact for platform "${platform}"`);
  }
  if (!/^[0-9a-f]{64}$/.test(String(hit.sha256))) {
    throw new Error(`the manifest's "${platform}" artifact has no 64-digit lowercase sha256`);
  }
  if (!/^collie-.+\.tar\.gz$/.test(String(hit.name))) {
    throw new Error(`the manifest's "${platform}" artifact has no release asset "name"`);
  }
  return hit;
}

/**
 * The download URL is BUILT from repo, tag and asset name rather than read from the manifest,
 * because the manifest deliberately carries no URLs (M14/01 §2.1) and this is the same
 * construction `scripts/install.sh` and `collie update` already use.
 */
function downloadUrl(manifest: Manifest, artifact: ManifestArtifact): string {
  return `https://github.com/${manifest.repo}/releases/download/${manifest.tag}/${artifact.name}`;
}

// ── Field-scoped rewrites ──────────────────────────────────────────────────

/**
 * Replaces the one line matching `pattern` with `line`. Field-scoped means exactly that: the match
 * must occur ONCE. Zero matches means the file no longer declares the field this script owns, and
 * two means the field is declared twice and a rewrite would silently pick one.
 */
function replaceOneLine(text: string, pattern: RegExp, line: string, what: string): string {
  const matches = text.match(pattern);
  if (matches === null || matches.length !== 1) {
    throw new Error(`${what}: expected exactly one line matching ${pattern}, found ${matches?.length ?? 0}`);
  }
  return text.replace(pattern, line);
}

function rewritePkgbuild(text: string, manifest: Manifest): string {
  let out = replaceOneLine(text, /^pkgver=.*$/m, `pkgver=${manifest.version}`, "PKGBUILD pkgver");
  for (const arch of AUR_ARCHES) {
    const sha = artifactFor(manifest, arch.platform).sha256;
    out = replaceOneLine(
      out,
      new RegExp(`^${arch.arrayName}=.*$`, "m"),
      `${arch.arrayName}=('${sha}')`,
      `PKGBUILD ${arch.arrayName}`,
    );
  }
  return out;
}

function rewriteSources(text: string, manifest: Manifest): string {
  // SAFETY: the two fields the assertion names are both OVERWRITTEN on the next lines and never
  // read from the parsed value, so the assertion claims nothing about what the file held. A file
  // whose top level is not an object fails the first assignment with a TypeError (this module is
  // strict), and the caller reports it with the path.
  const sources = JSON.parse(text) as NixSources;
  sources.version = manifest.version;
  sources.platforms = {};
  for (const row of NIX_PLATFORMS) {
    const artifact = artifactFor(manifest, row.platform);
    sources.platforms[row.key] = {
      url: downloadUrl(manifest, artifact),
      // Kept in the manifest's own base-16 spelling so the two documents compare byte for byte.
      sha256: artifact.sha256,
    };
  }
  return `${JSON.stringify(sources, null, 2)}\n`;
}

// ── Verification: read the files back, compare against the manifest ────────

/**
 * One verified field. `expected` and `found` are JSON ENCODINGS, not bare strings: a file that
 * carries `"sha256": 5` where a string belongs must fail here, and comparing encodings catches that
 * without narrowing an untyped value by hand. `found` is null when the field is absent altogether.
 */
interface Field {
  readonly where: string;
  readonly expected: string;
  readonly found: string | null;
}

function encode(value: string): string {
  return JSON.stringify(value);
}

function encodeMatch(captured: string | undefined): string | null {
  return captured === undefined ? null : encode(captured);
}

function pkgbuildFields(text: string, manifest: Manifest): Field[] {
  const fields: Field[] = [
    {
      where: "packaging/aur/PKGBUILD pkgver",
      expected: encode(manifest.version),
      found: encodeMatch(text.match(/^pkgver=(.*)$/m)?.[1]),
    },
  ];
  for (const arch of AUR_ARCHES) {
    fields.push({
      where: `packaging/aur/PKGBUILD ${arch.arrayName}`,
      expected: encode(artifactFor(manifest, arch.platform).sha256),
      found: encodeMatch(text.match(new RegExp(`^${arch.arrayName}=\\('([^']*)'\\)$`, "m"))?.[1]),
    });
  }
  return fields;
}

function sourcesFields(text: string, manifest: Manifest): Field[] {
  // SAFETY: nothing is read through this assertion without being compared, as a JSON encoding,
  // against the manifest's value by `report` below. A field of the wrong type encodes differently
  // and is reported as a mismatch, which is this function's whole job.
  const sources = JSON.parse(text) as Partial<NixSources>;
  const fields: Field[] = [
    {
      where: "packaging/nix/sources.json version",
      expected: encode(manifest.version),
      found: sources.version === undefined ? null : JSON.stringify(sources.version),
    },
  ];
  for (const row of NIX_PLATFORMS) {
    const artifact = artifactFor(manifest, row.platform);
    const entry = sources.platforms?.[row.key];
    fields.push({
      where: `packaging/nix/sources.json platforms.${row.key}.sha256`,
      expected: encode(artifact.sha256),
      found: entry === undefined ? null : JSON.stringify(entry.sha256),
    });
    fields.push({
      where: `packaging/nix/sources.json platforms.${row.key}.url`,
      expected: encode(downloadUrl(manifest, artifact)),
      found: entry === undefined ? null : JSON.stringify(entry.url),
    });
  }
  return fields;
}

/** Prints every field, and returns the ones that disagree with the manifest. */
function report(fields: readonly Field[]): Field[] {
  const bad: Field[] = [];
  for (const f of fields) {
    if (f.found === f.expected) {
      console.log(`  ok   ${f.where} = ${f.expected}`);
    } else {
      bad.push(f);
      console.log(`  BAD  ${f.where}: expected ${f.expected}, found ${f.found ?? "<no such field>"}`);
    }
  }
  return bad;
}

// ── .SRCINFO ───────────────────────────────────────────────────────────────

/**
 * `.SRCINFO` is generated, never hand-written: the AUR reads it instead of the PKGBUILD, and only
 * `makepkg` knows the exact format. Without `makepkg` this leaves the file alone and says so,
 * because refusing on a non-Arch machine would block a rewrite that is otherwise complete.
 */
function regenerateSrcinfo(aurDir: string): void {
  // `Bun.which` rather than a probe run: spawning a name that is not on PATH THROWS, and a missing
  // makepkg is the ordinary case on every machine that is not Arch.
  if (Bun.which("makepkg") === null) {
    console.log("  note .SRCINFO left unchanged: no `makepkg` on PATH (run this on Arch, or in the release job's container)");
    return;
  }
  const out = Bun.spawnSync(["makepkg", "--printsrcinfo"], { cwd: aurDir });
  if (!out.success) {
    throw new Error(`makepkg --printsrcinfo failed: ${out.stderr.toString().trim()}`);
  }
  writeFileSync(join(aurDir, ".SRCINFO"), out.stdout.toString());
  console.log("  ok   .SRCINFO regenerated with makepkg --printsrcinfo");
}

// ── Entry point ────────────────────────────────────────────────────────────

interface Options {
  readonly manifest: string;
  readonly checkOnly: boolean;
  readonly root: string;
}

function parseArgs(argv: readonly string[]): Options {
  let manifest = "";
  let checkOnly = false;
  let root = resolve(dirname(Bun.fileURLToPath(import.meta.url)), "..");
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--manifest") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--manifest needs a path or URL");
      manifest = next;
      i++;
    } else if (arg === "--root") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--root needs a directory");
      root = next;
      i++;
    } else if (arg === "--check") {
      checkOnly = true;
    } else {
      throw new Error(`unknown argument "${arg}" (usage: --manifest <path|url> [--check] [--root <dir>])`);
    }
  }
  if (manifest === "") throw new Error("--manifest <path|url> is required");
  return { manifest, checkOnly, root };
}

async function main(): Promise<number> {
  const opts = parseArgs(Bun.argv.slice(2));
  const manifest = await loadManifest(opts.manifest);
  const pkgbuildPath = join(opts.root, "packaging/aur/PKGBUILD");
  const sourcesPath = join(opts.root, "packaging/nix/sources.json");
  for (const p of [pkgbuildPath, sourcesPath]) {
    if (!existsSync(p)) throw new Error(`${p}: no such file`);
  }

  console.log(`Collie ${manifest.version} (${manifest.tag}), from ${opts.manifest}`);

  if (!opts.checkOnly) {
    writeFileSync(pkgbuildPath, rewritePkgbuild(readFileSync(pkgbuildPath, "utf8"), manifest));
    writeFileSync(sourcesPath, rewriteSources(readFileSync(sourcesPath, "utf8"), manifest));
    regenerateSrcinfo(join(opts.root, "packaging/aur"));
  }

  // Read back from disk, always — in `--check` this is the whole job, and after a rewrite it is
  // the proof. Neither branch trusts the strings this process just held in memory.
  const bad = report([
    ...pkgbuildFields(readFileSync(pkgbuildPath, "utf8"), manifest),
    ...sourcesFields(readFileSync(sourcesPath, "utf8"), manifest),
  ]);

  if (bad.length > 0) {
    console.error(
      `\n✗ ${bad.length} field(s) do not match ${opts.manifest}. Nothing may be published from this tree.`,
    );
    for (const f of bad) console.error(`  ${f.where}: expected ${f.expected}, found ${f.found ?? "<no such field>"}`);
    return 1;
  }
  console.log(`\n✓ packaging/ matches the manifest for ${manifest.version}.`);
  return 0;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  console.error(`✗ refresh-packages: ${err instanceof Error ? err.message : String(err)}`);
}
process.exit(code);
