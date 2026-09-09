// Tests for scripts/release-notes.ts, the release page body read out of CHANGELOG.md.
//
// The body is what an operator sees on the GitHub Release page, and nothing else writes it, so
// each case here pins one half of the contract: what a well-shaped section renders to, and which
// mis-shaped section stops the release with a named reason instead of publishing a page that
// lists nothing.
//
// The last block reads the REPOSITORY'S OWN CHANGELOG.md, so a bullet the page could not print
// turns CI red on the commit that wrote it. The tag-time failure is the backstop, not the gate.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import {
	changelogAnchor,
	checkUnreleased,
	parseSection,
	renderBody,
} from "./release-notes.ts";

const REPO = "AltanS/collie";

// A section with all five groups, one bullet each.
const FULL = `# Changelog

## [Unreleased]

## [2.1.0] - 2026-10-01

### Added

- **The crew levels itself.** Every member follows the lead's tag. Thanks @someone (#12). ([abc1234](https://github.com/AltanS/collie/commit/abc1234))

### Changed

- **The update band shows one release at a time.** It used to stack them. ([aaa0001](https://github.com/AltanS/collie/commit/aaa0001))

### Fixed

- **\`collie doctor\` names the unit it checked.** It used to name the first one on the host. ([def5678](https://github.com/AltanS/collie/commit/def5678))

### Packaging

- **The Arch package installs to \`/opt/collie\`.** That is the layout the repository expects. ([0000111](https://github.com/AltanS/collie/commit/0000111))

### Docs

- **The install page names the mise route.** It sits beside Arch and Nix. ([2222333](https://github.com/AltanS/collie/commit/2222333))

## [2.0.0] - 2026-09-01

### Added

- **The first one.** ([9999999](https://github.com/AltanS/collie/commit/9999999))
`;

const SMALL = `# Changelog

## [1.0.0] - 2026-01-01

### Added

- **Collie ships.** The first release. ([1111111](https://github.com/AltanS/collie/commit/1111111))
`;

