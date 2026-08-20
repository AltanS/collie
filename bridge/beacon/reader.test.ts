import { describe, expect, test } from "bun:test";

import { parseBeacon } from "./parse.ts";
import { beaconFileName, beaconKey, beaconKeyOf, beaconsDir } from "./paths.ts";
import { type BeaconDirectory, type BeaconLiveness, markersIn, readBeacons } from "./reader.ts";
import { BEACON_SCHEMA_VERSION, BEACON_TTL_MS, type BeaconMarker, type BeaconReading } from "./types.ts";

// The beacon contract, driven the way the rest of the bridge's pure logic is driven: a fake
// directory and a fake pid probe, no temp files, no live process, no clock of its own.
//
// What these tests are FOR is the set of rules a later change could plausibly break without any
// type error: expiry's two clocks, the expired-vs-absent split (an expired beacon keeps its session
// ref and loses its status; an absent one supplies nothing at all), the marker list under nesting,
// tolerance of a directory somebody else has been writing into, and the stability of the pane key.

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

/** A pid the fake liveness probe reports as running, with the start time the fixtures store. */
const LIVE_PID = 4242;
const LIVE_PID_START = 1_000_000;

const TMUX_MARKER: BeaconMarker = { namespace: "tmux", scope: "/tmp/tmux-1000/default", pane: "%7" };
const ZELLIJ_MARKER: BeaconMarker = { namespace: "zellij", scope: "work", pane: "3" };

interface BeaconFixture {
  readonly markers?: readonly BeaconMarker[];
  readonly status?: string;
  readonly pid?: number;
  readonly pidStartTime?: number;
  readonly heartbeatMs?: number;
  readonly harness?: string;
  readonly schemaVersion?: number;
}

/** A well-formed beacon document, live as of {@link NOW} unless a field is overridden. */
function beacon(fixture: BeaconFixture = {}) {
  return {
    schemaVersion: fixture.schemaVersion ?? BEACON_SCHEMA_VERSION,
    harness: fixture.harness ?? "claude",
    session: { kind: "id", value: "0f9d1c2e-1111-4222-8333-444455556666" },
    status: fixture.status ?? "working",
    pid: fixture.pid ?? LIVE_PID,
    pidStartTime: fixture.pidStartTime ?? LIVE_PID_START,
    markers: fixture.markers ?? [TMUX_MARKER],
    heartbeatMs: fixture.heartbeatMs ?? NOW - 60_000,
  };
}

/** The directory seam over a plain map of name → text. Missing names read as null, like the real one. */
function directoryOf(files: Record<string, string>): BeaconDirectory {
  return {
    list: () => Promise.resolve(Object.keys(files)),
    read: (name: string) => Promise.resolve(files[name] ?? null),
  };
}

/** A directory holding exactly the beacons given, each under the name its own markers digest to. */
function directoryOfBeacons(...documents: ReturnType<typeof beacon>[]): BeaconDirectory {
  const files: Record<string, string> = {};
  for (const document of documents) {
    files[beaconFileName(beaconKey(document.markers))] = JSON.stringify(document);
  }
  return directoryOf(files);
}

/** Only {@link LIVE_PID} is running, and it started at {@link LIVE_PID_START}. */
const liveness: BeaconLiveness = {
  startTimeOf: (pid: number) => Promise.resolve(pid === LIVE_PID ? LIVE_PID_START : null),
};

function sweep(directory: BeaconDirectory, now = NOW): Promise<readonly BeaconReading[]> {
  return readBeacons({ directory, liveness, now: () => now });
}

