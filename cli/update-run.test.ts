import { afterAll, describe, expect, test } from "bun:test";
import { X509Certificate } from "node:crypto";

import { STANDBY_VERSION_HEADER } from "../bridge/crew/standby.ts";
import { leadStore, material, member, peerStore } from "../bridge/crew/fixtures.ts";
import { fingerprintOfCert } from "../bridge/crew/identity.ts";
import { markerFor, NO_RUNTIME_FACTS, type CrewRuntimeMarker } from "../bridge/crew/staleness.ts";
import { serializeTrustStore } from "../bridge/crew/trust-store.ts";
import { UPDATE_RUN_SCHEMA, type UpdateRun } from "../bridge/update-run.ts";
import { fakeFiles } from "./fakes.ts";
import {
  aliveVerdict,
  awaitRunRecord,
  type BootEvidence,
  driveApply,
  healthProbe,
  healthVerdict,
  probeConfigOf,
  probeTarget,
  updateHealthProbe,
  updateHealthTarget,
  type ApplyEffects,
  type ApplyPlan,
  type ProbeConfig,
} from "./update-run.ts";
import { realNet, type Net, type NetCertificate, type NetProbe } from "./sys.ts";

// The two rules of `cli/update-run.ts` that are pure and that a live machine got wrong: WHERE the
// health gate knocks, and how a caller waits on a run it is not driving. Nothing here opens a
// socket, reads a real file or spends a poll interval.

const STATE = "/state";

const config = (over: Partial<ProbeConfig> = {}): ProbeConfig => ({
  host: "",
  port: 8787,
  standbyPort: null,
  pinsALead: false,
  selfCertPem: null,
  ...over,
});

// A peer's own certificate: real minted material, so the fingerprint comes from a parse.
const OWN_PEM = material("laptop").certPem;
const OWN_FINGERPRINT = fingerprintOfCert(OWN_PEM) ?? "";
const peerConfig = (over: Partial<ProbeConfig> = {}): ProbeConfig =>
  config({ pinsALead: true, selfCertPem: OWN_PEM, ...over });

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

  test("a wildcard bind is asked on loopback, because a wildcard is not an address one can dial", () => {
    for (const host of ["0.0.0.0", "::", " 0.0.0.0 "]) {
      expect(probeTarget(config({ host })).url).toBe("http://127.0.0.1:8787/api/health");
    }
  });

  test("an IPv6 bind is put in brackets, so the URL parses and reaches it", () => {
    expect(probeTarget(config({ host: "fd7a:115c:a1e0::1" })).url).toBe("http://[fd7a:115c:a1e0::1]:8787/api/health");
    expect(probeTarget(config({ host: "[::1]" })).url).toBe("http://[::1]:8787/api/health");
    expect(() => new URL(probeTarget(config({ host: "::1" })).url)).not.toThrow();
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
    const files = fakeFiles({ [`${STATE}/crew-trust.json`]: serializeTrustStore(peerStore()) });
    const cfg = probeConfigOf(
      { COLLIE_HOST: "100.64.0.8", COLLIE_STANDBY_PORT: "8799" },
      files,
      STATE,
      8787,
    );
    expect(cfg).toEqual({
      host: "100.64.0.8",
      port: 8787,
      standbyPort: 8799,
      pinsALead: true,
      selfCertPem: peerStore().self.certPem,
    });
    expect(probeTarget(cfg).kind).toBe("standby");
  });

  test("a lead's store names no lead, so its own port is the target", () => {
    const files = fakeFiles({
      [`${STATE}/crew-trust.json`]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" })] })),
    });
    expect(probeConfigOf({ COLLIE_STANDBY_PORT: "8799" }, files, STATE, 8787).pinsALead).toBe(false);
  });

  test("no trust store at all is a solo install, not a parse failure", () => {
    const cfg = probeConfigOf({}, fakeFiles({}), STATE, 8787);
    expect(cfg.pinsALead).toBe(false);
    expect(cfg.selfCertPem).toBeNull();
  });
});

// ── Where the UPDATE gate knocks ─────────────────────────────────────────────
// `probeTarget` stays as it was (the Windows launcher reads it). The update gate adds the third
// door: a TLS-only peer is asked for its own certificate.

