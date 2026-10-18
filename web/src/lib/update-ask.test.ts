import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { __resetUpdateAsk, beginAskedUpdate, type UpdateAsk } from "./update-ask";
import { __resetUpdateRunStore, getUpdateRunSnapshot } from "./update-run-store";
import { clearUpdateStarted, getUpdateClaim } from "./update-ribbon";
import type { UpdateRun } from "./types";
import { asJsonString, parseJsonObject } from "./json";

// THE CONFIRM'S 202, AND WHAT THIS DEVICE KEEPS OF IT (2026-09-26).
//
// The bridge reads the run record BEFORE it starts the updater, so the 202's `run` is the LAST run's
// record, and the id of the run just begun travels on its own, as `runId`. Keeping the old record's id
// as the claim, and handing the old record to the store as "the run just begun", is what put "Update
// finished" on screen at 0:00 with the old versions.

const LAST: UpdateRun = {
  schema: 2,
  state: "done",
  from: "1.13.1",
  to: "1.13.2",
  startedAt: Date.now() - 86_500_000,
  updatedAt: Date.now() - 86_400_000,
  pid: 4242,
  attempt: 0,
  runId: "old",
  settledAt: Date.now() - 86_400_000,
};

const ASK: UpdateAsk = { kind: "crew", version: "1.13.3", major: false, peersOnly: false, current: "1.13.2" };

function answer(body: { run: UpdateRun | null; runId?: string }): void {
  server.use(http.post("/api/update", () => HttpResponse.json({ ok: true, to: "1.13.3", major: false, ...body }, { status: 202 })));
}

beforeEach(() => {
  __resetUpdateAsk();
  __resetUpdateRunStore();
  clearUpdateStarted();
});

afterEach(() => {
  __resetUpdateAsk();
  __resetUpdateRunStore();
  clearUpdateStarted();
});

describe("beginAskedUpdate: the 202 of a lead that has updated before", () => {
  it("takes the new run's id as the claim, never the old record's", async () => {
    answer({ run: LAST, runId: "new" });
    await beginAskedUpdate(ASK);
    expect(getUpdateClaim()).toMatchObject({ runId: "new", target: "1.13.3", peersOnly: false });
  });

  it("does not hand the old record to the store as the run just begun", async () => {
    answer({ run: LAST, runId: "new" });
    await beginAskedUpdate(ASK);
    expect(getUpdateRunSnapshot().run).toBeUndefined();
  });

  it("a bridge that names no new run leaves the claim without an id and the store untouched", async () => {
    answer({ run: LAST });
    await beginAskedUpdate(ASK);
    expect(getUpdateClaim()?.runId).toBeNull();
    expect(getUpdateRunSnapshot().run).toBeUndefined();
  });

  it("a record that IS the new run's is still taken as the freshest thing for one beat", async () => {
    const begun: UpdateRun = {
      schema: 2,
      state: "preflight",
      from: "1.13.2",
      to: "1.13.3",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      pid: 4343,
      attempt: 0,
      runId: "new",
    };
    answer({ run: begun, runId: "new" });
    await beginAskedUpdate(ASK);
    expect(getUpdateRunSnapshot().run).toEqual(begun);
  });

  it("a peers-only start still keeps no id: its runs ride the status, not a record", async () => {
    answer({ run: LAST, runId: "new" });
    await beginAskedUpdate({ kind: "retry", version: "1.13.2", major: false, peersOnly: true, current: "1.13.2" });
    expect(getUpdateClaim()).toMatchObject({ runId: null, peersOnly: true });
    expect(getUpdateRunSnapshot().run).toBeUndefined();
  });
});

describe("beginAskedUpdate: a rollback (M60 spec 01)", () => {
  const ROLLBACK: UpdateAsk = { kind: "rollback", version: "1.13.1", major: false, peersOnly: false, current: "1.13.2" };
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  it("posts the confirm, the version the sheet named and a fresh UUID to the rollback route, never to /api/update", async () => {
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/update", () => HttpResponse.json({ error: "wrong route" }, { status: 500 })),
      http.post("/api/update/rollback", async ({ request }) => {
        const body = parseJsonObject(await request.text());
        bodies.push(body);
        const id = asJsonString(body?.requestId) ?? "";
        return HttpResponse.json({ ok: true, from: "1.13.2", to: "1.13.1", run: LAST, runId: id }, { status: 202 });
      }),
    );
    await beginAskedUpdate(ROLLBACK);
    await beginAskedUpdate(ROLLBACK);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ confirm: true, target: "1.13.1" });
    const ids = bodies.map((b) => asJsonString(parseJsonObject(JSON.stringify(b))?.requestId) ?? "");
    for (const id of ids) expect(id).toMatch(UUID);
    // One id per confirm.
    expect(ids[0]).not.toBe(ids[1]);
    // The claim keys on the request id, which the run record carries as its run id, and says rollback.
    expect(getUpdateClaim()).toMatchObject({ runId: ids[1], target: "1.13.1", peersOnly: false, members: [], rollback: true });
    expect(getUpdateRunSnapshot().run).toBeUndefined();
  });

  it("a refusal spends the claim and throws the bridge's own code", async () => {
    server.use(
      http.post("/api/update/rollback", () =>
        HttpResponse.json(
          { ok: false, error: "there is no previous build on this machine to roll back to", code: "update.rollback_unavailable" },
          { status: 409 },
        ),
      ),
    );
    await expect(beginAskedUpdate(ROLLBACK)).rejects.toThrow();
    expect(getUpdateClaim()).toBeNull();
  });
});
