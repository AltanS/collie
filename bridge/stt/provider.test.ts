import { describe, expect, test, vi } from "bun:test";

import { SttCancelledError, SttError, createSttDeadline } from "./provider.ts";

describe("createSttDeadline", () => {
  test("caller cancellation wins while still observing a later phase rejection", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const deadline = createSttDeadline(caller.signal, 5);
      let rejectPhase: (reason?: Error) => void = () => {};
      const phase = new Promise<never>((_resolve, reject) => {
        rejectPhase = reject;
      });

      const waiting = deadline.wait(phase);
      caller.abort();
      await expect(waiting).rejects.toBeInstanceOf(SttCancelledError);
      vi.advanceTimersByTime(5);
      expect(() => deadline.throwIfAborted()).toThrow(SttCancelledError);

      // The race has settled, but the phase has not. A missing rejection handler here would become
      // an unhandled rejection on this turn.
      rejectPhase(new Error("late phase failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a timeout wins over a later caller", async () => {
    vi.useFakeTimers();
    try {
      const caller = new AbortController();
      const deadline = createSttDeadline(caller.signal, 5);
      let rejectPhase: (reason?: Error) => void = () => {};
      const phase = new Promise<never>((_resolve, reject) => {
        rejectPhase = reject;
      });

      const waiting = deadline.wait(phase);
      vi.advanceTimersByTime(5);
      const error = await waiting.then(
        () => null,
        (err) => (err instanceof SttError ? err : null),
      );
      expect(error).toBeInstanceOf(SttError);
      expect(error?.kind).toBe("timeout");

      caller.abort();
      const stopped = (() => {
        try {
          deadline.throwIfAborted();
        } catch (err) {
          return err;
        }
        return null;
      })();
      expect(stopped).toBeInstanceOf(SttError);
      expect(stopped instanceof SttError ? stopped.kind : null).toBe("timeout");

      rejectPhase(new Error("late phase failure"));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  test("an already-cancelled caller keeps caller-first precedence and observes a rejected phase", async () => {
    const caller = new AbortController();
    const timeout = new AbortController();
    caller.abort();
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    const nativeTimeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const deadline = createSttDeadline(caller.signal, 5);
      const rejected = Promise.reject(new Error("phase failed"));

      await expect(deadline.wait(rejected)).rejects.toBeInstanceOf(SttCancelledError);
      expect(() => deadline.throwIfAborted()).toThrow(SttCancelledError);
      await Promise.resolve();
    } finally {
      nativeTimeout.mockRestore();
    }
  });

  test("a caller TimeoutError remains cancellation", () => {
    const caller = new AbortController();
    const deadline = createSttDeadline(caller.signal);
    caller.abort(new DOMException("caller deadline", "TimeoutError"));

    expect(() => deadline.throwIfAborted()).toThrow(SttCancelledError);
  });

  test("cancellation at a phase boundary still observes that phase's rejection", async () => {
    const caller = new AbortController();
    const deadline = createSttDeadline(caller.signal);
    const rejected = Promise.reject(new Error("body read failed"));
    caller.abort();

    await expect(deadline.wait(rejected)).rejects.toBeInstanceOf(SttCancelledError);
    await Bun.sleep(0);
  });

  test("wait removes its listener as soon as work settles", async () => {
    const deadline = createSttDeadline(undefined);
    const remove = vi.spyOn(deadline.signal, "removeEventListener");
    try {
      await expect(deadline.wait(Promise.resolve("done"))).resolves.toBe("done");
      expect(remove).toHaveBeenCalledTimes(1);
    } finally {
      remove.mockRestore();
    }
  });
});
