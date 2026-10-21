// Tests for bridge/update-line.ts: the two release lines (M60 spec 01, ADR 0110).
//
// The table below IS the contract of `lineOffer`: line x installed build x published tags -> what is
// offered, and where "Go back now" goes. Every reader (the monitor, the update verbs, the phone) gets
// its answer from this one function.
import { describe, expect, test } from "bun:test";

import {
  afterFailedBuild,
  afterRollback,
  baseVersion,
  DEFAULT_UPDATE_LINE,
  isEdgeBuild,
  isStrictRelease,
  lineOffer,
  lineReading,
  parseUpdateLine,
  readUpdateLine,
  REJECTED_MAX,
  UNREADABLE_BY_LAST_STABLE,
  UPDATE_LINE_SCHEMA,
  type UpdateLineRecord,
  updateLinePath,
  withLine,
  writeUpdateLine,
} from "./update-line.ts";

const TAGS = ["v1.22.5", "v1.22.6", "v1.23.0-edge.1", "v1.23.0-edge.2", "v2.0.0", "v2.0.0-edge.1", "v1.0.0-beta.4"];

interface Row {
  readonly name: string;
  readonly line: "stable" | "edge";
  readonly installed: string;
  readonly tags: readonly string[];
  readonly rejected?: readonly string[];
  readonly latest: string | null;
  readonly newer: readonly string[];
  readonly back: string | null;
}

const TABLE: readonly Row[] = [
  {
    name: "Stable on a Stable build: strict releases only, Edge builds unseen",
    line: "stable",
    installed: "1.22.5",
    tags: TAGS,
    latest: "1.22.6",
    newer: ["1.22.6"],
    back: null,
  },
  {
    name: "Edge on a Stable build: the newest Edge build of the same major",
    line: "edge",
    installed: "1.22.6",
    tags: TAGS,
    latest: "1.23.0-edge.2",
    newer: ["1.23.0-edge.1", "1.23.0-edge.2"],
    back: null,
  },
  {
    name: "Edge on an Edge build: the next Edge build",
    line: "edge",
    installed: "1.23.0-edge.1",
    tags: TAGS,
    latest: "1.23.0-edge.2",
    newer: ["1.23.0-edge.2"],
    back: null,
  },
  {
    name: "Edge: a final release supersedes its own Edge builds",
    line: "edge",
    installed: "1.23.0-edge.2",
    tags: [...TAGS, "v1.23.0"],
    latest: "1.23.0",
    newer: ["1.23.0"],
    back: null,
  },
  {
    name: "Edge: an Edge build of the next minor is above the last final",
    line: "edge",
    installed: "1.23.0",
    tags: [...TAGS, "v1.23.0", "v1.24.0-edge.1"],
    latest: "1.24.0-edge.1",
    newer: ["1.24.0-edge.1"],
    back: null,
  },
  {
    name: "Back to Stable, case 1: a Stable at or above the build is an ordinary update",
    line: "stable",
    installed: "1.23.0-edge.2",
    tags: [...TAGS, "v1.23.0"],
    latest: "1.23.0",
    newer: ["1.23.0"],
    back: null,
  },
  {
    name: "Back to Stable, case 2: the Edge build is ahead, so Go back now names the latest Stable",
    line: "stable",
    installed: "1.23.0-edge.2",
    tags: TAGS,
    latest: "1.22.6",
    newer: [],
    back: "1.22.6",
  },
  {
    name: "Back to Stable, case 3: the same build, nothing to do",
    line: "stable",
    installed: "1.23.0",
    tags: [...TAGS, "v1.23.0"],
    latest: "1.23.0",
    newer: [],
    back: null,
  },
  {
    name: "A rejected build is never offered: Edge skips it to the next one",
    line: "edge",
    installed: "1.22.6",
    tags: TAGS,
    rejected: ["1.23.0-edge.2"],
    latest: "1.23.0-edge.1",
    newer: ["1.23.0-edge.1"],
    back: null,
  },
  {
    name: "A rejected build is never offered on Stable either",
    line: "stable",
    installed: "1.22.5",
    tags: TAGS,
    rejected: ["1.22.6"],
    latest: "1.22.5",
    newer: [],
    back: null,
  },
  {
    name: "A major crossing is never offered, on either line",
    line: "edge",
    installed: "1.23.0-edge.2",
    tags: ["v1.23.0-edge.2", "v2.0.0-edge.1", "v2.0.0"],
    latest: "1.23.0-edge.2",
    newer: [],
    back: null,
  },
  {
    name: "Stable on an old beta keeps the legacy train, without Edge builds in it",
    line: "stable",
    installed: "1.0.0-beta.3",
    tags: ["v1.0.0-beta.3", "v1.0.0-beta.4", "v1.0.0-edge.1"],
    latest: "1.0.0-beta.4",
    newer: ["1.0.0-beta.4"],
    back: null,
  },
  {
    name: "A build tail on the installed version is ignored",
    line: "edge",
    installed: "1.23.0-edge.1+ab12cd3",
    tags: TAGS,
    latest: "1.23.0-edge.2",
    newer: ["1.23.0-edge.2"],
    back: null,
  },
];

