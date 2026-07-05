import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { server } from "../test/setup";
import { isBusy, trackBusy, useBusy } from "./busy";
import * as api from "./api";

// The busy signal must always settle back to idle between tests (a leaked count would make later
// assertions flap). Every test below awaits its in-flight work, so this is a guard, not a crutch.
afterEach(() => {
  expect(isBusy()).toBe(false);
});

describe("trackBusy — counter semantics", () => {
  it("is busy while a tracked promise is pending, idle once it resolves", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = trackBusy(gate);
    expect(isBusy()).toBe(true);
    release();
    await p;
    expect(isBusy()).toBe(false);
  });

  it("decrements even when the tracked promise REJECTS", async () => {
    const p = trackBusy(Promise.reject(new Error("boom")));
    expect(isBusy()).toBe(true);
    await expect(p).rejects.toThrow("boom");
    expect(isBusy()).toBe(false);
  });

  it("nests: stays busy until the LAST concurrent mutation settles", async () => {
    let releaseA!: () => void;
    let releaseB!: () => void;
    const a = trackBusy(new Promise<void>((r) => (releaseA = r)));
    const b = trackBusy(new Promise<void>((r) => (releaseB = r)));
    expect(isBusy()).toBe(true);
    releaseA();
    await a;
    expect(isBusy()).toBe(true); // b still in flight
    releaseB();
    await b;
    expect(isBusy()).toBe(false);
  });
});

describe("useBusy — reflects transitions", () => {
  it("re-renders from false → true → false around a tracked promise", async () => {
    const { result } = renderHook(() => useBusy());
    expect(result.current).toBe(false);

    let release!: () => void;
    let p!: Promise<void>;
    // Wrap the store mutation in act() so React flushes the useSyncExternalStore re-render.
    act(() => {
      p = trackBusy(new Promise<void>((r) => (release = r)));
    });
    expect(result.current).toBe(true);
    await act(async () => {
      release();
      await p;
    });
    expect(result.current).toBe(false);
  });
});

describe("api wiring — mutations tracked, reads not", () => {
  it("POST /reply is tracked (busy the instant it fires, idle after)", async () => {
    const p = api.sendReply("w1:p1", "hi");
    expect(isBusy()).toBe(true); // trackBusy increments synchronously inside req()
    await p;
    expect(isBusy()).toBe(false);
  });

  it("POST /keys and POST /tab are tracked", async () => {
    const keys = api.sendKeys("w1:p1", ["1"]);
    expect(isBusy()).toBe(true);
    await keys;
    const tab = api.createTab("w2");
    expect(isBusy()).toBe(true);
    await tab;
    expect(isBusy()).toBe(false);
  });

  it("multipart upload is tracked", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () =>
        HttpResponse.json({ ok: true, path: "/uploads/x.png" }),
      ),
    );
    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const up = api.uploadImage("w1:p1", file);
    expect(isBusy()).toBe(true);
    await up;
    expect(isBusy()).toBe(false);
  });

  it("GET /snapshot and GET /config are NOT tracked", async () => {
    const snap = api.fetchSnapshot();
    expect(isBusy()).toBe(false);
    const cfg = api.fetchConfig();
    expect(isBusy()).toBe(false);
    await Promise.all([snap, cfg]);
    expect(isBusy()).toBe(false);
  });
});
