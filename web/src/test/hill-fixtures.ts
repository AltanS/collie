// Decisions and receipts for the hill's tests (M96), shaped by `lib/hill/wire.ts`. One builder with
// the contract's defaults, so a case sets only the fields it is about.

import type { HillDecision, HillReceipt } from "@/lib/hill/wire";

export const HILL_T0 = 1_762_000_000_000;

let seq = 0;

/** A whole open decision, the fields a case leaves out filled in. Each call gets its own id. */
export function hillDecision(over: Partial<HillDecision> = {}): HillDecision {
  seq += 1;
  const id = `dc_test${String(seq).padStart(7, "0")}`;
  return {
    v: 1,
    id,
    requestId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    from: { kind: "agent", address: "wt_aaaaaaaaaaaa", trickId: null, trickKey: null, memberId: null, harness: "claude", label: "collie lead", host: "bluefin", trickHost: null },
    about: null,
    priority: "today",
    priorityAsked: "today",
    title: "Ship the zoom fix in 1.28.1?",
    summary: "The fix is on main and its unit tests pass.",
    body: "",
    options: [
      { intent: "yes", label: "Yes, Edge first" },
      { intent: "no", label: "Not yet" },
    ],
    text: "optional",
    recommends: null,
    media: [],
    links: [],
    replyTo: null,
    target: { label: "collie lead", host: "bluefin", unattended: false },
    supersedes: null,
    supersededBy: null,
    expiresAt: null,
    at: HILL_T0,
    state: "open",
    closedAt: null,
    closedReason: null,
    answer: null,
    ...over,
  };
}

/**
 * A decision a trick posted (M94 in the hill): `from.kind` is "trick", `from.label` the trick's name, no
 * session address. It has no target unless the case sets one (`replyTo` was set), and an open one has
 * no answer.
 */
export function trickDecision(over: Partial<HillDecision> = {}): HillDecision {
  const base = hillDecision();
  return {
    ...base,
    from: { kind: "trick", address: null, trickId: "look", trickKey: "ship-zoom", memberId: null, harness: null, label: "Look", host: null, trickHost: null },
    target: null,
    ...over,
  };
}

/** A receipt for `rid`, `ok` and typed unless the case says otherwise. */
export function hillReceipt(over: Partial<HillReceipt> = {}): HillReceipt {
  return { rid: "00000000-0000-4000-8000-000000000001", code: "ok", reason: null, state: "answered", delivery: "typed", trick: "none", at: HILL_T0, ...over };
}
