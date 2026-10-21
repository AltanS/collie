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
//   • `line` — `"edge"` on an Edge build (`1.23.0-edge.1`, M60 spec 01), and ABSENT on a Stable one,
//     so a Stable release's document stays byte for byte what it was. An Edge build reads its base
//     version's CHANGELOG section: the suffix lives in the tag, never in the file.
//   • `notes`: the section's bullets as the release page lists them: each bold lead, under its
//     group (1.21.1). The Updates page shows them before the operator confirms. Leads only: the
//     detail and the commit links stay on the release page, which the phone links to.
//
// The sidecar is the ONE release-level record the phone reads. It never reads a release body, so a
// fact that has to reach an install before it updates has to be here or nowhere.
//
// Writing this in TypeScript rather than in the workflow's shell is deliberate: the reason sentence
// is prose an author wrote, and `JSON.stringify` is the only thing that quotes it correctly.

import { readFileSync } from "node:fs";

import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { parseSection, parseUrgent } from "./release-notes.ts";
import { isEdgeVersion } from "./release-version.ts";

/** The document, exactly as it is published. `urgent` is absent, never null, when the release is an
 *  ordinary one — an absent key is what every reader before ADR 0046 already handles. */
export interface ReleaseReadingDocument {
	version: string;
	crewProtocol: number;
	urgent?: { reason: string };
	/** `"edge"` on an Edge build. Absent is Stable, which is every release before M60 too. */
	line?: "edge";
	/** The section's groups, each as its bullets' bold leads. Absent when the section has none. */
	notes?: { name: string; leads: string[] }[];
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
	if (isEdgeVersion(version)) doc.line = "edge";
	// The same parse the release page is built from, so the phone and the page list the same lines.
	// It throws on a section the page could not print, which stops the release here, one step
	// before the notes step would have stopped it anyway.
	const notes = parseSection(changelog, version)
		.groups.filter((group) => group.leads.length > 0)
		.map((group) => ({ name: group.name, leads: group.leads }));
	if (notes.length > 0) doc.notes = notes;
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
