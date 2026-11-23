// A test rig for asks (Asks, 2026-11-22): a HillService over a memory store, with a send that records,
// shared by asks.test.ts, asks-send.test.ts and asks-files.test.ts. Test code only; nothing in the bridge
// imports it.

import type { HillDecision, HillPostInput } from "../../web/src/lib/hill/wire.ts";
import { memoryHillReceipts, type HillReceiptSurface } from "./receipts.ts";
import { HillService, type HillAgentSender, type HillPostAnswer, type HillSendResult, type HillServiceDeps } from "./service.ts";
import { HillStore } from "./store.ts";

export const ONE: HillAgentSender = { kind: "agent", address: "local/%1#aaaa", memberId: null, harness: "claude", label: "repo#one", host: "desk" };
export const TWO: HillAgentSender = { kind: "agent", address: "local/%2#bbbb", memberId: null, harness: "claude", label: "repo#two", host: "desk" };

export function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function askInput(n: number, over: Partial<HillPostInput> = {}): HillPostInput {
  return {
    requestId: uuid(n),
    title: `Ship the fix on Edge first, round ${String(n)}?`,
    summary: "The fix is green on the leg.",
    body: "## Why\n\nTesters see it first.",
    options: [
      { intent: "edge", label: "Ship it on Edge first", detail: "Testers get it today." },
      { intent: "stable", label: "Ship it on Stable now", detail: "Everyone gets it today." },
    ],
    recommends: { intent: "edge", why: "Testers see it first." },
    priority: "now",
    ask: { words: false, files: [] },
    ...over,
  };
}

export interface AskRig {
  hill: HillService;
  store: HillStore;
  clock: number;
  live: Set<string>;
  sent: Array<{ to: string; body: string; by: string; subject: string | undefined }>;
  pushed: number;
  delivery: HillSendResult | "throw";
}

export function askRig(receipts: HillReceiptSurface = memoryHillReceipts(), over: (clock: () => number) => Partial<HillServiceDeps> = () => ({})): AskRig {
  let n = 0;
  let a = 0;
  const store = new HillStore(null, () => state.clock);
  const state: Omit<AskRig, "hill"> = { store, clock: 1000, live: new Set([ONE.address, TWO.address]), sent: [], pushed: 0, delivery: "typed" };
  const hill = new HillService({
    store,
    receipts,
    place: (address) => (state.live.has(address) ? { address, label: "repo", host: "desk", unattended: false } : null),
    send: async (to, body, by, subject) => {
      state.sent.push({ to, body, by, subject });
      if (state.delivery === "throw") throw new Error("socket closed");
      return state.delivery;
    },
    crewMode: () => "solo",
    walkyOn: () => true,
    memberId: "m_aaaaaaaaaa",
    machine: "desk",
    now: () => state.clock,
    mintId: () => `dc_test${String((n += 1)).padStart(8, "0")}`,
    mintAskId: () => `ak_test${String((a += 1)).padStart(8, "0")}`,
    push: { check: () => "send", send: () => void (state.pushed += 1), clear: () => undefined },
    ...over(() => state.clock),
  });
  return Object.assign(state, { hill });
}

export function posted(answer: HillPostAnswer): HillDecision {
  if (!answer.ok) throw new Error(`refused: ${answer.code ?? "-"} ${answer.error}`);
  return answer.decision;
}

