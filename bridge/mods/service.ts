import { mkdir } from "node:fs/promises";

import type { JsonValue } from "../json.ts";
import { redactText } from "../redact.ts";
import { payloadDigest } from "../worktree-receipts.ts";
import {
  CORE_NODE_KINDS,
  freshWindowMs,
  parseModDocumentText,
  parseTapRequest,
  REFUSALS_MAX,
  type FactsTrigger,
  type ModState,
  type ModTapReply,
  type ModsReply,
  type ParsedModDocument,
  type Refusal,
  type TapRequest,
  type WireModInfo,
} from "../../web/src/lib/mods/schema.ts";
import { createModScanner, type FoundMod, type ModsScan } from "./discover.ts";
import { scrubEnv, type ProviderEnv } from "./env.ts";
import { buildFacts, type FactsWorld } from "./facts.ts";
import { modsConfigDir, modStateDir } from "./paths.ts";
import { outcomeProblem, runProvider, type RunOutcome, type RunSpec } from "./run.ts";
import { ModsStore, problemLine } from "./store.ts";
import { createSwitchReader, type Switches } from "./switches.ts";

// THE MODS RUNNER (M94 slice 01): which mod runs when, and what its run leaves behind.
//
// ── WHEN A MOD RUNS ─────────────────────────────────────────────────────────────
//   * Only while ON (the switch file) and only with a manifest that parsed.
//   * Timers run only while a phone has watched in the last five minutes ({@link WATCH_WINDOW_MS}):
//     "watched" is a `/api/snapshot` or `/api/mods` request from a paired phone (server.ts stamps it).
//     The host's own CLI and a lead's sweep of this machine do not count. A `gh` mod on `30s` makes no
//     call while the phone is in a pocket.
//   * The first run after the mod is loaded, switched on, or its folder changed has the trigger
//     `start`; later ones `timer`, every `every` (at least 5 s). A mod with no `every` runs once at
//     start and then on taps only.
//   * One run at a time per mod. A tick while one runs is skipped. A tap queues ONE deep, ahead of the
//     timer; a second tap while one waits is refused as busy and may be tried again.
//   * After a failed run: 1, 5, then 30 minutes, then the mod stops ({@link BACKOFF_MS}). A change in
//     its folder, switching it on again, or a tap restarts it. A broken provider never runs 1,440
//     times a day against a paid API.
//
// ── WHAT A RUN LEAVES ───────────────────────────────────────────────────────────
// stdout and stderr are masked in run.ts before anything here sees them. The document is parsed with
// the schema's one parser, against the manifest's declared places and the core node kinds (slice 08
// adds the rest), and stored per part with a rev (store.ts). A failed run keeps the last good parts,
// stale. The error line is masked and capped, and goes to the list entry, the doctor row and one log
// line when it changes, never once per run.
//
// ── TAPS ────────────────────────────────────────────────────────────────────────
// `POST /api/mods/<host>/<id>/tap` carries a request id (WIRE.md 7.10's receipt shape). The bridge
// keeps the last {@link TAP_RECEIPTS_MAX} replies of runs that STARTED, by request id: a repeat gets
// the first reply with `replayed` and runs nothing; a repeat still in flight waits for the first; the
// same id with another payload is refused. A tap that ran nothing (the mod is off, busy or skipped)
// keeps no receipt, so the same id may simply be tried again. `draft` and `open` pass through to the
// phone; the bridge does not act on them.

/** How long a phone's look keeps timers running. */
export const WATCH_WINDOW_MS = 5 * 60_000;
/** The wait after the first, second and third failure in a row. The fourth stops the mod. */
export const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000] as const;
/** The scheduler's tick. A timer of 5 s therefore runs within a second of its due time. */
export const TICK_MS = 1000;
/** The least time between two scans of the mods folder. */
export const SCAN_EVERY_MS = 2000;
/** The tap receipts kept, newest last. */
export const TAP_RECEIPTS_MAX = 200;

