import { describe, expect, test } from "bun:test";

import { AuditLog, type AuditEntry } from "../bridge/audit.ts";
import { PACK_PROTOCOL_VERSION } from "../bridge/pack/enrollment.ts";
import { leadStore, material, member, peerStore, T0 } from "../bridge/pack/fixtures.ts";
import { type OpsRecord, parsePackOps } from "../bridge/pack/ops-store.ts";
import { serializeTrustStore, TrustStore, type TrustStoreData, type TrustStoreIo } from "../bridge/pack/trust-store.ts";
import { UPDATE_RUN_SCHEMA, type UpdateRun } from "../bridge/update-run.ts";
import { capture, context, fakeExec, fakeFiles, fakeOps, ROOT, type SeededFiles, type SeededOps } from "./fakes.ts";
import { EXIT } from "./io.ts";
import type { PackUpdateRow } from "../bridge/update-action.ts";
import { answersThisBuild, cmdPackUpdate, peerReportLines, type PackUpdateDeps } from "./pack-update.ts";
import type { RemoteResult } from "./remote.ts";
import { PREFLIGHT_SCHEMA, type PreflightCheck, type PreflightReport } from "./update-check.ts";

// `collie pack update` against fakes for every seam. NOTHING here spawns `ssh`, dials a network or
// touches a disk: the transport records `(host, script)` pairs and answers from a table, the one
// confirmation is a value, and both stores are in memory. Same safety boundary `cli/remote.test.ts`
// draws for `pack add` — a verb that rebuilds software on other people's machines is exactly the one
// a test suite must never be able to run for real.

type Leg = "probe" | "install" | "restart" | "status";

/** Which leg a script is, read off the script itself — never off call ordering. */
function legOf(script: string): Leg {
  if (script.includes("collie-probe:")) return "probe";
  if (script.includes("collie-install:")) return "install";
  if (script.includes('"$ROOT/bin/collie" restart')) return "restart";
  if (script.includes("update --status --json")) return "status";
  throw new Error(`unrecognised leg script:\n${script}`);
}

const COMMIT = "abc123def4567890abc123def4567890abc123de";
/** How git abbreviates {@link COMMIT} here — the build stamp's `+<sha>` half. */
const SHORT = "abc123d";
const OLD_COMMIT = "0000feed0000feed0000feed0000feed0000feed";
const VERSION = "1.2.3";
const OLD_VERSION = "1.2.2";
const CHECKOUT = "/home/pat/.collie";

const PROBE_DEFAULTS = {
  home: "/home/pat",
  git: "/usr/bin/git",
  bun: "/home/pat/.bun/bin/bun",
  herdr: "/usr/local/bin/herdr",
  configdir: "/home/pat/.config/herdr/plugins/config/herdr.collie",
  envhost: "",
  envport: "",
  checkout: CHECKOUT,
  commit: OLD_COMMIT,
  branch: "",
  dirty: "no",
  dirtyfiles: "",
  version: OLD_VERSION,
  address: "100.64.0.9",
  port: "busy",
} satisfies Record<string, string>;

function probeOut(over: Record<string, string> = {}): string {
  const all = { ...PROBE_DEFAULTS, ...over };
  return [...Object.entries(all).map(([k, v]) => `collie-probe:${k}=${v}`), "collie-probe:probe=ok", ""].join("\n");
}

interface Recorded {
  host: string;
  leg: Leg;
  script: string;
}

interface HarnessOptions {
  store?: TrustStoreData | null;
  /** Seeded ops records, by member id. Absent ⇒ that member has no remembered ssh host. */
  ops?: SeededOps;
  /** Per-host probe field overrides. */
  probes?: Record<string, Record<string, string>>;
  /** Per-host, per-leg canned results. */
  answers?: Record<string, Partial<Record<Leg, Partial<RemoteResult>>>>;
  confirm?: boolean | null;
  /** The preflight the gate reads. Absent ⇒ nothing red anywhere. */
  preflight?: PreflightReport;
  /** What the running bridge banked off the pack link (§19). Absent ⇒ it knows nothing. */
  peerReported?: readonly PackUpdateRow[];
  /** What this LEAD answers with. Absent ⇒ the build being pushed, so the lead is not behind. */
  leadVersion?: string;
  /** This lead's own update: what `start` returns, and the records its runner writes, in order. */
  lead?: { start?: number; records?: readonly (UpdateRun | null)[] };
  /** Which members answer `hello`, and with which version. `false` ⇒ it does not answer at all. */
  hello?: Record<string, string | false>;
  bundle?: string | null;
}

