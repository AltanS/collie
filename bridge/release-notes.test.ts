// The release notes chain, from the release to the Updates page (1.21.1).
//
// Altan, 2026-10-13: "I also thought that we'd have release notes by now for new updates." The chain
// had no notes link at all. The release job wrote the notes into the GitHub Release BODY, which no
// installed Collie reads, and into `collie-release.json` it wrote only the version, the crew wire
// version and the urgent line. So the bridge had nothing to send and the card listed version numbers.
// These cases pin each link: the sidecar the release publishes, the reading the bridge keeps, the
// running version's own CHANGELOG, and the one route that carries both.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonValue } from "./json.ts";
import { GROUPS } from "../scripts/release-notes.ts";
import { currentNotesReader, notesFromChangelog } from "./release-notes.ts";
import {
  type ApiTag,
  NOTES_LEAD_CHARS,
  NOTES_GROUPS,
  NOTES_LEADS_MAX,
  parseNotesField,
  parseReleaseReading,
  UpdateMonitor,
  type UpdateMonitorDeps,
  type UpdateStore,
} from "./update.ts";

const apiTags = (...names: string[]): ApiTag[] => names.map((name) => ({ name, sha: `sha-${name}` }));

/** The asset v1.21.0 published, captured 2026-10-13. The release BODY carried "## What changed";
 *  this, the one document the bridge reads, carried no notes at all. */
const V1_21_0_SIDECAR: JsonValue = { version: "1.21.0", crewProtocol: 2 };

/** A sidecar as the release job writes it from 1.21.1 on. */
const NEXT_SIDECAR: JsonValue = {
  version: "1.21.1",
  crewProtocol: 2,
  notes: [
    { name: "Fixed", leads: ["The red \"Could not update\" row closes when you tap its ✕."] },
    { name: "Added", leads: ["The Updates page lists what an update changes."] },
  ],
};

const CHANGELOG = `# Changelog

## [Unreleased]

## [1.21.1] - 2026-10-14

### Fixed

- **The red row closes.** Detail. ([abc1234](https://github.com/AltanS/collie/commit/abc1234))

## [1.21.0] - 2026-10-13

### Added

- **A durable agent program joins your crew.** Detail that the page does not print.
  It wraps onto a second line. ([abc1234](https://github.com/AltanS/collie/commit/abc1234))

### Fixed

- **Windows reaches a durable program over HTTPS only.** Detail. Thanks @someone (#1).
`;

describe("the sidecar's notes field", () => {
  it("v1.21.0's own asset carries no notes, which is the reported gap", () => {
    expect(parseReleaseReading(V1_21_0_SIDECAR)?.notes).toBeUndefined();
  });

  it("a sidecar from 1.21.1 on carries the leads, in the release page's group order", () => {
    expect(parseReleaseReading(NEXT_SIDECAR)?.notes).toEqual([
      { name: "Added", leads: ["The Updates page lists what an update changes."] },
      { name: "Fixed", leads: ["The red \"Could not update\" row closes when you tap its ✕."] },
    ]);
  });

  it("a bad notes field is an ordinary release, never an unreadable one", () => {
    for (const notes of ["text", 3, null, {}, [{ name: "Secrets", leads: ["x"] }], [{ name: "Fixed", leads: "x" }]]) {
      const reading = parseReleaseReading({ version: "1.21.1", crewProtocol: 2, notes });
      expect(reading).toEqual({ version: "1.21.1", crewProtocol: 2 });
    }
  });

  it("knows the same five groups the release page prints, in the same order", () => {
    expect(NOTES_GROUPS).toEqual([...GROUPS]);
  });

  it("caps what a download can put on the page", () => {
    const long = "word ".repeat(100).trim();
    const many = Array.from({ length: NOTES_LEADS_MAX + 5 }, (_, i) => `Lead ${i}.`);
    const groups = parseNotesField([
      { name: "Fixed", leads: [long, 7, ""] },
      { name: "Added", leads: many },
      { name: "Added", leads: ["a second Added group is dropped"] },
    ]);
    expect(groups?.[0]?.leads).toHaveLength(NOTES_LEADS_MAX);
    const cut = groups?.[1]?.leads[0] ?? "";
    expect(cut.length).toBeLessThanOrEqual(NOTES_LEAD_CHARS + 1);
    expect(cut.endsWith("…")).toBe(true);
    expect(groups?.[1]?.leads).toHaveLength(1);
  });
});

