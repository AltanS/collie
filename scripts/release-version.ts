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

import { reconcile, stampPackageJson, stampToml, tomlVersion } from "./release-tag.ts";

export {
	isEdgeVersion,
	readReleaseTag,
	reconcile,
	sectionVersion,
	stampPackageJson,
	stampToml,
	tomlVersion,
	type Reconciled,
	type ReleaseTagReading,
} from "./release-tag.ts";

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
