import { describe, expect, test } from "bun:test";

import {
  isUnsupported,
  muxAck,
  muxGone,
  muxOk,
  muxRefused,
  muxUnreachable,
  muxUnsupported,
  type MuxOutcome,
} from "./types.ts";

// The refusal shape is the load-bearing half of the contract: a route branches on it, and M10/06
// turns "unsupported" into an explanation and everything else into an error. These tests pin the
// property that makes that safe — an absent capability is DISTINGUISHABLE from a failure, and it
// names the capability rather than describing it in prose a UI would have to parse.

describe("the unsupported answer", () => {
  test("is a refusal that names its capability", () => {
    const outcome = muxUnsupported("agentSessionRef", "tmux keeps no agent session log");
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe("unsupported");
    if (outcome.reason !== "unsupported") throw new Error("narrowing failed");
    expect(outcome.capability).toBe("agentSessionRef");
    expect(outcome.detail).not.toBe("");
  });

  test("is distinguishable from every kind of failure", () => {
    expect(isUnsupported(muxUnsupported("paneGrid", "no grid"))).toBe(true);
    expect(isUnsupported(muxGone("pane closed"))).toBe(false);
    expect(isUnsupported(muxRefused("key not sendable"))).toBe(false);
    expect(isUnsupported(muxUnreachable("socket closed"))).toBe(false);
  });

  test("success is never mistaken for it", () => {
    expect(isUnsupported(muxOk(42))).toBe(false);
    expect(isUnsupported(muxAck())).toBe(false);
  });

  // A failed outcome carries no `value`, so a caller that forgot to check `ok` cannot read an empty
  // success out of a refusal — "degrade rather than lie" (M10/03) starts here.
  test.each([
    ["unsupported", muxUnsupported("closePane", "no such verb")],
    ["gone", muxGone("gone")],
    ["refused", muxRefused("no")],
    ["unreachable", muxUnreachable("down")],
  ] as const)("a %s refusal carries no value", (_reason, outcome: MuxOutcome<never>) => {
    expect(Object.hasOwn(outcome, "value")).toBe(false);
    expect(outcome.ok).toBe(false);
  });
});

describe("success", () => {
  test("carries the value", () => {
    const outcome = muxOk({ text: "hello" });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("narrowing failed");
    expect(outcome.value.text).toBe("hello");
  });

  test("an ack is a success with nothing in it", () => {
    const outcome = muxAck();
    expect(outcome.ok).toBe(true);
    expect(Object.hasOwn(outcome, "value")).toBe(true);
  });
});
