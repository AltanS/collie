// Tests for scripts/release-version.ts and the Edge half of scripts/check-version.sh (M60 spec 01).
//
// The contract in one line: the four version files in git keep plain X.Y.Z, an Edge tag carries
// `-edge.N`, and the release job's stamped copy of the files is the only place both meet. Each case
// pins one part of that, and the last block runs the real check-version.sh over fixture trees.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { parsePrereleaseTag } from "../bridge/update.ts";
import { manifestVersionFrom } from "../bridge/version.ts";
import {
	isEdgeVersion,
	readReleaseTag,
	reconcile,
	sectionVersion,
	stampPackageJson,
	stampToml,
	tomlVersion,
} from "./release-version.ts";

const ROOT = join(import.meta.dir, "..");

describe("readReleaseTag", () => {
	test("a Stable tag names the files' version", () => {
		expect(readReleaseTag("v1.23.0")).toEqual({ tag: "v1.23.0", version: "1.23.0", base: "1.23.0", line: "stable" });
	});

	test("an Edge tag names its build and the base version the files carry", () => {
		expect(readReleaseTag("v1.23.0-edge.1")).toEqual({
			tag: "v1.23.0-edge.1",
			version: "1.23.0-edge.1",
			base: "1.23.0",
			line: "edge",
		});
		expect(readReleaseTag("v1.23.0-edge.0")?.line).toBe("edge");
		expect(readReleaseTag("v1.23.0-edge.12")?.base).toBe("1.23.0");
	});

	test("any other tail is an old beta's, which carried its tail in the files", () => {
		expect(readReleaseTag("v1.0.0-beta.44")).toEqual({
			tag: "v1.0.0-beta.44",
			version: "1.0.0-beta.44",
			base: "1.0.0-beta.44",
			line: "other",
		});
		// A leading zero is not an Edge number, so it is not stamped.
		expect(readReleaseTag("v1.23.0-edge.01")?.line).toBe("other");
		expect(readReleaseTag("v1.23.0-edge")?.line).toBe("other");
	});

	test("anything that is not a release tag is null", () => {
		for (const bad of ["1.23.0", "v1.23", "v1.23.0-", "v1.23.0-edge..1", "refs/tags/v1.23.0", "v1.23.0/x", ""]) {
			expect(readReleaseTag(bad)).toBeNull();
		}
	});
});

describe("sectionVersion and isEdgeVersion", () => {
	test("strip exactly one Edge tail and nothing else", () => {
		expect(sectionVersion("1.23.0-edge.4")).toBe("1.23.0");
		expect(sectionVersion("1.23.0")).toBe("1.23.0");
		expect(sectionVersion("1.0.0-beta.44")).toBe("1.0.0-beta.44");
		expect(isEdgeVersion("1.23.0-edge.4")).toBe(true);
		expect(isEdgeVersion("1.23.0")).toBe(false);
		expect(isEdgeVersion("1.23.0-edge.04")).toBe(false);
	});
});

describe("reconcile: the tag against the files", () => {
	test("a Stable tag needs the files at its version, and no stamp", () => {
		expect(reconcile("v1.23.0", "1.23.0")).toMatchObject({ ok: true, stamp: null });
		const wrong = reconcile("v1.23.0", "1.22.6");
		expect(wrong.ok).toBe(false);
		if (!wrong.ok) expect(wrong.reason).toBe("tag v1.23.0 needs version files at 1.23.0, and they say 1.22.6");
	});

	test("an Edge tag needs the files at its base, and asks for the stamp", () => {
		expect(reconcile("v1.23.0-edge.2", "1.23.0")).toMatchObject({ ok: true, stamp: "1.23.0-edge.2" });
		// A job re-run over a checkout it already stamped needs no second stamp.
		expect(reconcile("v1.23.0-edge.2", "1.23.0-edge.2")).toMatchObject({ ok: true, stamp: null });
	});

	test("an Edge tag on a commit of another version is refused, naming both", () => {
		const wrong = reconcile("v1.23.0-edge.1", "1.22.6");
		expect(wrong.ok).toBe(false);
		if (!wrong.ok) expect(wrong.reason).toContain("needs version files at 1.23.0 (or 1.23.0-edge.1, already stamped), and they say 1.22.6");
		expect(reconcile("v1.23.0-edge.1", "1.23.0-edge.2").ok).toBe(false);
	});

	test("an old beta tag needs the files at the whole version", () => {
		expect(reconcile("v1.0.0-beta.44", "1.0.0-beta.44")).toMatchObject({ ok: true, stamp: null });
		expect(reconcile("v1.0.0-beta.44", "1.0.0").ok).toBe(false);
	});

	test("a tag that is not a release tag is refused", () => {
		expect(reconcile("latest", "1.23.0").ok).toBe(false);
	});
});