describe("lineOffer: the resolution table (M60 spec 01)", () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const offer = lineOffer({ tags: row.tags, installed: row.installed, line: row.line, rejected: row.rejected });
      expect(offer).toEqual({ latest: row.latest, newer: row.newer, back: row.back });
    });
  }

  test("an unreadable installed version offers nothing", () => {
    expect(lineOffer({ tags: TAGS, installed: "unknown", line: "edge" })).toEqual({ latest: null, newer: [], back: null });
  });

  test("lineReading carries the line and the state-shape exceptions, which are empty by rule (ADR 0110)", () => {
    const reading = lineReading({ ...DEFAULT_UPDATE_LINE, line: "edge" }, TAGS, "1.22.6");
    expect(reading.line).toBe("edge");
    expect(reading.latest).toBe("1.23.0-edge.2");
    expect(reading.exceptions).toEqual([]);
    expect(UNREADABLE_BY_LAST_STABLE).toEqual([]);
  });
});

describe("the version readings", () => {
  test("isEdgeBuild names the -edge.N tail and nothing else", () => {
    expect(isEdgeBuild("1.23.0-edge.1")).toBe(true);
    expect(isEdgeBuild("1.23.0-edge.12+ab12cd3")).toBe(true);
    expect(isEdgeBuild("1.23.0")).toBe(false);
    expect(isEdgeBuild("1.23.0-edge.01")).toBe(false);
    expect(isEdgeBuild("1.0.0-beta.4")).toBe(false);
    expect(isEdgeBuild("1.4.1-dev+ab12cd3")).toBe(false);
  });

  test("baseVersion is where release notes and CHANGELOG sections are looked up", () => {
    expect(baseVersion("1.23.0-edge.3")).toBe("1.23.0");
    expect(baseVersion("1.23.0-edge.3+ab12cd3")).toBe("1.23.0");
    expect(baseVersion("1.23.0")).toBe("1.23.0");
    expect(baseVersion("1.0.0-beta.4")).toBe("1.0.0-beta.4");
  });

  test("isStrictRelease reads a tag or a version", () => {
    expect(isStrictRelease("v1.22.6")).toBe(true);
    expect(isStrictRelease("1.22.6+ab12cd3")).toBe(true);
    expect(isStrictRelease("1.23.0-edge.1")).toBe(false);
  });
});

