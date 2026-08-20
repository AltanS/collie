import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT } from "../../cli/io.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdPackApprovePromote,
  cmdPackInvite,
  cmdPackRotate,
  cmdPackStatus,
  cmdPromote,
  cmdReconnect,
  type PackDeps,
} from "../../cli/pack.ts";
import type { CliContext } from "../../cli/context.ts";
import type { Exec, ExecResult } from "../../cli/sys.ts";
import { realFiles } from "../../cli/sys.ts";
import { PackOpsStore } from "./ops-store.ts";
import { PACK_PROTOCOL_VERSION } from "./enrollment.ts";
import { startFakeHerdr, type FakeHerdr } from "./fake-herdr.ts";
import { mintIdentity, randomToken } from "./identity.ts";
import { PACK_HELLO_PATH, PACK_LEAVE_PATH } from "./router.ts";
import { bodyDigest, canonicalRequest, signRequest, SIGNATURE_HEADER, TIMESTAMP_HEADER } from "./signing.ts";
import { PeerClient, type PackLink } from "./peer-client.ts";
import { dialTls, peerListenerTls, type PackRequestInit, type PackTlsOptions } from "./transport.ts";
import { parseTrustStore, TrustStore, TRUST_STORE_FILENAME, type TrustStoreData } from "./trust-store.ts";
import { collieVersionBare } from "../version.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO-INSTANCE INTEGRATION HARNESS (spec M4/08).
//
// Two REAL Collie bridges, as child processes, on loopback, enrolled through the REAL enrollment
// path, talking over REAL pinned mutual TLS with certificates this build minted. Nothing about the
// pack is faked: not the handshake, not the trust store, not the HTTP, not the admission gate.
//
// ── WHY IT IS A `bun test` FILE AND NOT A SHELL SCRIPT ───────────────────────
// CLAUDE.md's rule is that `Bun.serve`-dependent code stays out of `bun test`, because Vitest-on-Node
// cannot run it. The backend suite is Bun's OWN runner, which can — the constraint was never about
// this side. Keeping the harness here buys the thing a shell script could not: the operator verbs are
// invoked as the FUNCTIONS `cli/pack.ts` exports, with `PackDeps` supplied by the harness. So
// `restart()` is a real respawn of a real child process (which is what a membership change must
// trigger, and what re-pins the listener), `serve()`/`unserve()` are no-ops that touch no tailnet,
// and nothing in this file can reach the machine it runs on.
//
// ── WHAT IS FAKED, AND WHY IT IS HONEST ──────────────────────────────────────
// Exactly one thing: Herdr. `fake-herdr.ts` answers the handful of methods a snapshot and a pane read
// need, over a real unix socket, one-shot as the real server is. The subject here is the pack
// transport; standing up a second project's daemon to reach it would make this test depend on a
// machine that has one, which is the definition of the flaky test the spec says will be deleted.
//
// ── SAFETY ───────────────────────────────────────────────────────────────────
// Every instance is ephemeral: a fresh `stateDir` and config root under `mkdtemp`, a port the OS
// chose, a scratch `HOME`. Nothing reads or writes the developer's own Collie, and no verb that
// touches the world (`tailscale`, `systemctl`) is reachable — `exec` is a fake that finds nothing.
// ─────────────────────────────────────────────────────────────────────────────

const BOOT_TIMEOUT_MS = 15_000;
const PANE_TEXT_LEAD = "lead pane\n$ echo desk\n";
const PANE_TEXT_PEER = "peer pane\n$ echo laptop\n";

let root: string;

/** One end of the pack: a scratch state dir, a fake Herdr, and a child bridge we can respawn. */
class Instance {
  readonly stateDir: string;
  readonly configRoot: string;
  readonly socketPath: string;
  readonly home: string;
  herdr: FakeHerdr | null = null;
  proc: Bun.Subprocess<"ignore", "pipe", "pipe"> | null = null;
  port = 0;
  /** Everything the child printed, for a failure that needs the child's own account of it. */
  log = "";

  constructor(
    readonly name: string,
    readonly paneId: string,
    readonly paneText: string,
  ) {
    this.home = join(root, name);
    this.stateDir = join(this.home, "state");
    this.configRoot = join(this.home, "herdr");
    this.socketPath = join(this.configRoot, "herdr.sock");
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.configRoot, { recursive: true });
  }

  startHerdr(): void {
    this.herdr = startFakeHerdr({
      socketPath: this.socketPath,
      workspaceLabel: this.name,
      panes: [{ paneId: this.paneId, tabId: "t1", workspaceId: "w1", label: this.name, text: this.paneText }],
    });
  }

  /** The trust store as it is on disk right now — the harness's window into what a verb persisted. */
  store(): TrustStoreData | null {
    try {
      return parseTrustStore(readFileSync(join(this.stateDir, TRUST_STORE_FILENAME), "utf8"));
    } catch {
      return null;
    }
  }

  /** Whether this instance's own listener pins — the same predicate `bridge/index.ts` computes. */
  pins(): boolean {
    const data = this.store();
    const mode = data === null || data.lead === null ? "lead" : "peer";
    return peerListenerTls(mode, data) !== null;
  }

  /**
   * The scheme this instance answers on. It follows from `pins()` and nothing else: a pinned listener
   * is a TLS listener, and an unpinned one is the plain HTTP the front door would terminate for.
   */
  origin(): string {
    return `${this.pins() ? "https" : "http"}://127.0.0.1:${this.port}`;
  }

  async start(): Promise<void> {
    if (this.port === 0) this.port = await freePort();
    this.proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "index.ts")], {
      cwd: join(import.meta.dir, "..", ".."),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: this.home,
        COLLIE_HOST: "127.0.0.1",
        COLLIE_PORT: String(this.port),
        COLLIE_STATE_DIR: this.stateDir,
        HERDR_SOCKET_PATH: this.socketPath,
        COLLIE_POLL_MS: "300",
        // The herd is idle by construction here (a fake pane never changes), and the lead's peer
        // sweep RIDES the herd poll — including its idle relaxation (§10.1). Left at the 12 s
        // default, every freshness assertion below would be waiting on that relaxation rather than
        // on the pack. Lowering it changes the cadence, never the mechanism: there is still no
        // second timer, which is exactly what the cadence assertion measures.
        COLLIE_POLL_IDLE_MS: "1000",
        COLLIE_MULTI_SESSION: "0",
        // The pack surface is what is under test; the browser gate is not, and a peer serves no
        // browser surface at all (§3). Left at its defaults so nothing here relaxes a shipped rule.
      },
      // Both streams captured, and drained into `this.log`. A child's own diagnostics are the only
      // window into a boot that half-worked, and `bun test` discards a piped stream nobody reads.
      stdout: "pipe",
      stderr: "pipe",
    });
    void drain(this.proc.stdout, (chunk) => (this.log += chunk));
    void drain(this.proc.stderr, (chunk) => (this.log += chunk));
    // `bun test` kills subprocesses a test left behind when that test ends. These deliberately
    // outlive the test that spawned them — a membership verb restarts the bridge mid-test and every
    // later assertion is against the process that came back — so they are unref'd, and `afterAll`
    // owns their death instead.
    this.proc.unref();
    await waitFor(() => this.ready(), BOOT_TIMEOUT_MS, `${this.name} did not boot`);
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = null;
    if (proc === null) return;
    proc.kill("SIGTERM");
    await proc.exited;
  }

  /** A membership verb's restart, for real: the child dies, and the new one re-reads the store. */
  async restart(): Promise<number> {
    await this.stop();
    await this.start();
    return EXIT.OK;
  }

  /**
   * Ready = the port accepts a connection.
   *
   * Deliberately NOT an HTTP request: once this instance is a peer its listener demands the lead's
   * client certificate at the handshake, so every credential-free request is refused before a status
   * line exists. A TCP accept is the one readiness signal that means the same thing in both modes.
   */
  async ready(): Promise<boolean> {
    return portOpen(this.port);
  }
}

