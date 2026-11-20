import { describe, expect, test } from "bun:test";

import { mergeSnapshot } from "./crew/merge.ts";
import { PeerNotifier } from "./crew/notify.ts";
import { makeNotifySink, NotificationCoordinator, type NotifyClock } from "./notifications.ts";
import { pushPayloadData, type PushMessage } from "./push.ts";
import { herdTagFor } from "./sessions.ts";
import type { AgentStatus, AgentView, PaneWire, SnapshotResponse } from "./types.ts";

// A PUSH'S PROJECT PICTURE, ASKED OF ALL THREE HALVES AT ONCE (round 17).
//
// The picture of a push is looked up by the service worker in what the PAGE wrote, by the words the
// BRIDGE put in the push. Each half was tested alone and passed, and the operator's phone still showed a
// push with no picture while the dashboard showed it. So this file runs the lead's real merge (what the
// page keys a pane by), the real notifiers and payload (what the push names), the page's real writer and
// the worker's real reader over one fake Cache Storage. It imports across the boundary on purpose, as the
// other `*-web-contract.test.ts` files do.

const ORIGIN = "https://collie.test";

// The page reads the mount off a `<meta>`, its tables out of localStorage, and its origin off `location`.
const local = new Map<string, string>();
Object.defineProperty(globalThis, "document", { value: { querySelector: () => null, addEventListener: () => {}, visibilityState: "visible", documentElement: { lang: "", dataset: {}, classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false }, style: { setProperty: () => {} } } }, configurable: true });
Object.defineProperty(globalThis, "localStorage", {
  value: { getItem: (k: string) => local.get(k) ?? null, setItem: (k: string, v: string) => void local.set(k, v), removeItem: (k: string) => void local.delete(k) },
  configurable: true,
});
Object.defineProperty(globalThis, "location", { value: { origin: ORIGIN }, configurable: true });
Object.defineProperty(globalThis, "__BUILD_INFO__", { value: { version: "0.0.0", channel: "dev" }, configurable: true });

/** Cache Storage, the slice both the page and the worker use. */
const stores = new Map<string, Map<string, Response>>();
const storage = {
  open: async (name: string) => {
    const store = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, store);
    return {
      put: async (key: string, response: Response) => void store.set(key, response),
      match: async (key: string) => store.get(key)?.clone(),
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (request: { url: string }) => store.delete(request.url),
    };
  },
  has: async (name: string) => stores.has(name),
  delete: async (name: string) => stores.delete(name),
  keys: async () => [...stores.keys()],
};
Object.defineProperty(globalThis, "caches", { value: storage, configurable: true });

const page = await import("../web/src/lib/project-picture.ts");
const { pushPictureFor } = await import("../web/src/lib/project-picture-push.ts");
const { decidePush } = await import("../web/src/lib/push-decision.ts");

const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));
const chunk = (type: string, data: number[]) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
/** A PNG of one side, so each machine's picture can be told apart in the worker's answer. */
const png = (side: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk("IHDR", [...be32(side), ...be32(side), 8, 6, 0, 0, 0]), ...chunk("IDAT", Array.from({ length: 16 }, () => 0)), ...chunk("IEND", [])]);
const asUrl = (bytes: Uint8Array) => `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`;

const LEAD = "desk";
const MEMBER = "laptop";
const LEAD_V = "aaaaaaaaaaaaaaaaaaaaaaaa";
const MEMBER_V = "bbbbbbbbbbbbbbbbbbbbbbbb";
const LEAD_PNG = png(128);
const MEMBER_PNG = png(256);

// The fetch answers each machine's picture; the canvas hands the bytes back as both copies.
const fetched: string[] = [];
/** A device that never saw a picture, Cache Storage empty, with the two seams set again (a reset clears them). */
function freshPhone(): void {
  page.__resetProjectPictures();
  stores.clear();
  page.__setProjectPictureSeams({
    fetch: async (path) => {
      fetched.push(path);
      return new Blob([path.includes(`host=${MEMBER}`) ? MEMBER_PNG : LEAD_PNG], { type: "image/png" });
    },
    canvas: { draw: async (bytes, boxes) => boxes.map(() => bytes), dataUrl: async () => "data:image/png;base64,AAAA" },
  });
}

// The lead's own pane and the member's pane share their id on purpose: only the machine tells them apart.
function pane(status: AgentStatus, picture?: string): PaneWire {
  const out: PaneWire = { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "athena", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status, cwd: "/home/you/athena", focused: false, kind: "agent" };
  if (picture !== undefined) out.picture = picture;
  return out;
}
const peerBody = (status: AgentStatus) => ({ sessions: [], agents: [pane(status, MEMBER_V)], shellPanes: [], workspaces: [], tabs: [] });

