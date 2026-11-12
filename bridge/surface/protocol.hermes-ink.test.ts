// Hermes's Ink TUI (`hermes --tui`) on the screen path is a confirm tap at best: the classic CLI's
// profile reads it only in part, a running turn refuses, and the probe is typed into the box (ADR 0140).
// Once its door binds (ADR 0141, ADR 0142), a plain message goes through Hermes's gateway before the
// screen is read, so none of that applies: no read, no key, no probe. A door that refuses or is absent
// leaves the Ink pane's screen path exactly as it was (SPEC V8, V25). The panes are the captured Ink
// screens of Hermes v0.23.0, held still, so the screen path's probe never shows and its send refuses.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorRegistry, type Door, type DoorAnswer, type DoorSend, type Preflight } from "../door/door.ts";
import { muxAck, muxOk, type MuxAck, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "../mux/types.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { SendAnswer } from "../../web/src/lib/surface/send.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks, type SendRequest } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

const PANES = join(import.meta.dir, "..", "..", "web", "src", "fixtures", "panes");
const ink = (name: string): string => readFileSync(join(PANES, `hermes--tui-${name}.txt`), "utf8");

/** An Ink screen that never changes: what is typed is recorded, never drawn. */
class StillPane {
  reads = 0;
  typed = "";
  keysSeen: string[] = [];
  constructor(private readonly text: string) {}

  readGrid = (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
    void request;
    this.reads++;
    return Promise.resolve(muxOk({ paneId, text: this.text, truncated: false, revision: this.reads }));
  };

  typeText = (paneId: string, text: string): Promise<MuxAck> => {
    void paneId;
    this.typed += text;
    return Promise.resolve(muxAck());
  };

  writeKeys = (paneId: string, keys: readonly string[]): Promise<MuxAck> => {
    void paneId;
    this.keysSeen.push(...keys);
    return Promise.resolve(muxAck());
  };
}

/** Hermes's door as the registry keys it, its binding and its gateway's word as told. */
class HermesDoor implements Door {
  readonly id = "hermes";
  submits: DoorSend[] = [];
  constructor(
    private readonly bind: () => Promise<Preflight>,
    private readonly answer: DoorAnswer = { kind: "taken" },
  ) {}
  preflight = (): Promise<Preflight> => this.bind();
  submitted(send: DoorSend): Promise<DoorAnswer> {
    this.submits.push(send);
    return Promise.resolve(this.answer);
  }
}

const bound = (answer?: DoorAnswer): HermesDoor => {
  const door: HermesDoor = new HermesDoor(() => Promise.resolve({ ok: true, door: { submit: (send) => door.submitted(send) } }), answer);
  return door;
};
const unbound = (): HermesDoor => new HermesDoor(() => Promise.resolve({ ok: false, why: "Which Hermes session is this pane showing? Nothing was sent." }));
const noGateway = (): HermesDoor => new HermesDoor(() => Promise.resolve({ ok: false, why: "no Hermes gateway is running", absent: true }));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-ink-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

let ids = 0;
const nextId = (): string => `ink_case${String(++ids).padStart(4, "0")}-72207d22`;

function rig(screen: string, door: HermesDoor | null) {
  const pane = new StillPane(ink(screen));
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const protocol = new SendProtocol({
    mux: { readGrid: pane.readGrid, typeText: pane.typeText },
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks: new SessionLocks(),
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "0.23.0", { log: () => undefined })),
    generation: () => "gen-1",
    doors: doorRegistry(door === null ? [] : [door]),
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  const send = (text: string, over: Partial<SendRequest> = {}): Promise<SendAnswer> =>
    protocol.handle({ id: nextId(), text, mode: "send", fromPhone: true, ...over }, { session: "main", paneId: "%1", harness: "hermes" });
  return { pane, protocol, send };
}

/** Ink's captured idle box (its hint), a draft under a titled status row, and a running turn. */
const SCREENS = [
  { screen: "idle-hint", word: "taken" },
  { screen: "draft-title", word: "taken" },
  { screen: "busy-title", word: "queued" },
] as const;

describe("an Ink pane whose door binds sends through the gateway, never by the screen", () => {
  for (const { screen, word } of SCREENS) {
    test(`${screen}: no read, no probe, no key, no confirm tap; \`via\` hermes and a card`, async () => {
      const door = bound({ kind: word });
      const { pane, protocol, send } = rig(screen, door);
      const answer = await send("hello from the phone");
      expect(answer.receipt).toMatchObject({ outcome: "sent", queued: true, via: "hermes", door: word, keys: [] });
      expect(answer.receipt?.doorRefused).toBeUndefined();
      expect(answer.offers ?? []).not.toContain("commit");
      expect(door.submits).toEqual([{ requestId: answer.receipt!.requestId, text: "hello from the phone" }]);
      expect(pane.reads).toBe(0);
      expect(pane.typed).toBe("");
      expect(pane.keysSeen).toEqual([]);
      expect(protocol.queuedOf("main", "%1").map((card) => card.requestId)).toEqual([answer.receipt!.requestId]);
    });
  }

  test("a multi-line message goes whole, as one turn: the gateway takes text, not keys", async () => {
    const door = bound();
    const { pane, send } = rig("idle-hint", door);
    const answer = await send("first line\nsecond line");
    expect(answer.receipt).toMatchObject({ outcome: "sent", via: "hermes" });
    expect(door.submits.map((s) => s.text)).toEqual(["first line\nsecond line"]);
    expect(pane.keysSeen).toEqual([]);
  });

  test("the confirm tap of an earlier screen refusal asks the door first too: a door types no key, so the rows seen do not matter", async () => {
    const door = bound();
    const { pane, send } = rig("draft-title", door);
    const answer = await send("hello", { rowsHash: "0f00ba0f00ba" });
    expect(answer.receipt).toMatchObject({ outcome: "sent", via: "hermes" });
    expect(door.submits).toHaveLength(1);
    expect(pane.reads).toBe(0);
    expect(pane.typed).toBe("");
  });
});

describe("an Ink pane whose door does not bind keeps its screen path", () => {
  for (const { screen } of SCREENS) {
    test(`${screen}: refused before submit, the screen is read and the receipt says the door refused`, async () => {
      const door = unbound();
      const { pane, send } = rig(screen, door);
      const answer = await send("hello from the phone");
      expect(answer.receipt).toMatchObject({ outcome: "refused", via: "screen", doorRefused: true });
      expect(answer.receipt?.door).toBeUndefined();
      expect(door.submits).toEqual([]);
      expect(pane.reads).toBeGreaterThan(0);
      expect(pane.keysSeen).not.toContain("Enter");
    });

    test(`${screen}: no gateway at all is no door, and the receipt names none (SPEC V25)`, async () => {
      const door = noGateway();
      const { pane, send } = rig(screen, door);
      const answer = await send("hello from the phone");
      expect(answer.receipt).toMatchObject({ outcome: "refused", via: "screen" });
      expect(answer.receipt?.doorRefused).toBeUndefined();
      expect(answer.receipt?.door).toBeUndefined();
      expect(pane.reads).toBeGreaterThan(0);
      expect(pane.keysSeen).not.toContain("Enter");
    });
  }

  test("a running turn still refuses on the screen path, as before doors", async () => {
    const { send } = rig("busy-title", unbound());
    const answer = await send("hello");
    expect(answer.receipt).toMatchObject({ outcome: "refused", reason: "turn_running", doorRefused: true });
  });
});
