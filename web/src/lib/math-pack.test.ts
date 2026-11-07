import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

import { __resetDesign, designPrefs, mathEngineOf, setDesignMath } from "@/lib/design";
import { __resetMathEngines, loadMathEngine, mathEngineFailed } from "@/lib/math/engine";
import type { MathPackStatus } from "@/lib/types";
import { server } from "@/test/setup";

import {
  __resetMathPack,
  MATH_PACK_BACKOFF_MS,
  MATH_PACK_POLL_MS,
  noteMathPack,
  setWantedMathEngine,
  useMathPack,
} from "./math-pack";

// The host's pack as the phone holds it (ADR 0132). The engine below cannot load, the way a 404 under
// `/math/` leaves it after an update took the pack away.
vi.mock("@/lib/math/katex", () => {
  throw new Error("Failed to fetch dynamically imported module: http://phone.test/math/katex/katex-x.js");
});

const READY: MathPackStatus = { state: "ready", version: "1.29.0", source: "store", bytes: 3_994_976 };

let reloads = 0;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  __resetDesign();
  __resetMathEngines();
  reloads = 0;
  __resetMathPack(() => {
    reloads++;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("an engine that failed before the pack arrived", () => {
  it("reloads the page once when the pack is ready, and not again", async () => {
    setDesignMath("katex");
    expect(await loadMathEngine("katex")).toBeNull();
    expect(mathEngineFailed("katex")).toBe(true);
    noteMathPack(READY);
    expect(reloads).toBe(1);
    noteMathPack(READY);
    expect(reloads).toBe(1);
  });

  it("does not reload for an engine that has not failed, or for Off", () => {
    noteMathPack(READY);
    setDesignMath("mathjax");
    noteMathPack(READY);
    expect(reloads).toBe(0);
  });
});

describe("the engine chosen while the host had no pack", () => {
  it("becomes the choice when the pack is ready", () => {
    setWantedMathEngine("mathjax");
    noteMathPack({ state: "downloading", received: 0, total: null });
    expect(mathEngineOf(designPrefs())).toBe("off");
    noteMathPack(READY);
    expect(mathEngineOf(designPrefs())).toBe("mathjax");
  });

  it("is dropped when the download fails, so a later pack does not apply it", () => {
    setWantedMathEngine("mathjax");
    noteMathPack({ state: "absent", error: "download-failed" });
    noteMathPack(READY);
    expect(mathEngineOf(designPrefs())).toBe("off");
  });
});

describe("the poll while the host downloads", () => {
  it("never gives up after failed reads, and finds the pack once the host answers", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let answer: "fail" | MathPackStatus = "fail";
    let reads = 0;
    server.use(
      http.get("/api/math", () => {
        reads++;
        return answer === "fail" ? HttpResponse.error() : HttpResponse.json(answer);
      }),
    );
    noteMathPack({ state: "downloading", received: 1, total: 10 });
    const { result } = renderHook(() => useMathPack());
    // Well past ten failures at any pace the old poll had.
    for (let i = 0; i < 15; i++) await act(() => vi.advanceTimersByTimeAsync(MATH_PACK_BACKOFF_MS));
    expect(reads).toBeGreaterThan(10);
    answer = READY;
    await act(() => vi.advanceTimersByTimeAsync(MATH_PACK_BACKOFF_MS + MATH_PACK_POLL_MS));
    expect(result.current?.state).toBe("ready");
  });

  it("stops when the card unmounts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    let reads = 0;
    server.use(
      http.get("/api/math", () => {
        reads++;
        return HttpResponse.json({ state: "downloading", received: 1, total: 10 });
      }),
    );
    noteMathPack({ state: "downloading", received: 1, total: 10 });
    const { unmount } = renderHook(() => useMathPack());
    await act(() => vi.advanceTimersByTimeAsync(MATH_PACK_POLL_MS * 3));
    unmount();
    const after = reads;
    await act(() => vi.advanceTimersByTimeAsync(MATH_PACK_BACKOFF_MS * 3));
    expect(reads).toBe(after);
  });
});
