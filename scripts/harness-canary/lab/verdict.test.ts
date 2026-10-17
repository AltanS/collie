import { describe, expect, test } from "bun:test";
import { failCase, notReachedCase, passCase } from "../verdict";
import { phoneResult } from "./phone-verdict";
import { judge, type LabFacts, type ScreenFact, type WalkFact } from "./verdict";

const walk: WalkFact = { reached: true, returned: true, menuRead: true, startedTurn: null, sent: ["/help"], unclassified: [], missing: [] };
const screen = (patch: Partial<ScreenFact>): ScreenFact => ({
  leg: "walk",
  label: "/model",
  expects: "dialog",
  surface: { turn: "unknown", composer: "unknown", modal: "ask" },
  free: false,
  cue: "strong",
  rows: [],
  ...patch,
});
const facts = (patch: Partial<LabFacts>): LabFacts => ({
  harness: "claude",
  version: "2.1.301",
  profile: "provisional",
  walk,
  screens: [screen({})],
  send: { outcome: "sent", probed: true, keys: 3 },
  ask: { outcome: "sent", fileCreated: false },
  turns: 2,
  ...patch,
});

describe("judge", () => {
  test("zero free on a dialog screen and a settled send pass", () => {
    expect(judge(facts({}))).toMatchObject({ result: "pass", reasons: [] });
  });

  test("one dialog screen that reads free fails, and the verdict names it", () => {
    const verdict = judge(facts({ screens: [screen({}), screen({ label: "/permissions", free: true })] }));
    expect(verdict.result).toBe("fail");
    expect(verdict.freeOnDialog.map((entry) => entry.label)).toEqual(["/permissions"]);
    expect(verdict.reasons[0]).toContain("/permissions is a dialog");
  });

  test("a strong cue makes a screen a dialog even when the lab did not expect one", () => {
    const verdict = judge(facts({ screens: [screen({ expects: "either", free: true })] }));
    expect(verdict.result).toBe("fail");
  });

  test("an idle screen that reads free is fine", () => {
    const idle = screen({ expects: "idle", label: "start", surface: { turn: "idle", composer: "empty", modal: "none" }, free: true, cue: "none" });
    expect(judge(facts({ screens: [idle] })).result).toBe("pass");
  });

  test("a send that did not settle fails", () => {
    const verdict = judge(facts({ send: { outcome: "refused", reason: "draft", probed: true, keys: 1 } }));
    expect(verdict.result).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("refused");
  });

  test("no send fails", () => {
    expect(judge(facts({ send: null })).result).toBe("fail");
  });

  test("a walk that cannot start, cannot return or reads no menu fails", () => {
    expect(judge(facts({ walk: { ...walk, reached: false } })).result).toBe("fail");
    expect(judge(facts({ walk: { ...walk, returned: false } })).result).toBe("fail");
    expect(judge(facts({ walk: { ...walk, menuRead: false } })).result).toBe("fail");
  });

  test("a safe command that started a turn fails", () => {
    const verdict = judge(facts({ walk: { ...walk, startedTurn: "/help" } }));
    expect(verdict.result).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("/help is on the safe list");
  });

  test("a declined command that made its file fails", () => {
    expect(judge(facts({ ask: { outcome: "sent", fileCreated: true } })).result).toBe("fail");
  });

  test("the ask must reach sent or effective: an ask that did not settle fails", () => {
    const verdict = judge(facts({ ask: { outcome: "refused", reason: "stale", fileCreated: false } }));
    expect(verdict.result).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("the ask answer did not settle: refused (stale)");
    expect(judge(facts({ ask: { outcome: "effective", fileCreated: false } })).result).toBe("pass");
  });

  test("a dialog that no reader lifts is a fail, and the reason says so", () => {
    const verdict = judge(facts({ ask: null, askNote: "the dialog was on screen and no reader lifted it" }));
    expect(verdict.result).toBe("fail");
    expect(verdict.reasons.join(" ")).toContain("no ask answer was made: the dialog was on screen and no reader lifted it");
  });

  test("a harness with no profile is walk-only when the walk is clean, and fails when it is not", () => {
    expect(judge(facts({ profile: "none", send: null, ask: null, screens: [] })).result).toBe("walk-only");
    expect(judge(facts({ profile: "none", send: null, ask: null, screens: [screen({ free: true })] })).result).toBe("fail");
  });
});

describe("judge, with the phone leg", () => {
  const phone = (verdicts: readonly ("pass" | "fail" | "not-reached")[]) => ({
    target: "scratch" as const,
    turns: 3,
    summary: "/lab/phone/summary.json",
    results: verdicts.map((verdict, i) => phoneResult(i === 0 ? "idle-send" : "stream-sends", [verdict === "pass" ? passCase("send") : verdict === "fail" ? failCase("send", "ended refused (turn_running)") : notReachedCase("send", "the turn did not end")])),
  });

  test("a full run fails when a phone scenario fails, and passes when the rest only did not reach", () => {
    expect(judge(facts({ phone: phone(["pass", "fail"]) })).reasons).toEqual(["phone stream-sends: 0/1, send: ended refused (turn_running)"]);
    expect(judge(facts({ phone: phone(["pass", "not-reached"]) })).result).toBe("pass");
  });

  test("a phone leg that should have run and did not is a fail with its note", () => {
    expect(judge(facts({ phone: null, phoneNote: "the scratch bridge did not answer /api/health" })).reasons).toEqual(["the phone leg did not run: the scratch bridge did not answer /api/health"]);
  });

  test("a phone-only run is judged by the phone leg alone: no send and no ask is no reason", () => {
    const only = facts({ legs: "phone", send: null, ask: null, screens: [], phone: phone(["pass"]) });
    expect(judge(only)).toMatchObject({ result: "pass", reasons: [] });
    expect(judge({ ...only, phone: phone(["fail"]) }).result).toBe("fail");
    expect(judge({ ...only, phone: undefined }).reasons).toEqual(["this harness has no phone leg"]);
  });
});
