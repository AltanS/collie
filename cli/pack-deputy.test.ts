import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import type { JsonObject, JsonValue } from "../bridge/json.ts";
import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { fp, leadStore, material, member, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import { type OpsRecord, parsePackOps } from "../bridge/pack/ops-store.ts";
import { checkpointMarker, formatMarker, markerFor, type PackRuntimeFacts } from "../bridge/pack/staleness.ts";
import {
  serializeTrustStore,
  TrustStore,
  type TrustedMember,
  type TrustStoreData,
  type TrustStoreIo,
  type Warrant,
} from "../bridge/pack/trust-store.ts";
import { mintWarrant, type WarrantPush } from "../bridge/pack/warrant.ts";
import { capture, context, fakeExec, fakeFiles, fakeOps, STATE, type SeededFiles, type SeededOps } from "./fakes.ts";
import { EXIT } from "./io.ts";
import { cmdPackDeputy } from "./pack-deputy.ts";
import { cmdPackStatus, failureLine } from "./pack.ts";
import type { PackAddDeps, RemoteResult } from "./remote.ts";

// `collie pack deputy` and the deputy half of `collie pack status`, against fakes for every seam.
// NOTHING here spawns `ssh`, dials a network or touches a disk: the transport records `(host,
// script)` pairs, the one confirmation is a value, and both stores are in memory. Same safety
// boundary `cli/pack-update.test.ts` draws, for the sharper version of its reason — this verb
// restarts other people's machines as its normal path.

const CHECKOUT = "/home/pat/.collie";

/** What the fake transport banked about one `POST /pack/v1/warrant`. */
interface PushedWarrant {
  readonly member: string;
  readonly warrant: Warrant;
  readonly certPem: string | null;
}

const PROBE_DEFAULTS = {
  home: "/home/pat",
  git: "/usr/bin/git",
  bun: "/home/pat/.bun/bin/bun",
  herdr: "/usr/local/bin/herdr",
  configdir: "/home/pat/.config/herdr/plugins/config/herdr.collie",
  envhost: "",
  envport: "",
  checkout: CHECKOUT,
  commit: "0000feed0000feed0000feed0000feed0000feed",
  branch: "",
  dirty: "no",
  dirtyfiles: "",
  version: "1.0.0",
  address: "100.64.0.9",
  port: "busy",
} satisfies Record<string, string>;

function probeOut(over: Record<string, string> = {}): string {
  const all = { ...PROBE_DEFAULTS, ...over };
  return [...Object.entries(all).map(([k, v]) => `collie-probe:${k}=${v}`), "collie-probe:probe=ok", ""].join("\n");
}

type Leg = "probe" | "restart";

function legOf(script: string): Leg {
  if (script.includes("collie-probe:")) return "probe";
  if (script.includes('"$ROOT/bin/collie" restart')) return "restart";
  throw new Error(`unrecognised leg script:\n${script}`);
}

function opsRecord(sshHost: string, over: Partial<OpsRecord> = {}): OpsRecord {
  return { sshHost, path: CHECKOUT, port: 8787, recordedAt: T0, anchoredGeneration: null, anchoredAt: null, ...over };
}

/** A two-peer lead: `nas` (the usual deputy) and `attic`. */
const twoPeers = (over: Partial<TrustStoreData> = {}): TrustStoreData =>
  leadStore({
    peers: [
      member({ memberId: "nas", address: "100.64.0.9:8787" }),
      member({ memberId: "attic", address: "100.64.0.10:8787" }),
    ],
    ...over,
  });

/** The store a lead is left with after naming `deputy` — the same transition production uses. */
function withWarrant(data: TrustStoreData, deputy: string | null, now = T0): TrustStoreData {
  const change = mintWarrant(data, deputy, now);
  if (change === null) throw new Error(`mintWarrant refused "${deputy}" — the fixture is wrong`);
  return change.next;
}

interface HarnessOptions {
  store?: TrustStoreData | null;
  ops?: SeededOps;
  /** Members whose warrant push never reaches the far side at all — a transport throw. */
  refuse?: readonly string[];
  /**
   * How many warrant pushes each member answers with a bare `401` before accepting one.
   *
   * A `401` is what §8.6's replay floor produces when two processes on the lead sign a push with the
   * same key and one stamp lands second (`bridge/pack/router.ts` → `MEMBERSHIP_PATHS`), so it is a
   * REACHABLE machine refusing — the distinction the verb must not blur.
   */
  unauthorized?: Record<string, number>;
  /** Per-host, per-leg canned results. */
  answers?: Record<string, Partial<Record<Leg, Partial<RemoteResult>>>>;
  confirm?: boolean | null;
  /** Per-member `hello` answers for `pack status`: the warrant generation, or `false` for silence. */
  hello?: Record<string, number | null | false>;
  /**
   * Per-member `warrantActiveGeneration` on `hello` (§18.17) — what that machine's LISTENER came up
   * holding, as opposed to what its store holds. Absent ⇒ the field is omitted, which is a
   * pre-amendment build or a machine with nothing active, and reads as neither.
   */
  active?: Record<string, number>;
  /** Seeded files, for the runtime marker `pack status` reads. */
  files?: SeededFiles;
  /**
   * The labels in THIS machine's own `paired-devices.json`.
   *
   * One by default, because RFC §6.4 refuses to designate a deputy on a lead with nothing paired —
   * so an unpaired lead is a *state under test*, not the ambient condition of every other test.
   */
  paired?: readonly string[];
  now?: number;
  env?: Record<string, string>;
}

/** A paired registry as `collie pair` leaves it: labels and 64-hex hashes, nothing spendable. */
function pairedFiles(labels: readonly string[]): SeededFiles {
  const devices = labels.map((label, i) => ({
    label,
    tokenHash: String(i).repeat(64).slice(0, 64),
    createdAt: T0,
    lastSeenAt: T0,
  }));
  return { [`${STATE}/paired-devices.json`]: `${JSON.stringify({ devices }, null, 2)}\n` };
}

function harness(opts: HarnessOptions = {}) {
  const initial = opts.store === undefined ? twoPeers() : opts.store;
  let contents = initial === null ? null : serializeTrustStore(initial);
  const storeIo: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const out = capture();
  const calls: { host: string; leg: Leg }[] = [];
  const audit: AuditEntry[] = [];
  const confirms: string[] = [];
  const pushed: PushedWarrant[] = [];
  /** How many times each member's warrant route was dialled — the retry is counted here. */
  const warrantPushes = new Map<string, number>();
  const restarts: number[] = [];
  const ops = fakeOps(opts.ops ?? { nas: opsRecord("nas.example"), attic: opsRecord("attic.example") });
  const now = opts.now ?? T0;

  const deps: PackAddDeps = {
    // The same reason every other pack suite sets it: `PeerClient`'s REAL `setTimeout` must never
    // fire and report a fake member as unreachable.
    ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000", ...opts.env }),
    io: out,
    exec: fakeExec(),
    files: fakeFiles({ ...pairedFiles(opts.paired ?? ["phone"]), ...opts.files }),
    store: new TrustStore(STATE, storeIo),
    ops,
    // SAFETY: `AuditLog` hands its sink the line it just serialised from an `AuditEntry` — the log's
    // own round trip, not foreign input.
    audit: new AuditLog((l: string) => void audit.push(JSON.parse(l) as AuditEntry), { now: () => now }),
    fetch: async (url, init) => {
      const who = ["nas", "attic"].find((id) => url.includes(addressOf(initial, id))) ?? "nas";
      if (url.includes("/warrant")) {
        warrantPushes.set(who, (warrantPushes.get(who) ?? 0) + 1);
        // SAFETY: this verb serialises exactly one shape onto this route — `WarrantPush`, through
        // `JSON.stringify` a few lines earlier in `pushToPeers`. The suite is reading back the bytes
        // it just watched the verb write, not foreign input, so there is nothing here to re-validate.
        const body = JSON.parse(String(init.body)) as WarrantPush;
        pushed.push({ member: who, warrant: body.warrant, certPem: body.deputyCertPem ?? null });
        if (opts.refuse?.includes(who) === true) throw new Error("connection refused");
        if ((warrantPushes.get(who) ?? 0) <= (opts.unauthorized?.[who] ?? 0)) {
          // The bare 401 admission emits: no code, no cause, no version banner (§8.1).
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return jsonReply({ ok: true }, who);
      }
      const reported = opts.hello?.[who];
      if (reported === false) throw new Error("connection refused");
      const active = opts.active?.[who];
      const body: JsonObject = {
        protocol: PACK_PROTOCOL_VERSION,
        member: who,
        version: "1.0.0",
        warrantGeneration: reported ?? null,
      };
      // Omitted rather than nulled when the test says nothing — absent is the wire's own state.
      if (active !== undefined) body.warrantActiveGeneration = active;
      return jsonReply(body, who);
    },
    now: () => now,
    random: () => "r",
    mintIdentity: () => Promise.resolve(material("fresh")),
    readStdin: () => Promise.resolve(""),
    restart: () => {
      restarts.push(calls.length);
      return Promise.resolve(EXIT.OK);
    },
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
    remote: (host) => ({
      run: async (script) => {
        const leg = legOf(script);
        calls.push({ host, leg });
        const stdout = leg === "probe" ? probeOut() : "";
        return { code: 0, stdout, stderr: "", spawned: true, ...opts.answers?.[host]?.[leg] };
      },
      close: () => {},
    }),
    confirm: (question) => {
      confirms.push(question);
      return opts.confirm === undefined ? true : opts.confirm;
    },
    prompt: () => null,
    gitBundle: () => Promise.resolve(null),
    reload: () => Promise.resolve(initial),
  };

  return {
    deps,
    io: out,
    calls,
    confirms,
    pushed,
    ops,
    audit,
    restarts,
    warrantPushes,
    data: () => (contents === null ? null : contents),
  };
}

function jsonReply(body: JsonValue, from: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
      "x-pack-member": from,
    },
  });
}