describe("the running version's notes, from its own CHANGELOG", () => {
  it("reads one section's leads, folded lines and all, and drops the detail", () => {
    expect(notesFromChangelog(CHANGELOG, "1.21.0")).toEqual([
      { name: "Added", leads: ["A durable agent program joins your crew."] },
      { name: "Fixed", leads: ["Windows reaches a durable program over HTTPS only."] },
    ]);
  });

  it("a version with no section, or a section the page could not print, is no notes and no throw", () => {
    expect(notesFromChangelog(CHANGELOG, "9.9.9")).toBeNull();
    expect(notesFromChangelog("## [1.0.0] - 2026-01-01\n\n- no group\n", "1.0.0")).toBeNull();
  });

  it("an Edge build reads the section of its base version (M60 spec 01)", async () => {
    expect(notesFromChangelog(CHANGELOG, "1.21.0-edge.2")).toEqual(notesFromChangelog(CHANGELOG, "1.21.0"));
    const reader = currentNotesReader("/root", "1.21.0-edge.2", "u", async () => CHANGELOG);
    // The version stays the build's own, so the page names what is running; the notes are the base's.
    expect((await reader())?.version).toBe("1.21.0-edge.2");
    expect((await reader())?.groups[0]?.name).toBe("Added");
  });

  it("reads the file once, and a missing file is null", async () => {
    let reads = 0;
    const reader = currentNotesReader("/root", "1.21.0", "https://example.test/v1.21.0", async (path) => {
      reads += 1;
      expect(path).toBe(join("/root", "CHANGELOG.md"));
      return CHANGELOG;
    });
    const first = await reader();
    await reader();
    expect(reads).toBe(1);
    expect(first?.version).toBe("1.21.0");
    expect(first?.url).toBe("https://example.test/v1.21.0");
    expect(first?.groups[0]?.name).toBe("Added");

    const missing = currentNotesReader("/root", "1.21.0", "u", async () => {
      throw new Error("ENOENT");
    });
    expect(await missing()).toBeNull();
  });

  it("this repository's own CHANGELOG reads for its newest release", () => {
    const changelog = readFileSync(join(import.meta.dir, "..", "CHANGELOG.md"), "utf8");
    const newest = /^## \[(\d[^\]]*)\] - \d{4}-\d{2}-\d{2}/m.exec(changelog)?.[1] ?? "";
    expect(notesFromChangelog(changelog, newest)?.length ?? 0).toBeGreaterThan(0);
  });
});

const quietStore: UpdateStore = {
  lastNotified: () => null,
  lastPushedAt: () => null,
  setLastNotified: async () => {},
  dismissedVersion: () => null,
  dismissedCrewVersion: () => null,
  dismissedCrewAt: () => null,
  setDismissed: async () => {},
};

function monitor(over: Partial<UpdateMonitorDeps> = {}) {
  const asked: string[] = [];
  const m = new UpdateMonitor({
    repo: "AltanS/collie",
    current: "1.21.0",
    installKind: "detached-checkout",
    instance: null,
    packageCommand: null,
    bootVersion: "1.21.0",
    liveVersion: () => "1.21.0",
    exeReplaced: () => false,
    startupStamp: "S",
    fetchTags: async () => apiTags("v1.21.0", "v1.21.1", "v1.21.2"),
    crewProtocol: 2,
    crewMode: () => "solo",
    fetchReleaseReading: async (version) => {
      asked.push(version);
      if (version === "1.21.1") return parseReleaseReading(NEXT_SIDECAR);
      return { version, crewProtocol: 2 };
    },
    bridgeStamp: () => "S",
    store: quietStore,
    runState: () => null,
    now: () => new Date(2026, 9, 14, 10).getTime(),
    updatesEnabled: () => false,
    notify: () => {},
    currentNotes: currentNotesReader("/root", "1.21.0", "https://github.com/AltanS/collie/releases/tag/v1.21.0", async () => CHANGELOG),
    ...over,
  });
  return { m, asked };
}

describe("UpdateMonitor.notes, what GET /api/update/check carries", () => {
  it("names the offered release's notes and the running version's, with no request of its own", async () => {
    const { m, asked } = monitor();
    await m.checkRelease();
    const before = asked.length;
    const notes = await m.notes();
    // The offered notes are the readings the check already holds; asking for them reads nothing.
    expect(asked.length).toBe(before);
    expect(notes.offered).toEqual([
      {
        version: "1.21.1",
        url: "https://github.com/AltanS/collie/releases/tag/v1.21.1",
        groups: [
          { name: "Added", leads: ["The Updates page lists what an update changes."] },
          { name: "Fixed", leads: ["The red \"Could not update\" row closes when you tap its ✕."] },
        ],
      },
    ]);
    expect(notes.current?.version).toBe("1.21.0");
    expect(notes.current?.groups.map((g) => g.name)).toEqual(["Added", "Fixed"]);
  });

  it("before any check, and with no CHANGELOG reader, there is nothing to list", async () => {
    const { m } = monitor({ currentNotes: undefined });
    expect(await m.notes()).toEqual({ current: null, offered: [] });
  });
});
