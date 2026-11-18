import { describe, expect, it } from "vitest";

import { FloatClock } from "./float-clock";
import { FLOAT_AWAY_CAP_MS, OnceQueue } from "./float";

describe("the play clock of a stay picture", () => {
  it("runs from the first frame, stops while the picture is away, and carries on where it stopped", () => {
    const clock = new FloatClock();
    clock.resume("k", "a", 1000);
    expect(clock.positionOf("k", "a", 1500)).toBe(500);
    clock.pause("k", "a", 1500);
    expect(clock.positionOf("k", "a", 20_000)).toBe(500);
    clock.resume("k", "a", 20_000);
    expect(clock.positionOf("k", "a", 20_100)).toBe(600);
  });

  it("is over once the picture was away longer than the cap, and not before", () => {
    const clock = new FloatClock();
    clock.resume("k", "a", 0);
    clock.pause("k", "a", 400);
    expect(clock.positionOf("k", "a", 400 + FLOAT_AWAY_CAP_MS)).toBe(400);
    expect(clock.positionOf("k", "a", 401 + FLOAT_AWAY_CAP_MS)).toBe(Number.POSITIVE_INFINITY);
    clock.resume("k", "a", 401 + FLOAT_AWAY_CAP_MS);
    expect(clock.positionOf("k", "a", 500 + FLOAT_AWAY_CAP_MS)).toBe(Number.POSITIVE_INFINITY);
  });

  it("starts over for a changed value, and a resume while it runs changes nothing", () => {
    const clock = new FloatClock();
    clock.resume("k", "a", 0);
    clock.resume("k", "a", 300);
    expect(clock.positionOf("k", "a", 400)).toBe(400);
    clock.resume("k", "b", 500);
    expect(clock.positionOf("k", "b", 600)).toBe(100);
    expect(clock.positionOf("k", "a", 600)).toBe(0);
  });

  it("drops the clock of a part that has left", () => {
    const clock = new FloatClock();
    clock.resume("k", "a", 0);
    clock.resume("j", "a", 0);
    clock.retain(new Set(["j"]));
    expect(clock.positionOf("k", "a", 50)).toBe(0);
    expect(clock.positionOf("j", "a", 50)).toBe(50);
  });
});

describe("a shot the layer was away from", () => {
  it("plays again whatever the rate says, and not while another shot is on screen", () => {
    const queue = new OnceQueue<{ trick: string }>(() => 0);
    const shot = { trick: "t" };
    expect(queue.offer(shot)).toBe("play");
    queue.cancel();
    expect(queue.offer(shot)).toBe("drop");
    expect(queue.resume(shot)).toBe(true);
    expect(queue.resume({ trick: "u" })).toBe(false);
  });
});