describe("update health target", () => {
  test("a peer with no standby door is asked for its certificate, on the address it bound", () => {
    expect(updateHealthTarget(peerConfig())).toEqual({
      kind: "peer-listener",
      host: "127.0.0.1",
      port: 8787,
      fingerprint: OWN_FINGERPRINT,
    });
    expect(updateHealthTarget(peerConfig({ host: "100.64.0.8" }))).toMatchObject({ host: "100.64.0.8" });
    expect(updateHealthTarget(peerConfig({ host: "0.0.0.0" }))).toMatchObject({ host: "127.0.0.1" });
  });

  test("an IPv6 bind is dialled without the URL brackets", () => {
    expect(updateHealthTarget(peerConfig({ host: "[fd7a::1]" }))).toMatchObject({ host: "fd7a::1" });
    expect(updateHealthTarget(peerConfig({ host: "fd7a::1" }))).toMatchObject({ host: "fd7a::1" });
  });

  test("a peer WITH a standby door is still asked there", () => {
    expect(updateHealthTarget(peerConfig({ standbyPort: 8799 }))).toEqual(
      probeTarget(peerConfig({ standbyPort: 8799 })),
    );
    expect(updateHealthTarget(peerConfig({ standbyPort: 8799 })).kind).toBe("standby");
  });

  test("a lead and a solo install keep their front door, wide binds included", () => {
    expect(updateHealthTarget(config())).toEqual(probeTarget(config()));
    expect(updateHealthTarget(config({ host: "100.64.0.8" }))).toEqual(probeTarget(config({ host: "100.64.0.8" })));
    expect(updateHealthTarget(config({ standbyPort: 8799 })).kind).toBe("front-door");
  });

  test("a peer whose own certificate is missing or will not parse falls back to the front door", () => {
    expect(updateHealthTarget(config({ pinsALead: true })).kind).toBe("front-door");
    expect(updateHealthTarget(peerConfig({ selfCertPem: "not a certificate" })).kind).toBe("front-door");
  });
});

// ── What the gate reads from a peer's certificate ────────────────────────────

function netShowingCertificate(answer: NetCertificate, asked: string[] = []): Net {
  return {
    ...netAnswering({ ok: false, failure: { status: null, message: "no plain HTTP in this case" } }),
    tlsCertificate: (host, port) => {
      asked.push(`${host}:${port}`);
      return Promise.resolve(answer);
    },
  };
}

// A runtime marker as the bridge leaves it at boot. `markerFor` is the bridge's own constructor.
const markerAt = (bootedAt: number, pid = 4242, build: string | null = null): CrewRuntimeMarker =>
  markerFor(peerStore(), bootedAt, pid, NO_RUNTIME_FACTS, build);

/** Boot evidence with every part scripted. By default: a live bridge that booted at t=1000, restart at t=900. */
const evidence = (over: Partial<BootEvidence> = {}): BootEvidence => ({
  marker: () => markerAt(1_000),
  since: () => 900,
  alive: () => true,
  ...over,
});