describe("the pane key", () => {
  test("is stable for a marker set, and does not depend on the order they were seen in", async () => {
    // Pinned, not recomputed: the key names a FILE, so a change to the digest orphans every beacon
    // on every host at once. If this literal has to move, that is a schema change.
    expect(beaconKey([TMUX_MARKER])).toBe("79487966109b824e");
    expect(beaconKey([ZELLIJ_MARKER])).toBe("1628cfc66ba3cf12");
    expect(beaconKey([TMUX_MARKER, ZELLIJ_MARKER])).toBe("4870fb192082528c");
    expect(beaconKey([ZELLIJ_MARKER, TMUX_MARKER])).toBe("4870fb192082528c");
    await Promise.resolve();
  });

  test("distinguishes the same pane id in another addressing scope", () => {
    // The whole reason `scope` exists: pane ids are per-server on tmux and per-session on zellij, so
    // `%7` on a second tmux server is a different pane and must never inherit this one's identity.
    const otherServer: BeaconMarker = { ...TMUX_MARKER, scope: "/tmp/tmux-1000/other" };
    expect(beaconKey([otherServer])).not.toBe(beaconKey([TMUX_MARKER]));
  });

  test("round-trips through the file name, and rejects a name that is not ours", () => {
    const key = beaconKey([TMUX_MARKER]);
    expect(beaconKeyOf(beaconFileName(key))).toBe(key);
    expect(beaconKeyOf("notes.txt")).toBeNull();
    expect(beaconKeyOf("../../etc/passwd")).toBeNull();
    expect(beaconKeyOf("README.json")).toBeNull();
  });

  test("the directory hangs off the resolved state dir", () => {
    expect(beaconsDir("/var/state/collie")).toBe("/var/state/collie/beacons");
  });
});

describe("expiry", () => {
  test("a fresh heartbeat and a living pid is live, and carries the status", async () => {
    const readings = await sweep(directoryOfBeacons(beacon()));
    expect(readings).toHaveLength(1);
    const [reading] = readings;
    expect(reading?.liveness).toBe("live");
    expect(reading?.liveness === "live" ? reading.status : null).toBe("working");
  });

  test("a dead pid expires the beacon however fresh its heartbeat is", async () => {
    const readings = await sweep(directoryOfBeacons(beacon({ pid: 9999, heartbeatMs: NOW })));
    expect(readings[0]?.liveness).toBe("expired");
  });

  test("a RECYCLED pid expires the beacon — it is running, but it is not ours", async () => {
    // The pid-reuse guard, and the reason `pidStartTime` is stored at all: without it this record
    // would read as live and hand a stranger's process the dead agent's identity.
    const recycled = beacon({ pid: LIVE_PID, pidStartTime: LIVE_PID_START + 1, heartbeatMs: NOW });
    const readings = await sweep(directoryOfBeacons(recycled));
    expect(readings[0]?.liveness).toBe("expired");
  });

  test("a stale heartbeat expires the beacon even while its pid still lives", async () => {
    const stale = beacon({ heartbeatMs: NOW - BEACON_TTL_MS - 1 });
    expect((await sweep(directoryOfBeacons(stale)))[0]?.liveness).toBe("expired");
  });

  test("the TTL is longer than a long agent turn", async () => {
    // The rule BEACON_TTL_MS exists for: a Claude session can think for half an hour between
    // UserPromptSubmit and Stop with no hook firing, and expiring it would call a working agent gone.
    const thinking = beacon({ heartbeatMs: NOW - 45 * 60 * 1000 });
    expect((await sweep(directoryOfBeacons(thinking)))[0]?.liveness).toBe("live");
    // And exactly at the boundary it is still live; one millisecond past it is not.
    const atBoundary = beacon({ heartbeatMs: NOW - BEACON_TTL_MS });
    expect((await sweep(directoryOfBeacons(atBoundary)))[0]?.liveness).toBe("live");
  });
});