/** What the server needs: the snapshot's rev, the watch stamp, the two routes. */
export interface ModsSurface {
  /** `modsRev` for the snapshot, or undefined when there is no mods folder (no field at all). */
  rev(): number | undefined;
  /** A paired phone looked (`/api/snapshot`, `/api/mods`). */
  noteWatched(): void;
  /** `GET /api/mods?since=`. */
  reply(since: number | undefined): Promise<ModsReply>;
  /** `POST /api/mods/<host>/<id>/tap`. */
  tap(host: string, id: string, body: JsonValue | undefined): Promise<TapAnswer>;
}

/** A tap route's answer: the HTTP status and the JSON body. */
export type TapAnswer =
  | { status: 200; body: ModTapReply }
  | { status: 400; body: { error: "tap-invalid"; refusals: Refusal[] } }
  | { status: 404; body: { error: "unknown-host" | "unknown-mod" } }
  | { status: 409; body: { error: "request-id-reused"; requestId: string } };

export interface ModsServiceDeps {
  configDir: string;
  stateDir: string;
  /** This machine's host name for facts and part keys (facts.ts `modsHostName`). */
  host: () => string;
  /** The sessions and spaces, read at run time, with session ids keyed on `host`. */
  world: (host: string) => Omit<FactsWorld, "host">;
  /** The unit's environment, scrubbed before each run. */
  env: ProviderEnv;
  now?: () => number;
  /** The process runner. A test passes a fake or the real one with short limits. */
  run?: (spec: RunSpec) => Promise<RunOutcome>;
  /** Limits passed to the runner, for tests. */
  limits?: Pick<RunSpec, "timeoutMs" | "stdoutCap" | "stderrCap">;
  warn?: (line: string) => void;
  /** The first rev. Default the start time in ms (store.ts says why). */
  revBase?: number;
  /** The platform, for the shell. */
  platform?: NodeJS.Platform;
}

interface QueuedTap {
  request: TapRequest;
  resolve: (reply: ModTapReply) => void;
}

interface ModRuntime {
  found: FoundMod;
  on: boolean;
  /** Failed runs in a row. */
  failures: number;
  stopped: boolean;
  /** The next run is a `start` run. */
  pendingStart: boolean;
  /** Earliest time the next start or timer run may begin. */
  nextAt: number;
  running: Promise<void> | null;
  queued: QueuedTap | null;
  lastRunAt?: number;
  lastError?: string;
  /** The last document's refusals. */
  docRefusals: Refusal[];
}

interface Receipt {
  digest: string;
  reply: ModTapReply;
}

/** A mod's state on the wire. */
export function modStateOf(rt: Pick<ModRuntime, "on" | "found" | "stopped" | "failures">): ModState {
  if (rt.found.manifest === undefined) return "skipped";
  if (!rt.on) return "off";
  if (rt.stopped) return "stopped";
  return rt.failures > 0 ? "failing" : "ok";
}

/** The wait after the `failures`-th failure in a row, or null when the mod stops. */
export function backoffAfter(failures: number): number | null {
  return BACKOFF_MS[failures - 1] ?? null;
}