describe("update health target: the peer listener's answer", () => {
  const target = updateHealthTarget(peerConfig({ host: "100.64.0.8" }));
  // `X509Certificate.fingerprint256` is what node hands back: uppercase, colon separated.
  const nodeSpelling = new X509Certificate(OWN_PEM).fingerprint256;
  const ownCert = netShowingCertificate({ ok: true, fingerprint256: nodeSpelling });
  const answer = (net: Net, boot: BootEvidence = evidence()) => updateHealthProbe(net, target, boot)();

  test("this machine's own certificate, a marker from after the restart and a live pid answer ok, with no version", async () => {
    const asked: string[] = [];
    const got = await answer(netShowingCertificate({ ok: true, fingerprint256: nodeSpelling }, asked));
    expect(got).toEqual({ ok: true, version: null, deposed: false });
    expect(asked).toEqual(["100.64.0.8:8787"]);
  });

  test("a bridge that records its build answers with it, so the build check applies again", async () => {
    const got = await answer(ownCert, evidence({ marker: () => markerAt(1_000, 4242, "1.4.0+ab12cd3") }));
    expect(got).toEqual({ ok: true, version: "1.4.0+ab12cd3", deposed: false });
    expect(healthVerdict(got, "1.4.0", "ab12cd3")).toEqual({ ok: true });
    expect(healthVerdict(got, "1.5.0", "ef45ab6")).toEqual({
      ok: false,
      reason: "the service came back as 1.4.0+ab12cd3, not 1.5.0",
    });
  });

  test("a marker written exactly at the restart moment counts as after it", async () => {
    expect((await answer(ownCert, evidence({ since: () => 1_000 }))).ok).toBe(true);
  });

  test("another certificate on the port is not this machine's bridge", async () => {
    const other = new X509Certificate(material("desk").certPem).fingerprint256;
    expect(await answer(netShowingCertificate({ ok: true, fingerprint256: other }))).toEqual({
      ok: false,
      reason: "100.64.0.8:8787 answers with a certificate that is not this machine's",
    });
  });

  test("a refused port fails with the connection's own message", async () => {
    const net = netShowingCertificate({ ok: false, failure: { status: null, message: "connect ECONNREFUSED" } });
    expect(await answer(net)).toEqual({ ok: false, reason: "connect ECONNREFUSED" });
  });

  test("the right certificate with a marker older than the restart is the old process still draining", async () => {
    const got = await answer(ownCert, evidence({ marker: () => markerAt(800) }));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toContain("has not booted since the restart");
  });

  test("no marker at all fails, and says so", async () => {
    const got = await answer(ownCert, evidence({ marker: () => null }));
    expect(got).toEqual({ ok: false, reason: "the bridge has not booted since the restart: it left no runtime marker" });
  });

  test("a marker whose pid is gone fails, and names the pid", async () => {
    const got = await answer(ownCert, evidence({ alive: () => false }));
    expect(got.ok).toBe(false);
    expect(!got.ok && got.reason).toContain("is gone (pid 4242)");
  });

  test("a process table that cannot be read proves nothing against a fresh marker and the right certificate", async () => {
    expect((await answer(ownCert, evidence({ alive: () => null }))).ok).toBe(true);
  });

  test("the verdicts: a versionless answer passes the build check, a failure still fails", () => {
    const noVersion = { ok: true, version: null, deposed: false } as const;
    expect(healthVerdict(noVersion, "1.4.0", "ab12cd3")).toEqual({ ok: true });
    expect(aliveVerdict(noVersion)).toEqual({ ok: true });
    expect(healthVerdict({ ok: true, version: "1.3.0", deposed: false }, "1.4.0", "ab12cd3").ok).toBe(false);
    expect(healthVerdict({ ok: false, reason: "nope" }, "1.4.0", "ab12cd3")).toEqual({ ok: false, reason: "nope" });
  });

  test("the other doors keep their own probe", async () => {
    const standby = probeTarget(config({ pinsALead: true, standbyPort: 8799 }));
    const net = netAnswering({ ok: true, status: 200, header: "1.4.0", body: { state: "armed" } });
    expect(await updateHealthProbe(net, standby, evidence())()).toEqual({ ok: true, version: "1.4.0", deposed: false });
  });
});

// ── What the gate reads at the standby door ──────────────────────────────────

