// A held row that ended `typed_not_submitted` goes once the box reads empty (issue 739, opencode 2.2.6 on
// Herdr 0.9.5, a crew member's pane). The Model button sent `/models` while the agent worked: the send
// was held, released after the turn, and ended `typed_not_submitted(mismatch)`. The card said "Typed, not
// sent. The text is still in the box." over an empty box, with no buttons on a member's pane, and stayed
// through the turn's end, an app reopen and bridge restarts: nothing but the hour ever retired it.
//
// The reads are the real opencode captures (`web/src/fixtures/panes/oc--*`), folded with the opencode
// profile the way the bridge's shadow reads a live pane (`SurfaceShadow.boxOf`: a placeholder is "").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { muxAck, muxOk } from "../mux/types.ts";
import { agentOf, fixtureRows, idleFor, readScreen } from "../../web/src/test/surface-corpus.ts";
import { profileFor } from "../../web/src/lib/surface/profile.ts";
import type { Surface } from "../../web/src/lib/surface/surface.ts";
import { HoldStore } from "./holds.ts";
import { KeyGate } from "./key-gate.ts";
import { RowRing, SendProtocol, SessionLocks } from "./protocol.ts";
import { RequestStore } from "./requests.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "collie-typed-rows-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** One poll's read of a capture, as `SurfaceShadow.boxOf` and `surfaceOf` hand it to the tick. */
interface Read {
  readonly box: string | null;
  readonly surface: Surface;
}

function readOf(name: string, harness = "opencode"): Read {
  const got = readScreen(fixtureRows(name), agentOf(harness), idleFor(harness));
  const frame = got.frame ?? null;
  return { box: frame === null ? null : frame.placeholder ? "" : frame.interior.text, surface: got.surface };
}

const IDLE_EMPTY = readOf("oc--done--tool-run.txt");
const PLACEHOLDER = readOf("oc--fresh-idle.txt");
const RUNNING_EMPTY = readOf("oc--working.txt");
const DRAFT = readOf("oc--draft-single.txt");
const DIALOG = readOf("oc--permission-bash.txt");
const PICKER = readOf("oc--agents-picker.txt");

function rig(heldDir = join(dir, "held")) {
  const clock = { now: 1_000_000 };
  const now = (): number => clock.now;
  const holds = new HoldStore(heldDir, now);
  const locks = new SessionLocks();
  const pane = {
    readGrid: (paneId: string) => Promise.resolve(muxOk({ paneId, text: "", truncated: false, revision: 1 })),
    typeText: () => Promise.resolve(muxAck()),
    pasteText: () => Promise.resolve(muxAck()),
    writeKeys: () => Promise.resolve(muxAck()),
  };
  const protocol = new SendProtocol({
    mux: pane,
    gate: new KeyGate(pane, now),
    store: new RequestStore(join(dir, "sends"), now),
    locks,
    ring: new RowRing(),
    profile: (harness: string) => Promise.resolve(profileFor(harness, "2.2.6", { log: () => undefined })),
    generation: () => "opencode:s1",
    holds,
    now,
    sleep: (ms: number) => {
      clock.now += ms;
      return Promise.resolve();
    },
  });
  /** One poll: the clock moves on, the read is taken now, the tick runs. Returns the ids that went. */
  const poll = (read: Read): string[] => {
    clock.now += 1000;
    const at = clock.now;
    return protocol.tickTyped("main", () => ({ box: read.box, at }), () => read.surface);
  };
  return { holds, clock, protocol, locks, poll };
}

/** The field case's row: `/models` held during the turn, released, ended `typed_not_submitted(mismatch)`. */
function typedRow(holds: HoldStore, id = "req-739-0000001"): string {
  holds.add({ id, session: "main", paneId: "%1", harness: "opencode", mode: "send", text: "/models", revision: 1, command: true });
  holds.end(id, "typed_not_submitted", "mismatch");
  return id;
}

describe("the captures read as the rule expects", () => {
  test("an empty box, idle, after a turn, and under the placeholder, and while a turn runs", () => {
    expect(IDLE_EMPTY).toMatchObject({ box: "", surface: { turn: "idle", modal: "none", composer: "empty" } });
    expect(PLACEHOLDER).toMatchObject({ box: "", surface: { modal: "none", composer: "empty" } });
    expect(RUNNING_EMPTY).toMatchObject({ box: "", surface: { turn: "running", modal: "none", composer: "empty" } });
  });

  test("a draft, a permission dialog, and a picker over an empty box", () => {
    expect(DRAFT.box).toBe("hello from the fixture corpus");
    expect(DIALOG.box).toBeNull();
    expect(PICKER.box).toBe("");
    expect(PICKER.surface.modal).not.toBe("none");
  });
});

