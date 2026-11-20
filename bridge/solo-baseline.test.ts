import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { AuditLog, fileAuditAppender, formatAuditLine, type AuditEntry } from "./audit.ts";
import { ActivityLedger } from "./activity.ts";
import { loadConfig, type Config } from "./config.ts";
import { CONFIG_SETTINGS } from "./config-schema.ts";
import { computeEtag } from "./http-cache.ts";
import { muxOk } from "./mux/types.ts";
import { NotifyPrefsStore } from "./notify-prefs.ts";
import { FolderStore } from "./folders.ts";
import { WorktreeBaseStore } from "./worktree-bases.ts";
import { SentStore, sentFileIo } from "./sent.ts";
import { WorktreeReceiptStore } from "./worktree-receipts.ts";
import { MachineAlertStore } from "./machine-alerts.ts";
import { loadMachineHistory, saveMachineHistory } from "./machine-history.ts";
import { machineRosterOf, MachineWatch, SOLO_MACHINE_ID } from "./machines.ts";
import { Push, pushPayloadData, type PushMessage } from "./push.ts";
import { TrustStore } from "./crew/trust-store.ts";
import { Snooze } from "./snooze.ts";
import { bootSources, planPrograms, sourcesPath, type DurableSource } from "./sources.ts";
import {
  SessionRegistry,
  herdTagFor,
  type SessionFactory,
  type SessionParts,
} from "./sessions.ts";
import type { EngineSnapshot } from "./state-engine.ts";
import { toPaneWire } from "./types.ts";
import type {
  AgentView,
  SnapshotResponse,
  TabView,
  UpdateStatus,
  WorkspaceView,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// SOLO ZERO-TAX — a solo user pays nothing for the crew.
//
// The contract in CREW_PROTOCOL.md §11: with ZERO peers enrolled, a solo instance sends no crew
// field, routes no crew path, reads no crew setting and writes no crew file. Each test below states
// one of those as a rule, so a normal new route, setting, wire field or state file needs no edit here.
//
// The snapshot body is still compared against a golden, because the solo ETag must not move: the body
// of a fixed fake herd is a result, not a list. REGENERATING IT IS A DELIBERATE ACT:
//   COLLIE_REGEN_SOLO_BASELINE=1 bun test bridge/solo-baseline.test.ts
// rewrites the fixtures under bridge/fixtures/solo-baseline/. A PR that does so says so, with the reason.
// ─────────────────────────────────────────────────────────────────────────────
//     line the field was added. server.ts emits its snapshot `satisfies SnapshotResponse`, so a new
//     emitted key must first exist on the type — the chain has no gap.
//   • BYTE level — a golden body, deep-equalled and byte-compared, plus its ETag.
// ─────────────────────────────────────────────────────────────────────────────

const FIXTURES = join(import.meta.dir, "fixtures", "solo-baseline");
const REGEN = process.env.COLLIE_REGEN_SOLO_BASELINE === "1";

function golden(name: string): string {
  // A Windows checkout may turn the committed LF into CRLF (core.autocrlf); the bytes the code
  // produces are LF, so the fixture is read as the LF text that was committed.
  return readFileSync(join(FIXTURES, name), "utf8").replace(/\r\n/g, "\n");
}

/** Compare against a committed golden, or rewrite it under COLLIE_REGEN_SOLO_BASELINE=1. */
function expectGolden(name: string, actual: string): void {
  if (REGEN) {
    writeFileSync(join(FIXTURES, name), actual);
    console.warn(`[solo-baseline] REGENERATED ${name} — say so in the PR description, with a reason.`);
  }
  expect(actual).toBe(golden(name));
}

// ── The fixed fake herd ───────────────────────────────────────────────────────
// A solo instance: one herdr session (the primary), two agent panes, one shell pane, one space,
// one tab. Frozen inputs — every number here is arbitrary but must never change, or the golden
// stops being a comparison against yesterday.

const TS = 1_754_000_000_000;

const claudePane: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "blocked",
  cwd: "/home/you/playground/collie",
  focused: true,
  kind: "agent",
  paneLabel: "guard work",
  sessionName: "guard-work",
  // Server-side only: toPaneWire must strip this to `hasSession` and never leak the value.
  agentSession: { kind: "id", value: "abc-123" },
  readableLines: 48,
  tabLabel: "collie",
  lastActiveAt: TS - 60_000,
  lastSeenAt: TS - 300_000,
};

