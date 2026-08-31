import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { server } from "../test/setup";
import {
  __resetOperatorBusy,
  beginBusy,
  isBusy,
  isOperatorBusy,
  trackBusy,
  useBusy,
  useBusyWhile,
  useOperatorBusy,
} from "./busy";
import * as api from "./api";

// The busy signal must always settle back to idle between tests (a leaked count would make later
// assertions flap). Every test below awaits its in-flight work, so this is a guard, not a crutch.
afterEach(() => {
  expect(isBusy()).toBe(false);
  expect(isOperatorBusy()).toBe(false);
  __resetOperatorBusy();
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

// ── THE ORBIT'S CHANNEL ────────────────────────────────────────────────────────────────────────
//
// A second counter in the same file, and the cases below pin the two properties that keep it from
// becoming the bar's: an idempotent release (so an effect cleanup that runs twice cannot drive the
// count negative and stick the orbit OFF), and complete independence from the bar's own signals —
// the 1.5s background poll must never reach it.
describe("beginBusy — the operator-work counter", () => {
  it("counts an interval of work, and rests once it is released", () => {
    expect(isOperatorBusy()).toBe(false);
    const release = beginBusy();
    expect(isOperatorBusy()).toBe(true);
    release();
    expect(isOperatorBusy()).toBe(false);
  });

  // The release is a React effect cleanup at every call site, and a remount under StrictMode runs a
  // cleanup for an increment it already released. A plain decrement would go negative, and a
  // negative counter never returns to zero — a permanently DARK orbit, which is the worse failure.
  it("releases exactly once however many times the release is called", () => {
    const release = beginBusy();
    release();
    release();
    release();
    expect(isOperatorBusy()).toBe(false);

    // Still able to count from zero afterwards — the extra calls left no debt behind.
    const again = beginBusy();
    expect(isOperatorBusy()).toBe(true);
    again();
    expect(isOperatorBusy()).toBe(false);
  });

  it("nests, so concurrent work rests only on the LAST release", () => {
    const a = beginBusy();
    const b = beginBusy();
    expect(isOperatorBusy()).toBe(true);
    a();
    expect(isOperatorBusy()).toBe(true);
    b();
    expect(isOperatorBusy()).toBe(false);
  });

  // The whole reason this counter exists rather than reusing the bar's: the poll runs every 1.5s, so
  // an orbit fed from it would never come to rest.
  it("is untouched by the bar's own signals — a tracked mutation and a stalled poll", async () => {
    let release!: () => void;
    const p = trackBusy(new Promise<void>((r) => (release = r)));
    expect(isBusy()).toBe(true);
    expect(isOperatorBusy()).toBe(false);
    release();
    await p;
  });
});

describe("useBusyWhile / useOperatorBusy", () => {
  it("holds the orbit open for exactly as long as the flag is true", () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => {
        useBusyWhile(active);
        return useOperatorBusy();
      },
      { initialProps: { active: false } },
    );
    expect(result.current).toBe(false);

    rerender({ active: true });
    expect(result.current).toBe(true);
    expect(isOperatorBusy()).toBe(true);

    rerender({ active: false });
    expect(result.current).toBe(false);
    expect(isOperatorBusy()).toBe(false);
  });

  // A pane switch unmounts the composer mid-send. Without the cleanup the count would be stranded
  // and the orbit would spin for the rest of the session.
  it("releases on unmount, so work that never finished cannot strand the orbit", () => {
    const { unmount } = renderHook(() => useBusyWhile(true));
    expect(isOperatorBusy()).toBe(true);
    unmount();
    expect(isOperatorBusy()).toBe(false);
  });
});