let lead: Instance;
let peer: Instance;
/** Herdr calls per second this instance made while solo — the baseline §11's timer row compares to. */
let soloCadence = 0;

// ── The `PackDeps` a verb runs against ───────────────────────────────────────

/** An `Exec` that finds nothing. `tailscale` is therefore absent, so no verb can reach a tailnet. */
const noExec: Exec = {
  which: () => null,
  capture: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  inherit: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  runIn: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  spawnDetached: () => null,
  processCommand: () => null,
  kill: () => {},
};

/**
 * A {@link PackRequestInit} whose `tls` half may be partial: one test below dials with no client
 * certificate at all, which is the refusal it is checking for.
 */
type TestPackRequestInit = Omit<PackRequestInit, "tls"> & { tls?: Partial<PackTlsOptions> };

/**
 * Bun's `fetch` understands a per-request `tls` option that the DOM `RequestInit` type has no room
 * for — `PackRequestInit` (transport.ts) is the bridge's name for that superset. This is the one
 * place in this file where the wider init meets the platform signature.
 */
function packFetch(url: string, init: TestPackRequestInit): Promise<Response> {
  // SAFETY: `tls` is a real field Bun reads off the init at runtime; only the DOM lib's type is
  // narrower. Nothing about the init is changed on the way through.
  return fetch(url, init as RequestInit);
}

/** The slice of the lead's merged `/api/snapshot` these tests read back. */
interface MergedSnapshot {
  servers?: Array<{ id: string; reachable: boolean }>;
  sessions?: Array<{ host?: string }>;
}

/** GET a collie's `/api/snapshot` and read it as {@link MergedSnapshot}. */
async function snapshotOf(origin: string): Promise<MergedSnapshot> {
  const res = await fetch(`${origin}/api/snapshot`);
  // SAFETY: the handler emits its body `satisfies SnapshotResponse` (server.ts), and MergedSnapshot
  // is a structural subset of that type with every field optional — it claims nothing the handler
  // does not already promise.
  return (await res.json()) as MergedSnapshot;
}

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

function depsFor(instance: Instance, captured: Captured): PackDeps {
  const ctx: CliContext = {
    root: join(import.meta.dir, "..", ".."),
    instance: null,
    configDir: join(instance.home, "config"),
    home: instance.home,
    env: { COLLIE_POLL_MS: "300" },
    port: instance.port,
    serveMode: "http",
    socket: instance.socketPath,
    handlerFile: join(instance.home, "config", "tailscale-managed-handler"),
    stateDir: instance.stateDir,
  };
  return {
    ctx,
    io: { out: (l) => captured.out.push(l), err: (l) => captured.err.push(l) },
    exec: noExec,
    files: realFiles,
    store: freshStore(instance),
    ops: new PackOpsStore(instance.stateDir),
    audit: null,
    // The REAL platform fetch, so a pinned handshake is a pinned handshake.
    fetch: packFetch,
    now: () => Date.now(),
    random: randomToken,
    mintIdentity: () =>
      Promise.resolve(mintIdentity({ commonName: `collie-${instance.name}`, sans: ["127.0.0.1", "localhost"] })),
    readStdin: () => Promise.resolve(""),
    restart: () => instance.restart(),
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
  };
}

/**
 * A fresh `TrustStore` per verb.
 *
 * `TrustStore` caches its file for the life of the process, and the real CLI is a new process per
 * verb. Sharing one across the harness's verbs would let a verb act on a roster the previous verb
 * superseded — a staleness the shipped code cannot have and this harness must not invent.
 */
function freshStore(instance: Instance): TrustStore {
  return new TrustStore(instance.stateDir);
}

/** Run a verb and return its exit code plus everything it printed. */
async function verb(
  instance: Instance,
  run: (deps: PackDeps) => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const captured: Captured = { out: [], err: [] };
  const code = await run(depsFor(instance, captured));
  return { code, out: captured.out.join("\n"), err: captured.err.join("\n") };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "collie-pack-e2e-"));
  lead = new Instance("desk", "w1:p1", PANE_TEXT_LEAD);
  peer = new Instance("laptop", "w1:p9", PANE_TEXT_PEER);
  lead.startHerdr();
  peer.startHerdr();
  await lead.start();
  await peer.start();
}, 60_000);