const codexPane: AgentView = {
  paneId: "w1:p2",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "codex",
  status: "working",
  cwd: "/home/you/playground/collie",
  focused: false,
  kind: "agent",
};

const shellPane: AgentView = {
  paneId: "w1:p3",
  workspaceId: "w1",
  workspaceLabel: "collie",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "shell",
  status: "idle",
  cwd: "/home/you",
  focused: false,
  kind: "shell",
};

const workspaces: WorkspaceView[] = [
  {
    workspaceId: "w1",
    number: 1,
    label: "collie",
    focused: true,
    activeTabId: "w1:t1",
    tabCount: 1,
    paneCount: 3,
  },
];

const tabs: TabView[] = [
  { tabId: "w1:t1", workspaceId: "w1", number: 1, label: "collie", focused: true, paneCount: 3 },
];

const engineSnapshot: EngineSnapshot = {
  agents: [claudePane, codexPane],
  shellPanes: [shellPane],
  workspaces,
  tabs,
  bridge: "connected",
};

const updateStatus: UpdateStatus = {
  current: "1.0.0-alpha.1",
  latest: null,
  latestUrl: null,
  releaseAvailable: false,
  majorAvailable: null,
  majorUrl: null,
  installKind: "detached-checkout",
  dismissedVersion: null,
  dismissedCrewVersion: null,
  bridgeStale: false,
  restartNeeded: false,
  checkedAt: null,
};

/**
 * Every member of {@link SessionParts} is a class with private fields, so no fake can ever *be* one
 * structurally. `Partial<T>` keeps the compiler checking each method a fake DOES supply against the
 * real class (a renamed or re-typed method still breaks this file); only the "the rest is never
 * reached" step is asserted.
 */
function stubPart<T>(impl: Partial<T>): T {
  // SAFETY: SessionRegistry only ever calls the methods these fakes implement — `engine.current()`
  // and the `stop()`/`clearAll()` disposal hooks. `herdr` is stored and handed back, never called,
  // on the paths this file drives (registry construction, `list()`, and the snapshot assembly).
  return impl as T;
}

/** Only claude has a journal adapter in this fixture — codex/shell must not advertise History. */
const hasJournal = (agent: string) => agent === "claude";

/**
 * A registry over exactly one session (the primary), built with the same fake-factory convention as
 * sessions.test.ts. `list()` is the REAL implementation — this pins what a solo `sessions` looks like.
 */
function soloRegistry(sources: readonly DurableSource[] = []): SessionRegistry {
  const factory: SessionFactory = () => ({
    // The registry's only discovery: an adapter reporting nothing but the primary itself.
    herdr: stubPart<SessionParts["herdr"]>({ listSessions: () => Promise.resolve(muxOk([])) }),
    engine: stubPart<SessionParts["engine"]>({ current: () => engineSnapshot, stop: () => {} }),
    poker: stubPart<SessionParts["poker"]>({ stop: () => {} }),
    notifications: stubPart<SessionParts["notifications"]>({ clearAll: () => {} }),
  });
  return new SessionRegistry({
    configRoot: "/home/you/.config/herdr",
    primarySocketPath: "/home/you/.config/herdr/herdr.sock",
    factory,
    multiSession: true,
    sources,
  });
}
/**
 * Assemble the snapshot body exactly as the `/api/snapshot` handler does for a solo instance: device
 * auth off (so the key is absent), no peers. `satisfies SnapshotResponse` on both sides keeps the two
 * in step: a key the handler adds must exist on the type.
 */
function soloSnapshot(registry: SessionRegistry): SnapshotResponse {
  const { agents, shellPanes, workspaces: ws, tabs: tb, bridge } = registry.get()!.engine.current();
  return {
    bridge,
    // device: omitted — COLLIE_DEVICE_HEADER unset is the default deployment.
    agents: agents.map((p) => toPaneWire(p, hasJournal)),
    shellPanes: shellPanes.map((p) => toPaneWire(p, hasJournal)),
    workspaces: ws,
    tabs: tb,
    sessions: registry.list(),
    notifications: { snoozedUntil: null },
    update: updateStatus,
    ts: TS,
  } satisfies SnapshotResponse;
}

