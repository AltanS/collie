import { afterEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { __resetOperatorCommands } from "@/lib/operator-config";
import type { MuxConfig, MuxTopologyLatency } from "@/lib/types";
import { SyncStamp, syncAge } from "./sync-stamp";

// The line is DECLARATION-DRIVEN, and both directions matter. Under a pushing multiplexer it must
// render nothing at all — a freshness counter there is anxiety about a state that does not occur —
// and under a bounded one it must render, because that state does occur and the operator is the one
// who has to decide whether to trust the screen (ADR 0031).
//
// The mux name is fabricated throughout, as it is in mux-gated-controls.test.tsx and for the same
// reason: if this line could be made to appear by the NAME, every case below would still pass while
// the app had quietly re-welded itself to one multiplexer.

/** The store caches one successful read for the life of the page; each case gets its own page. */
afterEach(() => __resetOperatorCommands());

function declares(topologyLatency?: MuxTopologyLatency): void {
  const mux: MuxConfig = { name: "reference", capabilities: {}, unsupportedKeys: [], notes: {} };
  if (topologyLatency !== undefined) mux.topologyLatency = topologyLatency;
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

const NOW = 1_700_000_000_000;

describe("syncAge — a snapshot's age, in the register that names seconds", () => {
  it("names the seconds, which is the whole reason this is not `timeAgoShort`", () => {
    expect(syncAge(NOW - 4000, NOW)).toBe("4s");
    expect(syncAge(NOW, NOW)).toBe("0s");
  });

  it("hands over to the shared compact form once a minute has passed", () => {
    expect(syncAge(NOW - 90_000, NOW)).toBe("1m");
    expect(syncAge(NOW - 2 * 3_600_000, NOW)).toBe("2h");
  });

  it("a snapshot stamped in the future reads as zero, never as a negative age", () => {
    expect(syncAge(NOW + 5000, NOW)).toBe("0s");
  });
});

describe("SyncStamp — it speaks only where the bridge said freshness is bounded", () => {
  it("renders the age under a bounded declaration", async () => {
    declares({ kind: "bounded", ms: 12_000 });
    render(<SyncStamp ts={Date.now() - 4000} />);
    await waitFor(() => expect(screen.getByText(/synced/i)).toBeInTheDocument());
    expect(screen.getByText(/synced 4s ago/i)).toBeInTheDocument();
  });

  it("renders NOTHING under a pushing declaration — there is nothing to reassure anybody about", async () => {
    declares({ kind: "push" });
    const { container } = render(<SyncStamp ts={Date.now() - 4000} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing for a bridge that never spoke — absence reads as push", async () => {
    declares();
    const { container } = render(<SyncStamp ts={Date.now() - 4000} />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("renders nothing with no snapshot stamp to age, rather than a placeholder", async () => {
    declares({ kind: "bounded", ms: 12_000 });
    const { container } = render(<SyncStamp />);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });
});