function addressOf(data: TrustStoreData | null, memberId: string): string {
  return data?.peers.find((p) => p.memberId === memberId)?.address ?? "nowhere";
}

const text = (io: ReturnType<typeof capture>): string => [...io.stdout, ...io.stderr].join("\n");
const legs = (h: ReturnType<typeof harness>): string[] => h.calls.map((c) => `${c.host}:${c.leg}`);

/** A runtime marker on disk, as the running bridge would have left it. */
/**
 * A runtime marker on disk, as the running bridge would have left it.
 *
 * `checkpointedAt` defaults to the boot stamp; a test whose `now` is more than three refresh
 * intervals past that is describing a bridge that is NOT running, which is its own rendered state.
 */
function marker(
  data: TrustStoreData | null,
  facts: Partial<PackRuntimeFacts> = {},
  o: { bootedAt?: number; checkpointedAt?: number } = {},
) {
  const boot = markerFor(data, o.bootedAt ?? T0, 4242, {
    anchoredGeneration: null,
    leadLastDialledAt: null,
    leadRefusedSecretAt: null,
    deposed: null,
    pairingCollision: null,
    ...facts,
  });
  const live = checkpointMarker(boot, boot, o.checkpointedAt ?? boot.bootedAt);
  return { [`${STATE}/pack-runtime.json`]: formatMarker(live) } satisfies SeededFiles;
}

// ── Who may run it, and on whom (RFC §3) ─────────────────────────────────────