describe("the stamp", () => {
	test("rewrites the one version line of each file and nothing else", () => {
		const toml = readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8");
		const stamped = stampToml(toml, "1.23.0-edge.1");
		expect(tomlVersion(stamped)).toBe("1.23.0-edge.1");
		expect(stamped.split("\n").length).toBe(toml.split("\n").length);
		// `min_herdr_version` is a different key, untouched.
		expect(stamped).toContain(/^min_herdr_version = "[^"]+"/m.exec(toml)?.[0] ?? "min_herdr_version");
		const pkg = readFileSync(join(ROOT, "package.json"), "utf8");
		const stampedPkg = stampPackageJson(pkg, "1.23.0-edge.1");
		expect(tomlVersion(`version = "${/"version"\s*:\s*"([^"]*)"/.exec(stampedPkg)?.[1] ?? ""}"`)).toBe("1.23.0-edge.1");
		// Only the version moved: the rest of the file is byte for byte the same.
		const before = /"version"\s*:\s*"([^"]*)"/.exec(pkg)?.[1] ?? "";
		expect(stampedPkg).toBe(pkg.replace(`"version": "${before}"`, `"version": "1.23.0-edge.1"`));
	});

	test("the plugin manifest a stamp writes is one every reader of it accepts", () => {
		// Herdr reads `version`; the bridge reads it through `manifestVersionFrom`, and the update path
		// compares it as a pre-release that sorts below its Stable release.
		const stamped = stampToml(readFileSync(join(ROOT, "herdr-plugin.toml"), "utf8"), "1.23.0-edge.1");
		const read = manifestVersionFrom(stamped);
		expect(read).toBe("1.23.0-edge.1");
		expect(parsePrereleaseTag(`v${read ?? ""}`)).toEqual({ triple: [1, 23, 0], prerelease: "edge.1" });
	});
});

