import { describe, expect, it } from "vitest";

import type { JsonValue } from "@/lib/json";
import { parseDecisionView } from "@/lib/tricks/schema";

import { diffSummary, gateStrip, roughCard, stressCard } from "./decisions";

// The playground's views are ones a poster may send: each passes the bridge's own rules for a
// Decision's view (`parseDecisionView`), so a look judged on this page is a look the hill can show.

describe("the playground's Decision views", () => {
  it.each([
    ["the gate strip", gateStrip],
    ["the diff summary", diffSummary],
    ["the rough card", roughCard],
    ["the stress card", stressCard],
  ])("%s passes the bridge's rules", (_name, decision) => {
    const value: JsonValue = JSON.parse(JSON.stringify(decision.view));
    expect(parseDecisionView(value).refusals).toEqual([]);
  });
});
