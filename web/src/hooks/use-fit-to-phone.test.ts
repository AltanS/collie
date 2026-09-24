import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fitPane, unfitPane } from "@/lib/api";
import type { FitSize } from "@/lib/fit-grid";
import { clearStatus, useStatus } from "@/lib/status";
import type { FitResponse } from "@/lib/types";
import { FIT_RENEW_MS, FIT_RESIZE_SETTLE_MS, useFitToPhone } from "./use-fit-to-phone";

// The lease's whole life, against a mocked wire. What this hook owes ADR 0049, in the order a test
// below proves it: it fits only when asked; it renews while the view is live and only EXTENDS when it
// does; a lapse ends it quietly and is never answered with a re-take; a hidden page or a suspended
// view pauses the renewals and releases nothing; coming back renews at once; and leaving the view,
// or Release, lets go — including of a take that was still on the wire when the operator let go.
//
// `fitPane`/`unfitPane` are mocked and the rest of the API module is the real one, so the hook's
// refusal reading (`apiErrorFields`) runs as it does in the app.
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  fitPane: vi.fn(),
  unfitPane: vi.fn(),
}));

const fit = vi.mocked(fitPane);
const unfit = vi.mocked(unfitPane);

const granted = (size: FitSize): FitResponse => ({ ok: true, ...size, lapseMs: 120_000 });
const refused = (code: "pane.fit_busy" | "pane.fit_lapsed"): FitResponse => ({
  ok: false,
  error: code,
  code,
});

/** The calls made with `renew: true`, and the ones without. */
const renewals = () => fit.mock.calls.filter((call) => call[3] === true);
const takes = () => fit.mock.calls.filter((call) => call[3] !== true);

let visibility: DocumentVisibilityState = "visible";
function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

interface Props {
  paneId: string;
  size: FitSize | null;
  suspended: boolean;
}

function mount(initial: Partial<Props> = {}) {
  const props: Props = { paneId: "w1:p1", size: { cols: 48, rows: 36 }, suspended: false, ...initial };
  return renderHook(
    (p: Props) => ({
      fitter: useFitToPhone({ paneId: p.paneId, measure: () => p.size, suspended: p.suspended }),
      status: useStatus(),
    }),
    { initialProps: props },
  );
}