describe("the script, as the release job runs it", () => {
	const made: string[] = [];
	afterEach(() => {
		for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	/** A tree with the three version files and the CHANGELOG at `version`, and the two scripts. */
	function tree(version: string, heading = version): string {
		const dir = mkdtempSync(join(tmpdir(), "collie-release-version-"));
		made.push(dir);
		mkdirSync(join(dir, "scripts"));
		mkdirSync(join(dir, "web"));
		cpSync(join(ROOT, "scripts", "check-version.sh"), join(dir, "scripts", "check-version.sh"));
		writeFileSync(join(dir, "herdr-plugin.toml"), `id = "herdr.collie"\nversion = "${version}"\nmin_herdr_version = "0.7.0"\n`);
		writeFileSync(join(dir, "package.json"), `{\n  "name": "collie",\n  "version": "${version}"\n}\n`);
		writeFileSync(join(dir, "web", "package.json"), `{\n  "name": "web",\n  "version": "${version}"\n}\n`);
		writeFileSync(join(dir, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n## [${heading}] - 2026-10-18\n`);
		return dir;
	}

	const stamp = (dir: string, tag: string) =>
		Bun.spawnSync(["bun", join(ROOT, "scripts", "release-version.ts"), "--tag", tag, "--stamp", "--root", dir]);
	const checkVersion = (dir: string, ref?: string) => {
		const path = { PATH: process.env.PATH ?? "" };
		const env = ref === undefined ? path : { ...path, GITHUB_REF_NAME: ref };
		return Bun.spawnSync(["bash", join(dir, "scripts", "check-version.sh")], { env });
	};

	test("an Edge tag on a plain X.Y.Z commit stamps the copy, and check-version accepts it for that tag only", () => {
		const dir = tree("1.23.0");
		expect(checkVersion(dir).exitCode).toBe(0);
		const r = stamp(dir, "v1.23.0-edge.1");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toBe("version=1.23.0-edge.1\nbase=1.23.0\nline=edge\n");
		expect(tomlVersion(readFileSync(join(dir, "herdr-plugin.toml"), "utf8"))).toBe("1.23.0-edge.1");
		// The CHANGELOG still says 1.23.0, and that is right: the suffix is the tag's.
		const ok = checkVersion(dir, "v1.23.0-edge.1");
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toContain("1.23.0-edge.1 (Edge build of 1.23.0) consistent");
		// The same stamped files anywhere else are a mistake: on a dev machine, or under another tag.
		for (const ref of [undefined, "v1.23.0-edge.2", "v1.23.0", "main"]) {
			const refused = checkVersion(dir, ref);
			expect(refused.exitCode).toBe(1);
			expect(refused.stderr.toString()).toContain("an -edge.N suffix belongs in the tag only");
		}
	});

	test("a Stable tag writes nothing, and a tag on the wrong commit stops the job", () => {
		const dir = tree("1.23.0");
		const before = readFileSync(join(dir, "package.json"), "utf8");
		const r = stamp(dir, "v1.23.0");
		expect(r.exitCode).toBe(0);
		expect(r.stdout.toString()).toBe("version=1.23.0\nbase=1.23.0\nline=stable\n");
		expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
		const wrong = stamp(dir, "v1.24.0-edge.1");
		expect(wrong.exitCode).toBe(1);
		expect(wrong.stderr.toString()).toContain("tag v1.24.0-edge.1 needs version files at 1.24.0");
		expect(readFileSync(join(dir, "package.json"), "utf8")).toBe(before);
	});

	test("files that disagree are refused before any stamp", () => {
		const dir = tree("1.23.0");
		writeFileSync(join(dir, "web", "package.json"), `{ "version": "1.22.6" }\n`);
		const r = stamp(dir, "v1.23.0-edge.1");
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("the version files disagree");
		expect(tomlVersion(readFileSync(join(dir, "herdr-plugin.toml"), "utf8"))).toBe("1.23.0");
	});

	test("check-version still demands the CHANGELOG heading at the base version", () => {
		const dir = tree("1.23.0", "1.22.6");
		stamp(dir, "v1.23.0-edge.1");
		const r = checkVersion(dir, "v1.23.0-edge.1");
		expect(r.exitCode).toBe(1);
		expect(r.stderr.toString()).toContain("version mismatch");
	});

	/** `tree`, as a git repository with one commit tagged `tag`. */
	function repo(version: string, tag: string): string {
		const dir = tree(version);
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", "-C", dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args]);
		git("init", "-q");
		git("add", "-A");
		git("commit", "-qm", "release");
		git("tag", tag);
		return dir;
	}
	const gitStatus = (dir: string) => Bun.spawnSync(["git", "-C", dir, "status", "--porcelain"]).stdout.toString();

	test("a stamp keeps the tree clean, so the web build is not marked -dirty", () => {
		const dir = repo("1.23.0", "v1.23.0-edge.1");
		expect(stamp(dir, "v1.23.0-edge.1").exitCode).toBe(0);
		expect(tomlVersion(readFileSync(join(dir, "herdr-plugin.toml"), "utf8"))).toBe("1.23.0-edge.1");
		expect(gitStatus(dir)).toBe("");
	});

	test("a checkout install's stamp is accepted at the tag's own commit, and nowhere else", () => {
		const dir = repo("1.23.0", "v1.23.0-edge.1");
		stamp(dir, "v1.23.0-edge.1");
		// No GITHUB_REF_NAME: HEAD is the tag, and the manifest carries the stamp's mark.
		const ok = checkVersion(dir);
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout.toString()).toContain("(Edge build of 1.23.0)");
		// A stamp typed by hand carries no mark, and is refused at the same commit.
		Bun.spawnSync(["git", "-C", dir, "update-index", "--no-assume-unchanged", "--", "herdr-plugin.toml"]);
		expect(checkVersion(dir).exitCode).toBe(1);
	});

	test("a marked stamp on a commit the tag does not name is refused", () => {
		const dir = repo("1.23.0", "v1.23.0-edge.1");
		stamp(dir, "v1.23.0-edge.1");
		Bun.spawnSync(["git", "-C", dir, "tag", "-d", "v1.23.0-edge.1"]);
		expect(checkVersion(dir).exitCode).toBe(1);
	});

	test("check-version on this repository is untouched by any of it", () => {
		expect(Bun.spawnSync(["bash", join(ROOT, "scripts", "check-version.sh")]).exitCode).toBe(0);
	});
});
