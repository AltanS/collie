import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ActivityLedger } from "./activity.ts";
import { loadConfig } from "./config.ts";
import { makeNotifySink, NotificationCoordinator, paneTag } from "./notifications.ts";
import { Push } from "./push.ts";
import { serveNotificationsClear, type ClearSession, type NotificationsClearCaller } from "./server.ts";
import type { AgentStatus, AgentView, NotificationsClearResponse } from "./types.ts";

// `POST /api/notifications/clear`, driven through the exported handler with the real coordinator, the
// real seen ledger and the real Push: who may ask, which device the read path's exemption names, and
// that the whole is what opening every pane already does, no more.

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "collie-clear-route-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function pane(paneId: string, status: AgentStatus): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "demo",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status,
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
  };
}

type Sent = { endpoint: string; body: { type?: string; tag?: string; tags?: string[]; badge?: number; renotify?: boolean } };

/** A real Push with the two devices of these cases: the phone that asks, the laptop that does not. */
function rig(phoneClosesOwn = true) {
  const sent: Sent[] = [];
  const push = new Push({ ...loadConfig(), stateDir: tempDir() }, (s, payload) => {
    sent.push({ endpoint: s.endpoint, body: JSON.parse(payload) });
    return Promise.resolve();
  }, { clearBurstMs: 0 });
  push["_enabled"] = true;
  const keys = { p256dh: "p", auth: "a" };
  push["subs"].set("phone", { endpoint: "phone", keys, device: "phone", closesOwn: phoneClosesOwn });
  push["subs"].set("laptop", { endpoint: "laptop", keys, device: "laptop", closesOwn: true });
  return { push, sent, to: (endpoint: string) => sent.filter((x) => x.endpoint === endpoint) };
}

/**
 * One session with a blocked pane (p1) and a finished one (p2), each its own notification, its alerts
 * delivered, and both panes known to the seen ledger from before they moved.
 */
function session(
  push: Push,
  activity: ActivityLedger,
  name: string,
  muted = false,
  { primary = false, individual = true }: { primary?: boolean; individual?: boolean } = {},
) {
  const timers: (() => void)[] = [];
  const clock = { schedule: (fn: () => void) => timers.push(fn), cancel: () => {} };
  // The primary session's slot is the bare `collie:herd` (`herdTagFor`), and its payload names no session.
  const herdTag = primary ? "collie:herd" : `collie:herd:${name}`;
  const sink = makeNotifySink(push, { isMuted: () => muted }, herdTag, primary ? {} : { session: name });
  const coordinator = new NotificationCoordinator<number>(clock, sink, 0, (s) => s === "blocked" || s === "done", () => individual);
  activity.ensure(name, "p1");
  activity.ensure(name, "p2");
  for (const [id, to] of [["p1", "blocked"], ["p2", "done"]] as const) {
    activity.noteActive(name, id);
    coordinator.onTransition(pane(id, to), "working", to);
  }
  for (const fire of timers.splice(0)) fire();
  const target: ClearSession = { herdTag, coordinator, markAllSeen: () => activity.noteAllSeen(name) };
  return { target, coordinator, herdTag };
}

function ledger() {
  let now = 1_000;
  const activity = new ActivityLedger({ stateDir: tempDir() }, () => now);
  return { activity, tick: () => void (now += 1_000) };
}

const caller = (device: string | null, refuse = false): NotificationsClearCaller => ({
  gate: () => (refuse ? new Response("device not paired", { status: 403 }) : null),
  device: () => device,
});

async function answer(res: Response): Promise<NotificationsClearResponse> {
  // SAFETY: the handler answers `NotificationsClearResponse` (server.ts, serveNotificationsClear).
  return (await res.json()) as NotificationsClearResponse;
}

