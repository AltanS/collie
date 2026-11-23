import { describe, expect, it } from "vitest";

import { asJsonObject } from "@/lib/json";

import { readHillDecision } from "./reader";
import { HILL_COLLIE_REF_TYPES, isTrickCard } from "./wire";

// The test Decision as the bridge stores and serves it (bridge/hill/test-card.ts): the web's reader holds it, with Collie's
// sender and its fixed words. bridge/hill/test-card.test.ts holds the same card against the bridge's reader.

const STORED = {
  v: 1,
  id: "ak_test00000001",
  requestId: "5d1b0a54-9a2e-4c1f-8f0a-3b7d2c6e9a10",
  from: {
    kind: "collie",
    address: null,
    trickId: null,
    trickKey: null,
    memberId: "m_aaaaaaaaaa",
    harness: null,
    label: "Collie",
    host: "desk",
    trickHost: null,
    ref: { type: "test", id: "test", hash: "a4e8d3b9c1f2e7a05d6b8c3f1e9a7b2d4c6e8f0a1b3d5f7092c4e6a8b0d2f4a6" },
  },
  about: null,
  priority: "now",
  priorityAsked: "now",
  title: "Does the Hill reach you?",
  summary: "You sent this test from Settings. Tap the answer to close it.",
  body: "",
  recommends: null,
  links: [],
  options: [{ intent: "ok", label: "It works" }],
  text: "none",
  media: [],
  replyTo: null,
  target: null,
  supersedes: null,
  supersededBy: null,
  expiresAt: 1_600_000,
  at: 1_000_000,
  state: "open",
  closedAt: null,
  closedReason: null,
  answer: null,
  postDigest: "b".repeat(64),
  pushTag: "collie:hill:ak_test00000001",
};

describe("a stored test Decision", () => {
  it("is read by the web's reader as a card of Collie's own, labelled Collie, priority Now, with one option", () => {
    const read = readHillDecision(asJsonObject(STORED) ?? {});
    expect(read).toMatchObject({ id: "ak_test00000001", priority: "now", title: "Does the Hill reach you?", options: [{ intent: "ok", label: "It works" }], from: { kind: "collie", label: "Collie", ref: { type: "test", id: "test" } } });
  });

  it("is a ref type the web lists, and no trick card", () => {
    expect(HILL_COLLIE_REF_TYPES).toContain("test");
    expect(isTrickCard({ kind: "collie", ref: { type: "test" } })).toBe(false);
    expect(isTrickCard({ kind: "collie", ref: { type: "rights" } })).toBe(true);
  });
});