afterAll(async () => {
  if (process.env.COLLIE_HARNESS_DEBUG === "1") {
    for (const i of [lead, peer]) console.log(`\n──── ${i?.name} ────\n${i?.log}`);
  }
  await lead?.stop();
  await peer?.stop();
  lead?.herdr?.stop();
  peer?.herdr?.stop();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

// ── §11's four integration rows, measured on a live solo instance ────────────

describe("solo zero-tax, measured rather than inferred", () => {
  test("a solo instance opens exactly one port and mints nothing", async () => {
    // Both instances are still solo here — nothing has been invited or joined yet.
    expect(lead.store()).toBeNull();
    expect(readdirSync(lead.stateDir)).not.toContain(TRUST_STORE_FILENAME);
    // The bound port count, which the unit baseline can only infer from config defaults (§11).
    expect(await portOpen(lead.port)).toBe(true);
    expect(await portOpen(lead.port + 1)).toBe(false);
  });

  test("a solo instance's status codes are today's, per route", async () => {
    const base = lead.origin();
    // `/pack/v1/*` is NOT ROUTED on an instance that never enrolled, and the observable form of that
    // is INDISTINGUISHABILITY, not a particular code: whatever an arbitrary unknown path gets — an
    // SPA fallback on a build with `web/dist`, a 404 without one — the pack prefix gets the same.
    // Asserting a literal 404 here would have been asserting the presence of a frontend build.
    const unknown = await fetch(`${base}/definitely/not/a/route`);
    const packed = await fetch(`${base}${PACK_HELLO_PATH}`);
    expect(packed.status).toBe(unknown.status);
    expect(packed.headers.get("x-pack-protocol")).toBeNull();
    expect((await fetch(`${base}/api/snapshot`)).status).toBe(200);
    expect((await fetch(`${base}/api/config`)).status).toBe(200);
    expect((await fetch(`${base}/api/pane/${encodeURIComponent(lead.paneId)}`)).status).toBe(200);
  });

  test("the peer sweep rides the herd poll — there is no second timer", async () => {
    // §11's row, measured rather than inferred. The lead's own Herdr is polled by the state engine;
    // the peer's Herdr is polled by the PEER's state engine, and the peer's `/pack/v1/snapshot` is
    // served from that. What the row is really about is that adding a peer arms NO new clock on the
    // lead, so the lead's call rate to its own Herdr must be the same before and after a pack forms.
    // Recorded here while both instances are still solo; asserted after enrollment.
    soloCadence = await cadence(lead);
    expect(soloCadence).toBeGreaterThan(0);
  }, 60_000);

  test("a solo snapshot carries no pack fields", async () => {
    const body = await (await fetch(`${lead.origin()}/api/snapshot`)).text();
    expect(body).not.toMatch(/"servers"|"host":|"pack"/);
  });
});

// ── Enrollment over the real transport ───────────────────────────────────────

describe("invite → join, end to end", () => {
  let token = "";

  test("the lead mints an invite and can answer it", async () => {
    const minted = await verb(lead, (d) => cmdPackInvite(d, ["--label", "laptop"]));
    expect(minted.code).toBe(EXIT.OK);
    token = minted.out.split("\n")[0]!.trim();
    expect(token.length).toBeGreaterThan(20);
    // Minting an invite is the moment a pack comes into existence — and the moment the first key
    // material is written. Before it there was nothing (asserted above).
    const data = lead.store();
    expect(data?.pack).not.toBeNull();
    expect(data?.self.certPem).toContain("BEGIN CERTIFICATE");
  }, 60_000);

  test("the peer joins, and both sides pin the other's certificate", async () => {
    const joined = await verb(peer, (d) =>
      // `--insecure` because this harness enrolls over loopback `http://`: `join` now refuses a
      // plaintext hop unless the operator explicitly owns that assumption. A loopback join is exactly
      // the "genuinely trusted hop" the flag exists for.
      cmdJoin(d, [`http://127.0.0.1:${lead.port}`, token, "--insecure", "--address", `127.0.0.1:${peer.port}`]),
    );
    expect(joined.err).not.toContain("certificate minting is not wired");
    expect(joined.code).toBe(EXIT.OK);

    const peerData = peer.store();
    const leadData = lead.store();
    expect(peerData?.lead?.memberId).toBe(leadData!.self.memberId);
    expect(peerData?.lead?.fingerprint).toBe(leadData!.self.fingerprint);
    expect(leadData?.peers[0]?.fingerprint).toBe(peerData!.self.fingerprint);
    // Both hold the CERTIFICATE, not only its hash — the material the handshake needs (§8.1).
    expect(peerData?.lead?.certPem).toContain("BEGIN CERTIFICATE");
    expect(leadData?.peers[0]?.certPem).toContain("BEGIN CERTIFICATE");

    // ── A FINDING THIS HARNESS PRODUCED, AND WHAT SHIPPED FOR IT ─────────────
    // `join` restarts the PEER (it is the machine changing mode), and `pack invite` restarted the
    // LEAD so it could answer the invite — but nothing restarts the lead AFTER the enrollment lands.
    // The lead's `PackLead` is built at startup from the roster as it was then, which for a first
    // enrollment is empty, so the running lead writes the new peer to disk and goes on merging
    // nothing until something else restarts it.
    //
    // v1 does not re-wire a live process (PACK_PROTOCOL §8.2's note says why); what it does is refuse
    // to be silent — the bridge logs it, `collie pack status` reports "enrolled but INACTIVE", and
    // `collie join` names the lead's restart as the last step. The restart itself is still the
    // operator's, so it is still the harness's: this line IS that restart, not a workaround for a
    // missing one.
    await lead.restart();
  }, 60_000);

  test("the peer's listener now pins its lead, and the lead's does not pin", () => {
    expect(peer.pins()).toBe(true);
    expect(lead.pins()).toBe(false);
  });

  test("the lead's roster change took effect through the restart, not a live reload", async () => {
    // The verb restarted the peer; that restart is what re-bound the listener with the new `ca`.
    // `server.reload({tls})` does NOT swap a pinned `ca` in Bun 1.3.14 — which is why the verbs
    // restart at all, and why this is asserted rather than assumed.
    const before = peerListenerTls("peer", peer.store());
    expect(before).not.toBeNull();
    expect(before!.ca).toEqual([lead.store()!.self.certPem]);
    expect(await portOpen(peer.port)).toBe(true);
  });
});

// ── The pinned handshake, from both sides ────────────────────────────────────

describe("the TLS factor is enforced at the handshake", () => {
  test("an unpinned client certificate is refused before any handler runs", async () => {
    const stranger = mintIdentity({ commonName: "stranger", sans: ["127.0.0.1"] });
    const attempt = packFetch(`${peer.origin()}${PACK_HELLO_PATH}`, {
      tls: {
        cert: stranger.certPem,
        key: stranger.keyPem,
        ca: [peer.store()!.self.certPem],
        checkServerIdentity: () => undefined,
      },
      headers: { authorization: `Bearer ${peer.store()!.pack!.secret}` },
    });
    await expect(attempt).rejects.toThrow();
  });

  test("no client certificate at all is refused the same way", async () => {
    const attempt = packFetch(`${peer.origin()}${PACK_HELLO_PATH}`, {
      tls: { ca: [peer.store()!.self.certPem], checkServerIdentity: () => undefined },
    });
    await expect(attempt).rejects.toThrow();
  });

  test("the pinned lead is admitted, and gets the uniform 401 with the wrong secret", async () => {
    const ok = await dialAsLead(PACK_HELLO_PATH, {});
    expect(ok.status).toBe(200);
    // Two version numbers, and they are not the same kind of thing (§7.1): `protocol` is the wire
    // contract, `version` is a fact about the process answering. The second is threaded into the
    // router at boot from THIS checkout, so a real child bridge reports exactly what `collie version`
    // would print here — one machine, one string.
    expect(await ok.json()).toMatchObject({
      protocol: PACK_PROTOCOL_VERSION,
      version: collieVersionBare(join(import.meta.dir, "..", "..")),
    });

    const refused = await dialAsLead(PACK_HELLO_PATH, {}, "not-the-secret");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthorized" });
    // §8.5: a refusal carries no version banner. Its bytes are any other bare 401's.
    expect(refused.headers.get("x-pack-protocol")).toBeNull();
  });
});

// ── The merged snapshot and the proxied read ─────────────────────────────────

describe("the lead speaks for the pack", () => {
  test("the merged snapshot carries both hosts' sessions, host-tagged", async () => {
    const body = await snapshotOf(lead.origin());
    await waitFor(
      async () => (await snapshotOf(lead.origin())).servers?.length === 2,
      10_000,
      `the lead never merged the peer in (saw ${JSON.stringify(body.servers)})`,
    );
    const snap = await snapshotOf(lead.origin());
    const hosts = (snap.servers ?? []).map((s) => s.id).toSorted();
    expect(hosts).toEqual(
      [lead.store()!.self.memberId, peer.store()!.self.memberId].toSorted(),
    );
    // Every session is host-qualified once a pack exists (§9.2) — including the lead's own.
    expect((snap.sessions ?? []).every((s) => s.host !== undefined && s.host !== "")).toBe(true);
  }, 60_000);

  test("a proxied pane read is byte-identical and keeps its ETag and its 304", async () => {
    const peerId = peer.store()!.self.memberId;
    const url = `${lead.origin()}/api/pane/${encodeURIComponent(peer.paneId)}?host=${peerId}`;
    const first = await fetch(url);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const bodyText = await first.text();
    // The peer's own answer, unrewritten: the pane text came off the peer's fake Herdr, not the
    // lead's — the lead has a pane of its own with different text, so a mix-up would show here.
    expect(bodyText).toContain("peer pane");
    expect(bodyText).not.toContain("lead pane");

    const conditional = await fetch(url, { headers: { "if-none-match": etag! } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  test("the lead's own poll rate is unchanged by the pack it now leads", async () => {
    // The other half of §11's "no second timer". A lead that had armed a sweep timer of its own
    // would be polling its Herdr on one clock and its peers on another; instead the sweep is an
    // `onTick` of the SAME engine, so the local rate cannot have moved. Compared with a wide band,
    // because this measures a real machine and the assertion is "no extra clock", not "no jitter".
    const withPack = await cadence(lead);
    expect(withPack).toBeGreaterThan(soloCadence * 0.5);
    expect(withPack).toBeLessThan(soloCadence * 2);
  }, 60_000);

  test("the lead performs no filesystem access for a peer's pane", () => {
    // The peer's uploads dir is the observable: a lead that served a peer pane locally would have
    // had to materialise something under its own state dir.
    expect(readdirSync(lead.stateDir).toSorted()).not.toContain("uploads");
  });
});

// ── Failure modes ────────────────────────────────────────────────────────────

describe("a peer that is not there", () => {
  test("a write to a downed peer is refused, not silently retried", async () => {
    await peer.stop();
    try {
      const peerId = peer.store()!.self.memberId;
      const res = await fetch(
        `${lead.origin()}/api/pane/${encodeURIComponent(peer.paneId)}/reply?host=${peerId}`,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }) },
      );
      expect(res.ok).toBe(false);
      expect(res.status).toBeGreaterThanOrEqual(500);
      // Nothing reached the peer's Herdr — the refusal is a refusal, not a maybe.
      expect(peer.herdr!.writes).toEqual([]);
    } finally {
      await peer.start();
    }
  }, 60_000);

  test("an unreachable peer is a degraded entry in the snapshot, never a 5xx", async () => {
    await peer.stop();
    expect(await portOpen(peer.port)).toBe(false);
    try {
      const res = await fetch(`${lead.origin()}/api/snapshot`);
      expect(res.status).toBe(200);
      await waitFor(
        async () => {
          const snap = await snapshotOf(lead.origin());
          return (snap.servers ?? []).some((s) => s.id !== lead.store()!.self.memberId && !s.reachable);
        },
        10_000,
        async () =>
          `the lead never marked the downed peer degraded (last: ${JSON.stringify(
            (await snapshotOf(lead.origin())).servers,
          )}, port open: ${await portOpen(peer.port)})`,
      );
    } finally {
      await peer.start();
    }
  }, 60_000);
});

// ── §10.4: what a cold handshake costs, and what it costs to abort one ───────
//
// THE LIVE FINDING THIS PINS. A healthy peer behind a Tailscale DERP relay (≈350 ms RTT, TLS
// handshake measured at 1.9 s) read `unreachable · hello: timed out after 1200ms` forever. These
// tests reproduce that hermetically — a real pinned peer, dialled through a TCP proxy that counts
// accepts and injects one-way latency — and pin the three facts the fix rests on.

/** A counting, latency-injecting TCP proxy in front of `port`. Every accept is one new handshake. */
function startLatencyProxy(port: number, delayMs: number) {
  interface Pipe {
    up: { write: (b: Uint8Array) => void; end: () => void } | null;
    pending: Uint8Array[];
  }
  const pipes = new Map<object, Pipe>();
  const state = { accepts: 0 };
  const later = (fn: () => void): void => {
    if (delayMs === 0) fn();
    else setTimeout(fn, delayMs);
  };
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(sock) {
        state.accepts += 1;
        const pipe: Pipe = { up: null, pending: [] };
        pipes.set(sock, pipe);
        void Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data: (_s, d) => {
              const copy = new Uint8Array(d);
              later(() => sock.write(copy));
            },
            close: () => {
              sock.end();
            },
            error: () => {
              sock.end();
            },
          },
        }).then((up) => {
          pipe.up = up;
          for (const chunk of pipe.pending) up.write(chunk);
          pipe.pending = [];
          return undefined;
        });
      },
      data(sock, d) {
        const pipe = pipes.get(sock);
        if (pipe === undefined) return;
        const copy = new Uint8Array(d);
        later(() => {
          if (pipe.up === null) pipe.pending.push(copy);
          else pipe.up.write(copy);
        });
      },
      close(sock) {
        const pipe = pipes.get(sock);
        pipes.delete(sock);
        pipe?.up?.end();
      },
      error() {},
    },
  });
  return { state, port: listener.port ?? 0, stop: () => listener.stop(true) };
}

