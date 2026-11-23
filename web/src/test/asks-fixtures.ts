// Asks for the tests of the Asks pages (Asks build 2, 2026-11-23): Decisions with the `ask` field, built on `hillDecision`.
// Names are the hill fixtures' own; no person's name, no private path.

import type { AskDecision } from "@/lib/hill/asks";
import type { AgentView } from "@/lib/types";
import type { HillAsk, HillAskFile, HillDecision, HillOption } from "@/lib/hill/wire";

import { hillDecision, HILL_T0 } from "./hill-fixtures";

/** The options of a typical ask: three, the first with a "does" text and a cost. */
export const ASK_OPTIONS: HillOption[] = [
  { intent: "keep", label: "Keep both routes", detail: "Older phones keep working.", cost: "Two code paths until the next minor." },
  { intent: "drop", label: "Drop the old route", detail: "One code path." },
  { intent: "later", label: "Decide next week" },
];

export interface AskOver {
  id?: string;
  title?: string;
  summary?: string;
  body?: string;
  options?: HillOption[];
  recommend?: string;
  why?: string;
  /** The session address; two asks with the same address belong to one session. */
  address?: string;
  label?: string;
  at?: number;
  words?: boolean;
  files?: HillAskFile[];
  root?: string | null;
  mark?: "fresh" | "carried" | "unchecked";
  confirmedAt?: number;
  media?: HillDecision["media"];
  state?: HillDecision["state"];
  closedReason?: string | null;
  decision?: Partial<HillDecision>;
}

/** One open ask. `id` defaults to the builder's own `dc_test...`; pass one to name it. */
export function askDecision(over: AskOver = {}): AskDecision {
  const fields: Partial<HillDecision> = {
    title: over.title ?? "Keep the old answer route beside the new Send?",
    summary: over.summary ?? "",
    body: over.body ?? "",
    options: over.words === true ? [] : (over.options ?? ASK_OPTIONS),
    recommends: over.recommend === undefined ? null : { intent: over.recommend, why: over.why ?? "" },
    at: over.at ?? HILL_T0,
  };
  if (over.id !== undefined) fields.id = over.id;
  if (over.media !== undefined) fields.media = over.media;
  if (over.state !== undefined) fields.state = over.state;
  if (over.closedReason !== undefined) fields.closedReason = over.closedReason;
  const base = hillDecision(Object.assign(fields, over.decision));
  base.from = { ...base.from, address: over.address ?? base.from.address, label: over.label ?? base.from.label };
  const ask: HillAsk = { words: over.words === true, files: over.files ?? [], root: over.root === undefined ? null : over.root, mark: over.mark ?? "fresh" };
  if (over.confirmedAt !== undefined) ask.confirmedAt = over.confirmedAt;
  return Object.assign(base, { ask });
}

/** The address of a solo pane, as a walky sender spells it. */
export function askAddress(paneId: string): string {
  return `local/${paneId}#a1b2`;
}

/** A live pane for a session. `cache` is a warm reading with `minutes` left, a cold one, or none. */
export function askPane(paneId: string, over: { label?: string; status?: AgentView["status"]; cache?: { warmMinutes: number; now: number } | "cold" | null; cwd?: string } = {}): AgentView {
  const pane: AgentView = {
    paneId,
    instance: "a1b2",
    workspaceId: "w1",
    workspaceLabel: "lodge",
    workspaceNumber: 1,
    tabId: `w1:t${paneId}`,
    agent: "claude",
    status: over.status ?? "idle",
    cwd: over.cwd ?? "/work/lodge",
    focused: false,
  };
  if (over.label !== undefined) pane.paneLabel = over.label;
  const cache = over.cache ?? null;
  if (cache === "cold") pane.cache = { state: "cold", ttlSeconds: 300, ruleId: "test", confidence: "observed" };
  else if (cache !== null) pane.cache = { state: "warm", expiresAt: cache.now + cache.warmMinutes * 60_000, ttlSeconds: 300, ruleId: "test", confidence: "observed" };
  return pane;
}
