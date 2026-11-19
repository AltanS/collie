// Shared by protocol.override-reach.test.ts and protocol.override-reach.slow.test.ts: the helpers both files need. Not a test file.

import { afterEach, beforeEach, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor, resetProfileLog, type Profile } from "../../web/src/lib/surface/profile.ts";
import { type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { GENERIC_PROBE, RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { HoldStore } from "./holds.ts";
import type { PaneForeground } from "../pane-binary.ts";

// `import.meta.url`, not `import.meta.dir`: `bridge/root.test.ts` bans the latter in every file that is not a `*.test.ts`,
// and this module only ever runs from the checkout.
const HERE = fileURLToPath(new URL(".", import.meta.url));

export const FIXTURES = join(HERE, "..", "..", "web", "src", "fixtures");

export const pane = (name: string): string => readFileSync(join(FIXTURES, "panes", name), "utf8");

/** A harness with no profile: its send goes blind (a bare shell is one). */
export const NO_PROFILE = "nothing-known";

/** A harness whose profile never finds its frame and has no block reader: every screen is read unread. */
export const FRAMELESS = "frameless-test";

export function framelessProfile(): Profile {
  const base = loadProfiles().get("agy")!;
  const never = { pattern: "(?!)", column: 0 };
  const { paste, ...rest } = base;
  void paste;
  return {
    ...rest,
    id: FRAMELESS,
    identity: { ...base.identity, agentNames: [] },
    versions: [{ ...base.versions[0]!, range: "0.0.0 - *", low: "0.0.0", high: null }],
    idle: { ...base.idle, frame: { ...base.idle.frame, top: never, prompt: { pattern: "(?!)(?<draft>.*)", column: 0 }, bottom: never }, runningRows: [] },
    keys: { ...base.keys, submit: ["Enter"], enterWhileRunning: "queues" },
    reservedLeads: ["/", "!", "@"],
    probe: { ...base.probe, char: GENERIC_PROBE },
  };
}

export type Write = { readonly how: "type" | "paste" | "block"; readonly text: string };

/** One screen, served as it is; every text write and key is recorded, and nothing on screen changes. */
export class ScreenPane {
  writes: Write[] = [];
  keys: string[] = [];
  revision = 1;
  constructor(public screen: string) {}

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: this.revision }));
  };

  private wrote(how: Write["how"], text: string): Promise<MuxAck> {
    this.writes.push({ how, text });
    this.revision++;
    return Promise.resolve(muxAck());
  }

  typeText = (paneId: string, text: string): Promise<MuxAck> => (void paneId, this.wrote("type", text));
  pasteText = (paneId: string, text: string): Promise<MuxAck> => (void paneId, this.wrote("paste", text));
  pasteBlock = (paneId: string, text: string): Promise<MuxAck> => (void paneId, this.wrote("block", text));

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.keys.push(...keys);
    this.revision++;
    return Promise.resolve(muxAck());
  };
}

export let dir: string;

/** Registers the per-test scratch folder hooks in the test file that calls it. */
export function useScratchDir(): void {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "collie-override-"));
    resetProfileLog();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
}

export let ids = 0;

export const nextId = (): string => `override-${String(++ids).padStart(8, "0")}`;

export interface RigOptions {
  readonly harness?: string;
  readonly version?: string;
  readonly edit?: (profile: Profile) => Profile;
  /** What the multiplexer can write: typed keys only, a bracketed paste (tmux), or a whole-text paste (Herdr). */
  readonly write?: "type" | "paste" | "block";
  readonly holds?: HoldStore;
  /** What the multiplexer's foreground read answers for the pane (`SendDeps.paneForeground`); absent: no read. */
  readonly foreground?: PaneForeground;
  /** The foreground read throws. */
  readonly foregroundThrows?: true;
}

export function rig(screen: ScreenPane, options: RigOptions = {}) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const harness = options.harness ?? "claude";
  const write = options.write ?? "paste";
  const mux =
    write === "type"
      ? { readGrid: screen.readGrid, typeText: screen.typeText }
      : write === "paste"
        ? { readGrid: screen.readGrid, typeText: screen.typeText, pasteText: screen.pasteText }
        : { readGrid: screen.readGrid, typeText: screen.typeText, pasteText: screen.pasteText, pasteBlock: screen.pasteBlock };
  const store = new RequestStore(join(dir, `sends-${String(ids)}`), now);
  const protocol = new SendProtocol({
    mux,
    gate: new KeyGate(screen, now),
    store,
    locks: new SessionLocks(),
    ring: new RowRing(),
    holds: options.holds,
    paneForeground: options.foregroundThrows === true ? () => Promise.reject(new Error("gone")) : options.foreground === undefined ? undefined : () => options.foreground!,
    profile: (name: string) => {
      if (name === NO_PROFILE) return Promise.resolve(null);
      const base = name === FRAMELESS ? framelessProfile() : loadProfiles().get(name);
      if (base === undefined) return Promise.resolve(null);
      const profile = options.edit === undefined ? base : options.edit(base);
      return Promise.resolve(profileFor(name, options.version ?? "2.1.325", { log: () => undefined, profiles: new Map([[name, profile]]) }));
    },
    generation: () => "gen-1",
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const target = { session: "main", paneId: "%1", harness };
  const prepare = async (): Promise<string> => {
    const answer = await protocol.handle({ id: "prepare", text: "", mode: "prepare" }, target);
    expect(answer.rowsHash).toBeDefined();
    return answer.rowsHash!;
  };
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> => protocol.handle({ id: nextId(), text, mode: "send", ...over }, target);
  /** The person's override: a prepare, then the send with the hash it gave. */
  const override = async (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> => send(text, { rowsHash: await prepare(), override: true, fromPhone: true, ...over });
  return { protocol, store, clock, prepare, send, override };
}

/** A refusal that typed nothing and pressed nothing, with the rows now and their hash. */
export function refusedClean(answer: SendAnswer, screen: ScreenPane, reason: string): void {
  expect(answer.receipt).toMatchObject({ outcome: "refused", reason, keys: [] });
  expect(screen.writes).toEqual([]);
  expect(screen.keys).toEqual([]);
  expect(answer.rowsHash).toMatch(/^[0-9a-f]+$/u);
  expect(answer.rows?.length ?? 0).toBeGreaterThan(0);
  expect(answer.offers).toEqual(["keys"]);
}