/** A real lead-side client aimed at `address`, with the two budgets under test. */
function clientForBudgets(timeoutMs: number, patientTimeoutMs?: number): PeerClient {
  const from = lead.store()!;
  const to = peer.store()!;
  return new PeerClient({
    self: from.self.memberId,
    secret: () => from.pack!.secret,
    timeoutMs,
    patientTimeoutMs,
    fetch: packFetch,
    // The SHIPPED pin, built the way bridge/index.ts builds it — including the fresh object per
    // dial, which is the thing that could plausibly have defeated connection reuse.
    tls: () => dialTls(from, { certPem: to.self.certPem }) ?? undefined,
  });
}

describe("a cold handshake priced above the budget", () => {
  test("Bun's fetch REUSES a pinned-TLS connection, even with a fresh `tls` object per dial", async () => {
    const proxy = startLatencyProxy(peer.port, 0);
    const link: PackLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
    try {
      const client = clientForBudgets(5000);
      for (let i = 0; i < 5; i++) expect((await client.hello(link)).ok).toBe(true);
      // Five requests, ONE handshake. This is why the fix is not "make the wiring pool" — it does.
      expect(proxy.state.accepts).toBe(1);
    } finally {
      proxy.stop();
    }
  }, 60_000);

  test("…but an ABORTED handshake leaves nothing pooled, so a strict budget never bootstraps", async () => {
    // 1 s of injected RTT prices the cold handshake above the 1200 ms poll budget — the DERP case.
    const proxy = startLatencyProxy(peer.port, 500);
    const link: PackLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
    try {
      const strict = clientForBudgets(1200);
      for (let i = 0; i < 3; i++) {
        const outcome = await strict.hello(link);
        expect(outcome.ok).toBe(false);
        expect(!outcome.ok && outcome.state === "unreachable" && outcome.timedOut).toBe(true);
      }
      // Three attempts, three fresh handshakes, no progress: "unreachable forever", reproduced.
      expect(proxy.state.accepts).toBe(3);

      // One patient probe breaks the deadlock — and the connection it warms is the one the strict
      // budget then rides. Both halves of §10.4 in two assertions.
      const patient = clientForBudgets(1200, 5000);
      expect((await patient.hello(link)).ok).toBe(true);
      expect(proxy.state.accepts).toBe(4);
      expect((await strict.hello(link)).ok).toBe(true);
      expect((await strict.snapshot(link)).ok).toBe(true);
      expect(proxy.state.accepts).toBe(4);
    } finally {
      proxy.stop();
    }
  }, 60_000);

  test("a cold DATA request bootstraps on the patient budget, then rides the warm one", async () => {
    // The same 1 s of injected RTT — the shape that left the link flapping with `hello` green and
    // every pane read 503ing after exactly one strict budget.
    const proxy = startLatencyProxy(peer.port, 500);
    const link: PackLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
    try {
      const starved = clientForBudgets(1200);
      expect((await starved.snapshot(link)).ok).toBe(false);
      expect(proxy.state.accepts).toBe(1);

      // With a patient budget wired, the FIRST data request pays for the handshake itself — no
      // `hello` in front of it — and every one after it rides the connection it left pooled.
      const client = clientForBudgets(1200, 5000);
      expect((await client.snapshot(link)).ok).toBe(true);
      expect(proxy.state.accepts).toBe(2);
      expect((await client.snapshot(link)).ok).toBe(true);
      expect((await client.proxy(link, "snapshot")).ok).toBe(true);
      expect(proxy.state.accepts).toBe(2);
    } finally {
      proxy.stop();
    }
  }, 60_000);
});

