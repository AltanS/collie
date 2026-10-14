// ── WHAT A RELEASE CHANGED, AS THE PHONE READS IT (1.21.1) ──────────────────────────────────────
//
// The Updates page names what an update brings, and what the running version changed, in the same
// lines the GitHub Release page prints: each CHANGELOG bullet's bold lead, under its group. Two
// sources, and neither is a new network call:
//
//   • OFFERED versions come from each release's `collie-release.json`, which the update check
//     already reads for the crew link and the urgent marker (M27/06, ADR 0046). A release from
//     1.21.1 on carries a `notes` field there; an older one carries none and simply lists nothing.
//   • The CURRENT version comes from the `CHANGELOG.md` that ships beside `package.json` in every
//     checkout and every payload. Read once, from disk, the way the version itself is.
//
// The phone never reads a release body. A GitHub body is prose for a browser (update commands,
// checksums, links), and a parser over it would be a second reading of a CHANGELOG that is already
// parsed, once, at release time (`scripts/release-notes.ts`).
//
// ── BOUNDED, BECAUSE THE SIDECAR IS A DOWNLOAD ──────────────────────────────
// The document comes off the network, so its notes are read the way its urgent line is: anything
// that is not the shape is dropped, and the rest is capped. A release with a hundred bullets is
// still a release; it is shown as its first `NOTES_LEADS_MAX` lines per group. That reader,
// `parseNotesField`, sits in `update.ts` beside `parseReleaseReading`, the boundary it belongs to.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parseSection } from "../scripts/release-notes.ts";
import { parseNotesField } from "./update.ts";

/** One CHANGELOG group of a release, as its bold leads. `name` is one of `GROUPS`. */
export interface ReleaseNotesGroup {
  name: string;
  leads: string[];
}

/** What one release changed. `url` is that release's GitHub page, built from the repo and the
 *  version and never taken from a document. */
export interface ReleaseNotes {
  version: string;
  url: string;
  groups: ReleaseNotesGroup[];
}

/**
 * One version's section of a CHANGELOG, as groups of leads. Null when the file has no such section
 * or the section is not the shape the release page reads. Never throws: the notes are a courtesy on
 * the Updates page, and a CHANGELOG this build cannot read must not take that page down.
 */
export function notesFromChangelog(changelog: string, version: string): ReleaseNotesGroup[] | null {
  try {
    const section = parseSection(changelog, version);
    return parseNotesField(section.groups.map((g) => ({ name: g.name, leads: g.leads })));
  } catch {
    return null;
  }
}

/**
 * The running version's own notes, read from the `CHANGELOG.md` beside its `package.json`, once.
 *
 * Memoised for the process's lifetime, answer and absence alike: the version is fixed at boot, and
 * a file that was not there at the first ask is not worth a disk read on every page open.
 */
export function currentNotesReader(
  rootDir: string,
  version: string,
  url: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, "utf8"),
): () => Promise<ReleaseNotes | null> {
  let held: Promise<ReleaseNotes | null> | null = null;
  return () => {
    held ??= read(join(rootDir, "CHANGELOG.md")).then(
      (text) => {
        const groups = notesFromChangelog(text, version);
        return groups === null ? null : { version, url, groups };
      },
      () => null,
    );
    return held;
  };
}