function opsRecord(sshHost: string): OpsRecord {
  return { sshHost, path: CHECKOUT, port: 8787, recordedAt: T0 };
}

function harness(opts: HarnessOptions = {}) {
  const initial =
    opts.store === undefined
      ? leadStore({ peers: [member({ memberId: "nas", address: "100.64.0.9:8787" })] })
      : opts.store;
  let contents = initial === null ? null : serializeTrustStore(initial);
  const storeIo: TrustStoreIo = {
    read: async () => contents,
    write: async (_p, d) => {
      contents = d;
    },
  };
  const out = capture();
  const calls: Recorded[] = [];
  // Everything that happens on a machine, in the order it happened — the ssh legs AND the lead's own
  // update, which is what "lead first" is asserted against.
  const events: string[] = [];
  const audit: AuditEntry[] = [];
  const confirms: string[] = [];
  const ops = fakeOps(opts.ops ?? { nas: opsRecord("nas.example") });
  let reads = 0;

  // The build stamp is what `collieVersionBare` answers with, so it is what decides whether this
  // lead is behind the commit it is about to hand out.
  const seeded: SeededFiles = { [`${ROOT}/herdr-plugin.toml`]: `id = "herdr.collie"\nversion = "${VERSION}"\n` };
  if (opts.leadVersion !== undefined) {
    seeded[`${ROOT}/web/dist/build-info.json`] = JSON.stringify({ version: opts.leadVersion });
  }

  const exec = fakeExec({
    answers: [
      [`git -C ${ROOT} rev-parse HEAD`, { stdout: `${COMMIT}\n` }],
      [`git -C ${ROOT} rev-parse --short ${COMMIT}`, { stdout: `${SHORT}\n` }],
      [`git -C ${ROOT} status --porcelain`, { stdout: "" }],
      [`git -C ${ROOT} show ${COMMIT}:herdr-plugin.toml`, { stdout: `version = "${VERSION}"\n` }],
    ],
  });

  const deps: PackUpdateDeps = {
    // The same reason the other pack suites set it: `PeerClient`'s REAL `setTimeout` must never fire
    // and report a fake member as unreachable.
    ctx: context({ COLLIE_PACK_TIMEOUT_MS: "60000" }),
    io: out,
    exec,
    files: fakeFiles(seeded),
    store: new TrustStore("/state", storeIo),
    ops,
    // SAFETY: `AuditLog` hands its sink the line it just serialised from an `AuditEntry` — the
    // log's own round trip, not foreign input.
    audit: new AuditLog((l: string) => void audit.push(JSON.parse(l) as AuditEntry), { now: () => T0 }),
    fetch: async (url) => {
      // Every dial in this verb is a `hello` at a member's own address; the member is named by it.
      const who = Object.keys(opts.hello ?? {}).find((id) => url.includes(addressOf(initial, id))) ?? "nas";
      const answer = opts.hello?.[who];
      if (answer === false) throw new Error("connection refused");
      const version = answer ?? VERSION;
      return new Response(JSON.stringify({ protocol: PACK_PROTOCOL_VERSION, member: who, version }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-pack-protocol": String(PACK_PROTOCOL_VERSION),
          "x-pack-member": who,
        },
      });
    },
    now: () => T0,
    random: () => "r",
    mintIdentity: () => Promise.resolve(material("fresh")),
    readStdin: () => Promise.resolve(""),
    restart: () => Promise.resolve(EXIT.OK),
    serve: () => Promise.resolve(EXIT.OK),
    unserve: () => EXIT.OK,
    clearNotifications: () => Promise.resolve(),
    preflight: () =>
      Promise.resolve(opts.preflight ?? { schema: PREFLIGHT_SCHEMA, verdict: "green", checks: [] }),
    peerReported: () => Promise.resolve(opts.peerReported ?? []),
    lead: {
      start: () => {
        events.push("lead");
        return Promise.resolve(opts.lead?.start ?? EXIT.OK);
      },
      record: () => {
        const records = opts.lead?.records ?? [run("done")];
        return records[Math.min(reads++, records.length - 1)] ?? null;
      },
    },
    // Every wait in this verb is a poll interval, and no test may spend one.
    sleep: () => Promise.resolve(),
    remote: (host) => ({
      run: async (script) => {
        const leg = legOf(script);
        calls.push({ host, leg, script });
        events.push(`${host}:${leg}`);
        const stdout =
          leg === "probe"
            ? probeOut(opts.probes?.[host] ?? {})
            : leg === "install"
              ? `collie-install:root=${CHECKOUT}\ncollie-install:version=${VERSION}`
              : "";
        return { code: 0, stdout, stderr: "", spawned: true, ...opts.answers?.[host]?.[leg] };
      },
      close: () => {},
    }),
    confirm: (question) => {
      confirms.push(question);
      return opts.confirm === undefined ? true : opts.confirm;
    },
    prompt: () => null,
    gitBundle: () => Promise.resolve(opts.bundle === undefined ? "QkFTRTY0LWJ1bmRsZQ==" : opts.bundle),
    reload: () => Promise.resolve(initial),
  };

  return { deps, io: out, calls, confirms, ops, events };
}

