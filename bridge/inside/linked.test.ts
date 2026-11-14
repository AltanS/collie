// The pane read's `linked` (M99 spec 15): the session half of the send pick, one function for the
// field and the road, so the mark and the send cannot disagree.

import { describe, expect, test } from "bun:test";

import { DATA_MAIL_NEEDS, isLinked, paneLinkedReader, pickSendPath, sessionRoad, type PathSession } from "../surface/path.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTelemetry } from "../telemetry.ts";
import { DATA_PANE, dataDescribe, dataRig, dataTest } from "./data-rig.ts";

const part = (...capabilities: string[]) => ({ capabilities: new Set(capabilities) });
const plain = { mode: "send" as const, text: "hello", fromView: false, mail: false };

describe("linked field: the session half of the send pick", () => {
  test("linked only with the wire on and a part that declares send and wake", () => {
    expect(isLinked({ enabled: true, part: part("send", "wake") })).toBe(true);
    expect(isLinked({ enabled: false, part: part("send", "wake") })).toBe(false);
    expect(isLinked({ enabled: true, part: null })).toBe(false);
    expect(isLinked({ enabled: true, part: part("send") })).toBe(false);
    expect(isLinked({ enabled: true, part: part("mail", "wake") })).toBe(false);
  });

  test("the pick of a plain send agrees with the field in every session case", () => {
    const sessions: PathSession[] = [
      { enabled: true, part: part("send", "wake") },
      { enabled: false, part: part("send", "wake") },
      { enabled: true, part: null },
      { enabled: true, part: part("wake") },
    ];
    for (const session of sessions) expect(pickSendPath({ ...session, request: plain }).path === "data").toBe(isLinked(session));
  });

  test("a WalkyTalky delivery asks for mail and wake through the same function", () => {
    expect(sessionRoad({ enabled: true, part: part("send", "wake") }, DATA_MAIL_NEEDS)).toBe("not-declared");
    expect(sessionRoad({ enabled: true, part: part("mail", "wake") }, DATA_MAIL_NEEDS)).toBeNull();
  });

  dataTest("the field follows the live part: there while it is bound, gone after its bye", async () => {
    const data = await dataRig({ harness: "claude", version: "2.1.200" });
    try {
      const linked = () => isLinked({ enabled: true, part: data.hub.partOf(DATA_PANE) });
      expect(linked()).toBe(false);
      const fake = await data.part();
      expect(linked()).toBe(true);
      await fake.bye();
      expect(linked()).toBe(false);
    } finally {
      data.stop();
      rmSync(join(data.socket, "..", ".."), { recursive: true, force: true });
    }
  });
});

dataDescribe("one reader of linked for the pane read and the install ping", () => {
  test("the reader says what isLinked says for the pane, whether the wire is on, and with no hub never linked", async () => {
    const data = await dataRig({ harness: "claude", version: "2.1.200" });
    try {
      let on = true;
      const read = paneLinkedReader({ enabled: () => on, hub: data.hub });
      const reads = () => read(DATA_PANE.session, DATA_PANE.paneId);
      expect(reads()).toBe(false);
      const fake = await data.part();
      expect(reads()).toBe(isLinked({ enabled: true, part: data.hub.partOf(DATA_PANE) }));
      expect(reads()).toBe(true);
      // Another pane of the session, and another session, have no part.
      expect(read(DATA_PANE.session, "w9:p9")).toBe(false);
      expect(read("elsewhere", DATA_PANE.paneId)).toBe(false);
      // The kill switch is read at each call, as the pane read and the ping both need.
      on = false;
      expect(reads()).toBe(false);
      on = true;
      await fake.bye();
      expect(reads()).toBe(false);
      expect(paneLinkedReader({ enabled: () => true, hub: null })(DATA_PANE.session, DATA_PANE.paneId)).toBe(false);
    } finally {
      data.stop();
      rmSync(join(data.socket, "..", ".."), { recursive: true, force: true });
    }
  });

  test("the ping's trouble row and tally say linked exactly when the pane read does, for the same pane", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "collie-linked-ping-"));
    const data = await dataRig({ harness: "claude", version: "2.1.200" });
    try {
      let on = true;
      const paneIsLinked = paneLinkedReader({ enabled: () => on, hub: data.hub });
      const telemetry = createTelemetry({
        stateDir,
        env: {},
        origin: "env",
        version: "1.29.0",
        installKind: "binary",
        line: () => "stable",
        crewMode: () => "solo",
        // The wiring of bridge/index.ts: the ping's reader IS the pane read's.
        linked: (where) => paneIsLinked(where.session ?? DATA_PANE.session, where.paneId),
        now: () => Date.UTC(2026, 10, 13, 12, 0, 0),
        fetch: async () => new Response("ok"),
        os: "linux",
        arch: "x64",
      });
      telemetry.observe();
      const signal = { kind: "dialog", harness: "claude", version: "2.1.200", mux: "herdr" } as const;
      const where = { session: DATA_PANE.session, paneId: DATA_PANE.paneId };
      // A row is keyed by linked too, so a signal of a linked pane counts on a row of its own: the newest row says.
      const rowLinked = () => telemetry.view().next?.trouble.findLast((row) => row.kind === "dialog")?.linked;
      telemetry.trouble(signal, where);
      expect(rowLinked()).toBe(paneIsLinked(DATA_PANE.session, DATA_PANE.paneId));
      expect(rowLinked()).toBe(false);
      const fake = await data.part();
      // A later signal of a linked pane turns the row linked, as the pane read now says.
      telemetry.trouble(signal, where);
      expect(paneIsLinked(DATA_PANE.session, DATA_PANE.paneId)).toBe(true);
      expect(rowLinked()).toBe(true);
      // The kill switch off: neither says linked for a new signal of a new kind of row.
      on = false;
      telemetry.trouble({ ...signal, kind: "send" }, where);
      const send = telemetry.view().next?.trouble.find((row) => row.kind === "send");
      expect(send?.linked).toBe(paneIsLinked(DATA_PANE.session, DATA_PANE.paneId));
      expect(send?.linked).toBe(false);
      // The tally reads the same function: its pair is linked while the pane read says linked.
      on = true;
      const panes = [{ paneId: DATA_PANE.paneId, agent: "claude" }];
      telemetry.sessions({ scope: "on", mux: "herdr", panes, linked: (paneId) => paneIsLinked(DATA_PANE.session, paneId) });
      expect(telemetry.view().next?.usage).toEqual([{ harness: "claude", mux: "herdr", linked: true }]);
      on = false;
      telemetry.sessions({ scope: "off", mux: "tmux", panes, linked: (paneId) => paneIsLinked(DATA_PANE.session, paneId) });
      expect(telemetry.view().next?.usage).toContainEqual({ harness: "claude", mux: "tmux", linked: false });
      await fake.bye();
    } finally {
      data.stop();
      rmSync(stateDir, { recursive: true, force: true });
      rmSync(join(data.socket, "..", ".."), { recursive: true, force: true });
    }
  });
});