describe("a held row that ended typed_not_submitted, over opencode's empty box (#739)", () => {
  test("the hold tick alone never retires it: the field case, before the fix", async () => {
    const r = rig();
    const id = typedRow(r.holds);
    for (let i = 0; i < 5; i++) await Promise.all(r.protocol.tickHolds("main", () => IDLE_EMPTY.surface, () => IDLE_EMPTY.box));
    expect(r.holds.get(id)?.state).toBe("ended");
  });

  test("two polls of the empty box after a turn: the row goes, nothing pressed", () => {
    const r = rig();
    const id = typedRow(r.holds);
    expect(r.poll(IDLE_EMPTY)).toEqual([]);
    expect(r.holds.get(id)).not.toBeNull();
    expect(r.poll(IDLE_EMPTY)).toEqual([id]);
    expect(r.holds.get(id)).toBeNull();
    expect(r.holds.list()).toEqual([]);
  });

  test("the placeholder, and an empty box while a turn runs, read as empty too", () => {
    for (const read of [PLACEHOLDER, RUNNING_EMPTY]) {
      const r = rig(join(dir, `held-${String(read.surface.turn)}-${String(read.box)}`));
      const id = typedRow(r.holds);
      r.poll(read);
      expect(r.poll(read)).toEqual([id]);
    }
  });

  test("a draft in the box between two empty reads starts the count again", () => {
    const r = rig();
    const id = typedRow(r.holds);
    r.poll(IDLE_EMPTY);
    r.poll(DRAFT);
    expect(r.poll(IDLE_EMPTY)).toEqual([]);
    expect(r.poll(IDLE_EMPTY)).toEqual([id]);
  });

  test("a box that holds text, a dialog with no box, and a picker over an empty box keep the row", () => {
    for (const read of [DRAFT, DIALOG, PICKER]) {
      const r = rig(join(dir, `held-${String(read.box)}-${JSON.stringify(read.surface.modal).length}`));
      const id = typedRow(r.holds);
      for (let i = 0; i < 4; i++) expect(r.poll(read)).toEqual([]);
      expect(r.holds.get(id)?.state).toBe("ended");
    }
  });

  test("a read taken before the row ended, and one read handed twice, are not counted", () => {
    const r = rig();
    const id = typedRow(r.holds);
    const before = r.clock.now - 1;
    expect(r.protocol.tickTyped("main", () => ({ box: "", at: before }), () => IDLE_EMPTY.surface)).toEqual([]);
    r.clock.now += 1000;
    const once = r.clock.now;
    expect(r.protocol.tickTyped("main", () => ({ box: "", at: once }), () => IDLE_EMPTY.surface)).toEqual([]);
    expect(r.protocol.tickTyped("main", () => ({ box: "", at: once }), () => IDLE_EMPTY.surface)).toEqual([]);
    expect(r.holds.get(id)).not.toBeNull();
    expect(r.poll(IDLE_EMPTY)).toEqual([id]);
  });

  test("while a send runs on the pane its box is that send's: no read counts", () => {
    const r = rig();
    const id = typedRow(r.holds);
    expect(r.locks.acquire("main\u0000%1", "req-other", r.clock.now + 60_000, r.clock.now)).toBe(true);
    for (let i = 0; i < 3; i++) expect(r.poll(IDLE_EMPTY)).toEqual([]);
    expect(r.holds.get(id)).not.toBeNull();
  });

  test("a restart reads the row back from disk, and the first two polls retire it", () => {
    const first = rig();
    const id = typedRow(first.holds);
    const again = rig();
    expect(again.holds.get(id)?.outcome).toBe("typed_not_submitted");
    again.clock.now = first.clock.now + 60_000;
    again.poll(IDLE_EMPTY);
    expect(again.poll(IDLE_EMPTY)).toEqual([id]);
    expect(rig().holds.get(id)).toBeNull();
  });

  test("a row that ended another way is left to its own exits", () => {
    const r = rig();
    r.holds.add({ id: "req-739-0000002", session: "main", paneId: "%1", harness: "opencode", mode: "send", text: "late", revision: 1, command: false });
    r.holds.end("req-739-0000002", "expired");
    r.poll(IDLE_EMPTY);
    expect(r.poll(IDLE_EMPTY)).toEqual([]);
    expect(r.holds.get("req-739-0000002")?.outcome).toBe("expired");
  });
});

describe("the rule names no harness: a Claude Code box reads empty the same way", () => {
  test("two polls of claude--fresh-idle retire a typed row", () => {
    const read = readOf("claude--fresh-idle.txt", "claude");
    expect(read.box).toBe("");
    expect(read.surface.modal).toBe("none");
    const r = rig();
    const id = typedRow(r.holds);
    r.poll(read);
    expect(r.poll(read)).toEqual([id]);
  });
});
