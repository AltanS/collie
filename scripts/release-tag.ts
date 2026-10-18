// What a release tag names, and the three version-file stamps it needs (M60 spec 01, ADR 0110).
//
// Pure, and with no shebang, so `cli/update.ts` can import it: the in-place updater stamps an Edge
// suffix from the tag it checks out exactly as the release runner does, and `cli/main.test.ts` walks
// the CLI's static imports with a transpiler that refuses a `#!` line. `release-version.ts` is the
// runner's command around these and re-exports them.

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
