// The Send Protocol against the scripted fake multiplexer: part held-send. The rig is `protocol.rig.ts`;
// the other parts sit beside this file as `protocol.<topic>.test.ts`.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import { type HeldCancelAnswer, type SendAnswer } from "../../web/src/lib/surface/send.ts";
import { type Surface } from "../../web/src/lib/surface/surface.ts";
import { neverHeldEntry, SendProtocol, type SendLedger } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { SurfaceLedger } from "./counters.ts";
import { HOLD_ENDED_KEEP_MS, HoldStore } from "./holds.ts";
import { OFFERED, FakePane, LIVE_ROW, PiPane, type Rig, dir, neverEscape, noCommandQueue, omp, rig, steersWithNoQueueKey, useScratchDir } from "./protocol.rig.ts";

useScratchDir();

describe("the held send (M56 spec 15)", () => {
  const FREE = { revision: 1, turn: "idle", modal: "none", composer: "empty" } as const;
  const RUNNING = { revision: 1, turn: "running", modal: "none", composer: "empty" } as const;
  /** A Claude pane whose turn runs and whose binary reported no version: the profile cannot be trusted with the turn. */
  const untrusted = (options: Parameters<typeof rig>[0] = {}): Rig & { holds: HoldStore } => {
    const clock = options.clock ?? { now: 1_000_000 };
    const holds = options.holds ?? new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ version: "no version here", ...options, holds, clock });
    r.pane.over = [LIVE_ROW];
    return { ...r, holds };
  };
  /** Ends the pane's turn: the running row goes, the box stays empty. */
  const turnEnds = (pane: FakePane): void => {
    pane.over = [];
  };
  const tick = async (r: Rig, surface: typeof FREE | typeof RUNNING = FREE): Promise<(SendAnswer | null)[]> => Promise.all(r.protocol.tickHolds("main", () => surface));
  /** Two free polls in a row: the first only counts, the second releases (review of spec 15, H2). */
  const freeTwice = async (r: Rig): Promise<(SendAnswer | null)[]> => {
    expect(await tick(r)).toEqual([]);
    return tick(r);
  };

  test("a send the harness cannot take during its turn is held: receipt held, nothing typed, the text on disk 0600", async () => {
    const r = untrusted();
    const answer = await r.send("then give it a title", { id: "held-000001" });
    expect(answer.receipt).toMatchObject({ requestId: "held-000001", outcome: "held", keys: [] });
    expect(answer.receipt?.reason).toBeUndefined();
    expect(answer.offers).toEqual([]);
    // Claude queues in a turn, but not on a version Collie could not read: the detail and the row say so (#594).
    expect(answer.detail).toBe("The agent is working, and Collie could not read this agent's version. Collie keeps this and sends it when the turn ends. Run collie doctor to see why.");
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    expect(r.deps.store.get("held-000001")?.phase).toBe("held");
    const file = join(dir, "held", "held-000001.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ id: "held-000001", text: "then give it a title", state: "held", paneId: "%1" });
    // Windows has no POSIX mode bits, so only the mode expectation waits for another platform.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(r.protocol.heldOf("main", "%1")).toEqual([
      { requestId: "held-000001", mode: "send", text: "then give it a title", heldAt: 1_000_120, expiresAt: 1_000_120 + 30 * 60 * 1000, state: "held", cause: "turn_running", versionUnread: true },
    ]);
    expect(r.protocol.recent("%1")[0]).toMatchObject({ requestId: "held-000001", outcome: "held" });
  });

  test("the same id again while held answers the stored held receipt and holds nothing twice", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000002" });
    const again = await r.send("then give it a title", { id: "held-000002" });
    expect(again).toMatchObject({ replayed: true, receipt: { outcome: "held" } });
    expect(r.holds.list()).toHaveLength(1);
  });

  test("nothing is released while the Surface reads the turn; two free polls in a row send it under the same id, a fresh run of the protocol", async () => {
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => 1_000_000 });
    const r = untrusted({ ledger });
    await r.send("then give it a title", { id: "held-000003" });
    expect(await tick(r, RUNNING)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    turnEnds(r.pane);
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000003", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.transcript.at(-1)).toBe("> then give it a title");
    expect(r.deps.store.get("held-000003")).toMatchObject({ phase: "settled", receipt: { outcome: "sent" } });
    expect(r.holds.list()).toEqual([]);
    expect(existsSync(join(dir, "held", "held-000003.json"))).toBe(false);
    expect(r.protocol.heldOf("main", "%1")).toEqual([]);
    const row = ledger.rows()[0]!;
    expect(row).toMatchObject({ held: 1, held_sent: 1, sent: 1 });
    neverEscape(r.pane);
  });

  test("a later send on a pane with held sends joins the end, even on a free pane; the second waits for a running turn, then two free polls", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-000004" });
    turnEnds(r.pane);
    const second = await r.send("second message", { id: "held-000005" });
    expect(second.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(second.detail).toBe("Earlier messages wait for this pane. Collie sends this after them.");
    expect(r.pane.calls).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-000004", "held-000005"]);
    const [first] = await freeTwice(r);
    expect(first?.receipt).toMatchObject({ requestId: "held-000004", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> first message");
    // The release started the wait again: free polls alone send nothing until a turn ran.
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(await tick(r, RUNNING)).toEqual([]);
    const [next] = await freeTwice(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000005", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> first message", "> second message"]);
  });

  test("a released send that starts no turn does not stall the next: five free polls a minute apart send it, it never expires (review V1)", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("first message", { id: "held-000040" });
    turnEnds(r.pane);
    await r.send("second message", { id: "held-000041" });
    const [first] = await freeTwice(r);
    expect(first?.receipt).toMatchObject({ requestId: "held-000040", outcome: "sent" });
    // No poll reads a running turn after it (a /help, or a turn shorter than one poll).
    for (let i = 0; i < 4; i++) {
      clock.now += 60_000;
      expect(await tick(r)).toEqual([]);
    }
    clock.now += 60_000;
    const [next] = await tick(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000041", outcome: "sent" });
    expect(r.pane.transcript.slice(-2)).toEqual(["> first message", "> second message"]);
    expect(r.holds.list()).toEqual([]);
  });

  /** A pi pane in a turn with a held `/model`: pi sends a command with an Enter that steers a turn. */
  const piHeldCommand = async (id: string): Promise<Rig & { holds: HoldStore; clock: { now: number }; pane: PiPane }> => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const pane = new PiPane("alt+Enter");
    pane.inTurn = true;
    const r = rig({ pane, harness: "pi", version: "0.87.1", holds, clock });
    expect((await r.send("/model", { id, mode: "command" })).receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(holds.get(id)?.waitsForTurn).toBe(true);
    pane.inTurn = false;
    return { ...r, holds, clock, pane };
  };

  test("a held command whose Enter steers (pi), its turn ended before any poll: two free polls under two seconds keep it, two seconds apart send it once (omp gang 2026-10-25)", async () => {
    const r = await piHeldCommand("held-pi-01");
    expect(await tick(r)).toEqual([]);
    r.clock.now += 500;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    r.clock.now += 1_600;
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-pi-01", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.transcript.filter((row) => row === "> /model")).toHaveLength(1);
    expect(r.pane.steered).toEqual([]);
    expect(r.holds.list()).toEqual([]);
  });

  test("a held command whose Enter steers (pi) never goes while a poll reads the turn: a running poll starts the free count again", async () => {
    const r = await piHeldCommand("held-pi-03");
    expect(await tick(r)).toEqual([]);
    r.clock.now += 1_000;
    r.pane.inTurn = true;
    expect(await tick(r, RUNNING)).toEqual([]);
    r.pane.inTurn = false;
    r.clock.now += 3_000;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.keysSeen).toEqual([]);
    const [released] = await tick(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-pi-03", outcome: "sent" });
    expect(r.pane.steered).toEqual([]);
  });

  test("a plain send behind a held command (pi) waits seconds, not the command's ten minutes (omp gang 2026-10-25, 07 F3)", async () => {
    const r = await piHeldCommand("held-pi-04");
    const behind = await r.send("then summarise the diff", { id: "held-pi-05" });
    expect(behind.receipt).toMatchObject({ outcome: "held", keys: [] });
    const sent: string[] = [];
    for (let i = 0; i < 12 && r.holds.list().length > 0; i++) {
      for (const answer of await tick(r)) if (answer?.receipt?.outcome === "sent") sent.push(answer.receipt.requestId);
      r.clock.now += 1_500;
    }
    expect(sent).toEqual(["held-pi-04", "held-pi-05"]);
    expect(r.clock.now - 1_000_000).toBeLessThan(20_000);
    // The command went with Enter on an idle box, the message with pi's send key.
    expect(r.pane.transcript.slice(-2)).toEqual(["> /model", " > then summarise the diff"]);
    expect(r.pane.steered).toEqual([]);
  });

  test("a second held command after a release that started no turn takes the quiet rule: five free polls over ten seconds, never two", async () => {
    const r = await piHeldCommand("held-pi-06");
    expect((await r.send("/session", { id: "held-pi-07", mode: "command" })).receipt).toMatchObject({ outcome: "held" });
    expect(await tick(r)).toEqual([]);
    r.clock.now += 2_100;
    const [first] = await tick(r);
    expect(first?.receipt).toMatchObject({ requestId: "held-pi-06", outcome: "sent" });
    // No poll reads a turn after it: two free polls seconds apart are not enough for the next command.
    expect(await tick(r)).toEqual([]);
    r.clock.now += 2_500;
    expect(await tick(r)).toEqual([]);
    r.clock.now += 2_500;
    expect(await tick(r)).toEqual([]);
    r.clock.now += 2_500;
    expect(await tick(r)).toEqual([]);
    r.clock.now += 2_600;
    const [second] = await tick(r);
    expect(second?.receipt).toMatchObject({ requestId: "held-pi-07", outcome: "sent" });
    expect(second?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.steered).toEqual([]);
  });

  test("a held command whose Enter steers (pi) goes out after a poll read a running turn, then two free polls", async () => {
    const r = await piHeldCommand("held-pi-02");
    r.pane.inTurn = true;
    expect(await tick(r, RUNNING)).toEqual([]);
    r.pane.inTurn = false;
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-pi-02", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
  });

  // Tester 14 (omp 18.12.6, 2026-10-25): a held `/plan` kept `turn_running` on an idle pane whose box held
  // a returned draft, because only a marked request's cause was rewritten after the hold.
  test("a held send's cause follows the pane on every poll: a turn that ends over a draft reads draft_present, a dialog not_free", async () => {
    const DRAFT = { revision: 2, turn: "idle", modal: "none", composer: "draft" } as const;
    const OPEN_DIALOG = { revision: 3, turn: "idle", modal: "unknown", composer: "empty" } as const;
    const holds = new HoldStore(join(dir, "held"));
    const r = omp({ holds });
    r.pane.inTurn = true;
    await r.send("/plan", { id: "held-cause-01", mode: "command" });
    await r.send("and then tidy up", { id: "held-cause-02" });
    expect(r.protocol.heldOf("main", "%1").map((row) => row.cause)).toEqual(["turn_running", "turn_running"]);
    const poll = async (surface: Surface): Promise<void> => void (await Promise.all(r.protocol.tickHolds("main", () => surface)));
    // The turn ends and the box holds a draft (Stop gave a queued text back): the sentence says the box.
    await poll(DRAFT);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.cause)).toEqual(["draft_present", "draft_present"]);
    expect(holds.get("held-cause-01")?.cause).toBe("draft_present");
    // Nothing was typed over the draft, and the command stayed held.
    expect(r.pane.keysSeen).toEqual([]);
    await poll(OPEN_DIALOG);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.cause)).toEqual(["not_free", "not_free"]);
    await poll(RUNNING);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.cause)).toEqual(["turn_running", "turn_running"]);
    // A free read says nothing new: the label stays until the release.
    await poll(FREE);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.cause)).toEqual(["turn_running", "turn_running"]);
  });

  test("a steer while a held command waits runs now, ahead of it, and the held command still goes after the turn (M69)", async () => {
    const r = await piHeldCommand("held-pi-03");
    r.pane.inTurn = true;
    // pi draws a steer as `Steering: <text>` over its edit hint (lab, pi 1.3.0, 2026-10-23).
    const press = r.pane.writeKeys;
    r.pane.writeKeys = async (paneId, keys) => {
      const before = r.pane.steered.length;
      const ack = await press(paneId, keys);
      for (const text of r.pane.steered.slice(before)) r.pane.transcript.push(`Steering: ${text}`, "↳ Alt+Up to edit all queued messages");
      return ack;
    };
    const steer = await r.send("also say hello at the end", { id: "steer-pi-03", when: "steer", fromPhone: true });
    expect(steer.receipt).toMatchObject({ requestId: "steer-pi-03", outcome: "steered" });
    expect(steer.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.pane.steered).toEqual(["also say hello at the end"]);
    expect(r.holds.get("held-pi-03")?.state).toBe("held");
    expect(r.holds.get("steer-pi-03")).toBeNull();
    // The turn runs on a poll, then ends: the held command goes after it, as before the steer.
    expect(await tick(r, RUNNING)).toEqual([]);
    r.pane.inTurn = false;
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-pi-03", outcome: "sent" });
    expect(released?.receipt?.keys.at(-1)).toBe("Enter");
    expect(r.holds.list()).toEqual([]);
  });

  test("a held command on a pane whose version was not read waits for a polled turn too; a held text there keeps the quiet path", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ edit: noCommandQueue, holds, clock, version: "no version here" });
    r.pane.over = [LIVE_ROW];
    await r.send("/compact", { id: "held-uv-01", mode: "command" });
    expect(holds.get("held-uv-01")?.waitsForTurn).toBe(true);
    await r.send("then give it a title", { id: "held-uv-02" });
    expect(holds.get("held-uv-02")?.waitsForTurn).toBeUndefined();
  });

  test("five free polls inside ten seconds do not release the next held send on their own", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("first message", { id: "held-000042" });
    turnEnds(r.pane);
    await r.send("second message", { id: "held-000043" });
    await freeTwice(r);
    for (let i = 0; i < 5; i++) {
      clock.now += 1_000;
      expect(await tick(r)).toEqual([]);
    }
    clock.now += 6_000;
    const [next] = await tick(r);
    expect(next?.receipt).toMatchObject({ requestId: "held-000043", outcome: "sent" });
  });

  test("a plain send that starts with a reserved lead is refused before it can join a queue", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-000006" });
    expect((await r.send("/compact")).receipt).toMatchObject({ outcome: "refused", reason: "reserved_lead" });
    expect(r.holds.list()).toHaveLength(1);
  });

  test("a command on a harness that does not queue commands is held and sent as a command once free", async () => {
    const r = rig({ edit: noCommandQueue, holds: new HoldStore(join(dir, "held")) });
    r.pane.over = [LIVE_ROW];
    const answer = await r.send("/compact", { id: "held-000007", mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(answer.detail).toBe("The agent is working. Collie keeps this and sends it when the turn ends.");
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000007", outcome: "sent" });
    expect(r.pane.transcript.at(-1)).toBe("> /compact");
  });

  test("Submit of a box in a turn is not held: the box holds text, which a free pane never has", async () => {
    const r = untrusted();
    r.pane.box = "half a thought";
    expect((await r.send("half a thought", { mode: "submit" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("after 30 minutes a held send ends expired, its text kept for a Resend; the counters take it", async () => {
    const clock = { now: 1_000_000 };
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => clock.now });
    const r = untrusted({ clock, ledger });
    await r.send("then give it a title", { id: "held-000008" });
    clock.now += 30 * 60 * 1000 - 1;
    await tick(r, RUNNING);
    expect(r.holds.get("held-000008")?.state).toBe("held");
    clock.now += 1;
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(r.deps.store.get("held-000008")).toMatchObject({ phase: "settled", receipt: { outcome: "expired", keys: [] } });
    expect(r.protocol.heldOf("main", "%1")).toEqual([expect.objectContaining({ requestId: "held-000008", state: "ended", outcome: "expired", text: "then give it a title" })]);
    expect(ledger.rows()[0]).toMatchObject({ held: 1, held_expired: 1 });
  });

  test("Cancel ends a held send cancelled and leaves no file; an ended row is dismissed; the counters take the cancel", async () => {
    const clock = { now: 1_000_000 };
    const ledger = new SurfaceLedger(join(dir, "state"), { now: () => clock.now });
    const r = untrusted({ clock, ledger });
    await r.send("then give it a title", { id: "held-000009" });
    expect(r.protocol.cancelHeld("main", "%2", "held-000009")).toBeNull();
    expect(r.protocol.cancelHeld("other", "%1", "held-000009")).toBeNull();
    const cancelled = r.protocol.cancelHeld("main", "%1", "held-000009");
    expect(cancelled).toMatchObject({ result: "cancelled", receipt: { requestId: "held-000009", outcome: "cancelled" } });
    expect(r.deps.store.get("held-000009")?.receipt?.outcome).toBe("cancelled");
    expect(existsSync(join(dir, "held", "held-000009.json"))).toBe(false);
    turnEnds(r.pane);
    expect(await tick(r)).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    expect(ledger.rows()[0]).toMatchObject({ held: 1, held_cancelled: 1 });

    r.pane.over = [LIVE_ROW];
    await r.send("another one", { id: "held-000010" });
    clock.now += 31 * 60 * 1000;
    await tick(r, RUNNING);
    expect(r.protocol.cancelHeld("main", "%1", "held-000010")).toEqual({ result: "dismissed" });
    expect(r.protocol.heldOf("main", "%1")).toEqual([]);
    expect(r.deps.store.get("held-000010")?.receipt?.outcome).toBe("expired");
  });

  test("Cancel on a held send that is going out now is refused busy, and the send completes", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000011" });
    turnEnds(r.pane);
    const seen: (HeldCancelAnswer | null)[] = [];
    r.pane.beforeRead = () => {
      if (seen.length === 0) seen.push(r.protocol.cancelHeld("main", "%1", "held-000011"));
    };
    const [released] = await freeTwice(r);
    expect(seen).toEqual([{ result: "refused", reason: "busy" }]);
    expect(released?.receipt?.outcome).toBe("sent");
    // Cancel after it went out: refused busy, with the stored receipt (review of spec 15, H8).
    expect(r.protocol.cancelHeld("main", "%1", "held-000011")).toMatchObject({ result: "refused", reason: "busy", receipt: { requestId: "held-000011", outcome: "sent" } });
    expect(r.protocol.cancelHeld("main", "%2", "held-000011")).toBeNull();
  });

  test("a pane that closes with a held send ends it refused(pane_gone), the text kept", async () => {
    let generation: string | null = "gen-1";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000012" });
    generation = null;
    // Two polls with no pane may be a redraw; the third ends it (review of spec 15, H5).
    expect(await tick(r)).toEqual([]);
    expect(await tick(r)).toEqual([]);
    expect(r.holds.get("held-000012")?.state).toBe("held");
    expect(await tick(r)).toEqual([]);
    expect(r.deps.store.get("held-000012")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
    expect(r.protocol.heldOf("main", "%1")).toEqual([expect.objectContaining({ state: "ended", outcome: "refused", reason: "pane_gone", text: "then give it a title" })]);
    expect(r.pane.calls).toEqual([]);
  });

  test("a pane that comes back within two polls keeps its held send", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000019" });
    generation = null;
    await tick(r);
    await tick(r);
    generation = "claude:-";
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000019", outcome: "sent" });
  });

  test("a session id that resolves, or a /clear, keeps the held send: the agent is the same, and the release runs on the pane as it is", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000020" });
    generation = "claude:session-a";
    await tick(r, RUNNING);
    generation = "claude:session-b";
    turnEnds(r.pane);
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-000020", outcome: "sent", paneGeneration: "claude:session-b" });
  });

  test("a pane that holds another agent now ends its held sends refused(pane_gone)", async () => {
    let generation: string | null = "claude:-";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000021" });
    generation = "codex:-";
    await tick(r);
    expect(r.deps.store.get("held-000021")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a pane that holds another program now ends its held sends refused(pane_gone)", async () => {
    let generation: string | null = "gen-1";
    const r = untrusted({ generation: () => generation });
    await r.send("then give it a title", { id: "held-000013" });
    generation = "gen-2";
    await tick(r);
    expect(r.deps.store.get("held-000013")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("a release whose S0 finds the turn running again goes back to its place, the receipt held; after five tries it ends", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000014" });
    // The poll read free, the protocol's S0 reads the running row: not yet.
    const [back] = await freeTwice(r);
    expect(back?.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.holds.get("held-000014")).toMatchObject({ state: "held", tries: 1 });
    expect(r.deps.store.get("held-000014")?.phase).toBe("held");
    for (let i = 0; i < 3; i++) await freeTwice(r);
    expect(r.holds.get("held-000014")?.tries).toBe(4);
    const [last] = await freeTwice(r);
    expect(last?.receipt).toMatchObject({ outcome: "refused", reason: "turn_running" });
    expect(r.holds.get("held-000014")).toMatchObject({ state: "ended", outcome: "refused", reason: "turn_running", text: "then give it a title" });
    expect(r.pane.calls).toEqual([]);
  });

  test("a release whose pane is locked by another send goes back to its place", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000015" });
    turnEnds(r.pane);
    r.deps.locks.acquire("main\u0000%1", "someone-else", r.clock.now + 60_000, r.clock.now);
    const [back] = await freeTwice(r);
    expect(back?.receipt?.outcome).toBe("held");
    expect(r.holds.get("held-000015")?.tries).toBe(1);
    r.deps.locks.release("main\u0000%1", "someone-else");
    const [sent] = await freeTwice(r);
    expect(sent?.receipt?.outcome).toBe("sent");
  });

  test("the queue is replayed on boot: a new store and protocol over the same state dir release it", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000016" });
    // A restart: new stores over the same directories, recovery, then the reconcile.
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    expect(store.recover(SendProtocol.crashReceipt)).toEqual([]);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(0);
    expect(holds.list()).toEqual([expect.objectContaining({ id: "held-000016", state: "held", text: "then give it a title" })]);
    const pane = new FakePane();
    const second = rig({ version: "no version here", pane, holds, storeDir: join(dir, "sends"), clock: { now: 2_000_000 } });
    const [released] = await freeTwice(second);
    expect(released?.receipt).toMatchObject({ requestId: "held-000016", outcome: "sent" });
    expect(pane.transcript.at(-1)).toBe("> then give it a title");
  });

  // Issue 740: three held sends past their 30 minutes came back after every restart as "Not sent" cards,
  // each with a fresh hour to stand, until the files were deleted by hand.
  /** A ledger that keeps the outcomes it is told, for the boot step's count. */
  const countingLedger = (outcomes: string[]): SendLedger => ({
    send: (_key, end) => {
      outcomes.push(end.outcome);
    },
    noteManual: () => undefined,
    capState: () => {
      throw new Error("not asked on start");
    },
    inbox: () => undefined,
    example: () => undefined,
  });

  test("a held send whose budget ran out while the bridge was down ends expired at its own expiry, counted once, and stands only the rest of the hour (issue 740)", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000090" });
    const expiresAt = first.holds.get("held-000090")!.expiresAt;
    const later = expiresAt + 60 * 1000;
    const store = new RequestStore(join(dir, "sends"), () => later);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => later);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(0);
    const counted: string[] = [];
    expect(SendProtocol.expireHoldsOnStart(holds, store, later, countingLedger(counted))).toEqual({ ended: ["held-000090"], dropped: [] });
    // The card stays, so a person who has not seen it still does; its hour runs from the expiry, not from now.
    expect(holds.get("held-000090")).toMatchObject({ state: "ended", outcome: "expired", endedAt: expiresAt });
    expect(store.get("held-000090")?.receipt).toMatchObject({ outcome: "expired" });
    expect(counted).toEqual(["expired"]);
    // A second restart a minute later changes nothing: no fresh end time, no second count.
    const again = new HoldStore(join(dir, "held"), () => later + 60 * 1000);
    expect(SendProtocol.expireHoldsOnStart(again, store, later + 60 * 1000, countingLedger(counted))).toEqual({ ended: [], dropped: [] });
    expect(again.get("held-000090")?.endedAt).toBe(expiresAt);
    expect(counted).toEqual(["expired"]);
    // Past the hour from the expiry, the row goes and is never replayed.
    const past = expiresAt + HOLD_ENDED_KEEP_MS + 1;
    const last = new HoldStore(join(dir, "held"), () => past);
    expect(SendProtocol.expireHoldsOnStart(last, store, past)).toEqual({ ended: [], dropped: ["held-000090"] });
    expect(existsSync(join(dir, "held", "held-000090.json"))).toBe(false);
  });

  test("a held send past its budget by more than the hour goes outright, settled expired and counted (issue 740)", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000094" });
    const past = first.holds.get("held-000094")!.expiresAt + HOLD_ENDED_KEEP_MS + 1;
    const store = new RequestStore(join(dir, "sends"), () => past);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => past);
    const counted: string[] = [];
    expect(SendProtocol.expireHoldsOnStart(holds, store, past, countingLedger(counted))).toEqual({ ended: [], dropped: ["held-000094"] });
    expect(holds.list()).toEqual([]);
    expect(store.get("held-000094")?.receipt).toMatchObject({ outcome: "expired" });
    expect(counted).toEqual(["expired"]);
  });

  test("a row that ended expired a few minutes ago stays on start; one older than the hour goes; other rows are not this step's (issue 740)", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000091" });
    await first.send("and a second one", { id: "held-000092" });
    await first.send("and a third one", { id: "held-000093" });
    first.holds.end("held-000091", "expired");
    first.holds.end("held-000092", "refused", "pane_gone");
    const endedAt = first.holds.get("held-000091")!.endedAt!;
    const soon = endedAt + 5 * 60 * 1000;
    const store = new RequestStore(join(dir, "sends"), () => soon);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => soon);
    expect(SendProtocol.expireHoldsOnStart(holds, store, soon)).toEqual({ ended: [], dropped: [] });
    expect(holds.list().map((entry) => [entry.id, entry.state])).toEqual([
      ["held-000091", "ended"],
      ["held-000092", "ended"],
      ["held-000093", "held"],
    ]);
    const late = endedAt + HOLD_ENDED_KEEP_MS + 1;
    const after = new HoldStore(join(dir, "held"), () => late);
    expect(SendProtocol.expireHoldsOnStart(after, store, late)).toEqual({ ended: ["held-000093"], dropped: ["held-000091"] });
    expect(after.list().map((entry) => [entry.id, entry.state, entry.outcome])).toEqual([
      ["held-000092", "ended", "refused"],
      ["held-000093", "ended", "expired"],
    ]);
  });

  test("a crash between a cancel's two writes never leaves a request held with no row", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000095" });
    // The process dies when the request is about to settle: whatever the cancel wrote first is all there is.
    r.deps.store.settle = () => {
      throw new Error("crash");
    };
    expect(() => r.protocol.cancelHeld("main", "%1", "held-000095")).toThrow("crash");
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    SendProtocol.reconcileHolds(holds, store);
    const stranded = store.get("held-000095")?.phase === "held" && holds.get("held-000095") === null;
    expect(stranded).toBe(false);
  });

  test("a crash between an expiry's two writes never leaves a request held with no row", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("then give it a title", { id: "held-000096" });
    clock.now += 31 * 60 * 1000;
    r.deps.store.settle = () => {
      throw new Error("crash");
    };
    await tick(r).catch(() => undefined);
    const store = new RequestStore(join(dir, "sends"), () => clock.now);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    SendProtocol.reconcileHolds(holds, store);
    const stranded = store.get("held-000096")?.phase === "held" && holds.get("held-000096")?.state !== "held";
    expect(stranded).toBe(false);
  });

  test("a settle that throws for one held request does not stop the poll for the others, and the next poll ends it", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("then give it a title", { id: "held-000091" });
    await r.send("and a second one", { id: "held-000092" });
    await r.send("and a third one", { id: "held-000093" });
    clock.now += 31 * 60 * 1000;
    const settle = r.deps.store.settle.bind(r.deps.store);
    let full = true;
    r.deps.store.settle = (id, receipt) => {
      if (full && id === "held-000091") throw new Error("ENOSPC: no space left on device");
      return settle(id, receipt);
    };
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (line: string) => void warnings.push(line);
    try {
      await tick(r);
      // The two others ended, the failing one is still held, and one warning said so.
      expect(r.deps.holds!.get("held-000092")).toMatchObject({ state: "ended", outcome: "expired" });
      expect(r.deps.holds!.get("held-000093")).toMatchObject({ state: "ended", outcome: "expired" });
      expect(r.deps.holds!.get("held-000091")).toMatchObject({ state: "held" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("ENOSPC");
      // The disk has room again: the next poll ends it.
      full = false;
      await tick(r);
      expect(r.deps.holds!.get("held-000091")).toMatchObject({ state: "ended", outcome: "expired" });
    } finally {
      console.warn = warn;
    }
  });

  test("a request settled before its row was removed finishes the row on start: a cancel drops it, an expiry ends it with no crash reason", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-000097" });
    await r.send("and a second one", { id: "held-000098" });
    const held = (id: string) => r.deps.store.get(id)!.receipt!;
    r.deps.store.settle("held-000097", { ...held("held-000097"), outcome: "cancelled" });
    r.deps.store.settle("held-000098", { ...held("held-000098"), outcome: "expired" });
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(2);
    expect(holds.get("held-000097")).toBeNull();
    expect(holds.get("held-000098")).toMatchObject({ state: "ended", outcome: "expired" });
    expect(holds.get("held-000098")?.reason).toBeUndefined();
  });

  test("a release the bridge died in ends unknown(crash) on boot, its text kept, and is never sent again", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000017" });
    // The release had started: the file said running, the request ran as accepted.
    first.holds.markRunning("held-000017");
    first.deps.store.rearm("held-000017");
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    expect(store.recover(SendProtocol.crashReceipt).map((record) => record.id)).toEqual(["held-000017"]);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(1);
    expect(holds.get("held-000017")).toMatchObject({ state: "ended", outcome: "unknown", reason: "crash", text: "then give it a title" });
    const second = rig({ version: "no version here", holds, storeDir: join(dir, "sends"), clock: { now: 2_000_000 } });
    expect(await tick(second)).toEqual([]);
    expect(second.pane.calls).toEqual([]);
  });

  test("a release that had not started when the bridge died goes back to waiting", async () => {
    const first = untrusted();
    await first.send("then give it a title", { id: "held-000018" });
    first.holds.markRunning("held-000018");
    const store = new RequestStore(join(dir, "sends"), () => 2_000_000);
    store.recover(SendProtocol.crashReceipt);
    const holds = new HoldStore(join(dir, "held"), () => 2_000_000);
    expect(SendProtocol.reconcileHolds(holds, store)).toBe(1);
    expect(holds.get("held-000018")?.state).toBe("held");
  });

  test("a pane holds at most 32 sends; the next is refused busy, never dropped silently", async () => {
    const r = untrusted();
    for (let i = 0; i < 32; i++) expect((await r.send(`message ${String(i)}`)).receipt?.outcome).toBe("held");
    expect((await r.send("one too many")).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
    expect(r.holds.list()).toHaveLength(32);
  });

  test("Add to it in a turn is not held: it names the draft in the box now (review of spec 15, H3)", async () => {
    const r = untrusted();
    r.pane.box = "half a thought";
    expect((await r.send(" and more", { mode: "append", rowsHash: OFFERED })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(r.holds.list()).toEqual([]);
  });

  test("a command the profile never lets wait is refused in a turn, neither queued by the harness nor held (H6)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ holds });
    r.pane.over = [LIVE_ROW];
    for (const text of ["/clear", "/resume", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    }
    expect(holds.list()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    // A longer word is another command: `/clearly` is not `/clear`.
    const claude = profileFor("claude", "2.1.301", { log: () => undefined });
    expect(neverHeldEntry("/clearly", claude)).toBeNull();
    expect(neverHeldEntry("/clear all", claude)).toBe("/clear");
    // Codex 0.163.0 lists /logout among its slash commands (its binary's command names, review of spec 15).
    expect(neverHeldEntry("/logout", profileFor("codex", "0.163.0", { log: () => undefined }))).toBe("/logout");
    // /compact stays allowed on both.
    expect(neverHeldEntry("/compact", claude)).toBeNull();
    expect(neverHeldEntry("/compact", profileFor("codex", "0.163.0", { log: () => undefined }))).toBeNull();
  });

  test("a never-held command on a profile that does not queue commands is refused, not held, and joins no queue (H6)", async () => {
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ edit: noCommandQueue, holds });
    r.pane.over = [LIVE_ROW];
    expect((await r.send("/exit", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    expect((await r.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact"]);
  });

  test("Muse: every measured session-acting command in a turn is refused, never held, and never typed after the turn ends (MUSE-08, #519)", async () => {
    // Spellings measured live on Muse 1.4.10 (palette/help, nothing destructive executed):
    // /clear and /new clear to a fresh session, /exit and /quit quit, /logout logs out and exits,
    // /resume swaps session, /fork branches it, /rewind rewinds it, and ! is the shell escape.
    const NEVER = "Collie does not queue this command during a turn. Send it when the turn ends.";
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "muse", version: "1.4.7", holds });
    r.pane.placeholder = "Start a message with ! to run a shell command yourself";
    r.pane.over = ["◇ Double checking (2m 40s · esc to interrupt)"];
    for (const text of ["/clear", "/new", "/exit", "/quit", "/logout", "/resume", "/fork", "/rewind", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt, text).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail, text).toBe(NEVER);
    }
    expect(holds.list()).toEqual([]);
    expect(r.pane.calls).toEqual([]);
    // Nothing is delivered when the turn ends.
    turnEnds(r.pane);
    await freeTwice(r);
    await tick(r);
    expect(r.pane.calls).toEqual([]);
    expect(r.pane.transcript.join("\n")).not.toContain("/clear");
    // Ordinary sends in a Muse turn still hold and queue; /compact is not session-acting.
    r.pane.over = ["◇ Double checking (2m 40s · esc to interrupt)"];
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    // A never-held command sent behind an existing hold still refuses, never joins the queue.
    expect((await r.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect((await r.send("then give it a title")).receipt?.outcome).toBe("held");
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact", "then give it a title"]);
    // The matcher is per spelling: unmeasured or non-session spellings are not caught.
    const muse = profileFor("muse", "1.4.7", { log: () => undefined });
    expect(loadProfiles().get("muse")?.keys.neverHeld).toEqual(["/clear", "/new", "/exit", "/quit", "/logout", "/resume", "/fork", "/rewind", "!"]);
    expect(neverHeldEntry("/fork fix the parser", muse)).toBe("/fork");
    expect(neverHeldEntry("/compact", muse)).toBeNull();
    expect(neverHeldEntry("/branch", muse)).toBeNull();
    expect(neverHeldEntry("/resume-claude", muse)).toBeNull();
    expect(neverHeldEntry("/clearly", muse)).toBeNull();
  });

  describe("a never-held command on a profile the turn cannot be trusted with (PR 491)", () => {
    const NEVER = "Collie does not queue this command during a turn. Send it when the turn ends.";
    const CODEX_WORKING = "• Working (4s • esc to interrupt)";
    const outcomeOf = (answer: SendAnswer, holds: HoldStore) => ({
      outcome: answer.receipt?.outcome,
      detail: answer.detail,
      held: holds.list().length,
    });

    test("control: the same /clear on a Claude whose version was read is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = rig({ holds });
      r.pane.over = [LIVE_ROW];
      const answer = await r.send("/clear", { mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });

    test("Claude, version unread: /clear in a turn is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const r = untrusted({ holds });
      const answer = await r.send("/clear", { id: "never-clr-01", mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });

    test("Claude, version unread: a /clear sent in a turn is never typed after the turn ends", async () => {
      const r = untrusted();
      await r.send("/clear", { id: "never-clr-02", mode: "command" });
      expect(await tick(r, RUNNING)).toEqual([]);
      turnEnds(r.pane);
      await freeTwice(r);
      await tick(r);
      expect(r.pane.transcript).not.toContain("> /clear");
      expect(r.pane.calls).toEqual([]);
    });

    test("Codex, version unread: /new in a turn is refused, and never typed after the turn ends", async () => {
      const clock = { now: 1_000_000 };
      const holds = new HoldStore(join(dir, "held"), () => clock.now);
      const r = rig({ pane: new FakePane("codex"), harness: "codex", version: "no version here", holds, clock });
      r.pane.over = [CODEX_WORKING];
      const answer = await r.send("/new", { id: "never-new-01", mode: "command" });
      await tick(r, RUNNING);
      r.pane.over = [];
      await freeTwice(r);
      await tick(r);
      expect({ ...outcomeOf(answer, holds), typed: r.pane.transcript.includes("› /new") }).toEqual({ outcome: "refused", detail: NEVER, held: 0, typed: false });
    });

    test("Codex, version unread, a running screen with no box to read (gateSteeringTurn): /exit is refused, not held", async () => {
      const holds = new HoldStore(join(dir, "held"));
      const pane = new FakePane("codex");
      pane.fixed = ["a transcript row", "", CODEX_WORKING, "", "a row Collie cannot read as a box"].join("\n");
      const r = rig({ pane, harness: "codex", version: "no version here", holds });
      const answer = await r.send("/exit", { id: "never-ext-01", mode: "command" });
      expect(outcomeOf(answer, holds)).toEqual({ outcome: "refused", detail: NEVER, held: 0 });
    });
  });

  test("a held send never goes into a box that answers the agent's question (idle.answerPrompt); a person's send from the phone still may", async () => {
    const capture = (name: string): string => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8");
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ harness: "hermes", version: "0.22.2", holds, clock });
    // Hermes works (`☤`): the message is held.
    r.pane.fixed = capture("hermes--running.txt");
    expect((await r.send("then summarize the changes", { id: "held-answer-01" })).receipt?.outcome).toBe("held");
    // The turn pauses on an open question (`✎`): the Surface reads free, but the box answers it.
    r.pane.fixed = capture("hermes--clarify-other.txt");
    const [released] = await freeTwice(r);
    expect(released?.receipt).toMatchObject({ requestId: "held-answer-01", outcome: "held" });
    expect(holds.get("held-answer-01")?.state).toBe("held");
    expect(r.pane.calls).toEqual([]);
    // A send that is no person's own (a walky talky message, a hook, the CLI) waits too (#704).
    const direct = rig({ harness: "hermes", version: "0.22.2" });
    direct.pane.fixed = capture("hermes--clarify-other.txt");
    const other = await direct.send("CockroachDB");
    expect(other.receipt).toMatchObject({ outcome: "refused", reason: "not_free" });
    expect(direct.pane.calls).toEqual([]);
    // The person, looking at the question, may answer it from the phone: that send is typed.
    const answer = await direct.send("CockroachDB", { fromPhone: true });
    expect(answer.receipt?.reason).not.toBe("not_free");
    expect(direct.pane.calls.length).toBeGreaterThan(0);
  });

  test("a held Replace waits at an answer box too, and an open question spends none of a request's tries", async () => {
    const capture = (name: string): string => readFileSync(join(import.meta.dir, `../../web/src/fixtures/panes/${name}`), "utf8");
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ harness: "hermes", version: "0.22.2", holds, clock });
    r.pane.fixed = capture("hermes--running.txt");
    expect((await r.send("then summarize the changes", { id: "held-answer-02", mode: "replace", rowsHash: OFFERED })).receipt?.outcome).toBe("held");
    r.pane.fixed = capture("hermes--clarify-other.txt");
    // Far past the five tries a pane that is not ready gets: the question stays open for minutes.
    for (let i = 0; i < 30; i++) {
      clock.now += 10_000;
      await tick(r);
    }
    expect(holds.get("held-answer-02")).toMatchObject({ state: "held", tries: 0 });
    expect(r.pane.calls).toEqual([]);
  });

  test("a never-held command on a running screen with no frame is refused, not held", async () => {
    // Hermes mid-redraw: the `☤` row stands, its rules are not drawn yet, so no frame is read and the
    // screen takes the manual path, where the running row is read by the steering-turn gate.
    const capture = readFileSync(join(import.meta.dir, "../../web/src/fixtures/panes/hermes--running.txt"), "utf8");
    const rows = capture.split("\n");
    const sgr = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;]*m`, "gu");
    const isRule = (row: string): boolean => /^─{20,}\s*$/u.test(row.replace(sgr, ""));
    const rules = new Set(rows.map((row, i) => (isRule(row) ? i : -1)).filter((i) => i >= 0).slice(-2));
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ harness: "hermes", version: "0.22.2", holds });
    r.pane.fixed = rows.filter((_, i) => !rules.has(i)).join("\n");
    const answer = await r.send("/exit", { mode: "command" });
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    expect(holds.list()).toEqual([]);
  });

  test("a never-held command is refused, not held, on a harness that takes nothing in a turn", async () => {
    // Hermes's shape: Enter steers a turn and no key queues, so every send in a turn is held, except
    // the commands the profile never lets wait. An untrusted version takes the same path.
    const holds = new HoldStore(join(dir, "held"));
    const r = rig({ edit: steersWithNoQueueKey, holds });
    r.pane.over = [LIVE_ROW];
    for (const text of ["/clear", "/resume", "!git status"]) {
      const answer = await r.send(text, { mode: "command" });
      expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
      expect(answer.detail).toBe("Collie does not queue this command during a turn. Send it when the turn ends.");
    }
    expect((await r.send("/compact", { mode: "command" })).receipt?.outcome).toBe("held");
    expect((await r.send("then give it a title")).receipt?.outcome).toBe("held");
    expect(holds.list().map((entry) => entry.text)).toEqual(["/compact", "then give it a title"]);
    expect(r.pane.calls).toEqual([]);
    const untrustedHolds = new HoldStore(join(dir, "held-untrusted"));
    const u = untrusted({ holds: untrustedHolds });
    expect((await u.send("/clear", { mode: "command" })).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
    expect(untrustedHolds.list()).toEqual([]);
  });

  test("a held command expires after 10 minutes, a held text after 30 (H6)", async () => {
    const clock = { now: 1_000_000 };
    const holds = new HoldStore(join(dir, "held"), () => clock.now);
    const r = rig({ edit: noCommandQueue, holds, clock, version: "no version here" });
    r.pane.over = [LIVE_ROW];
    await r.send("/compact", { id: "held-cmd-01", mode: "command" });
    await r.send("then give it a title", { id: "held-txt-01" });
    clock.now += 10 * 60 * 1000;
    await tick(r, RUNNING);
    expect(holds.get("held-cmd-01")).toMatchObject({ state: "ended", outcome: "expired" });
    expect(holds.get("held-txt-01")?.state).toBe("held");
  });

  test("a manual send on a pane with held sends joins the queue too (H9)", async () => {
    const r = untrusted();
    await r.send("first message", { id: "held-man-01" });
    turnEnds(r.pane);
    const manual = await r.send("second message", { id: "held-man-02", rowsHash: "abc123" });
    expect(manual.receipt).toMatchObject({ outcome: "held", keys: [] });
    expect(r.pane.calls).toEqual([]);
    expect(r.protocol.heldOf("main", "%1").map((row) => row.requestId)).toEqual(["held-man-01", "held-man-02"]);
  });

  test("the bridge holds at most 256 sends over all panes; the next is refused busy (H9)", async () => {
    const r = untrusted();
    for (let i = 0; i < 256; i++) r.holds.add({ id: `seed-${String(i).padStart(6, "0")}`, session: "main", paneId: `%${String(100 + (i % 16))}`, harness: "claude", mode: "send", text: "x", revision: 0, command: false });
    expect((await r.send("one too many")).receipt).toMatchObject({ outcome: "refused", reason: "busy" });
  });

  test("Resend takes the stored text of an ended row, never one that may have reached the agent or still stands in the box (H7)", async () => {
    const clock = { now: 1_000_000 };
    const r = untrusted({ clock });
    await r.send("then give it a title", { id: "held-res-01" });
    expect(r.protocol.resendSource("main", "%1", "held-res-01")).toBeNull();
    clock.now += 31 * 60 * 1000;
    await tick(r, RUNNING);
    expect(r.protocol.resendSource("main", "%1", "held-res-01")).toEqual({ text: "then give it a title", mode: "send" });
    expect(r.protocol.resendSource("main", "%2", "held-res-01")).toBeNull();
    r.holds.add({ id: "held-res-02", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "maybe in", revision: 0, command: false });
    r.holds.end("held-res-02", "unknown", "no_evidence");
    expect(r.protocol.resendSource("main", "%1", "held-res-02")).toBeNull();
    r.holds.add({ id: "held-res-03", session: "main", paneId: "%1", harness: "claude", mode: "send", text: "in the box", revision: 0, command: false });
    r.holds.end("held-res-03", "typed_not_submitted", "changed");
    expect(r.protocol.resendSource("main", "%1", "held-res-03")).toBeNull();
    expect(r.protocol.dismissHeld("main", "%1", "held-res-01")).toBe(true);
    expect(r.protocol.dismissHeld("main", "%1", "held-res-01")).toBe(false);
  });

  test("on boot, held sends of a session that no longer exists go, and a still-held request settles pane_gone (H9)", async () => {
    const r = untrusted();
    await r.send("then give it a title", { id: "held-gone-01" });
    expect(SendProtocol.dropHoldsOutside(r.holds, r.deps.store, new Set(["main"]))).toBe(0);
    expect(SendProtocol.dropHoldsOutside(r.holds, r.deps.store, new Set(["other"]))).toBe(1);
    expect(r.holds.list()).toEqual([]);
    expect(r.deps.store.get("held-gone-01")?.receipt).toMatchObject({ outcome: "refused", reason: "pane_gone" });
  });

  test("without a hold queue the old refusal stands: turn_running, nothing typed", async () => {
    const r = rig({ version: "no version here" });
    r.pane.over = [LIVE_ROW];
    expect((await r.send("then give it a title")).receipt).toMatchObject({ outcome: "refused", reason: "turn_running", keys: [] });
  });
});
