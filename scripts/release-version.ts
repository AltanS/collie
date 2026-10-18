#!/usr/bin/env bun
// The version a release tag names, reconciled with the version files the tagged commit carries.
//
//   bun scripts/release-version.ts --tag v1.23.0-edge.1            check, print version/base/line
//   bun scripts/release-version.ts --tag v1.23.0-edge.1 --stamp    the same, then stamp the files
//
// TWO KINDS OF TAG, ONE SET OF FILES (M60 spec 01). A Stable tag `vX.Y.Z` names exactly the version
// the four files agree on, as it always did. An Edge tag `vX.Y.Z-edge.N` is a pre-release of that
// same version: it goes on a commit whose files still say plain `X.Y.Z`, and the suffix lives in the
// TAG alone. The files in git never carry it, so cutting Stable from a commit that lived on Edge is a
// second tag on the same tree and no edit at all.
//
// THE PAYLOAD MUST NAME THE BUILD IT IS. An Edge build that reported plain `1.23.0` would read as the
// release itself: the update check could never offer the real `1.23.0` over it (equal is not newer),
// and the release job's own `collie version` check, which wants the tag's version, would fail. So the
// release job STAMPS the suffix into its own working copy of the three version files before it
// builds (`--stamp`). Only that runner's checkout changes; nothing is committed.
// `scripts/check-version.sh` accepts the stamped shape only where `GITHUB_REF_NAME` is that very
// tag, so a stamped file committed by mistake fails every other check.
//
// No dependency beyond Node's own modules: the payload job runs this before `bun install`.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `vX.Y.Z` with an optional `-<tail>`: the same anchor `bridge/update.ts` reads remote tags with. */
const TAG = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** The one pre-release tail this file stamps: `edge.N`, `N` a number with no leading zero. */
const EDGE_TAIL = /^edge\.(0|[1-9]\d*)$/;

/** What a release tag names. `base` is the version the files carry for it. */
export interface ReleaseTagReading {
	readonly tag: string;
	/** The dotted version the build reports: `1.23.0` or `1.23.0-edge.1`. */
	readonly version: string;
	/** The version the four files carry for this tag: `1.23.0` for both of the above. */
	readonly base: string;
	/** `edge` for a `-edge.N` tag, `stable` for a strict one, `other` for any other tail (old betas). */
	readonly line: "stable" | "edge" | "other";
}

/** Read a tag, or answer null for anything that is not `vX.Y.Z[-tail]`. */
export function readReleaseTag(tag: string): ReleaseTagReading | null {
	const m = TAG.exec(tag.trim());
	if (m === null) return null;
	const triple = `${m[1]}.${m[2]}.${m[3]}`;
	const tail = m[4];
	if (tail === undefined) return { tag: tag.trim(), version: triple, base: triple, line: "stable" };
	const version = `${triple}-${tail}`;
	// An old beta carried its tail IN the files (`1.0.0-beta.44` everywhere), so its base is itself.
	if (!EDGE_TAIL.test(tail)) return { tag: tag.trim(), version, base: version, line: "other" };
	return { tag: tag.trim(), version, base: triple, line: "edge" };
}

/** `1.23.0-edge.1` → `1.23.0`; every other version unchanged. Where a CHANGELOG section is looked up. */
export function sectionVersion(version: string): string {
	return version.replace(/-edge\.(0|[1-9]\d*)$/, "");
}

/** Whether a dotted version is an Edge build (`1.23.0-edge.1`). */
export function isEdgeVersion(version: string): boolean {
	return sectionVersion(version) !== version;
}

/** The verdict on one tag against the files' version, and the stamp it needs, if any. */
export type Reconciled =
	| { readonly ok: true; readonly reading: ReleaseTagReading; readonly stamp: string | null }
	| { readonly ok: false; readonly reason: string };

/**
 * Does this tag belong on a commit whose files say `files`? And if so, what must the payload say?
 *
 * A Stable tag needs the files to say its version. An Edge tag needs them to say its BASE, and asks
 * for a stamp; files that already carry the full Edge version are a re-run of a stamped job and need
 * none. Anything else is a tag on the wrong commit, refused with both versions named.
 */