// ── §8.6: signed membership requests ─────────────────────────────────────────

describe("signed membership requests", () => {
  test("a request signed by a pinned member is admitted on the lead's unpinned surface", async () => {
    const res = await signedLeaveProbe({});
    // `hello` rather than a real `leave`: the assertion is that the SIGNATURE admitted the call, and
    // a real leave would tear the pack down mid-suite.
    expect(res.status).toBe(200);
  });

  test("a bad signature is the uniform 401", async () => {
    const res = await signedLeaveProbe({ corruptSignature: true });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("a stale timestamp is refused", async () => {
    const res = await signedLeaveProbe({ timestampOffsetMs: -10 * 60 * 1000 });
    expect(res.status).toBe(401);
  });

  test("a future timestamp is refused too", async () => {
    const res = await signedLeaveProbe({ timestampOffsetMs: 10 * 60 * 1000 });
    expect(res.status).toBe(401);
  });

  test("a signature over a different body does not carry to this one", async () => {
    const res = await signedLeaveProbe({ signBody: '{"other":true}' });
    expect(res.status).toBe(401);
  });

  test("the canonical string is what both sides agree on", () => {
    // Pinned here as well as in signing.test.ts because this is the one place both ends are real:
    // if the shape ever changed on one side only, every assertion above would still pass by
    // symmetry, and this line would not.
    expect(canonicalRequest("post", PACK_LEAVE_PATH, bodyDigest("{}"), 17)).toBe(
      `POST\n${PACK_LEAVE_PATH}\n${bodyDigest("{}")}\n17`,
    );
  });
});

// ── Rotation, promotion, leave ───────────────────────────────────────────────

describe("rotation", () => {
  test("the lead rotates, dials with the superseded secret, and records the pickup", async () => {
    const before = lead.store()!.pack!.secretGeneration;
    const rotated = await verb(lead, (d) => cmdPackRotate(d));
    expect(rotated.code).toBe(EXIT.OK);
    const after = lead.store()!;
    expect(after.pack!.secretGeneration).toBe(before + 1);
    // markSecretDelivered ran: the peer is not behind, so it is not dropped to `unenrolled`.
    expect(after.peers[0]!.secretGeneration).toBe(after.pack!.secretGeneration);
    expect(after.peers[0]!.status).toBe("enrolled");
    expect(rotated.out).toContain(`picked up generation ${after.pack!.secretGeneration}`);
    // …and the peer adopted it, on its own disk.
    expect(peer.store()!.pack!.secret).toBe(after.pack!.secret);
  }, 60_000);

  test("the pack still works on the new secret", async () => {
    const res = await dialAsLead(PACK_HELLO_PATH, {});
    expect(res.status).toBe(200);
  });
});

describe("promotion", () => {
  test("an UNAPPROVED promotion is refused by the real lead, and nothing moves (§14, ADR 0014)", async () => {
    // The whole of gate 1, end to end: a §8.6-signed self-claim from a genuinely enrolled member,
    // over real pinned TLS, against a real lead — refused, because no operator armed a consent there.
    const refused = await verb(peer, (d) => cmdPromote(d, ["--address", `127.0.0.1:${peer.port}`]));
    expect(refused.code).toBe(EXIT.REFUSED);
    expect(refused.err).toContain("has not approved");
    expect(refused.err).toContain("approve-promote");
    // …and it does NOT aim the operator at the destructive remedy for a missing consent.
    expect(refused.err).not.toContain("--force");
    expect(lead.store()!.lead).toBeNull();
    expect(peer.store()!.lead).not.toBeNull();
  }, 60_000);

  test("`collie promote` on the peer demotes the lead and moves the crown", async () => {
    const oldLeadId = lead.store()!.self.memberId;
    // Step one, on the machine being taken from: consent, which restarts the lead's bridge so the
    // process that fields the claim has actually read it (§14.1 — the `loaded` latch is why).
    const peerId = peer.store()!.self.memberId;
    const approved = await verb(lead, (d) => cmdPackApprovePromote(d, [peerId]));
    expect(approved.code).toBe(EXIT.OK);
    expect(lead.store()!.pendingHandover).toMatchObject({ memberId: peerId });

    const promoted = await verb(peer, (d) => cmdPromote(d, ["--address", `127.0.0.1:${peer.port}`]));
    expect(promoted.code).toBe(EXIT.OK);
    expect(promoted.out).toContain("stepped down");

    // The crown moved on both disks, and the pack identity did NOT change (§14: a role change).
    const newLead = peer.store()!;
    const demoted = lead.store()!;
    expect(newLead.lead).toBeNull();
    expect(newLead.peers.map((p) => p.memberId)).toEqual([oldLeadId]);
    expect(demoted.lead?.memberId).toBe(newLead.self.memberId);
    expect(demoted.peers).toEqual([]);
    expect(newLead.pack!.packId).toBe(demoted.pack!.packId);
    expect(newLead.pack!.secret).toBe(demoted.pack!.secret);
    // Single-use: the consent was spent in the same write as the demotion.
    expect(demoted.pendingHandover).toBeNull();
  }, 60_000);

  test("the listeners swapped roles: the new lead unpins, the demoted machine pins", () => {
    expect(peer.pins()).toBe(false);
    expect(lead.pins()).toBe(true);
  });

  test("each side re-points at the other's new scheme", async () => {
    // ── A HARNESS ARTEFACT, STATED SO IT IS NOT MISREAD AS A PROTOCOL STEP ───
    // A promotion swaps which machine pins its listener, and here — and ONLY here — that changes the
    // SCHEME: a lead in this harness is plain HTTP (it stands in for a front door that would
    // terminate TLS) and a peer is the pinned HTTPS listener. In a real deployment both are https
    // and nothing about the address changes. The stored address is a hint either way (§4), so
    // `collie reconnect` is the verb for it, and running it is cheaper and more honest than teaching
    // the harness to rewrite a roster behind the code's back.
    // The demoted machine is not restarted BY the promotion — §14 leaves it running, and it keeps
    // the lead-mode listener it booted with (pinning nothing) until something restarts it. Same shape
    // as the post-enrollment finding above, and the same answer: `promote` now prints `collie restart`
    // then `collie unserve` for that machine, its own `pack status` reports a peer on disk and a lead
    // in memory, and the restart stays the operator's — so, here, the harness's.
    await lead.restart();
    const oldLead = lead.store()!.self.memberId;
    const backToPeer = await verb(peer, (d) => cmdReconnect(d, [oldLead, `https://127.0.0.1:${lead.port}`]));
    expect(backToPeer.code).toBe(EXIT.OK);
    const backToLead = await verb(lead, (d) => cmdReconnect(d, [`http://127.0.0.1:${peer.port}`]));
    expect(backToLead.code).toBe(EXIT.OK);
  }, 60_000);
});

describe("leave", () => {
  test("the demoted machine leaves, and is removed on both sides", async () => {
    const left = await verb(lead, (d) => cmdLeave(d));
    expect(left.code).toBe(EXIT.OK);
    expect(left.out).toContain("removed this machine from its roster");
    // Locally: no pack, no pins, no secret — but the identity survives (§8.4).
    const after = lead.store()!;
    expect(after.pack).toBeNull();
    expect(after.lead).toBeNull();
    expect(after.self.certPem).toContain("BEGIN CERTIFICATE");
    // Remotely: the signed `leave` was admitted on the new lead's unpinned surface and applied.
    expect(peer.store()!.peers).toEqual([]);
  }, 60_000);

  test("both machines are back to a solo route table", async () => {
    const status = await verb(peer, (d) => cmdPackStatus(d, ["--no-probe"]));
    expect(status.code).toBe(EXIT.OK);
    // The peer still holds a pack of its own (it leads nobody), so this asserts the roster, not mode.
    expect(status.out).toContain("members: none yet");
  });
});

// ── Teardown is complete ─────────────────────────────────────────────────────

describe("teardown", () => {
  test("nothing was written outside either instance's own state dir", () => {
    // The two state dirs are siblings under one mkdtemp root, and every path either process was
    // given points inside its own. A writer that escaped would land in the other's tree or in the
    // root itself — both observable here.
    expect(readdirSync(root).toSorted()).toEqual(["desk", "laptop"]);
    for (const inst of [lead, peer]) {
      const other = inst === lead ? peer : lead;
      expect(readdirSync(other.stateDir)).not.toContain(`${inst.name}.json`);
    }
  });

  test("no port is left bound once an instance is stopped", async () => {
    const scratch = new Instance("scratch", "w1:p1", "x");
    scratch.startHerdr();
    await scratch.start();
    const port = scratch.port;
    expect(await portOpen(port)).toBe(true);
    await scratch.stop();
    scratch.herdr?.stop();
    await waitFor(async () => !(await portOpen(port)), 5000, "the port stayed bound after stop()");
  }, 60_000);
});

// ── §8.1/§8.6 PREMISE CANARIES: Bun can ENFORCE a client certificate but not READ it ─────────
//
// Two facts about Bun 1.3.14 underwrite the ENTIRE application-layer half of the pack's first factor:
//   1. `Bun.serve` verifies a pinned client certificate at the handshake but exposes NO per-request
//      accessor for the certificate that was presented. That is why identity is attested to the
//      admission gate as a boolean (`transportPinned`, bridge/pack/transport.ts) instead of read, and
//      why peer→lead requests must re-establish the second factor with a signature (§8.6, signing.ts).
//   2. `server.reload({ tls })` does NOT swap the enforced `ca`. That is why there is no live re-pin and
//      why every membership verb restarts the bridge to change its anchors (`applyLocally`, cli/pack.ts).
//
// If EITHER premise breaks in a future Bun, the workaround it justifies should be DISMANTLED, not
// silently fossilised. These probes stand up a minimal real `Bun.serve` over mutual TLS with certs this
// build mints, and assert the CURRENT limitation still holds — so they PASS today and FAIL loudly the
// day Bun gains the capability, pointing the next engineer at transport.ts / signing.ts / §8.6.
/**
 * Every per-request surface a client certificate could plausibly appear on, enumerated as a type.
 * All optional, and all expected to be `undefined` — the canaries below assert exactly that, so this
 * is the list of things Bun does NOT expose, not a claim that it does.
 */
declare const opaqueCertificate: unique symbol;
/**
 * Whatever a future Bun would hand back for a presented client certificate. Deliberately opaque —
 * the canaries only ever ask whether the value is `undefined`, never what is inside it, and
 * inventing a shape here would be a guess about an API that does not exist.
 */
type OpaqueCertificate = { readonly [opaqueCertificate]: never };

interface RequestCertProbe {
  socket?: unknown;
  getPeerCertificate?: unknown;
  peerCertificate?: unknown;
  clientCertificate?: unknown;
}

/** The same enumeration for the `Server` handed to a `fetch` handler. */
interface ServerCertProbe {
  getPeerCertificate?: (req: Request) => OpaqueCertificate;
  requestClientCertificate?: (req: Request) => OpaqueCertificate;
  peerCertificate?: unknown;
}

describe("Bun-capability canaries (the pin can be enforced but not read; a reload cannot re-pin)", () => {
  test("CANARY — the receiving side still cannot read the presented client certificate per request", async () => {
    const serverId = mintIdentity({ commonName: "canary-server", sans: ["127.0.0.1", "localhost"] });
    const clientId = mintIdentity({ commonName: "canary-client", sans: ["127.0.0.1"] });

    // Every per-request surface a client certificate could plausibly appear on. Enumerated by name and
    // captured from INSIDE the handler, on the enforced path — the handshake below only completes for a
    // pinned client, so if any of these is non-`undefined` the certificate is readable, which is exactly
    // the capability this canary guards against.
    let surfaces: Array<[name: string, value: unknown]> = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: serverId.certPem,
        key: serverId.keyPem,
        ca: [clientId.certPem],
        requestCert: true,
        rejectUnauthorized: true,
      },
      fetch(req, srv) {
        // SAFETY: every member of both probes is optional, so neither assertion claims a property
        // exists — the point of the canary is that they are all still `undefined`. Reading one that
        // Bun has not (yet) added is exactly the question being asked.
        const r = req as RequestCertProbe;
        // SAFETY: as above — every member of ServerCertProbe is optional, so this asserts nothing
        // about what Bun's `Server` actually carries.
        const s = srv as ServerCertProbe;
        surfaces = [
          // On the `Request`…
          ["req.socket", r.socket],
          ["req.getPeerCertificate", r.getPeerCertificate],
          ["req.peerCertificate", r.peerCertificate],
          ["req.clientCertificate", r.clientCertificate],
          // …on the `Server` handed to the handler.
          ["server.getPeerCertificate", s.getPeerCertificate?.(req) ?? s.getPeerCertificate],
          ["server.requestClientCertificate", s.requestClientCertificate?.(req) ?? s.requestClientCertificate],
          ["server.peerCertificate", s.peerCertificate],
        ];
        return new Response("ok");
      },
    });
    try {
      const res = await packFetch(`https://127.0.0.1:${server.port}/`, {
        tls: {
          cert: clientId.certPem,
          key: clientId.keyPem,
          ca: [serverId.certPem],
          checkServerIdentity: () => undefined,
        },
      });
      // The handshake completed → the pin was ENFORCED and the handler ran. That half must keep working.
      expect(res.status).toBe(200);

      // CANARY — when any of these becomes readable, Bun gained the capability; dismantle the workaround
      // (transport.ts's boolean `transportPinned` / signing.ts's §8.6 signatures / §8.6 itself), because
      // the receiver could then read the peer identity directly instead of re-deriving it from a signature.
      for (const [name, value] of surfaces) {
        expect(value, `${name} must stay absent — see transport.ts / signing.ts / PACK_PROTOCOL §8.6`).toBeUndefined();
      }
    } finally {
      server.stop(true);
    }
  });

  test("CANARY — server.reload({tls:{ca}}) does NOT change the enforced pin", async () => {
    const serverId = mintIdentity({ commonName: "canary-server", sans: ["127.0.0.1", "localhost"] });
    const pinned = mintIdentity({ commonName: "canary-pinned", sans: ["127.0.0.1"] });
    const added = mintIdentity({ commonName: "canary-added", sans: ["127.0.0.1"] });

    const serveOpts = (ca: string[]) => ({
      port: 0,
      hostname: "127.0.0.1",
      tls: {
        cert: serverId.certPem,
        key: serverId.keyPem,
        ca,
        requestCert: true,
        rejectUnauthorized: true,
      },
      fetch: () => new Response("ok"),
    });
    const server = Bun.serve(serveOpts([pinned.certPem]));
    const dial = (who: { certPem: string; keyPem: string }): Promise<Response> =>
      packFetch(`https://127.0.0.1:${server.port}/`, {
        tls: { cert: who.certPem, key: who.keyPem, ca: [serverId.certPem], checkServerIdentity: () => undefined },
      });
    try {
      // Baseline: the pinned client is admitted; a client the listener never anchored is refused at the
      // handshake (BoringSSL rejects it before any handler) — establishing that enforcement is real.
      expect((await dial(pinned)).status).toBe(200);
      await expect(dial(added)).rejects.toThrow();

      // Add the second certificate to the anchor list the ONLY way a live process could: reload.
      server.reload(serveOpts([pinned.certPem, added.certPem]));

      // CANARY — the newly-added client is STILL refused, because reload did not swap the enforced `ca`.
      // When this stops throwing, `server.reload({tls})` re-pins live; dismantle the "no live re-pin /
      // restart to re-pin" workaround (transport.ts, and the membership-verb restart in cli/pack.ts).
      await expect(
        dial(added),
        "reload re-pinned live — revisit transport.ts's no-live-re-pin and PACK_PROTOCOL §8.6",
      ).rejects.toThrow();
    } finally {
      server.stop(true);
    }
  });
});