describe("pack deputy refuses before it mints", () => {
  test("a solo collie has no crown to deputise for", async () => {
    const h = harness({ store: null });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("not in a pack");
    expect(h.pushed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("a peer refuses: the deputy is named on the machine whose key signs the warrant", async () => {
    const h = harness({ store: peerStore() });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain('this collie is a peer of "desk"');
    expect(h.calls).toEqual([]);
  });

  test("a lead cannot deputise itself", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, ["desk"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("a lead cannot deputise itself");
    expect(h.pushed).toEqual([]);
  });

  test("a member this lead does not pin is a typo, not a consent", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, ["ghost"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain('no member "ghost" in this roster');
  });

  test("an unenrolled member is named as unenrolled, never as unknown", async () => {
    const h = harness({
      store: leadStore({ peers: [member({ memberId: "nas", status: "unenrolled" })] }),
    });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("is unenrolled");
    expect(text(h.io)).toContain("collie join");
  });

  test("a member behind on the pack secret is told to catch up rather than deputised", async () => {
    const h = harness({
      store: leadStore({ peers: [member({ memberId: "nas", secretGeneration: 0 })] }),
    });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("has not picked up the current pack secret");
  });

  test("a bare `pack deputy` prints usage and this lead's peers, and mints nothing", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, [])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("collie pack deputy <member>");
    expect(text(h.io)).toContain("nas");
    expect(text(h.io)).toContain("attic");
    expect(h.pushed).toEqual([]);
  });
});

// ── The happy path: mint → push → one consent → restart batch (RFC §5) ───────

describe("pack deputy arms the whole pack under one consent", () => {
  test("mints, restarts this lead, pushes to every peer, then restarts them all", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);

    // The local bridge is restarted BEFORE anything reaches another machine: the running lead is
    // what refreshes the warrant on every sweep thereafter.
    expect(h.restarts).toEqual([0]);
    expect(h.pushed.map((p) => p.member).toSorted()).toEqual(["attic", "nas"]);
    // The deputy's certificate rides with the warrant — a peer has no roster to look it up in.
    for (const push of h.pushed) {
      expect(push.warrant?.deputyMemberId).toBe("nas");
      expect(push.warrant?.deputyFingerprint).toBe(fp("nas"));
      expect(push.certPem).toBe(material("nas").certPem);
    }
    // Every enrolled peer is probed read-only, then restarted — including the deputy itself, which
    // must learn it holds a warrant naming it.
    expect(legs(h)).toEqual(["nas.example:probe", "attic.example:probe", "nas.example:restart", "attic.example:restart"]);
    expect(text(h.io)).toContain('"nas" is this pack\'s deputy at warrant generation 1');
  });

  test("ONE confirmation covers the batch, and it names every machine", async () => {
    const h = harness();
    await cmdPackDeputy(h.deps, ["nas"]);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toBe('restart collie on nas, attic to arm the deputy "nas"? [y/N]');
  });

  test("the probe runs before the question — nothing is restarted to find out it cannot be", async () => {
    const h = harness();
    await cmdPackDeputy(h.deps, ["nas"]);
    const firstRestart = h.calls.findIndex((c) => c.leg === "restart");
    expect(h.calls.slice(0, firstRestart).every((c) => c.leg === "probe")).toBe(true);
  });

  test("a refusal restarts nothing, and says the warrant is inert until something does", async () => {
    const h = harness({ confirm: false });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(legs(h)).toEqual(["nas.example:probe", "attic.example:probe"]);
    expect(text(h.io)).toContain("nothing was restarted");
    expect(text(h.io)).toContain("inert");
  });

  test("a non-interactive run aborts legibly and never reads EOF as yes", async () => {
    const h = harness({ confirm: null });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(legs(h).includes("nas.example:restart")).toBe(false);
    expect(text(h.io)).toContain("this run is not interactive");
    // The warrant IS minted and pushed by then — the message must not imply otherwise.
    expect(h.pushed).toHaveLength(2);
  });

  test("the armed generation is remembered per member, beside the ssh route and never in the store", async () => {
    const h = harness();
    await cmdPackDeputy(h.deps, ["nas"]);
    const recorded = parsePackOps(h.ops.contents()!)?.members;
    expect(recorded?.nas?.anchoredGeneration).toBe(1);
    expect(recorded?.attic?.anchoredGeneration).toBe(1);
    expect(recorded?.nas?.anchoredAt).toBe(T0);
    expect(h.data()).not.toContain("anchoredGeneration");
  });

  test("naming a second deputy supersedes the first in one step, at the next generation", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    expect(await cmdPackDeputy(h.deps, ["attic"])).toBe(EXIT.OK);
    expect(h.pushed.every((p) => p.warrant?.deputyMemberId === "attic")).toBe(true);
    expect(h.pushed.every((p) => p.warrant?.generation === 2)).toBe(true);
  });
});

// ── The member without an ssh record (RFC §5's reported, never skipped) ──────

