// A test rig for the data road (M99 specs 03 and 04): a real Send Protocol with a mux that records
// every call, a real inside hub and socket, and a fake part from `bridge/inside/fake-part.ts`. Test
// code only; nothing in the bridge imports it.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { muxAck, muxUnreachable, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { fakeEdgeTarget, fakeLiveness, FakePart } from "../inside/fake-part.ts";
import { InsideHub } from "../inside/hub.ts";
import { placeHello } from "../inside/place.ts";
import { CommandQueue } from "../inside/queue.ts";
import { PartRegistry } from "../inside/registry.ts";
import { InsideServer, insideSocketPath } from "../inside/server.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

export const DATA_PANE = { session: "main", paneId: "w1:p1" };
const ENV = { HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/run/herdr.sock" };

/** Every mux call the Send Protocol made, by name. The data road makes none. */
export class RecordingMux {
  readonly calls: string[] = [];
  readGrid = (): Promise<MuxOutcome<MuxGrid>> => {
    this.calls.push("readGrid");
    return Promise.resolve(muxUnreachable("the rig has no screen"));
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
  /** A fake part, said hello, bound to {@link DATA_PANE}. */
  part(fields?: Record<string, string[]>): Promise<FakePart>;
  send(id: string, text: string, over?: Partial<SendRequest>): Promise<SendAnswer>;
  stop(): void;
}

let serial = 0;

/** The rig. `enabled` is the kill switch; `limits` shorten the data road's waits for a test. */
export async function dataRig(options: { enabled?: boolean; takeMs?: number; wordMs?: number; inside?: boolean } = {}): Promise<DataRig> {
  const dir = mkdtempSync(join(tmpdir(), "data-"));
  const mux = new RecordingMux();
  const target = fakeEdgeTarget({ session: "main", panes: ["w1:p1"], foreground: [process.pid] });
  const hub = new InsideHub({ registry: new PartRegistry({ log: () => {} }), queue: new CommandQueue(), place: (hello) => placeHello(hello, [target], fakeLiveness(new Map([[process.pid, 7]]))) });
  const socket = insideSocketPath(dir);
  const server = new InsideServer({ socketPath: socket, hub, log: () => {} });
  if (!(await server.start())) throw new Error("the rig's inside socket did not start");
  const store = new RequestStore(join(dir, "sends"));
  const holds = new HoldStore(join(dir, "held"));
  const claude = loadProfiles().get("claude");
  const protocol = new SendProtocol({
    mux,
    gate: new KeyGate(mux),
    store,
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: () => Promise.resolve(claude === undefined ? null : profileFor("claude", "2.1.200", { log: () => undefined })),
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
    part: async (fields = {}) => {
      const part = new FakePart(socket, { env: ENV, pidStartTime: 7, ...fields });
      await part.hello();
      return part;
    },
    send: (id, text, over = {}) => protocol.handle({ id, text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "w1:p1", harness: "claude" }),
    stop: () => server.stop(),
  };
}

/** A fresh request id the store and the wire both take. */
export function dataId(): string {
  serial += 1;
  return `req-data${String(serial).padStart(6, "0")}`;
}
