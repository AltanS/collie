import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/test/setup";
import { LIVE_CAP_MS, markDead, markLive, resetLiveness } from "./liveness";
import { sendGuardedReply } from "./reply-action";

// M46 spec 11, the backstop behind every disabled Send: a pane the bridge has not answered a read for
// lately gets NO request at all from the guarded reply, not even the pre-flight read.
// (The always-live pin in reply-action.test.ts is what lets that suite drive sends without polling.)

beforeEach(() => resetLiveness());

function watchNetwork() {
  const calls: string[] = [];
  server.use(
    http.all(/\/api\//, ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`);
      return HttpResponse.json({ ok: true });
    }),
  );
  return calls;
}

describe("sendGuardedReply when the pane is not live", () => {
  it("refuses with reason offline and sends nothing", async () => {
    const calls = watchNetwork();
    const out = await sendGuardedReply({ paneId: "w1:p1", text: "continue", agent: "claude" });
    expect(out).toMatchObject({ status: "refused", reason: "offline" });
    expect(calls).toEqual([]);
  });

  it("refuses for an unknown agent too (the one-shot path is behind the same door)", async () => {
    const calls = watchNetwork();
    const out = await sendGuardedReply({ paneId: "w1:p1", text: "ls", agent: "nothing-known" });
    expect(out).toMatchObject({ status: "refused", reason: "offline" });
    expect(calls).toEqual([]);
  });

  it("refuses when the last live answer is older than the safety cap", async () => {
    const calls = watchNetwork();
    markLive("w1:p1", Date.now() - LIVE_CAP_MS - 1_000);
    const out = await sendGuardedReply({ paneId: "w1:p1", text: "continue", agent: "claude" });
    expect(out).toMatchObject({ status: "refused", reason: "offline" });
    expect(calls).toEqual([]);
  });

  it("refuses once the last read failed and the debounce ran out", async () => {
    vi.useFakeTimers();
    try {
      const calls = watchNetwork();
      markLive("w1:p1");
      markDead("w1:p1");
      vi.advanceTimersByTime(1_001);
      vi.useRealTimers();
      const out = await sendGuardedReply({ paneId: "w1:p1", text: "continue", agent: "claude" });
      expect(out).toMatchObject({ status: "refused", reason: "offline" });
      expect(calls).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is per scope: a live pane on another machine does not open this one", async () => {
    const calls = watchNetwork();
    markLive("w1:p1", Date.now(), { host: "minibuch" });
    const out = await sendGuardedReply({ paneId: "w1:p1", text: "continue", agent: "claude" });
    expect(out).toMatchObject({ status: "refused", reason: "offline" });
    expect(calls).toEqual([]);
  });

  it("goes on to the network once the pane is live", async () => {
    const calls = watchNetwork();
    markLive("w1:p1");
    const out = await sendGuardedReply({ paneId: "w1:p1", text: "ls", agent: "nothing-known" });
    expect(out).not.toMatchObject({ reason: "offline" });
    expect(calls.length).toBeGreaterThan(0);
  });
});
