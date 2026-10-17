import type { PaneChatResponse, PaneHistoryResponse, SnapshotResponse, TranscriptEntry } from "@/lib/types";
import { fixtureAgents, fixtureSnapshot } from "./handlers";

/** The same pane used by the default API fixture, with Kiro's journal availability. */
export const KIRO_PANE_ID = fixtureAgents[0]!.paneId;

/** A Kiro pane can draw Chat without exposing its session ID or foreground process. */
export const fixtureKiroSnapshot: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: [{ ...fixtureAgents[0]!, agent: "kiro", hasSession: true }],
  shellPanes: [],
};

/** Synthetic saved denial rows, in the messages.jsonl row shape rather than ACP events. */
export const fixtureKiroDenialLog = [
  { id: "denied-call", payload: { type: "tool_call", toolCallId: "denied", toolName: "execute_bash", kind: "execute", args: { command: "printf never_run" }, status: "denied" } },
  { id: "denied-result", payload: { type: "tool_result", toolCallId: "denied", content: "Permission refused.", success: false } },
].map((row) => JSON.stringify({ ...row, timestamp: "2026-10-01T12:00:00.000Z" })).join("\n") + "\n";

interface KiroJournalResponses {
  history: Extract<PaneHistoryResponse, { available: true }>;
  chat: Extract<PaneChatResponse, { available: true }>;
}

/** Normalize source-parsed saved-session entries into the existing History and live Chat API. */
export function kiroJournalResponses(entries: TranscriptEntry[]): KiroJournalResponses {
  const upserts = entries.map((entry, index) => ({ ...entry, seq: 1_000_000 + index }));
  return {
    history: {
      paneId: KIRO_PANE_ID, available: true, entries, hasMore: false,
      total: entries.length, fileTruncated: false,
    },
    chat: {
      paneId: KIRO_PANE_ID, available: true, page: "live", gen: 1, rev: 1,
      head: upserts.at(-1)?.seq ?? 999_999, oldest: upserts[0]?.seq ?? 1_000_000,
      hasOlder: false, upserts,
    },
  };
}
