import { describe, expect, test } from "bun:test";

import { pickSendPath, type PathInput } from "./path.ts";

const PART = { capabilities: new Set(["send", "mail", "draft", "wake"]) };
const PLAIN = { mode: "send" as const, text: "Reply with pong.", fromView: false, mail: false };
const pick = (over: Partial<PathInput> = {}, request: Partial<PathInput["request"]> = {}) =>
  pickSendPath({ enabled: true, part: PART, ...over, request: { ...PLAIN, ...request } });

describe("pickSendPath", () => {
  test("a plain send to a part that declares send and wake goes by data", () => {
    expect(pick()).toEqual({ path: "data", why: "data" });
    expect(pick({}, { text: "two lines\nof plain text" }).path).toBe("data");
  });

  test("capabilities: without send, or without wake, the screen", () => {
    expect(pick({ part: { capabilities: new Set(["wake"]) } })).toEqual({ path: "screen", why: "not-declared" });
    expect(pick({ part: { capabilities: new Set(["send"]) } })).toEqual({ path: "screen", why: "not-declared" });
  });

  test("a send into a sign-in field always goes by the screen: the field is not the agent's prompt", () => {
    expect(pick({}, { secret: true })).toEqual({ path: "screen", why: "secret" });
  });

  test("the kill switch off: the screen, whatever the part declares", () => {
    expect(pick({ enabled: false })).toEqual({ path: "screen", why: "off" });
  });

  test("no part, or a part gone: the screen", () => {
    expect(pick({ part: null })).toEqual({ path: "screen", why: "no-part" });
  });

  test("the plain text rule: no slash command, no shell line, no mention, no attachment", () => {
    expect(pick({}, { text: "/compact" }).why).toBe("command");
    expect(pick({}, { text: "  !ls -la" }).why).toBe("command");
    expect(pick({}, { text: "@notes.md read this" }).why).toBe("command");
    expect(pick({}, { text: "look /home/a/.local/state/collie/uploads/w1-p1-mabc12-0123abcd.png please" }).why).toBe("attachment");
    expect(pick({}, { text: "/home/a/.local/state/collie/uploads/w1-p1-mabc12-0123abcd.png" }).why).toBe("attachment");
    expect(pick({}, { text: "a/b and 1/2 are fine" }).path).toBe("data");
    expect(pick({}, { text: "   " }).why).toBe("empty");
  });

  test("only a plain new message: other modes, a steer and an agent view keep the screen", () => {
    for (const mode of ["command", "append", "replace", "submit", "discard"] as const) expect(pick({}, { mode }).why).toBe("not-plain-mode");
    expect(pick({}, { when: "steer" }).why).toBe("not-plain-mode");
    expect(pick({}, { fromView: true }).why).toBe("not-plain-mode");
  });

  test("a WalkyTalky delivery goes by data to a part that declares mail and wake (M99 spec 05)", () => {
    const envelope = "[walky-talky wt_aaaaaaaaaaa1] from operator (cli)\nhello";
    expect(pick({}, { mail: true, text: envelope })).toEqual({ path: "data", why: "data" });
    expect(pick({ part: { capabilities: new Set(["send", "wake"]) } }, { mail: true, text: envelope })).toEqual({ path: "screen", why: "not-declared" });
    expect(pick({ part: { capabilities: new Set(["mail"]) } }, { mail: true, text: envelope })).toEqual({ path: "screen", why: "not-declared" });
    // A part that takes mail but no phone send keeps a phone send on the screen.
    expect(pick({ part: { capabilities: new Set(["mail", "wake"]) } })).toEqual({ path: "screen", why: "not-declared" });
  });
});
