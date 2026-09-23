#!/usr/bin/env bun
// The GitHub Release page's body, generated from CHANGELOG.md.
//
//   bun scripts/release-notes.ts --version 1.6.0 --repo AltanS/collie --tag v1.6.0
//   bun scripts/release-notes.ts --version 1.6.0 --repo AltanS/collie --tag v1.6.0 \
//     --previous-tag v1.5.6 --changelog CHANGELOG.md
//
// Prints the body to stdout. `.github/workflows/release.yml` redirects it into the file
// `gh release create --notes-file` reads.
//
// The shape it reads: a version's section groups its bullets under `### Added`, `### Changed`,
// `### Fixed`, `### Packaging` and `### Docs`, and every bullet opens with a bold lead sentence
// (`- **Lead sentence.** detail …`). The page lists the leads, one line per bullet, under the
// group's name, and links the changelog for the detail. That is the whole reason the lead is
// bold and short: it is the release page's own sentence, written once.
//
// A lead keeps its credit. When the bullet's detail credits someone ("Thanks @x (#12).",
// "Reported by @y (#34)."), the page line ends with that credit, so a reader sees who did what,
// and the @mention is what makes GitHub draw the release's Contributors avatars. See
// `creditsOf` for which @ counts.
//
// The order on the page is the reader's, not the file's. A phone arrives here from the in-app
// update banner to copy one command, so the update block is FIRST and is never folded into a
// `<details>` a thumb has to find. What changed comes second. Only the by-hand checksum recipe is
// folded, because the reader who wants it goes looking for it.
//
// Exit 1, with the reason on stderr, when the section cannot be read that way: no heading for the
// version, a bullet with no bold lead, a bullet sitting above any group heading, or a group
// heading that is not one of the five. A release page that silently lists nothing is worse than a
// workflow step that stops and says which bullet is wrong.

import { readFileSync } from "node:fs";

/** The five group headings, in the order the release page prints them. */
export const GROUPS = ["Added", "Changed", "Fixed", "Packaging", "Docs"] as const;

export type GroupName = (typeof GROUPS)[number];

/** One credit phrase of a bullet, as the author wrote it: `Thanks`, `Reported by`, … */
export interface Credit {
	/** The words before the handles, first letter upper-cased: `Thanks`, `Reported by`. */
	phrase: string;
	/** The GitHub logins it names, without the `@`, in the bullet's order. */
	handles: string[];
}

export interface Group {
	name: GroupName;
	/** One lead per bullet, in the order the changelog lists them, `**` already stripped. */
	leads: string[];
	/** Parallel to `leads`: the credits each bullet carries, empty when it names nobody. */
	credits: Credit[][];
}

export interface Section {
	version: string;
	/** The `YYYY-MM-DD` the heading carries. */
	date: string;
	groups: Group[];
}

function isGroupName(name: string): name is GroupName {
	return GROUPS.some((group) => group === name);
}

/**
 * The file's lines, with a trailing `\r` dropped. A CHANGELOG edited on Windows, or fetched
 * through a tool that normalises line endings on the way in, arrives CRLF; every check below
 * anchors on the end of a line, so one stray `\r` would turn a well-shaped bullet into a refusal.
 */
