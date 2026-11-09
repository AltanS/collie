import type { HillDecision } from "../../web/src/lib/hill/wire.ts";

// Shared test fixtures for the hill (M96). Not a test file itself (so `bun test` does not collect it)
// and not imported by any production path: it exists so the hill's test files agree on what a whole
// stored decision looks like.

/** A whole decision, every field set, as the service stores one. */
export function decision(id: string, over: Partial<HillDecision> = {}): HillDecision {
  return {
    v: 1,
    id,
    requestId: "0f8b5c1e-5a7d-4b8e-9f00-1a2b3c4d5e6f",
    from: { kind: "agent", address: "local/%1#aaaa", trickId: null, trickKey: null, memberId: null, harness: "agent-x", label: "repo#one", host: "desk", trickHost: null },
    about: null,
    priority: "today",
    priorityAsked: "today",
    title: "Ship it?",
    summary: "The leg is green.",
    body: "",
    options: [{ intent: "yes", label: "Yes" }],
    text: "optional",
    recommends: null,
    media: [],
    links: [],
    replyTo: null,
    target: { label: "repo#one", host: "desk", unattended: false },
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    at: 1000,
    state: "open",
    closedAt: null,
    closedReason: null,
    answer: null,
    ...over,
  };
}
