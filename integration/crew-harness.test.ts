import { emptyConfigLayer } from "../bridge/config-source.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createServer } from "node:net";

import { HOST } from "../bridge/host.ts";
import type { JsonValue } from "../bridge/json.ts";
import { EXIT } from "../cli/io.ts";
import { askSocket, cmdWalkySend, cmdWalkyStatus, type WalkyDeps } from "../cli/walky.ts";
import { asJsonObject, asJsonString } from "../web/src/lib/json.ts";
import { signMessage } from "../bridge/walky/canonical.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { readReceiptsAnswer, readWalkyReport } from "../bridge/walky/parse.ts";
import { attestFor, senderBlockFor, WALKY_REPORT_FIELD } from "../bridge/walky/crew.ts";
import { NUDGE_MARK, type WalkyMessage, type WalkyReceipt } from "../bridge/walky/types.ts";
import { cmdDevicesRevoke } from "../cli/pairing.ts";
import {
  cmdJoin,
  cmdLeave,
  cmdCrewApprovePromote,
  cmdCrewInvite,
  cmdCrewRotate,
  cmdCrewStatus,
  cmdPromote,
  cmdReconnect,
  type CrewDeps,
} from "../cli/crew.ts";
import { DEFAULT_SERVE_PORT, type CliContext } from "../cli/context.ts";
import type { Exec, ExecResult } from "../cli/sys.ts";
import { realFiles } from "../cli/sys.ts";
import { CrewOpsStore } from "../bridge/crew/ops-store.ts";
import { CREW_PROTOCOL_VERSION } from "../bridge/crew/enrollment.ts";
import { startFakeHerdr, type FakeHerdr, type PaneWrite } from "../bridge/crew/fake-herdr.ts";
import { mintIdentity, randomToken } from "../bridge/crew/identity.ts";
import { CREW_HELLO_PATH, CREW_LEAVE_PATH, CREW_PREFIX, CREW_SNAPSHOT_PATH, CREW_WALKY_PATH } from "../bridge/crew/router.ts";
import { parseStandbyDevices } from "../bridge/crew/standby-devices.ts";
import { TAKEOVER_RESTART_EXIT } from "../bridge/crew/takeover.ts";
import { parseMarker, crewRuntimePath } from "../bridge/crew/staleness.ts";
import { memberWarrantLines, peerWarrantLines } from "../cli/crew-status-deputy.ts";
import { isWellFormedLocalSecret, localSecretPath } from "../bridge/local-secret.ts";
import { CODE_TTL_MS, generateCode, newPending, PENDING_FILENAME, sha256Hex } from "../bridge/pairing.ts";
import {
  bodyDigest,
  canonicalRequest,
  signCanonical,
  signDial,
  signRequest,
  DIAL_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../bridge/crew/signing.ts";
import { canonicalWarrant, mintWarrant, parseWarrantActiveReport, parseWarrantReport } from "../bridge/crew/warrant.ts";
import { PeerClient, type CrewLink } from "../bridge/crew/peer-client.ts";
import { dialTls, peerListenerTls, type CrewRequestInit, type CrewTlsOptions } from "../bridge/crew/transport.ts";
import {
  parseTrustStore,
  serializeTrustStore,
  TrustStore,
  TRUST_STORE_FILENAME,
  type TrustStoreData,
} from "../bridge/crew/trust-store.ts";
import { collieVersionBare } from "../bridge/version.ts";
import type { CrewStatusResponse, MachinesResponse } from "../bridge/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// THE TWO-INSTANCE INTEGRATION HARNESS (spec M4/08).
//
// ── WHY THIS LIVES IN `integration/` AND NOT IN `bridge/crew/` ───────────────
// It was `bridge/crew/harness.test.ts` until 2026-09-30, and `bun run test` therefore paid for it on
// every push: 58.3s of a 67.0s backend run, measured, while every other file in `bridge/` is under
// five seconds. The time is INHERENT and not waste. This file boots twenty real child processes,
// because `server.reload({tls})` cannot re-pin a certificate (the canary below proves it), so every
// membership change needs a real restart; and its arming thresholds are already at the floor the
// race note downstream explains.
//
// So it moved lanes rather than being trimmed. `bun test ./bridge` no longer finds it, `bun run
// test:crew` runs it by name, and CI gives it a job of its own beside the browser tier. The
// directory is also the honest filing: the imports below reach into `bridge/` AND `cli/` in equal
// measure, which is already proof it was never a unit test of either.
//
// Two REAL Collie bridges, as child processes, on loopback, enrolled through the REAL enrollment
// path, talking over REAL pinned mutual TLS with certificates this build minted. Nothing about the
// crew is faked: not the handshake, not the trust store, not the HTTP, not the admission gate.
//
// ── WHY IT IS A `bun test` FILE AND NOT A SHELL SCRIPT ───────────────────────
// CLAUDE.md's rule is that `Bun.serve`-dependent code stays out of `bun test`, because Vitest-on-Node
// cannot run it. The backend suite is Bun's OWN runner, which can — the constraint was never about
// this side. Keeping the harness here buys the thing a shell script could not: the operator verbs are
// invoked as the FUNCTIONS `cli/crew.ts` exports, with `CrewDeps` supplied by the harness. So
// `restart()` is a real respawn of a real child process (which is what a membership change must
// trigger, and what re-pins the listener), `serve()`/`unserve()` are no-ops that touch no tailnet,
// and nothing in this file can reach the machine it runs on.
//
// ── WHAT IS FAKED, AND WHY IT IS HONEST ──────────────────────────────────────
// Exactly one thing: Herdr. `fake-herdr.ts` answers the handful of methods a snapshot and a pane read
// need, over a real unix socket, one-shot as the real server is. The subject here is the crew
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
// Deliberately TALL — well past `GZIP_MIN_BYTES` (bridge/http-cache.ts), so the peer's own gzip
// branch is genuinely reached when the hop negotiates gzip. A two-line fixture kept every proxied
// body under the threshold, which is exactly why the header-vs-bytes bug below was invisible here.
const PANE_TEXT_PEER =
  "peer pane\n$ echo laptop\n" + Array.from({ length: 40 }, (_, i) => `laptop line ${i} ................`).join("\n");

let root: string;

/**
 * A GET that decodes NOTHING — status, headers and the bytes exactly as they were framed.
 *
 * `fetch` (Bun's and every browser's) transparently inflates a `content-encoding: gzip` body while
 * leaving the header in place, so under `fetch` a header that describes its bytes and one that lies
 * about them look identical. That is what let the beta.9 bug ship. `node:http` performs no content
 * decoding, so the assertion "encoding claimed ⟺ bytes gzipped" is actually decidable.
 */
async function rawGet(
  target: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> }> {
  const url = new URL(target);
  return await new Promise((resolve, reject) => {
    const req = httpGet(
      { host: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, headers },
      (msg) => {
        const chunks: Buffer[] = [];
        msg.on("data", (chunk: Buffer) => chunks.push(chunk));
        msg.on("end", () => {
          const flat: Record<string, string> = {};
          for (const [name, value] of Object.entries(msg.headers)) {
            if (value !== undefined) flat[name] = Array.isArray(value) ? value.join(", ") : value;
          }
          // Copied into a plain `Uint8Array` rather than handed on as a `Buffer`: a Buffer's backing
          // store is `ArrayBufferLike`, which `Bun.gunzipSync` will not take.
          const merged = Buffer.concat(chunks);
          const body = new Uint8Array(merged.byteLength);
          body.set(merged);
          resolve({ status: msg.statusCode ?? 0, headers: flat, body });
        });
      },
    );
    req.on("error", reject);
  });
}

/** One end of the crew: a scratch state dir, a fake Herdr, and a child bridge we can respawn. */
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
    /** Extra environment for this child — the standby door's two keys, and nothing else so far. */
    readonly extraEnv: Record<string, string> = {},
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
    // The previous process's secret names nothing a new bridge holds. Removed here so the wait in
    // `localAuth()` can only ever be satisfied by the file THIS start wrote.
    rmSync(localSecretPath(this.stateDir), { force: true });
    this.proc = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "bridge", "index.ts")], {
      cwd: join(import.meta.dir, ".."),
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
        // on the crew. Lowering it changes the cadence, never the mechanism: there is still no
        // second timer, which is exactly what the cadence assertion measures.
        COLLIE_POLL_IDLE_MS: "1000",
        COLLIE_MULTI_SESSION: "0",
        ...this.extraEnv,
        // The crew surface is what is under test; the browser gate is not, and a peer serves no
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

  /**
   * The read credential for this instance: the host's own per-start secret (ADR 0086,
   * bridge/local-secret.ts), read off `<stateDir>/local-secret` exactly as the CLI reads it. It is
   * rotated on every start, so it is read per request and never cached. Waits for the file because a
   * listener can accept before the bridge has written it.
   */
  async localAuth(): Promise<Record<string, string>> {
    const path = localSecretPath(this.stateDir);
    let secret = "";
    await waitFor(
      () => {
        try {
          secret = readFileSync(path, "utf8").trim();
        } catch {
          secret = "";
        }
        return Promise.resolve(isWellFormedLocalSecret(secret));
      },
      10_000,
      () => `${this.name} never wrote its local secret`,
    );
    return { authorization: `Bearer ${secret}` };
  }

  /** The pairing token this drill claimed for the write routes, once, through the real claim. */
  private pairedToken: string | null = null;

  /**
   * A real pairing token for the write routes, claimed the way a phone claims one. The drill owns the
   * state dir, so it plays `collie pair` itself: the same `generateCode` and `newPending` write the
   * same pending file (the bridge picks it up without a restart), then `POST /api/pair` with a
   * same-origin `Origin` hands out the token. The token lives in `paired-devices.json`, so it survives
   * this instance's restarts. The local secret is never used for a write: it is read-level only.
   */
  async pairingAuth(): Promise<Record<string, string>> {
    if (this.pairedToken === null) {
      const code = generateCode();
      writeFileSync(
        join(this.stateDir, PENDING_FILENAME),
        JSON.stringify(newPending(code, Date.now(), CODE_TTL_MS)),
        { mode: 0o600 },
      );
      const res = await fetch(`${this.origin()}/api/pair`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: this.origin() },
        body: JSON.stringify({ code, label: "drill" }),
      });
      expect(res.status).toBe(200);
      // SAFETY: the handler emits `{ token, label }` on a claim (server.ts, `POST /api/pair`).
      this.pairedToken = ((await res.json()) as { token: string }).token;
    }
    return { authorization: `Bearer ${this.pairedToken}`, origin: this.origin() };
  }

  /** A GET or other READ of this instance's `/api/*`, carrying its local credential. */
  async api(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(await this.localAuth())) headers.set(name, value);
    return fetch(`${this.origin()}${path}`, { ...init, headers });
  }

  /** A write to this instance's `/api/*`, carrying a real pairing token and a same-origin `Origin`. */
  async apiWrite(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(await this.pairingAuth())) headers.set(name, value);
    return fetch(`${this.origin()}${path}`, { ...init, headers });
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

// ── The `CrewDeps` a verb runs against ───────────────────────────────────────

/** An `Exec` that finds nothing. `tailscale` is therefore absent, so no verb can reach a tailnet. */
const noExec: Exec = {
  which: () => null,
  capture: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  inherit: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  runIn: (): ExecResult => ({ code: 127, stdout: "", stderr: "", found: false }),
  runLogged: () => ({ code: 127, timedOut: false, stderr: "" }),
  spawnDetached: () => null,
  processCommand: () => null,
  kill: () => {},
};

/**
 * A {@link CrewRequestInit} whose `tls` half may be partial: one test below dials with no client
 * certificate at all, which is the refusal it is checking for.
 */
type TestCrewRequestInit = Omit<CrewRequestInit, "tls"> & { tls?: Partial<CrewTlsOptions> };

/**
 * Bun's `fetch` understands a per-request `tls` option that the DOM `RequestInit` type has no room
 * for — `CrewRequestInit` (transport.ts) is the bridge's name for that superset. This is the one
 * place in this file where the wider init meets the platform signature.
 */
function crewFetch(url: string, init: TestCrewRequestInit): Promise<Response> {
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
async function snapshotOf(instance: Instance): Promise<MergedSnapshot> {
  const res = await instance.api("/api/snapshot");
  // SAFETY: the handler emits its body `satisfies SnapshotResponse` (server.ts), and MergedSnapshot
  // is a structural subset of that type with every field optional — it claims nothing the handler
  // does not already promise.
  return (await res.json()) as MergedSnapshot;
}

interface Captured {
  readonly out: string[];
  readonly err: string[];
}

function depsFor(instance: Instance, captured: Captured): CrewDeps {
  const ctx: CliContext = {
    root: join(import.meta.dir, ".."),
    instance: null,
    configDir: join(instance.home, "config"),
    home: instance.home,
    env: { COLLIE_POLL_MS: "300" },
    configLayer: emptyConfigLayer(),
    port: instance.port,
    serveMode: "http",
    servePort: DEFAULT_SERVE_PORT,
    basePath: "/",
    socket: instance.socketPath,
    handlerFile: join(instance.home, "config", "tailscale-managed-handler"),
    stateDir: instance.stateDir,
  };
  return {
    ctx,
    io: { out: (l) => captured.out.push(l), err: (l) => captured.err.push(l) },
    exec: noExec,
    files: realFiles,
    // The machine the drill runs on, as production passes it: a verb refuses on a Windows host.
    host: HOST,
    store: freshStore(instance),
    ops: new CrewOpsStore(instance.stateDir),
    audit: null,
    // The REAL platform fetch, so a pinned handshake is a pinned handshake.
    fetch: crewFetch,
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
  run: (deps: CrewDeps) => Promise<number>,
): Promise<{ code: number; out: string; err: string }> {
  const captured: Captured = { out: [], err: [] };
  const code = await run(depsFor(instance, captured));
  return { code, out: captured.out.join("\n"), err: captured.err.join("\n") };
}

// ── Setup ────────────────────────────────────────────────────────────────────

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "collie-crew-e2e-"));
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
    // `/crew/v1/*` is NOT ROUTED on an instance that never enrolled, and the observable form of that
    // is INDISTINGUISHABILITY, not a particular code: whatever an arbitrary unknown path gets — an
    // SPA fallback on a build with `web/dist`, a 404 without one — the crew prefix gets the same.
    // Asserting a literal 404 here would have been asserting the presence of a frontend build.
    const unknown = await fetch(`${base}/definitely/not/a/route`);
    const packed = await fetch(`${base}${CREW_HELLO_PATH}`);
    expect(packed.status).toBe(unknown.status);
    expect(packed.headers.get("x-crew-protocol")).toBeNull();
    // Today's codes, WITH the host's own read credential (ADR 0086): reads need the pairing token,
    // and a drill that sends none would measure the gate and not the routes.
    expect((await lead.api(`/api/snapshot`)).status).toBe(200);
    expect((await lead.api(`/api/config`)).status).toBe(200);
    expect((await lead.api(`/api/pane/${encodeURIComponent(lead.paneId)}`)).status).toBe(200);
  });

  test("with no credential every read is 403 but health, and a wrong one is no better", async () => {
    const base = lead.origin();
    const wrong = { authorization: `Bearer ${"A".repeat(43)}` };
    const paths = ["/api/snapshot", "/api/config", `/api/pane/${encodeURIComponent(lead.paneId)}`, "/api/crew", "/api/machines"];
    for (const path of paths) {
      const bare = await fetch(`${base}${path}`);
      expect([path, bare.status, await bare.text()]).toEqual([path, 403, "device not paired"]);
      expect([path, (await fetch(`${base}${path}`, { headers: wrong })).status]).toEqual([path, 403]);
    }
    // The one open read: the updater's probe, asked before anyone holds a token.
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  test("the peer sweep rides the herd poll — there is no second timer", async () => {
    // §11's row, measured rather than inferred. The lead's own Herdr is polled by the state engine;
    // the peer's Herdr is polled by the PEER's state engine, and the peer's `/crew/v1/snapshot` is
    // served from that. What the row is really about is that adding a peer arms NO new clock on the
    // lead, so the lead's call rate to its own Herdr must be the same before and after a crew forms.
    // Recorded here while both instances are still solo; asserted after enrollment.
    soloCadence = await cadence(lead);
    expect(soloCadence).toBeGreaterThan(0);
  }, 60_000);

  test("`/api/crew` is registered on a solo instance and answers 404 — there is no crew", async () => {
    // The Crew overview is a FRONT-DOOR route, so unlike `/crew/v1/*` it exists here: what a solo
    // instance owes is a refusal, not an absence, and it is the same refusal a peer gives (ADR 0013).
    const res = await lead.api(`/api/crew`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('"code":"crew.not_lead"');
  });

  // ADR 0084: Machines exists on a solo collie too, as one row for its own machine. The sampler rides
  // the engine tick and needs two readings five seconds apart, so the sample arrives, it is not there.
  test("`/api/machines` answers one row on a solo instance, and its own sample arrives on the tick", async () => {
    const machinesOf = async (): Promise<MachinesResponse> =>
      // SAFETY: the handler emits `MachinesResponse` (server.ts, `serveMachinesRoute`).
      (await (await lead.api(`/api/machines`)).json()) as MachinesResponse;
    await waitFor(
      async () => (await machinesOf()).machines[0]?.sample !== undefined,
      15_000,
      async () => `no sample on the solo row (saw ${JSON.stringify(await machinesOf())})`,
    );
    const body = await machinesOf();
    expect(body.machines.map((m) => [m.id, m.isLead, m.health])).toEqual([["local", true, "reachable"]]);
    expect(body.machines[0]!.sample!.cpu).toBeGreaterThanOrEqual(0);
    expect(body.machines[0]!.sample!.cpu).toBeLessThanOrEqual(1);
    expect(body.machines[0]!.sample!.memTotal).toBeGreaterThan(0);
    const history = await lead.api(`/api/machines/local/history`);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ stepMs: 60_000 });
    expect((await lead.api(`/api/machines/nas/history`)).status).toBe(404);
  }, 30_000);

  test("a solo snapshot carries no crew fields", async () => {
    const body = await (await lead.api(`/api/snapshot`)).text();
    expect(body).not.toMatch(/"servers"|"host":|"crew"/);
  });
});