function toLines(text: string): string[] {
	return text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

interface RawSection {
	/** The `YYYY-MM-DD` the heading carries. */
	date: string;
	/** Every line below the heading, up to the next `## ` heading. */
	lines: string[];
}

/**
 * The lines of `## [version] - date`'s section, and the date out of that heading. The section runs
 * from its own heading to the next `## ` heading, or to the end of the file.
 */
function sectionLines(changelog: string, version: string): RawSection {
	const lines = toLines(changelog);
	const headingPattern = new RegExp(
		`^## \\[${version.replace(/\./g, "\\.")}\\] - (\\d{4}-\\d{2}-\\d{2})\\s*$`,
	);
	for (let i = 0; i < lines.length; i++) {
		const match = headingPattern.exec(lines[i] ?? "");
		if (!match) continue;
		const body: string[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			const line = lines[j] ?? "";
			if (line.startsWith("## ")) break;
			body.push(line);
		}
		return { date: match[1] ?? "", lines: body };
	}
	throw new Error(
		`CHANGELOG has no '## [${version}] - YYYY-MM-DD' heading. ` +
			`The release page is built from that section, so there is nothing to publish.`,
	);
}

/** The bold lead of a bullet line, with the asterisks removed and everything else kept. */
function leadOf(line: string, where: string): string {
	if (!line.startsWith("- **")) {
		throw new Error(
			`CHANGELOG ${where}: a bullet has no bold lead sentence.\n  ${line}\n` +
				`  Expected: - **Lead sentence.** detail text … ([abc1234](link))`,
		);
	}
	const end = line.indexOf("**", 4);
	if (end === -1) {
		throw new Error(
			`CHANGELOG ${where}: a bullet's bold lead is never closed.\n  ${line}\n` +
				`  Expected: - **Lead sentence.** detail text … ([abc1234](link))`,
		);
	}
	return line.slice(4, end).trim();
}

/** The maintainer. His own handle in a bullet is not a contributor credit. */
const MAINTAINER = "altans";

/** A GitHub login: letters, digits and single inner hyphens, at most 39 characters. The lookahead
 *  refuses a match that runs on into a path or a longer word (`@types/node`, `@scope-`). */
const HANDLE = String.raw`@([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})(?![A-Za-z0-9/_-])`;

/** A handle as a bullet writes it: bare, `@x`, or linked to its profile, `[@x](https://github.com/x)`. */
const WRITTEN_HANDLE = String.raw`\[?${HANDLE}(?:\]\(https:\/\/github\.com\/[^)\s]*\))?`;

/** A credit: `Thanks`, `thanks to` or `<word> by`, then one or more handles joined by commas or
 *  `and`. The phrase must directly precede the first handle. */
const CREDIT = new RegExp(
	String.raw`(?<![A-Za-z])(thanks(?: to)?|(?:[A-Za-z]+ )?by)\s+(${WRITTEN_HANDLE}(?:(?:\s*,\s*(?:and\s+)?|\s+and\s+)${WRITTEN_HANDLE})*)`,
	"gi",
);

/**
 * The credits in one bullet line.
 *
 * WHICH @ COUNTS. Only a handle that directly follows a credit phrase: `Thanks @x`,
 * `thanks to @x`, `Reported by @x`, `Suggested by @x and @y`. A bare `@word` anywhere in the
 * bullet does NOT count. The looser rule (every login-shaped `@`) would credit prose like
 * "the `@effort` token", an npm scope in running text, or a mention of a harness's own `@agent`
 * syntax, and every false hit is a stranger's avatar on the release page and a notification
 * in their inbox. A missed credit is a changelog edit; a false one is already sent.
 *
 * A handle linked to its profile (`[@x](https://github.com/x)`, as 1.10.2 and 1.11.0 wrote them)
 * counts too, and the page prints it bare, because GitHub does not mention a user from link text.
 *
 * Code spans are removed before the scan, so `` `Thanks @x` `` inside backticks is text, not a
 * credit. An e-mail address never matches: its `@` follows a letter, not the phrase and a space.
 * The maintainer's own handle is dropped, and a phrase left with no handle is dropped with it.
 */
function creditsOf(line: string): Credit[] {
	const prose = line.replace(/`[^`]*`/g, "");
	const credits: Credit[] = [];
	for (const match of prose.matchAll(CREDIT)) {
		const words = match[1] ?? "";
		const handles = [...(match[2] ?? "").matchAll(new RegExp(HANDLE, "g"))]
			.map((h) => h[1] ?? "")
			.filter((h) => h.toLowerCase() !== MAINTAINER);
		if (handles.length === 0) continue;
		credits.push({ phrase: words.charAt(0).toUpperCase() + words.slice(1), handles });
	}
	return credits;
}

/** A bullet's credits as the page prints them after the lead: `Thanks @a. Reported by @b.` */
function creditText(credits: Credit[]): string {
	return credits
		.map(({ phrase, handles }) => {
			const names = handles.map((h) => `@${h}`);
			const joined =
				names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0];
			return `${phrase} ${joined}.`;
		})
		.join(" ");
}

/**
 * Every handle a section credits, once each, in the order the page first names them. Case is
 * GitHub's business, not ours, so `@Foo` and `@foo` are one person and the first spelling wins.
 */
export function creditedHandles(section: Section): string[] {
	const seen = new Map<string, string>();
	for (const group of section.groups) {
		for (const credits of group.credits) {
			for (const credit of credits) {
				for (const handle of credit.handles) {
					const key = handle.toLowerCase();
					if (!seen.has(key)) seen.set(key, handle);
				}
			}
		}
	}
	return [...seen.values()];
}

/**
 * Reads a section's lines into its groups. Throws with the reason when the shape is wrong.
 * `where` names the section in the message, so a failure says which one it read.
 */
function groupsOf(lines: string[], where: string): Group[] {
	const groups: Group[] = [];
	let current: Group | null = null;

	for (const line of lines) {
		if (line.startsWith("### ")) {
			const name = line.slice(4).trim();
			if (!isGroupName(name)) {
				throw new Error(
					`CHANGELOG ${where}: unknown group heading '### ${name}'. ` +
						`The five are: ${GROUPS.join(", ")}.`,
				);
			}
			current = { name, leads: [], credits: [] };
			groups.push(current);
			continue;
		}
		if (!line.startsWith("- ")) continue;
		if (!current) {
			throw new Error(
				`CHANGELOG ${where}: a bullet sits above every '### ' group heading.\n  ${line}\n` +
					`  Put it under one of: ${GROUPS.join(", ")}.`,
			);
		}
		current.leads.push(leadOf(line, where));
		current.credits.push(creditsOf(line));
	}

	groups.sort((a, b) => GROUPS.indexOf(a.name) - GROUPS.indexOf(b.name));
	return groups;
}

/** The longest an urgent sentence may be. A push notification and a phone card both read it, and a
 *  reason nobody finishes reading is a reason nobody acts on. */
export const URGENT_REASON_MAX = 140;

/** A line that was TRYING to be the urgent marker. Anything matching this must match the exact form
 *  below or the release stops: a near miss that is silently read as prose ships a release nobody is
 *  told about, which is the one failure this whole mechanism exists to prevent. */
const URGENT_NEAR_MISS = /^(\*\*\s*urgent|urgent[.:])/i;

/** The exact form. One bold lead, a space, then the sentence. */
const URGENT_EXACT = /^\*\*Urgent\.\*\* (\S.*)$/;

const URGENT_EXPECTED_LINE =
	"Expected exactly: **Urgent.** One sentence, present tense, why this must reach operators today.";

/**
 * The sentence, checked. Throws with the reason when it is one an operator should not be sent.
 *
 * The rules are the ones a push body and a phone card impose, and nothing more: it is one plain
 * sentence, short enough to be read at a glance, and it carries no markup, because neither surface
 * renders any. A backtick or a link in a push body is printed as the characters themselves.
 */
function checkUrgentReason(reason: string): string {
	const fail = (why: string): never => {
		throw new Error(`CHANGELOG: the **Urgent.** sentence ${why}.\n  ${reason}\n  ${URGENT_EXPECTED_LINE}`);
	};
	if (reason.length === 0) fail("is empty");
	if (reason.length > URGENT_REASON_MAX) {
		fail(`is ${reason.length} characters, and the limit is ${URGENT_REASON_MAX}`);
	}
	if (reason.includes("`")) fail("holds a backtick, and neither the push nor the card renders code");
	if (/\[[^\]]*\]\([^)]*\)/.test(reason)) fail("holds a markdown link, which no surface renders");
	if (!reason.endsWith(".")) fail("does not end with a period");
	return reason;
}

