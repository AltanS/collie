// Tests for scripts/release-reading.ts, the `collie-release.json` a release publishes about itself.
//
// The document is the ONE release-level record an installed Collie reads before it updates, so each
// case here pins one half of its contract: the fields it always carries, and the urgent marker it
// carries only when the CHANGELOG section asked for it (ADR 0046).
//
// The last block builds the document for THIS repository's newest release, so a changelog the
// release job could not read turns CI red on the commit that wrote it rather than at tag time.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { buildReleaseReading } from "./release-reading.ts";

const ORDINARY = `# Changelog

## [1.9.0] - 2026-09-14

### Added

- **The crew levels itself.** Every member follows the lead's tag. ([abc1234](https://github.com/AltanS/collie/commit/abc1234))
`;

const URGENT = `# Changelog

## [1.9.1] - 2026-09-20

**Urgent.** The cache reaper deletes live entries, take this today.

### Fixed

- **The cache reaper keeps live entries.** It read the window backwards. ([abc1234](https://github.com/AltanS/collie/commit/abc1234))
`;

describe("buildReleaseReading", () => {
	test("an ordinary release carries the version and the protocol, and no urgent key", () => {
		const doc = buildReleaseReading(ORDINARY, "1.9.0", 2);
		expect(doc).toEqual({ version: "1.9.0", crewProtocol: 2 });
		// ABSENT, never null: an absent key is what every reader before ADR 0046 already handles.
		expect(Object.keys(doc)).toEqual(["version", "crewProtocol"]);
	});

	test("an urgent release carries the line's own sentence", () => {
		expect(buildReleaseReading(URGENT, "1.9.1", 2)).toEqual({
			version: "1.9.1",
			crewProtocol: 2,
			urgent: { reason: "The cache reaper deletes live entries, take this today." },
		});
	});

	test("the sentence survives JSON, quotes and all", () => {
		const quoted = URGENT.replace(
			"The cache reaper deletes live entries, take this today.",
			'A pane whose name holds a " is dropped, take this today.',
		);
		const doc = buildReleaseReading(quoted, "1.9.1", 2);
		expect(JSON.parse(JSON.stringify(doc))).toEqual(doc);
	});

	test("a protocol number that is not an integer stops the release", () => {
		expect(() => buildReleaseReading(ORDINARY, "1.9.0", 2.5)).toThrow(/CREW_PROTOCOL_VERSION/);
		expect(() => buildReleaseReading(ORDINARY, "1.9.0", Number.NaN)).toThrow(/CREW_PROTOCOL_VERSION/);
	});

	test("a version with no section in the changelog stops the release", () => {
		expect(() => buildReleaseReading(ORDINARY, "9.9.9", 2)).toThrow(/CHANGELOG/);
	});
});

describe("the repository's own newest release", () => {
	const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");

	test("builds a document the update check can read", () => {
		const newest = /^## \[(\d[^\]]*)\] - (\d{4}-\d{2}-\d{2})/m.exec(changelog)?.[1];
		expect(newest).toBeTruthy();
		const doc = buildReleaseReading(changelog, newest ?? "", CREW_PROTOCOL_VERSION);
		expect(doc.version).toBe(newest ?? "");
		expect(Number.isInteger(doc.crewProtocol)).toBe(true);
	});
});