// ── Enrollment over the real transport ───────────────────────────────────────

describe("invite → join, end to end", () => {
  let token = "";

  test("the lead mints an invite and can answer it", async () => {
    const minted = await verb(lead, (d) => cmdCrewInvite(d, ["--label", "laptop"]));
    expect(minted.code).toBe(EXIT.OK);
    token = minted.out.split("\n")[0]!.trim();
    expect(token.length).toBeGreaterThan(20);
    // Minting an invite is the moment a crew comes into existence — and the moment the first key
    // material is written. Before it there was nothing (asserted above).
    const data = lead.store();
    expect(data?.crew).not.toBeNull();
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
    // `join` restarts the PEER (it is the machine changing mode), and `crew invite` restarted the
    // LEAD so it could answer the invite — but nothing restarts the lead AFTER the enrollment lands.
    // The lead's `CrewLead` is built at startup from the roster as it was then, which for a first
    // enrollment is empty, so the running lead writes the new peer to disk and goes on merging
    // nothing until something else restarts it.
    //
    // v1 does not re-wire a live process (CREW_PROTOCOL §8.2's note says why); what it does is refuse
    // to be silent — the bridge logs it, `collie crew status` reports "enrolled but INACTIVE", and
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
    const attempt = crewFetch(`${peer.origin()}${CREW_HELLO_PATH}`, {
      tls: {
        cert: stranger.certPem,
        key: stranger.keyPem,
        ca: [peer.store()!.self.certPem],
        checkServerIdentity: () => undefined,
      },
      headers: { authorization: `Bearer ${peer.store()!.crew!.secret}` },
    });
    await expect(attempt).rejects.toThrow();
  });

  test("no client certificate at all is refused the same way", async () => {
    const attempt = crewFetch(`${peer.origin()}${CREW_HELLO_PATH}`, {
      tls: { ca: [peer.store()!.self.certPem], checkServerIdentity: () => undefined },
    });
    await expect(attempt).rejects.toThrow();
  });

  test("the pinned lead is admitted, and gets the uniform 401 with the wrong secret", async () => {
    const ok = await dialAsLead(CREW_HELLO_PATH, {});
    expect(ok.status).toBe(200);
    // Two version numbers, and they are not the same kind of thing (§7.1): `protocol` is the wire
    // contract, `version` is a fact about the process answering. The second is threaded into the
    // router at boot from THIS checkout, so a real child bridge reports exactly what `collie version`
    // would print here — one machine, one string.
    expect(await ok.json()).toMatchObject({
      protocol: CREW_PROTOCOL_VERSION,
      version: collieVersionBare(join(import.meta.dir, "..")),
    });

    const refused = await dialAsLead(CREW_HELLO_PATH, {}, "not-the-secret");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: "unauthorized" });
    // §8.5: a refusal carries no version banner. Its bytes are any other bare 401's.
    expect(refused.headers.get("x-crew-protocol")).toBeNull();
  });
});

// ── The merged snapshot and the proxied read ─────────────────────────────────

describe("the lead speaks for the crew", () => {
  test("the merged snapshot carries both hosts' sessions, host-tagged", async () => {
    const body = await snapshotOf(lead);
    await waitFor(
      async () => (await snapshotOf(lead)).servers?.length === 2,
      10_000,
      `the lead never merged the peer in (saw ${JSON.stringify(body.servers)})`,
    );
    const snap = await snapshotOf(lead);
    const hosts = (snap.servers ?? []).map((s) => s.id).toSorted();
    expect(hosts).toEqual(
      [lead.store()!.self.memberId, peer.store()!.self.memberId].toSorted(),
    );
    // Every session is host-qualified once a crew exists (§9.2) — including the lead's own.
    expect((snap.sessions ?? []).every((s) => s.host !== undefined && s.host !== "")).toBe(true);
  }, 60_000);

  test("`GET /api/crew` reports the crew from memory, and dials nobody to do it", async () => {
    const leadId = lead.store()!.self.memberId;
    const peerId = peer.store()!.self.memberId;
    await waitFor(
      async () => (await snapshotOf(lead)).servers?.length === 2,
      10_000,
      "the lead never merged the peer in",
    );
    const res = await lead.api(`/api/crew`);
    expect(res.status).toBe(200);
    // SAFETY: the handler emits `CrewStatusResponse` (server.ts, `/api/crew`) — the same discipline
    // `snapshotOf` above applies to the snapshot body.
    const body = (await res.json()) as CrewStatusResponse;

    expect(body.crew.id).toBe(lead.store()!.crew!.crewId);
    expect(body.crew.name).toBe(lead.store()!.crew!.name);
    // The lead FIRST, then the peer — the order `servers[]` has, from the same `self` value (§9.2).
    expect(body.members.map((m) => m.id)).toEqual([leadId, peerId]);
    expect(body.members[0]!.isLead).toBe(true);
    expect(body.members[0]!.version).toBe(collieVersionBare(join(import.meta.dir, "..")));
    // A lead is not in its own roster, so it has neither of the two roster-only fields.
    expect(Object.keys(body.members[0]!)).not.toContain("address");
    expect(Object.keys(body.members[0]!)).not.toContain("enrolledAt");
    // The peer's row is the ROSTER's address, verbatim — never one re-derived from a live socket.
    expect(body.members[1]).toMatchObject({
      isLead: false,
      address: lead.store()!.peers[0]!.address,
      secretBehind: false,
    });

    // Nothing secret rides this wire, asserted over the bytes rather than field by field.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(lead.store()!.crew!.secret);
    expect(raw).not.toContain("BEGIN CERTIFICATE");
    expect(raw).not.toContain(lead.store()!.self.fingerprint);
  }, 60_000);

  // ADR 0084: the lead lists every machine under the id `/api/crew` uses for it, and a member's load
  // arrives as the `machineStats` sibling of the snapshot the sweep already dials.
  test("`/api/machines` lists both machines under their crew ids, and the peer's sample arrives", async () => {
    const leadId = lead.store()!.self.memberId;
    const peerId = peer.store()!.self.memberId;
    const machinesOf = async (): Promise<MachinesResponse> =>
      // SAFETY: the handler emits `MachinesResponse` (server.ts, `serveMachinesRoute`).
      (await (await lead.api(`/api/machines`)).json()) as MachinesResponse;
    await waitFor(
      async () => (await machinesOf()).machines.find((m) => m.id === peerId)?.sample !== undefined,
      15_000,
      async () => `the peer's row never got a sample (saw ${JSON.stringify(await machinesOf())})`,
    );
    const body = await machinesOf();
    // SAFETY: the handler emits `CrewStatusResponse` (server.ts, `/api/crew`).
    const crew = (await (await lead.api(`/api/crew`)).json()) as CrewStatusResponse;
    expect(body.machines.map((m) => m.id)).toEqual(crew.members.map((m) => m.id));
    expect(body.machines.map((m) => m.id)).toEqual([leadId, peerId]);
    expect(body.machines.map((m) => m.isLead)).toEqual([true, false]);
    const peerRow = body.machines[1]!;
    expect(peerRow.health).toBe("reachable");
    // Stamped on the LEAD's clock at receipt (§10.2), so never in the lead's future.
    expect(peerRow.sampledAt!).toBeLessThanOrEqual(body.ts);
    expect(peerRow.sample!.cores).toBeGreaterThan(0);
    // The sibling never leaks into the browser's merged snapshot.
    expect(JSON.stringify(await snapshotOf(lead))).not.toContain("machineStats");
  }, 30_000);

  test("the read gate covers `/api/crew`, exactly as it covers `/api/config`", async () => {
    // A cross-origin read is refused before the body is composed — the same `guard(…, "read")` every
    // other non-terminal endpoint takes, so a rebound DNS name cannot read the roster either.
    // WITH the credential: the only thing wrong with this request is its Origin, so the 403 is the
    // read gate's cross-origin refusal and not the missing-credential one.
    const res = await lead.api("/api/crew", { headers: { origin: "http://evil.invalid" } });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("cross-origin");
  });

  test("a proxied pane read is byte-identical and keeps its ETag and its 304", async () => {
    const peerId = peer.store()!.self.memberId;
    const path = `/api/pane/${encodeURIComponent(peer.paneId)}?host=${peerId}`;
    const first = await lead.api(path);
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).not.toBeNull();
    const bodyText = await first.text();
    // The peer's own answer, unrewritten: the pane text came off the peer's fake Herdr, not the
    // lead's — the lead has a pane of its own with different text, so a mix-up would show here.
    expect(bodyText).toContain("peer pane");
    expect(bodyText).not.toContain("lead pane");

    const conditional = await lead.api(path, { headers: { "if-none-match": etag! } });
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
  });

  test("a proxied read's headers describe the bytes it sent — encoding claimed ⟺ bytes gzipped", async () => {
    // THE REGRESSION THIS PINS. The lead used to copy the PEER's `content-encoding` onto a body the
    // runtime had already transparently decompressed, so the phone got `gzip` over plain JSON, its
    // `fetch` threw inflating it, the loader's catch degraded to a stale pane, and EVERY peer pane
    // rendered "(no recent output)". `curl` without `--compressed` ignores the header, which is why
    // every shell check looked green — so this test asks the way a browser asks, and decodes.
    //
    // The invariant is NOT "never an encoding": .adr/0023 has the lead compress this hop itself, so a
    // `content-encoding: gzip` here is now legitimate. What must hold is that the header and the bytes
    // agree — which is what the original bug violated, and what is asserted below in both directions.
    const peerId = peer.store()!.self.memberId;
    const url = `${lead.origin()}/api/pane/${encodeURIComponent(peer.paneId)}?host=${peerId}`;
    const auth = await lead.localAuth();
    // Read at the WIRE, via `node:http`: `fetch` inflates a gzip body for us and leaves the header
    // on, which is precisely the confusion that hid the original bug — under `fetch` a lying header
    // and an honest one are indistinguishable. `rawGet` decodes nothing.
    const res = await rawGet(url, { ...auth, "accept-encoding": "gzip, deflate, br" });
    expect(res.status).toBe(200);

    const gzipped = res.body[0] === 0x1f && res.body[1] === 0x8b;
    const claimed = res.headers["content-encoding"];
    expect(claimed === undefined || claimed === "gzip").toBe(true);
    expect(gzipped).toBe(claimed === "gzip");

    const text = new TextDecoder().decode(gzipped ? Bun.gunzipSync(res.body) : res.body);
    expect(text).toContain("peer pane");
    expect(() => {
      JSON.parse(text);
    }).not.toThrow();
    // Past `GZIP_MIN_BYTES`, so a body too small to be worth compressing is not what made this pass.
    expect(text.length).toBeGreaterThan(256);

    // Never the peer's pre-decompression length, and absent entirely on a transformed body.
    const length = res.headers["content-length"];
    if (length !== undefined) expect(Number(length)).toBe(res.body.byteLength);
    // The ETag is unaffected by any of this: it is the peer's hash of its pre-gzip body (§9.1) — the
    // identity representation, which is what both hops agree on (.adr/0023).
    expect(res.headers["etag"]).toBeDefined();

    // …and the win .adr/0023 exists for: this hop really was compressed for a phone that asked.
    expect(gzipped).toBe(true);
    expect(res.body.byteLength).toBeLessThan(text.length / 2);
  });

  test("the lead's own poll rate is unchanged by the crew it now leads", async () => {
    // The other half of §11's "no second timer". A lead that had armed a sweep timer of its own
    // would be polling its Herdr on one clock and its peers on another; instead the sweep is an
    // `onTick` of the SAME engine, so the local rate cannot have moved. Compared with a wide band,
    // because this measures a real machine and the assertion is "no extra clock", not "no jitter".
    const withCrew = await cadence(lead);
    expect(withCrew).toBeGreaterThan(soloCadence * 0.5);
    expect(withCrew).toBeLessThan(soloCadence * 2);
  }, 60_000);

  test("the lead performs no filesystem access for a peer's pane", () => {
    // The peer's uploads dir is the observable: a lead that served a peer pane locally would have
    // had to materialise something under its own state dir.
    expect(readdirSync(lead.stateDir).toSorted()).not.toContain("uploads");
  });
});