/**
 * THE URGENT MARKER, or null (ADR 0046).
 *
 * The person cutting the release may put ONE line directly under the release heading, above the
 * first `###` group, in the same bold-lead style as a bullet:
 *
 *   **Urgent.** The 1.9.1 cache reaper deletes live entries, take this today.
 *
 * That position and no other. A line further down the section is part of a group and is read as
 * prose, exactly as it was before this existed. An absent line is the ordinary release.
 *
 * The line changes the DELIVERY of the release, never its number: the phone keeps the daily digest
 * cadence for it instead of folding it into the weekly patch window.
 *
 * A NEAR MISS STOPS THE RELEASE. `**urgent**`, `Urgent:` and a bold lead with no sentence after it
 * are all somebody trying to mark a release urgent, and reading one of them as prose would publish
 * a fix on the weekly window while its author believed it was on the daily one. There is no silent
 * arm of this function: it returns the marker, returns null, or throws.
 */
export function parseUrgent(changelog: string, version: string): { reason: string } | null {
	const { lines } = sectionLines(changelog, version);
	for (const raw of lines) {
		if (raw.startsWith("### ")) return null; // the groups have started; nothing above them said it
		const line = raw.trim();
		if (!URGENT_NEAR_MISS.test(line)) continue;
		const match = URGENT_EXACT.exec(line);
		if (!match) {
			throw new Error(
				`CHANGELOG [${version}]: this line looks like the urgent marker and is not it.\n  ${line}\n` +
					`  ${URGENT_EXPECTED_LINE}`,
			);
		}
		return { reason: checkUrgentReason((match[1] ?? "").trim()) };
	}
	return null;
}