/** Let the timers and the promise chains they start run to rest. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe("useFitToPhone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fit.mockReset();
    unfit.mockReset();
    fit.mockImplementation(async (_pane, size) => granted(size));
    unfit.mockResolvedValue({ ok: true });
    visibility = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    act(() => clearStatus());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing on its own: no fit on mount, and none on becoming visible", async () => {
    mount();
    setVisibility("hidden");
    setVisibility("visible");
    await advance(FIT_RENEW_MS * 3);
    expect(fit).not.toHaveBeenCalled();
    expect(unfit).not.toHaveBeenCalled();
  });

  it("takes a lease at the measured size on the tap, then renews it on the cadence", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    expect(takes()).toEqual([["w1:p1", { cols: 48, rows: 36 }, undefined, false]]);
    expect(result.current.fitter.phase).toEqual({ kind: "fitted", cols: 48, rows: 36 });

    await advance(FIT_RENEW_MS - 1);
    expect(renewals()).toHaveLength(0);
    await advance(1);
    expect(renewals()).toEqual([["w1:p1", { cols: 48, rows: 36 }, undefined, true]]);
    await advance(FIT_RENEW_MS);
    expect(renewals()).toHaveLength(2);
    // Renewals never take: the only take is the tap's.
    expect(takes()).toHaveLength(1);
  });

  it("clamps the measured size into the bridge's bounds before sending it", async () => {
    const { result } = mount({ size: { cols: 12, rows: 3 } });
    await act(async () => {
      await result.current.fitter.fit();
    });
    expect(takes()[0]?.[1]).toEqual({ cols: 20, rows: 8 });
  });

  it("drops to idle SILENTLY when a renewal finds the lease lapsed, and never re-takes it", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    fit.mockResolvedValue(refused("pane.fit_lapsed"));
    await advance(FIT_RENEW_MS);
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(result.current.status).toBeNull();
    await advance(FIT_RENEW_MS * 4);
    expect(fit).toHaveBeenCalledTimes(2); // the take and the one renewal that found it gone
  });

  it("keeps the lease through a transient renewal failure and tries again next round", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    fit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await advance(FIT_RENEW_MS);
    expect(result.current.fitter.phase.kind).toBe("fitted");
    expect(result.current.status).toBeNull();
    await advance(FIT_RENEW_MS);
    expect(renewals()).toHaveLength(2);
  });

  it("follows a changed mirror with a take AFTER the renewal proves the lease is still held", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.fitter.fit();
    });
    // The phone rotated: the mirror is now wider and shorter.
    hook.rerender({ paneId: "w1:p1", size: { cols: 96, rows: 20 }, suspended: false });
    await advance(FIT_RENEW_MS);
    expect(renewals()).toHaveLength(1);
    expect(takes()).toEqual([
      ["w1:p1", { cols: 48, rows: 36 }, undefined, false],
      ["w1:p1", { cols: 96, rows: 20 }, undefined, false],
    ]);
    expect(hook.result.current.fitter.phase).toEqual({ kind: "fitted", cols: 96, rows: 20 });
  });

  it("follows a new WIDTH as soon as it settles, without waiting for the renewal", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.fitter.fit();
    });
    hook.rerender({ paneId: "w1:p1", size: { cols: 96, rows: 36 }, suspended: false });
    act(() => hook.result.current.fitter.noteResize());
    await advance(FIT_RESIZE_SETTLE_MS);
    expect(takes().at(-1)?.[1]).toEqual({ cols: 96, rows: 36 });
  });

  it("leaves a height-only change (the soft keyboard) for the next renewal", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.fitter.fit();
    });
    hook.rerender({ paneId: "w1:p1", size: { cols: 48, rows: 18 }, suspended: false });
    act(() => hook.result.current.fitter.noteResize());
    await advance(FIT_RESIZE_SETTLE_MS);
    expect(fit).toHaveBeenCalledTimes(1);
  });

  it("stops renewing while the page is hidden, releases nothing, and renews at once on return", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    act(() => setVisibility("hidden"));
    await advance(FIT_RENEW_MS * 3);
    expect(renewals()).toHaveLength(0);
    expect(unfit).not.toHaveBeenCalled();
    expect(result.current.fitter.phase.kind).toBe("fitted");

    act(() => setVisibility("visible"));
    await advance(0);
    expect(renewals()).toHaveLength(1);
    // …and the cadence picks up again from there.
    await advance(FIT_RENEW_MS);
    expect(renewals()).toHaveLength(2);
  });

  it("goes idle when the renewal on return finds the lease lapsed in the pocket", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    act(() => setVisibility("hidden"));
    await advance(FIT_RENEW_MS * 5);
    fit.mockResolvedValue(refused("pane.fit_lapsed"));
    act(() => setVisibility("visible"));
    await advance(0);
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(takes()).toHaveLength(1);
  });

  it("pauses the same way while the view is suspended (idle pause, read-only, gone pane)", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.fitter.fit();
    });
    hook.rerender({ paneId: "w1:p1", size: { cols: 48, rows: 36 }, suspended: true });
    await advance(FIT_RENEW_MS * 3);
    expect(renewals()).toHaveLength(0);
    expect(unfit).not.toHaveBeenCalled();
    hook.rerender({ paneId: "w1:p1", size: { cols: 48, rows: 36 }, suspended: false });
    await advance(0);
    expect(renewals()).toHaveLength(1);
  });

  it("releases on unmount — leaving the pane view — without waiting for the answer", async () => {
    const hook = mount();
    await act(async () => {
      await hook.result.current.fitter.fit();
    });
    hook.unmount();
    expect(unfit).toHaveBeenCalledWith("w1:p1", undefined);
    await advance(FIT_RENEW_MS * 2);
    expect(renewals()).toHaveLength(0);
  });

  it("sends no release on leaving a pane that was never fitted", () => {
    mount().unmount();
    expect(unfit).not.toHaveBeenCalled();
  });

  it("releases on the Release control and stops renewing", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    act(() => result.current.fitter.release());
    expect(unfit).toHaveBeenCalledTimes(1);
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    await advance(FIT_RENEW_MS * 2);
    expect(renewals()).toHaveLength(0);
  });

  it("lets go again of a take that lands after its release", async () => {
    let answer!: (r: FitResponse) => void;
    fit.mockImplementationOnce(() => new Promise<FitResponse>((resolve) => (answer = resolve)));
    const { result } = mount();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.fitter.fit();
    });
    expect(result.current.fitter.phase).toEqual({ kind: "fitting" });
    act(() => result.current.fitter.release());
    expect(unfit).toHaveBeenCalledTimes(1);
    await act(async () => {
      answer(granted({ cols: 48, rows: 36 }));
      await pending;
    });
    expect(unfit).toHaveBeenCalledTimes(2);
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
  });

  it("refuses and explains when another device controls the terminal's size", async () => {
    fit.mockResolvedValue(refused("pane.fit_busy"));
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(result.current.status).toMatchObject({
      tone: "error",
      text: "Another device or tool is controlling this terminal's size. Try again after it lets go.",
    });
  });

  it("says so, once, when a renewal loses the terminal to another controller", async () => {
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    fit.mockResolvedValue(refused("pane.fit_busy"));
    await advance(FIT_RENEW_MS);
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(result.current.status?.tone).toBe("error");
    await advance(FIT_RENEW_MS * 2);
    expect(renewals()).toHaveLength(1);
  });

  it("reads a refusal that arrived as a thrown 400 the same way", async () => {
    fit.mockRejectedValue(new Error("boom"));
    const { result } = mount();
    await act(async () => {
      await result.current.fitter.fit();
    });
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(result.current.status).toMatchObject({ tone: "error", text: "boom" });
  });

  it("refuses to lease a size it could not measure", async () => {
    const { result } = mount({ size: null });
    await act(async () => {
      await result.current.fitter.fit();
    });
    expect(fit).not.toHaveBeenCalled();
    expect(result.current.fitter.phase).toEqual({ kind: "idle" });
    expect(result.current.status).toMatchObject({
      tone: "error",
      text: "Couldn't measure the terminal view on this phone.",
    });
  });
});