/** One update record, as the lead's runner would have written it. */
function run(state: UpdateRun["state"], over: Partial<UpdateRun> = {}): UpdateRun {
  return {
    schema: UPDATE_RUN_SCHEMA,
    state,
    from: OLD_VERSION,
    to: VERSION,
    startedAt: T0,
    updatedAt: T0,
    pid: 4242,
    attempt: 0,
    ...over,
  };
}

const redCheck = (id: string, reason: string, remedy?: string): PreflightCheck =>
  remedy === undefined ? { id, verdict: "red", reason } : { id, verdict: "red", reason, remedy };

/** A preflight that is red on one member and green everywhere else. */
function redOn(memberId: string, check: PreflightCheck): PreflightReport {
  return {
    schema: PREFLIGHT_SCHEMA,
    verdict: "red",
    checks: [],
    pack: [{ memberId, host: `${memberId}.example`, verdict: "red", checks: [check] }],
  };
}

/** A member's address in a fixture store — what the fake `fetch` matches a dial against. */
function addressOf(data: TrustStoreData | null, memberId: string): string {
  return data?.peers.find((p) => p.memberId === memberId)?.address ?? "nowhere";
}

const text = (io: ReturnType<typeof capture>): string => [...io.stdout, ...io.stderr].join("\n");
const legs = (h: ReturnType<typeof harness>): string[] => h.calls.map((c) => `${c.host}:${c.leg}`);

const twoPeers = () =>
  leadStore({
    peers: [
      member({ memberId: "nas", address: "100.64.0.9:8787" }),
      member({ memberId: "pi", address: "100.64.0.10:8787" }),
    ],
  });

// ── Who may run it, and on what ──────────────────────────────────────────────

