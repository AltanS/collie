// The pane read's `linked` (M99 spec 15): the session half of the send pick, one function for the
// field and the road, so the mark and the send cannot disagree.

import { describe, expect, test } from "bun:test";

import { DATA_MAIL_NEEDS, isLinked, pickSendPath, sessionRoad, type PathSession } from "../surface/path.ts";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { DATA_PANE, dataRig } from "./data-rig.ts";

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

  test("the field follows the live part: there while it is bound, gone after its bye", async () => {
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
