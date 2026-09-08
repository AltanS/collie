import { describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// Spied at the api seam, not over the network — what these cases are about is WHICH host was asked
// and HOW OFTEN, and a mock records both.
vi.mock("@/lib/api", () => ({ fetchConfig: vi.fn() }));

import { fetchConfig } from "@/lib/api";
import { __resetOperatorCommands } from "./operator-config";
import { useMuxCapability } from "./mux-capability";
import type { BridgeConfig, MuxConfig } from "./types";

// The REQUEST half of the per-host capability lookup (M22/03). Its rules, and the reason each one
// is a rule:
//
//   • **A scope with no host puts nothing on the wire.** A solo install can only ever produce that
//     shape, so it must never make a second request — the zero-tax contract, client side.
//   • **One read per host id, for the life of the page.** The block cannot change without that
//     member's bridge restarting, which the phone cannot miss.
//   • **A read that has not landed renders the LEAD's answer.** So does one that failed. Both are
//     "nothing said otherwise", and that means the lead's, never "every capability present".
//
// The rule that turns the two answers into one — mux-capability.ts's `scopedMuxConfig` — is asserted
// purely in mux-capability.test.ts, which is what keeps this file about the fetching alone.

const asked = vi.mocked(fetchConfig);

/** A fabricated declaration. The name is deliberately not a real multiplexer's — nothing reads it. */
function cfg(over: Partial<MuxConfig> = {}): MuxConfig {
  return { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {}, ...over };
}

/** A config body carrying one block. Only `mux` differs between the lead's answer and a member's. */
function body(mux: MuxConfig | undefined): BridgeConfig {
  const wire: BridgeConfig = { push: false, vapidPublicKey: "" };
  if (mux !== undefined) wire.mux = mux;
  return wire;
}

const leadBlock = cfg({ name: "lead-mux", capabilities: { createWorktree: false } });
const memberBlock = cfg({ name: "member-mux", capabilities: { createWorktree: true } });

/** Answer the lead's read with one block, and a named member's read with another. */
function serve(member: Record<string, MuxConfig | undefined>): void {
  __resetOperatorCommands();
  asked.mockReset();
  asked.mockImplementation((scope) =>
    Promise.resolve(body(scope?.host === undefined ? leadBlock : member[scope.host])),
  );
}

describe("useMuxCapability — which host is asked, and how often", () => {
  it("no scope asks the lead, with no host on the wire", async () => {
    serve({});
    const { result } = renderHook(() => useMuxCapability("createWorktree"));
    await waitFor(() => expect(result.current.mux).toBe("lead-mux"));
    expect(result.current.capable).toBe(false);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked).toHaveBeenLastCalledWith();
  });

  it("a scope naming a member asks that member, and answers with its declaration", async () => {
    serve({ laptop: memberBlock });
    const { result } = renderHook(() => useMuxCapability("createWorktree", { host: "laptop" }));
    await waitFor(() => expect(result.current.mux).toBe("member-mux"));
    // The capability the LEAD does not have, offered on the member that declared it.
    expect(result.current.capable).toBe(true);
    expect(asked).toHaveBeenCalledWith({ host: "laptop" });
  });

  it("a member with no block of its own ends up on the lead's answer", async () => {
    serve({ laptop: undefined });
    const { result } = renderHook(() => useMuxCapability("createWorktree", { host: "laptop" }));
    await waitFor(() => expect(asked).toHaveBeenCalledWith({ host: "laptop" }));
    await waitFor(() => expect(result.current.mux).toBe("lead-mux"));
    expect(result.current.capable).toBe(false);
  });

  it("one read per host id, however many controls ask", async () => {
    serve({ laptop: memberBlock });
    renderHook(() => useMuxCapability("createWorktree", { host: "laptop" }));
    renderHook(() => useMuxCapability("renamePane", { host: "laptop" }));
    renderHook(() => useMuxCapability("closePane", { host: "laptop" }));
    await waitFor(() => expect(asked.mock.calls.filter((c) => c[0]?.host === "laptop")).toHaveLength(1));
  });

  it("a blank host is the lead, so a normalised-away `?h=` asks nobody extra", async () => {
    // lib/scope's rule, taken rather than re-implemented: blank and whitespace-only are the lead.
    serve({});
    const { result } = renderHook(() => useMuxCapability("createWorktree", { host: "  " }));
    await waitFor(() => expect(result.current.mux).toBe("lead-mux"));
    expect(asked.mock.calls.every((c) => c[0] === undefined)).toBe(true);
  });

  it("a failed member read leaves the lead's answer standing, and is not cached", async () => {
    serve({});
    asked.mockImplementation((scope) =>
      scope?.host === undefined ? Promise.resolve(body(leadBlock)) : Promise.reject(new Error("offline")),
    );
    const first = renderHook(() => useMuxCapability("createWorktree", { host: "laptop" }));
    await waitFor(() => expect(first.result.current.mux).toBe("lead-mux"));
    expect(first.result.current.capable).toBe(false);
    first.unmount();

    const tried = asked.mock.calls.filter((c) => c[0]?.host === "laptop").length;
    renderHook(() => useMuxCapability("createWorktree", { host: "laptop" }));
    await waitFor(() =>
      expect(asked.mock.calls.filter((c) => c[0]?.host === "laptop")).toHaveLength(tried + 1),
    );
  });
});