/** A fresh window as the `fresh` string a part carries, so the phone needs no manifest. */
export function freshString(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

export class ModsService implements ModsSurface {
  private readonly deps: ModsServiceDeps;
  private readonly now: () => number;
  private readonly warn: (line: string) => void;
  private readonly store: ModsStore;
  private readonly scanner: ReturnType<typeof createModScanner>;
  private readonly readSwitches: () => Promise<Switches>;
  private readonly runtimes = new Map<string, ModRuntime>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly inflight = new Map<string, { digest: string; reply: Promise<ModTapReply> }>();
  private watchedAt = -Infinity;
  private folderExists = false;
  private scannedAt = -Infinity;
  private scanning: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: ModsServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.warn = deps.warn ?? ((line) => console.warn(`[mods] ${line}`));
    this.store = new ModsStore(deps.revBase ?? Date.now());
    this.scanner = createModScanner(modsConfigDir(deps.configDir));
    this.readSwitches = createSwitchReader(deps.stateDir, this.warn);
  }

  /** Start the scheduler. Silent and nearly free while no phone watches: a tick then does nothing. */
  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  rev(): number | undefined {
    return this.folderExists ? this.store.rev : undefined;
  }

  noteWatched(): void {
    this.watchedAt = this.now();
    void this.refresh();
  }

  /** Whether a phone looked within {@link WATCH_WINDOW_MS}. */
  watched(): boolean {
    return this.now() - this.watchedAt < WATCH_WINDOW_MS;
  }

  /** The PATH a provider gets. */
  runnerPath(): string {
    return scrubEnv(this.deps.env, this.deps.configDir).PATH ?? "";
  }

  async reply(since: number | undefined): Promise<ModsReply> {
    await this.refresh();
    return this.store.reply(since, this.folderExists ? this.runnerPath() : undefined);
  }

  /**
   * Read the folder and the switches again, at most every {@link SCAN_EVERY_MS} unless `force`. Joins
   * a scan in flight. Never throws.
   */
  refresh(force = false): Promise<void> {
    if (this.scanning !== null) return this.scanning;
    if (!force && this.now() - this.scannedAt < SCAN_EVERY_MS) return Promise.resolve();
    this.scanning = (async () => {
      try {
        const [scan, switches] = await Promise.all([this.scanner.scan(), this.readSwitches()]);
        this.apply(scan, switches);
      } catch (err) {
        this.warn(`the mods folder could not be read: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.scannedAt = this.now();
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  /** Fold a scan and the switches into the runtimes and the list. */
  private apply(scan: ModsScan, switches: Switches): void {
    this.folderExists = scan.exists;
    const host = this.deps.host();
    const ids = new Set(scan.mods.map((m) => m.id));
    for (const id of this.runtimes.keys()) {
      if (ids.has(id)) continue;
      this.runtimes.delete(id);
      this.store.removeMod(host, id);
    }
    for (const found of scan.mods) {
      const on = switches.on.has(found.id);
      const old = this.runtimes.get(found.id);
      if (old === undefined) {
        this.runtimes.set(found.id, {
          found,
          on,
          failures: 0,
          stopped: false,
          pendingStart: true,
          nextAt: 0,
          running: null,
          queued: null,
          docRefusals: [],
        });
        this.publish(found.id);
        continue;
      }
      // A folder that changed is a restart: the backoff is forgotten and the next run is a start.
      if (old.found.fingerprint !== found.fingerprint) {
        old.found = found;
        this.restart(old);
        if (found.manifest === undefined) this.store.markStale(host, found.id, problemLine(found.refusals[0]?.reason ?? "mod.toml is refused."));
      }
      if (old.on !== on) {
        old.on = on;
        if (on) this.restart(old);
        else this.store.dropParts(host, found.id);
      }
      this.publish(found.id);
    }
  }

  private restart(rt: ModRuntime): void {
    rt.failures = 0;
    rt.stopped = false;
    rt.pendingStart = true;
    rt.nextAt = 0;
  }

  /** Put a mod's list entry in the store, which takes a rev only when it changed. */
  private publish(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt === undefined) return;
    const m = rt.found.manifest;
    const info: WireModInfo = {
      host: this.deps.host(),
      id,
      name: m?.name ?? id,
      icon: m?.icon ?? "plug",
      on: rt.on,
      state: modStateOf(rt),
      places: m?.places ?? [],
      provenance: { via: "folder" },
    };
    const error = m === undefined ? rt.found.refusals[0]?.reason : rt.lastError;
    if (error !== undefined) info.error = problemLine(error);
    if (rt.lastRunAt !== undefined) info.lastRunAt = new Date(rt.lastRunAt).toISOString();
    const refusals = [...rt.found.refusals, ...rt.docRefusals].slice(0, REFUSALS_MAX);
    if (refusals.length > 0) info.refusals = refusals;
    this.store.setInfo(info);
  }

  /** Whether a start or timer run is due now. */
  private due(rt: ModRuntime, now: number): boolean {
    if (!rt.on || rt.found.manifest === undefined || rt.stopped) return false;
    if (rt.running !== null || rt.queued !== null) return false;
    if (now < rt.nextAt) return false;
    // A failed start run keeps `pendingStart`, so it is tried again after its backoff; a mod with no
    // `every` never runs on the clock otherwise.
    return rt.pendingStart || rt.found.manifest.everyMs !== undefined;
  }

  /**
   * One scheduler tick: nothing at all unless a phone watched; else a scan (throttled) and every due
   * run started. Resolves when the runs it started are done, which is what a test waits on.
   */
  async tick(): Promise<void> {
    if (!this.watched()) return;
    await this.refresh();
    const now = this.now();
    const started: Promise<void>[] = [];
    for (const rt of this.runtimes.values()) {
      if (!this.due(rt, now)) continue;
      const trigger: FactsTrigger = rt.pendingStart ? { kind: "start" } : { kind: "timer" };
      started.push(this.begin(rt, trigger, null));
    }
    await Promise.all(started);
  }

  /** Start a run now and chain a queued tap after it. The promise ends when this run (not the tap) is done. */
  private begin(rt: ModRuntime, trigger: FactsTrigger, tap: QueuedTap | null): Promise<void> {
    const run = (async () => {
      const reply = await this.runOnce(rt, trigger);
      if (tap !== null) tap.resolve(reply);
    })();
    rt.running = run.finally(() => {
      rt.running = null;
      const next = rt.queued;
      if (next === null) return;
      rt.queued = null;
      const tapTrigger: FactsTrigger = { kind: "tap", ...next.request };
      void this.begin(rt, tapTrigger, next);
    });
    return rt.running;
  }

  /** Run the provider once and store what it left. The reply is the tap's, when the trigger is a tap. */
  private async runOnce(rt: ModRuntime, trigger: FactsTrigger): Promise<ModTapReply> {
    const manifest = rt.found.manifest;
    const host = this.deps.host();
    const id = rt.found.id;
    const requestId = trigger.kind === "tap" ? trigger.requestId : "";
    const revBefore = this.store.rev;
    if (manifest === undefined) return { requestId, outcome: "failed", message: "The mod's mod.toml is refused." };
    const startedAt = this.now();
    const state = modStateDir(this.deps.stateDir, id);
    // The provider's own folder under <stateDir>/mods, owner only like the rest of the state folder.
    await mkdir(state, { recursive: true, mode: 0o700 }).catch(() => {});
    const world = this.deps.world(host);
    const facts = buildFacts({ host, ...world }, { id, dir: rt.found.dir, state }, trigger);
    const outcome = await (this.deps.run ?? runProvider)({
      command: manifest.run,
      cwd: rt.found.dir,
      env: scrubEnv(this.deps.env, this.deps.configDir),
      stdin: JSON.stringify(facts),
      platform: this.deps.platform,
      ...this.deps.limits,
    });
    rt.lastRunAt = startedAt;
    const afterTap = trigger.kind === "tap";
    // A run that was switched off or removed while it ran leaves nothing behind.
    if (this.runtimes.get(id) !== rt || !rt.on) {
      return { requestId, outcome: "failed", message: "The mod was switched off while it ran." };
    }
    let problem = outcomeProblem(outcome, 200);
    let parsed: ParsedModDocument | null = null;
    if (problem === null && outcome.kind === "exited") {
      // Masked in run.ts already; again here, so no runner behind the seam can hand the parser a key.
      parsed = parseModDocumentText(redactText(outcome.stdout), { declared: manifest.places, afterTap, kinds: CORE_NODE_KINDS });
      if (parsed.documentRefused) problem = `The output was refused: ${parsed.refusals[0]?.reason ?? "not a document"}`;
    }
    if (problem !== null || parsed === null || parsed.documentRefused) {
      const line = problemLine(problem ?? "The run failed.");
      this.failed(rt, line, parsed?.refusals ?? []);
      this.store.markStale(host, id, line);
      this.publish(id);
      const reply: ModTapReply = { requestId, outcome: outcome.kind === "timeout" ? "unknown" : "failed", message: line, rev: this.store.rev };
      const mine = this.store.modParts(host, id, revBefore);
      if (mine.parts.length > 0) reply.parts = mine.parts;
      reply.present = mine.present;
      return reply;
    }
    const freshMs = freshWindowMs(parsed.freshMs, manifest.everyMs);
    const asOf = parsed.asOf ?? new Date(startedAt).toISOString();
    this.store.applyDocument(host, id, parsed, { asOf, fresh: parsed.fresh ?? freshString(freshMs) });
    this.succeeded(rt, startedAt, parsed.refusals);
    this.publish(id);
    const mine = this.store.modParts(host, id, revBefore);
    const reply: ModTapReply = { requestId, outcome: "applied", rev: this.store.rev, parts: mine.parts, present: mine.present };
    if (afterTap && parsed.draft !== undefined) reply.draft = parsed.draft;
    if (afterTap && parsed.open !== undefined) reply.open = parsed.open;
    return reply;
  }

  private failed(rt: ModRuntime, line: string, refusals: Refusal[]): void {
    const changed = rt.lastError !== line;
    rt.lastError = line;
    rt.docRefusals = refusals;
    rt.failures += 1;
    const wait = backoffAfter(rt.failures);
    if (wait === null) {
      rt.stopped = true;
      this.warn(`${rt.found.id}: stopped after ${rt.failures} failed runs in a row: ${line}`);
      return;
    }
    rt.nextAt = this.now() + wait;
    if (changed) this.warn(`${rt.found.id}: ${line}; next try in ${Math.round(wait / 60_000)} min`);
  }

  private succeeded(rt: ModRuntime, startedAt: number, refusals: Refusal[]): void {
    if (rt.failures > 0 || rt.stopped) this.warn(`${rt.found.id}: runs again`);
    rt.failures = 0;
    rt.stopped = false;
    rt.pendingStart = false;
    rt.lastError = undefined;
    rt.docRefusals = refusals;
    const every = rt.found.manifest?.everyMs;
    rt.nextAt = every === undefined ? Infinity : startedAt + every;
  }

  async tap(host: string, id: string, body: JsonValue | undefined): Promise<TapAnswer> {
    if (host !== this.deps.host()) return { status: 404, body: { error: "unknown-host" } };
    const parsed = parseTapRequest(body);
    if (parsed.request === undefined) return { status: 400, body: { error: "tap-invalid", refusals: parsed.refusals } };
    const request = parsed.request;
    const digest = payloadDigest([id, request.intent, JSON.stringify(request.args ?? null), request.part, request.from?.session ?? ""]);
    const kept = this.receipts.get(request.requestId);
    if (kept !== undefined) {
      if (kept.digest !== digest) return { status: 409, body: { error: "request-id-reused", requestId: request.requestId } };
      return { status: 200, body: replayOf(kept.reply) };
    }
    const flying = this.inflight.get(request.requestId);
    if (flying !== undefined) {
      if (flying.digest !== digest) return { status: 409, body: { error: "request-id-reused", requestId: request.requestId } };
      return { status: 200, body: replayOf(await flying.reply) };
    }
    await this.refresh();
    const rt = this.runtimes.get(id);
    if (rt === undefined) return { status: 404, body: { error: "unknown-mod" } };
    const refuse = (message: string): TapAnswer => ({ status: 200, body: { requestId: request.requestId, outcome: "failed", message } });
    if (rt.found.manifest === undefined) return refuse("The mod's mod.toml is refused. Run `collie mod check` on its folder.");
    if (!rt.on) return refuse("The mod is off.");
    if (rt.queued !== null) return refuse("The mod is busy. Try again in a moment.");
    // A tap restarts a mod that backed off or stopped (design §3.2).
    rt.failures = 0;
    rt.stopped = false;
    const reply = new Promise<ModTapReply>((resolve) => {
      const queued: QueuedTap = { request, resolve };
      if (rt.running !== null) {
        rt.queued = queued;
        return;
      }
      void this.begin(rt, { kind: "tap", ...request }, queued);
    });
    this.inflight.set(request.requestId, { digest, reply });
    try {
      const answer = await reply;
      this.receipts.set(request.requestId, { digest, reply: answer });
      while (this.receipts.size > TAP_RECEIPTS_MAX) {
        const oldest = this.receipts.keys().next().value;
        if (oldest === undefined) break;
        this.receipts.delete(oldest);
      }
      return { status: 200, body: answer };
    } finally {
      this.inflight.delete(request.requestId);
    }
  }
}

/** A stored reply, answered again: `applied` reads `replayed`, every other outcome as it was. */
function replayOf(reply: ModTapReply): ModTapReply {
  return reply.outcome === "applied" ? { ...reply, outcome: "replayed" } : reply;
}
