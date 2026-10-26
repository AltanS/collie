// Stop (M68 spec 01): `POST /api/pane/:id/abort` on a pane with a screen. A fake multiplexer shows real
// captures from the fixture corpus and flips them as keys arrive. Covered: each refusal, `stopped`,
// `pressed`, the replay rule (one id, one press), the audit line with no text, and the route's body checks.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog } from "../audit.ts";
import type { JsonValue } from "../../web/src/lib/json.ts";
import { muxAck, muxGone, muxOk, muxRefused, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { crewRouteFor } from "../crew/forward.ts";
import { stopRoute, type StopRouteRuntime } from "../server.ts";
import { loadProfiles, profileFor } from "../../web/src/lib/surface/profile.ts";
import type { StopReceipt } from "../../web/src/lib/surface/stop.ts";
import { KeyGate } from "./key-gate.ts";
import { StopService } from "./stop.ts";

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const fx = (name: string): string => readFileSync(join(FIXTURES, name), "utf8");

const PI_RUNNING = fx("pi--omo-v5130-plain-running.txt");
const PI_IDLE = fx("pi--omo-v5130-plain-idle.txt");
const OMP_APPROVAL = fx("omp--approval-bash.txt");
const GROK_RUNNING = fx("grok--working.txt");
/** Grok mid-turn with words typed into the box: the working capture, its empty box row filled. */
const GROK_RUNNING_DRAFT = GROK_RUNNING.replace(/│ ❯ {2}/u, "│ ❯ half a thought");
const NOT_A_SCREEN = "just some words\non a plain screen\n";

/** A pane that shows one capture at a time and swaps it as keys arrive. */
class ScriptPane {
  keysSeen: string[][] = [];
  reads = 0;
  /** What a press does to the screen. The default does nothing: a turn that ignores the key. */
  onKeys: (keys: readonly string[], pane: ScriptPane) => void = () => undefined;
  refuseKeys = false;
  unreadable = false;

  constructor(public screen: string) {}

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    if (this.unreadable) return Promise.resolve(muxGone("gone"));
    return Promise.resolve(muxOk({ paneId, text: this.screen, truncated: false, revision: 0 }));
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    if (this.refuseKeys) return Promise.resolve(muxRefused("refused"));
    this.keysSeen.push([...keys]);
    this.onKeys(keys, this);
    return Promise.resolve(muxAck());
  };
}

interface Rig {
  readonly pane: ScriptPane;
  readonly rt: StopRouteRuntime;
  readonly lines: string[];
  readonly sleeps: number[];
  readonly pokes: () => number;
  readonly stop: (paneId: string, body: JsonValue | undefined) => Promise<Response>;
}

/** Panes: %1 pi, %2 omp, %3 grok, %4 an agent with no profile, %7 a bare shell. */
function rig(screen: string, told: string[] = []): Rig {
  const pane = new ScriptPane(screen);
  const sleeps: number[] = [];
  const service = new StopService({
    mux: pane,
    gate: new KeyGate(pane),
    profile: (harness) => Promise.resolve(profileFor(harness, "99.0.0", { log: () => undefined })),
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    stopped: (paneId) => void told.push(paneId),
  });
  let pokes = 0;
  const engine = {
    current: () => ({
      agents: [
        { paneId: "%1", agent: "pi" },
        { paneId: "%2", agent: "omp" },
        { paneId: "%3", agent: "grok" },
        { paneId: "%4", agent: "an-agent-collie-cannot-read" },
      ],
      shellPanes: [{ paneId: "%7" }],
    }),
    noteInput: () => undefined,
    pokeNow: () => {
      pokes++;
    },
  };
  const rt: StopRouteRuntime = { stop: service, engine };
  const lines: string[] = [];
  const audit = new AuditLog((line) => void lines.push(line));
  return {
    pane,
    rt,
    lines,
    sleeps,
    pokes: () => pokes,
    stop: (paneId, body) => stopRoute(rt, paneId, body, { audit, device: "phone", session: "main", acceptEncoding: null }),
  };
}

async function receipt(res: Response): Promise<StopReceipt> {
  expect(res.status).toBe(200);
  // SAFETY: the route answers a StopReceipt as JSON; the tests below compare every field they read.
  return (await res.json()) as StopReceipt;
}

const ID = "stop-req-0001";

