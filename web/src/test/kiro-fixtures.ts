// The import attribute is what lets Playwright's Node loader read this module too.
import kiroJournalEntries from "@/fixtures/kiro-journal-entries.json" with { type: "json" };
import type { PaneChatResponse, PaneHistoryResponse, SnapshotResponse, TranscriptEntry } from "@/lib/types";
import { FIXTURE_CHAT_GEN, FIXTURE_SEQ_BASE, fixtureAgents, fixtureSnapshot } from "./handlers";

/** The same pane used by the default API fixture, with Kiro's journal availability. */
export const KIRO_PANE_ID = fixtureAgents[0]!.paneId;

/** A Kiro pane can draw Chat without exposing its session ID or foreground process. */
export const fixtureKiroSnapshot: SnapshotResponse = {
  ...fixtureSnapshot,
  agents: [{ ...fixtureAgents[0]!, agent: "kiro", hasSession: true }],
  shellPanes: [],
};

/**
 * The bridge's Kiro journal parse of the session kiro-cli 2.32.0 saved in
 * `bridge/journal/fixtures/kiro/messages.jsonl`. The JSON is committed
 * because the browser runner cannot load the bridge's parser; `bridge/journal/kiro-journal-golden.test.ts`
 * fails when the parser stops producing it.
 */
export const fixtureKiroEntries: TranscriptEntry[] =
  // SAFETY: `bridge/journal/kiro-journal-golden.test.ts` checks this file equals the Kiro journal's
  // `parse` output, which is a TranscriptEntry[].
  kiroJournalEntries as TranscriptEntry[];

/** Kiro's read-only History: every saved entry, on one page. */
export const fixtureKiroHistory: Extract<PaneHistoryResponse, { available: true }> = {
  paneId: KIRO_PANE_ID,
  available: true,
  entries: fixtureKiroEntries,
  hasMore: false,
  total: fixtureKiroEntries.length,
  fileTruncated: false,
};

/** Kiro's live Chat window: the same entries, numbered as the default Chat fixture numbers its own. */
export const fixtureKiroChat: Extract<PaneChatResponse, { available: true }> = {
  paneId: KIRO_PANE_ID,
  available: true,
  page: "live",
  gen: FIXTURE_CHAT_GEN,
  rev: 1,
  head: FIXTURE_SEQ_BASE + fixtureKiroEntries.length - 1,
  oldest: FIXTURE_SEQ_BASE,
  hasOlder: false,
  upserts: fixtureKiroEntries.map((entry, index) => Object.assign({}, entry, { seq: FIXTURE_SEQ_BASE + index })),
};
