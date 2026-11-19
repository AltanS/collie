// The hold queue on disk (M56 spec 15): one 0600 file per held request, queue order kept across a
// restart, the three states, the keep window and caps of an ended row, and the boot cleanup.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxOutcome } from "../mux/types.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { HOLD_GRACE_MS, HOLD_WIRE_VERSION, shownInputOf } from "../../web/src/lib/surface/hold.ts";
import { liftDialog, readerBlocks } from "../../web/src/lib/surface/lift.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { Ask } from "../../web/src/lib/surface/surface.ts";
import { PartAsks } from "../inside/asks.ts";
import type { FakePart } from "../inside/fake-part.ts";
import { AskAnswerer, AskBook } from "./ask.ts";
import { HoldBook, takeHold, type Held } from "./hold.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";
import { dataDescribe, dataId, dataRig, type DataRig } from "../inside/data-rig.ts";
import { HOLD_BRIDGE_MAX, HOLD_COMMAND_MS, HOLD_ENDED_KEEP_MS, HOLD_ENDED_PANE_MAX, HOLD_MS, HOLD_PANE_MAX, HoldStore, heldRow, type HoldInput } from "./holds.ts";

let dir: string;
beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "collie-holds-")), "held");
});
afterEach(() => rmSync(join(dir, ".."), { recursive: true, force: true }));

const input = (id: string, paneId = "%1", session = "main"): HoldInput => ({ id, session, paneId, harness: "agent", mode: "send", text: `text of ${id}`, revision: 3, command: false });