// ── Helpers ──────────────────────────────────────────────────────────────────

/** Dial the pinned member as the other member would — real client certificate, real pin. */
async function dialAsLead(path: string, init: RequestInit, secret?: string): Promise<Response> {
  const from = lead.store()!;
  const to = peer.store()!;
  const target = from.peers.find((p) => p.memberId === to.self.memberId) ?? to.lead!;
  return packFetch(`https://127.0.0.1:${peer.port}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${secret ?? from.pack!.secret}`,
      "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
      "x-pack-member": from.self.memberId,
    },
    tls: {
      cert: from.self.certPem,
      key: from.self.keyPem,
      ca: [target.certPem],
      checkServerIdentity: () => undefined,
    },
  });
}

/**
 * A signed peer→lead request, with the knobs each §8.6 refusal needs.
 *
 * Sent to `hello` rather than `leave` so a passing test does not dismantle the pack; the admission
 * path is identical, because the signature is verified before any route is chosen.
 */
async function signedLeaveProbe(opts: {
  corruptSignature?: boolean;
  timestampOffsetMs?: number;
  signBody?: string;
}): Promise<Response> {
  const from = peer.store()!;
  const timestamp = Date.now() + (opts.timestampOffsetMs ?? 0);
  const signed = signRequest(from.self.keyPem, {
    method: "GET",
    path: PACK_HELLO_PATH,
    body: opts.signBody ?? "",
    timestamp,
  });
  const signature = opts.corruptSignature === true ? flipBase64(signed) : signed;
  return fetch(`http://127.0.0.1:${lead.port}${PACK_HELLO_PATH}`, {
    headers: {
      authorization: `Bearer ${from.pack!.secret}`,
      "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
      "x-pack-member": from.self.memberId,
      [TIMESTAMP_HEADER]: String(timestamp),
      [SIGNATURE_HEADER]: signature,
    },
  });
}