describe("a peer this operator cannot ssh into is REPORTED", () => {
  test("it gets the warrant, is named in the exact `anchor INACTIVE` shape, and is not restarted", async () => {
    const h = harness({ ops: { nas: opsRecord("nas.example") } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    // It still received the warrant — phase 1 rides the pack link and needs no ssh at all.
    expect(h.pushed.map((p) => p.member).toSorted()).toEqual(["attic", "nas"]);
    expect(legs(h)).toEqual(["nas.example:probe", "nas.example:restart"]);
    expect(text(h.io)).toContain("attic: warrant stored, anchor INACTIVE — restart attic");
    expect(text(h.io)).toContain("no ssh record");
  });

  test("a machine whose ssh drops is reported the same way, never silently dropped", async () => {
    const h = harness({ answers: { "attic.example": { probe: { code: 255, stderr: "ssh: connect refused" } } } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("attic: warrant stored, anchor INACTIVE — restart attic");
    expect(legs(h).includes("attic.example:restart")).toBe(false);
  });

  test("a peer that did not take the warrant fails the run rather than passing it quietly", async () => {
    const h = harness({ refuse: ["attic"], hello: { nas: 1, attic: false } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("attic: NOT STORED");
  });
});

// ── A store that was not confirmed is never an anchor (the live-drill regression) ─

describe("a push the verb cannot confirm never becomes a recorded anchor", () => {
  test("a 401 is retried once with a fresh stamp — the replay floor's own remedy", async () => {
    const h = harness({ unauthorized: { nas: 1 } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.warrantPushes.get("nas")).toBe(2);
    expect(h.warrantPushes.get("attic")).toBe(1);
    expect(text(h.io)).toContain("nas: warrant stored, restarted");
  });

  test("the drill's exact sequence: 401 that never clears → member failed, NOT restarted, no ops write, non-zero exit", async () => {
    // The peer answers every push with 401 and reports the generation it actually holds: none.
    const h = harness({ unauthorized: { attic: 99 }, hello: { nas: 1, attic: null } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.FAIL);
    // (a) no restart was attempted there…
    expect(legs(h).some((l) => l.startsWith("attic"))).toBe(false);
    // …and (b) no anchor was recorded for it.
    expect(parsePackOps(h.ops.contents()!)?.members.attic?.anchoredGeneration ?? null).toBeNull();
    // The member that DID store it is unaffected — one failure is not a cancelled run.
    expect(parsePackOps(h.ops.contents()!)?.members.nas?.anchoredGeneration).toBe(1);
  });

  test("an unstored member's row never mentions an anchor, in any form", async () => {
    const h = harness({ unauthorized: { attic: 99 }, hello: { nas: 1, attic: null } });
    await cmdPackDeputy(h.deps, ["nas"]);
    const said = text(h.io);
    const atticLines = said.split("\n").filter((l) => l.includes("attic:") || l.includes("no anchor"));
    expect(atticLines.join(" ")).not.toContain("anchors the deputy");
    expect(said).toContain("Nothing was restarted there and no anchor was recorded for it.");
  });

  test("a peer that ANSWERS and did not take it is called up-and-refusing, never unreachable", async () => {
    const h = harness({ unauthorized: { attic: 99 }, hello: { nas: 1, attic: null } });
    await cmdPackDeputy(h.deps, ["nas"]);
    expect(text(h.io)).toContain("attic: NOT STORED — that machine is up and did not take the warrant");
    expect(text(h.io)).not.toContain("attic: NOT STORED — that machine is not answering");
  });

  test("a peer that answers NOTHING is called unreachable — the two words stay distinct", async () => {
    const h = harness({ refuse: ["attic"], hello: { nas: 1, attic: false } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("attic: NOT STORED — that machine is not answering");
  });

  test("the sweep winning the race is not a failure — the peer's own report is the confirmation", async () => {
    // Every push 401s (the stamp the bridge's sweep already burned), but the peer reports the
    // generation, so it HOLDS the warrant and the run is honest to say so.
    const h = harness({ unauthorized: { attic: 99 }, hello: { nas: 1, attic: 1 } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("attic: warrant stored (this lead's own sweep delivered it first)");
    expect(legs(h)).toContain("attic.example:restart");
    expect(parsePackOps(h.ops.contents()!)?.members.attic?.anchoredGeneration).toBe(1);
  });

  test("the local restart happens AFTER the push, so the running lead has nothing newer to race with", async () => {
    const h = harness();
    await cmdPackDeputy(h.deps, ["nas"]);
    // Both pushes are on the wire before the line announcing the local restart is printed.
    expect(h.pushed).toHaveLength(2);
    const said = h.io.stdout;
    const restartLine = said.findIndex((l) => l.includes("restarting the bridge"));
    const planLine = said.findIndex((l) => l.includes("will restart collie at"));
    expect(restartLine).toBeGreaterThan(-1);
    // …and before the ssh phase, which is what the plan lines mark.
    expect(planLine).toBeGreaterThan(restartLine);
  });
});

// ── Re-running is a retry, not a change (RFC §4.4 vs. the operator's reality) ─

describe("a re-run re-syncs rather than minting", () => {
  test("naming the standing deputy again keeps the generation and re-pushes it", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("already this pack's deputy at warrant generation 1");
    expect(h.pushed.every((p) => p.warrant?.generation === 1)).toBe(true);
  });

  test("a re-run after fixing the ssh record completes the anchoring the first run could not", async () => {
    // First run: `attic` has no route, so it is stored-not-anchored.
    const first = harness({ ops: { nas: opsRecord("nas.example") } });
    await cmdPackDeputy(first.deps, ["nas"]);
    const armed = parsePackOps(first.ops.contents()!)!.members;
    expect(armed.attic).toBeUndefined();

    // Second run, with the route taught: only the machine that is still behind is restarted.
    const second = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }), attic: opsRecord("attic.example") },
    });
    expect(await cmdPackDeputy(second.deps, ["nas"])).toBe(EXIT.OK);
    expect(legs(second)).toEqual(["attic.example:probe", "attic.example:restart"]);
    expect(text(second.io)).toContain("nas: warrant stored, already armed for this generation");
    expect(parsePackOps(second.ops.contents()!)?.members.attic?.anchoredGeneration).toBe(1);
  });

  test("a fully armed pack re-run asks nothing and restarts nothing", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: {
        nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }),
        attic: opsRecord("attic.example", { anchoredGeneration: 1, anchoredAt: T0 }),
      },
    });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.confirms).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  // ── THE LIVE DRILL, BUG 5 (§18.17) ────────────────────────────────────────
  // The record only moves when THIS verb's own restart leg completes, so a machine restarted by an
  // update, by its unit, or by a hand on a keyboard was armed and unrecorded — and a re-run offered
  // to restart a pack that was already fully armed. It asks the machines now.
  test("the drill's sequence: warrant stored, restarted OUT OF BAND — the re-run asks nothing and exits 0", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      // Nothing in this file has ever seen either machine armed…
      ops: { nas: opsRecord("nas.example"), attic: opsRecord("attic.example") },
      hello: { nas: 1, attic: 1 },
      // …and both listeners came up holding the current generation regardless.
      active: { nas: 1, attic: 1 },
    });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    // Nothing asked, nothing probed over ssh, nothing restarted.
    expect(h.confirms).toEqual([]);
    expect(h.calls).toEqual([]);
    expect(text(h.io)).toContain("that machine reports it active");
    // …and the record catches up, so the OFFLINE view stops disagreeing with the live one.
    const members = parsePackOps(h.ops.contents()!)!.members;
    expect(members.nas?.anchoredGeneration).toBe(1);
    expect(members.attic?.anchoredGeneration).toBe(1);
    // A refresh, never a creation: the ssh route the operator typed is untouched.
    expect(members.nas?.sshHost).toBe("nas.example");
  });

  test("a machine reporting an OLDER activation is still restarted — the report cuts both ways", async () => {
    const h = harness({
      store: withWarrant(withWarrant(twoPeers(), "nas"), "nas", T0 + 1000),
      ops: {
        nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }),
        attic: opsRecord("attic.example", { anchoredGeneration: 2, anchoredAt: T0 }),
      },
      hello: { nas: 2, attic: 2 },
      // `attic`'s RECORD claims generation 2, and `attic` itself says its listener holds 1.
      active: { nas: 1, attic: 1 },
    });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    // `nas` is behind on the record AND on its report, so it is restarted. `attic` is skipped by the
    // record check above, which is untouched — this verb never demotes a record it already trusts.
    expect(legs(h)).toEqual(["nas.example:probe", "nas.example:restart"]);
  });
});