describe("expired is not absent", () => {
  test("an expired beacon keeps its session ref and its harness, and has no status at all", async () => {
    const readings = await sweep(directoryOfBeacons(beacon({ pid: 9999 })));
    const [reading] = readings;
    expect(reading?.liveness).toBe("expired");
    expect(reading?.harness).toBe("claude");
    // History is history: a finished conversation is still readable (M11/04).
    expect(reading?.session.value).toBe("0f9d1c2e-1111-4222-8333-444455556666");
    expect(reading?.session.kind).toBe("id");
    // And the status is gone from the value, not merely ignored by its reader.
    expect(reading === undefined ? true : "status" in reading).toBe(false);
  });

  test("an absent beacon supplies nothing — no reading, and never an idle one", async () => {
    // Absence must not become `idle`: "no beacon" and "the agent is resting" look identical from
    // outside and mean opposite things to a triage sort.
    expect(await sweep(directoryOf({}))).toEqual([]);
  });

  test("an unlistable directory reads as absent rather than as a failure", async () => {
    const missing: BeaconDirectory = {
      list: () => Promise.resolve(null),
      read: () => Promise.resolve(null),
    };
    expect(await readBeacons({ directory: missing, liveness, now: () => NOW })).toEqual([]);
  });
});

describe("markers are a list", () => {
  test("a nested pane answers both multiplexers from one file", async () => {
    const nested = beacon({ markers: [TMUX_MARKER, ZELLIJ_MARKER] });
    const [reading] = await sweep(directoryOfBeacons(nested));
    expect(reading).toBeDefined();
    if (reading === undefined) return;
    expect(markersIn(reading, "tmux")).toEqual([TMUX_MARKER]);
    expect(markersIn(reading, "zellij")).toEqual([ZELLIJ_MARKER]);
    expect(markersIn(reading, "screen")).toEqual([]);
  });

  test("the tmux marker is the Collie pane id verbatim — the join is string equality", async () => {
    const [reading] = await sweep(directoryOfBeacons(beacon()));
    expect(reading).toBeDefined();
    if (reading === undefined) return;
    const [marker] = markersIn(reading, "tmux");
    // `$TMUX_PANE` is `%7`, and `%` is legal in a Collie id for precisely this reason. No transform.
    expect(marker?.pane).toBe("%7");
    expect(marker?.scope).toBe("/tmp/tmux-1000/default");
  });

  test("the zellij marker is stored as the BARE integer the env held, with no prefix", async () => {
    const [reading] = await sweep(directoryOfBeacons(beacon({ markers: [ZELLIJ_MARKER] })));
    expect(reading).toBeDefined();
    if (reading === undefined) return;
    const [marker] = markersIn(reading, "zellij");
    // `$ZELLIJ_PANE_ID` is `3`, not the namespaced Collie id. The adapter's matcher adds zellij's
    // pane-id prefix at the join (M11/03) — the file never carries it, so this value stays exactly
    // what the multiplexer put in the environment.
    expect(marker?.pane).toBe("3");
    expect(/^\d+$/u.test(marker?.pane ?? "")).toBe(true);
    expect(marker?.scope).toBe("work");
  });
});