export function reconcile(tag: string, files: string): Reconciled {
	const reading = readReleaseTag(tag);
	if (reading === null) return { ok: false, reason: `'${tag}' is not a release tag (vX.Y.Z or vX.Y.Z-edge.N)` };
	if (files === reading.version) return { ok: true, reading, stamp: null };
	if (reading.line === "edge" && files === reading.base) return { ok: true, reading, stamp: reading.version };
	const wanted = reading.line === "edge" ? `${reading.base} (or ${reading.version}, already stamped)` : reading.version;
	return {
		ok: false,
		reason: `tag ${reading.tag} needs version files at ${wanted}, and they say ${files}`,
	};
}

/** `herdr-plugin.toml` with its first `version = "…"` line set to `version`. */
export function stampToml(text: string, version: string): string {
	return text.replace(/^([ \t]*version[ \t]*=[ \t]*")[^"]*(")/m, `$1${version}$2`);
}

/** A `package.json` with its first `"version": "…"` set to `version`, the rest byte for byte. */
export function stampPackageJson(text: string, version: string): string {
	return text.replace(/("version"[ \t]*:[ \t]*")[^"]*(")/, `$1${version}$2`);
}

/** The canonical version out of `herdr-plugin.toml`, the way `scripts/check-version.sh` reads it. */
export function tomlVersion(text: string): string | null {
	return /^[ \t]*version[ \t]*=[ \t]*"([^"]*)"/m.exec(text)?.[1] ?? null;
}

function packageVersion(text: string): string | null {
	return /"version"[ \t]*:[ \t]*"([^"]*)"/.exec(text)?.[1] ?? null;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: readonly string[], name: string): string | null {
	const at = argv.indexOf(`--${name}`);
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

function main(argv: readonly string[]): number {
	const tag = flag(argv, "tag");
	const root = flag(argv, "root") ?? join(import.meta.dir, "..");
	if (tag === null || tag === "") {
		console.error("usage: bun scripts/release-version.ts --tag vX.Y.Z[-edge.N] [--stamp] [--root <repo>]");
		return 2;
	}
	const files = {
		toml: join(root, "herdr-plugin.toml"),
		pkg: join(root, "package.json"),
		web: join(root, "web", "package.json"),
	};
	const text = { toml: readFileSync(files.toml, "utf8"), pkg: readFileSync(files.pkg, "utf8"), web: readFileSync(files.web, "utf8") };
	const versions = { toml: tomlVersion(text.toml), pkg: packageVersion(text.pkg), web: packageVersion(text.web) };
	if (versions.toml === null || versions.toml !== versions.pkg || versions.toml !== versions.web) {
		console.error(
			`✗ release-version: the version files disagree (herdr-plugin.toml ${versions.toml ?? "?"}, package.json ${versions.pkg ?? "?"}, web/package.json ${versions.web ?? "?"}); run scripts/check-version.sh`,
		);
		return 1;
	}
	const verdict = reconcile(tag, versions.toml);
	if (!verdict.ok) {
		console.error(`✗ release-version: ${verdict.reason}`);
		return 1;
	}
	const { reading, stamp } = verdict;
	if (stamp !== null && argv.includes("--stamp")) {
		writeFileSync(files.toml, stampToml(text.toml, stamp));
		writeFileSync(files.pkg, stampPackageJson(text.pkg, stamp));
		writeFileSync(files.web, stampPackageJson(text.web, stamp));
		// THE TREE STAYS CLEAN. A stamped file is a change `git status` reports, and the web build
		// marks a build from a changed tree `-dirty`, which the health gate reads as "not that commit"
		// and rolls back. `assume-unchanged` keeps the stamp out of `git status`, here and in a
		// checkout install that stamps the same way (`cli/update.ts`).
		if (existsSync(join(root, ".git"))) {
			spawnSync("git", ["-C", root, "update-index", "--assume-unchanged", "--", "herdr-plugin.toml", "package.json", join("web", "package.json")]);
		}
		console.error(`stamped ${stamp} into herdr-plugin.toml, package.json and web/package.json (this checkout only)`);
	}
	process.stdout.write(`version=${reading.version}\nbase=${reading.base}\nline=${reading.line}\n`);
	return 0;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