// ── Revocation (RFC §4.4) ────────────────────────────────────────────────────

describe("pack deputy --revoke", () => {
  test("mints a generation naming NOBODY and pushes it — an absence would prove nothing", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    expect(await cmdPackDeputy(h.deps, ["--revoke"])).toBe(EXIT.OK);
    expect(h.pushed).toHaveLength(2);
    for (const push of h.pushed) {
      expect(push.warrant?.generation).toBe(2);
      expect(push.warrant?.deputyMemberId).toBeNull();
      expect(push.certPem).toBeNull();
    }
    expect(text(h.io)).toContain("names NOBODY");
  });

  test("revoking nothing is not an error — the operator asked for a state that already holds", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, ["--revoke"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("nothing was revoked");
    expect(h.pushed).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("offers the same restart batch — a stored revocation is inert at the listener too", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    await cmdPackDeputy(h.deps, ["--revoke"]);
    expect(h.confirms[0]).toBe("restart collie on nas, attic to retire the old deputy's anchor? [y/N]");
    expect(legs(h)).toEqual(["nas.example:probe", "attic.example:probe", "nas.example:restart", "attic.example:restart"]);
  });

  test("names the peers still anchoring the old deputy when they could not be restarted", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas"), ops: {} });
    expect(await cmdPackDeputy(h.deps, ["--revoke"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("still anchoring the old deputy until they restart: nas, attic");
    expect(h.calls).toEqual([]);
  });
});

// ── `pack status`, the lead's view (RFC §10, §5) ─────────────────────────────

describe("pack status on the lead", () => {
  test("names the deputy, its generation and how long ago it was refreshed", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas"), now: T0 + 240_000, hello: { nas: 1, attic: 1 } });
    expect(await cmdPackStatus(h.deps, [])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("deputy nas — warrant generation 1, refreshed 4m ago");
  });

  test("a lead with peers and no deputy says so — a takeover leaves exactly that state", async () => {
    const h = harness({ hello: { nas: null, attic: null } });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("deputy none — no peer may take over");
  });

  test("a member that holds the current generation and was armed reads as stored AND anchored", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }) },
      hello: { nas: 1, attic: 1 },
    });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("warrant generation 1 — stored and anchored");
  });

  test("a member that stored it but was never restarted is the exact `anchor INACTIVE` shape", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas"), ops: {}, hello: { nas: 1, attic: 1 } });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("warrant stored, anchor INACTIVE — restart nas");
    expect(text(h.io)).toContain("warrant stored, anchor INACTIVE — restart attic");
  });

  // ── THE LIVE DRILL, BUG 5 (§18.17) ────────────────────────────────────────
  // The lead told the operator to restart a deputy whose own `pack status` read `deputy role ACTIVE
  // at this boot`. The two surfaces had different evidence: the machine knew, and the lead was
  // reading a file that only its own restart leg ever writes. It asks the machine now.
  test("a member that reports the generation ACTIVE is armed, whoever restarted it", async () => {
    const h = harness({
      // No ops record for either machine: nothing here has ever restarted them.
      store: withWarrant(twoPeers(), "nas"),
      ops: {},
      hello: { nas: 1, attic: 1 },
      active: { nas: 1, attic: 1 },
    });
    await cmdPackStatus(h.deps, []);
    const said = text(h.io);
    // The role picks the word, and the lead knows the role from its own warrant.
    expect(said).toContain("stored, and its deputy role is ACTIVE (that machine reports it)");
    expect(said).toContain("stored, and anchored (that machine reports it)");
    expect(said).not.toContain("anchor INACTIVE");
  });

  test("a report BEHIND the issued generation stays INACTIVE, even against a record that claims it", async () => {
    const h = harness({
      store: withWarrant(withWarrant(twoPeers(), "nas"), "nas", T0 + 1000),
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 2, anchoredAt: T0 }) },
      hello: { nas: 2, attic: 2 },
      active: { nas: 1, attic: 1 },
    });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("warrant stored, anchor INACTIVE — restart nas");
  });

  test("a confirmed activation is written back, so `--no-probe` stops disagreeing with the probe", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: { nas: opsRecord("nas.example"), attic: opsRecord("attic.example") },
      hello: { nas: 1, attic: 1 },
      active: { nas: 1, attic: 1 },
      now: T0 + 5000,
    });
    await cmdPackStatus(h.deps, []);
    const members = parsePackOps(h.ops.contents()!)!.members;
    expect(members.nas?.anchoredGeneration).toBe(1);
    expect(members.nas?.anchoredAt).toBe(T0 + 5000);
    // A refresh, never a creation — the route the operator typed is what makes a record exist.
    expect(members.nas?.sshHost).toBe("nas.example");
  });

  test("a member with no ops record gains none — an anchor with no ssh route invents a field", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: {},
      hello: { nas: 1, attic: 1 },
      active: { nas: 1, attic: 1 },
    });
    await cmdPackStatus(h.deps, []);
    expect(parsePackOps(h.ops.contents() ?? "{}")?.members.nas).toBeUndefined();
  });

  test("a member a generation behind is named as behind, not as unarmed", async () => {
    const h = harness({ store: withWarrant(withWarrant(twoPeers(), "nas"), "attic"), hello: { nas: 1, attic: 2 } });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("warrant generation 1 — BEHIND this lead's 2");
  });

  test("an ops record that outruns the peer's own report is rendered STALE, never as anchored", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      // The record says this operator armed generation 1 there; the machine says it holds nothing.
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }) },
      hello: { nas: null, attic: null },
    });
    await cmdPackStatus(h.deps, []);
    const said = text(h.io);
    expect(said).toContain("anchor  RECORD IS STALE — this machine armed generation 1 there, but it reports none at all");
    expect(said).not.toContain("stored and anchored");
  });

  test("a member BEHIND the current generation cannot have anchored it, and the record is called out", async () => {
    const h = harness({
      store: withWarrant(withWarrant(twoPeers(), "nas"), "attic"),
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 2, anchoredAt: T0 }) },
      hello: { nas: 1, attic: 2 },
    });
    await cmdPackStatus(h.deps, []);
    const said = text(h.io);
    expect(said).toContain("warrant generation 1 — BEHIND this lead's 2");
    expect(said).toContain("RECORD IS STALE — this machine armed generation 2 there, but it reports generation 1");
  });

  test("a record level with the peer's report is not stale — the honest case says nothing extra", async () => {
    const h = harness({
      store: withWarrant(twoPeers(), "nas"),
      ops: { nas: opsRecord("nas.example", { anchoredGeneration: 1, anchoredAt: T0 }) },
      hello: { nas: 1, attic: 1 },
    });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).not.toContain("RECORD IS STALE");
  });

  test("a member that reports no generation is a capability gap, stated as one", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas"), hello: { nas: null, attic: null } });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain("warrant reports none — this build predates warrants");
  });

  test("an unreachable deputy is the warning RFC §5 asks for, and names the remedy", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas"), hello: { nas: false, attic: 1 } });
    await cmdPackStatus(h.deps, []);
    expect(text(h.io)).toContain('⚠ deputy "nas" is unreachable — appoint another with `collie pack deputy <member>`');
  });

  test("--no-probe suppresses that warning — nothing answered because nothing was asked", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("is unreachable — appoint another");
  });
});