/** Reads one version's section into its groups. Throws with the reason when the shape is wrong. */
export function parseSection(changelog: string, version: string): Section {
	const { date, lines } = sectionLines(changelog, version);
	return { version, date, groups: groupsOf(lines, version) };
}

/**
 * The same check over `## [Unreleased]`, which has no date and so no `parseSection`. This is what
 * CI runs, so a bullet the release page could not print turns the build red on the commit that
 * wrote it, days before anyone pushes a tag. Throws with the reason, returns the parsed groups
 * when the section is well shaped (an empty section is well shaped).
 */
export function checkUnreleased(changelog: string): Group[] {
	const lines = toLines(changelog);
	const body: string[] = [];
	let inside = false;
	for (const line of lines) {
		if (line.startsWith("## [Unreleased]")) {
			inside = true;
			continue;
		}
		if (line.startsWith("## ")) inside = false;
		if (inside) body.push(line);
	}
	return groupsOf(body, "[Unreleased]");
}

/**
 * GitHub's anchor for a `## [x.y.z] - YYYY-MM-DD` heading. Its slugger lowercases the heading
 * text, removes every character that is not a letter, a digit, a space or a hyphen, and then
 * turns each remaining space into a hyphen. So `[1.5.0] - 2026-09-04` loses its brackets and its
 * dots, and its three spaces become three hyphens: `150---2026-09-04`. A prerelease keeps the
 * hyphen it already carries and loses only the dot, so `[1.7.0-beta.1] - 2026-10-01` becomes
 * `170-beta1---2026-10-01`.
 *
 * Verified against a live rendered page, not assumed:
 *   curl -sL https://github.com/AltanS/collie/blob/v1.5.0/CHANGELOG.md | grep -o 'user-content-150---2026-09-04'
 */
export function changelogAnchor(version: string, date: string): string {
	return `${version.replace(/\./g, "")}---${date}`;
}

/**
 * The update commands, open on the page and first on it. A phone reader arrives from the in-app
 * update banner (web/src/components/update-banner.tsx) to copy one command, so this may never sit
 * behind a `<details>` and may never sit below the change list.
 */
function updateBlock(repo: string, tag: string): string[] {
	return [
		"## Update",
		"",
		"**Already on 1.x?** One command, then the phone updates itself within a minute.",
		"",
		// Two spellings, because there are two kinds of install and neither command works on the
		// other: a Herdr-managed checkout has plugin actions, a downloaded binary install has
		// `collie` on PATH (M14/01 §8).
		"```",
		"collie update                                              # downloaded install (install.sh or a tarball below)",
		"herdr plugin action invoke update --plugin herdr.collie    # Herdr plugin install",
		"```",
		"",
		"Check with `collie version` or `herdr plugin action invoke version --plugin herdr.collie`.",
		"",
		// The 0.x crossing rides on EVERY release, not only 1.0.0's. A 0.x install's update banner
		// points at the newest release, so a reader who never opens 1.0.0's notes must still find
		// this line here (M14/01 §8).
		`**Coming from 0.x?** \`collie update\` will not cross a major. Follow [Upgrading from 0.x to 1.0](https://github.com/${repo}/blob/${tag}/docs/upgrading.md#upgrading-from-0x-to-10).`,
	];
}

