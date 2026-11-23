import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  dropSpaceLanding,
  landingStep,
  peekSpaceLanding,
  queueSpaceLanding,
  SPACE_LANDING_TTL_MS,
  type LandingFacts,
} from "./space-landing";

// THE ASK AND THE DECISION behind `open_space` on a large screen (components/space-landing.tsx draws them).

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  dropSpaceLanding();
  vi.useRealTimers();
});

describe("the ask", () => {
  it("holds the space until it is dropped, and a peek does not spend it", () => {
    expect(peekSpaceLanding()).toBeNull();
    queueSpaceLanding("a\u0000\u0000w2");
    expect(peekSpaceLanding()).toBe("a\u0000\u0000w2");
    expect(peekSpaceLanding()).toBe("a\u0000\u0000w2");
    dropSpaceLanding();
    expect(peekSpaceLanding()).toBeNull();
  });

  it("goes stale: a Dashboard that opens later does not land on it", () => {
    queueSpaceLanding("w2");
    vi.advanceTimersByTime(SPACE_LANDING_TTL_MS - 1);
    expect(peekSpaceLanding()).toBe("w2");
    vi.advanceTimersByTime(2);
    expect(peekSpaceLanding()).toBeNull();
  });

  it("keeps only the newest ask", () => {
    queueSpaceLanding("w1");
    queueSpaceLanding("w3");
    expect(peekSpaceLanding()).toBe("w3");
  });
});

describe("the next step", () => {
  const clear: LandingFacts = { exists: true, choiceExcludes: false, hiddenSpace: false, hiddenMachine: false, needsYouHides: false, queryHides: false, drawn: true };

  it("lands when nothing hides the space and it is on screen", () => {
    expect(landingStep(clear)).toEqual({ kind: "land" });
  });

  it("has nothing to land on for a space that is gone, or one with no column and no row", () => {
    expect(landingStep({ ...clear, exists: false })).toEqual({ kind: "none" });
    expect(landingStep({ ...clear, drawn: false })).toEqual({ kind: "none" });
  });

  it("clears what hides the space, in the order the list narrows by", () => {
    const all: LandingFacts = { ...clear, choiceExcludes: true, hiddenSpace: true, hiddenMachine: true, needsYouHides: true, queryHides: true, drawn: false };
    expect(landingStep(all)).toEqual({ kind: "clear", what: "workspaceChoice" });
    const noChoice: LandingFacts = { ...all, choiceExcludes: false };
    expect(landingStep(noChoice)).toEqual({ kind: "clear", what: "hiddenSpace" });
    const shown: LandingFacts = { ...noChoice, hiddenSpace: false };
    expect(landingStep(shown)).toEqual({ kind: "clear", what: "hiddenMachine" });
    const machineBack: LandingFacts = { ...shown, hiddenMachine: false };
    expect(landingStep(machineBack)).toEqual({ kind: "clear", what: "needsYouOnly" });
    const switchOff: LandingFacts = { ...machineBack, needsYouHides: false };
    expect(landingStep(switchOff)).toEqual({ kind: "clear", what: "query" });
    const textOff: LandingFacts = { ...switchOff, queryHides: false, drawn: true };
    expect(landingStep(textOff)).toEqual({ kind: "land" });
  });

  it("never lists the sort among the things it clears", () => {
    const whats = new Set<string>();
    const hides = ["choiceExcludes", "hiddenSpace", "hiddenMachine", "needsYouHides", "queryHides"] as const;
    for (const key of hides) {
      const step = landingStep({ ...clear, [key]: true });
      if (step.kind === "clear") whats.add(step.what);
    }
    expect([...whats].toSorted()).toEqual(["hiddenMachine", "hiddenSpace", "needsYouOnly", "query", "workspaceChoice"]);
  });
});