/** The snapshot the phone gets from the lead: the lead's real merge. */
function merged(): SnapshotResponse {
  const leadBody: SnapshotResponse = { bridge: "connected", agents: [pane("blocked", LEAD_V)], shellPanes: [], workspaces: [], tabs: [], sessions: [], notifications: { snoozedUntil: null }, ts: 1 };
  const state = { memberId: MEMBER, health: "reachable", lastSeenAt: 0, reason: null, version: null, conflict: null, preflight: null } as const;
  return mergeSnapshot(leadBody, { self: { id: LEAD, name: LEAD }, peers: [{ state, name: MEMBER, body: peerBody("blocked") }], now: 1 });
}

/** The page: each row starts its load, then the root writes the map, as one commit's effects run. */
async function phoneShows(snapshot: SnapshotResponse): Promise<void> {
  const loads = snapshot.agents.map((a) => page.loadPicture(a.picture ?? "", a.host ?? null));
  page.rememberPanePictures(snapshot.agents, snapshot.servers?.find((s) => s.isLead)?.id);
  await Promise.all(loads);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The JSON a phone receives, as `Push.send` builds it: the message and its `data`. */
const wire = (msg: PushMessage) => JSON.stringify({ ...msg, data: pushPayloadData(msg) });

const clock = (): NotifyClock<number> & { fire(): void } => {
  const fns: (() => void)[] = [];
  return { schedule: (fn) => fns.push(fn), cancel: () => {}, fire: () => fns.splice(0).forEach((fn) => fn()) };
};

/** The lead's push for the member's pane: the peer notifier over two sweeps. */
function memberPush(): string {
  const sent: PushMessage[] = [];
  const c = clock();
  const peer = new PeerNotifier<number>({ clock: c, push: { send: (m) => void sent.push(m) }, mute: { isMuted: () => false }, delayMs: 5_000, isNotifiable: (s) => s === "blocked", individual: () => true });
  peer.observe(MEMBER, peerBody("working"));
  peer.observe(MEMBER, peerBody("blocked"));
  c.fire();
  return wire(sent.at(-1)!);
}

/** The lead's push for its own pane: its own herd's coordinator and sink. */
function leadPush(): string {
  const sent: PushMessage[] = [];
  const c = clock();
  const sink = makeNotifySink({ send: (m) => void sent.push(m) }, { isMuted: () => false }, herdTagFor(true, ""));
  const herd = new NotificationCoordinator<number>(c, sink, 5_000, (s) => s === "blocked", () => true);
  const own: AgentView = pane("blocked");
  herd.onTransition(own, "working", "blocked");
  c.fire();
  return wire(sent.at(-1)!);
}

/** The worker: the decision the push makes, then the picture it looks up. */
async function workerShows(payload: string): Promise<string | null> {
  const decision = decidePush(JSON.parse(payload), false);
  if (decision.kind !== "show") throw new Error(`the push decided ${decision.kind}`);
  return pushPictureFor(storage, ORIGIN, "/", { paneId: decision.paneId, host: decision.host });
}

describe("a push finds the picture the page wrote for its pane", () => {
  test("a member's pane: the member's picture, never the lead's pane of the same id", async () => {
    freshPhone();
    await phoneShows(merged());
    expect(JSON.parse(memberPush()).data).toEqual({ paneId: "w1:p1", host: MEMBER });
    expect(await workerShows(memberPush())).toBe(asUrl(MEMBER_PNG));
  });

  test("the lead's own pane, whose push names no host while the snapshot tags it with the lead's id", async () => {
    freshPhone();
    const snapshot = merged();
    expect(snapshot.agents.map((a) => a.host)).toEqual([LEAD, MEMBER]);
    await phoneShows(snapshot);
    expect(JSON.parse(leadPush()).data).toEqual({ paneId: "w1:p1" });
    expect(await workerShows(leadPush())).toBe(asUrl(LEAD_PNG));
  });

  test("Cache Storage lost and localStorage kept: the next page life puts the map and the banners back", async () => {
    freshPhone();
    await phoneShows(merged());
    const first = fetched.length;
    // A page life with the Cache intact fetches nothing again.
    page.__reloadProjectPictures();
    await phoneShows(merged());
    expect(fetched.length).toBe(first);
    // A stuck update's escape (lib/pwa.ts) deletes every Cache; the page's copies and memory stay.
    stores.clear();
    expect(await workerShows(memberPush())).toBeNull();
    page.__reloadProjectPictures();
    await phoneShows(merged());
    expect(fetched.length).toBe(first + 2);
    expect(await workerShows(memberPush())).toBe(asUrl(MEMBER_PNG));
    expect(await workerShows(leadPush())).toBe(asUrl(LEAD_PNG));
  });
});
