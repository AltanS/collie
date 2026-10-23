// The one door to Vercel's durable-harness and its World (M66). Every call the `./durable-harness` entry makes to
// `durable-harness` or `@workflow/*` is in this file and nowhere else: list the program's runs, read one session
// without taking it, append to and read a run's Collie journal, take a session over, name the World, check versions.
// The rest of the entry (`pi-source.ts`, `route.ts`, `with-collie.ts`) talks to the {@link WorldPort} interface, so a
// test drives it with an in-memory World, and a release of durable-harness that moves an API moves this file only.
// durable-harness needs Node 22 or later; this file reads `process.env` and nothing else of the runtime.
// Erasable TypeScript only, so Node runs it as it is.

import type { World } from "@workflow/world";
import { getWorld, worldTarget } from "durable-harness";
import { acquireHarness, type Opener, openWorldReader, type SessionReader, StorageFenced } from "durable-harness/pi-durable";
import type { Harness } from "@earendil-works/pi-durable";
import { type JournalRecord, parseJournal } from "../core/journal.ts";

/** The versions this entry was tested on (the M66 spike, 2026-10-21). {@link WorldPort.checkVersions} holds an install to them. */
export const TESTED = {
  /** Exact: a beta moves its API between releases. */
  durableHarness: "0.0.1-beta.6",
  /** The `@workflow/world` package of the test install. The runtime check reads the World's spec version instead. */
  workflowWorld: "5.0.5",
  /** `World.specVersion` of world-local 5.1.2 and world-vercel 5.2 (`SPEC_VERSION_CURRENT` of @workflow/world 5.0.5). */
  worldSpec: 8,
} as const;

/** A run's status as the World lists it. A finished run (`completed`, `failed`, `cancelled`) is a closed conversation. */
export type RunStatus = string;

/** One run of the program's workflow: one session, one pane. */
export interface RunInfo {
  runId: string;
  status: RunStatus;
  workflowName: string;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601, when the World has one. */
  updatedAt?: string;
  /** ISO 8601, once the run finished. */
  completedAt?: string;
}

/** The statuses that end a run. */
const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);
export const runEnded = (status: RunStatus) => ENDED.has(status);

/** One root-conversation entry as the read-only reader gives it: the fields `Mapper.replay` reads, plus where it landed. */
export interface SessionEntryView {
  id: string;
  kind: string;
  model?: readonly unknown[];
  data?: unknown;
  byTaskId?: string;
  /** ISO time of the commit that wrote it. */
  at: string;
  /** Slot of the commit that wrote it. */
  slot: number;
}

/** A task as the log tells it. Only what the turn rule reads. */
export interface SessionTaskView {
  id: string;
  kind: string;
  status: string;
  starts: readonly { slot: number; at: string }[];
}

/** What the read-only reader shows of a session, without its commit log (which can be large and is never served). */
export interface SessionView {
  sessionId: string;
  /** Highest slot in the run's log. Every commit raises it, the throttled partial of a streamed reply included. */
  eventCount: number;
  /** Some task has not reached `terminal`. */
  unfinished: boolean;
  entries: readonly SessionEntryView[];
  /** Pi's `pi.live` document: `run` while a run is under way, `generation.message` while a reply is written. `{}` (not absent) when idle. */
  live: { run?: unknown; generation?: { message?: unknown } } | undefined;
  tasks: readonly SessionTaskView[];
}

/** A taken session: Pi's own Harness on it, and the release that closes it when this was the last holder. */
export interface HarnessLease {
  harness: Harness;
  release(): Promise<void>;
}