describe("pack update is a lead's verb, over named members", () => {
  test("a solo collie has no peers to level, and is told what its own update is", async () => {
    const h = harness({ store: null });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("not in a pack");
    expect(text(h.io)).toContain("`collie update`");
    expect(h.calls).toEqual([]);
  });

  test("a peer refuses: peers are updated from the lead", async () => {
    const h = harness({ store: peerStore() });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain("peers are updated from the lead");
    expect(h.calls).toEqual([]);
  });

  test("a bare `pack update` is a usage error that LISTS the members — never a mass ssh", async () => {
    const h = harness({ store: twoPeers(), hello: { nas: "1.2.2", pi: VERSION } });
    expect(await cmdPackUpdate(h.deps, [])).toBe(EXIT.USAGE);
    const rendered = text(h.io);
    expect(rendered).toContain("usage: collie pack update");
    expect(rendered).toContain("nas  1.2.2");
    expect(rendered).toContain(`pi  ${VERSION} — current`);
    expect(h.calls).toEqual([]);
  });

  test("`--all` with names is a usage error rather than a guess at which one wins", async () => {
    const h = harness();
    expect(await cmdPackUpdate(h.deps, ["--all", "nas"])).toBe(EXIT.USAGE);
    expect(h.calls).toEqual([]);
  });

  test("a member that is not in the roster is refused by name", async () => {
    const h = harness();
    expect(await cmdPackUpdate(h.deps, ["ghost"])).toBe(EXIT.STATE);
    expect(text(h.io)).toContain('no enrolled member "ghost"');
  });

  test("the lead is never a target — its own update is `collie update`", async () => {
    const h = harness();
    const self = (await h.deps.store.load())!.self.memberId;
    expect(await cmdPackUpdate(h.deps, [self])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("`collie update`");
    expect(h.calls).toEqual([]);
  });

  test("a route override describes one machine, so it refuses a multi-member run", async () => {
    const h = harness({ store: twoPeers(), ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") } });
    expect(await cmdPackUpdate(h.deps, ["--all", "--host", "elsewhere"])).toBe(EXIT.USAGE);
    expect(text(h.io)).toContain("--host/--path/--port describe ONE machine");
    expect(h.calls).toEqual([]);
  });
});

// ── The probe phase ──────────────────────────────────────────────────────────

describe("what the probe decides, before anything is sent", () => {
  test("a member with no ops record is skipped with the remedy, and does not fail the run", async () => {
    const h = harness({ ops: {} });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("no ssh record — run `collie pack add <host>` once to teach it");
    expect(rendered).toContain("nas         skipped");
    expect(h.calls).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  test("a member already at this commit is listed and left alone — no push, no prompt", async () => {
    const h = harness({ probes: { "nas.example": { commit: COMMIT, version: VERSION } } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(legs(h)).toEqual(["nas.example:probe"]);
    expect(h.confirms).toEqual([]);
    expect(text(h.io)).toContain(`already at ${VERSION}`);
    expect(text(h.io)).toContain("nas         current");
  });

  test("a dirty remote checkout is REFUSED per member, not prompted", async () => {
    const h = harness({ probes: { "nas.example": { dirty: "yes", dirtyfiles: "M bridge/index.ts " } } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain("has uncommitted changes");
    expect(rendered).toContain("will not");
    expect(legs(h)).toEqual(["nas.example:probe"]);
    expect(h.confirms).toEqual([]);
  });

  test("a machine with no Collie checkout is told to run `pack add`, not `pack update`", async () => {
    const h = harness({ probes: { "nas.example": { checkout: "" } } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("`collie pack add` installs the first");
    expect(legs(h)).toEqual(["nas.example:probe"]);
  });

  test("ssh that cannot reach a host fails that member and says it is a key problem when it is", async () => {
    const h = harness({
      answers: { "nas.example": { probe: { code: 255, stderr: "Permission denied (publickey)." } } },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("`ssh-add` your key");
    expect(text(h.io)).toContain("nas         FAILED");
  });
});

// ── The preflight gate ───────────────────────────────────────────────────────

describe("the preflight runs first, and one red aborts the whole run", () => {
  test("a red member aborts before a single machine is touched, naming it and the reason", async () => {
    const h = harness({
      preflight: redOn("nas", redCheck("disk", "203 MiB free at /home/pat/.collie", "free some space there")),
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain("error: the preflight is red on nas — 203 MiB free at /home/pat/.collie");
    expect(rendered).toContain("clear it with: free some space there");
    expect(rendered).toContain("Nothing was pushed, built or restarted");
    expect(h.calls).toEqual([]);
    expect(h.confirms).toEqual([]);
  });

  test("a red on the LEAD itself aborts too — it is one of the machines being updated", async () => {
    const h = harness({
      preflight: {
        schema: PREFLIGHT_SCHEMA,
        verdict: "red",
        checks: [redCheck("service", "no systemd user unit — an update would have nothing to restart")],
      },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("the preflight is red on this lead — no systemd user unit");
    expect(h.calls).toEqual([]);
  });

  test("a red about a member this run has no route to does not abort the members it can reach", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example") },
      hello: { nas: VERSION, pi: VERSION },
      preflight: redOn("pi", redCheck("ops-record", 'no ssh record for "pi"', "collie pack update pi --host <ssh-host>")),
    });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.OK);
    expect(legs(h)).toContain("nas.example:install");
  });

  // ── §19 — THE PEER-REPORTED VERDICT, BESIDE THE SSH ONE (M16/03) ───────────
  test("peer-reported preflight: the link's verdict is printed beside the walk's, dated", async () => {
    const h = harness({
      ops: { nas: opsRecord("nas.example") },
      hello: { nas: VERSION },
      peerReported: [
        { name: "nas", version: VERSION, verdict: "green", reasons: [], asOf: T0 - 6 * 60 * 60 * 1000 },
      ],
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    // The stamp is the MEMBER's, and it is shown: a green from six hours ago and a green from four
    // seconds ago are different claims.
    expect(text(h.io)).toContain("preflight: nas reports green over the link (as of 6h ago)");
  });

  test("peer-reported preflight: a disagreement is named, and the ssh walk still decides", async () => {
    const h = harness({
      ops: { nas: opsRecord("nas.example") },
      hello: { nas: VERSION },
      // The walk found nothing wrong; the member itself says it is red. Neither is silently preferred.
      peerReported: [
        {
          name: "nas",
          version: VERSION,
          verdict: "red",
          reasons: ["working tree has tracked changes: bridge/server.ts"],
          asOf: T0 - 30_000,
        },
      ],
      preflight: {
        schema: PREFLIGHT_SCHEMA,
        verdict: "green",
        checks: [],
        pack: [{ memberId: "nas", host: "nas.example", verdict: "green", checks: [] }],
      },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).toContain("preflight: nas reports red over the link — working tree has tracked changes");
    expect(rendered).toContain("they disagree: ssh says green, the link says red — this run follows the ssh walk");
    // Consent, ordering and abort behaviour are untouched: the run went ahead on the walk's verdict.
    expect(h.confirms).toHaveLength(1);
    expect(legs(h)).toContain("nas.example:install");
  });

  test("peer-reported preflight: a member the link knows nothing about prints nothing", () => {
    const rows: PackUpdateRow[] = [{ name: "pi", version: null, verdict: "green", reasons: [], asOf: T0 }];
    // `pi` is not a target of this run, so its row is not this run's business.
    expect(peerReportLines([], rows, new Set(["nas"]), T0)).toEqual([]);
    // And a member that has never produced a report says so rather than reading as checked.
    expect(
      peerReportLines([], [{ name: "nas", version: null, verdict: "unknown", reasons: [], asOf: null }], new Set(["nas"]), T0),
    ).toEqual(["preflight: nas reports unknown over the link (never checked there)"]);
  });

  test("a member the probe refuses aborts the run before anything is pushed", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") },
      probes: { "nas.example": { dirty: "yes", dirtyfiles: "M bridge/index.ts " } },
    });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.FAIL);
    expect(legs(h).filter((l) => l.endsWith("install"))).toEqual([]);
    expect(h.confirms).toEqual([]);
    expect(text(h.io)).toContain("the run stopped at nas");
  });
});

// ── The lead's own turn ──────────────────────────────────────────────────────

describe("the lead goes first", () => {
  test("a lead behind the build it is handing out takes it first, before any peer", async () => {
    const h = harness({ leadVersion: OLD_VERSION });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    // The probe is read-only; the first thing that CHANGES a machine is the lead's own update.
    expect(h.events).toEqual(["nas.example:probe", "lead", "nas.example:install", "nas.example:restart"]);
    expect(h.confirms[0]).toContain("this lead first");
    expect(text(h.io)).toContain(`this lead: ${OLD_VERSION} — it takes ${VERSION} first`);
  });

  test("a lead already running the build is not updated at all", async () => {
    const h = harness();
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.events).not.toContain("lead");
    expect(h.confirms[0]).not.toContain("this lead first");
  });

  test("the flow WAITS on the lead's record, and a rollback there stops the run", async () => {
    const h = harness({
      leadVersion: OLD_VERSION,
      lead: {
        records: [
          run("staging"),
          run("restarting"),
          run("rolled-back", { reason: "the service came back as 1.2.2", recovery: "collie update --rollback" }),
        ],
      },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain("this lead's own update ended as rolled-back");
    expect(rendered).toContain("recover with: collie update --rollback");
    expect(rendered).toContain("§7.1 tolerates version skew");
    // No peer was touched: the probe is the only thing that ran.
    expect(legs(h)).toEqual(["nas.example:probe"]);
    expect(text(h.io)).toContain("nas         skipped  not attempted — this lead's own update did not land");
  });

  test("a lead whose updater never settles stops the run rather than pushing anyway", async () => {
    const h = harness({ leadVersion: OLD_VERSION, lead: { records: [run("staging")] } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("this lead's own update did not finish");
    expect(legs(h)).toEqual(["nas.example:probe"]);
  });

  test("a lead whose update will not even start stops the run", async () => {
    const h = harness({ leadVersion: OLD_VERSION, lead: { start: EXIT.FAIL } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("this lead's own update would not start");
    expect(legs(h)).toEqual(["nas.example:probe"]);
  });
});

// ── The one consent ──────────────────────────────────────────────────────────

describe("consent is asked once, for the whole operation", () => {
  test("two behind members are one question, naming the build and both of them", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") },
      hello: { nas: VERSION, pi: VERSION },
    });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.OK);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0]).toContain(`update 2 members to ${VERSION}`);
    expect(h.confirms[0]).toContain("nas (1.2.2)");
    expect(h.confirms[0]).toContain("pi (1.2.2)");
  });

  test("the members that are NOT being touched are named in the same question", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example") },
      probes: { "nas.example": {} },
    });
    await cmdPackUpdate(h.deps, ["--all"]);
    expect(h.confirms[0]).toContain("without an ssh record");
  });

  test("no is no: nothing is pushed, built or restarted", async () => {
    const h = harness({ confirm: false });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.STATE);
    expect(legs(h)).toEqual(["nas.example:probe"]);
    expect(text(h.io)).toContain("left alone");
  });

  test("a non-interactive run aborts legibly rather than reading EOF as yes", async () => {
    const h = harness({ confirm: null });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("this run is not interactive, and it would have asked");
    expect(legs(h)).toEqual(["nas.example:probe"]);
  });
});

// ── The work ─────────────────────────────────────────────────────────────────

describe("a member's turn: push, restart, verify", () => {
  test("the happy path runs all three legs and reports the version the LEAD observed", async () => {
    const h = harness();
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(legs(h)).toEqual(["nas.example:probe", "nas.example:install", "nas.example:restart"]);
    const rendered = text(h.io);
    expect(rendered).toContain(`pack update — ${VERSION} (${COMMIT.slice(0, 12)})`);
    expect(rendered).toContain(`✓ push`);
    expect(rendered).toContain("its bridge came back");
    expect(rendered).toContain(`answers at 100.64.0.9:8787 · ${VERSION}`);
    expect(rendered).toContain(`nas         updated  ${OLD_VERSION} → ${VERSION}`);
    expect(rendered).toContain(`✓ 1 updated, 0 already current, 0 skipped, 0 failed — every member named runs ${VERSION}`);
  });

  test("the commit is bundled ONCE for the whole run, however many members take it", async () => {
    let bundles = 0;
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") },
      hello: { nas: VERSION, pi: VERSION },
    });
    const wrapped = { ...h.deps, gitBundle: () => (bundles++, Promise.resolve("QkFTRTY0")) };
    expect(await cmdPackUpdate(wrapped, ["--all"])).toBe(EXIT.OK);
    expect(bundles).toBe(1);
  });

  test("the first failure aborts, and every member after it is left untouched", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") },
      hello: { nas: VERSION, pi: VERSION },
      answers: { "nas.example": { install: { code: 24, stderr: "error: the build failed on this machine" } } },
    });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain("the build failed on nas.example");
    // Nothing was sent to the member after it. That is the whole rule (M15/06).
    expect(legs(h)).not.toContain("pi.example:install");
    expect(rendered).toContain("nas         FAILED");
    expect(rendered).toContain("pi          skipped  not attempted — the run stopped at nas");
    expect(rendered).toContain("the run stopped at nas — every member after it was left untouched");
  });

  test("the abort names the recovery command for the member that failed", async () => {
    const h = harness({
      answers: { "nas.example": { install: { code: 24, stderr: "error: the build failed" } } },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("recover with: collie pack update nas");
  });

  test("the abort says why stopping is safe: PACK_PROTOCOL §7.1 tolerates skew", async () => {
    const h = harness({
      answers: { "nas.example": { install: { code: 24, stderr: "error: the build failed" } } },
    });
    await cmdPackUpdate(h.deps, ["nas"]);
    expect(text(h.io)).toContain("§7.1 tolerates version skew");
  });

  test("a restart that fails says the new build is on disk and the old one is still running", async () => {
    const h = harness({ answers: { "nas.example": { restart: { code: 1, stderr: "error: the unit did not come back" } } } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("has the new build on disk and the old one still running");
  });

  test("a member the lead cannot reach afterwards is a FAILURE, not a green run", async () => {
    const h = harness({ hello: { nas: false } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain("cannot reach it at 100.64.0.9:8787");
    expect(text(h.io)).toContain("nas         FAILED");
  });

  // ── What counts as "it came back running what we pushed" ───────────────────
  // A built Collie reports `<semver>+<short sha>`, so the manifest version alone is only half of the
  // string. The first field run compared against that half and warned about a member running exactly
  // the commit it had just been sent — under a ✓ calling the same string a success.

  test("a member answering the version AND the pushed commit is not warned about at all", async () => {
    const h = harness({ hello: { nas: `${VERSION}+${SHORT}` } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    const rendered = text(h.io);
    expect(rendered).not.toContain("warn: nas answers as");
    expect(rendered).toContain(`answers at 100.64.0.9:8787 · ${VERSION}+${SHORT}`);
    expect(rendered).not.toContain("(expected");
  });

  test("git may abbreviate the same commit longer there than here, and that is still this build", async () => {
    const h = harness({ hello: { nas: `${VERSION}+${COMMIT.slice(0, 10)}` } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(text(h.io)).not.toContain("warn: nas answers as");
  });

  test("a member built from ANOTHER commit never passes the health gate — it aborts the run", async () => {
    const h = harness({ hello: { nas: `${VERSION}+beefbee` } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain(`nas did not come back running ${VERSION}+${SHORT}`);
    expect(rendered).toContain(`it answers as ${VERSION}+beefbee, not ${VERSION}+${SHORT}`);
  });

  test("a member that comes back reporting a different version fails the run, loudly", async () => {
    const h = harness({ hello: { nas: "9.9.9" } });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    expect(text(h.io)).toContain(`it answers as 9.9.9, not ${VERSION}+${SHORT}`);
    // The gate polls, and only asks the member's own updater once it has given up.
    expect(legs(h)).toContain("nas.example:status");
  });

  test("the member's own updater record is the reason, and its recovery command is the one printed", async () => {
    const h = harness({
      hello: { nas: false },
      answers: {
        "nas.example": {
          status: {
            stdout: JSON.stringify(
              run("rolled-back", { reason: "the service came back as 1.2.2", recovery: "collie update --rollback" }),
            ),
          },
        },
      },
    });
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.FAIL);
    const rendered = text(h.io);
    expect(rendered).toContain("its own updater reports rolled-back");
    expect(rendered).toContain("nas says: the service came back as 1.2.2");
    expect(rendered).toContain("recover with: ssh nas.example -- collie update --rollback");
  });

  test("a bundle this checkout cannot produce fails every member instead of half of them", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example"), pi: opsRecord("pi.example") },
      bundle: null,
    });
    expect(await cmdPackUpdate(h.deps, ["--all"])).toBe(EXIT.FAIL);
    expect(legs(h).filter((l) => l.endsWith("install"))).toEqual([]);
    expect(text(h.io)).toContain("not attempted — the bundle failed here");
  });
});

describe("answersThisBuild", () => {
  test("the version alone is the most an unstamped member can say, and it is not evidence against us", () => {
    expect(answersThisBuild(VERSION, VERSION, COMMIT)).toBe(true);
    expect(answersThisBuild(OLD_VERSION, VERSION, COMMIT)).toBe(false);
  });

  test("the build half must abbreviate the commit that was pushed", () => {
    expect(answersThisBuild(`${VERSION}+${SHORT}`, VERSION, COMMIT)).toBe(true);
    expect(answersThisBuild(`${VERSION}+${COMMIT}`, VERSION, COMMIT)).toBe(true);
    expect(answersThisBuild(`${VERSION}+beefbee`, VERSION, COMMIT)).toBe(false);
    expect(answersThisBuild(`${VERSION}+ab`, VERSION, COMMIT)).toBe(false);
  });

  test("a marker on either half means it is not that commit — `-dirty` and `-dev` both fail", () => {
    expect(answersThisBuild(`${VERSION}+${SHORT}-dirty`, VERSION, COMMIT)).toBe(false);
    expect(answersThisBuild(`${VERSION}-dev+${SHORT}`, VERSION, COMMIT)).toBe(false);
  });
});

// ── The ops record ───────────────────────────────────────────────────────────

describe("the ops record", () => {
  test("an override refreshes it, so the next run needs no flags", async () => {
    const h = harness({ ops: { nas: opsRecord("old.example") } });
    expect(await cmdPackUpdate(h.deps, ["nas", "--host", "nas.new", "--port", "9000"])).toBe(EXIT.OK);
    expect(h.calls.every((c) => c.host === "nas.new")).toBe(true);
    expect(parsePackOps(h.ops.contents()!)?.members.nas).toEqual({
      sshHost: "nas.new",
      path: CHECKOUT,
      port: 9000,
      recordedAt: T0,
      // `pack update` arms nothing — only `pack deputy` writes this pair, and a record it refreshes
      // must not silently claim an anchor it did not create.
      anchoredGeneration: null,
      anchoredAt: null,
    });
  });

  test("a run with no override rewrites nothing — the file is not a log", async () => {
    const h = harness();
    const before = h.ops.contents();
    expect(await cmdPackUpdate(h.deps, ["nas"])).toBe(EXIT.OK);
    expect(h.ops.contents()).toBe(before);
  });

  test("an override is remembered once the probe proves it, even when a later leg fails", async () => {
    const h = harness({
      ops: { nas: opsRecord("old.example") },
      answers: { "nas.new": { install: { code: 1, stderr: "the build blew up" } } },
    });
    expect(await cmdPackUpdate(h.deps, ["nas", "--host", "nas.new", "--port", "9000"])).toBe(EXIT.FAIL);
    // The push failed — the run as a whole is a failure — but the route the operator typed
    // correctly must not be lost: the probe reached `nas.new` and found a real checkout there
    // before the push ever ran, and that is proof enough to keep.
    expect(parsePackOps(h.ops.contents()!)?.members.nas).toEqual({
      sshHost: "nas.new",
      path: CHECKOUT,
      port: 9000,
      recordedAt: T0,
      anchoredGeneration: null,
      anchoredAt: null,
    });
  });
});

// ── Tilde expansion in remote paths ───────────────────────────────────────────

describe("a --path with a tilde is expanded on the far side, never here", () => {
  test("`~/…` reaches the remote shell as \"$HOME\"/rest, quoted — never a literal tilde", async () => {
    const h = harness({ ops: { nas: opsRecord("old.example") } });
    expect(
      await cmdPackUpdate(h.deps, ["nas", "--host", "nas.new", "--path", "~/apps/collie-stable"]),
    ).toBe(EXIT.OK);
    const probed = h.calls.find((c) => c.leg === "probe");
    expect(probed?.script).toContain(`"$HOME"/'apps/collie-stable'`);
    expect(probed?.script).not.toContain("~");
  });

  test("bare `~` reaches the remote shell as \"$HOME\"", async () => {
    const h = harness({ ops: { nas: opsRecord("old.example") } });
    expect(await cmdPackUpdate(h.deps, ["nas", "--host", "nas.new", "--path", "~"])).toBe(EXIT.OK);
    const probed = h.calls.find((c) => c.leg === "probe");
    expect(probed?.script).toContain(`for _d in "$HOME"; do`);
    expect(probed?.script).not.toContain("~");
  });

  test("a path without a tilde is still single-quoted, exactly as before", async () => {
    const h = harness({ ops: { nas: opsRecord("old.example") } });
    expect(
      await cmdPackUpdate(h.deps, ["nas", "--host", "nas.new", "--path", "/opt/collie"]),
    ).toBe(EXIT.OK);
    const probed = h.calls.find((c) => c.leg === "probe");
    expect(probed?.script).toContain(`for _d in '/opt/collie'; do`);
  });
});

// A single, deliberately un-asserted print of the whole plain transcript, so the shape of what an
// operator reads is reviewable in one place rather than inferred from twenty `toContain`s.
describe("the plain transcript", () => {
  test("reads as one report: plan, work, table", async () => {
    const h = harness({
      store: twoPeers(),
      ops: { nas: opsRecord("nas.example") },
      hello: { nas: VERSION, pi: VERSION },
    });
    await cmdPackUpdate(h.deps, ["--all"]);
    expect(h.io.stdout).toEqual([
      "pack update — 1.2.3 (abc123def456)",
      "preflight: nothing red on this lead or on 1 member.",
      "→ nas         1.2.2 at 0000feed0000 · nas.example:/home/pat/.collie",
      "· pi          no ssh record — run `collie pack add <host>` once to teach it",
      "",
      "nas:",
      "  pushing abc123def456 (0 KiB base64) to /home/pat/.collie…",
      "  ✓ push        1.2.3 at /home/pat/.collie",
      "  ✓ restart     its bridge came back",
      "  ✓ verify      answers at 100.64.0.9:8787 · 1.2.3",
      "",
      "summary:",
      "  nas         updated  1.2.2 → 1.2.3",
      "  pi          skipped  no ssh record",
      "✓ 1 updated, 0 already current, 1 skipped, 0 failed — 1 still behind this lead's 1.2.3",
    ]);
  });
});
