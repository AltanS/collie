import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { useServerDiagnostics } from "./use-server-diagnostics";

// One read of /api/config feeds both diagnostics rows, so the System page never fetches it twice.
describe("useServerDiagnostics", () => {
  it("reports the build and the masking switch from a single request", async () => {
    let reads = 0;
    server.use(
      http.get("/api/config", () => {
        reads += 1;
        return HttpResponse.json({ push: false, vapidPublicKey: "", build: "abc1234", redact: false });
      }),
    );
    const { result } = renderHook(() => useServerDiagnostics());
    expect(result.current).toEqual({ build: undefined, redact: undefined });
    await waitFor(() => expect(result.current).toEqual({ build: "abc1234", redact: false }));
    expect(reads).toBe(1);
  });

  it("leaves the switch unknown for a bridge older than the field", async () => {
    server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", build: "old" })));
    const { result } = renderHook(() => useServerDiagnostics());
    await waitFor(() => expect(result.current.build).toBe("old"));
    expect(result.current.redact).toBeUndefined();
  });

  it("stays unknown when the bridge cannot be read", async () => {
    server.use(http.get("/api/config", () => HttpResponse.error()));
    const { result } = renderHook(() => useServerDiagnostics());
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current).toEqual({ build: undefined, redact: undefined });
  });
});
