// The Send Protocol against the scripted fake multiplexer: part held-draft. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type HeldCancelAnswer, type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { type Surface } from "../../web/src/lib/surface/surface.ts";
import { SendProtocol, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { HoldStore } from "./holds.ts";
import { OFFERED, DIALOG, FakePane, LIVE_ROW, NO_PROFILE, PROBE, type Rig, dir, neverEscape, nextId, rig, shellText, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("a send at a box that is not free is held, not refused (2026-10-17 field case)", () => {
  const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
  const RUNNING = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  const BOX_HELD = "The input box is not free. Collie keeps this and sends it when the box is free.";
  const queued = (clock = { now: 1_000_000 }): Rig & { holds: HoldStore } => {
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    return { ...rig({ holds, clock }), holds };
  };
  const tick = async (r: Rig, surface: Surface = FREE): Promise<(SendAnswer | null)[]> => Promise.all(r.protocol.tickHolds("main", () => surface));

  test("a dialog at the box holds the message: receipt held, nothing typed, the box's line as detail", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    const answer = await r.send("ok for the open PRs", { id: "box-0000001" });
    expect(answer.receipt).toMatchObject({ requestId: "box-0000001", outcome: "held", keys: [] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    expect(answer.detail).toBe(BOX_HELD);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["box-0000001"]);
  });

  test("a box that moves between the two S0 reads holds the message too", async () => {
    const r = queued();
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await r.send("hello", { id: "box-0000002" });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.detail).toBe(BOX_HELD);
  });

  test("a hold from a box that was not free goes on the first free poll once its cause cleared (omp gang three 03-launch, 2026-10-26)", async () => {
    const clock = { now: 1_000_000 };
    const r = queued(clock);
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000003" });
    // The dialog is still up: the poll reads it, nothing goes.
    expect(await tick(r, { revision: 1, turn: "idle", modal: "unreadable", composer: "unknown" })).toEqual([]);
    r.pane.dialog = null;
    // An idle pane polls every 12 s: one free poll is enough, not five over ten seconds.
    clock.now += 12_000;
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "box-0000003", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> ok for the open PRs");
    expect(r.holds.list()).toEqual([]);
    neverEscape(r.pane);
  });

  test("after a release, the next box hold keeps the quiet rule: five free polls over ten seconds", async () => {
    const clock = { now: 1_000_000 };
    const r = queued(clock);
    r.pane.dialog = DIALOG;
    await r.send("first", { id: "box-0000013" });
    await r.send("second", { id: "box-0000014" });
    r.pane.dialog = null;
    const [first] = await tick(r);
    expect(first?.receipt).toMatchObject({ requestId: "box-0000013", outcome: "sent" });
    // The first one may start a turn the screen has not drawn yet: the second waits for the quiet rule.
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    clock.now += 2500;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.transcript.at(-1)).toBe("> first");
    clock.now += 2500;
    const [second] = await tick(r);
    expect(second?.receipt).toMatchObject({ requestId: "box-0000014", outcome: "sent" });
    neverEscape(r.pane);
  });

  test("a box hold made after the pane's last held send went out goes on the first free poll (live check W3, 2026-10-26)", async () => {
    const clock = { now: 1_000_000 };
    const r = queued(clock);
    r.pane.dialog = DIALOG;
    await r.send("first", { id: "box-0000016" });
    r.pane.dialog = null;
    const [first] = await tick(r);
    expect(first?.receipt).toMatchObject({ requestId: "box-0000016", outcome: "sent" });
    expect(r.holds.list()).toEqual([]);
    // A new hold on the same pane, its queue empty: what the pane's watch saw belonged to "first".
    r.pane.dialog = DIALOG;
    await r.send("second", { id: "box-0000017" });
    r.pane.dialog = null;
    clock.now += 12_000;
    const [second] = await tick(r);
    expect(second?.receipt).toMatchObject({ requestId: "box-0000017", outcome: "sent" });
    neverEscape(r.pane);
  });

  test("a box hold made after a cancel on a pane that ran a turn goes on the first free poll too (live check W3)", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("first", { id: "box-0000018" });
    // A poll reads a turn, then the person cancels the held row.
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(r.protocol.cancelHeld("main", "%1", "box-0000018")).not.toBeNull();
    await r.send("second", { id: "box-0000019" });
    r.pane.dialog = null;
    const [second] = await tick(r);
    expect(second?.receipt).toMatchObject({ requestId: "box-0000019", outcome: "sent" });
    neverEscape(r.pane);
  });

  test("a box hold whose pane then runs a turn keeps the turn rules, not the first free poll", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000015" });
    r.pane.dialog = null;
    expect(await tick(r, RUNNING)).toEqual([]);
    // The turn ended: one free poll is not enough, two are (FREE_POLLS).
    expect(await tick(r)).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "box-0000015", outcome: "sent" });
  });

  test("a hold from a box that was not free goes after a turn a poll reads, then two free polls", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000004" });
    r.pane.dialog = null;
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "box-0000004", outcome: "sent" });
  });

  test("a release that meets the box still not free goes back to its place, nothing typed", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    await r.send("ok for the open PRs", { id: "box-0000005" });
    // The poll's Surface says free, but the dialog is still on the screen the release reads.
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const [back] = await tick(r);
    expect(back?.receipt).toMatchObject({ requestId: "box-0000005", outcome: "held", keys: [] });
    expect(r.holds.get("box-0000005")).toMatchObject({ state: "held", tries: 1 });
    expect(r.pane.calls).toEqual([]);
  });

  test("a draft in the box is still refused draft_present with its offers, nothing held", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    const answer = await r.send("hello", { id: "box-0000006" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(answer.offers).toEqual(["append", "replace", "cancel"]);
    expect(r.holds.list()).toEqual([]);
  });

  test("a command at a box that is not free stays a refusal, nothing held", async () => {
    const r = queued();
    r.pane.dialog = DIALOG;
    const answer = await r.send("/compact", { id: "box-0000007", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a probe that fails on a redrawing screen and is cleaned up with a confirmed box is held, then sent on a stable read (live, 2026-10-17)", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = { ...rig({ version: "2.1.999", holds, clock }), holds };
    // The screen redraws once while the probe goes in: the hint under the box vanishes for that read.
    let redraws = 1;
    r.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}` && redraws > 0) {
        redraws--;
        p.status = [];
      }
    };
    const answer = await r.send("fourth message, reply ACK4 only", { id: "probe-00001" });
    expect(answer.receipt).toMatchObject({ requestId: "probe-00001", outcome: "held", keys: ["probe", "Backspace"] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.detail).toBe(BOX_HELD);
    expect(r.pane.box).toBe("");
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["probe-00001"]);
    // The hint is back and the screen holds still: the quiet rule releases it, and it goes out.
    r.pane.status = rig().pane.status;
    let released: SendAnswer | null | undefined;
    for (let i = 0; i < 6 && released === undefined; i++) {
      [released] = await tick(r);
      clock.now += 2500;
    }
    expect(released?.receipt).toMatchObject({ requestId: "probe-00001", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> fourth message, reply ACK4 only");
    expect(r.holds.list()).toEqual([]);
  });

  test("a probe whose cleanup is not confirmed stays a refusal, nothing held", async () => {
    const r = queued();
    const twice = rig({ version: "2.1.999", holds: r.holds });
    // The Backspace is taken, but the probe character shows in the box again on the read after it.
    twice.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
      if (what === "keys:Backspace") p.box = PROBE;
    };
    const answer = await twice.send("hello there", { id: "probe-00002" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("may remain in the box");
    // A probe character that shows twice gets no Backspace at all: refused too.
    const seen = rig({ version: "2.1.999", holds: r.holds });
    seen.pane.transcript.push(`an earlier line that shows ${PROBE}`);
    seen.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await seen.send("hello there", { id: "probe-00003" })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a command whose probe failed with a clean box stays a refusal", async () => {
    const r = rig({ version: "2.1.999", holds: new HoldStore(join(dir, "held")) });
    r.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.status = [];
    };
    expect((await r.send("/compact", { id: "probe-00004", mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
  });

  test("a manual send (Send anyway) whose probe fails clean stays refused, nothing held (review, 2026-10-17)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const framed = rig({ holds });
    framed.pane.transcript = Array.from({ length: 12 }, (_, i) => `transcript row ${String(i)}`);
    framed.pane.over = ["● How is the agent doing this session? (optional)", "  1: Bad    2: Fine    3: Good    0: Dismiss"];
    const look = await framed.send("carry on");
    expect(look.surface?.modal).toBe("unreadable");
    framed.pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.transcript.splice(2, 0, "a new row of output");
    };
    const answer = await framed.send("carry on", { rowsHash: look.rowsHash! });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe", "Backspace"] });
    expect(answer.detail).toContain("the box is clean again");
    expect(holds.list()).toEqual([]);
  });

  test("a pane with no profile never holds: its send goes in blind, with no read for a hold to wait on", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: NO_PROFILE, holds });
    r.pane.fixed = shellText();
    // The screen would move between the two S0 reads (not_free, the reason a profiled pane holds); no read is taken.
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.fixed = `${p.fixed ?? ""}\r\na row that came in`;
    };
    const answer = await r.send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "sent", keys: ["Enter"] });
    expect(holds.list()).toEqual([]);
  });

  test("a Replace whose text starts with a reserved lead is a command: no hold at a box that is not free", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    r.pane.dialog = DIALOG;
    const answer = await r.send("/compact", { id: "box-0000008", mode: "replace", rowsHash: OFFERED });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(r.holds.list()).toEqual([]);
    // The same Replace with a plain text is held.
    const plain = await r.send("a plain thought", { id: "box-0000009", mode: "replace", rowsHash: OFFERED });
    expect(plain.receipt?.outcome).toBe("held");
  });

  test("with no hold queue a box that is not free is refused as before", async () => {
    const r = rig();
    r.pane.dialog = DIALOG;
    expect((await r.send("hello")).receipt).toMatchObject({ outcome: "refused", reason: "not_free", keys: [] });
  });
});

describe("a draft holds a marked send, and only a marked one (M62 spec 02)", () => {
  const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
  const RUNNING = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  const DRAFT = { revision: 1, turn: "idle", modal: "none", composer: "draft" } as const;
  type Read = typeof FREE | typeof RUNNING | typeof DRAFT;
  const HOUR = 60 * 60 * 1000;
  const marked = (until: number): Partial<SendRequest> => ({ draftHolds: true, holdUntil: until });
  const queued = (check?: (id: string) => boolean): Rig & { holds: HoldStore } => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ holds, clock });
    if (check === undefined) return { ...r, holds };
    const protocol = new SendProtocol({ ...r.deps, holds, releaseCheck: (id) => check(id) });
    const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> => protocol.handle({ id: nextId(), text, mode: "send", ...over }, { session: "main", paneId: "%1", harness: "claude" });
    return { ...r, protocol, send, holds };
  };
  const tick = async (r: Rig, surface: Read = FREE): Promise<(SendAnswer | null)[]> => Promise.all(r.protocol.tickHolds("main", () => surface));
  /** The poll's default cadence: two reads this far apart span the draft release's two seconds. */
  const POLL = 2000;
  const later = async (r: Rig, surface: Read = FREE, ms = POLL): Promise<(SendAnswer | null)[]> => {
    r.clock.now += ms;
    return tick(r, surface);
  };

  test("a phone send over a draft is still refused draft_present with its offers; a marked one is held, nothing typed", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    const phone = await r.send("hello", { id: "draft-000001" });
    // The phone's send proves the draft with the probe (2026-10-25); the marked send that follows types nothing.
    expect(phone.receipt).toMatchObject({ outcome: "refused", reason: "draft_present", keys: ["probe", "Backspace"] });
    expect(phone.offers).toEqual(["append", "replace", "cancel"]);
    const calls = r.pane.calls.length;
    const keys = r.pane.keysSeen.length;
    const until = r.clock.now + HOUR;
    const walky = await r.send("hello", { id: "draft-000002", ...marked(until) });
    expect(walky.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(walky.offers).toEqual([]);
    expect(walky.detail).toBe("The box holds a draft. Collie keeps this and sends it when the box is empty.");
    // Its caller's clock replaces the hold store's 30 minutes.
    expect(r.holds.get("draft-000002")).toMatchObject({ draftHolds: true, cause: "draft_present", expiresAt: until });
    expect(r.pane.calls.slice(calls)).toEqual([]);
    expect(r.pane.keysSeen.slice(keys)).toEqual([]);
    expect(r.pane.box).toBe("half a thought");
  });

  test("the hold row of a marked send names its WalkyTalky message (a person's own held row, pinned whole above, names none)", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    const until = r.clock.now + HOUR;
    await r.send("[walky-talky wt_aaaaaaaaaaa1] from agent x", { id: "draft-000001", ...marked(until), walky: "wt_aaaaaaaaaaa1" });
    // The same ids come back from the file, then the row the snapshot serves.
    expect(r.holds.get("draft-000001")).toMatchObject({ draftHolds: true, walky: "wt_aaaaaaaaaaa1" });
    expect(r.protocol.heldOf("main", "%1")).toMatchObject([{ requestId: "draft-000001", state: "held", cause: "draft_present", walky: "wt_aaaaaaaaaaa1" }]);
    // A marked send with no message id (a caller that is not walky) carries none.
    await r.send("another", { id: "draft-000002", ...marked(until) });
    expect(r.protocol.heldOf("main", "%1")[1]).not.toHaveProperty("walky");
  });

  test("a phone send while a marked send waits over the draft does not join its queue: it is refused with its offers", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000003", ...marked(r.clock.now + HOUR) });
    const phone = await r.send("from the phone", { id: "draft-000004" });
    expect(phone.receipt).toMatchObject({ outcome: "refused", reason: "draft_present" });
    expect(phone.offers).toEqual(["append", "replace", "cancel"]);
    // A second marked send joins behind the first, held for the same draft.
    await r.send("from walky again", { id: "draft-000005", ...marked(r.clock.now + HOUR) });
    expect(r.holds.list().map((entry) => `${entry.id} ${entry.cause ?? "-"}`)).toEqual(["draft-000003 draft_present", "draft-000005 draft_present"]);
  });

  test("the box emptied: it goes on the second poll that reads it free, not after the quiet five", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000006", ...marked(r.clock.now + HOUR) });
    expect(await tick(r, DRAFT)).toEqual([]);
    r.pane.box = "";
    expect(await later(r)).toEqual([]);
    const [released] = await later(r);
    expect(released?.receipt).toMatchObject({ requestId: "draft-000006", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> from walky");
    expect(r.holds.list()).toEqual([]);
  });

  test("a submitted draft: the poll reads the turn, the cause moves to turn_running, and it goes after the turn", async () => {
    const r = queued();
    r.pane.box = "fix the parser";
    await r.send("from walky", { id: "draft-000007", ...marked(r.clock.now + HOUR) });
    r.pane.transcript.push("> fix the parser");
    r.pane.box = "";
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(r.holds.get("draft-000007")?.cause).toBe("turn_running");
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "draft-000007", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> fix the parser", "> from walky"]);
  });

  // A cancel (the sender's, a Drop) and an expiry end a held message only while it waits. Once its release
  // starts, `release` marks the row `running` in the same synchronous step (protocol.ts `release`), and both
  // `cancelHeld` and the poll's expiry skip a running row. So a mail row never ends `cancelled` or `expired`
  // with its text in the box: it ends by the receipt of the write.
  test("a cancel or an expiry that arrives before or while the message is typed ends nothing: refused busy, and the send ends by its receipt (never cancelled)", async () => {
    const r = queued();
    r.pane.box = "fix the parser";
    const until = r.clock.now + HOUR;
    await r.send("from walky", { id: "draft-000071", ...marked(until), walky: "wt_aaaaaaaaaaa1" });
    r.pane.transcript.push("> fix the parser");
    r.pane.box = "";
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    const cancels: (HeldCancelAnswer | null)[] = [];
    const polls: Promise<SendAnswer | null>[] = [];
    // Once as the release reads the box (before the write), once as its text goes in (during the write).
    const strike = () => {
      cancels.push(r.protocol.cancelHeld("main", "%1", "draft-000071"));
      expect(r.holds.get("draft-000071")?.state).toBe("running");
      const was = r.clock.now;
      r.clock.now = until + 1;
      polls.push(...r.protocol.tickHolds("main", () => FREE));
      r.clock.now = was;
    };
    r.pane.beforeRead = () => {
      if (cancels.length === 0) strike();
    };
    r.pane.afterInput = (_p, what) => {
      if (cancels.length === 1 && what.includes("from walky")) strike();
    };
    const [released] = await tick(r);
    await Promise.all(polls);
    expect(cancels).toEqual([{ result: "refused", reason: "busy" }, { result: "refused", reason: "busy" }]);
    expect(released?.receipt).toMatchObject({ requestId: "draft-000071", outcome: "sent" });
    expect(r.deps.store.get("draft-000071")?.receipt?.outcome).toBe("sent");
    expect(r.holds.list()).toEqual([]);
    expect(r.pane.transcript.slice(-2)).toEqual(["> fix the parser", "> from walky"]);
    // After the end the cancel is still refused, with the stored receipt, never `cancelled`.
    expect(r.protocol.cancelHeld("main", "%1", "draft-000071")).toMatchObject({ result: "refused", reason: "busy", receipt: { outcome: "sent" } });
  });

  test("a submitted draft whose turn has not drawn yet: two quick free reads type nothing, the turn read makes it a turn hold (2026-10-21 rig case 9)", async () => {
    // The browser leg's sequence: the draft, then Enter. The box clears at once, and the poll ticks on
    // every screen update, so two reads a few hundred milliseconds apart read an empty box over an idle
    // pane before the agent draws its turn. Typing there met the turn and ended typed_not_submitted.
    const r = queued();
    r.pane.box = "draft";
    await r.send("from walky", { id: "draft-000011", ...marked(r.clock.now + HOUR) });
    expect(await later(r, DRAFT)).toEqual([]);
    r.pane.transcript.push("> draft");
    r.pane.box = "";
    expect(await later(r, FREE, 300)).toEqual([]);
    expect(await later(r, FREE, 400)).toEqual([]);
    expect(await later(r, FREE, 500)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.holds.get("draft-000011")).toMatchObject({ state: "held", cause: "draft_present" });
    // The turn shows: the hold is now a turn hold, and it goes after that turn, once.
    expect(await later(r, RUNNING, 300)).toEqual([]);
    expect(r.holds.get("draft-000011")?.cause).toBe("turn_running");
    expect(await later(r, RUNNING)).toEqual([]);
    expect(await later(r)).toEqual([]);
    const [released] = await later(r);
    expect(released?.receipt).toMatchObject({ requestId: "draft-000011", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> draft", "> from walky"]);
  });

  test("the draft release counts its two seconds from the first free read: a draft read in between starts them again", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000012", ...marked(r.clock.now + HOUR) });
    r.pane.box = "";
    expect(await later(r)).toEqual([]);
    expect(await later(r, DRAFT, 1500)).toEqual([]);
    expect(await later(r, FREE, 1500)).toEqual([]);
    expect(await later(r, FREE, 1500)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    const [released] = await later(r, FREE, 500);
    expect(released?.receipt).toMatchObject({ requestId: "draft-000012", outcome: "sent" });
  });

  test("a release that meets a draft again goes back without spending a try, and writes the cause", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000008", ...marked(r.clock.now + HOUR) });
    for (let round = 0; round < 7; round++) {
      // The poll reads the box free, but the person typed again before the release read it.
      expect(await later(r)).toEqual([]);
      const [back] = await later(r);
      expect(back?.receipt).toMatchObject({ requestId: "draft-000008", outcome: "held", keys: [] });
    }
    expect(r.holds.get("draft-000008")).toMatchObject({ state: "held", tries: 0, cause: "draft_present" });
    expect(r.pane.calls).toEqual([]);
  });

  test("the caller's check has the last word: false ends it refused(pane_gone), nothing typed", async () => {
    const r = queued(() => false);
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000009", ...marked(r.clock.now + HOUR) });
    r.pane.box = "";
    expect(await later(r)).toEqual([]);
    expect(await later(r)).toEqual([]);
    expect(r.deps.store.get("draft-000009")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
  });

  test("its one clock: still held at 30 minutes, ended `expired` at the caller's hour", async () => {
    const r = queued();
    r.pane.box = "half a thought";
    await r.send("from walky", { id: "draft-000010", ...marked(r.clock.now + HOUR) });
    r.clock.now += 31 * 60 * 1000;
    expect(await tick(r, DRAFT)).toEqual([]);
    expect(r.holds.get("draft-000010")?.state).toBe("held");
    r.clock.now = 1_000_000 + HOUR;
    expect(await tick(r, DRAFT)).toEqual([]);
    expect(r.deps.store.get("draft-000010")?.receipt).toMatchObject({ outcome: "expired" });
    expect(r.pane.calls).toEqual([]);
  });
});

describe("a refusal receipt keeps its line and the Surface words (2026-10-17 field case)", () => {
  test("a box that moved between two reads: the line and four words on the receipt and on disk, never the screen row", async () => {
    const r = rig();
    r.pane.beforeRead = (p, n) => {
      if (n === 2) p.box = "someone typed at the desk";
    };
    const answer = await r.send("a private sentence", { id: "detail-00001" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "not_free", detail: "The input box moved between two reads." });
    expect(answer.receipt?.saw).toEqual({ turn: "idle", modal: "none", composer: "draft" });
    const stored = new RequestStore(join(dir, "sends"), () => r.clock.now).get("detail-00001")?.receipt;
    expect(stored).toMatchObject({ detail: "The input box moved between two reads.", saw: { turn: "idle", modal: "none", composer: "draft" } });
    const file = readFileSync(join(dir, "sends", "detail-00001.json"), "utf8");
    // The text is on disk only as the line Sent would keep (requests.ts); the desk's draft is a screen row and never is.
    expect(JSON.parse(file).line).toBe("a private sentence");
    expect(file).not.toContain("someone typed at the desk");
  });

  test("a dialog at the box: the plain line and the modal word", async () => {
    const r = rig();
    r.pane.dialog = DIALOG;
    const answer = await r.send("hello");
    expect(answer.receipt?.detail).toBe(answer.detail ?? "");
    expect(answer.receipt?.saw?.modal).not.toBe("none");
  });

  test("a send that went keeps neither a line nor the words", async () => {
    const r = rig();
    const sent = await r.send("hello there, agent");
    expect(sent.receipt?.outcome).toBe("sent");
    expect(sent.receipt?.detail).toBeUndefined();
    expect(sent.receipt?.saw).toBeUndefined();
  });
});

describe("the turn ends while Collie types (live, 2026-10-17, round 3)", () => {
  const listRow = (k: number): string => `  ${String(k)}. Fruit number ${String(k)}: it is a fruit with one short sentence about it.`;

  test("running at S0, idle at S1 with the finished answer and a (y/n) line above the box: sent", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      pane.height = 16;
      pane.drawsQueuedRow = true;
      pane.transcript = ["> Write a numbered list of 40 fruits", "", ...[1, 2, 3, 4, 5, 6, 7, 8].map(listRow)];
      pane.over = [LIVE_ROW];
      let ended = false;
      pane.afterInput = (p, what) => {
        // The answer finishes as the text goes in: the last rows, the menu and the question, then the finished row.
        if (ended || !what.includes("ACK4")) return;
        ended = true;
        p.over = [];
        p.transcript.push(...[9, 10, 11, 12].map(listRow), "  1. Apple", "  2. Pear", "  3. Quit", "", "  Confirm (y/n)", "", "\u273b Cooked for 5s \u00b7 done 12:17 PM");
      };
      const answer = await send("Fourth message, reply ACK4 only.");
      expect(ended, version).toBe(true);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
      expect(pane.box, version).toBe("");
    }
  });

  /** A capture's rows with the fake pane's box drawn into its box row. */
  const captured = (name: string): ((box: string) => string) => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.includes("\u276f\u00a0") && rows[i - 1]!.includes("\u2500".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    return (box) => {
      const shown = [...rows];
      if (box !== "") shown[boxRow] = `\u276f\u00a0${box}`;
      return shown.join("\r\n");
    };
  };
  const ENDING = captured("claude--v2302-turn-ending-stop-hooks--w119.txt");
  const ENDED = captured("claude--v2302-turn-ended-yn--w119.txt");
  const TEXT = "Fourth message, reply ACK4 only.";
  /** A list streaming above two queued messages, its last row still growing; `from` says when the stream starts. */
  const streamingWithQueue = (pane: FakePane, from: (call: string) => boolean): void => {
    pane.height = 40;
    pane.drawsQueuedRow = true;
    pane.transcript = ["> Write a numbered list of 120 fruits", "", ...Array.from({ length: 40 }, (_, i) => listRow(i + 1)), "  41."];
    pane.over = ["", "\u276f Second message sent during the turn, reply with the word ACK only.", "", "\u276f Third message while the list streams, reply ACK3 only.", "  ctrl+enter to send now", ""];
    let n = 40;
    pane.beforeRead = (p) => {
      if (!p.calls.some(from) || n >= 120) return;
      n += 3;
      p.transcript.splice(-1, 1, listRow(n - 2), listRow(n - 1), listRow(n), `  ${String(n + 1)}.`);
    };
  };


  test("real 2.1.302 screens: the Stop hooks row at S0, the finished turn with its menu and Confirm (y/n) at S1: sent", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.beforeRead = (p) => {
      p.fixed = p.calls.some((call) => call.includes("ACK4")) ? ENDED(p.box) : ENDING(p.box);
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "sent" });
    expect(pane.keysSeen.at(-1)).toBe("Enter");
    expect(pane.box).toBe("");
  });

  test("the list streams above two queued messages over the box while Collie types (no spinner, S0 idle): sent, never left typed (live replay, 2026-10-17)", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      pane.height = 40;
      pane.drawsQueuedRow = true;
      // The answer's last row is still growing ("  41."), and the queued messages stand under it, over
      // the box: the growing row is not the last row above the box (lane 8788, 120-row list). The list
      // streams once the text went in (the probe saw a still screen).
      streamingWithQueue(pane, (call) => call.includes("ACK4"));
      const answer = await send(TEXT);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent" });
      expect(pane.keysSeen.at(-1), version).toBe("Enter");
    }
  });

  test("the probe while the list streams above two queued messages, a row still growing: it passes, and the send goes in (2026-10-17, round 4)", async () => {
    for (const version of ["2.1.301", "2.1.302"]) {
      const { pane, send } = rig({ version });
      streamingWithQueue(pane, (call) => call.startsWith("type:"));
      const answer = await send(TEXT);
      expect(answer.receipt, version).toMatchObject({ outcome: "sent", keys: ["probe", "Backspace", "Enter"] });
    }
  });

  test("the probe with the frame gone at its read fails as before, no Backspace", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.fixed = ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\n");
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed", keys: ["probe"] });
    expect(pane.keysSeen).toEqual([]);
  });

  test("the probe with a dialog under the box at its read fails as before, and one Backspace cleans the box", async () => {
    const { pane, send } = rig({ version: "2.1.302" });
    pane.afterInput = (p, what) => {
      if (what === `type:${PROBE}`) p.popup = [...DIALOG];
    };
    const answer = await send(TEXT);
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "probe_failed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.calls).toEqual([`type:${PROBE}`]);
  });

  test("the frame with the text gone at S1 (the screen replaced): typed_not_submitted, no Enter, and the receipt names the rule", async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    pane.beforeRead = (p) => {
      // Another screen took the place, with plain rows and no box (a list or a menu there would read as a dialog).
      p.fixed = p.calls.some((call) => call.includes("ACK4")) ? ["", "  Your conversation moved to the background.", "", "  Nothing is selected."].join("\r\n") : ENDING(p.box);
    };
    const answer = await send(TEXT, { id: "typed-00001" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "changed" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT);
    const stored = deps.store.get("typed-00001")?.receipt;
    expect(stored?.detail).toBe("The frame with the typed text was gone, or the rows under the box changed, so Enter was not pressed.");
    expect(stored?.saw).toEqual({ turn: "unknown", modal: "unknown", composer: "unknown", reason: "no-match" });
    expect(JSON.stringify(stored)).not.toContain("ACK4");
  });

  test("a dialog at S1: typed_not_submitted, no Enter, the text stays, and the receipt says a dialog came", async () => {
    const { pane, send, deps } = rig({ version: "2.1.302" });
    pane.over = [LIVE_ROW];
    pane.afterInput = (p, what) => {
      if (what.includes("ACK4")) p.dialog = DIALOG;
    };
    const answer = await send(TEXT, { id: "typed-00002" });
    expect(answer.receipt).toMatchObject({ outcome: "typed_not_submitted", reason: "modal_cue" });
    expect(pane.keysSeen).not.toContain("Enter");
    expect(pane.box).toBe(TEXT);
    expect(deps.store.get("typed-00002")?.receipt?.detail).toBe("Something opened at the box after the text was typed, so Enter was not pressed.");
  });
});

describe("real Claude Code 2.1.302 turns with a list on screen (captured 2026-10-17)", () => {
  /** A fixture whose box row draws what the fake pane's box holds, so the probe and the text land in it. */
  const liveFixture = (pane: FakePane, name: string): void => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    const boxRow = rows.findIndex((row, i) => i > 0 && row.includes("❯ ") && rows[i - 1]!.includes("─".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    pane.beforeRead = (p) => {
      const shown = [...rows];
      if (p.box !== "") shown[boxRow] = `❯ ${p.box}`;
      p.fixed = shown.join("\r\n");
    };
  };

  for (const name of ["claude--v2302-working-list-echo--w119.txt", "claude--v2302-working-agents-panel--w119.txt"]) {
    test(`${name}: a send during the turn is taken, sent or held, never refused not_free`, async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = rig({ version: "2.1.302", holds });
      liveFixture(r.pane, name);
      const answer = await r.send("then give it a title");
      expect(["sent", "held"]).toContain(answer.receipt?.outcome ?? "none");
      expect(answer.receipt?.reason).not.toBe("not_free");
      if (answer.receipt?.outcome === "sent") expect(r.pane.keysSeen.at(-1)).toBe("Enter");
      else expect(r.pane.box).toBe("");
    });
  }

  test("claude--v2302-working-list-echo--w119.txt: the list above an idle-reading box is no dialog, the send goes in", async () => {
    const r = rig({ version: "2.1.302" });
    liveFixture(r.pane, "claude--v2302-working-list-echo--w119.txt");
    expect((await r.send("then give it a title")).receipt).toMatchObject({ outcome: "sent" });
  });
});

describe("a send into a running Claude Code turn under a wrapped prompt echo (2.1.310, live 2026-10-25)", () => {
  // The transcript echoes the operator's long prompt as `❯ ` and rows at column 2; the whole-screen cue
  // read took it for a pointed list (and, with the answer's numbered list, for a dialog), so the send was
  // refused not_free and held to the turn's end. Claude's profile names the echo (`idle.promptEchoes`).
  const liveFixture = (pane: FakePane, name: string): void => {
    const rows = readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8").split("\r\n");
    // eslint-disable-next-line no-control-regex
    const plain = (row: string): string => row.replace(/\u001b\[[0-9;]*m/gu, "");
    const boxRow = rows.findIndex((row, i) => i > 0 && plain(row).startsWith("❯") && plain(rows[i - 1]!).startsWith("─".repeat(20)));
    expect(boxRow).toBeGreaterThan(0);
    pane.beforeRead = (p) => {
      const shown = [...rows];
      if (p.box !== "") shown[boxRow] = `❯ ${p.box}`;
      p.fixed = shown.join("\r\n");
    };
  };

  for (const name of ["claude--v2-1-310-working-echo-numbered--w120.txt", "claude--v2-1-310-working-echo-bullets--w120.txt"]) {
    test(`${name}: the send goes in with Enter for Claude's queue, never refused not_free nor held`, async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = rig({ version: "2.1.310", holds });
      liveFixture(r.pane, name);
      const answer = await r.send("then give it a title");
      expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, keys: ["probe", "Backspace", "Enter"] });
      expect(answer.receipt?.reason).not.toBe("not_free");
      expect(r.pane.keysSeen.at(-1)).toBe("Enter");
      expect(holds.list()).toEqual([]);
    });
  }

  test("the same screen without the profile's echo rule is refused not_free and held, as it was live", async () => {
    const holds = new HoldStore(join(dir, "held-off"));
    const r = rig({ version: "2.1.310", holds, edit: (profile) => ({ ...profile, idle: { ...profile.idle, promptEchoes: false } }) });
    liveFixture(r.pane, "claude--v2-1-310-working-echo-numbered--w120.txt");
    const answer = await r.send("then give it a title");
    expect(answer.receipt?.outcome).toBe("held");
    expect(r.pane.keysSeen).not.toContain("Enter");
    // The held row keeps the refusal it came from, so the phone says the box, not the turn.
    expect(r.protocol.heldOf("main", "%1")).toEqual([expect.objectContaining({ state: "held", cause: "not_free" })]);
  });
});
