import { describe, expect, test } from "bun:test";

import { STANDBY_VERSION_HEADER } from "../bridge/pack/standby.ts";
import { leadStore, member, peerStore } from "../bridge/pack/fixtures.ts";
import { serializeTrustStore } from "../bridge/pack/trust-store.ts";
import { UPDATE_RUN_SCHEMA, type UpdateRun } from "../bridge/update-run.ts";
import { fakeFiles } from "./fakes.ts";
import {
  awaitRunRecord,
  healthProbe,
  probeConfigOf,
  probeTarget,
  type ProbeConfig,
} from "./update-run.ts";
import type { Net, NetProbe } from "./sys.ts";

// The two rules of `cli/update-run.ts` that are pure and that a live machine got wrong: WHERE the
// health gate knocks, and how a caller waits on a run it is not driving. Nothing here opens a
// socket, reads a real file or spends a poll interval.

const STATE = "/state";

const config = (over: Partial<ProbeConfig> = {}): ProbeConfig => ({
  host: "",
  port: 8787,
  standbyPort: null,
  pinsALead: false,
  ...over,
});

describe("probe target", () => {
  test("a loopback solo install is asked at its own front door, as it always was", () => {
    expect(probeTarget(config())).toEqual({ kind: "front-door", url: "http://127.0.0.1:8787/api/health" });
  });

  test("a wide bind is asked on the address it actually bound, not on loopback", () => {
    // COLLIE_HOST=100.64.0.8 with COLLIE_ALLOW_NON_LOOPBACK_BIND=1 — a listener that is not on
    // loopback at all, so the loopback URL connects to nothing.
    expect(probeTarget(config({ host: "100.64.0.8" }))).toEqual({
      kind: "front-door",
      url: "http://100.64.0.8:8787/api/health",
    });
  });

  test("a peer with a standby door is asked THERE — its front door is mutual TLS", () => {
    expect(probeTarget(config({ pinsALead: true, standbyPort: 8799 }))).toEqual({
      kind: "standby",
      url: "http://127.0.0.1:8799/standby/health",
    });
  });

  test("a LEAD with a standby port keeps its front door — nothing about it refuses plain HTTP", () => {
    expect(probeTarget(config({ standbyPort: 8799 })).kind).toBe("front-door");
  });

  test("a peer with no standby door is still asked at its front door, so the gate reports the truth", () => {
    expect(probeTarget(config({ pinsALead: true })).kind).toBe("front-door");
  });

  test("the config is read off this instance's env and its trust store", () => {
    const files = fakeFiles({ [`${STATE}/pack-trust.json`]: serializeTrustStore(peerStore()) });
    const cfg = probeConfigOf(
      { COLLIE_HOST: "100.64.0.8", COLLIE_STANDBY_PORT: "8799" },
      files,
      STATE,
      8787,
    );
    expect(cfg).toEqual({ host: "100.64.0.8", port: 8787, standbyPort: 8799, pinsALead: true });
    expect(probeTarget(cfg).kind).toBe("standby");
  });

  test("a lead's store names no lead, so its own port is the target", () => {
    const files = fakeFiles({
      [`${STATE}/pack-trust.json`]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" })] })),
    });
    expect(probeConfigOf({ COLLIE_STANDBY_PORT: "8799" }, files, STATE, 8787).pinsALead).toBe(false);
  });

  test("no trust store at all is a solo install, not a parse failure", () => {
    expect(probeConfigOf({}, fakeFiles({}), STATE, 8787).pinsALead).toBe(false);
  });
});

// ── What the gate reads at the standby door ──────────────────────────────────

function netAnswering(answer: NetProbe): Net {
  return {
    getJson: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
    download: () => Promise.resolve({ ok: false, failure: { status: null, message: "no network in tests" } }),
    probe: () => Promise.resolve(answer),
  };
}

describe("probe target: the standby door's answer", () => {
  const target = probeTarget(config({ pinsALead: true, standbyPort: 8799 }));

  test("503 means COLD, and a cold door is a peer that is up", async () => {
    const net = netAnswering({ ok: true, status: 503, header: "1.4.0+ab12cd3", body: { state: "cold" } });
    expect(await healthProbe(net, target)()).toEqual({ ok: true, version: "1.4.0+ab12cd3", deposed: false });
  });

  test("the header is what carries the version", async () => {
    const net = netAnswering({ ok: true, status: 200, header: "1.4.0+ab12cd3", body: { state: "armed" } });
    expect(await healthProbe(net, target)()).toEqual({ ok: true, version: "1.4.0+ab12cd3", deposed: false });
    expect(STANDBY_VERSION_HEADER).toBe("x-collie-version");
  });

  test("a door that predates the header is read out of its body instead", async () => {
    const net = netAnswering({ ok: true, status: 503, header: null, body: { state: "cold", version: "1.3.0" } });
    expect(await healthProbe(net, target)()).toEqual({ ok: true, version: "1.3.0", deposed: false });
  });

  test("a DEPOSED collie answers 503 here too, and it is not up in the sense that matters", async () => {
    const net = netAnswering({ ok: true, status: 503, header: "1.4.0+ab12cd3", body: { state: "deposed" } });
    expect(await healthProbe(net, target)()).toEqual({ ok: true, version: "1.4.0+ab12cd3", deposed: true });
  });

  test("an answer naming no version at all is not evidence that anything came up", async () => {
    const net = netAnswering({ ok: true, status: 503, header: null, body: { state: "cold" } });
    expect(await healthProbe(net, target)()).toEqual({
      ok: false,
      reason: "the standby door answered 503 without naming a version",
    });
  });

  test("a door that is not listening is the failure it looks like", async () => {
    const net = netAnswering({ ok: false, failure: { status: null, message: "connection refused" } });
    expect(await healthProbe(net, target)()).toEqual({ ok: false, reason: "connection refused" });
  });
});

// ── Waiting on a run somebody else is driving ────────────────────────────────

const run = (state: UpdateRun["state"], over: Partial<UpdateRun> = {}): UpdateRun => ({
  schema: UPDATE_RUN_SCHEMA,
  state,
  from: "v1.3.0",
  to: "v1.4.0",
  startedAt: 0,
  updatedAt: 0,
  pid: 42,
  attempt: 0,
  ...over,
});

const wait = { now: () => 0, sleep: () => Promise.resolve(), timeoutMs: 10_000, pollMs: 1_000 };

describe("awaitRunRecord", () => {
  test("it polls until the record settles, and reports how it settled", async () => {
    const records = [run("staging"), run("restarting"), run("done")];
    let i = 0;
    expect(await awaitRunRecord(() => records[Math.min(i++, 2)] ?? null, wait)).toEqual({ kind: "done" });
    expect(i).toBe(3);
  });

  test("a rollback carries its own reason and its own recovery command", async () => {
    const record = run("rolled-back", { reason: "it came back as 1.3.0", recovery: "collie update --rollback" });
    expect(await awaitRunRecord(() => record, wait)).toEqual({
      kind: "failed",
      state: "rolled-back",
      reason: "it came back as 1.3.0",
      recovery: "collie update --rollback",
    });
  });

  test("a record that never settles times out rather than waiting on a frozen clock forever", async () => {
    const outcome = await awaitRunRecord(() => run("verifying"), wait);
    expect(outcome.kind).toBe("timeout");
    expect(outcome.kind === "timeout" && outcome.reason).toContain("still verifying");
  });

  test("no record at all is a timeout that says so", async () => {
    const outcome = await awaitRunRecord(() => null, wait);
    expect(outcome.kind === "timeout" && outcome.reason).toContain("no update record was ever written");
  });
});
