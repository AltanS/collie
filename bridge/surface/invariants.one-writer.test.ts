// M102 spec 16 in the invariant suite: I6 (at most once, never interleaved) across two bridges and
// across a crash, the two breaks the chaos leg's first run found outside one process (C3 and C1).
//
//   two bridges  two Send Protocols, each with its own key gate, request store and in-memory lock, over
//                ONE pane, started at the same moment: each request writes one whole line (its text,
//                then Enter, with no other request's write between) or is refused with no write at all.
//   a crash      a bridge stops between the text and Enter, holding the pane lock. A new bridge process
//                over the same request store takes the dead bridge's lock over; the same id again types
//                nothing and answers `unknown`/`interrupted` with the rows now; a new send meets the text
//                left in the box through the normal gates (`draft_present`), never appended to it.
//
// The pane locks are real files in a temp folder; each bridge has its own pid, and the test says which
// pids are alive. The seeds vary the screen, which bridge starts first, and a slow multiplexer.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { replayHint, rngOf, runSeeds } from "../../web/src/test/invariants/seed.ts";
import { invariantRig, LogPane, nextId, type InvariantRig, type PaneDraw, type RigOptions, type Write } from "./invariants-rig.ts";
import { PaneLockFiles } from "./pane-lock.ts";
import { SendProtocol } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

/** The profile whose box the rig draws, pinned as the gates suite pins it. */
const AGENT = { harness: "claude", pinVersions: [{ range: "2.1.0 - 2.1.296", low: "2.1.0", high: "2.1.296", status: "verified", verifiedThrough: "2.1.296", verifiedOn: "2026-10-12" }] } satisfies Pick<RigOptions, "harness" | "pinVersions">;
/** A shell: no profile, the blind road (the chaos leg's panes). */
const SHELL = { harness: "", version: null } satisfies Pick<RigOptions, "harness" | "version">;

let root: string;
const living = new Set<number>();
const rigs: InvariantRig[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "collie-one-writer-"));
  living.clear();
});
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.dispose();
  rmSync(root, { recursive: true, force: true });
});

/** One bridge process: its pid, its pane lock on the shared folder, a Send Protocol over the shared pane. */
function bridgeOn(pane: LogPane, clock: { now: number }, pid: number, kind: Pick<RigOptions, "harness" | "pinVersions" | "version">, storeDir?: string): InvariantRig {
  living.add(pid);
  mkdirSync(join(root, "locks"), { recursive: true });
  const paneLock = new PaneLockFiles({ dir: join(root, "locks"), scope: "herdr\u0000/run/user/1000/herdr.sock", pid, now: () => clock.now, alive: (p) => living.has(p), startOf: (p) => `start-${String(p)}` });
  const rig = invariantRig({ ...kind, draw: pane.draw, pane, clock, paneLock, storeDir });
  rigs.push(rig);
  return rig;
}

