import { describe, expect, test } from "bun:test";

import { SttCancelledError, createSttDeadline } from "./provider.ts";

describe("createSttDeadline", () => {
  test("cancellation stops waiting while still observing a later phase rejection", async () => {
    const caller = new AbortController();
    const deadline = createSttDeadline(caller.signal);
    let rejectPhase: (reason?: Error) => void = () => {};
    const phase = new Promise<never>((_resolve, reject) => {
      rejectPhase = reject;
    });

    try {
      const waiting = deadline.wait(phase);
      caller.abort();
      await expect(waiting).rejects.toBeInstanceOf(SttCancelledError);

      // The race has settled, but the phase has not. A missing rejection handler here would become
      // an unhandled rejection on this turn.
      rejectPhase(new Error("late phase failure"));
      await Bun.sleep(0);
    } finally {
      deadline.close();
    }
  });

  test("an already-cancelled caller still observes a rejected phase", async () => {
    const caller = new AbortController();
    caller.abort();
    const deadline = createSttDeadline(caller.signal);
    const rejected = Promise.reject(new Error("phase failed"));

    try {
      await expect(deadline.wait(rejected)).rejects.toBeInstanceOf(SttCancelledError);
      await Bun.sleep(0);
    } finally {
      deadline.close();
    }
  });

  test("cancellation at a phase boundary still observes that phase's rejection", async () => {
    const caller = new AbortController();
    const deadline = createSttDeadline(caller.signal);
    const rejected = Promise.reject(new Error("body read failed"));
    caller.abort();

    try {
      await expect(deadline.wait(rejected)).rejects.toBeInstanceOf(SttCancelledError);
      await Bun.sleep(0);
    } finally {
      deadline.close();
    }
  });
});