describe("the record: update-line.json", () => {
  test("absent, unreadable or another schema reads as Stable with nothing rejected", () => {
    expect(parseUpdateLine(null)).toEqual(DEFAULT_UPDATE_LINE);
    expect(parseUpdateLine("{")).toEqual(DEFAULT_UPDATE_LINE);
    expect(parseUpdateLine("[]")).toEqual(DEFAULT_UPDATE_LINE);
    expect(parseUpdateLine(JSON.stringify({ schema: 2, line: "edge" }))).toEqual(DEFAULT_UPDATE_LINE);
  });

  test("reads the line, the rejected builds and the receipt, and drops what is not a version", () => {
    const record = parseUpdateLine(
      JSON.stringify({
        schema: UPDATE_LINE_SCHEMA,
        line: "edge",
        rejected: ["1.23.0-edge.1", 7, "nonsense", "1.23.0-edge.2+ab12cd3"],
        changedAt: 1_700_000_000_000,
        requestId: "11111111-2222-4333-8444-555555555555",
      }),
    );
    expect(record).toEqual({
      schema: UPDATE_LINE_SCHEMA,
      line: "edge",
      rejected: ["1.23.0-edge.1", "1.23.0-edge.2"],
      changedAt: 1_700_000_000_000,
      requestId: "11111111-2222-4333-8444-555555555555",
    });
    // An unknown line word is Stable, never a guess.
    expect(parseUpdateLine(JSON.stringify({ schema: 1, line: "nightly" })).line).toBe("stable");
  });

  test("withLine moves the clock only when the line changes", () => {
    const edge = withLine(DEFAULT_UPDATE_LINE, "edge", 10, "r-1");
    expect(edge).toEqual({ schema: 1, line: "edge", rejected: [], changedAt: 10, requestId: "r-1" });
    expect(withLine(edge, "edge", 20).changedAt).toBe(10);
  });

  test("a rollback off an Edge build goes back to Stable and rejects the build; off Stable it changes nothing", () => {
    const edge = withLine(DEFAULT_UPDATE_LINE, "edge", 10);
    const after = afterRollback(edge, "1.23.0-edge.2+ab12cd3", 30);
    expect(after).toEqual({ schema: 1, line: "stable", rejected: ["1.23.0-edge.2"], changedAt: 30 });
    expect(afterRollback(after, "1.23.0-edge.2", 40).rejected).toEqual(["1.23.0-edge.2"]);
    expect(afterRollback(edge, "1.22.6", 50)).toBe(edge);
  });

  test("the rejected list keeps the newest hundred", () => {
    let record = DEFAULT_UPDATE_LINE;
    for (let n = 0; n < REJECTED_MAX + 5; n++) record = afterRollback(record, `1.23.0-edge.${n}`, n);
    expect(record.rejected.length).toBe(REJECTED_MAX);
    expect(record.rejected[0]).toBe("1.23.0-edge.5");
  });

  test("written atomically, owner-only, and read back the same", () => {
    const files = new Map<string, string>();
    const ops: string[] = [];
    const writer = {
      mkdirp: (dir: string, mode?: number) => ops.push(`mkdirp ${dir} ${mode?.toString(8)}`),
      write: (path: string, text: string, mode?: number) => {
        files.set(path, text);
        ops.push(`write ${path} ${mode?.toString(8)}`);
      },
      rename: (from: string, to: string) => {
        files.set(to, files.get(from) ?? "");
        files.delete(from);
        ops.push(`rename ${from} ${to}`);
      },
    };
    const record = withLine(DEFAULT_UPDATE_LINE, "edge", 10, "r-1");
    writeUpdateLine(writer, "/state", record);
    expect(ops).toEqual([
      "mkdirp /state 700",
      `write ${updateLinePath("/state")}.tmp 600`,
      `rename ${updateLinePath("/state")}.tmp ${updateLinePath("/state")}`,
    ]);
    expect(readUpdateLine((p) => files.get(p) ?? null, "/state")).toEqual(record);
  });
});

describe("an Edge build that fails its own health check (ADR 0110)", () => {
  const edge: UpdateLineRecord = { ...DEFAULT_UPDATE_LINE, line: "edge", changedAt: 10 };

  test("is rejected, and the line stays where the person set it", () => {
    const after = afterFailedBuild(edge, "v1.23.0-edge.2");
    expect(after).toMatchObject({ line: "edge", rejected: ["1.23.0-edge.2"], changedAt: 10 });
    expect(afterFailedBuild(after, "1.23.0-edge.2")).toBe(after);
  });

  test("a failed strict release is not rejected", () => {
    expect(afterFailedBuild(edge, "1.23.0")).toBe(edge);
  });

  test("the next check offers the build after it, never the failed one", () => {
    const after = afterFailedBuild(edge, "1.23.0-edge.2");
    const offer = lineOffer({ tags: TAGS, installed: "1.22.6", line: after.line, rejected: after.rejected });
    expect(offer.latest).toBe("1.23.0-edge.1");
    expect(offer.newer).not.toContain("1.23.0-edge.2");
  });
});
