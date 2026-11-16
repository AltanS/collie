// A test rig for the data road (M99 specs 03 and 04): a real Send Protocol with a mux that records
// every call, a real inside hub and socket, and a fake part from `bridge/inside/fake-part.ts`. Test
// code only; nothing in the bridge imports it.

import { describe, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HOST } from "../host.ts";
import { muxAck, muxOk, muxUnreachable, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { fakeEdgeTarget, fakeLiveness, FakePart } from "./fake-part.ts";
import { InsideHub } from "./hub.ts";
import { placeHello } from "./place.ts";
import { CommandQueue } from "./queue.ts";
import { PartRegistry } from "./registry.ts";
import { InsideServer, insideSocketPath } from "./server.ts";
import { HoldStore } from "../surface/holds.ts";
import { KeyGate } from "../surface/key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "../surface/protocol.ts";
import { RequestStore } from "../surface/requests.ts";

// The data path is off on Windows in 1.29.0 (ADR 0140, decision 15: Windows keeps the screen path):
// `InsideServer.start()` answers false there, so `dataRig` cannot start. Every test that builds on
// the rig, or dials the inside socket, is `dataTest` or `dataDescribe`: a skip on win32, as the walky
// and hold socket tests are. The Windows behaviour itself (no socket, the gate says "platform") runs
// everywhere in server.test.ts and gate.test.ts with an injected host.
const NO_DATA_PATH = HOST.platform === "win32";
export const dataTest = test.skipIf(NO_DATA_PATH);
export const dataDescribe = describe.skipIf(NO_DATA_PATH);

export const DATA_PANE = { session: "main", paneId: "w1:p1" };
const ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" };

/** Every mux call the Send Protocol made, by name. The data road makes none. */
export class RecordingMux {
  readonly calls: string[] = [];
  /** The screen every read answers, a captured pane's text; null for a pane that cannot be read. Nothing typed changes it. */
  screen: string | null = null;
  readGrid = (paneId: string): Promise<MuxOutcome<MuxGrid>> => {
    this.calls.push("readGrid");
    if (this.screen === null) return Promise.resolve(muxUnreachable("the rig has no screen"));
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 1 }));
  };
  typeText = (): Promise<MuxAck> => {
    this.calls.push("typeText");
    return Promise.resolve(muxAck());
  };
  pasteText = (): Promise<MuxAck> => {
    this.calls.push("pasteText");
    return Promise.resolve(muxAck());
  };
  writeKeys = (): Promise<MuxAck> => {
    this.calls.push("writeKeys");
    return Promise.resolve(muxAck());
  };
}

export interface DataRig {
  readonly mux: RecordingMux;
  readonly hub: InsideHub;
  readonly protocol: SendProtocol;
  readonly store: RequestStore;
  readonly holds: HoldStore;
  readonly socket: string;
  /**
   * A fake part, said hello, bound to {@link DATA_PANE}; with `idle: false` it reports no turn yet, and
   * with `draft` it says whether the box holds a draft (`draft.state`). With no `draft` the draft stays
   * unknown, and a WalkyTalky message takes the screen road.
   */
  part(fields?: Record<string, string[]>, options?: { idle?: boolean; draft?: boolean }): Promise<FakePart>;
  send(id: string, text: string, over?: Partial<SendRequest>): Promise<SendAnswer>;
  stop(): void;
}

let serial = 0;

/**
 * The rig. `harness` and `version` name the profile the Send Protocol reads (a test names one: this
 * folder names no harness); `enabled` is the kill switch; `limits` shorten the data road's waits; `now`
 * is the hub's clock, for the age of a part's word.
 */
export async function dataRig(options: { harness: string; version: string; enabled?: boolean; takeMs?: number; wordMs?: number; inside?: boolean; now?: () => number }): Promise<DataRig> {
  const dir = mkdtempSync(join(tmpdir(), "data-"));
  const mux = new RecordingMux();
  const target = fakeEdgeTarget({ session: "main", panes: ["w1:p1"], foreground: [process.pid] });
  const hub = new InsideHub({
    registry: new PartRegistry({ log: () => {} }),
    queue: new CommandQueue(),
    place: (hello) => placeHello(hello, [target], fakeLiveness(new Map([[process.pid, 7]]))),
    now: options.now ?? Date.now,
    log: () => {},
  });
  const socket = insideSocketPath(dir);
  const server = new InsideServer({ socketPath: socket, hub, log: () => {} });
  if (!(await server.start())) throw new Error("the rig's inside socket did not start");
  const store = new RequestStore(join(dir, "sends"));
  const holds = new HoldStore(join(dir, "held"));
  const known = loadProfiles().get(options.harness);
  const protocol = new SendProtocol({
    mux,
    gate: new KeyGate(mux),
    store,
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: () => Promise.resolve(known === undefined ? null : profileFor(options.harness, options.version, { log: () => undefined })),
    generation: () => "gen-1",
    holds,
    data:
      options.inside === false
        ? undefined
        : { enabled: () => options.enabled ?? true, door: hub, limits: { takeMs: options.takeMs ?? 500, wordMs: options.wordMs ?? 800 } },
  });
  return {
    mux,
    hub,
    protocol,
    store,
    holds,
    socket,
    part: async (fields = {}, how = {}) => {
      const part = new FakePart(socket, { env: ENV, pidStartTime: 7, ...fields });
      await part.hello();
      // A part that reported its turn idle once: the bridge knows the turn (M99 review item 6).
      if (how.idle !== false) await part.event("turn.end", { turn: null });
      // And its box once, as a real part does after each hello (spec 05): no draft, unless the test says.
      if (how.draft !== undefined) await part.event("draft.state", { present: how.draft });
      return part;
    },
    send: (id, text, over = {}) => protocol.handle({ id, text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "w1:p1", harness: options.harness }),
    stop: () => server.stop(),
  };
}

/** A fresh request id the store and the wire both take. */
export function dataId(): string {
  serial += 1;
  return `req-data${String(serial).padStart(6, "0")}`;
}
