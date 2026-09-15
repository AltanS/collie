#!/usr/bin/env bun
// `collie-release.json`, the one small document a release publishes about itself.
//
//   bun scripts/release-reading.ts --version 1.9.1 --changelog CHANGELOG.md
//
// Prints the document to stdout. `.github/workflows/release.yml` redirects it into the asset the
// release job uploads beside the tarballs.
//
// What it carries, and why each field is here:
//
//   • `version` — the release this document is about.
//   • `crewProtocol` — the CREW WIRE VERSION this build speaks. An installed Collie reads it and can
//     tell an operator, BEFORE they confirm, that the update changes the link their crew talks over
//     (M27/06). THE NUMBER IS EVALUATED, NEVER TRANSCRIBED: this script imports the same constant
//     the binary compiles, so the asset cannot drift from the build.
//   • `urgent` — present only when the release's CHANGELOG section opens with an `**Urgent.**` line
//     (ADR 0046). It carries that line's own sentence, and it is why the phone keeps the daily
//     digest cadence for a patch that must not wait a week.
//
// The sidecar is the ONE release-level record the phone reads. It never reads a release body, so a
// fact that has to reach an install before it updates has to be here or nowhere.
//
// Writing this in TypeScript rather than in the workflow's shell is deliberate: the reason sentence
// is prose an author wrote, and `JSON.stringify` is the only thing that quotes it correctly.

import { readFileSync } from "node:fs";

import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { parseUrgent } from "./release-notes.ts";

/** The document, exactly as it is published. `urgent` is absent, never null, when the release is an
 *  ordinary one — an absent key is what every reader before ADR 0046 already handles. */
export interface ReleaseReadingDocument {
	version: string;
	crewProtocol: number;
	urgent?: { reason: string };
}

/** Build the document for one version out of the changelog and this build's own protocol number. */
export function buildReleaseReading(
	changelog: string,
	version: string,
	crewProtocol: number,
): ReleaseReadingDocument {
	if (!Number.isInteger(crewProtocol)) {
		throw new Error(`CREW_PROTOCOL_VERSION did not read as an integer: '${crewProtocol}'`);
	}
	const urgent = parseUrgent(changelog, version);
	const doc: ReleaseReadingDocument = { version, crewProtocol };
	if (urgent) doc.urgent = urgent;
	return doc;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | null {
	const at = argv.indexOf(`--${name}`);
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

function main(argv: string[]): void {
	const version = flag(argv, "version");
	const changelogPath = flag(argv, "changelog") ?? "CHANGELOG.md";

	if (!version) {
		console.error("usage: bun scripts/release-reading.ts --version 1.9.1 [--changelog CHANGELOG.md]");
		process.exit(1);
	}

	try {
		const changelog = readFileSync(changelogPath, "utf8");
		const doc = buildReleaseReading(changelog, version, CREW_PROTOCOL_VERSION);
		process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
	} catch (error) {
		console.error(`✗ release-reading: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

if (import.meta.main) main(process.argv.slice(2));