/** The World, as the rest of the entry sees it. */
export interface WorldPort {
  /** Every run of the program's workflow, in every status, oldest first. `name` is the opener's name (`resumeWith(open, { name })`). */
  listRuns(name: string): Promise<RunInfo[]>;
  /** One run, or undefined when the World does not know it. */
  getRun(id: string): Promise<RunInfo | undefined>;
  /** The session as its log has it, read without taking it over. */
  readSession(id: string): Promise<SessionView>;
  /** Append one record to the run's journal, `<runId>_collie`, as one JSON line. */
  appendJournal(id: string, record: JournalRecord): Promise<void>;
  /** The run's journal, in stream order. An empty or missing stream is an empty list. */
  readJournal(id: string): Promise<JournalRecord[]>;
  /** Take the session over in this process, through the opener `withCollie` returned. */
  openHarness(id: string): Promise<HarnessLease>;
  /** A name for the World this port reads: the same on every instance of one deployment. */
  worldIdentity(): string;
  /** Throws one line when the installed durable-harness, or the World's spec, is not the one this entry was tested on. */
  checkVersions(): Promise<void>;
}

/** The name of a run's journal. world-local keys a stream by its name alone, so the run id is part of it. */
export const journalName = (runId: string) => `${runId}_collie`;

/**
 * The opener's name in a durable-harness workflow name, `workflow//durable-harness@<version>//<name>`, for any
 * version; undefined for any other workflow. durable-harness does not export its own parser (`harnessOf`), and the
 * World filters by the exact name only, which carries the version, so the port lists every run and filters here.
 */
export function harnessNameOf(workflowName: string): string | undefined {
  return /^workflow\/\/durable-harness@[^/]+\/\/(.+)$/.exec(workflowName)?.[1];
}

export type { Opener, WorldStorage } from "durable-harness/pi-durable";
export type { World };

/** Is this error the one a takeover gives the process that lost the session? */
export const isStorageFenced = (e: Error): boolean => e instanceof StorageFenced;

export interface WorldPortOptions {
  /** The World. Left out: durable-harness's `getWorld()`, which on world-local also runs the queue in this process. */
  world?: World;
  /** The opener `withCollie` returned. Only `openHarness` needs it. */
  open?: Opener;
  /**
   * The World's name in the epoch. Left out: the target `getWorld()` picks, with world-local's data folder or the
   * Vercel project and environment. Name it for a World given in `world` that the environment does not describe.
   */
  identity?: string;
  /** How a session is read. Left out: durable-harness's `openWorldReader`. A test passes its own. */
  reader?: (id: string, world: World) => SessionReader;
  /** How many readers the port keeps warm (a refresh reads only what the log gained). Default 32. */
  readers?: number;
}

/** The longest page the World is asked for. */
const PAGE = 100;
/** A list stops after this many pages: 100 000 runs. A World that pages for ever is a bug, not a program. */
const MAX_PAGES = 1000;

const iso = (v: Date | string | null | undefined): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
};

interface RawRun {
  runId: string;
  status: string;
  workflowName: string;
  createdAt: Date | string;
  updatedAt?: Date | string;
  completedAt?: Date | string;
}

function runInfo(r: RawRun): RunInfo {
  const info: RunInfo = { runId: r.runId, status: r.status, workflowName: r.workflowName, createdAt: iso(r.createdAt) ?? new Date(0).toISOString() };
  const updatedAt = iso(r.updatedAt);
  if (updatedAt !== undefined) info.updatedAt = updatedAt;
  const completedAt = iso(r.completedAt);
  if (completedAt !== undefined) info.completedAt = completedAt;
  return info;
}

const env = (name: string): string | undefined => process.env[name];

/** The World `getWorld()` makes here, by name: its target, and the folder or project that tells two of them apart. */
function identityFromEnv(): string {
  const target = worldTarget();
  if (target === "local") {
    const dir = env("WORKFLOW_LOCAL_DATA_DIR") ?? ".workflow-data";
    return `local:${dir.startsWith("/") ? dir : `${process.cwd()}/${dir}`}`;
  }
  if (target === "vercel") return `vercel:${env("VERCEL_PROJECT_ID") ?? ""}:${env("VERCEL_TARGET_ENV") ?? env("VERCEL_ENV") ?? ""}`;
  return target;
}