/** Corrupt a base64 signature without changing its length — a wrong signature, not a malformed one. */
function flipBase64(value: string): string {
  const chars = [...value];
  const i = Math.floor(chars.length / 2);
  chars[i] = chars[i] === "A" ? "B" : "A";
  return chars.join("");
}

/** Pump a child's stream into a string, so a failing assertion can quote the child's own log. */
async function drain(stream: ReadableStream<Uint8Array> | undefined, onChunk: (s: string) => void): Promise<void> {
  if (stream === undefined) return;
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      onChunk(decoder.decode(value));
    }
  } catch {
    // The child went away mid-read; its log is whatever arrived.
  }
}

/** How many calls per second an instance makes to its own Herdr, measured over a two-second window. */
async function cadence(instance: Instance): Promise<number> {
  const before = instance.herdr!.calls.length;
  await Bun.sleep(2000);
  return (instance.herdr!.calls.length - before) / 2;
}

/** A port nothing is listening on, obtained by binding one and letting go. */
async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port ?? 0;
  probe.stop(true);
  if (port === 0) throw new Error("could not obtain a free port");
  return port;
}

async function portOpen(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Poll `predicate` until it holds or the budget runs out. Every wait in this file goes through it. */
async function waitFor(
  predicate: () => Promise<boolean>,
  budgetMs: number,
  message: string | (() => Promise<string>),
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  // The message is LAZY by option: a diagnostic that fetches state must fetch it at the moment of
  // failure, not at the moment the wait was set up — an eagerly-built one describes t=0 and lies.
  const detail = typeof message === "string" ? message : await message();
  throw new Error(`timed out after ${budgetMs}ms: ${detail}`);
}
