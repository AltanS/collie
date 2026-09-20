import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import {
  CREW_BEGUN_MS,
  FRONT_POLL_MS,
  __resetUpdateRunStore,
  crewRunOf,
  getUpdateRunSnapshot,
  noteCrewRunBegun,
  noteSnapshotCrew,
  noteSnapshotRun,
  readUpdateState,
  subscribeUpdateRun,
} from "./update-run-store";
import type { UpdateInfo, UpdatePeerLeg } from "./types";

// The store's half of a crew-only run (M32): where the legs that ride the status come from, which of
// two readings wins, and the one beat after this device's own confirm that nobody else fills. What
// the screen MAKES of those legs is the reducer's, pinned in `update-screen.test.ts`.

const NOW = 1_800_000_000_000;

const status = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  current: "1.9.1",
  latest: "1.9.1",
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  bridgeStale: false,
  checkedAt: NOW - 60_000,
  ...over,
});

const OLD_FAILED: UpdatePeerLeg[] = [{ name: "minibuch", state: "rolled-back", reason: "gate", updatedAt: NOW - 86_400_000 }];
const NEW_MOVING: UpdatePeerLeg[] = [{ name: "minibuch", state: "waiting", version: "1.9.0", updatedAt: NOW - 1_000 }];

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date", "setTimeout", "clearTimeout"] });
  __resetUpdateRunStore();
});

afterEach(() => {
  __resetUpdateRunStore();
  vi.useRealTimers();
});

describe("crewRunOf: the legs a status carries at its top level", () => {
  it("takes the legs, the settle stamp, the target and the lead's version", () => {
    expect(crewRunOf(status({ peers: NEW_MOVING, peersTo: "1.9.1" }))).toEqual({
      legs: NEW_MOVING,
      settledAt: null,
      to: "1.9.1",
      current: "1.9.1",
    });
    expect(crewRunOf(status({ peers: OLD_FAILED, settledAt: NOW - 5, peersTo: "1.9.1" }))?.settledAt).toBe(NOW - 5);
  });

  it("says nothing without top-level legs, and passes on a missing target as null", () => {
    expect(crewRunOf(undefined)).toBeNull();
    expect(crewRunOf(status())).toBeNull();
    expect(crewRunOf(status({ peers: NEW_MOVING }))?.to).toBeNull();
  });
});

