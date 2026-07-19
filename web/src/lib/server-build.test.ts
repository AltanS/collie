import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { server } from "../test/setup";
import { fixtureSnapshot } from "../test/handlers";
import * as api from "./api";
import {
  __resetServerBuild,
  getServerBuild,
  observeServerBuild,
  subscribeServerBuild,
  useServerBuild,
} from "./server-build";

afterEach(() => __resetServerBuild());

describe("observeServerBuild — store semantics", () => {
  it("records a real id, and an absent header (null) is a no-op that never clobbers", () => {
    expect(getServerBuild()).toBeUndefined();
    observeServerBuild("0.13.0+abc.1");
    expect(getServerBuild()).toBe("0.13.0+abc.1");
    observeServerBuild(null); // older bridge — no X-Collie-Build header
    expect(getServerBuild()).toBe("0.13.0+abc.1"); // left as-is, not reset to undefined
  });

  it("notifies subscribers on EVERY observation, repeats included (hysteresis depends on it)", () => {
    let hits = 0;
    const unsub = subscribeServerBuild(() => hits++);
    observeServerBuild("a");
    observeServerBuild("a"); // a repeat still fires — the self-updater counts consecutive sightings
    observeServerBuild("b");
    observeServerBuild(null); // absent header does not fire
    expect(hits).toBe(3);
    unsub();
  });
});

describe("header capture through the api fetch wrapper (MSW exposes the response header)", () => {
  it("captures X-Collie-Build off a snapshot poll", async () => {
    server.use(
      http.get("/api/snapshot", () =>
        HttpResponse.json(fixtureSnapshot, { headers: { "x-collie-build": "0.13.0+srv.9" } }),
      ),
    );
    await api.fetchSnapshot();
    expect(getServerBuild()).toBe("0.13.0+srv.9");
  });

  it("captures the header off a pane poll too", async () => {
    server.use(
      http.get(/\/api\/pane\/[^/]+$/, () =>
        HttpResponse.json(
          { paneId: "w1:p1", text: "x", truncated: false, revision: 1 },
          { headers: { "x-collie-build": "0.13.0+pane.3" } },
        ),
      ),
    );
    await api.fetchPane("w1:p1");
    expect(getServerBuild()).toBe("0.13.0+pane.3");
  });

  it("leaves the store undefined when the bridge sends no header (graceful older-bridge fallback)", async () => {
    await api.fetchSnapshot(); // default handler sets no x-collie-build header
    expect(getServerBuild()).toBeUndefined();
  });
});

describe("useServerBuild — reactive read", () => {
  it("re-renders when a new id is observed", () => {
    const { result } = renderHook(() => useServerBuild());
    expect(result.current).toBeUndefined();
    act(() => observeServerBuild("v2"));
    expect(result.current).toBe("v2");
  });
});