// ── §10.2's fourth state, rendered (RFC §10.2, §18.10) ──────────────────────

describe("a peer that follows another lead", () => {
  test("renders as a named conflict, never as a generic unreachable", () => {
    expect(
      failureLine({
        ok: false,
        state: "conflicted",
        reason: 'this collie follows lead "nas" since warrant generation 7',
        leadMemberId: "nas",
        warrantGeneration: 7,
        warrant: null,
        receivedAt: 0,
      }),
    ).toBe('this peer follows another lead "nas" (warrant generation 7)');
  });

  test("a conflict that reported no generation still names the lead", () => {
    expect(
      failureLine({
        ok: false,
        state: "conflicted",
        reason: "follows someone else",
        leadMemberId: "nas",
        warrantGeneration: null,
        warrant: null,
        receivedAt: 0,
      }),
    ).toBe('this peer follows another lead "nas"');
  });
});

// ── `pack status`, the peer's view (RFC §10.1, §5) ───────────────────────────

/** A peer's store holding a warrant its lead signed — the shape `POST /pack/v1/warrant` leaves. */
function peerHolding(deputy: string, at = T0): TrustStoreData {
  const lead = withWarrant(
    leadStore({ peers: [member({ memberId: "laptop" }), member({ memberId: deputy })] }),
    deputy,
    at,
  );
  return peerStore({ warrant: { warrant: lead.warrant!.warrant, deputyCertPem: material(deputy).certPem } });
}

describe("pack status on a peer", () => {
  test("prints when its lead last called it, from the running process's own receipt", async () => {
    const data = peerHolding("nas");
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0 + 6_000 }),
      now: T0 + 10_000,
      hello: { nas: 1 },
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("lead   desk — last called 4s ago");
  });

  test("past the arming threshold it says the lead has NOT called, and for how long", async () => {
    const data = peerHolding("nas");
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0 + 1_000 }, { checkpointedAt: T0 + 60_000 }),
      now: T0 + 61_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("lead   desk — has not called for 60s");
  });

  test("a receipt does not survive a restart, so a fresh process says exactly that", async () => {
    const data = peerHolding("nas");
    const h = harness({ store: data, files: marker(data, {}, { bootedAt: T0 + 5_000, checkpointedAt: T0 + 20_000 }), now: T0 + 20_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("has not called since this collie started 15s ago");
  });

  test("a checkpoint nothing has refreshed reads as a bridge that is not running", async () => {
    const data = peerHolding("nas");
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 600_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("no bridge is running here (last checkpoint 10m ago)");
  });

  test("the SECRET refusal is named as §8.4's rotation, never as silence", async () => {
    const data = peerHolding("nas");
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0, leadRefusedSecretAt: T0 + 4_000 }),
      now: T0 + 10_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("refused on the pack SECRET 6s ago");
    expect(text(h.io)).toContain("collie join");
  });

  test("a stored warrant whose anchor this boot built reads as anchored", async () => {
    const data = peerHolding("nas");
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0, anchoredGeneration: 1 }),
      now: T0 + 1_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain('warrant generation 1 — deputy "nas"');
    expect(text(h.io)).toContain("verified · anchored at this boot");
  });

  test("a stored warrant this process never anchored names the restart that would arm it", async () => {
    const data = peerHolding("nas");
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("verified · stored, NOT anchored");
    expect(text(h.io)).toContain("herdr plugin action invoke restart");
  });

  test("the deputy itself is told it is the deputy", async () => {
    const data = peerHolding("laptop");
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("THIS machine is the deputy");
  });

  test("a warrant that does not verify against the pinned lead is called out, never trusted", async () => {
    const data = peerHolding("nas");
    const forged: TrustStoreData = {
      ...data,
      warrant: { warrant: { ...data.warrant!.warrant, generation: 9 }, deputyCertPem: data.warrant!.deputyCertPem },
    };
    const h = harness({ store: forged, files: marker(forged, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain('NOT VERIFIED against lead "desk"');
  });

  test("a peer holding a revocation says the pack names nobody, and that its anchor lingers", async () => {
    const lead = withWarrant(withWarrant(twoPeers(), "nas"), null);
    const data = peerStore({ warrant: { warrant: lead.warrant!.warrant, deputyCertPem: null } });
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0, anchoredGeneration: 1 }),
      now: T0 + 1_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("REVOKED: this pack names no deputy");
    expect(text(h.io)).toContain("still anchors the deputy it was built with");
  });

  test("a peer that holds no warrant says so rather than staying quiet", async () => {
    const data = peerStore();
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("warrant none — this collie holds no warrant");
  });
});