/** Let pending runs go on: the protocol's calls answer on later turns of the event loop. */
async function settleLoop(until: () => boolean, turns = 400): Promise<void> {
  for (let turn = 0; turn < turns && !until(); turn++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Whether a write log is whole lines: between two Enters, every text write belongs to one text. A
 * probe character and its Backspace are no text.
 */
function interleaved(log: readonly Write[], texts: readonly string[]): string | null {
  let owner: string | null = null;
  for (const write of log) {
    if (write.kind === "keys") {
      if (write.value === "Enter") owner = null;
      continue;
    }
    const whose = texts.find((text) => write.value.includes(text));
    if (whose === undefined) continue;
    if (owner !== null && owner !== whose) return `"${whose}" was written into the line of "${owner}"`;
    owner = whose;
  }
  return null;
}

function textWritesOf(log: readonly Write[], text: string): number {
  return log.filter((write) => write.kind !== "keys" && write.value.includes(text)).length;
}

describe("I6 across two bridges on one pane (M102 spec 16, chaos C3)", () => {
  async function bothAtOnce(draw: PaneDraw, kind: Pick<RigOptions, "harness" | "pinVersions" | "version">, firstOne: boolean, delayMs: number): Promise<string | null> {
    const pane = new LogPane(draw);
    pane.readDelayMs = delayMs;
    const clock = { now: 1_000_000 };
    const one = bridgeOn(pane, clock, 101, kind);
    const two = bridgeOn(pane, clock, 202, kind);
    const [textOne, textTwo] = ["echo chaos-two-bridges-1", "echo chaos-two-bridges-2"];
    const tap = (rig: InvariantRig, text: string) => rig.handle({ text, mode: "send", fromPhone: true });
    const [a, b] = firstOne ? await Promise.all([tap(one, textOne), tap(two, textTwo)]) : (await Promise.all([tap(two, textTwo), tap(one, textOne)])).toReversed();
    const mixed = interleaved(pane.log, [textOne, textTwo]);
    if (mixed !== null) return mixed;
    for (const [answer, text] of [[a!, textOne], [b!, textTwo]] as const) {
      const writes = textWritesOf(pane.log, text);
      if (writes > 1) return `"${text}" was written ${String(writes)} times`;
      const outcome = answer.receipt?.outcome;
      // A request that wrote nothing has words: a refusal with its reason.
      if (writes === 0 && (outcome !== "refused" || answer.receipt?.reason === undefined)) return `"${text}" was not written and ended ${String(outcome)}`;
    }
    return null;
  }

  test("two phones, two bridges, one shell pane, the same moment: one whole line each or one refusal, never one garbled line", async () => {
    expect(await bothAtOnce({ kind: "bare" }, SHELL, true, 0)).toBeNull();
  });

  test("the second bridge gets the busy answer the second phone gets on one bridge, and the pane takes its line after the first one ends", async () => {
    const pane = new LogPane({ kind: "bare" });
    const clock = { now: 1_000_000 };
    const one = bridgeOn(pane, clock, 101, SHELL);
    const two = bridgeOn(pane, clock, 202, SHELL);
    const [a, b] = await Promise.all([one.handle({ text: "echo one", mode: "send", fromPhone: true }), two.handle({ text: "echo two", mode: "send", fromPhone: true })]);
    expect(a.receipt?.outcome).toBe("sent");
    expect(b.receipt?.outcome).toBe("refused");
    expect(b.receipt?.reason).toBe("busy");
    expect(b.receipt?.keys).toEqual([]);
    // The lock went with the first send's end: the second bridge's next tap goes.
    const again = await two.handle({ text: "echo two", mode: "send", fromPhone: true });
    expect(again.receipt?.outcome).toBe("sent");
    expect(interleaved(pane.log, ["echo one", "echo two"])).toBeNull();
  });

  for (const seed of runSeeds()) {
    test(`seed ${String(seed)}: a box or a shell, either bridge first, a slow multiplexer or none`, async () => {
      const rng = rngOf(seed);
      for (let round = 0; round < 6; round++) {
        const box = rng.chance(0.5);
        const firstOne = rng.chance(0.5);
        const delayMs = rng.int(4) * 40;
        rmSync(join(root, "locks"), { recursive: true, force: true });
        const broke = await bothAtOnce(box ? { kind: "box" } : { kind: "bare" }, box ? AGENT : SHELL, firstOne, delayMs);
        const name = `${box ? "box" : "shell"}-${firstOne ? "one" : "two"}-first-${String(delayMs)}ms`;
        expect(broke === null ? null : `${broke}; ${replayHint(seed, name)}`).toBeNull();
      }
    });
  }
});

describe("I6 across a crash between the text and Enter (M102 spec 16, chaos C1)", () => {
  /** Where the dying bridge stops: right after its text landed (before the submit mark), or at or after Enter. */
  type Stop = "after-text" | "at-enter" | "after-enter";

  /** A bridge (pid 101) that stops at `stop`, with the text written; then pid 101 is gone. */
  async function crashBeforeEnter(draw: PaneDraw, kind: Pick<RigOptions, "harness" | "pinVersions" | "version">, text: string, stop: Stop = "after-text"): Promise<{ pane: LogPane; clock: { now: number }; storeDir: string; id: string }> {
    const pane = new LogPane(draw);
    const clock = { now: 1_000_000 };
    const storeDir = join(root, "sends");
    const dying = bridgeOn(pane, clock, 101, kind, storeDir);
    const isEnter = (write: Write): boolean => write.kind === "keys" && write.value === "Enter";
    if (stop === "after-text") pane.stopAfter = (write) => write.kind !== "keys" && write.value.includes(text);
    if (stop === "at-enter") pane.stopAt = isEnter;
    if (stop === "after-enter") pane.stopAfter = isEnter;
    const id = nextId();
    void dying.handle({ id, text, mode: "send", fromPhone: true });
    await settleLoop(() => (stop === "after-text" ? textWritesOf(pane.log, text) > 0 : new RequestStore(storeDir, () => clock.now).get(id)?.submitSentAt !== undefined && (stop === "at-enter" || pane.log.some(isEnter))));
    expect(textWritesOf(pane.log, text)).toBe(1);
    // The process is killed: its pid is gone, its lock file stays, its run never ends.
    living.delete(101);
    pane.stopAt = null;
    pane.stopAfter = null;
    return { pane, clock, storeDir, id };
  }

  /** The new process's start: the store's recovery, then a protocol over the same store. */
  function restart(pane: LogPane, clock: { now: number }, storeDir: string, kind: Pick<RigOptions, "harness" | "pinVersions" | "version">): InvariantRig {
    new RequestStore(storeDir, () => clock.now).recover(SendProtocol.crashReceipt);
    return bridgeOn(pane, clock, 202, kind, storeDir);
  }

  test("the same id after the restart types nothing and answers unknown/interrupted with the rows now", async () => {
    const text = "echo chaos-bridge-dies-1";
    const { pane, clock, storeDir, id } = await crashBeforeEnter({ kind: "bare" }, SHELL, text);
    const fresh = restart(pane, clock, storeDir, SHELL);
    const from = pane.log.length;
    const answer = await fresh.handle({ id, text, mode: "send", fromPhone: true });
    expect(pane.log.slice(from)).toEqual([]);
    expect(answer.receipt?.outcome).toBe("unknown");
    expect(answer.receipt?.reason).toBe("interrupted");
    expect(answer.replayed).toBe(true);
    expect(answer.rowsHash).toBeString();
    expect(answer.rows?.some((row) => row.includes(text))).toBe(true);
  });

  test("a crash with no restart recovery yet (the replay settles it) answers interrupted too, and types nothing", async () => {
    const text = "echo chaos-bridge-dies-2";
    const { pane, clock, storeDir, id } = await crashBeforeEnter({ kind: "bare" }, SHELL, text);
    const fresh = bridgeOn(pane, clock, 202, SHELL, storeDir);
    const from = pane.log.length;
    const answer = await fresh.handle({ id, text, mode: "send", fromPhone: true });
    expect(pane.log.slice(from)).toEqual([]);
    expect(answer.receipt?.reason).toBe("interrupted");
  });

  for (const stop of ["at-enter", "after-enter"] as const) {
    test(`a crash ${stop === "at-enter" ? "as Enter was handed to the multiplexer" : "after Enter landed"} carries the submit mark: unknown/crash after the restart, nothing typed again`, async () => {
      const text = `echo chaos-${stop}`;
      const { pane, clock, storeDir, id } = await crashBeforeEnter({ kind: "bare" }, SHELL, text, stop);
      const fresh = restart(pane, clock, storeDir, SHELL);
      const from = pane.log.length;
      const answer = await fresh.handle({ id, text, mode: "send", fromPhone: true });
      expect(pane.log.slice(from)).toEqual([]);
      expect(answer.receipt?.outcome).toBe("unknown");
      expect(answer.receipt?.reason).toBe("crash");
    });

    test(`a crash ${stop} with no restart recovery yet (the replay settles it) answers crash too`, async () => {
      const text = `echo chaos-replay-${stop}`;
      const { pane, clock, storeDir, id } = await crashBeforeEnter({ kind: "bare" }, SHELL, text, stop);
      const fresh = bridgeOn(pane, clock, 202, SHELL, storeDir);
      const from = pane.log.length;
      const answer = await fresh.handle({ id, text, mode: "send", fromPhone: true });
      expect(pane.log.slice(from)).toEqual([]);
      expect(answer.receipt?.reason).toBe("crash");
    });
  }

  test("the dead bridge's pane lock is taken over: the new bridge's next send on that pane is not refused busy", async () => {
    const { pane, clock, storeDir } = await crashBeforeEnter({ kind: "bare" }, SHELL, "echo left-in-the-line");
    const fresh = restart(pane, clock, storeDir, SHELL);
    const answer = await fresh.handle({ text: "echo next", mode: "send", fromPhone: true });
    expect(answer.receipt?.reason).not.toBe("busy");
  });

  test("decision 6: a new send on a box that holds the interrupted text meets draft_present; nothing is appended and no Enter goes", async () => {
    const text = "please carry on with the parser fix";
    const { pane, clock, storeDir } = await crashBeforeEnter({ kind: "box" }, AGENT, text);
    expect(pane.box).toBe(text);
    const fresh = restart(pane, clock, storeDir, AGENT);
    const from = pane.log.length;
    const answer = await fresh.handle({ text: "a new message", mode: "send", fromPhone: true });
    expect(answer.receipt?.outcome).toBe("refused");
    expect(answer.receipt?.reason).toBe("draft_present");
    const writes = pane.log.slice(from);
    expect(writes.some((write) => write.kind !== "keys" && write.value.includes("a new message"))).toBe(false);
    expect(writes.some((write) => write.kind === "keys" && write.value === "Enter")).toBe(false);
    expect(pane.box).toBe(text);
  });

  test("the record on disk keeps no more text than before: the started mark is a time and nothing else", async () => {
    const text = "echo the-mark-adds-no-text";
    const { storeDir, id, clock } = await crashBeforeEnter({ kind: "bare" }, SHELL, text);
    const record = new RequestStore(storeDir, () => clock.now).get(id);
    expect(record?.startedAt).toBeNumber();
    expect(Object.keys(record ?? {}).toSorted()).toEqual(["acceptedAt", "id", "line", "mode", "paneGeneration", "paneId", "phase", "session", "startedAt", "surfaceRevision", "textHash", "textLength"]);
  });
});
