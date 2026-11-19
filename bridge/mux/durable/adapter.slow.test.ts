// The slow cases of adapter.test.ts: each waits more than a second on a real clock or a real process. The quick
// gate (`bun run gate`) leaves a `*.slow.test.*` file out; a full run keeps it.

import { afterEach, describe, expect, test } from "bun:test";
import type { MuxOutcome, MuxSnapshot } from "../types.ts";
import { DurableMux, MIN_SNAPSHOT_GAP_MS } from "./adapter.ts";
import { FakeDurableClock, FakeDurableProgram } from "./fixture.ts";

const programs: FakeDurableProgram[] = [];

interface Rig {
  readonly program: FakeDurableProgram;
  readonly adapter: DurableMux;
  readonly clock: FakeDurableClock;
  /** Move past the 250 ms floor, so the next read goes to the program. */
  tick(): void;
}

async function rig(): Promise<Rig> {
  const program = await FakeDurableProgram.startWire();
  programs.push(program);
  const clock = new FakeDurableClock();
  const adapter = new DurableMux(program.wire(), clock);
  return { program, adapter, clock, tick: () => clock.advance(MIN_SNAPSHOT_GAP_MS) };
}

afterEach(async () => {
  for (const program of programs.splice(0)) await program.close();
});

/** A refusal's reason and detail, or the word `ok`. */
function verdict(outcome: MuxOutcome<MuxSnapshot>): string {
  return outcome.ok ? "ok" : `${outcome.reason}: ${outcome.detail}`;
}

describe("the service name and the hysteresis", () => {
  test("one failed read keeps the last layout; the second in a row is unreachable", async () => {
    const { adapter, program, tick } = await rig();
    expect(verdict(await adapter.poll())).toBe("ok");
    // The program stops answering, but keeps its socket.
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    const first = await adapter.poll();
    expect(verdict(first)).toBe("ok");
    expect(first.ok && first.value.panes.length).toBeGreaterThan(0);
    tick();
    expect(verdict(await adapter.poll())).toStartWith("unreachable: no answer within");
    // It answers again: one good read is enough to come back, and the count starts over.
    program.override = null;
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    expect(verdict(await adapter.poll())).toBe("ok");
  }, 10_000);

  test("a held layout keeps its open asks across one dropped read, and the second drop clears them", async () => {
    const { adapter, program, tick } = await rig();
    await adapter.snapshot();
    const asks = adapter.openAsks("conv-02");
    expect(asks).toHaveLength(1);
    program.override = () => new Promise<Response>(() => undefined);
    tick();
    const held = await adapter.poll();
    expect(verdict(held)).toBe("ok");
    expect(held.ok && held.value.panes.find((pane) => pane.paneId === "conv-02")?.status).toBe("blocked");
    expect(adapter.openAsks("conv-02")).toEqual(asks);
    expect(adapter.program()?.snapshot.panes.find((pane) => pane.id === "conv-02")?.openAsks).toHaveLength(1);
    tick();
    expect(verdict(await adapter.poll())).toStartWith("unreachable: no answer within");
    expect(adapter.openAsks("conv-02")).toBeUndefined();
    expect(adapter.program()).toBeNull();
  }, 10_000);
});
