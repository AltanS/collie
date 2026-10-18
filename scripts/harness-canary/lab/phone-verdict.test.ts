import { describe, expect, test } from "bun:test";
import type { SendReceiptRow } from "../../../web/src/lib/surface/send";
import { parseKnownGaps } from "../known-gaps";
import { failCase, notReachedCase, passCase } from "../verdict";
import { applyPhoneGaps, isPhoneGapId, judgeStream, phoneCount, phoneLines, phoneReasons, phoneResult, readableSentence, streamSettled } from "./phone-verdict";

const row = (requestId: string, outcome: SendReceiptRow["outcome"], patch: Partial<SendReceiptRow> = {}): SendReceiptRow => ({ requestId, at: 1, mode: "send", outcome, keys: ["Enter"], gapsMs: {}, harness: "claude", version: "2.1.302", ...patch });

describe("the stream rule", () => {
  test("every receipt effective passes", () => {
    const cases = judgeStream([row("a", "effective"), row("b", "effective")], ["a", "b"], ["effective"]);
    expect(cases.map((c) => c.verdict)).toEqual(["pass", "pass"]);
  });

  test("a sent that never turned effective fails against a scratch bridge, and passes against a running one", () => {
    expect(judgeStream([row("a", "sent")], ["a"], ["effective"])[0]?.verdict).toBe("fail");
    expect(judgeStream([row("a", "sent")], ["a"], ["sent", "effective"])[0]?.verdict).toBe("pass");
  });

  test("a refusal or a typed_not_submitted fails and names the reason and the bridge's line", () => {
    const [refused, typed] = judgeStream([row("a", "refused", { reason: "turn_running", detail: "Claude is busy." }), row("b", "typed_not_submitted", { reason: "changed" })], ["a", "b"], ["effective"]);
    expect(refused).toMatchObject({ verdict: "fail" });
    expect(refused?.detail).toContain("refused (turn_running)");
    expect(refused?.detail).toContain("Claude is busy.");
    expect(typed?.detail).toContain("typed_not_submitted (changed)");
  });

  test("a request with no receipt, or one still held, fails as held", () => {
    const cases = judgeStream([row("b", "held")], ["a", "b"], ["effective"]);
    expect(cases[0]?.detail).toContain("still held");
    expect(cases[1]?.detail).toContain("still held");
  });

  test("settled waits on held and on sent, and stops on a final bad end", () => {
    expect(streamSettled([row("a", "held")], ["a"], ["effective"])).toBe(false);
    expect(streamSettled([row("a", "sent")], ["a"], ["effective"])).toBe(false);
    expect(streamSettled([row("a", "sent")], ["a"], ["sent", "effective"])).toBe(true);
    expect(streamSettled([row("a", "refused")], ["a"], ["effective"])).toBe(true);
    expect(streamSettled([], ["a"], ["effective"])).toBe(false);
  });
});

describe("a readable refusal", () => {
  test("a plain sentence is readable", () => {
    expect(readableSentence("Close the screen in the pane first, then send again.")).toBe(true);
  });

  test("empty, short, raw mux errors and JSON are not", () => {
    expect(readableSentence(undefined)).toBe(false);
    expect(readableSentence("")).toBe(false);
    expect(readableSentence("Refused.")).toBe(false);
    expect(readableSentence("tmux send-keys failed: no server running on /tmp/tmux-1000/x.")).toBe(false);
    expect(readableSentence("herdr pane read failed: server_not_running")).toBe(false);
    expect(readableSentence('The bridge said {"error":"busy"} to the send.')).toBe(false);
    expect(readableSentence("the send was refused by the bridge.")).toBe(false);
  });
});

describe("known gaps for the phone leg", () => {
  test("known-gaps.json takes a phone scenario as phone:<id>", () => {
    const gaps = parseKnownGaps(JSON.stringify({ gaps: [{ agent: "claude", scenario: "phone:stream-sends", reason: "r", ref: "#1" }] }));
    expect(gaps[0]?.scenario).toBe("phone:stream-sends");
    expect(() => parseKnownGaps(JSON.stringify({ gaps: [{ agent: "claude", scenario: "phone:nope", reason: "r", ref: "#1" }] }))).toThrow(/scenario/);
    expect(isPhoneGapId("phone:crew-send")).toBe(true);
    expect(isPhoneGapId("stream-sends")).toBe(false);
  });

  test("a listed fail becomes known-gap; a listed pass is stale; not-reached is left alone", () => {
    const gaps = parseKnownGaps(JSON.stringify({ gaps: [{ agent: "claude", scenario: "phone:idle-send", reason: "r", ref: "M56/10" }] }));
    expect(applyPhoneGaps(phoneResult("idle-send", [failCase("send", "x")]), "claude", gaps).verdict).toBe("known-gap");
    expect(applyPhoneGaps(phoneResult("idle-send", [passCase("send")]), "claude", gaps).staleGap).toBe(true);
    expect(applyPhoneGaps(phoneResult("idle-send", [notReachedCase("send", "x")]), "claude", gaps).verdict).toBe("not-reached");
    expect(applyPhoneGaps(phoneResult("idle-send", [failCase("send", "x")]), "codex", gaps).verdict).toBe("fail");
  });
});

describe("what the lab verdict takes from the phone leg", () => {
  test("only fails add a reason", () => {
    const results = [phoneResult("idle-send", [passCase("send")]), phoneResult("stream-sends", [failCase("send-2", "ended refused (turn_running)")]), phoneResult("crew-send", [notReachedCase("member", "no member in the lab")])];
    expect(phoneReasons(results)).toEqual(["phone stream-sends: 0/1, send-2: ended refused (turn_running)"]);
    expect(phoneCount(results)).toBe("1 pass, 1 fail, 1 not-reached");
    expect(phoneLines(results)[2]).toBe("phone crew-send: not-reached: 0/1, member: no member in the lab");
  });
});