describe("walky talky across the crew (CREW_PROTOCOL §21)", () => {
  /** One operator message through an instance's phone route (`POST /api/walky`): the socket takes a send only from a pane. */
  async function operatorSend(at: Instance, body: Record<string, JsonValue>): Promise<JsonValue> {
    const res = await at.apiWrite("/api/walky", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    // SAFETY: the route answers JSON, and the assertions below read it field by field.
    return (await res.json()) as JsonValue;
  }

  /** One read request over an instance's walky socket, as the CLI sends it with no pane markers. */
  async function walky(at: Instance, request: Record<string, JsonValue>): Promise<JsonValue> {
    const answer = await askSocket(walkySocketPath(at.stateDir), `${JSON.stringify({ v: 1, markers: [], ...request })}\n`, 5000);
    expect(answer).not.toBeNull();
    // SAFETY: the bridge writes one JSON line, and the assertions below read it field by field.
    return JSON.parse(answer!) as JsonValue;
  }

  test("the lead lists the member's pane, routes both ways, and each side records how the sender was known", async () => {
    const leadId = lead.store()!.self.memberId;
    const peerId = peer.store()!.self.memberId;
    // The member's pane carries its instance token on the snapshot it serves the lead, so `who` there
    // names it `<member>/<pane>#<token>`.
    await waitFor(
      async () => JSON.stringify(await walky(lead, { op: "who" })).includes(`"${peerId}/${peer.paneId}#`),
      10_000,
      "the lead's who never listed the member's pane",
    );
    expect(await walky(peer, { op: "who" })).toMatchObject({ ok: true, note: expect.stringContaining("run `collie walky who` on the lead (") });

    // The lead to the member: signed by the lead, so the member verifies the origin too.
    const down = await operatorSend(lead, { id: "wt_crewdown0001", to: `${peerId}/${peer.paneId}`, body: "from the lead" });
    expect(down).toMatchObject({ receipt: { state: "accepted", target: `${peerId}/${peer.paneId}`, by: peerId, verified: "origin" } });
    expect(await walky(peer, { op: "status", id: "wt_crewdown0001" })).toMatchObject({ ok: true, receipts: [{ target: `${peerId}/${peer.paneId}`, verified: "origin" }] });

    // The member to the lead, from the member's agent pane over its socket (a member takes no phone:
    // its listener admits only the lead). The lead checks the member's signature and writes `origin`.
    const marker = { namespace: "herdr", scope: peer.socketPath, pane: peer.paneId, schemaVersion: 1, harness: "claude" };
    const target = `${leadId}/${lead.paneId}`;
    const up = await walky(peer, { op: "send", id: "wt_crewup000001", to: target, body: "from the member", replyTo: null, markers: [marker] });
    expect(up).toMatchObject({ ok: true, receipts: [{ state: "accepted", target, by: leadId }] });
    expect(await walky(lead, { op: "status", id: "wt_crewup000001" })).toMatchObject({ ok: true, receipts: [{ target, verified: "origin" }] });
    // Once the lead's own pane settles, the lead pushes that outcome back (§21, added 2026-10-18): the
    // member's copy leaves `accepted` and reads what the lead wrote, and nothing is left "on the lead".
    const onLead = async (): Promise<WalkyReceipt[]> => readReceiptsAnswer(await walky(lead, { op: "status", id: "wt_crewup000001" }));
    const onMember = async (): Promise<JsonValue> => walky(peer, { op: "status", id: "wt_crewup000001" });
    await waitFor(
      async () => {
        const [held] = await onLead();
        const [own] = readReceiptsAnswer(await onMember());
        return held !== undefined && held.state !== "accepted" && own?.state === held.state;
      },
      20_000,
      async () => `the lead holds ${JSON.stringify(await onLead())}, the member ${JSON.stringify(await onMember())}`,
    );
    expect(await onMember()).toMatchObject({ ok: true, receipts: [{ target, by: leadId }], elsewhere: [] });
  }, 60_000);

  test("the lead's who names the member's pane with its instance token, and a send to that address lands", async () => {
    const peerId = peer.store()!.self.memberId;
    const bare = `${peerId}/${peer.paneId}`;
    let address: string | null = null;
    await waitFor(
      async () => {
        const who = await walky(lead, { op: "who" });
        const targets = asJsonObject(who)?.targets;
        const listed = Array.isArray(targets) ? targets.map((row) => asJsonString(asJsonObject(row)?.address)).find((a) => a?.startsWith(`${bare}#`) === true) : undefined;
        address = listed ?? null;
        return address !== null;
      },
      10_000,
      "the lead's who never listed the member's pane with a token",
    );
    expect(address!.slice(bare.length)).toMatch(/^#[a-z0-9]{4}$/u);
    // The receipt names the pane id only, on both machines; the message keeps the token it was sent to.
    const sent = await operatorSend(lead, { id: "wt_crewtoken001", to: address!, body: "to the instance" });
    expect(sent).toMatchObject({ receipt: { target: bare, by: peerId } });
    const state = asJsonString(asJsonObject(asJsonObject(sent)?.receipt)?.state);
    expect(["accepted", "delivered", "inbox-only"]).toContain(state);
    expect(await walky(peer, { op: "status", id: "wt_crewtoken001" })).toMatchObject({ ok: true, receipts: [{ target: bare }], message: { to: address! } });
    // Another token at that pane id is a pane that closed and gave its id away: refused, nothing typed.
    const other = address!.endsWith("#zzzz") ? `${bare}#yyyy` : `${bare}#zzzz`;
    expect(await operatorSend(lead, { id: "wt_crewtoken002", to: other, body: "to a gone instance" })).toMatchObject({ receipt: { state: "refused", reason: "pane replaced", target: bare, by: peerId } });
  }, 60_000);
});

// ── Failure modes ────────────────────────────────────────────────────────────

describe("a peer that is not there", () => {
  test("a write to a downed peer is refused, not silently retried", async () => {
    await peer.stop();
    try {
      const peerId = peer.store()!.self.memberId;
      // A write needs a real pairing token (the local secret is read-level only), so this one is
      // refused by the DOWNED PEER and not by the gate in front of it.
      const res = await lead.apiWrite(
        `/api/pane/${encodeURIComponent(peer.paneId)}/reply?host=${peerId}`,
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
      const res = await lead.api(`/api/snapshot`);
      expect(res.status).toBe(200);
      await waitFor(
        async () => {
          const snap = await snapshotOf(lead);
          return (snap.servers ?? []).some((s) => s.id !== lead.store()!.self.memberId && !s.reachable);
        },
        10_000,
        async () =>
          `the lead never marked the downed peer degraded (last: ${JSON.stringify(
            (await snapshotOf(lead)).servers,
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
    secret: () => from.crew!.secret,
    timeoutMs,
    patientTimeoutMs,
    fetch: crewFetch,
    // The SHIPPED pin, built the way bridge/index.ts builds it — including the fresh object per
    // dial, which is the thing that could plausibly have defeated connection reuse.
    tls: () => dialTls(from, { certPem: to.self.certPem }) ?? undefined,
  });
}

describe("a cold handshake priced above the budget", () => {
  test("Bun's fetch REUSES a pinned-TLS connection, even with a fresh `tls` object per dial", async () => {
    const proxy = startLatencyProxy(peer.port, 0);
    const link: CrewLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
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
    const link: CrewLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
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
    const link: CrewLink = { memberId: peer.store()!.self.memberId, address: `127.0.0.1:${proxy.port}` };
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
    // a real leave would tear the crew down mid-suite.
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
    expect(canonicalRequest("post", CREW_LEAVE_PATH, bodyDigest("{}"), 17)).toBe(
      `POST\n${CREW_LEAVE_PATH}\n${bodyDigest("{}")}\n17`,
    );
  });
});

// ── §8.1: a two-anchored peer, end to end ────────────────────────────────────

describe("a two-anchored peer resolves its caller by signature (§8.1, 2026-08-20)", () => {
  // The closure for the reach a second TLS anchor would otherwise buy, exercised over a REAL pinned
  // handshake against a REAL child bridge: the anchor is written to the peer's disk, the peer is
  // restarted (the only thing that re-pins a `ca` list), and the same three dials are made that a
  // healthy lead, an old build and a compromised deputy would each make.
  const deputy = mintIdentity({ commonName: "collie-deputy", sans: ["127.0.0.1"] });
  let restored = false;

  /** Write a warrant `desk` really signed, naming `deputy`, into the PEER's store. */
  function anchorDeputy(): void {
    const leadData = lead.store()!;
    const peerData = peer.store()!;
    const unsigned = {
      crewId: peerData.crew!.crewId,
      generation: 1,
      deputyMemberId: "deputy",
      deputyFingerprint: deputy.fingerprint,
      leadMemberId: leadData.self.memberId,
      issuedAt: Date.now(),
      refreshedAt: Date.now(),
    };
    const signature = signCanonical(leadData.self.keyPem, canonicalWarrant({ ...unsigned, signature: "" }));
    const next: TrustStoreData = {
      ...peerData,
      warrant: { warrant: { ...unsigned, signature }, deputyCertPem: deputy.certPem },
    };
    writeFileSync(join(peer.stateDir, TRUST_STORE_FILENAME), serializeTrustStore(next), { mode: 0o600 });
  }

  /** Dial the peer presenting `identity`'s certificate, optionally attesting the dial with its key. */
  function dialAs(identity: { certPem: string; keyPem: string }, attest: boolean, path = CREW_HELLO_PATH) {
    const from = lead.store()!;
    const to = peer.store()!;
    const timestamp = Date.now();
    const sent = new Headers({
      authorization: `Bearer ${from.crew!.secret}`,
      "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
      "x-crew-member": from.self.memberId,
    });
    // The unattested case is provably the SAME request minus two headers — which is exactly the
    // difference the gate is supposed to turn on.
    if (attest) {
      sent.set(TIMESTAMP_HEADER, String(timestamp));
      sent.set(DIAL_HEADER, signDial(identity.keyPem, { method: "GET", path, timestamp, to: to.self.memberId }));
    }
    return crewFetch(`https://127.0.0.1:${peer.port}${path}`, {
      headers: sent,
      tls: {
        cert: identity.certPem,
        key: identity.keyPem,
        ca: [to.self.certPem],
        checkServerIdentity: () => undefined,
      },
    });
  }

  beforeAll(async () => {
    anchorDeputy();
    // The anchor exists at bind time or not at all — `server.reload({tls})` does not swap a `ca`.
    await peer.restart();
  });

  afterAll(async () => {
    if (restored) return;
    restored = true;
    const peerData = peer.store()!;
    const { warrant: _dropped, ...withoutWarrant } = peerData;
    writeFileSync(join(peer.stateDir, TRUST_STORE_FILENAME), serializeTrustStore(withoutWarrant), { mode: 0o600 });
    await peer.restart();
  });

  test("the listener really carries TWO anchors now, and the deputy's handshake completes", async () => {
    const tls = peerListenerTls("peer", peer.store());
    expect(tls!.ca).toEqual([lead.store()!.self.certPem, deputy.certPem]);
    // The handshake is what the anchor buys. It answers — with a refusal, which is the next test.
    const res = await dialAs(deputy, true);
    expect(res.status).toBe(401);
  });

  test("the LEAD's own dial is admitted, because the shipped client attests every one", async () => {
    const res = await dialAs(lead.store()!.self, true);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ protocol: CREW_PROTOCOL_VERSION, member: peer.store()!.self.memberId });
  });

  test("an UNATTESTED dial is refused, even from the lead's own certificate", async () => {
    // This is the byte that closes the finding: the transport boolean no longer resolves to the lead,
    // so a caller that will not say who it is gets the uniform 401 — and so would a deputy.
    const res = await dialAs(lead.store()!.self, false);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  test("the DEPUTY reaches nothing: every route this build serves answers 401", async () => {
    for (const path of [CREW_HELLO_PATH, CREW_SNAPSHOT_PATH, `${CREW_PREFIX}pane/w1:p1`]) {
      const res = await dialAs(deputy, true, path);
      expect(res.status).toBe(401);
    }
  });

  test("and the merged snapshot still shows the peer — the real lead was never locked out", async () => {
    await waitFor(
      async () => ((await snapshotOf(lead)).servers ?? []).some((s) => s.id === peer.store()!.self.memberId && s.reachable),
      15_000,
      "the lead lost its own peer after the second anchor went up",
    );
  });
});

// ── Rotation, promotion, leave ───────────────────────────────────────────────

// ── §0: one wire version, against a real listener ───────────────────────────
// The unit tests translate a `Request` in memory; this one goes over the real pinned handshake to a
// real child bridge. 1.8.0's second prefix is gone (1.9.0, ADR 0039), so there is one prefix and one
// vocabulary, and the old header names reach nothing.
describe("the wire speaks version 2, and only version 2 (§0)", () => {
  test("a version 2 dial is answered in version 2's shapes", async () => {
    const res = await dialAsLead(CREW_HELLO_PATH, {});
    expect(res.status).toBe(200);
    expect(res.headers.get("x-crew-protocol")).toBe(String(CREW_PROTOCOL_VERSION));
    expect(res.headers.get(`x-${"pack"}-protocol`)).toBeNull();
    expect(await res.json()).toMatchObject({ protocol: CREW_PROTOCOL_VERSION });
  });

  // 1.7.0's prefix is not a crew path any more. The front door owns it, so the crew router declines
  // it and nothing answers a crew shape there.
  test("1.7.0's prefix is not answered by the crew listener at all", async () => {
    const res = await dialAsLead(`/${"pack"}/v1/hello`, {});
    expect(res.headers.get("x-crew-protocol")).toBeNull();
    expect(res.headers.get(`x-${"pack"}-protocol`)).toBeNull();
  });
});

describe("rotation", () => {
  test("the lead rotates, dials with the superseded secret, and records the pickup", async () => {
    const before = lead.store()!.crew!.secretGeneration;
    const rotated = await verb(lead, (d) => cmdCrewRotate(d));
    expect(rotated.code).toBe(EXIT.OK);
    const after = lead.store()!;
    expect(after.crew!.secretGeneration).toBe(before + 1);
    // markSecretDelivered ran: the peer is not behind, so it is not dropped to `unenrolled`.
    expect(after.peers[0]!.secretGeneration).toBe(after.crew!.secretGeneration);
    expect(after.peers[0]!.status).toBe("enrolled");
    expect(rotated.out).toContain(`picked up generation ${after.crew!.secretGeneration}`);
    // …and the peer adopted it, on its own disk.
    expect(peer.store()!.crew!.secret).toBe(after.crew!.secret);
  }, 60_000);

  test("the crew still works on the new secret", async () => {
    const res = await dialAsLead(CREW_HELLO_PATH, {});
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
    const approved = await verb(lead, (d) => cmdCrewApprovePromote(d, [peerId]));
    expect(approved.code).toBe(EXIT.OK);
    expect(lead.store()!.pendingHandover).toMatchObject({ memberId: peerId });

    const promoted = await verb(peer, (d) => cmdPromote(d, ["--address", `127.0.0.1:${peer.port}`]));
    expect(promoted.code).toBe(EXIT.OK);
    expect(promoted.out).toContain("stepped down");

    // The crown moved on both disks, and the crew identity did NOT change (§14: a role change).
    const newLead = peer.store()!;
    const demoted = lead.store()!;
    expect(newLead.lead).toBeNull();
    expect(newLead.peers.map((p) => p.memberId)).toEqual([oldLeadId]);
    expect(demoted.lead?.memberId).toBe(newLead.self.memberId);
    expect(demoted.peers).toEqual([]);
    expect(newLead.crew!.crewId).toBe(demoted.crew!.crewId);
    expect(newLead.crew!.secret).toBe(demoted.crew!.secret);
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
    // then `collie unserve` for that machine, its own `crew status` reports a peer on disk and a lead
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
    // Locally: no crew, no pins, no secret — but the identity survives (§8.4).
    const after = lead.store()!;
    expect(after.crew).toBeNull();
    expect(after.lead).toBeNull();
    expect(after.self.certPem).toContain("BEGIN CERTIFICATE");
    // Remotely: the signed `leave` was admitted on the new lead's unpinned surface and applied.
    expect(peer.store()!.peers).toEqual([]);
  }, 60_000);

  test("both machines are back to a solo route table", async () => {
    const status = await verb(peer, (d) => cmdCrewStatus(d, ["--no-probe"]));
    expect(status.code).toBe(EXIT.OK);
    // The peer still holds a crew of its own (it leads nobody), so this asserts the roster, not mode.
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
// Two facts about Bun 1.3.14 underwrite the ENTIRE application-layer half of the crew's first factor:
//   1. `Bun.serve` verifies a pinned client certificate at the handshake but exposes NO per-request
//      accessor for the certificate that was presented. That is why identity is attested to the
//      admission gate as a boolean (`transportPinned`, bridge/crew/transport.ts) instead of read, and
//      why peer→lead requests must re-establish the second factor with a signature (§8.6, signing.ts).
//   2. `server.reload({ tls })` does NOT swap the enforced `ca`. That is why there is no live re-pin and
//      why every membership verb restarts the bridge to change its anchors (`applyLocally`, cli/crew.ts).
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
      const res = await crewFetch(`https://127.0.0.1:${server.port}/`, {
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
        expect(value, `${name} must stay absent — see transport.ts / signing.ts / CREW_PROTOCOL §8.6`).toBeUndefined();
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
      crewFetch(`https://127.0.0.1:${server.port}/`, {
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
      // restart to re-pin" workaround (transport.ts, and the membership-verb restart in cli/crew.ts).
      await expect(
        dial(added),
        "reload re-pinned live — revisit transport.ts's no-live-re-pin and CREW_PROTOCOL §8.6",
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
  return crewFetch(`https://127.0.0.1:${peer.port}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${secret ?? from.crew!.secret}`,
      "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
      "x-crew-member": from.self.memberId,
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
 * Sent to `hello` rather than `leave` so a passing test does not dismantle the crew; the admission
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
    path: CREW_HELLO_PATH,
    body: opts.signBody ?? "",
    timestamp,
  });
  const signature = opts.corruptSignature === true ? flipBase64(signed) : signed;
  return fetch(`http://127.0.0.1:${lead.port}${CREW_HELLO_PATH}`, {
    headers: {
      authorization: `Bearer ${from.crew!.secret}`,
      "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
      "x-crew-member": from.self.memberId,
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

/**
 * How many poll calls per second an instance makes to its own Herdr, measured over a two-second window.
 *
 * `worktree.list` is not counted: the Herdr adapter asks it once per workspace (the repo lookup,
 * cached afterwards), so a window that happens to hold the first lookup would read as double the
 * rate. It is a one-off, not a clock.
 */
async function cadence(instance: Instance): Promise<number> {
  const polls = () => instance.herdr!.calls.filter((method) => method !== "worktree.list").length;
  const before = polls();
  await Bun.sleep(2000);
  return (polls() - before) / 2;
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

/**
 * Poll `predicate` until it holds or the budget runs out. Every wait in this file goes through it.
 *
 * `message` is ALWAYS a thunk, never `string | thunk`. It was both until 2026-10-01, narrowed with a
 * `typeof`, which the repo's lint forbids outside an I/O boundary — and it was right to: a union of
 * a value and a function that produces it is two shapes for one idea, and the reason below applies
 * to every caller anyway. A caller with a fixed sentence writes `() => "…"`.
 */
async function waitFor(
  predicate: () => Promise<boolean>,
  budgetMs: number,
  message: () => string | Promise<string>,
): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(100);
  }
  // The message is LAZY by option: a diagnostic that fetches state must fetch it at the moment of
  // failure, not at the moment the wait was set up — an eagerly-built one describes t=0 and lies.
  const detail = await message();
  throw new Error(`timed out after ${budgetMs}ms: ${detail}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// THE STANDBY DOOR AND THE TAKEOVER, END TO END (RFC §6, §7, §9).
//
// Three REAL child bridges — a lead, a deputy and a witness — enrolled through the real enrollment
// path, over real pinned mutual TLS. The whole loop, with nothing about it faked:
//
//   deputize → the warrant and the ROSTER ride the lead's own sweep → the pairing registry syncs to
//   the deputy and to nobody else → kill the lead → the door ARMS on silence → the phone confirms
//   with its pairing bearer → the deputy asks the dead lead, then asks the witness → the witness
//   re-pins → the deputy restarts as the lead and serves the front door → the old lead boots, its
//   boot gate finds the conflict, and it self-heals to a peer of the machine that deposed it.
//
// It is its OWN crew, on its own ports, so it neither depends on nor disturbs the two instances the
// rest of this file drives.
// ─────────────────────────────────────────────────────────────────────────────

describe("the standby door and the takeover (RFC §6/§7/§9)", () => {
  /**
   * Short enough to test, still above the harness's 1 s idle poll — the rule the formula encodes.
   *
   * The DEPUTY's threshold is deliberately the longer of the two, and that is not a test convenience:
   * both machines start counting from the same instant (the lead's last sweep), so a witness whose
   * threshold matched the deputy's would answer `lead_is_alive` or `silent` depending on which of two
   * near-simultaneous clocks fired first. RFC §14.2 names this race for the proxy's health check and
   * the arming threshold; it is the same race one layer in, and the same answer applies — the machine
   * that ACTS waits longer than the machines it asks.
   */
  const DEPUTY_ARM_MS = "3000";
  const WITNESS_ARM_MS = "1000";
  const TOKEN = "phone-token-for-the-takeover-test";
  /** A second credential, paired and then revoked — the drill's `drill` device. */
  const REVOKED_TOKEN = "drill-token-that-gets-revoked";

  let hq: Instance;
  let aide: Instance;
  let witness: Instance;
  let standbyPort = 0;

  const idOf = (i: Instance): string => i.store()!.self.memberId;
  /** The device labels this machine's SYNCED registry holds. `[]` for a file that is not there. */
  const syncedLabels = (i: Instance): string[] => {
    try {
      return parseStandbyDevices(readFileSync(join(i.stateDir, "standby-devices.json"), "utf8"))?.devices.map((d) => d.label) ?? [];
    } catch {
      return [];
    }
  };
  /** The marker THAT PROCESS wrote — the only honest source for "what did this listener come up with". */
  const runtimeMarkerOf = (i: Instance) => {
    try {
      return parseMarker(readFileSync(crewRuntimePath(i.stateDir), "utf8"));
    } catch {
      return null;
    }
  };
  const standby = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${standbyPort}${path}`, init);
  /**
   * `GET /crew/v1/hello` at a peer, dialled as the LEAD does it — the exact bytes the lead's own
   * `crew status` reads its answers off. Two factors: the lead's certificate at the handshake and the
   * crew secret in the header.
   */
  async function helloAt(
    target: Instance,
  ): Promise<{ warrantGeneration: number | null; warrantActiveGeneration: number | null }> {
    const from = hq.store()!;
    const to = target.store()!;
    const res = await crewFetch(`https://127.0.0.1:${target.port}${CREW_HELLO_PATH}`, {
      headers: {
        authorization: `Bearer ${from.crew!.secret}`,
        "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
        "x-crew-member": from.self.memberId,
      },
      tls: {
        cert: from.self.certPem,
        key: from.self.keyPem,
        ca: [to.self.certPem],
        checkServerIdentity: () => undefined,
      },
    });
    expect(res.status).toBe(200);
    // SAFETY: `Response.json()` yields exactly a JsonValue — the wire is JSON by definition — and both
    // readers below are the SHIPPED ones, so this asserts against the parse the lead really performs
    // rather than a second one written here.
    const body = (await res.json()) as JsonValue;
    return {
      warrantGeneration: parseWarrantReport(body)?.generation ?? null,
      warrantActiveGeneration: parseWarrantActiveReport(body),
    };
  }

  /** Enrol `peer` into `lead`'s crew through the real invite/join exchange. */
  async function enrol(leadInstance: Instance, peerInstance: Instance): Promise<void> {
    const invited = await verb(leadInstance, (d) => cmdCrewInvite(d, ["--label", peerInstance.name]));
    expect(invited.code).toBe(EXIT.OK);
    const token = invited.out.split("\n")[0]!.trim();
    // `--insecure` for the reason the first enrollment above gives: this harness enrolls over
    // loopback `http://`, which is exactly the "genuinely trusted hop" that flag exists for.
    const joined = await verb(peerInstance, (d) =>
      cmdJoin(d, [
        `http://127.0.0.1:${leadInstance.port}`,
        token,
        "--insecure",
        "--address",
        `127.0.0.1:${peerInstance.port}`,
      ]),
    );
    expect(joined.err).not.toContain("certificate minting is not wired");
    expect(joined.code).toBe(EXIT.OK);
    // Nothing restarts the LEAD after an enrollment lands (§8.2's note) — that restart is the
    // operator's, and here it is the harness's.
    await leadInstance.restart();
  }

  beforeAll(async () => {
    standbyPort = await freePort();
    hq = new Instance("hq", "w1:p1", "hq pane\n");
    aide = new Instance("aide", "w1:p2", "aide pane\n", {
      COLLIE_STANDBY_PORT: String(standbyPort),
      COLLIE_STANDBY_HOST: "127.0.0.1",
      COLLIE_STANDBY_ARM_MS: DEPUTY_ARM_MS,
    });
    witness = new Instance("nas", "w1:p3", "nas pane\n", { COLLIE_STANDBY_ARM_MS: WITNESS_ARM_MS });
    for (const i of [hq, aide, witness]) i.startHerdr();
    await Promise.all([hq.start(), aide.start(), witness.start()]);
    await enrol(hq, aide);
    await enrol(hq, witness);
  }, 120_000);

  afterAll(async () => {
    if (process.env.COLLIE_HARNESS_DEBUG === "1") {
      for (const i of [hq, aide, witness]) console.log(`\n──── ${i?.name} ────\n${i?.log}`);
    }
    await Promise.all([hq?.stop(), aide?.stop(), witness?.stop()]);
    for (const i of [hq, aide, witness]) i?.herdr?.stop();
  });

  test("the warrant and the ROSTER ride the lead's own sweep to the deputy (RFC §7.4)", async () => {
    // The operator's designation, minted through the shipped transition and left on the lead's disk
    // exactly as `collie crew deputy` leaves it. What this test is about is what happens NEXT, with
    // no verb and no second timer: the sweep the lead already runs carries it.
    const data = hq.store()!;
    const change = mintWarrant(data, idOf(aide), Date.now());
    expect(change).not.toBeNull();
    writeFileSync(join(hq.stateDir, TRUST_STORE_FILENAME), serializeTrustStore(change!.next), { mode: 0o600 });
    await hq.restart();

    await waitFor(async () => aide.store()?.warrant != null, 20_000, "the deputy never received its warrant");
    const deputyStore = aide.store()!;
    expect(deputyStore.warrant!.warrant.deputyMemberId).toBe(idOf(aide));
    // The certificate, so the transport could anchor it — and the ROSTER, so this machine can lead a
    // crew it has never dialled. Both ride the one push.
    expect(deputyStore.warrant!.deputyCertPem).toContain("BEGIN CERTIFICATE");
    expect(deputyStore.standbyRoster?.map((r) => r.memberId).toSorted()).toEqual([idOf(aide), idOf(witness)].toSorted());

    // …and the WITNESS gets the warrant without the roster: a peer never holds pins for machines it
    // must never dial (§4).
    await waitFor(async () => witness.store()?.warrant != null, 20_000, "the witness never received the warrant");
    expect(witness.store()!.standbyRoster).toBeUndefined();
  }, 60_000);

  test("the pairing registry syncs to the DEPUTY and to nobody else (RFC §6.5)", async () => {
    // The registry `collie pair` writes, written directly — the subject here is the sync, not the
    // claim exchange, and the file is the same one either way.
    writeFileSync(
      join(hq.stateDir, "paired-devices.json"),
      JSON.stringify({ devices: [{ label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: 1, lastSeenAt: 1 }] }),
      { mode: 0o600 },
    );
    // The DEVICE, not merely the file: an empty registry is itself something the lead syncs (a
    // `devices revoke` has to be able to REMOVE one over there), so the file alone proves nothing.
    await waitFor(
      async () => syncedLabels(aide).includes("phone"),
      20_000,
      async () => `the deputy never received the pairing registry (holds ${JSON.stringify(syncedLabels(aide))})`,
    );
    const synced = parseStandbyDevices(readFileSync(join(aide.stateDir, "standby-devices.json"), "utf8"))!;
    expect(synced.devices.map((d) => d.label)).toEqual(["phone"]);
    // ONLY HASHES CROSS: the token was shown once, at claim time, and is not recoverable.
    expect(readFileSync(join(aide.stateDir, "standby-devices.json"), "utf8")).not.toContain(TOKEN);
    // …and it is NOT merged into the deputy's own registry, which would arm its own write gate for
    // an operator who never ran `collie pair` here (RFC §16, decision 5).
    expect(existsSync(join(aide.stateDir, "paired-devices.json"))).toBe(false);
    // The witness is not the deputy and gets none of it.
    expect(existsSync(join(witness.stateDir, "standby-devices.json"))).toBe(false);
  }, 60_000);

  // ── THE LIVE DRILL, THE REVOCATION ─────────────────────────────────────────
  // `collie devices revoke` on the lead reported success and the phone lost write access there — and
  // 35 seconds later the deputy's copy still listed the revoked device, so the credential was still
  // takeover-capable at the standby door. A revoked credential must die EVERYWHERE.
  test("a device revoked on the lead leaves the deputy's copy, with no verb and no restart", async () => {
    // Two paired devices, both synced. `collie pair` is a claim exchange the phone drives; the file
    // it writes is the subject here, and it is the same file either way.
    writeFileSync(
      join(hq.stateDir, "paired-devices.json"),
      JSON.stringify({
        devices: [
          { label: "phone", tokenHash: sha256Hex(TOKEN), createdAt: 1, lastSeenAt: 1 },
          { label: "drill", tokenHash: sha256Hex(REVOKED_TOKEN), createdAt: 2, lastSeenAt: 2 },
        ],
      }),
      { mode: 0o600 },
    );
    await waitFor(
      async () => syncedLabels(aide).includes("drill"),
      30_000,
      async () => `the deputy never received the second device (holds ${JSON.stringify(syncedLabels(aide))})`,
    );

    // THE DRILL'S SHAPE: the deputy is a machine that has paired devices OF ITS OWN under the same
    // labels. That is not exotic — it is every former lead, and every machine whose operator paired
    // the same phone. Written before the revoke so the sync must cope with it.
    writeFileSync(
      join(aide.stateDir, "paired-devices.json"),
      JSON.stringify({ devices: [{ label: "phone", tokenHash: sha256Hex("aide-own"), createdAt: 3, lastSeenAt: 3 }] }),
      { mode: 0o600 },
    );

    // THE REAL VERB, on the real file — the path the drill ran.
    const revoked = await verb(hq, async (d) =>
      cmdDevicesRevoke({ ctx: d.ctx, io: d.io, files: d.files, exec: d.exec }, ["drill"]),
    );
    expect(revoked.code).toBe(EXIT.OK);
    expect(revoked.out).toContain('revoked "drill"');

    // THE FIX, ASSERTED: the deputy's copy loses it, even though a label collides. The sync never
    // touches the deputy's OWN registry — it replaces `standby-devices.json`, which is what the door
    // checks — so refusing it protected nothing and froze a revoked credential in place.
    await waitFor(
      async () => !syncedLabels(aide).includes("drill"),
      30_000,
      async () => `the deputy still holds the revoked device (holds ${JSON.stringify(syncedLabels(aide))})`,
    );
    // …and the one that was NOT revoked is still there, so this was a replacement and not a wipe.
    expect(syncedLabels(aide)).toEqual(["phone"]);

    // DECISION 6 IS INTACT: the collision is REPORTED — on the exchange, every sweep, so it is
    // visible while it is true — and it reaches the LEAD's own `crew status` surface, the machine
    // whose operator can rename the device. What it refuses is the ADOPTION (the takeover), which is
    // where entries actually enter a registry under a name.
    await waitFor(
      async () => (runtimeMarkerOf(hq)?.pairingCollision?.labels ?? []).includes("phone"),
      30_000,
      async () =>
        `the lead never reported the collision (marker=${JSON.stringify(runtimeMarkerOf(hq)?.pairingCollision)}` +
        ` deputySynced=${JSON.stringify(syncedLabels(aide))})`,
    );

    // Cleared for the rest of this file: the takeover below must be able to ADOPT, and a live
    // collision correctly refuses it. Removing the deputy's own registry is the operator's "revoke it
    // here" remedy, performed by the harness.
    rmSync(join(aide.stateDir, "paired-devices.json"));
    await waitFor(
      async () => runtimeMarkerOf(hq)?.pairingCollision == null,
      30_000,
      "the lead never cleared the collision finding after the operator resolved it",
    );
  }, 120_000);

  test("the anchor exists at bind time or not at all — both peers restart (RFC §5, phase 2)", async () => {
    await aide.restart();
    await witness.restart();
    // The witness now carries TWO anchors: its lead's, and the deputy's. That is what makes the
    // takeover exchange reachable at all — and it is a transport fact, not a route.
    const tls = peerListenerTls("peer", witness.store());
    expect(tls!.ca).toHaveLength(2);
    expect(tls!.ca[1]).toBe(aide.store()!.self.certPem);
  }, 60_000);

  // ── THE LIVE DRILL, BUG 3 ──────────────────────────────────────────────────
  // A deputy that had stored a verified warrant and then restarted cleanly still reported "stored,
  // NOT anchored" — forever, through any number of restarts. Reproduced here against REAL child
  // bridges: the marker each process writes is the only honest source for "what did this listener
  // come up with", so this asserts what those processes actually wrote, and then the sentence the
  // operator would have read.
  test("a warrant stored BEFORE a restart is reported as activated afterwards — both roles", async () => {
    const generation = aide.store()!.warrant!.warrant.generation;
    // The DEPUTY: it anchors NOTHING (a collie does not anchor its own certificate), so the old
    // derivation could never report it. What its restart activated is its deputy role.
    await waitFor(
      async () => runtimeMarkerOf(aide)?.anchoredGeneration === generation,
      20_000,
      async () => `deputy marker: ${JSON.stringify(runtimeMarkerOf(aide))}`,
    );
    const deputyLines = peerWarrantLines(aide.store()!, runtimeMarkerOf(aide), Date.now(), null)
      .map((l) => l.text)
      .join("\n");
    expect(deputyLines).toContain("deputy role ACTIVE at this boot");
    expect(deputyLines).not.toContain("NOT anchored");

    // The WITNESS: it really did build a second anchor, and says so in the other word.
    await waitFor(
      async () => runtimeMarkerOf(witness)?.anchoredGeneration === generation,
      20_000,
      async () => `witness marker: ${JSON.stringify(runtimeMarkerOf(witness))}`,
    );
    const witnessLines = peerWarrantLines(witness.store()!, runtimeMarkerOf(witness), Date.now(), null)
      .map((l) => l.text)
      .join("\n");
    expect(witnessLines).toContain("anchored at this boot");
  }, 60_000);

  // ── THE LIVE DRILL, BUG 5 (§18.17) ─────────────────────────────────────────
  // The two surfaces above are the deputy's own. The LEAD's said the opposite about the same machine
  // at the same minute — `warrant stored, anchor INACTIVE — restart <member>` — because its only
  // evidence was `crew-ops.json`, which moves when `crew deputy`'s restart leg completes and never
  // otherwise. Nothing restarted these machines through that verb, and they are armed; so this reads
  // the wire the lead actually reads, and then the sentence the operator would have got.
  test("the LEAD hears the activation over the wire, and stops asking for a restart", async () => {
    const generation = aide.store()!.warrant!.warrant.generation;
    const hello = await helloAt(aide);
    expect(hello.warrantGeneration).toBe(generation);
    expect(hello.warrantActiveGeneration).toBe(generation);

    // The lead's own renderer, with NO ops record — the drill's exact state, and the one that used to
    // print the impossible sentence.
    const rendered = memberWarrantLines(hq.store()!, hello.warrantGeneration, null, idOf(aide), hello.warrantActiveGeneration)
      .map((l) => l.text)
      .join("\n");
    expect(rendered).toContain("its deputy role is ACTIVE");
    expect(rendered).not.toContain("anchor INACTIVE");
    expect(rendered).not.toContain("a takeover from there is impossible");
  }, 60_000);

  // ── THE LIVE DRILL, BUG 4 ──────────────────────────────────────────────────
  // The lead used to remember what it had pushed in a process-local field, and `crew deputy` restarts
  // the local bridge as its last step — so the process that knew it still owed a sync was replaced by
  // one that had never offered it, and nothing ever asked the deputy. Now the deputy answers for
  // itself on an exchange that already happens, so this is provable: delete its copy, restart the
  // LEAD too, and the crew must converge with no verb and no operator step.
  test("the pairing sync survives a restart on either side — the deputy's own report drives it", async () => {
    rmSync(join(aide.stateDir, "standby-devices.json"));
    await aide.restart();
    await hq.restart();
    await waitFor(
      async () => syncedLabels(aide).includes("phone"),
      30_000,
      async () => `the deputy never got its registry back (holds ${JSON.stringify(syncedLabels(aide))})`,
    );
  }, 90_000);

  test("while the lead is alive the door is COLD: 503 on health, a page with no button", async () => {
    const health = await standby("/standby/health");
    expect(health.status).toBe(503);
    // standby answers the version: even cold, and even at 503 — the updater's health gate reads this
    // port on a peer, whose main port is behind mutual TLS (M15/05). The state word is unchanged.
    expect(health.headers.get("x-collie-version")).toMatch(/^\d+\.\d+\.\d+/);
    expect(await health.json()).toMatchObject({ state: "cold" });

    const page = await standby("/standby");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("Standby");
    expect(html).not.toContain("<button");
    // A confirm is refused with the reason, and the credential is never even consulted.
    const refused = await standby("/standby/takeover", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(refused.status).toBe(409);
  }, 30_000);

  test("the LEAD answers its own /standby/health with 200 — the proxy's primary check (RFC §14.2)", async () => {
    const res = await fetch(`${hq.origin()}/standby/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "leading" });
  });

  test("kill the lead, and the door ARMS on silence alone", async () => {
    await hq.stop();
    await waitFor(async () => (await standby("/standby/health")).status === 200, 20_000, "the door never armed");
    expect(await (await standby("/standby/health")).json()).toMatchObject({ state: "armed" });

    const html = await (await standby("/standby")).text();
    expect(html).toContain("Take over");
    expect(html).toContain(`has not called this machine for`);
    expect(html).toContain(`<button id="go" type="button">Take over</button>`);
    // One witness exists, so the page says who will be asked rather than the two-machine warning.
    expect(html).toContain("ask 1 other machine whether it has called");
  }, 60_000);

  test("the confirm is PAIRING ONLY — no bearer, a wrong bearer and a device header all refuse", async () => {
    const rejected: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong" },
      { "x-tailnet-device": "phone" },
      // ── THE LIVE DRILL, THE REVOCATION ──────────────────────────────────────
      // The credential revoked on the lead while it was still alive. It must be dead HERE too, at the
      // one door that can hand this machine the whole crew — and it is dead because the sync replaced
      // this deputy's copy rather than being refused on a label collision.
      { authorization: `Bearer ${REVOKED_TOKEN}` },
    ];
    for (const headers of rejected) {
      const res = await standby("/standby/takeover", { method: "POST", headers });
      expect(res.status).toBe(401);
    }
    // …and the credential that was NOT revoked is still good, so this was a revocation and not an
    // outage: the door still knows the surviving device. (Asserted without spending it — the takeover
    // below is where that token is used for real.)
    expect(syncedLabels(aide)).toEqual(["phone"]);
    // Nothing moved: the witness still follows the old lead.
    expect(witness.store()!.lead!.memberId).toBe(idOf(hq));
  }, 30_000);

  test("the takeover: the witness re-pins, and the deputy commits LAST", async () => {
    const aideId = idOf(aide);
    const hqId = idOf(hq);
    const res = await standby("/standby/takeover", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // Asserted WITH the body: every refusal here is a sentence, and a bare status would hide the one
    // fact a failure needs (which of RFC §7's steps said no).
    const answer = await res.json();
    expect({ status: res.status, answer }).toMatchObject({
      status: 200,
      answer: { ok: true, message: expect.stringContaining("the lead now") },
    });

    // The WITNESS re-pinned, on its own disk, keeping its member id and the crew secret (§14.5).
    await waitFor(async () => witness.store()!.lead!.memberId === aideId, 15_000, "the witness never re-pinned");
    expect(witness.store()!.crew!.secret).toBe(aide.store()!.crew!.secret);
    expect(witness.store()!.lead!.certPem).toBe(aide.store()!.self.certPem);

    // The DEPUTY committed locally, last: it leads, it adopted the roster the push carried, and the
    // old lead is carried as an ordinary member that has not been told yet (RFC §9).
    const led = aide.store()!;
    expect(led.lead).toBeNull();
    expect(led.peers.map((p) => p.memberId).toSorted()).toEqual([hqId, idOf(witness)].toSorted());
    expect(led.peers.find((p) => p.memberId === hqId)!.rePinPending).toBe(true);
    // The warrant was SPENT: the crew designates nobody until the operator names one again.
    expect(led.deputy).toBeNull();
    // …and the phone's credential came with it, so the same device keeps working against the new lead.
    expect(readFileSync(join(aide.stateDir, "paired-devices.json"), "utf8")).toContain(sha256Hex(TOKEN));
  }, 60_000);

  test("the deputy restarts INTO lead mode and serves the real front door", async () => {
    // The one restart the bridge performs on its own: the operator asked from a phone, and a machine
    // whose store says `lead` while its process runs a peer's pinned listener is unreachable.
    // ── THE LIVE DRILL, BUG 1 ────────────────────────────────────────────────
    // The exit STATUS is load-bearing, not cosmetic. `Restart=on-failure` — the drill's unit, and
    // systemd's common choice — does not revive a clean `0`, so a takeover that exited zero left the
    // store saying `lead`, the service `inactive`, and the operator holding a phone with no shell.
    // Both `on-failure` and `always` revive a non-zero exit, so only a non-zero status is correct
    // under either policy, and the answer's "reload in a moment" is only honest with it.
    const exited = await aide.proc!.exited;
    expect(exited).toBe(TAKEOVER_RESTART_EXIT);
    expect(TAKEOVER_RESTART_EXIT).not.toBe(0);
    await waitFor(async () => !(await portOpen(aide.port)), 15_000, "the deputy never restarted");
    await aide.start();
    // An unpinned listener, plain HTTP, serving the app — the shape a lead has and a peer does not.
    expect(aide.pins()).toBe(false);
    expect(aide.origin().startsWith("http://")).toBe(true);
    // The standby PORT keeps answering, and it now answers `leading` — a failover proxy's fallback
    // backend points here, so a new lead that closed it would leave the proxy swinging the phone back
    // onto the machine that died (RFC §14.2).
    await waitFor(async () => (await standby("/standby/health")).status === 200, 20_000, "the standby port went dark");
    expect(await (await standby("/standby/health")).json()).toEqual({ state: "leading" });
    await waitFor(
      async () => (await fetch(`${aide.origin()}/standby/health`)).status === 200,
      20_000,
      "the new lead never answered its own health check",
    );
    // The merged snapshot names both members, from the roster that rode the warrant push.
    await waitFor(
      async () => ((await snapshotOf(aide)).servers ?? []).some((s) => s.id === idOf(witness) && s.reachable),
      20_000,
      "the new lead never swept its adopted roster",
    );
  }, 60_000);

  test("the old lead boots, finds the conflict, and SELF-HEALS to a peer of the machine that deposed it", async () => {
    const aideId = aide.store()!.self.memberId;
    await hq.start();
    await waitFor(async () => hq.store()!.lead?.memberId === aideId, 30_000, "the old lead never self-healed");
    const healed = hq.store()!;
    // Strictly privilege-DECREASING, and it created no trust: the new lead's certificate came out of
    // this machine's own roster, never off the wire (§18.12).
    expect(healed.peers).toEqual([]);
    expect(healed.lead!.certPem).toBe(aide.store()!.self.certPem);
    expect(healed.deputy).toBeNull();
    // The crew identity and the secret are untouched — a role change, not a re-enrollment.
    expect(healed.crew!.crewId).toBe(aide.store()!.crew!.crewId);
    expect(healed.crew!.secret).toBe(aide.store()!.crew!.secret);

    // …and the new lead stops owing it the proof: §9's "one extra round trip, once, and never again".
    await waitFor(
      async () => aide.store()!.peers.find((p) => p.memberId === hq.store()!.self.memberId)?.rePinPending !== true,
      30_000,
      "the new lead never cleared the old lead's pending re-pin",
    );
  }, 90_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// WALKY TALKY ACROSS A CREW OF FOUR, ON THE REAL WIRE (CREW_PROTOCOL §21, M62 hardening B, D, E, F, I).
//
// `bridge/walky/crew.test.ts` proves each half with mocks. This is the only place the whole route is
// proven: real child bridges, real pinned mutual TLS, the real §8.6 request signature, the real lead
// attestation and the real Send Protocol writing into a fake Herdr. The two-instance block near the top
// covers one hop each way; what it cannot cover is a message between TWO MEMBERS (a member pins only its
// lead, so the lead is the only road), a member the lead knows to be too old, and a hand-built request
// that no honest bridge would send.
//
// Four instances, so that every route has its own: `wl` leads, `wa` and `wb` are ordinary members, and
// `wo` reports a version that predates walky talky. It is its OWN crew on its own ports, so it neither
// depends on nor disturbs the two instances the rest of this file drives.
//
// WHAT THE FAKE PANE CAN PROVE. `fake-herdr.ts` records every `pane.send_text` it receives in `writes`,
// and the pane's text never changes. So a write proves the bridge TYPED a line into that pane (and which
// line); it cannot prove the Send Protocol saw the line arrive. The receipt state therefore settles on
// whatever the Send Protocol makes of a screen that never shows the text, and these tests assert on the
// writes and on the receipt's `verified`/`by`, not on `delivered`.
// ─────────────────────────────────────────────────────────────────────────────

describe("walky talky in a crew of four, on the real wire", () => {
  let wl: Instance;
  let wa: Instance;
  let wb: Instance;
  let wo: Instance;
  let oldRoot = "";

  /**
   * A Claude Code screen drawn from what Herdr was told to write into the pane, the way
   * `bridge/surface/protocol.test.ts` draws one: a rule, the box (`❯`, the dim placeholder while it is
   * empty), a rule, the status row. `fake-herdr.ts` answers every `pane.read` with a fixed text, and the
   * Send Protocol will not type a message into a screen it cannot read (`inbox-only: unconfirmed`, no
   * write) nor trust a screen that never reacts to its probe character (`probe failed`). So the pane's
   * text is a getter over the fake's own `writes`: typed text lands in the box, Backspace takes a
   * character back, Enter moves the box into the transcript. Wrapped at the unit fake's width so a long
   * nudge line is a box of several rows, as a real one is.
   */
  function claudeScreen(writes: readonly PaneWrite[]): string {
    const width = 38;
    const transcript: string[] = [];
    let box = "";
    for (const write of writes) {
      if (write.method === "pane.send_text") box += asJsonString(write.params.text) ?? "";
      const sent = write.params.keys;
      const keys = write.method === "pane.send_keys" && Array.isArray(sent) ? sent : [];
      for (const key of keys) {
        if (key === "Backspace") box = [...box].slice(0, -1).join("");
        if (key === "Enter" && box !== "") {
          transcript.push(`> ${box}`);
          box = "";
        }
      }
    }
    const rows = box === "" ? [`❯ \u001b[2mTry "fix the failing tests"\u001b[0m`] : (box.match(new RegExp(`.{1,${String(width)}}`, "gu")) ?? [""]).map((chunk, i) => (i === 0 ? `❯ ${chunk}` : `  ${chunk}`));
    return [...transcript, "", "─".repeat(40), ...rows, "─".repeat(40), "  sonnet · project · main"].join("\n");
  }

  /** The pane label the lead's and A's panes share: one folder on two machines, for the scope case (M75). */
  const SCOPE_LABEL = "scope-ws#main";

  /** A pane label one case sets for a while, read on every snapshot; absent: the label the pane started with. */
  const paneLabels = new Map<Instance, string>();

  /** `startHerdr` for an instance whose pane is {@link claudeScreen}: the fake's `text` is read per `pane.read`. */
  function startLiveHerdr(at: Instance, label = at.name): void {
    at.herdr = startFakeHerdr({
      socketPath: at.socketPath,
      workspaceLabel: at.name,
      panes: [
        {
          paneId: at.paneId,
          tabId: "t1",
          workspaceId: "w1",
          get label() {
            return paneLabels.get(at) ?? label;
          },
          get text() {
            return claudeScreen(at.herdr?.writes ?? []);
          },
        },
      ],
    });
  }

  const idOf = (i: Instance): string => i.store()!.self.memberId;
  const paneOf = (i: Instance): string => `${idOf(i)}/${i.paneId}`;
  /** A pane's address as `who` prints it: the pane id, then `#` and the pane's instance token. */
  const tokened = (i: Instance) => expect.stringMatching(new RegExp(`^${paneOf(i)}#[a-z0-9]{4}$`, "u"));

  /** The harness's own copy of the standby block's `enrol`: invite, join, and the lead's restart. */
  async function enrol(leadInstance: Instance, memberInstance: Instance): Promise<void> {
    const invited = await verb(leadInstance, (d) => cmdCrewInvite(d, ["--label", memberInstance.name]));
    expect(invited.code).toBe(EXIT.OK);
    const token = invited.out.split("\n")[0]!.trim();
    const joined = await verb(memberInstance, (d) =>
      cmdJoin(d, [`http://127.0.0.1:${leadInstance.port}`, token, "--insecure", "--address", `127.0.0.1:${memberInstance.port}`]),
    );
    expect(joined.err).not.toContain("certificate minting is not wired");
    expect(joined.code).toBe(EXIT.OK);
    // Nothing restarts the LEAD after an enrollment lands (§8.2's note): the operator's step, here the harness's.
    await leadInstance.restart();
  }

  /** One request over an instance's walky socket. Markers default to none: the CLI outside any pane. */
  async function walky(at: Instance, request: Record<string, JsonValue>): Promise<JsonValue> {
    const answer = await askSocket(walkySocketPath(at.stateDir), `${JSON.stringify({ v: 1, markers: [], ...request })}\n`, 5000);
    expect(answer).not.toBeNull();
    // SAFETY: the bridge writes one JSON line, and the assertions below read it field by field.
    return JSON.parse(answer!) as JsonValue;
  }

  /** The markers a CLI inside `at`'s pane reads from its environment, as the existing walky block builds them. */
  const markersOf = (at: Instance): JsonValue[] => [
    { namespace: "herdr", scope: at.socketPath, pane: at.paneId, schemaVersion: 1, harness: "claude" },
  ];

  /** An agent's send from `from`'s pane over `from`'s own walky socket, the way `collie walky send` does it. */
  const agentSend = (from: Instance, id: string, to: string, body: string): Promise<JsonValue> =>
    walky(from, { op: "send", id, to, body, replyTo: null, markers: markersOf(from) });

  /** Every line the bridge typed into `at`'s pane, whole, in order. */
  const typedLines = (at: Instance): string[] =>
    at.herdr!.writes.filter((w) => w.method === "pane.send_text").flatMap((w) => asJsonString(w.params.text) ?? []);

  /** The lines typed into `at`'s pane that name message `id`. */
  const typedFor = (at: Instance, id: string): string[] => typedLines(at).filter((line) => line.includes(id));

  /** The audit lines of `at` that carry `action`, whole (the trail is one compact JSON object per line). */
  const auditOf = (at: Instance, action: string): string[] => {
    try {
      return readFileSync(join(at.stateDir, "audit.log"), "utf8").split("\n").filter((line) => line.includes(`"action":"${action}"`));
    } catch {
      return [];
    }
  };

  /** Wait until `at`'s own log holds a `delivered` receipt for `id`: the nudge is typed and submitted. */
  const settled = (at: Instance, id: string): Promise<void> =>
    waitFor(
      async () => readReceiptsAnswer(await walky(at, { op: "status", id })).some((r) => r.state === "delivered"),
      15_000,
      async () => `${at.name} never delivered ${id}: ${JSON.stringify(await walky(at, { op: "status", id }))}`,
    );

  /** `/api/crew` on the lead: the version it holds for each member. */
  async function versionsOnLead(): Promise<Record<string, string | undefined>> {
    const res = await wl.api("/api/crew");
    // SAFETY: the handler emits `CrewStatusResponse` (server.ts, `/api/crew`).
    const body = (await res.json()) as CrewStatusResponse;
    return Object.fromEntries(body.members.map((m) => [m.id, m.version]));
  }

  /**
   * A member's message sent straight at the lead's `/crew/v1/walky`, hand-built, signed with the
   * member's REAL key from its trust store and carrying §8.6's request signature over the exact bytes.
   * Nothing an honest bridge would send is needed to make it: that is how a stale or replayed message
   * is produced at all, because the member's own bridge stamps `at` with its own clock and signs once.
   */
  let lastStamp = 0;
  async function postAsMember(
    member: Instance,
    fields: { id: string; to: string; body: string; at: number; address?: string },
  ): Promise<{ status: number; body: JsonValue }> {
    const store = member.store()!;
    const memberId = store.self.memberId;
    // The sender's address as its own bridge signs it: the pane id and its instance token, which the
    // member's `who` names as `self` for a CLI inside that pane.
    const self = asJsonString(asJsonObject(await walky(member, { op: "who", markers: markersOf(member) }))?.self);
    const unsigned: WalkyMessage = {
      v: 1,
      id: fields.id,
      kind: "agent",
      from: { memberId, address: fields.address ?? self ?? `${memberId}/${member.paneId}`, harness: "claude", label: "drill" },
      to: fields.to,
      replyTo: null,
      at: fields.at,
      body: fields.body,
      signer: null,
      signature: null,
    };
    const payload = JSON.stringify(signMessage(unsigned, store.self.keyPem, memberId));
    // Strictly increasing, so the request-signature monotonicity rule (§8.6) cannot refuse two probes in one millisecond.
    lastStamp = Math.max(Date.now(), lastStamp + 1);
    const res = await fetch(`${wl.origin()}${CREW_WALKY_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${store.crew!.secret}`,
        "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
        "x-crew-member": memberId,
        [TIMESTAMP_HEADER]: String(lastStamp),
        [SIGNATURE_HEADER]: signRequest(store.self.keyPem, { method: "POST", path: CREW_WALKY_PATH, body: payload, timestamp: lastStamp }),
      },
      body: payload,
    });
    // SAFETY: the route answers JSON (`{ receipts }`, or `{ error }`), read field by field below.
    return { status: res.status, body: (await res.json().catch(() => null)) as JsonValue };
  }

  /**
   * A crew dial at `member` as the lead `wl` makes it: the lead's client certificate against the
   * member's pin, the crew secret and the dial attestation, the way `PeerClient` dials. It reads the
   * lead's identity off disk, so it works while the lead's process is down.
   */
  async function asLead(member: Instance, method: string, path: string, body?: string, extra: Record<string, string> = {}): Promise<Response> {
    const from = wl.store()!;
    const to = member.store()!;
    const timestamp = Date.now();
    const headers = new Headers({
      authorization: `Bearer ${from.crew!.secret}`,
      "x-crew-protocol": String(CREW_PROTOCOL_VERSION),
      "x-crew-member": from.self.memberId,
      [TIMESTAMP_HEADER]: String(timestamp),
      [DIAL_HEADER]: signDial(from.self.keyPem, { method, path, timestamp, to: to.self.memberId }),
      ...extra,
    });
    if (body !== undefined) headers.set("content-type", "application/json");
    return crewFetch(`https://127.0.0.1:${member.port}${path}`, {
      method,
      headers,
      body,
      tls: { cert: from.self.certPem, key: from.self.keyPem, ca: [to.self.certPem], checkServerIdentity: () => undefined },
    });
  }

  /** The lead-to-member route for `member`'s pane, percent-encoded as the lead's forward sends it. */
  const paneRoute = (member: Instance): string => `${CREW_PREFIX}pane/${encodeURIComponent(member.paneId)}/walky`;

  /** An agent's message from `from`'s pane, signed with `key` under `from`'s member id. */
  function agentMessage(from: Instance, id: string, to: string, body: string, key = from.store()!.self.keyPem): WalkyMessage {
    const memberId = idOf(from);
    const unsigned: WalkyMessage = {
      v: 1,
      id,
      kind: "agent",
      from: { memberId, address: paneOf(from), harness: "claude", label: "drill" },
      to,
      replyTo: null,
      at: Date.now(),
      body,
      signer: null,
      signature: null,
    };
    return signMessage(unsigned, key, memberId);
  }

  beforeAll(async () => {
    // A checkout that holds a manifest naming a release from before walky talky. The bridge reads its
    // own version off `<root>/herdr-plugin.toml` (bridge/version.ts), and a member reports that string
    // to its lead, so this is the honest way to be an old member: the lead is told, over the wire,
    // exactly what a real old build would tell it. `COLLIE_PLUGIN_ROOT` (bridge/root.ts) points the
    // child at it. The bridge also reads `package.json` from that root at boot (bridge/index.ts), so
    // the dir holds that one field too, and nothing else: the code still runs from this checkout.
    oldRoot = mkdtempSync(join(root, "old-checkout-"));
    writeFileSync(join(oldRoot, "herdr-plugin.toml"), 'version = "1.0.0"\n');
    writeFileSync(join(oldRoot, "package.json"), '{ "name": "collie", "version": "1.0.0" }\n');
    wl = new Instance("wlead", "w1:p1", "");
    wa = new Instance("wa", "w1:p2", "");
    wb = new Instance("wb", "w1:p3", "");
    wo = new Instance("wold", "w1:p4", "", { COLLIE_PLUGIN_ROOT: oldRoot });
    for (const i of [wl, wa, wb, wo]) startLiveHerdr(i, i === wl || i === wa ? SCOPE_LABEL : i.name);
    await Promise.all([wl.start(), wa.start(), wb.start(), wo.start()]);
    await enrol(wl, wa);
    await enrol(wl, wb);
    await enrol(wl, wo);
  }, 180_000);

  afterAll(async () => {
    if (process.env.COLLIE_HARNESS_DEBUG === "1") {
      for (const i of [wl, wa, wb, wo]) console.log(`\n──── ${i?.name} ────\n${i?.log}`);
    }
    await Promise.all([wl?.stop(), wa?.stop(), wb?.stop(), wo?.stop()]);
    for (const i of [wl, wa, wb, wo]) i?.herdr?.stop();
  });

  test("`who` on the lead lists every member's pane, and each member names the command to run on the lead", async () => {
    await waitFor(
      async () => {
        const listed = JSON.stringify(await walky(wl, { op: "who" }));
        return [wa, wb, wo].every((m) => listed.includes(`"${paneOf(m)}#`));
      },
      20_000,
      async () => `the lead's who never listed all three members: ${JSON.stringify(await walky(wl, { op: "who" }))}`,
    );
    // The lead's own pane first, then each member's: five addresses on one machine and three on others.
    const listed = JSON.stringify(await walky(wl, { op: "who" }));
    // Each one with its pane's instance token: the members send it on their snapshots.
    for (const m of [wl, wa, wb, wo]) expect(listed).toMatch(new RegExp(`"address":"${paneOf(m)}#[a-z0-9]{4}"`, "u"));
    // A member lists its own pane only: the roster is the lead's, and the note says which command reaches it.
    for (const m of [wa, wb]) {
      const own = await walky(m, { op: "who" });
      expect(own).toMatchObject({ ok: true, targets: [{ address: tokened(m) }], note: expect.stringContaining(`run \`collie walky who\` on the lead (${idOf(wl)})`) });
    }
  }, 60_000);

  test("a member's agent reaches another member's pane through the lead, and the receiver checks the sender's own signature through the lead's voucher", async () => {
    const id = "wt_a2bpane00001";
    const body = "from member a to member b, through the lead";
    const sent = await agentSend(wa, id, paneOf(wb), body);
    // The lead routed it and B answered: the receipt is B's own, written on B, and it says how B knew the sender.
    expect(sent).toMatchObject({ ok: true, receipts: [{ id, target: paneOf(wb), state: "accepted", by: idOf(wb), verified: "origin" }] });

    // B's log: the ORIGIN (added 2026-10-18). B pins only its lead, so the lead sent A's pinned
    // certificate with its voucher for it, and B checked A's own signature against that certificate.
    expect(await walky(wb, { op: "status", id })).toMatchObject({
      ok: true,
      receipts: [{ target: paneOf(wb), by: idOf(wb), verified: "origin" }],
      message: { id, kind: "agent", signer: idOf(wa), from: { memberId: idOf(wa), address: tokened(wa) } },
    });
    // The lead logged the message it routed, from A's pane to B's.
    expect(await walky(wl, { op: "status", id })).toMatchObject({
      ok: true,
      receipts: [{ target: paneOf(wb), by: idOf(wb) }],
      message: { id, from: { address: tokened(wa) }, to: paneOf(wb) },
    });
    // A learns B's outcome once the lead pushes it back (§21, added 2026-10-18).
    await waitFor(async () => readReceiptsAnswer(await walky(wa, { op: "status", id }))[0]?.state === "delivered", 20_000, () => "A never learned B's outcome");
    expect(await walky(wa, { op: "status", id })).toMatchObject({ ok: true, receipts: [{ target: paneOf(wb), state: "delivered", by: idOf(wb) }], elsewhere: [] });

    // The fake pane saw ONE typed line: the header and the nudge, an agent's message, no body.
    await waitFor(async () => typedFor(wb, id).length > 0, 15_000, async () => `B's pane never got the line; writes: ${JSON.stringify(wb.herdr!.writes)}`);
    const lines = typedFor(wb, id);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatch(new RegExp(`\\[walky-talky ${id}\\] from agent ${paneOf(wa)}#[a-z0-9]{4} \\(claude, `, "u"));
    expect(line).toContain(NUDGE_MARK);
    expect(line).toContain(`collie walky inbox ${id}`);
    expect(line).not.toContain(body);
    expect(line).not.toContain("\n");
    // The sender's pane and the lead's were typed into by nobody.
    expect(typedFor(wa, id)).toEqual([]);
    expect(typedFor(wl, id)).toEqual([]);

    // The lead audited the hop in and the hop out; B audited the delivery it took from the lead.
    await waitFor(
      async () =>
        auditOf(wl, "walky.send").some((l) => l.includes(idOf(wa))) &&
        auditOf(wl, "walky.deliver").some((l) => l.includes(`"host":"${idOf(wb)}"`)) &&
        auditOf(wb, "walky.deliver").some((l) => l.includes(`"from":"${idOf(wl)}"`) && l.includes('"verified":"origin"')),
      10_000,
      async () => `lead audit: ${auditOf(wl, "walky.send").join(" | ")} ${auditOf(wl, "walky.deliver").join(" | ")}; B audit: ${auditOf(wb, "walky.deliver").join(" | ")}`,
    );
  }, 60_000);

  test("the lead's agent reaches a member's pane signed by the lead, so the member verifies the ORIGIN, and the pane gets one nudge line with no body", async () => {
    const id = "wt_l2apane00001";
    const body = "from the lead's own agent to member a";
    const sent = await agentSend(wl, id, paneOf(wa), body);
    expect(sent).toMatchObject({ ok: true, receipts: [{ id, target: paneOf(wa), by: idOf(wa), verified: "origin" }] });
    expect(await walky(wa, { op: "status", id })).toMatchObject({
      ok: true,
      receipts: [{ target: paneOf(wa), by: idOf(wa), verified: "origin" }],
      message: { kind: "agent", signer: idOf(wl) },
    });

    await waitFor(async () => typedFor(wa, id).length > 0, 15_000, async () => `A's pane never got the line; writes: ${JSON.stringify(wa.herdr!.writes)}`);
    const lines = typedFor(wa, id);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    // Hardening A: ONE line, the header and the nudge. The body reaches the agent as `collie walky inbox <id>`.
    expect(line).toMatch(new RegExp(`\\[walky-talky ${id}\\] from agent ${paneOf(wl)}#[a-z0-9]{4} \\(claude, `, "u"));
    expect(line).toContain(`${NUDGE_MARK} Read it: collie walky inbox ${id}. Reply: collie walky reply ${id} "<text>"`);
    expect(line).not.toContain(body);
    expect(line).not.toContain("\n");
    expect(JSON.stringify(wa.herdr!.writes)).not.toContain(body);
    // …and the body IS there to read, on the member, where the agent will ask for it.
    expect(await walky(wa, { op: "inbox", all: true, markers: markersOf(wa) })).toMatchObject({
      ok: true,
      messages: expect.arrayContaining([expect.objectContaining({ id, body })]),
    });
  }, 60_000);

  test("the member's outcome reaches the lead on the next snapshot answer, past `accepted`, written by the member", async () => {
    // Two routes, one report: a message the lead routed from member A to B, and one the lead sent itself to A.
    // The send answered at `accepted` (asserted above), so only the member's report can move the lead's copy.
    for (const [id, member] of [
      ["wt_a2bpane00001", wb],
      ["wt_l2apane00001", wa],
    ] as const) {
      const target = paneOf(member);
      const onLead = async (): Promise<WalkyReceipt[]> => readReceiptsAnswer(await walky(wl, { op: "status", id }));
      await waitFor(
        async () => (await onLead()).some((r) => r.target === target && r.state !== "accepted"),
        20_000,
        async () => `the lead still holds ${JSON.stringify(await onLead())} (the member holds ${JSON.stringify(await walky(member, { op: "status", id }))})`,
      );
      const [held] = await onLead();
      expect(held).toMatchObject({ id, target, by: idOf(member), state: "delivered" });
      // The same receipt the member wrote itself: the report carried it, nothing on the lead invented it.
      const [own] = readReceiptsAnswer(await walky(member, { op: "status", id }));
      expect(held!.state).toBe(own!.state);
      expect(held!.verified).toBe(own!.verified);
    }
  }, 60_000);

  test("the sender member's own status shows the outcome the lead pushed back, and `send` there prints it", async () => {
    // `collie walky send` itself, run as an agent in A's pane: the pane's own environment names it.
    const id = "wt_clisend00001";
    const captured: Captured = { out: [], err: [] };
    const base = depsFor(wa, captured);
    const cli: WalkyDeps = {
      ctx: { ...base.ctx, env: { HERDR_PANE_ID: wa.paneId, HERDR_SOCKET_PATH: wa.socketPath } },
      files: realFiles,
      uid: process.getuid?.(),
      io: base.io,
      platform: HOST.platform,
      readStdin: () => Promise.resolve(""),
      stdinIsTty: true,
      ask: (path, line) => askSocket(path, line, 5000),
      sockets: () => [walkySocketPath(wa.stateDir)],
      mintId: () => id,
    };
    // B types it, B's next snapshot answer reports it, and the lead pushes it back to A, all inside
    // the 15 s `send` waits on a local message.
    expect(await cmdWalkySend(cli, [paneOf(wb), "from member a, told how it ended"])).toBe(EXIT.OK);
    expect(captured.out).toEqual([id, `to ${paneOf(wb)}`, "typed into the pane"]);
    expect(captured.err).toEqual([]);
    // A's own log holds B's receipt, as B wrote it, and nothing is left "on the lead".
    expect(await walky(wa, { op: "status", id })).toMatchObject({ ok: true, receipts: [{ id, target: paneOf(wb), state: "delivered", by: idOf(wb), verified: "origin" }], elsewhere: [] });
    const status: Captured = { out: [], err: [] };
    expect(await cmdWalkyStatus({ ...cli, io: depsFor(wa, status).io }, [id])).toBe(EXIT.OK);
    expect(status.out).toEqual([id, `${paneOf(wb)}: typed into the pane (signed by ${idOf(wa)})`]);
    expect(typedFor(wb, id)).toHaveLength(1);
  }, 60_000);

  test("a scope send (M75) from a member's pane reaches the lead's pane in that folder and comes back `delivered`, and `here` from the lead reaches the member", async () => {
    // The lead's pane and A's share the folder label `scope-ws#main` (beforeAll); B's and the old member's do
    // not. It runs before the phone-reply case, which stops A mid-send and leaves a draft in A's box.
    await waitFor(
      async () => {
        const listed = JSON.stringify(await walky(wl, { op: "who" }));
        return listed.includes(`"${paneOf(wa)}#`) && listed.includes(`"label":"${SCOPE_LABEL}"`);
      },
      20_000,
      async () => `the lead's who never listed A in the scope: ${JSON.stringify(await walky(wl, { op: "who" }))}`,
    );
    // Member to lead: A hands the scope to the lead whole, the lead expands it to its own pane only.
    const up = "wt_scopeup00001";
    const sent = await agentSend(wa, up, "scope-ws", "to every agent in scope-ws");
    expect(sent).toMatchObject({ ok: true, receipts: [{ id: up, target: paneOf(wl), by: idOf(wl), verified: "origin" }] });
    await settled(wl, up);
    expect(await walky(wl, { op: "status", id: up })).toMatchObject({
      ok: true,
      receipts: [{ target: paneOf(wl), state: "delivered" }],
      message: { to: "scope-ws", from: { address: tokened(wa) } },
      deliveries: [{ address: paneOf(wl), member: idOf(wl), outcome: "delivered" }],
      totals: { delivered: 1 },
    });
    // And back: the lead pushes the outcome to A, whose own status names the one delivery.
    await waitFor(
      async () => readReceiptsAnswer(await walky(wa, { op: "status", id: up })).some((r) => r.target === paneOf(wl) && r.state === "delivered"),
      20_000,
      async () => `A never learned the lead's outcome: ${JSON.stringify(await walky(wa, { op: "status", id: up }))}`,
    );
    expect(await walky(wa, { op: "status", id: up })).toMatchObject({ ok: true, deliveries: [{ address: paneOf(wl), outcome: "delivered" }], elsewhere: [] });
    expect(typedFor(wl, up)).toHaveLength(1);
    expect(typedFor(wa, up)).toEqual([]);
    expect(typedFor(wb, up)).toEqual([]);

    // Lead to member: `here` from the lead's pane is its folder without itself, so A's pane, checked by A.
    const down = "wt_scopedown001";
    const back = await agentSend(wl, down, "here", "to my siblings in scope-ws");
    expect(back).toMatchObject({ ok: true, receipts: [{ id: down, target: paneOf(wa), by: idOf(wa), verified: "origin" }] });
    await settled(wa, down);
    expect(await walky(wa, { op: "status", id: down })).toMatchObject({ ok: true, receipts: [{ target: paneOf(wa), state: "delivered" }], message: { to: "here" } });
    // A's report carries the outcome to the lead's parent.
    await waitFor(
      async () => readReceiptsAnswer(await walky(wl, { op: "status", id: down })).some((r) => r.target === paneOf(wa) && r.state === "delivered"),
      20_000,
      async () => `the lead never learned A's outcome: ${JSON.stringify(await walky(wl, { op: "status", id: down }))}`,
    );
    expect(typedFor(wa, down)).toHaveLength(1);
    expect(typedFor(wl, down)).toEqual([]);
  }, 90_000);

  test("`collie walky send here` from a member's pane reaches the lead's pane in that folder, past an older bridge asked first (2026-10-30)", async () => {
    // The live failure: on the sender's machine the CLI asked its own install's socket first, a release
    // lane older than M75, which answered the bare `bad request` before it looked at the markers. Here a
    // stand-in for it is asked first, A's bridge (not B's pane) second, B's own bridge third. B sends: the
    // A-lead pair is spent by the cases around this one (6 per 10 minutes, either direction), so B's pane
    // joins the folder for this case only, on another branch: `here` is the folder on any branch.
    paneLabels.set(wb, "scope-ws#side");
    const listsB = async (label: string): Promise<boolean> => JSON.stringify(await walky(wl, { op: "who" })).includes(`"label":"${label}"`);
    await waitFor(() => listsB("scope-ws#side"), 20_000, async () => `the lead's who never listed B in the scope: ${JSON.stringify(await walky(wl, { op: "who" }))}`);
    const olderDir = mkdtempSync(join(root, "older-bridge-"));
    const olderPath = walkySocketPath(olderDir);
    mkdirSync(dirname(olderPath), { recursive: true, mode: 0o700 });
    const older = createServer((socket) => socket.end(`${JSON.stringify({ ok: false, error: "bad request" })}\n`));
    await new Promise<void>((resolve) => older.listen(olderPath, resolve));
    try {
      const id = "wt_scopehere001";
      const captured: Captured = { out: [], err: [] };
      const base = depsFor(wb, captured);
      const cli: WalkyDeps = {
        ctx: { ...base.ctx, env: { HERDR_PANE_ID: wb.paneId, HERDR_SOCKET_PATH: wb.socketPath } },
        files: realFiles,
        uid: process.getuid?.(),
        io: base.io,
        platform: HOST.platform,
        readStdin: () => Promise.resolve(""),
        stdinIsTty: true,
        ask: (path, line) => askSocket(path, line, 5000),
        sockets: () => [olderPath, walkySocketPath(wa.stateDir), walkySocketPath(wb.stateDir)],
        mintId: () => id,
      };
      expect(await cmdWalkySend(cli, ["here", "to my siblings in scope-ws, from member b"])).toBe(EXIT.OK);
      expect(captured.err).toEqual([]);
      expect(captured.out.slice(0, 2)).toEqual([id, "to here"]);
      // The lead resolved `here` from B's label: its own pane and A's, never B's.
      const onLead = async () => walky(wl, { op: "status", id });
      await waitFor(
        async () => readReceiptsAnswer(await onLead()).filter((r) => r.state === "delivered").length === 2,
        20_000,
        async () => `the lead's parent never showed both deliveries: ${JSON.stringify(await onLead())}`,
      );
      expect(await onLead()).toMatchObject({
        ok: true,
        message: { to: "here", from: { address: tokened(wb), label: "scope-ws#side" } },
        deliveries: [{ address: paneOf(wl), member: idOf(wl), outcome: "delivered" }, { address: paneOf(wa), member: idOf(wa), outcome: "delivered" }],
      });
      expect(typedFor(wl, id)).toHaveLength(1);
      expect(typedFor(wa, id)).toHaveLength(1);
      expect(typedFor(wb, id)).toEqual([]);
    } finally {
      older.close();
      paneLabels.delete(wb);
    }
    await waitFor(() => listsB(wb.name), 20_000, async () => `the lead's who still lists B in the scope: ${JSON.stringify(await walky(wl, { op: "who" }))}`);
  }, 60_000);

  test("a sender block whose certificate the lead did not vouch for is the uniform 401, and the vouched one reads `origin`", async () => {
    const leadData = wl.store()!;
    const crewId = leadData.crew!.crewId;
    const pinned = leadData.peers.find((m) => m.memberId === idOf(wa))!.certPem;
    const voucher = senderBlockFor(idOf(wa), pinned, leadData.self.keyPem, crewId)!;
    const forger = mintIdentity({ commonName: "collie-forger", sans: ["127.0.0.1"] });
    const deliver = (message: WalkyMessage, sender: { certPem: string; voucher: string }): Promise<Response> =>
      asLead(wb, "POST", paneRoute(wb), JSON.stringify({ message, attest: attestFor(message, leadData.self.keyPem, crewId, idOf(wb)), sender }));

    // A's real message, with the certificate swapped: the voucher names the fingerprint of the one the lead pinned.
    const tampered = agentMessage(wa, "wt_tampercert01", paneOf(wb), "a certificate the lead never pinned");
    const swapped = await deliver(tampered, { ...voucher, certPem: forger.certPem });
    expect(swapped.status).toBe(401);
    expect(await swapped.json()).toEqual({ error: "unauthorized" });
    // A forger that signs as A with its own key, and sends its own certificate under A's voucher.
    const forged = agentMessage(wa, "wt_tampercert02", paneOf(wb), "signed by a forger as member a", forger.keyPem);
    expect((await deliver(forged, { ...voucher, certPem: forger.certPem })).status).toBe(401);
    // …or keeps the vouched certificate, which its key did not sign with.
    expect((await deliver(forged, voucher)).status).toBe(401);

    // THE CONTROL: the same hand-built delivery with the lead's real block is taken, as `origin`.
    const control = agentMessage(wa, "wt_tampercert03", paneOf(wb), "vouched for by the lead");
    const taken = await deliver(control, voucher);
    expect(taken.status).toBe(200);
    expect(await taken.json()).toMatchObject({ receipts: [{ id: control.id, target: paneOf(wb), by: idOf(wb), verified: "origin" }] });
    await settled(wb, control.id);
    // Nothing the refused deliveries said reached B: no record, no line.
    for (const id of ["wt_tampercert01", "wt_tampercert02"]) {
      expect(await walky(wb, { op: "status", id })).toMatchObject({ ok: true, receipts: [], message: null });
      expect(typedFor(wb, id)).toEqual([]);
    }
  }, 60_000);

  test("a member the lead knows to be older is refused `older member` BEFORE any dial", async () => {
    // The member reports 1.0.0 on its hello and its sweep answers; the lead's `older` check reads it.
    await waitFor(async () => (await versionsOnLead())[idOf(wo)] === "1.0.0", 20_000, async () => `the lead holds ${JSON.stringify(await versionsOnLead())}`);
    const id = "wt_oldmember001";
    const before = { writes: wo.herdr!.writes.length, dials: auditOf(wl, "walky.deliver").length, deliveries: auditOf(wo, "walky.deliver").length };
    const sent = await agentSend(wa, id, paneOf(wo), "for a member that predates walky talky");
    // The lead wrote the refusal itself: `by` the lead and `verified: local`, as a receipt only the routing side writes.
    expect(sent).toMatchObject({ ok: true, receipts: [{ id, target: paneOf(wo), state: "refused", reason: "older member", by: idOf(wl), verified: "local" }] });
    expect(await walky(wl, { op: "status", id })).toMatchObject({ ok: true, receipts: [{ target: paneOf(wo), state: "refused", reason: "older member", by: idOf(wl) }] });

    // ── HOW "NO DIAL" IS PROVED ───────────────────────────────────────────────
    // `wold` runs THIS checkout's code and only REPORTS 1.0.0, so a dial would have been taken: it would
    // have verified the lead's attestation, logged the message, audited `walky.deliver` and typed the
    // nudge. A 404 from a build without the route (the backstop `receiptsOfAnswer` names) would have
    // looked the same as the pre-dial refusal in the receipt, which is why the receipt is not the proof.
    // The proof is what a dial leaves behind, on both ends, none of which is there:
    //   - the member's fake Herdr saw no write, and its walky log holds nothing under the id;
    //   - the member's audit trail has no new `walky.deliver` (written for every verified crew delivery);
    //   - the lead's audit trail has no new forwarded `walky.deliver` and none that names the member.
    // The control is the earlier test: the same route to `wb` DID leave all three.
    expect(wo.herdr!.writes).toHaveLength(before.writes);
    expect(await walky(wo, { op: "status", id })).toMatchObject({ ok: true, receipts: [], message: null });
    expect(auditOf(wo, "walky.deliver")).toHaveLength(before.deliveries);
    expect(auditOf(wl, "walky.deliver")).toHaveLength(before.dials);
    expect(auditOf(wl, "walky.deliver").some((line) => line.includes(`"host":"${idOf(wo)}"`))).toBe(false);
    // Nor does the child's own account of itself mention the message.
    expect(wo.log).not.toContain(id);
  }, 60_000);

  test("a message more than ten minutes off the lead's clock is refused `stale`, and a fresh one through the same helper is taken", async () => {
    const to = paneOf(wl);
    const minute = 60 * 1000;
    // THE CONTROL: the helper builds a well-formed, really signed, really request-signed message, and
    // the lead takes it. Without this, every refusal below could be a malformed request in disguise.
    const control = await postAsMember(wa, { id: "wt_stalectrl001", to, body: "a fresh message, signed by hand", at: Date.now() });
    expect(control).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_stalectrl001", target: to, state: "accepted", verified: "origin", by: idOf(wl) }] } });
    // One message at a time into a pane: a second send that finds the first still typing is held back
    // as `inbox-only: dialog open` (the box is not free), which would hide what this test is about.
    await settled(wl, "wt_stalectrl001");
    // Nine minutes old is inside the window (the rule is ten), so it is taken too.
    const aging = await postAsMember(wa, { id: "wt_staleedge001", to, body: "nine minutes old, still inside the window", at: Date.now() - 9 * minute });
    expect(aging).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_staleedge001", state: "accepted", verified: "origin" }] } });

    const stale = await postAsMember(wa, { id: "wt_stale0000001", to, body: "a day-old replay would look like this", at: Date.now() - 11 * minute });
    expect(stale).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_stale0000001", target: to, state: "refused", reason: "stale", by: idOf(wl) }] } });
    // A sender whose clock runs ahead is as stale as one that runs behind.
    const future = await postAsMember(wa, { id: "wt_future000001", to, body: "from a clock in the future", at: Date.now() + 11 * minute });
    expect(future).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_future000001", target: to, state: "refused", reason: "stale", by: idOf(wl) }] } });

    // The lead's pane typed the two it took and nothing for the two it refused. The refusal is answered
    // before delivery starts, so the wait is on the LAST accepted message: a refused one that had slipped
    // through would have been typed in that same run, right beside it.
    await settled(wl, "wt_staleedge001");
    expect(typedFor(wl, "wt_stalectrl001")).toHaveLength(1);
    expect(typedFor(wl, "wt_staleedge001")).toHaveLength(1);
    expect(typedFor(wl, "wt_stale0000001")).toEqual([]);
    expect(typedFor(wl, "wt_future000001")).toEqual([]);
    // Nothing is logged for a refusal of this kind (hardening I): the count is all that is kept.
    expect(await walky(wl, { op: "status", id: "wt_stale0000001" })).toMatchObject({ ok: true, receipts: [], message: null });
    expect(await walky(wl, { op: "status", id: "wt_future000001" })).toMatchObject({ ok: true, receipts: [], message: null });
  }, 60_000);

  test("a replayed id is answered from the stored receipt and typed once, at the lead's pane and through the lead at a member", async () => {
    // At the lead's pane, over the sender's own socket: the second send never leaves the sender.
    const idLead = "wt_replaylead01";
    const bodyLead = "sent twice to a pane on the lead";
    const first = await agentSend(wa, idLead, paneOf(wl), bodyLead);
    expect(first).toMatchObject({ ok: true, receipts: [{ id: idLead, target: paneOf(wl), state: "accepted", by: idOf(wl), verified: "origin" }] });
    const second = await agentSend(wa, idLead, paneOf(wl), bodyLead);
    expect(second).toMatchObject({ ok: true, receipts: [{ id: idLead, target: paneOf(wl), by: idOf(wl) }] });
    expect(readReceiptsAnswer(second)).toEqual(readReceiptsAnswer(first));
    // The same message again straight at the lead (a retry the sender's log did not stop): the LEAD
    // answers from its own record and types nothing.
    const wire = await postAsMember(wa, { id: idLead, to: paneOf(wl), body: bodyLead, at: Date.now() });
    expect(wire).toMatchObject({ status: 200, body: { receipts: [{ id: idLead, target: paneOf(wl), by: idOf(wl) }] } });
    await settled(wl, idLead);
    expect(typedFor(wl, idLead)).toHaveLength(1);

    // Through the lead at another member: the member's pane is written once however often the lead is asked.
    const idMember = "wt_replaymem001";
    const bodyMember = "sent twice to a pane on another member";
    expect(await agentSend(wa, idMember, paneOf(wb), bodyMember)).toMatchObject({ ok: true, receipts: [{ id: idMember, target: paneOf(wb), by: idOf(wb), verified: "origin" }] });
    await settled(wb, idMember);
    const deliveries = auditOf(wb, "walky.deliver").length;
    const again = await postAsMember(wa, { id: idMember, to: paneOf(wb), body: bodyMember, at: Date.now() });
    expect(again).toMatchObject({ status: 200, body: { receipts: [{ id: idMember, target: paneOf(wb), by: idOf(wb) }] } });
    // The lead answered from its record and never dialled the member a second time: the member's pane
    // holds the one line, and the member audited no second delivery.
    expect(typedFor(wb, idMember)).toHaveLength(1);
    expect(auditOf(wb, "walky.deliver")).toHaveLength(deliveries);

    // The same id with another body is another message wearing a taken id: refused, by the sender's own
    // bridge and by the lead, and nothing it says is typed.
    const reusedAtSender = await agentSend(wa, idLead, paneOf(wl), "another body under the same id");
    expect(reusedAtSender).toMatchObject({ ok: true, receipts: [{ id: idLead, state: "refused", reason: "id reused" }] });
    const reusedAtLead = await postAsMember(wa, { id: idLead, to: paneOf(wl), body: "another body under the same id", at: Date.now() });
    expect(reusedAtLead).toMatchObject({ status: 200, body: { receipts: [{ id: idLead, state: "refused", reason: "id reused", by: idOf(wl) }] } });
    expect(JSON.stringify(wl.herdr!.writes)).not.toContain("another body");
    expect(typedFor(wl, idLead)).toHaveLength(1);
  }, 60_000);

  test("an agent may not broadcast and may not message its own pane, at its own bridge and at the lead", async () => {
    // At the sender's bridge, over its socket.
    expect(await agentSend(wa, "wt_broadcast001", "all", "to everyone")).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "only the operator may broadcast" }] });
    expect(await agentSend(wa, "wt_broadcast002", `${idOf(wb)}/all`, "to one machine")).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "only the operator may broadcast" }] });
    expect(await agentSend(wa, "wt_ownpane00001", paneOf(wa), "to myself")).toMatchObject({ ok: true, receipts: [{ state: "refused", reason: "that is your own pane" }] });
    // At the lead, for a sender that skipped its own checks: the refusal does not depend on the sender's honesty.
    const wire = await postAsMember(wa, { id: "wt_broadcast003", to: "all", body: "to everyone, by hand", at: Date.now() });
    expect(wire).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_broadcast003", state: "refused", reason: "only the operator may broadcast", by: idOf(wl), verified: "origin" }] } });
    const own = await postAsMember(wa, { id: "wt_ownpane00002", to: paneOf(wa), body: "to myself, by hand", at: Date.now() });
    expect(own).toMatchObject({ status: 200, body: { receipts: [{ id: "wt_ownpane00002", state: "refused", reason: "that is your own pane", by: idOf(wl) }] } });
    for (const id of ["wt_broadcast001", "wt_broadcast002", "wt_broadcast003", "wt_ownpane00001", "wt_ownpane00002"]) {
      for (const at of [wl, wa, wb, wo]) expect(typedFor(at, id)).toEqual([]);
    }
  }, 60_000);

  test("the phone reads a member pane's list through the lead, from the member's own log, and replies to a message in it", async () => {
    // What the phone's pane loader asks for a pane on a member (web/src/lib/api.ts `fetchPaneWalky`).
    const listOn = (member: Instance): Promise<Response> => wl.api(`/api/pane/${encodeURIComponent(member.paneId)}/walky?limit=50&host=${idOf(member)}`);
    const rowsOf = async (res: Response): Promise<JsonValue[]> => {
      expect(res.status).toBe(200);
      // SAFETY: the route answers JSON (`{ messages }`, server.ts `walkyPaneRoute`), read field by field here.
      const messages = asJsonObject((await res.json()) as JsonValue)?.messages;
      return Array.isArray(messages) ? messages : [];
    };
    // B's list holds what A sent it through the lead, with B's own receipt and B's own word for the sender.
    const onB = await rowsOf(await listOn(wb));
    expect(onB).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "wt_a2bpane00001",
          kind: "agent",
          from: expect.objectContaining({ memberId: idOf(wa), address: tokened(wa) }),
          receipt: expect.objectContaining({ target: paneOf(wb), by: idOf(wb), verified: "origin" }),
        }),
      ]),
    );
    // A's list holds the lead's own agent's message, checked by A against the lead's certificate, and
    // the message A's agent SENT to B, with the outcome the lead pushed back to A.
    expect(await rowsOf(await listOn(wa))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "wt_l2apane00001", receipt: expect.objectContaining({ by: idOf(wa), verified: "origin" }) }),
        expect.objectContaining({ id: "wt_a2bpane00001", from: expect.objectContaining({ address: tokened(wa) }), receipt: expect.objectContaining({ target: paneOf(wb), by: idOf(wb) }) }),
      ]),
    );

    // Reply from B's pane, the way the Messages sheet hands it to the composer: the sender's address, and
    // `replyTo`, on the lead's own `POST /api/walky`. The lead routed the message, so it knows the sender.
    const row = asJsonObject(onB.find((entry) => asJsonObject(entry)?.id === "wt_a2bpane00001"));
    const to = asJsonString(asJsonObject(row?.from)?.address);
    expect(to).toMatch(new RegExp(`^${paneOf(wa)}#[a-z0-9]{4}$`, "u"));
    const id = "wt_replyfromb01";
    const res = await wl.apiWrite("/api/walky", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, to, body: "seen on b's pane", replyTo: "wt_a2bpane00001" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ receipt: { id, target: paneOf(wa), by: idOf(wa), verified: "origin" } });
    await waitFor(async () => typedFor(wa, id).length > 0, 15_000, async () => `A's pane never got the reply; writes: ${JSON.stringify(wa.herdr!.writes)}`);
    expect(typedFor(wa, id)[0]).toContain(`[walky-talky ${id}] from operator (drill) reply to wt_a2bpane00001`);
    // …and the member's list, read through the lead again, holds the reply where A's log put it.
    expect(await rowsOf(await listOn(wa))).toEqual(expect.arrayContaining([expect.objectContaining({ id, replyTo: "wt_a2bpane00001" })]));

    // A member the lead knows to predate walky talky is answered by the lead with no dial: `wo` runs
    // this very build and would answer 200, so the 404 can only be the lead's own.
    const older = await listOn(wo);
    expect(older.status).toBe(404);
    expect(await older.text()).toContain("older than walky talky");

    // A member that is down is a refusal the phone reads as a list it could not read.
    await wa.stop();
    try {
      const down = await listOn(wa);
      expect(down.status).toBe(503);
      expect(await down.json()).toMatchObject({ code: "host_unreachable", host: idOf(wa) });
    } finally {
      await wa.start();
    }
  }, 90_000);

  test("a member's report rides every snapshot answer until a sweep carries the lead's ack, then it is gone", async () => {
    // LAST in this block: it stops the lead, so nothing but this test reads B's report while it runs.
    const leadData = wl.store()!;
    const crewId = leadData.crew!.crewId;
    /** B's report on one snapshot answer, read with the lead's identity; `ack` rides as the header the sweep sends. */
    const reportOf = async (ack?: string) => {
      const res = await asLead(wb, "GET", CREW_SNAPSHOT_PATH, undefined, ack === undefined ? {} : { "X-Crew-Walky-Ack": ack });
      expect(res.status).toBe(200);
      // SAFETY: the snapshot route answers JSON; `readWalkyReport` checks every field it reads.
      return readWalkyReport((await res.json()) as JsonValue, WALKY_REPORT_FIELD);
    };
    /** A delivery from the lead's own agent, as the lead's forward sends it. */
    const fromLead = async (id: string): Promise<void> => {
      const message = agentMessage(wl, id, paneOf(wb), "a message whose receipt B reports", leadData.self.keyPem);
      const res = await asLead(wb, "POST", paneRoute(wb), JSON.stringify({ message, attest: attestFor(message, leadData.self.keyPem, crewId, idOf(wb)) }));
      expect(res.status).toBe(200);
      await settled(wb, id);
    };
    const holds = (report: { receipts: readonly WalkyReceipt[] }, id: string): boolean => report.receipts.some((r) => r.id === id && r.state === "delivered");

    await wl.stop();
    try {
      await fromLead("wt_ackcursor001");
      const first = await reportOf();
      expect(holds(first, "wt_ackcursor001")).toBe(true);
      expect(first.cursor).toMatch(/^[0-9a-f]{8}\.\d+$/u);
      // An answer nobody acked loses nothing: the next one carries the same receipt and cursor.
      const second = await reportOf();
      expect(holds(second, "wt_ackcursor001")).toBe(true);
      expect(second.cursor).toBe(first.cursor);
      // An ack from another epoch (a lead acking what B's previous run sent) acks nothing.
      expect(holds(await reportOf(`${first.cursor!.startsWith("0") ? "f" : "0"}${first.cursor!.slice(1)}`), "wt_ackcursor001")).toBe(true);
      // The ack of that cursor: gone before the answer is built.
      expect(holds(await reportOf(first.cursor!), "wt_ackcursor001")).toBe(false);
      // A second one, held while the lead is down: only the real lead's sweep may ack it now.
      await fromLead("wt_ackcursor002");
      expect(holds(await reportOf(), "wt_ackcursor002")).toBe(true);
    } finally {
      await wl.start();
    }
    // The lead comes back with no cursor: its first sweep reads the report, its next one carries the ack.
    await waitFor(
      async () => !holds(await reportOf(), "wt_ackcursor002"),
      20_000,
      async () => `B still reports ${JSON.stringify(await reportOf())}`,
    );
  }, 90_000);
});
