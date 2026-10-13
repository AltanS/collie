import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, as mux-capability-host.test.tsx does: what these cases are about is WHICH
// session was asked and HOW OFTEN.
vi.mock("@/lib/api", () => ({ fetchConfig: vi.fn() }));

import { fetchConfig } from "@/lib/api";
import { __resetOperatorCommands } from "./operator-config";
import { paneGridOf, settleSessionCapabilities, useMuxCapability } from "./mux-capability";
import { noteSessionCards } from "./session-cards";
import type { BridgeConfig, MuxConfig, SessionSummary } from "./types";

// Capabilities per session card (M55 spec 02). The rules:
//
//   • **No session on the scope is the primary**, and the primary keeps today's one read: nothing
//     with a session name reaches the wire.
//   • **A card with `caps` answers for its session**, and nothing is fetched for it.
//   • **A card without `caps` falls back to `/api/config?session=<name>`**, once per (host, session).

const asked = vi.mocked(fetchConfig);

function cfg(over: Partial<MuxConfig> = {}): MuxConfig {
  return { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {}, ...over };
}

function body(mux: MuxConfig | undefined): BridgeConfig {
  const wire: BridgeConfig = { push: false, vapidPublicKey: "" };
  if (mux !== undefined) wire.mux = mux;
  return wire;
}

const leadBlock = cfg({ name: "lead-mux", capabilities: { paneGrid: true, createSpace: true } });
const fetchedBlock = cfg({ name: "fetched-mux", capabilities: { paneGrid: false, createSpace: false } });

/** The lead's read answers with its block; a session read answers with `fetchedBlock`. */
function serve(): void {
  __resetOperatorCommands();
  asked.mockReset();
  asked.mockImplementation((scope) => Promise.resolve(body(scope?.session === undefined ? leadBlock : fetchedBlock)));
}

function session(over: Partial<SessionSummary> & { name: string }): SessionSummary {
  return { isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0, ...over };
}

const PRIMARY = session({ name: "default", isPrimary: true, kind: "terminal", mux: "lead-mux", caps: { paneGrid: true } });
const DESK = session({
  name: "desk",
  kind: "program",
  mux: "support-desk",
  caps: { paneGrid: false, createSpace: false },
  where: "local",
  state: "ready",
  experimental: true,
});

const sessionCalls = () => asked.mock.calls.filter((c) => c[0]?.session !== undefined);

describe("useMuxCapability: capabilities per session card", () => {
  it("no session asks the lead once, and puts no session on the wire", async () => {
    serve();
    noteSessionCards([PRIMARY, DESK], undefined);
    const { result } = renderHook(() => useMuxCapability("paneGrid"));
    await waitFor(() => expect(result.current.mux).toBe("lead-mux"));
    expect(result.current.capable).toBe(true);
    expect(sessionCalls()).toHaveLength(0);
  });

  it("a program session's card answers for it, with no fetch", async () => {
    serve();
    noteSessionCards([PRIMARY, DESK], undefined);
    const { result } = renderHook(() => useMuxCapability("paneGrid", { session: "desk" }));
    await waitFor(() => expect(result.current.mux).toBe("support-desk"));
    expect(result.current.capable).toBe(false);
    expect(sessionCalls()).toHaveLength(0);
  });

  it("the primary session named outright still reads the lead's block", async () => {
    serve();
    noteSessionCards([PRIMARY, DESK], undefined);
    const { result } = renderHook(() => useMuxCapability("createSpace", { session: "default" }));
    await waitFor(() => expect(result.current.mux).toBe("lead-mux"));
    expect(sessionCalls()).toHaveLength(0);
  });

  it("a card with no capability set falls back to the fetch, once per session", async () => {
    serve();
    noteSessionCards([PRIMARY, session({ name: "old" })], undefined);
    const a = renderHook(() => useMuxCapability("paneGrid", { session: "old" }));
    renderHook(() => useMuxCapability("createSpace", { session: "old" }));
    await waitFor(() => expect(a.result.current.mux).toBe("fetched-mux"));
    expect(a.result.current.capable).toBe(false);
    expect(sessionCalls()).toHaveLength(1);
    expect(asked).toHaveBeenCalledWith({ host: undefined, session: "old" });
  });

  it("caches per (host, session): two sessions are two reads, a second ask of either is none", async () => {
    serve();
    const first = renderHook(() => useMuxCapability("paneGrid", { session: "one" }));
    const second = renderHook(() => useMuxCapability("paneGrid", { session: "two" }));
    await waitFor(() => expect(first.result.current.mux).toBe("fetched-mux"));
    await waitFor(() => expect(second.result.current.mux).toBe("fetched-mux"));
    renderHook(() => useMuxCapability("createSpace", { session: "one" }));
    await waitFor(() => expect(sessionCalls()).toHaveLength(2));
    expect(sessionCalls().map((c) => c[0]?.session).toSorted()).toEqual(["one", "two"]);
  });

  it("a card that arrives after the fetch takes over", async () => {
    serve();
    const { result } = renderHook(() => useMuxCapability("paneGrid", { session: "desk" }));
    await waitFor(() => expect(result.current.mux).toBe("fetched-mux"));
    act(() => noteSessionCards([PRIMARY, DESK], undefined));
    await waitFor(() => expect(result.current.mux).toBe("support-desk"));
  });

  it("a lead spelled by its member id finds the lead's cards", async () => {
    serve();
    const servers = [{ id: "bluefin", name: "bluefin", isLead: true, reachable: true, protocol: "ok" as const, lastSeenAt: 1 }];
    noteSessionCards([{ ...PRIMARY, host: "bluefin" }, { ...DESK, host: "bluefin" }], servers);
    expect(paneGridOf({ host: "bluefin", session: "desk" })).toBe(false);
  });
});

describe("paneGridOf and settleSessionCapabilities: the loader's view", () => {
  it("paneGridOf answers a program session off its card", () => {
    serve();
    noteSessionCards([PRIMARY, DESK], undefined);
    expect(paneGridOf({ session: "desk" })).toBe(false);
    expect(paneGridOf({})).toBe(true);
  });

  it("settle reads a session no snapshot described yet, and then paneGridOf answers", async () => {
    serve();
    await settleSessionCapabilities({ session: "desk" });
    expect(sessionCalls()).toHaveLength(1);
    expect(paneGridOf({ session: "desk" })).toBe(false);
  });

  it("settle asks nothing for the primary or for a session a card already describes", async () => {
    serve();
    noteSessionCards([PRIMARY, DESK], undefined);
    await settleSessionCapabilities({});
    await settleSessionCapabilities({ session: "desk" });
    expect(asked).not.toHaveBeenCalled();
  });
});