describe("POST /api/notifications/clear — who may ask", () => {
  test("a refused caller clears nothing and asks for no sessions", async () => {
    const { push, sent } = rig();
    let asked = false;
    const res = serveNotificationsClear(caller("phone", true), () => ((asked = true), []), push, null);
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("device not paired");
    expect(asked).toBe(false);
    expect(sent).toEqual([]);
  });

  test("a credential that names no device still clears, and exempts nobody", async () => {
    const { push, to } = rig();
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "s0");
      await Bun.sleep(0);
      tick();
      const body = await answer(serveNotificationsClear(caller(null), () => [s.target], push, null));
      await Bun.sleep(0);
      expect(body).toEqual({ clearedSlots: [paneTag(s.herdTag, "p2")] });
      // Nobody's slot was called shut, so the clear reaches the phone as it reaches the laptop.
      expect(to("phone").at(-1)!.body).toMatchObject({ type: "clear", tag: paneTag(s.herdTag, "p2") });
      expect(to("laptop").at(-1)!.body).toMatchObject({ type: "clear", tag: paneTag(s.herdTag, "p2") });
    } finally {
      activity.stop();
    }
  });
});

describe("POST /api/notifications/clear — what it does", () => {
  test("two sessions: every pane seen, the finished alerts cleared as one push to the laptop, none to the asker", async () => {
    const { push, sent, to } = rig();
    const { activity, tick } = ledger();
    try {
      const sessions = [session(push, activity, "s0"), session(push, activity, "s1")];
      await Bun.sleep(0);
      sent.length = 0;
      tick();

      const body = await answer(serveNotificationsClear(caller("phone"), () => sessions.map((s) => s.target), push, null));
      await Bun.sleep(0);

      // Every pane of both sessions is seen now, the blocked one too, as a read of each would leave it.
      for (const name of ["s0", "s1"]) {
        for (const id of ["p1", "p2"]) expect(activity.get(name, id)).toEqual({ activeAt: 1_000, seenAt: 2_000 });
      }
      // The blocked alerts stay; the finished ones are gone.
      for (const s of sessions) expect(s.coordinator.outstandingPaneIds()).toEqual(["p1"]);
      expect(body.clearedSlots).toEqual([paneTag("collie:herd:s0", "p2"), paneTag("collie:herd:s1", "p2")]);
      // The asker said it closes its own (`closesOwn`), so its slots are shut and it gets no clear.
      expect(to("phone")).toEqual([]);
      expect(push["clearSpends"].get("phone")).toBeUndefined();
      // The laptop gets both finished alerts' clears in one push (rule 3): one silent push of its budget.
      expect(to("laptop")).toHaveLength(1);
      expect(to("laptop")[0]!.body.tags).toEqual(body.clearedSlots);
    } finally {
      activity.stop();
    }
  });

  test("the asker's exemption is the read path's: a row that never said closesOwn still gets the clear", async () => {
    const { push, to } = rig(false);
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "s0");
      await Bun.sleep(0);
      tick();
      serveNotificationsClear(caller("phone"), () => [s.target], push, null);
      await Bun.sleep(0);
      // `Push.noteSeen` skips a row without `closesOwn`, after a clear-all exactly as after a pane read.
      expect(to("phone").at(-1)!.body).toMatchObject({ type: "clear", tag: paneTag(s.herdTag, "p2") });
    } finally {
      activity.stop();
    }
  });

  test("while snoozed nothing is pushed, the finished alerts still go, and the blocked one stays", async () => {
    const { push, sent } = rig();
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "s0", true);
      tick();
      const body = await answer(serveNotificationsClear(caller("phone"), () => [s.target], push, null));
      await Bun.sleep(0);
      expect(sent).toEqual([]);
      expect(s.coordinator.outstandingPaneIds()).toEqual(["p1"]);
      expect(body.clearedSlots).toEqual([paneTag(s.herdTag, "p2")]);
      expect(activity.get("s0", "p2")).toEqual({ activeAt: 1_000, seenAt: 2_000 });
    } finally {
      activity.stop();
    }
  });

  test("a pane with no alert is seen and its slot listed, and nothing is pushed for it", async () => {
    const { push, sent, to } = rig();
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "s0");
      activity.ensure("s0", "p3"); // a pane that never alerted: idle, or a shell
      await Bun.sleep(0);
      sent.length = 0;
      tick();
      const body = await answer(serveNotificationsClear(caller("phone"), () => [s.target], push, null));
      await Bun.sleep(0);
      expect(body.clearedSlots).toEqual([paneTag(s.herdTag, "p2"), paneTag(s.herdTag, "p3")]);
      expect(activity.get("s0", "p3")).toEqual({ activeAt: 1_000, seenAt: 2_000 });
      // The laptop's one clear names the finished pane only: p3 had nothing out to retract.
      expect(to("laptop")).toHaveLength(1);
      expect(to("laptop")[0]!.body).toMatchObject({ type: "clear", tag: paneTag(s.herdTag, "p2") });
    } finally {
      activity.stop();
    }
  });

  test("the primary session's panes are slotted under the bare herd tag, as a pane read names them", async () => {
    const { push } = rig();
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "default", false, { primary: true });
      await Bun.sleep(0);
      tick();
      const body = await answer(serveNotificationsClear(caller("phone"), () => [s.target], push, null));
      // `seenSlotTag` for a read of the primary's p2 is `collie:herd:p2`, and so is this.
      expect(body.clearedSlots).toEqual(["collie:herd:p2"]);
      expect(push["slotOf"]("phone", "collie:herd:p2")).toBe("closed");
    } finally {
      activity.stop();
    }
  });

  test("summary mode: the herd summary shrinks to the blocked pane on every device, as after a read", async () => {
    const { push, sent, to } = rig();
    const { activity, tick } = ledger();
    try {
      const s = session(push, activity, "s0", false, { individual: false });
      await Bun.sleep(0);
      sent.length = 0;
      tick();
      const body = await answer(serveNotificationsClear(caller("phone"), () => [s.target], push, null));
      await Bun.sleep(0);
      expect(body.clearedSlots).toEqual([paneTag(s.herdTag, "p2")]);
      expect(s.coordinator.outstandingPaneIds()).toEqual(["p1"]);
      // One render of the shrunk summary to each device, silently: a render, not a clear, so no budget.
      for (const device of ["phone", "laptop"]) {
        expect(to(device)).toHaveLength(1);
        expect(to(device)[0]!.body).toMatchObject({ tag: s.herdTag, badge: 1, renotify: false });
        expect(to(device)[0]!.body.type).toBeUndefined();
      }
      // The herd slot is never one a read shuts, so it is not shut here either.
      expect(push["slotOf"]("phone", s.herdTag)).toBe("open");
    } finally {
      activity.stop();
    }
  });

  test("is the per-pane read path applied to every pane: the same pushes, the same slots, the same ledger", async () => {
    // A: the operator opens p1 and p2 through Collie, then the next poll retracts (server.ts's pane
    // route: `activity.noteSeen`, `push.noteSeen` via `noteSeenSlot`; index.ts: `retractSeen`).
    const a = rig();
    const la = ledger();
    const sa = session(a.push, la.activity, "s0");
    // B: one Clear all.
    const b = rig();
    const lb = ledger();
    const sb = session(b.push, lb.activity, "s0");
    try {
      await Bun.sleep(0);
      a.sent.length = 0;
      b.sent.length = 0;
      la.tick();
      lb.tick();

      for (const id of ["p1", "p2"]) {
        la.activity.noteSeen("s0", id);
        a.push.noteSeen("phone", paneTag(sa.herdTag, id));
      }
      sa.coordinator.retractSeen(
        ["p1", "p2"].map((paneId) => {
          const x = la.activity.get("s0", paneId);
          return { paneId, lastActiveAt: x?.activeAt, lastSeenAt: x?.seenAt };
        }),
      );
      serveNotificationsClear(caller("phone"), () => [sb.target], b.push, null);
      await Bun.sleep(0);

      expect(b.sent).toEqual(a.sent);
      expect(lb.activity.snapshot()).toEqual(la.activity.snapshot());
      expect(sb.coordinator.outstandingPaneIds()).toEqual(sa.coordinator.outstandingPaneIds());
      // The one deliberate difference: a read of the blocked pane also shuts its slot on the phone,
      // where clear-all leaves a pane still blocked on the operator as it is, and its count in the icon.
      expect(a.push["slotOf"]("phone", paneTag(sa.herdTag, "p1"))).toBe("closed");
      expect(b.push["slotOf"]("phone", paneTag(sb.herdTag, "p1"))).toBe("open");
      expect(b.push["slotOf"]("phone", paneTag(sb.herdTag, "p2"))).toBe("closed");
    } finally {
      la.activity.stop();
      lb.activity.stop();
    }
  });
});