describe("parseSection", () => {
	test("reads the five groups in their fixed order", () => {
		const section = parseSection(FULL, "2.1.0");
		expect(section.date).toBe("2026-10-01");
		expect(section.groups.map((g) => g.name)).toEqual([
			"Added",
			"Changed",
			"Fixed",
			"Packaging",
			"Docs",
		]);
	});

	test("a lead keeps its backticks and loses its asterisks", () => {
		const section = parseSection(FULL, "2.1.0");
		const fixed = section.groups.find((g) => g.name === "Fixed");
		expect(fixed?.leads).toEqual(["`collie doctor` names the unit it checked."]);
		for (const group of section.groups) {
			for (const lead of group.leads) expect(lead).not.toContain("**");
		}
	});

	test("a missing version heading fails", () => {
		expect(() => parseSection(FULL, "3.0.0")).toThrow(/no '## \[3\.0\.0\]/);
	});

	test("a bullet with no bold lead fails", () => {
		const bad = FULL.replace("- **The crew levels itself.**", "- The crew levels itself.");
		expect(() => parseSection(bad, "2.1.0")).toThrow(/no bold lead sentence/);
	});

	test("a bold lead that is never closed fails", () => {
		const bad = FULL.replace("- **The crew levels itself.**", "- **The crew levels itself.");
		expect(() => parseSection(bad, "2.1.0")).toThrow(/never closed/);
	});

	test("a bullet above every group heading fails", () => {
		const bad = FULL.replace(
			"### Added\n\n- **The crew levels itself.**",
			"- **A stray bullet.** No group owns it.\n\n### Added\n\n- **The crew levels itself.**",
		);
		expect(() => parseSection(bad, "2.1.0")).toThrow(/above every '### ' group heading/);
	});

	test("an unknown group heading fails", () => {
		const bad = FULL.replace("### Packaging", "### Security");
		expect(() => parseSection(bad, "2.1.0")).toThrow(/unknown group heading '### Security'/);
	});

	test("a CRLF file reads exactly like an LF one", () => {
		const crlf = FULL.replace(/\n/g, "\r\n");
		expect(parseSection(crlf, "2.1.0")).toEqual(parseSection(FULL, "2.1.0"));
	});

	test("a prerelease heading is found and dated", () => {
		const beta = SMALL.replace("## [1.0.0] - 2026-01-01", "## [1.7.0-beta.1] - 2026-10-01");
		const section = parseSection(beta, "1.7.0-beta.1");
		expect(section.date).toBe("2026-10-01");
		expect(section.groups[0]?.leads).toEqual(["Collie ships."]);
	});
});

describe("checkUnreleased", () => {
	test("an empty Unreleased section is well shaped", () => {
		expect(checkUnreleased(FULL)).toEqual([]);
	});

	test("a well-shaped bullet under a group passes", () => {
		const filled = FULL.replace(
			"## [Unreleased]\n",
			"## [Unreleased]\n\n### Fixed\n\n- **A thing is fixed.** The detail follows here. (#1)\n",
		);
		expect(checkUnreleased(filled)).toEqual([{ name: "Fixed", leads: ["A thing is fixed."] }]);
	});

	test("a bullet with no bold lead fails, and the message names the section", () => {
		const bad = FULL.replace(
			"## [Unreleased]\n",
			"## [Unreleased]\n\n### Fixed\n\n- a thing is fixed\n",
		);
		expect(() => checkUnreleased(bad)).toThrow(/\[Unreleased\].*no bold lead sentence/s);
	});

	test("a bullet above every group heading fails", () => {
		const bad = FULL.replace(
			"## [Unreleased]\n",
			"## [Unreleased]\n\n- **A thing is fixed.** No group owns it.\n",
		);
		expect(() => checkUnreleased(bad)).toThrow(/above every '### ' group heading/);
	});

	test("an unknown group heading fails", () => {
		const bad = FULL.replace("## [Unreleased]\n", "## [Unreleased]\n\n### Removed\n");
		expect(() => checkUnreleased(bad)).toThrow(/unknown group heading '### Removed'/);
	});
});

describe("changelogAnchor", () => {
	// GitHub's slugger lowercases, drops every character that is not a letter, a digit, a space or
	// a hyphen, then turns each remaining space into a hyphen. The heading text is
	// `[x.y.z] - YYYY-MM-DD`, so the brackets and the dots go and the three spaces become three
	// hyphens. A prerelease loses only its dot; the hyphen in `-beta.1` was already legal.
	test("drops the dots and joins the date with three hyphens", () => {
		expect(changelogAnchor("1.5.0", "2026-09-04")).toBe("150---2026-09-04");
	});

	test("a prerelease keeps its hyphen and loses its dots", () => {
		expect(changelogAnchor("1.7.0-beta.1", "2026-10-01")).toBe("170-beta1---2026-10-01");
	});
});

describe("renderBody", () => {
	test("the whole body for a version with all five groups", () => {
		expect(renderBody(FULL, "2.1.0", REPO, "v2.1.0", "v2.0.0")).toBe(`## Update

**Already on 1.x?** One command, then the phone updates itself within a minute.

\`\`\`
collie update                                              # downloaded install (install.sh or a tarball below)
herdr plugin action invoke update --plugin herdr.collie    # Herdr plugin install
\`\`\`

Check with \`collie version\` or \`herdr plugin action invoke version --plugin herdr.collie\`.

**Coming from 0.x?** \`collie update\` will not cross a major. Follow [Upgrading from 0.x to 1.0](https://github.com/AltanS/collie/blob/v2.1.0/docs/upgrading.md#upgrading-from-0x-to-10).

## What changed

**Added**

- The crew levels itself.

**Changed**

- The update band shows one release at a time.

**Fixed**

- \`collie doctor\` names the unit it checked.

**Packaging**

- The Arch package installs to \`/opt/collie\`.

**Docs**

- The install page names the mise route.

Full detail with commits: [2.1.0 in the changelog](https://github.com/AltanS/collie/blob/v2.1.0/CHANGELOG.md#210---2026-10-01)

Compare: [v2.0.0...v2.1.0](https://github.com/AltanS/collie/compare/v2.0.0...v2.1.0)

<details><summary>Verify a download by hand</summary>

\`\`\`
curl -fLO https://github.com/AltanS/collie/releases/download/v2.1.0/collie-2.1.0-linux-x64.tar.gz
curl -fLO https://github.com/AltanS/collie/releases/download/v2.1.0/collie-2.1.0-linux-x64.tar.gz.sha256
sha256sum -c collie-2.1.0-linux-x64.tar.gz.sha256   # macOS: shasum -a 256 -c
\`\`\`

A sha256 catches a corrupt or truncated download. It does not prove who built the file,
HTTPS and the pinned github.com host carry that.

</details>
`);
	});

	test("no previous tag means no compare line", () => {
		const body = renderBody(SMALL, "1.0.0", REPO, "v1.0.0");
		expect(body).not.toContain("Compare:");
		expect(body).toContain("Full detail with commits: [1.0.0 in the changelog]");
	});

	test("the update block is open, and first on the page", () => {
		const body = renderBody(FULL, "2.1.0", REPO, "v2.1.0", "v2.0.0");
		expect(body.startsWith("## Update\n")).toBe(true);
		// The commands a phone came here to copy are visible without a tap: only the verify recipe
		// is folded.
		expect(body.indexOf("collie update  ")).toBeLessThan(body.indexOf("<details>"));
		expect(body.match(/<details>/g)).toHaveLength(1);
		expect(body.indexOf("## Update")).toBeLessThan(body.indexOf("## What changed"));
	});

	test("only the groups that have content are printed", () => {
		const body = renderBody(SMALL, "1.0.0", REPO, "v1.0.0");
		expect(body).toContain("**Added**");
		expect(body).not.toContain("**Changed**");
		expect(body).not.toContain("**Fixed**");
		expect(body).not.toContain("**Packaging**");
		expect(body).not.toContain("**Docs**");
	});
});

// ── The repository's own CHANGELOG ──────────────────────────────────────────────────────────────
// Not a fixture: the real file, so a badly shaped bullet is red in CI on the commit that wrote it
// rather than at tag time, when the release is already being published.

describe("the repository's CHANGELOG.md", () => {
	const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");

	test("the newest numbered version's section parses", () => {
		const newest = /^## \[(\d[^\]]*)\]/m.exec(changelog)?.[1];
		expect(newest).toBeTruthy();
		const section = parseSection(changelog, newest ?? "");
		expect(section.groups.length).toBeGreaterThan(0);
		for (const group of section.groups) expect(group.leads.length).toBeGreaterThan(0);
	});

	test("every bullet under Unreleased is grouped and has a bold lead", () => {
		expect(() => checkUnreleased(changelog)).not.toThrow();
	});
});