function netAnswering(answer: NetProbe): Net {
  return {
    tlsCertificate: () => Promise.resolve({ ok: false, failure: { status: null, message: "no TLS in this case" } }),
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

// ── driveApply against a peer's certificate check ────────────────────────────

const applyPlan = (): ApplyPlan => ({
  to: "v1.4.0",
  from: "v1.3.0",
  version: "1.4.0",
  commit: "ab12cd3",
  recovery: "collie update --rollback",
});

/**
 * Effects for a peer whose bridge is a script. `restart` stamps the moment and counts; the bridge
 * "boots" (its marker takes that moment) only when `boots(restartNumber)` says so.
 */
function peerRun(opts: {
  certAfter: (restarts: number) => boolean;
  boots: (restart: number) => boolean;
  /** The build the bridge booted by that restart records. Null, the default, is a bridge older than the field. */
  build?: (restart: number) => string | null;
}) {
  let t = 0;
  let restarts = 0;
  let since = Number.POSITIVE_INFINITY;
  let bootedAt: number | null = null;
  let build: string | null = null;
  const own = new X509Certificate(OWN_PEM).fingerprint256;
  const net: Net = {
    ...netAnswering({ ok: false, failure: { status: null, message: "no plain HTTP in this case" } }),
    tlsCertificate: () =>
      Promise.resolve(
        opts.certAfter(restarts)
          ? { ok: true, fingerprint256: own }
          : { ok: false, failure: { status: null, message: "connect ECONNREFUSED" } },
      ),
  };
  const boot = evidence({
    marker: () => (bootedAt === null ? null : markerAt(bootedAt, 4242, build)),
    since: () => since,
  });
  // `awaitHealth` polls until `now()` passes the deadline, so the clock advances on every read.
  const effects: ApplyEffects = {
    flip: () => true,
    restart: () => {
      restarts += 1;
      since = t++;
      if (opts.boots(restarts)) {
        bootedAt = t++;
        build = opts.build?.(restarts) ?? null;
      }
      return Promise.resolve(true);
    },
    health: updateHealthProbe(net, updateHealthTarget(peerConfig()), boot),
    prune: () => {},
    logTail: () => "",
    now: () => t++,
    sleep: () => Promise.resolve(),
    write: () => {},
    timeoutMs: 30_000,
    pollMs: 1_000,
  };
  return { effects, restartCount: () => restarts };
}

describe("driveApply: a peer with no plain-HTTP door", () => {
  test("its own certificate on the port, from a bridge that booted after the restart, passes the update", async () => {
    const { effects } = peerRun({ certAfter: () => true, boots: () => true });
    expect((await driveApply(effects, applyPlan(), run("staging"))).state).toBe("done");
  });

  test("the old process still answering with the right certificate does not pass, and the run ends stuck", async () => {
    // The restart command returned, the old bridge is still draining, nothing new has booted.
    const { effects } = peerRun({ certAfter: () => true, boots: () => false });
    const out = await driveApply(effects, applyPlan(), run("staging"));
    expect(out.state).toBe("stuck");
    expect(out.reason).toContain("has not booted since the restart");
  });

  test("a refused port still rolls back, and a rollback that cannot be verified ends stuck", async () => {
    const { effects } = peerRun({ certAfter: () => false, boots: () => true });
    const out = await driveApply(effects, applyPlan(), run("staging"));
    expect(out.state).toBe("stuck");
    expect(out.reason).toContain("ECONNREFUSED");
  });

  test("a bridge that crashes on the new build rolls back once the old one has booted again", async () => {
    // The new build never binds the port; after the rollback restart the old one boots and does.
    const { effects, restartCount } = peerRun({ certAfter: (n) => n >= 2, boots: (n) => n >= 2 });
    const out = await driveApply(effects, applyPlan(), run("staging"));
    expect(out.state).toBe("rolled-back");
    expect(restartCount()).toBe(2);
  });

  test("a restart that brings the OLD build back up is not the update, and rolls back", async () => {
    // A supervisor still pointed at the version the flip left boots it again. Fresh marker, live pid,
    // this machine's certificate: everything but the build says the update landed.
    const { effects, restartCount } = peerRun({ certAfter: () => true, boots: () => true, build: () => "1.3.0+9f8e7d6" });
    const out = await driveApply(effects, applyPlan(), run("staging"));
    expect(out.state).toBe("rolled-back");
    expect(out.reason).toContain("came back as 1.3.0+9f8e7d6, not 1.4.0");
    expect(restartCount()).toBe(2);
  });

  test("the new build, recorded, passes the update", async () => {
    const { effects } = peerRun({ certAfter: () => true, boots: () => true, build: () => "1.4.0+ab12cd3" });
    expect((await driveApply(effects, applyPlan(), run("staging"))).state).toBe("done");
  });

  test("the rollback needs a marker newer than the SECOND restart, not the first", async () => {
    // The first restart booted a bridge (it then failed some other way); the second booted none.
    // The first marker is newer than the first restart and older than the second.
    const { effects, restartCount } = peerRun({ certAfter: (n) => n >= 2, boots: (n) => n === 1 });
    const out = await driveApply(effects, applyPlan(), run("staging"));
    expect(out.state).toBe("stuck");
    expect(out.reason).toContain("has not booted since the restart");
    expect(restartCount()).toBe(2);
  });
});

// ── The real socket ──────────────────────────────────────────────────────────

describe("realNet().tlsCertificate", () => {
  // A listener shaped like a peer's: it demands a client certificate from a CA that is not ours, so
  // this process, which sends none, would be refused at the application layer. The handshake still
  // shows the server certificate first, and that is all the gate reads.
  const server = material("laptop");
  const otherCa = material("desk");
  const listener = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: server.certPem, key: server.keyPem, ca: [otherCa.certPem], requestCert: true, rejectUnauthorized: true },
    fetch: () => new Response("never reached"),
  });
  afterAll(() => {
    void listener.stop(true);
  });

  test("reads the server certificate of an mTLS-only listener without a client certificate", async () => {
    const got = await realNet().tlsCertificate("127.0.0.1", listener.port ?? 0);
    expect(got).toEqual({ ok: true, fingerprint256: new X509Certificate(server.certPem).fingerprint256 });
  });

  test("a plain-HTTP listener is not a TLS server, and fails", async () => {
    const plain = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("hello") });
    try {
      const got = await realNet().tlsCertificate("127.0.0.1", plain.port ?? 0);
      expect(got.ok).toBe(false);
    } finally {
      await plain.stop(true);
    }
  });

  test("a port nothing listens on fails instead of hanging", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("x") });
    const closed = probe.port ?? 0;
    await probe.stop(true);
    const got = await realNet().tlsCertificate("127.0.0.1", closed);
    expect(got.ok).toBe(false);
  });
});