/** The by-hand checksum recipe, folded into a `<details>`. */
function verifyBlock(repo: string, tag: string, version: string): string[] {
	const asset = `collie-${version}-linux-x64.tar.gz`;
	const base = `https://github.com/${repo}/releases/download/${tag}`;
	return [
		"<details><summary>Verify a download by hand</summary>",
		"",
		"```",
		`curl -fLO ${base}/${asset}`,
		`curl -fLO ${base}/${asset}.sha256`,
		`sha256sum -c ${asset}.sha256   # macOS: shasum -a 256 -c`,
		"```",
		"",
		"A sha256 catches a corrupt or truncated download. It does not prove who built the file,",
		"HTTPS and the pinned github.com host carry that.",
		"",
		"</details>",
	];
}

/**
 * The whole release page body for one version.
 *
 * `previousTag` is a real tag on the remote or nothing. It is NOT derived from the CHANGELOG:
 * headings exist for betas 33 to 41 that were cut and never tagged (CLAUDE.md, *Versioning*), so
 * a heading-derived compare link would point at a ref that does not exist and 404. The workflow
 * asks git for the tag before this commit and passes what git answers.
 */
export function renderBody(
	changelog: string,
	version: string,
	repo: string,
	tag: string,
	previousTag: string | null = null,
): string {
	const section = parseSection(changelog, version);
	const anchor = changelogAnchor(version, section.date);
	// THE URGENT LINE STAYS AS IT WAS WRITTEN, AND IT GOES FIRST (ADR 0046). It is the one sentence a
	// reader has to see before the update command, so it sits above the block a phone came here to
	// copy from. One line, the author's own, with no wrapper around it.
	const urgent = parseUrgent(changelog, version);
	const lines: string[] = [];
	if (urgent) lines.push(`**Urgent.** ${urgent.reason}`, "");
	lines.push(...updateBlock(repo, tag), "", "## What changed", "");

	for (const group of section.groups) {
		if (group.leads.length === 0) continue;
		lines.push(`**${group.name}**`, "");
		group.leads.forEach((lead, i) => {
			const credits = group.credits[i] ?? [];
			lines.push(credits.length > 0 ? `- ${lead} ${creditText(credits)}` : `- ${lead}`);
		});
		lines.push("");
	}

	lines.push(
		`Full detail with commits: [${version} in the changelog](https://github.com/${repo}/blob/${tag}/CHANGELOG.md#${anchor})`,
		"",
	);

	if (previousTag) {
		lines.push(
			`Compare: [${previousTag}...${tag}](https://github.com/${repo}/compare/${previousTag}...${tag})`,
			"",
		);
	}

	lines.push(...verifyBlock(repo, tag, version));
	return `${lines.join("\n")}\n`;
}

// ── CLI ────────────────────────────────────────────────────────────────────────────────────────

function flag(argv: string[], name: string): string | null {
	const at = argv.indexOf(`--${name}`);
	if (at === -1) return null;
	return argv[at + 1] ?? null;
}

function main(argv: string[]): void {
	const version = flag(argv, "version");
	const repo = flag(argv, "repo");
	const tag = flag(argv, "tag");
	const previousTag = flag(argv, "previous-tag");
	const changelogPath = flag(argv, "changelog") ?? "CHANGELOG.md";

	if (!version || !repo || !tag) {
		console.error(
			"usage: bun scripts/release-notes.ts --version 1.6.0 --repo AltanS/collie --tag v1.6.0 " +
				"[--previous-tag v1.5.6] [--changelog CHANGELOG.md]",
		);
		process.exit(1);
	}

	try {
		const changelog = readFileSync(changelogPath, "utf8");
		process.stdout.write(renderBody(changelog, version, repo, tag, previousTag || null));
	} catch (error) {
		console.error(`✗ release-notes: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

if (import.meta.main) main(process.argv.slice(2));
