// The slow cases of peer-client.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { describe, expect, test } from "bun:test";
import { PROTOCOL_HEADER, MEMBER_HEADER } from "./admission.ts";
import { CREW_PROTOCOL_VERSION } from "./enrollment.ts";
import { CREW } from "./fixtures.ts";
import { DEFAULT_CREW_TIMEOUT_MS, PeerClient, crewTimeoutBudget, WRITE_BUDGET_MS, type CrewFetch, type CrewLink, type PeerClientDeps } from "./peer-client.ts";

const laptop: CrewLink = { memberId: "laptop", address: "laptop.example:8787" };

/** A fetch that answers with `body`, stamped with the crew headers a healthy peer sends. */
function replying<TBody>(
  body: TBody,
  init: { status?: number; protocol?: string | null; member?: string } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch: CrewFetch = async (url, reqInit) => {
    calls.push({ url, init: reqInit });
    const headers = new Headers({ "content-type": "application/json" });
    const protocol = init.protocol === undefined ? String(CREW_PROTOCOL_VERSION) : init.protocol;
    if (protocol !== null) headers.set(PROTOCOL_HEADER, protocol);
    headers.set(MEMBER_HEADER, init.member ?? "laptop");
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: init.status ?? 200,
      headers,
    });
  };
  return { fetch, calls };
}

function client(
  fetch: CrewFetch,
  over: {
    timeoutMs?: number;
    patientTimeoutMs?: number;
    secret?: string | null;
    device?: string | null;
    sign?: PeerClientDeps["sign"];
    dialSign?: PeerClientDeps["dialSign"];
    now?: () => number;
  } = {},
) {
  return new PeerClient({
    self: "desk",
    secret: () => (over.secret === undefined ? CREW.secret : over.secret),
    timeoutMs: over.timeoutMs ?? 50,
    patientTimeoutMs: over.patientTimeoutMs,
    fetch,
    now: over.now ?? (() => 1_000),
    device: over.device === undefined ? undefined : () => over.device ?? null,
    sign: over.sign,
    dialSign: over.dialSign,
  });
}

// ── The third budget: a forwarded WRITE (§10.1, amended 2026-09-08) ──────────

describe("a forwarded write's own budget (§10.1)", () => {
  test("on the real clock: 2 s of work misses the poll budget and fits inside WRITE_BUDGET_MS", async () => {
    // The measured case, on real timers rather than modelled: a launch onto a zellij member spawns a
    // process and has the multiplexer build a tab. Around 2 s — under 1200 ms it is an abort the lead
    // can only report as ambiguous (§10.3), and under 5000 ms it is the peer's own answer.
    const slow: CrewFetch = (url, init) =>
      new Promise((resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("The operation was aborted.")));
        setTimeout(() => void replying({ ok: true }).fetch(url, init).then(resolve, reject), 2000);
      });
    // No patient budget wired, so the poll budget is the honest comparison and not the credit.
    const c = client(slow, { timeoutMs: crewTimeoutBudget(1500, {}) });
    const missed = await c.proxy(laptop, "launch", undefined, { method: "POST" });
    expect(!missed.ok && missed.reason).toBe(`launch: timed out after ${DEFAULT_CREW_TIMEOUT_MS}ms`);
    const landed = await c.proxy(laptop, "launch", undefined, { method: "POST" }, WRITE_BUDGET_MS);
    expect(landed.ok).toBe(true);
    expect(landed.ok && landed.status).toBe(200);
  }, 10_000);
});