// ── 2. The golden snapshot body ──────────────────────────────────────────────

describe("solo zero-tax — the snapshot body is byte-for-byte today's", () => {
  const body = JSON.stringify(soloSnapshot(soloRegistry()), null, 2);

  test("assembles to the committed golden, byte for byte", () => {
    expectGolden("snapshot.json", `${body}\n`);
  });

  // COLLIE_PROGRAMS=off (M55 spec 16): a sources.json that lists a program is ignored whole, so the
  // registry the bridge would build from it lists the same sessions and the snapshot is these bytes.
  test("COLLIE_PROGRAMS=off: a sources.json with a program leaves the snapshot byte-identical to solo", async () => {
    const dir = await mkdtemp(join(tmpdir(), "collie-programs-off-"));
    try {
      writeFileSync(sourcesPath(dir), JSON.stringify([{ name: "desk", kind: "durable", socket: "/run/desk.sock" }]), { mode: 0o600 });
      const plan = (env: Record<string, string>) =>
        planPrograms({ durableOnly: false, env, sources: bootSources(dir, env), primaryName: "herdr" });
      // The control: with the switch unset the same file does add a program, so the assertion below is not vacuous.
      expect(plan({}).others).toHaveLength(1);
      const off = plan({ COLLIE_PROGRAMS: "off" });
      expect(off).toEqual({ primary: undefined, others: [] });
      expect(JSON.stringify(soloSnapshot(soloRegistry(off.others)), null, 2)).toBe(body);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Deep equality, not a subset match: an added key fails here even if the golden were regenerated
  // carelessly, because the parsed golden is compared BOTH ways.
  test("deep-equals the golden with no extra keys on either side", () => {
    // SAFETY: the golden is this file's own committed output — written by `expectGolden` from a
    // `satisfies SnapshotResponse` body — so its parse is a SnapshotResponse by construction. The
    // two-way `toEqual` below is what actually checks that, key for key.
    const parsed = JSON.parse(golden("snapshot.json")) as SnapshotResponse;
    const actual = soloSnapshot(soloRegistry());
    expect(actual).toEqual(parsed);
    expect(parsed).toEqual(actual);
  });

  test("a solo snapshot names no crew anywhere in its bytes", () => {
    expect(body).not.toMatch(/"servers"|"peers"|"crew"|"host":|"lead"/);
  });

  test("solo emits exactly one session, the primary, and never a session ref", () => {
    const snap = soloSnapshot(soloRegistry());
    expect(snap.sessions).toEqual([
      { name: "default", isPrimary: true, reachable: true, agents: 2, working: 1, blocked: 1 },
    ]);
    // hasSession is the flag; agentSession (a filesystem path for pi) must never reach the wire.
    // Asked with `hasOwn` rather than by reading the property, because it is not on PaneWire at all
    // — which is the point: an absent key, not an undefined value.
    expect(snap.agents.map((p) => Object.hasOwn(p, "agentSession"))).toEqual([false, false]);
    expect(snap.agents.map((p) => p.hasSession)).toEqual([true, undefined]);
  });
});

// ── 3. ETag stability ────────────────────────────────────────────────────────
// §11: the solo snapshot ETag is UNCHANGED — a hard requirement, not an accepted one-time break.
// The literal hash is deliberately NOT pinned: Bun.hash is a runtime implementation detail and a Bun
// upgrade legitimately moves it. What §11 actually promises is that the *body bytes* don't move, and
// that the ETag is a pure function of those bytes. Both are asserted; the negative control below
// proves the gate has teeth.

describe("solo zero-tax — ETag", () => {
  test("is a pure function of the body: identical bytes → identical ETag", () => {
    const a = JSON.stringify(soloSnapshot(soloRegistry()));
    const b = JSON.stringify(soloSnapshot(soloRegistry()));
    expect(a).toBe(b);
    expect(computeEtag(a)).toBe(computeEtag(b));
  });

  test("the golden body's ETag matches the assembled body's", () => {
    const fromGolden = JSON.stringify(JSON.parse(golden("snapshot.json")));
    const fromCode = JSON.stringify(soloSnapshot(soloRegistry()));
    expect(computeEtag(fromCode)).toBe(computeEtag(fromGolden));
  });

  // NEGATIVE CONTROL — this is the tax, measured. It is why `servers` is optional-and-absent rather
  // than an always-present empty array (CREW_PROTOCOL.md §11).
  test("adding an empty `servers: []` would move every solo ETag", () => {
    const today = JSON.stringify(soloSnapshot(soloRegistry()));
    const taxed = JSON.stringify({ ...soloSnapshot(soloRegistry()), servers: [] });
    expect(computeEtag(taxed)).not.toBe(computeEtag(today));
  });
});

// ── 4. Routes ────────────────────────────────────────────────────────────────
// §11: zero routes added, no `/crew` prefix registered. The dispatch lives inside `Bun.serve`, which
// `bun test` cannot stand up (CLAUDE.md), so the route table is pinned by reading the source's route
// literals. Crude, but it is the actual registration site: a new `if (pathname === "/crew/…")` in
// server.ts fails here even though no server was started. A new solo route needs no edit here.

function declaredRoutes(): string[] {
  const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
  const exact = [...src.matchAll(/pathname === "([^"]+)"/g)].map((m) => m[1]!);
  const prefixes = [...src.matchAll(/pathname\.startsWith\("([^"]+)"\)/g)].map((m) => `${m[1]}*`);
  const patterns = [...src.matchAll(/^(?:export )?const \w*ROUTE = (\/\^.+\/);$/gm)].map((m) => m[1]!);
  return [...new Set([...exact, ...prefixes, ...patterns])].toSorted();
}

describe("solo zero-tax — routes", () => {
  test("server.ts declares routes, so the scan below reads the real table", () => {
    expect(declaredRoutes()).toContain("/api/snapshot");
  });

  test("no crew prefix is routed at all, and 1.7.0's is gone with the overlap", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf8");
    expect(declaredRoutes().filter((r) => r.startsWith("/crew") || r.startsWith("/pack"))).toEqual([]);
    expect(src).not.toMatch(/"\/crew/);
    expect(src).not.toMatch(/"\/pack/);
  });
});

// ── 5. Config: no crew keys, no crew env ─────────────────────────────────────

/** A setting or env name that belongs to the crew, not to a solo instance. */
const CREW_WORD = /crew|peer|lead|federat|pack|warrant|deputy|standby/i;

describe("solo zero-tax — config", () => {
  test("loadConfig with a bare environment names no crew key, and listens on loopback only", () => {
    const cfg = loadConfig();
    expect(Object.keys(cfg).filter((k) => CREW_WORD.test(k))).toEqual([]);
    // §11 "Ports opened": exactly one, loopback.
    expect(cfg.host).toBe("127.0.0.1");
    expect(Number.isInteger(cfg.port)).toBe(true);
  });


  test("the poll cadence defaults are unchanged — no second timer to configure", () => {
    // §11 "Poll cadence". Env is not scrubbed here (a deployment may override), so assert the
    // defaults from the source rather than from a live env.
    const src = readFileSync(join(import.meta.dir, "config.ts"), "utf8");
    expect(src).toContain('envInt("COLLIE_POLL_MS", 1500');
    expect(src).toContain('envInt("COLLIE_POLL_IDLE_MS", 12_000');
  });

  // The schema is the one declaration of every setting (ADR 0040): the rows with a `configField` are
  // exactly what `loadConfig` resolves. A crew instance enrolls by `collie crew join`, never by env.
  test("the schema names no crew enrollment env key", () => {
    const envKeys = CONFIG_SETTINGS.filter((s) => s.configField !== undefined).map((s) => s.env);
    expect(envKeys.length).toBeGreaterThan(0);
    expect(envKeys.filter((k) => CREW_WORD.test(k))).toEqual([]);
  });
});

// ── 6. Files written ─────────────────────────────────────────────────────────
// §11: a solo instance writes no key, no certificate, no trust store, no roster. Two halves: the
// modules under bridge/crew/ are the only ones that name a crew state file, and driving the solo
// stores writes only what the solo stores write.

/** Every `.ts` module under `dir`, recursively, excluding tests. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/** Every `<stateDir>/…` entry a module names, however the state dir and the name reached it. */
function stateDirEntriesNamedBy(files: string[]): string[] {
  const named = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    // Broader than the original `cfg.stateDir` + string-literal scan, in two directions, because a
    // writer using either other form would have slipped past it entirely:
    //  • the state dir arrives as `cfg.stateDir`, `this.cfg.stateDir` or a bare `stateDir` param;
    //  • the entry name may be a string literal or a `const NAME = "…"` in the same module.
    const constants = new Map(
      [...src.matchAll(/^(?:export )?const ([A-Z][A-Z0-9_]*) = "([^"]+)";$/gm)].map((m) => [m[1]!, m[2]!]),
    );
    for (const m of src.matchAll(/join\([^)]*stateDir,\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))\)/g)) {
      const literal = m[1] ?? (m[2] === undefined ? undefined : constants.get(m[2]));
      if (literal !== undefined) named.add(literal);
      else if (m[2] !== undefined) {
        throw new Error(`${f}: <stateDir>/${m[2]} — the scan cannot resolve that name, so it cannot guard it`);
      }
    }
  }
  return [...named].toSorted();
}

describe("solo zero-tax — the filesystem", () => {
  test("no module outside bridge/crew/ names a <stateDir> entry that a crew module names", () => {
    const solo = stateDirEntriesNamedBy(sourceFiles(import.meta.dir).filter((f) => !f.includes(`${sep}crew${sep}`)));
    const crew = stateDirEntriesNamedBy(sourceFiles(join(import.meta.dir, "crew")));
    // The control: the scan sees the crew's files, so an empty overlap below is not vacuous.
    expect(crew).toContain("crew-trust.json");
    expect(solo).toContain("audit.log");
    expect(crew.filter((e) => solo.includes(e))).toEqual([]);
  });


  test("driving every solo write path produces only known files", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const cfg: Config = { ...loadConfig(), stateDir };
      await new Snooze(cfg, () => TS).set(TS + 60_000);
      await new NotifyPrefsStore(cfg).set({ blocked: false });
      // The folder list, loaded as index.ts loads it at startup and fed the two things an idle solo
      // bridge sees: a space created in home, and nothing at all. Neither is an entry, so no file.
      const folders = new FolderStore(cfg, "/home/op");
      await folders.load();
      await folders.recordRecent("/home/op");
      await folders.recordRecent("");
      const ledger = new ActivityLedger({ stateDir }, () => TS, 60 * 60 * 1000);
      ledger.ensure("default", "w1:p1");
      await ledger.flush();
      new AuditLog(fileAuditAppender(join(stateDir, "audit.log")), { now: () => TS }).record({
        action: "reply",
        paneId: "w1:p1",
        detail: { text: "ok" },
      });
      // The trust store, resolved exactly as index.ts resolves it at startup. A solo instance has
      // never enrolled, so this must open a file that isn't there and create NOTHING — not the
      // store, not a key, not a default. §11's "Files written" row, driven rather than read.
      expect(await new TrustStore(stateDir).load()).toBeNull();
      // The audit append is fire-and-forget; let its microtask + write land.
      await Bun.sleep(20);
      const written = (await readdir(stateDir)).toSorted();
      expect(written).toEqual(["activity.json", "audit.log", "notify-prefs.json", "snooze.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // §11's "Files written" row, amended on purpose by M40/02: `folders.json` is written by use and by
  // nothing else. Driven, so the amendment is a fact about the store rather than a sentence.
  test("the folder list appears only on use: a create with a folder, or a star", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const folders = new FolderStore({ stateDir }, "/home/op");
      await folders.load();
      expect(await readdir(stateDir)).toEqual([]);
      await folders.recordRecent("/home/op/proj");
      expect(await readdir(stateDir)).toEqual(["folders.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // The same shape for the worktree receipts (ADR 0089): loading writes nothing, a create with a
  // request id writes the one file.
  test("the worktree receipts appear only on use: a create that carries a request id", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const receipts = new WorktreeReceiptStore(stateDir);
      await receipts.load();
      expect(await readdir(stateDir)).toEqual([]);
      await receipts.record({
        requestId: "0b9e6a1c-3f2d-4c5e-8a7b-1d2e3f4a5b6c",
        at: 1,
        workspaceId: "w2",
        paneId: "w2:p1",
        path: "/home/op/repo/.worktrees/x",
        branch: "worktree/x",
        launcherStarted: false,
      });
      expect(await readdir(stateDir)).toEqual(["worktree-receipts.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // The same shape for the worktree bases (ADR 0089, amended): loading writes nothing, a create that
  // named a starting point writes the one file.
  test("the worktree bases appear only on use: a create that named a starting point", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const bases = new WorktreeBaseStore(stateDir);
      await bases.load();
      expect(await readdir(stateDir)).toEqual([]);
      await bases.record("/home/op/repo/.worktrees/x", { base: "main", createdAt: 1 });
      expect(await readdir(stateDir)).toEqual(["worktree-bases.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // The same shape for push's clear budget (bridge/push.ts, rule 4): a bridge with no subscription
  // sends nothing and writes nothing, however many alerts come and go; the first clear that reaches
  // a subscription writes the one file.
  test("the clear budget appears only on use: a clear that reaches a subscription", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const push = new Push({ ...loadConfig(), stateDir }, () => Promise.resolve());
      push["_enabled"] = true;
      await push.loadStore();
      await push.send({ title: "claude needs you", tag: "collie:herd:w1:p1" });
      await push.send({ type: "clear", tag: "collie:herd:w1:p1" });
      await push.send({ type: "clear", tag: "collie:herd" });
      expect(await readdir(stateDir)).toEqual([]);
      push["subs"].set("phone", { endpoint: "phone", keys: { p256dh: "p", auth: "a" } });
      await push.send({ type: "clear", tag: "collie:herd:w1:p1" });
      expect(await readdir(stateDir)).toEqual(["push-clear-budget.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  // The same shape for Sent (ADR 0107): building the store writes nothing, a skipped line writes
  // nothing, the switch off writes nothing, and the first kept line writes the one file.
  test("Sent appears only on use: a shell line the skip rules keep", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      const off = new SentStore(sentFileIo(stateDir), { off: true, home: "/home/op" });
      expect(await off.record("git status", "/home/op/proj", "shell")).toBe("skipped");
      const sent = new SentStore(sentFileIo(stateDir), { home: "/home/op" });
      expect(await sent.record(" git status", "/home/op/proj", "shell")).toBe("skipped");
      expect(await sent.record("export AWS_SECRET_ACCESS_KEY=x", "/home/op/proj", "shell")).toBe("skipped");
      expect(await sent.clear()).toBe(0);
      expect(await readdir(stateDir)).toEqual([]);
      expect(await sent.record("git status", "/home/op/proj", "shell")).toBe("recorded");
      expect(await readdir(stateDir)).toEqual(["sent.jsonl"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// §11's "Files written" row, amended on purpose by ADR 0084, and driven like the folder list above:
// the watch exactly as index.ts builds it on a solo collie, over a temp state folder.
describe("solo zero-tax — the machine files", () => {
  test("the history appears on the first save after five minutes of samples; the rules only on a rule", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "collie-solo-baseline-"));
    try {
      let now = TS;
      const watch = new MachineWatch({
        now: () => now,
        roster: () => machineRosterOf(null, { id: SOLO_MACHINE_ID, name: "solo" }),
        history: await loadMachineHistory(stateDir, now),
        alerts: await MachineAlertStore.load(stateDir),
        saveHistory: (history, at) => saveMachineHistory(stateDir, history, at),
        muted: () => false,
        enabled: () => true,
        send: () => {},
      });
      // Started, ticked, and stopped with nothing sampled: nothing on disk.
      watch.tick();
      await watch.flush();
      expect(await readdir(stateDir)).toEqual([]);

      // Sampled for a while, but inside the five-minute save interval: still nothing.
      const sample = { cpu: 0.2, cores: 4, memUsed: 1e9, memTotal: 8e9 };
      for (let i = 0; i < 4; i++) {
        watch.observe(SOLO_MACHINE_ID, sample, now);
        now += 60_000;
        watch.tick();
      }
      await Bun.sleep(5);
      expect(await readdir(stateDir)).toEqual([]);

      now += 60_000;
      watch.observe(SOLO_MACHINE_ID, sample, now);
      watch.tick();
      // The tick's save is already on the chain and the history is no longer dirty, so flush waits for
      // that write and adds none. A fixed sleep listed the folder mid-rename on Windows (the .tmp file).
      await watch.flush();
      expect(await readdir(stateDir)).toEqual(["machine-history.json"]);

      await watch.setAlerts(SOLO_MACHINE_ID, { cpu: { above: 0.9, forMin: 10 } });
      expect((await readdir(stateDir)).toSorted()).toEqual(["machine-alerts.json", "machine-history.json"]);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});

// ── 7. Notification tags and push payload ────────────────────────────────────

describe("solo zero-tax — notifications", () => {
  test("the primary session keeps the bare collie:herd tag", () => {
    expect(herdTagFor(true, "default")).toBe("collie:herd");
    // Whatever the primary is NAMED, its tag stays bare — the name never enters the solo tag.
    expect(herdTagFor(true, "work")).toBe("collie:herd");
  });

  test("push.ts stamps `session` and `host` only when the message names one", () => {
    // ── RENEGOTIATED BY M4/06, THE SAME WAY THE WIRE-TYPE ROWS WERE BY M4/04 ──
    // The row it defends: "push payload unchanged: no `host` field, mirroring how `session` is stamped
    // only for non-primary" (§11). `host` is conditional exactly as `session` is, so a solo instance
    // (which never has a host) emits the identical bytes. What would be a real regression is an
    // UNCONDITIONAL stamp. This read `push.ts` as source text while the payload was built inside
    // Push.send, which needs the web-push module to run; since the push picture work (ADR 0164) the
    // payload is `pushPayloadData`, a pure function, so the row is pinned on the payload it builds.
    // The shape of `data` is the contract an installed service worker already caches.
    const solo: PushMessage = { title: "t", body: "b", tag: "collie:herd", paneId: "w1:p1" };
    // Keys, not `toEqual`: `toEqual` passes an unconditional stamp of `undefined`.
    expect(Object.keys(pushPayloadData(solo))).toEqual(["paneId"]);
    expect(JSON.stringify(pushPayloadData(solo))).toBe('{"paneId":"w1:p1"}');
    const named: PushMessage = { ...solo, session: "work", host: "mini" };
    expect(pushPayloadData(named)).toEqual({ paneId: "w1:p1", session: "work", host: "mini" });
  });

  test("a solo payload has no host: the sink stamps it only when a host is named", async () => {
    // The behavioural half of the row above, at the layer that decides: `makeNotifySink` is what
    // every local session's coordinator renders through, and a solo instance passes it no host.
    const { makeNotifySink } = await import("./notifications.ts");
    const sent: PushMessage[] = [];
    const sink = makeNotifySink({ send: (m: PushMessage) => sent.push(m) }, { isMuted: () => false }, "collie:herd");
    sink.render({
      title: "claude needs you",
      titleCode: "agent.blocked",
      titleDetail: { agent: "claude" },
      body: "demo · /home/you",
      paneId: "p1",
      renotify: true,
      badge: 1,
    });
    sink.clear();
    expect(sent).toEqual([
      {
        title: "claude needs you",
        titleCode: "agent.blocked",
        titleDetail: { agent: "claude" },
        body: "demo · /home/you",
        tag: "collie:herd",
        paneId: "p1",
        renotify: true,
        badge: 1,
      },
      { type: "clear", tag: "collie:herd" },
    ]);
    expect(sent.every((m) => !("host" in m))).toBe(true);
  });
});

// ── 8. Audit lines ───────────────────────────────────────────────────────────

const AUDIT_ENTRIES: AuditEntry[] = [
  { action: "reply", paneId: "w1:p1", detail: { text: "ship it" } },
  { action: "keys", paneId: "w1:p1", detail: { keys: ["ctrl+c"] } },
  { action: "tab.create", detail: { workspaceId: "w1" } },
  { action: "pane.close", paneId: "w1:p3", session: "collie-demo", detail: {} },
  { action: "upload", paneId: "w1:p1", device: "phone", detail: { filename: "shot.png", size: 1234 } },
];

describe("solo zero-tax — audit lines", () => {
  test("format exactly as they do today: `host` absent, not null", () => {
    const lines = AUDIT_ENTRIES.map((e) => formatAuditLine(e, TS)).join("\n");
    expectGolden("audit.jsonl", `${lines}\n`);
    expect(lines).not.toMatch(/"host"/);
  });
});