export function createWorldPort(o: WorldPortOptions = {}): WorldPort {
  let world: Promise<World> | undefined = o.world === undefined ? undefined : Promise.resolve(o.world);
  const worldOf = () => (world ??= getWorld());
  const readerOf = o.reader ?? ((id: string, w: World) => openWorldReader(id, { world: w }));
  const warm = new Map<string, SessionReader>();
  const keep = o.readers ?? 32;

  async function reader(id: string): Promise<SessionReader> {
    const have = warm.get(id);
    if (have !== undefined) {
      warm.delete(id);
      warm.set(id, have);
      return have;
    }
    const made = readerOf(id, await worldOf());
    warm.set(id, made);
    while (warm.size > keep) warm.delete(warm.keys().next().value!);
    return made;
  }

  let checked: Promise<void> | undefined;

  return {
    async listRuns(name) {
      const w = await worldOf();
      const runs: RunInfo[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const got = await w.runs.list({ pagination: cursor === undefined ? { limit: PAGE } : { limit: PAGE, cursor }, resolveData: "none" });
        for (const r of got.data) if (harnessNameOf(r.workflowName) === name) runs.push(runInfo(r));
        if (!got.hasMore || got.cursor === null || got.cursor === undefined) break;
        cursor = got.cursor;
      }
      // Oldest first, and the run id breaks a tie, so every instance lists the same order.
      return runs.toSorted((a, b) => (a.createdAt === b.createdAt ? (a.runId < b.runId ? -1 : 1) : a.createdAt < b.createdAt ? -1 : 1));
    },

    async getRun(id) {
      const w = await worldOf();
      try {
        return runInfo(await w.runs.get(id, { resolveData: "none" }));
      } catch (e) {
        if (e instanceof Error && e.name === "WorkflowRunNotFoundError") return undefined;
        throw e;
      }
    },

    async readSession(id) {
      const r = await reader(id);
      try {
        await r.refresh();
        const s = await r.snapshot();
        return { sessionId: s.sessionId, eventCount: s.eventCount, unfinished: s.unfinished, entries: s.entries, live: s.live, tasks: s.tasks };
      } catch (e) {
        warm.delete(id); // a reader that failed may hold half a read: the next one starts clean
        throw e;
      }
    },

    async appendJournal(id, record) {
      const w = await worldOf();
      await w.streams.write(id, journalName(id), `${JSON.stringify(record)}\n`);
    },

    async readJournal(id) {
      const w = await worldOf();
      const parts: Uint8Array[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const got = await w.streams.getChunks(id, journalName(id), cursor === undefined ? { limit: 1000 } : { limit: 1000, cursor });
        for (const chunk of got.data) parts.push(chunk.data);
        if (!got.hasMore || got.cursor === null) break;
        cursor = got.cursor;
      }
      let size = 0;
      for (const p of parts) size += p.byteLength;
      const all = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        all.set(p, at);
        at += p.byteLength;
      }
      // Lines, not chunks: a record is whole on its line wherever the World cut the bytes.
      return parseJournal(new TextDecoder().decode(all));
    },

    async openHarness(id) {
      const open = o.open;
      if (open === undefined) throw new Error("collie: taking a session over needs the opener withCollie returned (WorldPortOptions.open)");
      const lease = await acquireHarness(id, open, { world: await worldOf() });
      return { harness: lease.harness, release: () => lease.release() };
    },

    worldIdentity() {
      return o.identity ?? identityFromEnv();
    },

    checkVersions() {
      checked ??= (async () => {
        const pkg: { version?: string } = (await import("durable-harness/package.json", { with: { type: "json" } })).default;
        if (pkg.version !== TESTED.durableHarness) {
          throw new Error(
            `collie: durable-harness ${String(pkg.version)} is installed, and @colliepwa/durable-sdk/durable-harness is tested on ${TESTED.durableHarness} only; install durable-harness@${TESTED.durableHarness}`,
          );
        }
        const spec = (await worldOf()).specVersion;
        if (spec !== TESTED.worldSpec) {
          throw new Error(`collie: the World speaks Workflow spec ${String(spec)}, and @colliepwa/durable-sdk/durable-harness is tested on spec ${TESTED.worldSpec} (@workflow/world ${TESTED.workflowWorld}) only`);
        }
      })();
      // A failed check is asked again next time: the install may be fixed without a restart of the caller's test.
      checked.catch(() => (checked = undefined));
      return checked;
    },
  };
}