describe("HoldStore", () => {
  test("a marked request (M62 spec 02) keeps its caller's end, its mark and what holds it, across a restart", () => {
    const store = new HoldStore(dir, () => 5_000);
    const entry = store.add({ ...input("req-000001"), draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    expect(entry).toMatchObject({ draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    expect(new HoldStore(dir, () => 5_000).get("req-000001")).toMatchObject({ draftHolds: true, cause: "draft_present", expiresAt: 5_000 + 60 * 60 * 1000 });
    // An unmarked request keeps the cause it was held from (the phone's sentence), and the store's own clock.
    const plain = store.add({ ...input("req-000002"), cause: "not_free" });
    expect(plain.cause).toBe("not_free");
    expect(plain.draftHolds).toBeUndefined();
    expect(plain.expiresAt).toBe(5_000 + HOLD_MS);
    // Every held request follows the pane (the poll), a marked one or not.
    expect(store.setCause("req-000002", "turn_running")?.cause).toBe("turn_running");
    expect(store.setCause("req-000009", "turn_running")).toBeNull();
  });

  test("a WalkyTalky message's hold keeps its id across a restart and an end, and the phone's row carries it; a person's own hold has none", () => {
    const store = new HoldStore(dir, () => 5_000);
    store.add({ ...input("req-000001"), draftHolds: true, cause: "draft_present", walky: "wt_aaaaaaaaaaa1" });
    store.add(input("req-000002"));
    const again = new HoldStore(dir, () => 5_000);
    expect(again.get("req-000001")?.walky).toBe("wt_aaaaaaaaaaa1");
    expect(heldRow(again.get("req-000001")!)).toMatchObject({ requestId: "req-000001", walky: "wt_aaaaaaaaaaa1" });
    expect(heldRow(again.get("req-000002")!)).not.toHaveProperty("walky");
    expect(again.get("req-000002")).not.toHaveProperty("walky");
    // The row keeps it when it ends, so the phone can tell an ended mail row from an ended send of the person's.
    expect(heldRow(again.end("req-000001", "typed_not_submitted")!)).toMatchObject({ state: "ended", outcome: "typed_not_submitted", walky: "wt_aaaaaaaaaaa1" });
  });

  test("a file whose walky field is not a message id reads back without it", () => {
    const store = new HoldStore(dir, () => 5_000);
    store.add({ ...input("req-000001"), draftHolds: true, walky: "wt_aaaaaaaaaaa1" });
    const path = join(dir, "req-000001.json");
    const entry = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, `${JSON.stringify({ ...entry, walky: "not a message id" })}\n`);
    expect(new HoldStore(dir, () => 5_000).get("req-000001")).not.toHaveProperty("walky");
  });

  test("every cause a refusal holds from comes back from its file and rides on the phone's row", () => {
    const store = new HoldStore(dir, () => 5_000);
    const causes = ["turn_running", "not_free", "bound", "draft_present", "probe_failed"] as const;
    causes.forEach((cause, i) => store.add({ ...input(`req-00000${String(i + 1)}`), cause }));
    const again = new HoldStore(dir, () => 5_000);
    expect(again.list().map((entry) => entry.cause)).toEqual([...causes]);
    expect(again.list().map((entry) => heldRow(entry).cause)).toEqual([...causes]);
    // A file with a cause no bridge writes reads back without one; a file without one gives a row without one.
    writeFileSync(join(dir, "req-000009.json"), `${JSON.stringify({ ...again.get("req-000001"), id: "req-000009", seq: 99, cause: "sideways" })}\n`);
    const third = new HoldStore(dir, () => 5_000);
    expect(third.get("req-000009")?.cause).toBeUndefined();
    expect(heldRow(third.get("req-000009")!)).not.toHaveProperty("cause");
  });

  test("setCause writes the file only when the cause changed, and a put-back keeps it", () => {
    const store = new HoldStore(dir, () => 5_000);
    store.add({ ...input("req-000001"), draftHolds: true, cause: "draft_present" });
    const path = join(dir, "req-000001.json");
    // A field only this test writes: a rewrite from memory would drop it.
    writeFileSync(path, `${JSON.stringify({ ...store.get("req-000001"), untouched: true })}\n`);
    expect(store.setCause("req-000001", "draft_present")?.cause).toBe("draft_present");
    expect(readFileSync(path, "utf8")).toContain('"untouched":true');
    expect(store.setCause("req-000001", "turn_running")?.cause).toBe("turn_running");
    expect(store.putBack("req-000001", false)).toMatchObject({ cause: "turn_running", draftHolds: true });
    expect(new HoldStore(dir, () => 5_000).get("req-000001")?.cause).toBe("turn_running");
  });

  test("a held request is one 0600 file in a 0700 directory, with its text, ending HOLD_MS later", () => {
    const store = new HoldStore(dir, () => 5_000);
    const entry = store.add(input("req-000001"));
    expect(entry).toMatchObject({ state: "held", heldAt: 5_000, expiresAt: 5_000 + HOLD_MS, tries: 0, text: "text of req-000001" });
    expect(readdirSync(dir)).toEqual(["req-000001.json"]);
    // Windows has no POSIX mode bits, so only the mode expectations wait for another platform.
    if (process.platform !== "win32") {
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(dir, "req-000001.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("a pane's queue is in hold order, across a restart, and a new hold after the restart goes last", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    store.add(input("req-000003"));
    now += 10;
    store.add(input("req-000001"));
    store.add(input("req-000009", "%2"));
    const again = new HoldStore(dir, () => now);
    expect(again.list("main", "%1").map((entry) => entry.id)).toEqual(["req-000003", "req-000001"]);
    again.add(input("req-000002"));
    expect(again.waiting("main", "%1").map((entry) => entry.id)).toEqual(["req-000003", "req-000001", "req-000002"]);
    expect(again.list("other")).toEqual([]);
  });

  test("a command that waits for a polled turn keeps the mark across a restart; one without it writes none", () => {
    const store = new HoldStore(dir, () => 1_000);
    store.add({ ...input("req-000021"), mode: "command", text: "/model", command: true, waitsForTurn: true });
    store.add({ ...input("req-000022"), waitsForTurn: false });
    const again = new HoldStore(dir, () => 1_000);
    expect(again.get("req-000021")?.waitsForTurn).toBe(true);
    expect(again.get("req-000022") && "waitsForTurn" in again.get("req-000022")!).toBe(false);
  });

  test("running, put back with a try counted, ended with the text kept; waiting leaves the ended out", () => {
    const store = new HoldStore(dir, () => 1_000);
    store.add(input("req-000001"));
    store.add(input("req-000002"));
    expect(store.markRunning("req-000001")?.state).toBe("running");
    expect(store.markRunning("req-000001")).toBeNull();
    expect(store.putBack("req-000001")).toMatchObject({ state: "held", tries: 1 });
    expect(store.end("req-000002", "expired")).toMatchObject({ state: "ended", outcome: "expired", endedAt: 1_000, text: "text of req-000002" });
    expect(store.waiting("main", "%1").map((entry) => entry.id)).toEqual(["req-000001"]);
    expect(new HoldStore(dir).get("req-000002")).toMatchObject({ state: "ended", outcome: "expired" });
  });

  test("an ended row goes after the keep window; a waiting one never does", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    store.add(input("req-000001"));
    store.add(input("req-000002"));
    store.end("req-000002", "refused", "pane_gone");
    now += HOLD_ENDED_KEEP_MS + 1;
    expect(store.prune()).toBe(1);
    expect(store.list().map((entry) => entry.id)).toEqual(["req-000001"]);
  });

  test("on boot a held file that does not read back and a .tmp leftover are deleted; a foreign name is left alone", () => {
    const store = new HoldStore(dir);
    store.add(input("req-000001"));
    writeFileSync(join(dir, "req-000002.json"), "{\"id\":\"req-000002\"}\n");
    writeFileSync(join(dir, "not a request.json"), "{}\n");
    writeFileSync(join(dir, "req-000003.json"), "not json\n");
    writeFileSync(join(dir, "req-000004.json.tmp"), "{\"text\":\"half a write\"}\n");
    expect(new HoldStore(dir).list().map((entry) => entry.id)).toEqual(["req-000001"]);
    expect(readdirSync(dir).toSorted()).toEqual(["not a request.json", "req-000001.json"]);
  });

  test("a held command ends HOLD_COMMAND_MS after it was held, a text HOLD_MS", () => {
    const store = new HoldStore(dir, () => 5_000);
    expect(store.add({ ...input("req-000001"), command: true }).expiresAt).toBe(5_000 + HOLD_COMMAND_MS);
    expect(store.add(input("req-000002")).expiresAt).toBe(5_000 + HOLD_MS);
    expect(HOLD_COMMAND_MS).toBe(10 * 60 * 1000);
  });

  test("a pane keeps at most 50 ended rows for at most an hour; the oldest go first; the bridge counts its waiting rows", () => {
    let now = 1_000;
    const store = new HoldStore(dir, () => now);
    for (let i = 0; i < 52; i++) {
      const id = `req-${String(i).padStart(6, "0")}`;
      store.add(input(id));
      now += 1;
      store.end(id, "expired");
    }
    store.add(input("req-other1", "%2"));
    store.end("req-other1", "expired");
    store.add(input("req-wait01"));
    expect(store.waitingCount()).toBe(1);
    expect(store.prune()).toBe(2);
    const ended = store.list("main", "%1").filter((entry) => entry.state === "ended").map((entry) => entry.id);
    expect(ended).toHaveLength(HOLD_ENDED_PANE_MAX);
    expect(ended[0]).toBe("req-000002");
    expect(store.get("req-other1")?.state).toBe("ended");
    expect(HOLD_ENDED_KEEP_MS).toBe(60 * 60 * 1000);
    expect(HOLD_PANE_MAX).toBe(32);
    expect(HOLD_BRIDGE_MAX).toBe(256);
  });

  test("the phone's row carries the text, the times and the state, and the outcome once ended", () => {
    const store = new HoldStore(dir, () => 1_000);
    const entry = store.add(input("req-000001"));
    expect(heldRow(entry)).toEqual({ requestId: "req-000001", mode: "send", text: "text of req-000001", heldAt: 1_000, expiresAt: 1_000 + HOLD_MS, state: "held" });
    const ended = store.end("req-000001", "refused", "pane_gone")!;
    expect(heldRow(ended)).toMatchObject({ state: "ended", outcome: "refused", reason: "pane_gone" });
    expect(store.remove("req-000001")).toBe(true);
    expect(store.remove("req-000001")).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});

// ── The data road holds as the screen road does (M99 spec 03) ──

dataDescribe("a data send while the part's turn runs", () => {
  const rigs: DataRig[] = [];
  afterEach(() => {
    for (const rig of rigs.splice(0)) rig.stop();
  });
  async function running(): Promise<{ r: DataRig; part: FakePart }> {
    const r = await dataRig({ harness: "claude", version: "2.1.200" });
    rigs.push(r);
    const part = await r.part();
    // The bridge's wiring: a part's turn end releases its pane's oldest held send (bridge/index.ts).
    r.hub.listen({ event: (bound, event) => void (event.kind === "turn.end" ? r.protocol.releaseOnTurnEnd(bound.address.session, bound.address.paneId) : null) });
    await part.event("turn.start", { turn: "t1" });
    return { r, part };
  }

  test("goes to the part at the turn-end event, under its own request id, and ends sent", async () => {
    const { r, part } = await running();
    const id = dataId();
    await r.send(id, "after the turn");
    const served = part.serveOnce();
    await part.event("turn.end", { turn: "t1", reason: "answer" });
    expect(await served).toEqual({ id, kind: "prompt", text: "after the turn" });
    await r.hub.waitFor(id, ["sent"], 2000);
    for (let i = 0; i < 20 && r.store.get(id)?.receipt?.outcome !== "sent"; i += 1) await Bun.sleep(25);
    expect(r.store.get(id)?.receipt?.outcome).toBe("sent");
    expect(r.store.get(id)?.path).toBe("data");
    expect(r.protocol.heldOf("main", "w1:p1")).toEqual([]);
    expect(r.mux.calls).toEqual([]);
  });
});

// ── A permission hold from a part is today's hold (M99 spec 04) ──

describe("a permission hold from the part", () => {
  const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
  const BASH_DIALOG = readFileSync(join(FIXTURES, "claude--permission-bash.txt"), "utf8");
  const GEN = "claude:session-1";
  const PANE = "%1";
  const HOLD = loadProfiles().get("claude")!.hold!;

  function hookRig() {
    const root = mkdtempSync(join(tmpdir(), "part-hold-"));
    const clock = { now: 2_000_000 };
    const now = (): number => clock.now;
    const keys: string[] = [];
    const screen = { text: BASH_DIALOG };
    const pane = {
      readGrid: (paneId: string): Promise<MuxOutcome<MuxGrid>> => Promise.resolve(muxOk({ paneId, text: screen.text, truncated: false, revision: 0 })),
      writeKeys: (_paneId: string, sent: readonly string[]): Promise<MuxAck> => {
        keys.push(...sent);
        return Promise.resolve(muxAck());
      },
    };
    const holdBook = new HoldBook({ now, salt: "hold-salt", log: () => undefined, schedule: () => () => undefined });
    const book = new AskBook(now, "test-salt");
    book.attachHolds(holdBook);
    const answerer = new AskAnswerer({
      log: () => undefined,
      mux: pane,
      gate: new KeyGate(pane, now),
      store: new RequestStore(join(root, "sends"), now),
      locks: new SessionLocks(),
      book,
      ring: new RowRing(),
      profile: (harness) => Promise.resolve(profileFor(harness, "2.1.301", { log: () => undefined })),
      generation: () => GEN,
      now,
      sleep: (ms) => {
        clock.now += ms;
        return Promise.resolve();
      },
    });
    const deps = { book: holdBook, generation: () => GEN, profile: (harness: string) => loadProfiles().get(harness)?.hold, reread: () => undefined };
    const poll = (): Ask | null => book.publish(PANE, GEN, liftDialog(readerBlocks(splitLines(parseAnsi(BASH_DIALOG)), "claude")));
    const answer = (ask: Ask, optionId: string, hash = ask.hash) => answerer.handle({ askId: ask.id, hash, optionId, origin: "person_tap" }, { session: "main", paneId: PANE, harness: "claude" });
    return { holdBook, book, deps, poll, answer, keys, screen };
  }

  function partRig() {
    const r = hookRig();
    const answers: { ask: string; decision: string }[] = [];
    const commandIds: string[] = [];
    const asks = new PartAsks({
      sessionOf: () => ({
        harnessOf: () => "claude",
        holdProfile: (harness) => loadProfiles().get(harness)?.hold,
        takeHold: (paneId, request, conn, onClose) => takeHold(r.deps, paneId, request, conn, onClose),
        settle: (held, outcome) => (outcome === "void" ? r.holdBook.end(held, "void") : r.holdBook.settle(held, outcome)),
      }),
      enqueue: (_address, command) => {
        answers.push({ ask: command.ask, decision: command.decision });
        commandIds.push(command.id);
        // The part returns the decision; the desk then shows the hook's line, as after a hook's reply.
        r.screen.text = `⏺ Bash(mkfifo fixture-fifo)\n  ⎿  Allowed by PermissionRequest hook\n${readFileSync(join(FIXTURES, "claude--v2301-idle.txt"), "utf8")}`;
        return { ok: true };
      },
      now: () => 1,
    });
    const part = { partId: "p".repeat(22), address: { session: "main", paneId: PANE }, capabilities: new Set(["send", "wake"] as const), asks: new Set(["permission"] as const), boundAt: 0, pid: 4242, pidStartTime: 1234 };
    return { ...r, asks, part, answers, commandIds };
  }

  const INPUT = { command: "mkfifo fixture-fifo", description: "Make a fifo" };

  test("the part's ask gives the same card and hash as the hook's request for the same call", () => {
    const hook = hookRig();
    const shown = shownInputOf(INPUT, HOLD.inputShown, HOLD.inputDetails.Bash);
    takeHold(hook.deps, PANE, { v: HOLD_WIRE_VERSION, harness: "claude", pid: 4242, pidStartTime: 1234, markers: [], tool: "Bash", input: shown.text, agent: null, hold: true, at: 1 }, { reply: () => true, release: () => undefined }, () => undefined);
    const hookAsk = hook.poll();
    const fromHook = hook.holdBook.note(PANE);

    const p = partRig();
    expect(p.asks.ask(p.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT })).toEqual({ wait: true, waitMs: HOLD.limitMs + HOLD_GRACE_MS });
    const partAsk = p.poll();
    const fromPart = p.holdBook.note(PANE);
    expect(fromPart).not.toBeNull();
    expect({ tool: fromPart?.tool, input: fromPart?.input, options: fromPart?.options, hash: fromPart?.hash }).toEqual({ tool: fromHook?.tool, input: fromHook?.input, options: fromHook?.options, hash: fromHook?.hash });
    expect(partAsk?.hash).toBe(hookAsk?.hash);
    expect(partAsk?.channel).toBe("hook");
  });

  test("a tap gives the hook's receipt, and the decision goes to the part's ask; no key", async () => {
    const p = partRig();
    p.asks.ask(p.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    const ask = p.poll()!;
    const reply = await p.answer(ask, "1");
    expect(reply.receipt?.outcome).toBe("sent");
    expect(reply.receipt?.channel).toBe("hook");
    expect(reply.receipt?.decision).toBe("allow");
    expect(reply.receipt?.keys).toEqual([]);
    expect(p.answers).toEqual([{ ask: "perm-1", decision: "allow" }]);
    expect(p.keys).toEqual([]);
  });

  test("a tap with another hash lets the hold go: no decision reaches the part", async () => {
    const p = partRig();
    p.asks.ask(p.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    const ask = p.poll()!;
    await p.answer(ask, "1", "not-the-hash");
    expect(p.answers).toEqual([]);
  });

  test("nothing answers by itself: with no tap, no decision; the part's close ends the hold", () => {
    const p = partRig();
    p.asks.ask(p.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    p.asks.closed(p.part.partId, "perm-1");
    expect(p.answers).toEqual([]);
    expect(p.holdBook.note(PANE)?.state ?? "gone").not.toBe("held");
  });

  test("a screen-only tool or a harness with no hold profile asks the part not to wait", () => {
    const p = partRig();
    expect(p.asks.ask(p.part, { id: "q-1", kind: "permission", tool: "AskUserQuestion", input: {} })).toEqual({ wait: false });
    const none = new PartAsks({ sessionOf: () => ({ harnessOf: () => "shell", holdProfile: () => undefined, takeHold: () => null, settle: () => undefined }), enqueue: () => ({ ok: true }) });
    expect(none.ask(p.part, { id: "perm-2", kind: "permission", tool: "Bash", input: INPUT })).toEqual({ wait: false });
  });

  // ── The hold settles from the answer command (M99 review item 5) ──
  async function answered() {
    const p = partRig();
    p.asks.ask(p.part, { id: "perm-1", kind: "permission", tool: "Bash", input: { command: "mkfifo fixture-fifo", description: "Make a fifo" } });
    const ask = p.poll()!;
    await p.answer(ask, "1");
    const held = p.holdBook.holdsOn("%1")[0]!;
    return { p, held };
  }
  /** The hold as it stands right after the decision went out, before any evidence. */
  const unsettle = (held: Held): void => {
    held.outcome = null;
    held.state = "sent";
  };
  const entry = (id: string, state: "sent" | "failed" | "withdrawn", reason: string | null = null) => ({ command: { id, kind: "answer" as const, ask: "perm-1", decision: "allow" as const }, state, reason });

  test("settles from the answer command: the part's sent settles phone", async () => {
    const { p, held } = await answered();
    p.asks.command(entry(p.commandIds[0]!, "sent"));
    expect(held.outcome).toBe("phone");
  });

  test("settles from the answer command: the part's failed with reason desk settles desk, not phone", async () => {
    const { p, held } = await answered();
    // The rig's screen shows the hook's line at once; this run reads the part's word first.
    unsettle(held);
    p.asks.command(entry(p.commandIds[0]!, "failed", "desk"));
    expect(held.outcome).toBe("desk");
  });

  test("settles from the answer command: a command the part never answered is no settle; a withdrawal voids the hold", async () => {
    const { p, held } = await answered();
    unsettle(held);
    p.asks.command({ ...entry(p.commandIds[0]!, "sent"), state: "taken" });
    expect(held.outcome).toBeNull();
    p.asks.command(entry(p.commandIds[0]!, "withdrawn"));
    expect(held.state).toBe("ended");
  });
});

describe("ownership is per dialog (M99 review items 1 to 5)", () => {
  const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
  const BASH_DIALOG = readFileSync(join(FIXTURES, "claude--permission-bash.txt"), "utf8");
  const GEN = "claude:session-1";
  const PANE = "%1";
  const INPUT = { command: "mkfifo fixture-fifo", description: "Make a fifo" };

  function rig() {
    const timers: (() => void)[] = [];
    const holdBook = new HoldBook({ now: () => 2_000_000, salt: "hold-salt", log: () => undefined, schedule: (run) => (timers.push(run), () => undefined) });
    const book = new AskBook(() => 2_000_000, "test-salt");
    book.attachHolds(holdBook);
    const deps = { book: holdBook, generation: () => GEN, profile: (harness: string) => loadProfiles().get(harness)?.hold, reread: () => undefined };
    const asks = new PartAsks({
      sessionOf: () => ({
        harnessOf: () => "claude",
        holdProfile: (harness) => loadProfiles().get(harness)?.hold,
        takeHold: (paneId, request, conn, onClose) => takeHold(deps, paneId, request, conn, onClose),
        settle: (held, outcome) => (outcome === "void" ? holdBook.end(held, "void") : holdBook.settle(held, outcome)),
      }),
      enqueue: () => ({ ok: true }),
    });
    const part = { partId: "q".repeat(22), address: { session: "main", paneId: PANE }, capabilities: new Set(["send", "wake"] as const), asks: new Set(["permission"] as const), boundAt: 0, pid: 1, pidStartTime: 1 };
    const poll = (): Ask | null => book.publish(PANE, GEN, liftDialog(readerBlocks(splitLines(parseAnsi(BASH_DIALOG)), "claude")));
    const shown = shownInputOf(INPUT, HOLD.inputShown, HOLD.inputDetails.Bash).text;
    /** Run every timer the hold book set (the close grace among them). */
    const elapse = (): void => {
      for (const run of timers.splice(0)) run();
    };
    return { holdBook, asks, part, poll, shown, elapse };
  }
  const HOLD = loadProfiles().get("claude")!.hold!;

  test("a bound part with no ask.open owns nothing: the keys ask stays (item 3)", () => {
    const r = rig();
    expect(r.poll()?.channel).toBe("keys");
    expect(r.asks.ownsDialog("main", PANE, { tool: "Bash", input: r.shown, agent: null })).toBe(false);
  });

  test("a live part hold owns that dialog only: another tool, another input or a subagent's request is not its own (item 1)", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    expect(r.asks.ownsDialog("main", PANE, { tool: "Bash", input: r.shown, agent: null })).toBe(true);
    expect(r.asks.ownsDialog("main", PANE, { tool: "Edit", input: r.shown, agent: null })).toBe(false);
    expect(r.asks.ownsDialog("main", PANE, { tool: "Bash", input: "other", agent: null })).toBe(false);
    expect(r.asks.ownsDialog("main", PANE, { tool: "Bash", input: r.shown, agent: "sub-1" })).toBe(false);
    expect(r.asks.ownsDialog("other", PANE, { tool: "Bash", input: r.shown, agent: null })).toBe(false);
  });

  test("a part hold that ends with no decision hands the open dialog back: a keys ask is minted (item 2)", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    expect(r.poll()?.channel).toBe("hook");
    r.asks.closed(r.part.partId, "perm-1");
    expect(r.asks.ownsDialog("main", PANE, { tool: "Bash", input: r.shown, agent: null })).toBe(false);
    // As for a hook that let go early: the screen judges it for the close grace, then the keys ask.
    r.elapse();
    expect(r.poll()?.channel).toBe("keys");
  });

  test("the part goes away mid hold: the dialog is a keys ask again (item 3)", () => {
    const r = rig();
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    r.poll();
    r.asks.gone(r.part.partId);
    r.elapse();
    expect(r.poll()?.channel).toBe("keys");
  });

  test("an ask the hold does not take (a cut input, a screen-only tool, no tool) leaves the keys ask (item 3)", () => {
    const r = rig();
    expect(r.asks.ask(r.part, { id: "perm-9", kind: "permission", tool: "Bash", input: { command: "x".repeat(5000) } })).toEqual({ wait: false });
    expect(r.asks.ask(r.part, { id: "q-1", kind: "permission", tool: "AskUserQuestion", input: {} })).toEqual({ wait: false });
    expect(r.asks.ask(r.part, { id: "q-2", kind: "permission", tool: null, input: null })).toBeUndefined();
    expect(r.poll()?.channel).toBe("keys");
  });

  test("a hook that came first keeps its card until the part's hold opens; then one card, the part's (one card, never zero)", () => {
    const r = rig();
    const hookConn = { replies: 0, released: 0, reply: () => ((hookConn.replies += 1), true), release: () => void (hookConn.released += 1) };
    takeHold(
      { book: r.holdBook, generation: () => GEN, profile: (harness) => loadProfiles().get(harness)?.hold, reread: () => undefined },
      PANE,
      { v: HOLD_WIRE_VERSION, harness: "claude", pid: 4242, pidStartTime: 1234, markers: [], tool: "Bash", input: r.shown, agent: null, hold: true, at: 1 },
      hookConn,
      () => undefined,
    );
    expect(r.poll()?.channel).toBe("hook");
    r.asks.ask(r.part, { id: "perm-1", kind: "permission", tool: "Bash", input: INPUT });
    expect(hookConn).toMatchObject({ replies: 0, released: 1 });
    expect(r.holdBook.holdsOn(PANE).filter((held) => held.state === "held")).toHaveLength(1);
    expect(r.poll()?.channel).toBe("hook");
  });
});
