// The History view's half of the wave-4 stub bridge: `/api/pane/:id/history`, in pages. A long
// transcript answers its newest `limit` turns with `hasMore`, and `?before=<uuid>` the page ending just
// above that turn, as the bridge does. The default pane holds 90 turns, a user turn every ten, so the
// 60-turn window has something above it. Payloads are shaped like web/src/lib/types.
import type { PaneHistoryResponse, TranscriptEntry } from "@web/lib/types";

import type { StubHandler } from "./routes-api";

const START = Date.parse("2026-10-05T09:00:00Z");

/** `count` turns, oldest first: a user turn at every tenth index, an agent turn between. */
export function conversation(count: number): TranscriptEntry[] {
  return Array.from({ length: count }, (_, i): TranscriptEntry => {
    const user = i % 10 === 0;
    return {
      uuid: `t${String(i)}`,
      ts: new Date(START + i * 60_000).toISOString(),
      role: user ? "user" : "assistant",
      parts: user
        ? [{ kind: "text", text: `question number ${String(i)}` }]
        : [
            { kind: "text", text: `answer number ${String(i)}` },
            { kind: "tool", name: "Bash", summary: `ls dir${String(i)}`, result: { text: `file-${String(i)}.txt` } },
          ],
    };
  });
}

export type HistoryMode = "long" | "short" | PaneHistoryReason | "error";
type PaneHistoryReason = "disabled" | "no-session" | "no-log";

export function historyStub(mode: HistoryMode = "long", paneId = "w1:p1"): StubHandler {
  const all = conversation(mode === "short" ? 5 : 90);
  return async (ctx) => {
    if (ctx.method !== "GET" || ctx.url.pathname !== `/api/pane/${encodeURIComponent(paneId)}/history`) return false;
    if (mode === "error") {
      await ctx.json(500, { error: "boom" });
      return true;
    }
    if (mode === "disabled" || mode === "no-session" || mode === "no-log") {
      await ctx.json(200, { paneId, available: false, reason: mode } satisfies PaneHistoryResponse);
      return true;
    }
    const limit = Number(ctx.url.searchParams.get("limit") ?? "5000");
    const before = ctx.url.searchParams.get("before");
    const end = before === null ? all.length : all.findIndex((e) => e.uuid === before);
    const entries = all.slice(Math.max(0, end - limit), end);
    await ctx.json(200, {
      paneId,
      available: true,
      entries,
      hasMore: end - limit > 0,
      total: all.length,
      fileTruncated: false,
    } satisfies PaneHistoryResponse);
    return true;
  };
}
