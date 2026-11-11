import { afterAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import type { JsonObject, JsonValue } from "../json.ts";
import { CARRY_RETRY_MS, TricksCopySync, type CarryCall, type TricksCopyClient } from "./carry-sync.ts";
import { tricksCarryRoutes } from "./carry-surface.ts";
import { machine, putOnTrick, removeCarryDirs } from "./carry-fixtures.ts";
import type { CrewLink } from "./peer-client.ts";
import { CREW_TRICKS_COPY_CODE_PATH, CREW_TRICKS_COPY_PATH, CREW_TRICKS_COPY_STATE_PATH } from "./router.ts";
import { leadTricks } from "./standby-tricks-lead.ts";
import { StandbyTricksStore, tricksDigest } from "./standby-tricks.ts";
import { switchesPath } from "../tricks/paths.ts";

afterAll(removeCarryDirs);

const LINK: CrewLink = { memberId: "laptop", address: "127.0.0.1:1" };

/** A client that answers through a real deputy store, by the deputy's own routes. Counts every call. */
interface Wired {
  readonly client: TricksCopyClient;
  readonly calls: string[];
  report(): JsonObject;
}

function wired(store: StandbyTricksStore): Wired {
  const routes = tricksCarryRoutes(store);
  const calls: string[] = [];
  const via = (path: string) => async (_link: CrewLink, body: JsonObject): Promise<CarryCall> => {
    calls.push(path);
    // The wire is JSON: what the deputy reads is what survives a round trip.
    // SAFETY: `JSON.parse` of `JSON.stringify` output is a JsonValue by construction.
    const crossed = JSON.parse(JSON.stringify(body)) as JsonValue;
    const answer = await routes.handle(path, { from: "desk", crewId: "crew-1" }, crossed);
    return answer === null ? { kind: "answer", status: 404, body: null } : { kind: "answer", status: answer.status, body: answer.body };
  };
  return { client: { list: via(CREW_TRICKS_COPY_PATH), code: via(CREW_TRICKS_COPY_CODE_PATH), state: via(CREW_TRICKS_COPY_STATE_PATH) }, calls, report: () => routes.report() };
}

describe("the lead keeps its deputy's copy current", () => {
  test("one sync carries list, code and state; the next sweep sends nothing", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs", state: { "a.json": "1\n" } });
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    const w = wired(store);
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client: w.client });
    expect(await sync.run(LINK, w.report())).toBe("done");
    expect(w.calls).toEqual([CREW_TRICKS_COPY_PATH, CREW_TRICKS_COPY_CODE_PATH, CREW_TRICKS_COPY_STATE_PATH]);
    expect((await store.ready()).map((r) => r.trick.id)).toEqual(["legs"]);
    expect(await sync.run(LINK, w.report())).toBe("idle");
    expect(w.calls.length).toBe(3);
    expect(sync.deputyFact()).toMatchObject({ member: "laptop", state: "current", tricks: 1 });
  });

  test("a deputy still missing parts is asked again at most once a minute", async () => {
    let now = 1_000_000;
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const calls: string[] = [];
    // A deputy that takes the list but never the code: always one part behind.
    const client: TricksCopyClient = {
      list: async () => (calls.push("list"), { kind: "answer", status: 200, body: { applied: true, need: { code: ["legs"], state: [] } } }),
      code: async () => (calls.push("code"), { kind: "failed" }),
      state: async () => (calls.push("state"), { kind: "failed" }),
    };
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client, now: () => now });
    const [lt] = await leadTricks(lead.stateDir, lead.configDir);
    const behind = { tricksDigest: tricksDigest(lt === undefined ? [] : [lt.trick]), tricksSeq: 1, tricksNeed: 1 };
    expect(await sync.run(LINK, behind)).toBe("failed");
    for (let i = 0; i < 5; i += 1) expect(await sync.run(LINK, behind)).toBe("idle");
    expect(calls).toEqual(["list", "code"]);
    now += CARRY_RETRY_MS;
    await sync.run(LINK, behind);
    expect(calls).toEqual(["list", "code", "list", "code"]);
    expect(sync.deputyFact()?.state).toBe("behind");
  });

  test("a deputy without the route is an older Collie, said once", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const client: TricksCopyClient = {
      list: async () => ({ kind: "answer", status: 404, body: null }),
      code: async () => ({ kind: "failed" }),
      state: async () => ({ kind: "failed" }),
    };
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client });
    expect(await sync.run(LINK, {})).toBe("no_route");
    expect(sync.deputyFact()).toMatchObject({ member: "laptop", state: "older" });
  });

  test("the list only rises: the lead sends one past what the deputy holds, even with a clock behind", async () => {
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    await store.applyList({ from: "desk", crewId: "crew-1", seq: 9_000_000_000_000, tricks: [] });
    const w = wired(store);
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client: w.client, now: () => 1 });
    expect(await sync.run(LINK, w.report())).toBe("done");
    expect(store.report()?.seq).toBe(9_000_000_000_001);
  });

  test("a lead that runs nothing says nothing to a deputy that holds nothing", async () => {
    const lead = await machine("lead");
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    const w = wired(store);
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client: w.client });
    expect(await sync.run(LINK, w.report())).toBe("idle");
    expect(w.calls).toEqual([]);
  });

  test("a trick switched OFF on the lead leaves the deputy's copy at the next list", async () => {
    let now = 1_000_000;
    const lead = await machine("lead");
    await putOnTrick(lead, { id: "legs" });
    const store = new StandbyTricksStore((await machine("deputy")).stateDir);
    const w = wired(store);
    const sync = new TricksCopySync({ read: () => leadTricks(lead.stateDir, lead.configDir), client: w.client, now: () => now });
    await sync.run(LINK, w.report());
    await writeFile(switchesPath(lead.stateDir), JSON.stringify({ version: 3, on: {} }));
    sync.invalidate();
    now += 1;
    expect(await sync.run(LINK, w.report())).toBe("done");
    expect(await store.ready()).toEqual([]);
  });
});