// ── `pack status` on a machine that was deposed (RFC §8.2, §8.3) ─────────────

describe("pack status on a deposed machine", () => {
  const deposed = (outcome: "healed" | "parked-unverifiable" | "parked-rotated", reason: null | "unknown-deputy") => ({
    outcome,
    leadMemberId: "nas",
    generation: 3,
    at: T0,
    packName: "the herd",
    reason,
  });

  test("says so loudly, names the new lead, and states the self-heal it is performing", async () => {
    const data = peerStore();
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0, deposed: deposed("healed", null) }),
      now: T0 + 1_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain('⚠ DEPOSED — this machine led pack "the herd" until 2025-07-31T22:13:20.000Z.');
    expect(said).toContain('The pack is now led by "nas" (warrant generation 3).');
    expect(said).toContain("rejoined the pack as a peer");
  });

  test("a terminal park names WHICH check failed, in the same words the page uses", async () => {
    const data = peerStore();
    const h = harness({
      store: data,
      files: marker(data, { deposed: deposed("parked-unverifiable", "unknown-deputy") }),
      now: T0 + 1_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("its roster holds no certificate matching the warrant");
    expect(text(h.io)).toContain("collie pack add");
  });

  test("stranded by a rotation is named as that, never as a self-heal that went wrong", async () => {
    const data = peerStore();
    const h = harness({
      store: data,
      files: marker(data, { deposed: deposed("parked-rotated", null) }),
      now: T0 + 1_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("the pack secret was rotated while it was away");
  });

  test("a machine that was never deposed prints none of it", async () => {
    const data = peerStore();
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("DEPOSED");
  });
});

// ── RFC §6.4 and §16 decision 4: what `pack deputy` will not do, and what it warns about ──

describe("pack deputy and the credential the door would check (RFC §6.4)", () => {
  test("a lead with nothing paired is REFUSED, and the remedy is `collie pair`", async () => {
    const h = harness({ paired: [] });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.STATE);
    const said = text(h.io);
    expect(said).toContain("no paired device, so a deputy's standby door could never arm");
    expect(said).toContain("collie pair");
    // Nothing was minted, written or sent — the refusal is before the first side effect.
    expect(h.pushed).toEqual([]);
    expect(h.restarts).toEqual([]);
    expect(h.calls).toEqual([]);
  });

  test("one paired device is enough — the gate is presence, exactly as `enforced()` is", async () => {
    const h = harness({ paired: ["phone"] });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.pushed).toHaveLength(2);
  });

  test("--revoke is never refused by it: the un-doing must work on any pack", async () => {
    const h = harness({ paired: [], store: withWarrant(twoPeers(), "nas") });
    expect(await cmdPackDeputy(h.deps, ["--revoke"])).toBe(EXIT.OK);
    expect(text(h.io)).toContain("names NOBODY");
  });
});