describe("garbage", () => {
  test("a directory of garbage yields zero beacons and never throws", async () => {
    const directory = directoryOf({
      // A torn write: the emitter renames, but a foreign process need not.
      "aaaaaaaaaaaaaaaa.json": '{"schemaVersion":1,"harness":"cla',
      // Not JSON at all.
      "bbbbbbbbbbbbbbbb.json": "hello, i am a log file\n",
      // JSON, but not an object.
      "cccccccccccccccc.json": "[1,2,3]",
      // Empty.
      "dddddddddddddddd.json": "",
      // Somebody else's file, in our directory.
      "notes.txt": "shopping list",
      // A name that is not a key at all.
      "beacons.json.bak": JSON.stringify(beacon()),
    });
    expect(await sweep(directory)).toEqual([]);
  });

  test("garbage beside a good beacon does not stop the sweep", async () => {
    const good = beacon();
    const directory = directoryOf({
      "aaaaaaaaaaaaaaaa.json": "{{{",
      [beaconFileName(beaconKey(good.markers))]: JSON.stringify(good),
      "zzzzzzzzzzzzzzzz.json": "null",
    });
    const readings = await sweep(directory);
    expect(readings).toHaveLength(1);
    expect(readings[0]?.harness).toBe("claude");
  });

  test("a read that fails mid-sweep is skipped, not raised", async () => {
    const good = beacon();
    const name = beaconFileName(beaconKey(good.markers));
    const flaky: BeaconDirectory = {
      list: () => Promise.resolve([name, "aaaaaaaaaaaaaaaa.json"]),
      read: (candidate: string) =>
        candidate === name
          ? Promise.resolve(JSON.stringify(good))
          : Promise.reject(new Error("EACCES")),
    };
    const readings = await readBeacons({ directory: flaky, liveness, now: () => NOW });
    expect(readings).toHaveLength(1);
  });

  test("a pid probe that throws is treated as a dead pid, not as an error", async () => {
    const angry: BeaconLiveness = { startTimeOf: () => Promise.reject(new Error("EPERM")) };
    const readings = await readBeacons({
      directory: directoryOfBeacons(beacon()),
      liveness: angry,
      now: () => NOW,
    });
    expect(readings[0]?.liveness).toBe("expired");
  });
});

describe("foreign and future files", () => {
  test("a newer schema is skipped rather than guessed at", async () => {
    const future = beacon({ schemaVersion: BEACON_SCHEMA_VERSION + 1 });
    expect(await sweep(directoryOfBeacons(future))).toEqual([]);
  });

  test("a beacon under the wrong name is refused, so no pane gets a second identity", async () => {
    // A copied or renamed beacon would otherwise present its markers twice, and the join answers a
    // pane once. The file name must be the digest of the record's own markers.
    const document = beacon();
    const directory = directoryOf({
      [beaconFileName(beaconKey(document.markers))]: JSON.stringify(document),
      [beaconFileName(beaconKey([ZELLIJ_MARKER]))]: JSON.stringify(document),
    });
    const readings = await sweep(directory);
    expect(readings).toHaveLength(1);
  });

  test("a record missing anything load-bearing is not a beacon", () => {
    expect(parseBeacon(JSON.stringify(beacon({ markers: [] })))).toBeNull();
    expect(parseBeacon(JSON.stringify(beacon({ status: "thinking" })))).toBeNull();
    expect(parseBeacon(JSON.stringify(beacon({ harness: "   " })))).toBeNull();
    expect(parseBeacon(JSON.stringify(beacon({ pid: 0 })))).toBeNull();
    expect(parseBeacon(JSON.stringify(beacon({ pid: 1.5 })))).toBeNull();
    expect(parseBeacon(JSON.stringify(beacon({ heartbeatMs: -1 })))).toBeNull();
  });

  test("a malformed marker entry costs its own entry, never the whole pane", () => {
    // The "works until you nest" bug in miniature: the outer multiplexer's half being unreadable
    // must not take the inner one's identity down with it.
    const document = { ...beacon(), markers: [TMUX_MARKER, { namespace: "zellij", pane: 3 }] };
    const record = parseBeacon(JSON.stringify(document));
    expect(record?.markers).toEqual([TMUX_MARKER]);
  });

  test("a session ref of an unknown kind is refused", () => {
    const document = { ...beacon(), session: { kind: "url", value: "https://example.invalid" } };
    expect(parseBeacon(JSON.stringify(document))).toBeNull();
  });

  test("a path session ref survives parsing — and is confined downstream, never here", () => {
    // Parsing is not trusting. A `path` ref has exactly pi's standing: attacker-shaped by
    // construction, and it reaches the filesystem only through journal/files.ts containment (M11/04).
    const document = { ...beacon(), session: { kind: "path", value: "/etc/passwd" } };
    expect(parseBeacon(JSON.stringify(document))?.session).toEqual({
      kind: "path",
      value: "/etc/passwd",
    });
  });
});