describe("the beat after this device's own peers-only confirm", () => {
  it("answers a crew run with no legs at once, so the screen is taken in the same tap", () => {
    noteCrewRunBegun("1.9.1");
    expect(getUpdateRunSnapshot().crewRun).toEqual({ legs: [], settledAt: null, to: "1.9.1", current: "1.9.1" });
  });

  it("sets the PREVIOUS run's legs aside, so last run's failure never flashes up on the tap", () => {
    noteSnapshotCrew(status({ peers: OLD_FAILED, settledAt: NOW - 86_000_000, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual(OLD_FAILED);

    noteCrewRunBegun("1.9.1");
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual([]);
    // A poll that left before the confirm and landed after it: the old run's legs, word for word.
    vi.advanceTimersByTime(500);
    noteSnapshotCrew(status({ peers: OLD_FAILED, settledAt: NOW - 86_000_000, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual([]);
    // The bridge's own `begin` cleared its legs, so the next status carries none. Still the beat.
    noteSnapshotCrew(status());
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual([]);
  });

  it("ends the moment the new run's first legs arrive", () => {
    noteSnapshotCrew(status({ peers: OLD_FAILED, settledAt: NOW - 86_000_000, peersTo: "1.9.1" }));
    noteCrewRunBegun("1.9.1");
    vi.advanceTimersByTime(1_500);
    noteSnapshotCrew(status({ peers: NEW_MOVING, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual(NEW_MOVING);
  });

  it("ends on the first legs even when there was nothing to set aside", () => {
    noteCrewRunBegun("1.9.1");
    noteSnapshotCrew(status({ peers: NEW_MOVING, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual(NEW_MOVING);
  });

  it(`never outlives CREW_BEGUN_MS (${CREW_BEGUN_MS} ms): a run that produced no leg lets go`, () => {
    noteSnapshotCrew(status({ peers: OLD_FAILED, settledAt: NOW - 86_000_000, peersTo: "1.9.1" }));
    noteCrewRunBegun("1.9.1");
    vi.advanceTimersByTime(CREW_BEGUN_MS - 1);
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual([]);
    vi.advanceTimersByTime(1);
    // And the old run's legs do not come back in its place.
    expect(getUpdateRunSnapshot().crewRun).toBeNull();
  });
});

describe("two readings of one status", () => {
  it("keeps the later reading, and hands out the same object while nothing changed", () => {
    noteSnapshotCrew(status({ peers: NEW_MOVING, peersTo: "1.9.1" }));
    const first = getUpdateRunSnapshot().crewRun;
    vi.advanceTimersByTime(1_500);
    noteSnapshotCrew(status({ peers: NEW_MOVING, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun).toBe(first);

    const arrived: UpdatePeerLeg[] = [{ name: "minibuch", state: "done", version: "1.9.1", updatedAt: NOW }];
    vi.advanceTimersByTime(1_500);
    noteSnapshotCrew(status({ peers: arrived, settledAt: NOW, peersTo: "1.9.1" }));
    expect(getUpdateRunSnapshot().crewRun).toMatchObject({ legs: arrived, settledAt: NOW });
  });

  it("never lets the answer to an OLDER question overwrite a poll that has seen the crew move", async () => {
    vi.useRealTimers();
    let answer: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    // The store's own read, asked before the crew moved, answering "no legs" after the poll saw them.
    server.use(
      http.get("/api/update/check", async () => {
        await held;
        return HttpResponse.json({ ...status(), preflight: null, crew: [] });
      }),
    );
    const read = readUpdateState();
    noteSnapshotCrew(status({ peers: NEW_MOVING, peersTo: "1.9.1" }));
    answer?.();
    await read;
    expect(getUpdateRunSnapshot().crewRun?.legs).toEqual(NEW_MOVING);
  });
});

describe("the poll follows the whole update subject, not just the lead's own run", () => {
  // 2026-09-20. A crew update is TWO phases and `arm` watched only the first. On the real 1.11.0 run
  // the lead's own record reached `done` in six seconds, this store stopped polling there, and the
  // member sat on `waiting` for two minutes twenty five seconds before anything told it to move —
  // because `GET /api/update/check` is what makes the lead sweep carrying `X-Crew-Preflight: fresh`,
  // and a member whose verdict the lead does not hold is refused its turn.
  const DONE = {
    schema: 2 as const,
    state: "done" as const,
    from: "1.9.0",
    to: "1.9.1",
    startedAt: NOW - 6_000,
    updatedAt: NOW - 1_000,
    attempt: 0,
    pid: 4242,
  };

  const drive = async (legs: UpdatePeerLeg[], settledAt?: number) => {
    vi.useFakeTimers({
      now: NOW,
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    let checks = 0;
    server.use(
      http.get("*/api/update/check", () => {
        checks += 1;
        return HttpResponse.json(status({ peers: legs, peersTo: "1.9.1" }));
      }),
      http.get("*/standby/update", () => HttpResponse.json(DONE)),
    );
    const stop = subscribeUpdateRun(() => {});
    noteSnapshotRun(DONE);
    noteSnapshotCrew(status(settledAt === undefined ? { peers: legs, peersTo: "1.9.1" } : { peers: legs, peersTo: "1.9.1", settledAt }));
    // Let the ONE read a first subscriber always makes land, then count only what the intervals do.
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS / 2);
    checks = 0;
    await vi.advanceTimersByTimeAsync(FRONT_POLL_MS * 3);
    stop();
    return checks;
  };

  it("keeps reading while a member is still moving under a run the lead has finished", async () => {
    // `NEW_MOVING` is a leg in state `waiting`, which is the exact word the 1.11.0 run froze on. A
    // queued member is MOVING for this purpose: the run is waiting on it, and the read this arms is
    // what unblocks it.
    expect(NEW_MOVING[0]!.state).toBe("waiting");
    // And the legs arrive AFTER the lead's own record has gone `done`, which is the real ordering:
    // `arm` is re-taken on every change rather than decided once, so a later leg re-arms it.
    expect(await drive(NEW_MOVING)).toBeGreaterThan(0);
  });

  it("stops once the lead has stamped the crew settled", async () => {
    expect(await drive(NEW_MOVING, NOW - 1)).toBe(0);
  });

  it("stops when every leg is terminal, even with no settle stamp from an older bridge", async () => {
    expect(await drive([{ name: "minibuch", state: "done", version: "1.9.1", updatedAt: NOW - 1 }])).toBe(0);
  });
});