describe("a Stop on a pane with a screen", () => {
  test("the turn ends after the press: `stopped`, the profile's own key, one press", async () => {
    const { pane, stop, sleeps, lines, pokes } = rig(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = PI_IDLE);
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "stopped", keys: ["Escape"] });
    expect(pane.keysSeen).toEqual([["Escape"]]);
    // The turn is gone at the first look (0.4 s) and still gone at the second (1.4 s): two in a row.
    expect(sleeps).toEqual([400, 1000]);
    expect(lines).toHaveLength(1);
    expect(pokes()).toBe(1);
  });

  test("the turn still runs after three looks: `pressed`, all inside 3 s", async () => {
    const { pane, stop, sleeps } = rig(PI_RUNNING);
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "pressed", keys: ["Escape"] });
    expect(pane.keysSeen).toEqual([["Escape"]]);
    expect(sleeps).toEqual([400, 1000, 1000]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000);
  });

  test("the turn ends on the second look and stays ended on the third: `stopped`", async () => {
    const { pane, stop, sleeps } = rig(PI_RUNNING);
    let reads = 0;
    pane.onKeys = (_keys, p) => {
      reads = p.reads;
    };
    const base = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      if (pane.reads >= reads + 1 && reads > 0) pane.screen = PI_IDLE;
      return base(paneId, request);
    };
    expect((await receipt(await stop("%1", { requestId: ID }))).outcome).toBe("stopped");
    expect(sleeps).toEqual([400, 1000, 1000]);
  });

  // One idle read may be a redraw between two tool calls: `stopped` needs two in a row.
  for (const [idleAt, name] of [
    [0, "0.4 s"],
    [1, "1.4 s"],
    [2, "2.4 s"],
  ] as const) {
    test(`one idle read alone, at ${name}, is \`pressed\`, never \`stopped\``, async () => {
      const { pane, stop, sleeps } = rig(PI_RUNNING);
      let pressedAt = -1;
      pane.onKeys = (_keys, p) => void (pressedAt = p.reads);
      const base = pane.readGrid;
      pane.readGrid = (paneId, request) => {
        if (pressedAt >= 0) pane.screen = pane.reads - pressedAt === idleAt ? PI_IDLE : PI_RUNNING;
        return base(paneId, request);
      };
      expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "pressed", keys: ["Escape"] });
      expect(sleeps).toEqual([400, 1000, 1000]);
    });
  }

  test("a dialog opens instead of the turn ending: `pressed`, never `stopped`", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = OMP_APPROVAL);
    expect((await receipt(await stop("%1", { requestId: ID }))).outcome).toBe("pressed");
  });

  test("a dialog the key opened: still `pressed`, with reason dialog_open so the phone points at the card", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = OMP_APPROVAL);
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "pressed", reason: "dialog_open", keys: ["Escape"] });
  });

  test("a turn that ignores the key carries no reason", async () => {
    const { stop } = rig(PI_RUNNING);
    expect((await receipt(await stop("%1", { requestId: ID }))).reason).toBeUndefined();
  });

  test("refused no_profile: a bare shell, an agent Collie has no profile for, and no key leaves", async () => {
    for (const paneId of ["%7", "%4"]) {
      const { pane, stop } = rig(PI_RUNNING);
      expect(await receipt(await stop(paneId, { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "no_profile" });
      expect(pane.keysSeen).toEqual([]);
      expect(pane.reads).toBe(0);
    }
  });

  test("refused turn_idle: a stale tap after the turn ended is a no-op with a receipt", async () => {
    const { pane, stop } = rig(PI_IDLE);
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "turn_idle" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("refused dialog_open: Escape would answer an approval dialog, so it is not pressed", async () => {
    const { pane, stop } = rig(OMP_APPROVAL);
    expect(await receipt(await stop("%2", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "dialog_open" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("refused draft_present: the box holds text and this harness's interrupt key clears it first", async () => {
    expect(loadProfiles().get("grok")?.keys.interruptClearsDraft).toBe(true);
    const { pane, stop, lines } = rig(GROK_RUNNING_DRAFT);
    expect(await receipt(await stop("%3", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "draft_present" });
    expect(pane.keysSeen).toEqual([]);
    // The audit line names the reason, and carries no screen or message text.
    expect(lines[0]).toContain('"reason":"draft_present"');
    expect(lines[0]).not.toContain("half a thought");
  });

  test("the same Grok turn with an empty box is pressed", async () => {
    const { pane, stop } = rig(GROK_RUNNING);
    expect((await receipt(await stop("%3", { requestId: ID }))).outcome).toBe("pressed");
    // Grok's vendor doc: "Esc never cancels the turn", so its interrupt key is Ctrl+C.
    expect(pane.keysSeen).toEqual([["ctrl+c"]]);
  });

  test("refused unreadable: a screen with no box is not stopped blind", async () => {
    const { pane, stop } = rig(NOT_A_SCREEN);
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "unreadable" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("re-read before the key: a dialog on the second read is refused dialog_open, and no key leaves", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    const base = pane.readGrid;
    pane.readGrid = (paneId, request) => {
      // The first read shows the running turn; a dialog draws before the read right before the press.
      if (pane.reads === 1) pane.screen = OMP_APPROVAL;
      return base(paneId, request);
    };
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "dialog_open" });
    expect(pane.keysSeen).toEqual([]);
    expect(pane.reads).toBe(2);
  });

  test("re-read before the key: the turn ended by the second read is refused turn_idle; a screen it cannot read, unreadable", async () => {
    for (const [screen, reason] of [
      [PI_IDLE, "turn_idle"],
      [NOT_A_SCREEN, "unreadable"],
    ] as const) {
      const { pane, stop } = rig(PI_RUNNING);
      const base = pane.readGrid;
      pane.readGrid = (paneId, request) => {
        if (pane.reads === 1) pane.screen = screen;
        return base(paneId, request);
      };
      expect(await receipt(await stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason });
      expect(pane.keysSeen).toEqual([]);
    }
  });

  test("refused pane_gone and press_failed", async () => {
    const gone = rig(PI_RUNNING);
    gone.pane.unreadable = true;
    expect(await receipt(await gone.stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "pane_gone" });
    const refused = rig(PI_RUNNING);
    refused.pane.refuseKeys = true;
    expect(await receipt(await refused.stop("%1", { requestId: ID }))).toEqual({ requestId: ID, outcome: "refused", reason: "press_failed" });
  });
});

describe("the replay rule", () => {
  test("the same request id twice answers the same receipt and presses once", async () => {
    const { pane, stop, lines, pokes } = rig(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = PI_IDLE);
    const first = await receipt(await stop("%1", { requestId: ID }));
    // The pane reads idle now, so a second run would refuse turn_idle; the stored receipt answers instead.
    const second = await receipt(await stop("%1", { requestId: ID }));
    expect(second).toEqual(first);
    expect(second.outcome).toBe("stopped");
    expect(pane.keysSeen).toEqual([["Escape"]]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"replayed":true');
    expect(pokes()).toBe(1);
  });

  test("two taps at once with one id press once", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    const [a, b] = await Promise.all([stop("%1", { requestId: ID }), stop("%1", { requestId: ID })]);
    expect(await receipt(a)).toEqual(await receipt(b));
    expect(pane.keysSeen).toEqual([["Escape"]]);
  });

  test("a refusal is replayed as it was", async () => {
    const { pane, stop } = rig(PI_IDLE);
    const first = await receipt(await stop("%1", { requestId: ID }));
    pane.screen = PI_RUNNING;
    expect(await receipt(await stop("%1", { requestId: ID }))).toEqual(first);
    expect(pane.keysSeen).toEqual([]);
    // A new id is a new tap.
    expect((await receipt(await stop("%1", { requestId: "stop-req-0002" }))).outcome).toBe("pressed");
  });

  test("a request id used on another pane is a 409 and presses nothing", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    await stop("%1", { requestId: ID });
    const other = await stop("%3", { requestId: ID });
    expect(other.status).toBe(409);
    expect(pane.keysSeen).toHaveLength(1);
  });
});

// Second live pass (2026-10-23): Claude Code fires no Stop hook on Escape, so the prompt edge's running
// block outlived Collie's own `stopped` receipt by 11 s, and by 20 s and more when Escape came before the
// first token and the prompt went back into the box. The receipt is told to the pane's fold.
describe("a stopped receipt is told to the fold", () => {
  test("once per `stopped`, with the pane; never on `pressed`, a refusal or a replay", async () => {
    const told: string[] = [];
    const { pane, stop } = rig(PI_RUNNING, told);
    pane.onKeys = (_keys, p) => void (p.screen = PI_IDLE);
    expect((await receipt(await stop("%1", { requestId: ID }))).outcome).toBe("stopped");
    expect(told).toEqual(["%1"]);
    expect((await receipt(await stop("%1", { requestId: ID }))).outcome).toBe("stopped");
    expect(told).toEqual(["%1"]);
    // Idle now: a new tap is refused turn_idle, and nothing is told.
    expect((await receipt(await stop("%1", { requestId: "stop-req-0002" }))).reason).toBe("turn_idle");
    const still: string[] = [];
    const running = rig(PI_RUNNING, still);
    expect((await receipt(await running.stop("%1", { requestId: ID }))).outcome).toBe("pressed");
    expect(still).toEqual([]);
    expect(told).toEqual(["%1"]);
  });

  test("a hook that throws leaves the receipt `stopped`", async () => {
    const pane = new ScriptPane(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = PI_IDLE);
    const service = new StopService({
      mux: pane,
      gate: new KeyGate(pane),
      profile: (harness) => Promise.resolve(profileFor(harness, "99.0.0", { log: () => undefined })),
      sleep: () => Promise.resolve(),
      stopped: () => {
        throw new Error("the fold is gone");
      },
    });
    const answer = await service.handle(ID, "%1", "pi");
    expect(answer.kind === "receipt" && answer.receipt.outcome).toBe("stopped");
  });
});

describe("a queued message the Stop gives back to the box (ADR 0122)", () => {
  // Tester 03's case 0 on OMP 18.6.1: `second message` waits under `After yield · 1`, Escape ends the
  // turn and OMP moves the text back into its box (web/src/fixtures/panes/README.md).
  const OMP_QUEUED = fx("omp--v18-6-1-queued-before-stop--w119.txt");
  const OMP_RETURNED = fx("omp--v18-6-1-stop-returned--w119.txt");

  function queuedRig(returned: (paneId: string, read: { readonly box: string | null; readonly at: number; readonly turn: string }) => readonly string[]) {
    const pane = new ScriptPane(OMP_QUEUED);
    const service = new StopService({
      mux: pane,
      gate: new KeyGate(pane),
      profile: (harness) => Promise.resolve(profileFor(harness, "18.6.1", { log: () => undefined })),
      sleep: () => Promise.resolve(),
      now: () => 5_000,
      returned,
    });
    pane.onKeys = (_keys, p) => void (p.screen = OMP_RETURNED);
    return { pane, service };
  }

  test("each read-back's box goes to the Send Protocol, and what it says came back rides the receipt", async () => {
    const boxes: (string | null)[] = [];
    const { service } = queuedRig((paneId, read) => {
      expect(paneId).toBe("%2");
      expect(read.at).toBe(5_000);
      // The turn the read-back showed goes along: the Send Protocol keeps a running turn's cards alive.
      expect(read.turn).toBe("idle");
      boxes.push(read.box);
      return read.box === "second message" ? ["queued-0001"] : [];
    });
    const answer = await service.handle(ID, "%2", "omp");
    expect(answer).toEqual({ kind: "receipt", replayed: false, receipt: { requestId: ID, outcome: "stopped", keys: ["Escape"], returned: ["queued-0001"] } });
    // The two reads before the key are not handed over: only what the key left on screen counts.
    expect(boxes).toEqual(["second message", "second message"]);
  });

  test("nothing back in the box: the receipt carries no `returned`, as before", async () => {
    const { service } = queuedRig(() => []);
    const answer = await service.handle(ID, "%2", "omp");
    expect(answer).toEqual({ kind: "receipt", replayed: false, receipt: { requestId: ID, outcome: "stopped", keys: ["Escape"] } });
  });

  test("a Send Protocol that throws leaves the receipt as it was", async () => {
    const { service } = queuedRig(() => {
      throw new Error("the store is gone");
    });
    const answer = await service.handle(ID, "%2", "omp");
    expect(answer).toMatchObject({ receipt: { outcome: "stopped" } });
    expect(answer.kind === "receipt" && "returned" in answer.receipt).toBe(false);
  });
});

describe("a Stop on omp's running local shell line (omp-gang three, tester 5, W3)", () => {
  // `!sleep 25` runs in omp's own bash block: `⠋ Running… (⎋ to cancel)`, no model turn. The profile did not name the
  // row, the Surface read the turn idle and the Stop was refused `turn_idle` for a command only Escape ends.
  const SURFACE = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "surface");
  const sfx = (name: string): string => readFileSync(join(SURFACE, name), "utf8");
  const SCREENS = [
    ["18.6.1", "omp--v18-6-1-local-bash-running--w120.txt"],
    ["18.12.6", "omp--v18-12-6-local-bash-running--w120.txt"],
  ] as const;
  /** The screen once Escape ended the command: the Running block's rows gone. */
  const ended = (screen: string): string => screen.split("\n").filter((row) => !row.includes("Running…") && !row.includes("$ sleep")).join("\n");

  for (const [version, name] of SCREENS) {
    test(`${version}: the Stop presses Escape, the key the row names, and the command ending is \`stopped\``, async () => {
      const screen = sfx(name);
      const pane = new ScriptPane(screen);
      pane.onKeys = (_keys, p) => void (p.screen = ended(screen));
      const service = new StopService({
        mux: pane,
        gate: new KeyGate(pane),
        profile: (harness) => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
        sleep: () => Promise.resolve(),
      });
      const answer = await service.handle(ID, "%2", "omp");
      expect(answer).toEqual({ kind: "receipt", replayed: false, receipt: { requestId: ID, outcome: "stopped", keys: ["Escape"] } });
      expect(pane.keysSeen).toEqual([["Escape"]]);
    });

    test(`${version}: a command that ignores the key ends \`pressed\`, one press, as a model turn does`, async () => {
      const pane = new ScriptPane(sfx(name));
      const service = new StopService({
        mux: pane,
        gate: new KeyGate(pane),
        profile: (harness) => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
        sleep: () => Promise.resolve(),
      });
      const answer = await service.handle(ID, "%2", "omp");
      expect(answer).toEqual({ kind: "receipt", replayed: false, receipt: { requestId: ID, outcome: "pressed", keys: ["Escape"] } });
      expect(pane.keysSeen).toEqual([["Escape"]]);
    });

    test(`${version}: with the Running row gone the pane reads idle and the Stop is refused turn_idle, nothing pressed`, async () => {
      const pane = new ScriptPane(ended(sfx(name)));
      const service = new StopService({
        mux: pane,
        gate: new KeyGate(pane),
        profile: (harness) => Promise.resolve(profileFor(harness, version, { log: () => undefined })),
        sleep: () => Promise.resolve(),
      });
      const answer = await service.handle(ID, "%2", "omp");
      expect(answer).toEqual({ kind: "receipt", replayed: false, receipt: { requestId: ID, outcome: "refused", reason: "turn_idle" } });
      expect(pane.keysSeen).toEqual([]);
    });
  }
});

describe("the route's body", () => {
  test("no request id, a bad one, or a body that is no object is a 400; a pane the engine lacks is a 404", async () => {
    const { pane, stop } = rig(PI_RUNNING);
    for (const body of [undefined, null, "x", [], {}, { requestId: 5 }, { requestId: "short" }, { requestId: "../../etc/passwd-x" }]) {
      expect((await stop("%1", body)).status).toBe(400);
    }
    const missing = await stop("%9", { requestId: ID });
    expect(missing.status).toBe(404);
    // The Stop's own receipt, so the phone tells a gone pane from a build with no Stop (unsupported_build).
    expect(await missing.json()).toEqual({ requestId: ID, outcome: "refused", reason: "pane_gone" });
    expect(pane.keysSeen).toEqual([]);
  });

  test("with no Stop service on the runtime the route says so, and presses nothing", async () => {
    const { rt } = rig(PI_RUNNING);
    const res = await stopRoute({ engine: rt.engine }, "%1", { requestId: ID }, { audit: new AuditLog(() => undefined), device: null, session: "main", acceptEncoding: null });
    expect(res.status).toBe(404);
  });

  test("the audit line names the request id, the pane, the keys and the outcome, and no text", async () => {
    const { pane, stop, lines } = rig(PI_RUNNING);
    pane.onKeys = (_keys, p) => void (p.screen = PI_IDLE);
    await stop("%1", { requestId: ID, text: "should never be recorded" });
    expect(lines).toHaveLength(1);
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({ action: "abort", paneId: "%1", session: "main", device: "phone", detail: { requestId: ID, outcome: "stopped", keys: ["Escape"] } });
    expect(lines[0]).not.toContain("should never be recorded");
  });
});

describe("across a crew link", () => {
  test("the abort route crosses to the member that owns the pane, which runs the press and answers the receipt", () => {
    // The Stop branch sits in the pane block the browser route and the crew dispatch share, so a member
    // runs it against its own panes and its own receipts, and the lead relays the answer as it is.
    expect(crewRouteFor("/api/pane/%251/abort")).toBe("pane/%251/abort");
    const src = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8");
    const branch = src.indexOf('action === "abort" && req.method === "POST" && rt.stop !== undefined');
    expect(branch).toBeGreaterThan(0);
    // Before the crew handler is built: the same code serves the lead's own panes and a member's.
    expect(branch).toBeLessThan(src.indexOf("const crewHandler = opts.crewRouter?.("));
  });
});