describe("pack deputy says the same-origin prerequisite once (RFC §16, decision 4)", () => {
  test("with no shared origin configured it WARNS, names what is lost, and refuses nothing", async () => {
    const h = harness();
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    const said = text(h.io);
    expect(said).toContain("COLLIE_PUBLIC_URL is unset here, so this machine knows of no shared origin");
    expect(said).toContain("per-origin");
    // The fallback is named rather than implied: this pack keeps everything but the phone-first half.
    expect(said).toContain("collie promote");
  });

  test("a lead behind one origin is not lectured about it", async () => {
    const h = harness({ env: { COLLIE_PUBLIC_URL: "https://collie.example.com" } });
    expect(await cmdPackDeputy(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).not.toContain("no shared origin");
  });

  test("a revocation says nothing about origins — there is no door left to reach", async () => {
    const h = harness({ store: withWarrant(twoPeers(), "nas") });
    expect(await cmdPackDeputy(h.deps, ["--revoke"])).toBe(EXIT.OK);
    expect(text(h.io)).not.toContain("no shared origin");
  });
});

// ── `pack status` on the deputy: its own door (RFC §6.2, §6.3, §10.1) ────────

/** The registry the lead has synced here (RFC §6.5), as `standby-devices.json` holds it. */
function syncedFiles(labels: readonly string[]): SeededFiles {
  const devices = labels.map((label, i) => ({ label, tokenHash: String(i).repeat(64), createdAt: T0 }));
  const file = { version: 1, packId: "pack-1", leadMemberId: "desk", syncedAt: T0, devices };
  return { [`${STATE}/standby-devices.json`]: `${JSON.stringify(file, null, 2)}\n` };
}

/** The deputy itself — `laptop` is `peerStore`'s own id — with a live marker and a scripted silence. */
function deputyAt(opts: { silentMs?: number; devices?: readonly string[]; env?: Record<string, string> } = {}) {
  const data = peerHolding("laptop");
  const silent = opts.silentMs ?? 0;
  return harness({
      store: data,
      files: {
        ...marker(data, { leadLastDialledAt: T0, anchoredGeneration: 1 }, { checkpointedAt: T0 + silent }),
        ...syncedFiles(opts.devices ?? ["phone"]),
      },
      now: T0 + silent,
      env: { COLLIE_STANDBY_PORT: "8788", ...opts.env },
  });
}

describe("pack status prints the deputy's own arming state", () => {
  test("cold: the door's own sentence, not a second wording of it", async () => {
    const h = deputyAt({ silentMs: 4_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("standby door — cold on :8788 · arms after 30 seconds of silence");
    expect(said).toContain("it is alive");
  });

  test("armed: it says so, and says how long the lead has been silent", async () => {
    const h = deputyAt({ silentMs: 61_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("standby door — ARMED on :8788 · silent for 61 seconds");
    // Arming grants nothing, and the line must not read like something has happened.
    expect(said).toContain("the lead's next landed call disarms it");
  });

  test("an EMPTY synced registry refuses to arm, and the line names the remedy", async () => {
    const h = deputyAt({ silentMs: 61_000, devices: [] });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("standby door — cold on :8788");
    expect(said).toContain("Run `collie pair` on the lead");
    expect(said).not.toContain("ARMED");
  });

  test("no port is no door at all — RFC §6.2's absent-means-closed, said out loud", async () => {
    const h = deputyAt({ silentMs: 61_000, env: { COLLIE_STANDBY_PORT: "" } });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("standby door — CLOSED: COLLIE_STANDBY_PORT is unset");
    expect(said).toContain("collie promote");
  });

  test("the threshold is the FORMULA — a relaxed idle poll moves this line with it (§10.1)", async () => {
    const h = deputyAt({ silentMs: 4_000, env: { COLLIE_POLL_IDLE_MS: "24000" } });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("arms after 60 seconds of silence");
  });

  test("an override at or below the idle poll is warned about, in the door's own words", async () => {
    const h = deputyAt({ silentMs: 4_000, env: { COLLIE_STANDBY_ARM_MS: "5000", COLLIE_POLL_IDLE_MS: "12000" } });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("will arm itself on an idle pack");
  });

  test("a peer that is NOT the deputy has no door, and prints none", async () => {
    const data = peerHolding("nas");
    const h = harness({
      store: data,
      files: marker(data, { leadLastDialledAt: T0 }),
      now: T0 + 61_000,
      env: { COLLIE_STANDBY_PORT: "8788" },
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("standby door");
  });

  test("no live bridge means no verdict — an arming line off a dead process would be a lie", async () => {
    const data = peerHolding("laptop");
    const h = harness({
      store: data,
      files: { ...marker(data, { leadLastDialledAt: T0 }), ...syncedFiles(["phone"]) },
      now: T0 + 600_000,
      env: { COLLIE_STANDBY_PORT: "8788" },
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("configured on :8788, but no bridge is running here to bind it");
    expect(said).not.toContain("ARMED");
  });
});

// ── `pack status` on the lead: the refused pairing sync (RFC §6.5, §18.14) ───

describe("pack status names a pairing LABEL CLASH at the deputy", () => {
  // ── THE LIVE DRILL, THE REVOCATION ─────────────────────────────────────────
  // This used to read "pairing sync REFUSED", and the sync really was refused — which froze the
  // deputy's copy, so a device revoked on the lead stayed valid at that machine's standby door. The
  // sync lands now; what the clash blocks is the TAKEOVER, and the words have to say which.
  test("it names the labels, what it actually blocks, and how to free the name", async () => {
    const data = withWarrant(twoPeers(), "nas");
    const h = harness({
      store: data,
      files: marker(data, { pairingCollision: { at: T0 + 1_000, labels: ["phone"] } }),
      now: T0 + 6_000,
    });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain('⚠ pairing LABEL CLASH (seen 5s ago) — the deputy already has "phone"');
    // The credential half is HEALTHY and must not read as broken — that is the whole correction.
    expect(said).toContain("The sync itself is landing");
    expect(said).toContain("What");
    expect(said).toContain("this blocks is the TAKEOVER");
    expect(said).not.toContain("REFUSED");
    expect(said).toContain("collie devices");
  });

  test("a lead whose last sync landed says nothing about collisions", async () => {
    const data = withWarrant(twoPeers(), "nas");
    const h = harness({ store: data, files: marker(data), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("pairing sync REFUSED");
  });
});

// ── `pack status` on a NEW lead: the members it has not told (RFC §7.1, §9) ──

describe("pack status renders the pending re-pins a takeover left behind", () => {
  const tookOver = (over: Partial<TrustedMember> = {}): TrustStoreData =>
    leadStore({ peers: [member({ memberId: "desk", rePinPending: true, ...over }), member({ memberId: "attic" })] });

  test("a member still owed the proof is a row, and it names NO step to run", async () => {
    const data = tookOver();
    const h = harness({ store: data, files: marker(data), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    const said = text(h.io);
    expect(said).toContain("re-pin  PENDING — this member has not been told the crown moved");
    expect(said).toContain("There is no step to run");
    expect(said).toContain("clears the row by itself");
  });

  test("the row survives `--no-probe`: the member most likely to be pending is the unreachable one", async () => {
    const data = tookOver();
    const h = harness({ store: data, files: marker(data), now: T0 + 1_000, hello: { attic: 1 } });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).toContain("re-pin  PENDING");
  });

  test("a member that WAS told carries no row, and neither does one from before the field", async () => {
    const data = tookOver({ rePinPending: false });
    const h = harness({ store: data, files: marker(data), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("re-pin");

    const old = leadStore({ peers: [member({ memberId: "desk" })] });
    const g = harness({ store: old, files: marker(old), now: T0 + 1_000 });
    await cmdPackStatus(g.deps, ["--no-probe"]);
    expect(text(g.io)).not.toContain("re-pin");
  });

  test("a PEER prints none of it — it has no roster to owe anything to", async () => {
    const data = peerStore();
    const h = harness({ store: data, files: marker(data, { leadLastDialledAt: T0 }), now: T0 + 1_000 });
    await cmdPackStatus(h.deps, ["--no-probe"]);
    expect(text(h.io)).not.toContain("re-pin");
  });
});
