import { describe, expect, it } from "vitest";

import {
  activeDirection,
  cellOf,
  chordSwipe,
  DEFAULT_TUNING,
  fitCenter,
  idleGesture,
  isArmed,
  isTerminal,
  joystickTarget,
  keyAt,
  moveBy,
  navLayoutOf,
  reduceGesture,
  sameCell,
  speedOf,
  type GestureEvent,
  type GestureKind,
  type GestureState,
  type NavLayout,
  type Tuning,
} from "./pane-nav-gesture";

// Three spaces: a has four panes, b has two (its landing is b2), c has one.
const DEFS = [
  { panes: ["a1", "a2", "a3", "a4"], landing: null },
  { panes: ["b1", "b2"], landing: "b2" },
  { panes: ["c1"], landing: null },
];
/** A layout the test knows is there; a null here is a broken fixture, so it fails loudly. */
function must(layout: NavLayout | null): NavLayout {
  if (layout === null) throw new Error("no layout");
  return layout;
}
const START = must(navLayoutOf(DEFS, "a2"));
const CHORD = DEFAULT_TUNING.chord;
const STICK = DEFAULT_TUNING.stick;
const P = (x: number, y: number) => ({ x, y });

function play(kind: GestureKind, events: readonly GestureEvent[], from?: GestureState, tune: Tuning = DEFAULT_TUNING[kind]): GestureState {
  return events.reduce((s, e) => reduceGesture(s, e, tune), from ?? idleGesture(kind));
}
const down = (ms = 0, x = 100, y = 100): GestureEvent => ({ t: "down", at: P(x, y), layout: START, ms });
const move = (x: number, y: number, ms = 0): GestureEvent => ({ t: "move", at: P(x, y), ms });
const up = (x = 100, y = 100, ms = 0): GestureEvent => ({ t: "up", at: P(x, y), ms });
const second = (x: number, y: number, ms = 1000): GestureEvent => ({ t: "second-down", at: P(x, y), ms });
const swipe = (x: number, y: number, ms = 1000): GestureEvent => ({ t: "second-move", at: P(x, y), ms });

describe("the map", () => {
  it("puts the cursor on the pane on screen, and each other space on its landing", () => {
    expect(START.space).toBe(0);
    expect(START.spaces.map((s) => s.focus)).toEqual([1, 1, 0]);
    expect(keyAt(START)).toBe("a2");
  });

  it("is null for a pane that is in no space", () => {
    expect(navLayoutOf(DEFS, "zz")).toBeNull();
    expect(navLayoutOf([], "a1")).toBeNull();
  });

  it("lands on the first pane when the landing is not a pane of the space", () => {
    expect(navLayoutOf([{ panes: ["a1"], landing: null }, { panes: ["b1", "b2"], landing: "gone" }], "a1")?.spaces[1]?.focus).toBe(0);
  });

  it("steps along the space's row and between spaces, keeping each space's own focus, with no wrap", () => {
    const right = moveBy(START, { t: "pane", delta: 1 });
    expect(keyAt(right)).toBe("a3");
    const downOne = moveBy(right, { t: "space", delta: 1 });
    expect(keyAt(downOne)).toBe("b2");
    expect(keyAt(moveBy(downOne, { t: "space", delta: -1 }))).toBe("a3");
    const last = moveBy(moveBy(downOne, { t: "space", delta: 1 }), { t: "space", delta: 1 });
    expect(keyAt(last)).toBe("c1");
    expect(moveBy(last, { t: "pane", delta: 1 })).toBe(last);
    expect(moveBy(START, { t: "space", delta: -1 })).toBe(START);
    expect(moveBy(moveBy(START, { t: "pane", delta: -1 }), { t: "pane", delta: -1 })).toEqual(moveBy(START, { t: "pane", delta: -1 }));
  });
});

describe("the second finger (chord)", () => {
  const O = P(100, 100);

  it("gives no step under 40 px, and keeps the anchor", () => {
    expect(chordSwipe(O, P(130, 105), CHORD)).toEqual({ action: null, count: 0, anchor: O, by: null });
  });

  it("gives one step at 40 px, left or right, up or down", () => {
    expect(chordSwipe(O, P(145, 102), CHORD)).toMatchObject({ action: { t: "pane", delta: 1 }, count: 1, by: "travel" });
    expect(chordSwipe(O, P(55, 98), CHORD).action).toEqual({ t: "pane", delta: -1 });
    expect(chordSwipe(O, P(102, 55), CHORD).action).toEqual({ t: "space", delta: -1 });
    expect(chordSwipe(O, P(98, 145), CHORD).action).toEqual({ t: "space", delta: 1 });
  });

  it("moves the anchor on by one threshold, so the remainder is kept", () => {
    const r = chordSwipe(O, P(160, 100), CHORD);
    expect(r.count).toBe(1);
    expect(r.anchor.x).toBeCloseTo(140);
  });

  it("counts the whole length inside the 40 degree cone", () => {
    // 36 across and 19 up: 41 px long, 28 degrees off the axis.
    expect(chordSwipe(O, P(136, 81), CHORD).action).toEqual({ t: "pane", delta: 1 });
    // 35 across and 15 up: 38 px long, under the threshold.
    expect(chordSwipe(O, P(135, 85), CHORD).action).toBeNull();
  });

  it("counts a swipe outside the cone on its larger axis, never ignoring it", () => {
    // 43 degrees off: only the 44 px of the larger axis count.
    expect(chordSwipe(O, P(144, 141), CHORD)).toMatchObject({ action: { t: "pane", delta: 1 }, count: 1 });
    // 30 across and 28 down is 41 px long but 43 degrees off, so only 30 px count.
    expect(chordSwipe(O, P(130, 128), CHORD).action).toBeNull();
  });

  it("is one step unless the swipe travels twice the threshold, then a step per threshold", () => {
    expect(chordSwipe(O, P(175, 100), CHORD).count).toBe(1);
    expect(chordSwipe(O, P(180, 100), CHORD).count).toBe(2);
    expect(chordSwipe(O, P(230, 100), CHORD).count).toBe(3);
  });

  it("steps on a flick that is fast enough and long enough, and not otherwise", () => {
    const fast = [
      { x: 100, y: 100, ms: 0 },
      { x: 125, y: 100, ms: 40 },
    ];
    expect(chordSwipe(O, P(125, 100), CHORD, fast, 40)).toMatchObject({ action: { t: "pane", delta: 1 }, count: 1, by: "flick", anchor: P(125, 100) });
    const slow = [
      { x: 100, y: 100, ms: 0 },
      { x: 125, y: 100, ms: 79 },
    ];
    expect(chordSwipe(O, P(125, 100), CHORD, slow, 79).action).toBeNull();
    const short = [
      { x: 100, y: 100, ms: 0 },
      { x: 110, y: 100, ms: 10 },
    ];
    expect(chordSwipe(O, P(110, 100), CHORD, short, 10).action).toBeNull();
  });

  it("reads the speed over the last 80 ms only", () => {
    const samples = [
      { x: 0, y: 0, ms: 0 },
      { x: 50, y: 0, ms: 100 },
      { x: 52, y: 0, ms: 150 },
    ];
    expect(speedOf(samples, 150)).toBeCloseTo(0.04);
    expect(speedOf([{ x: 0, y: 0, ms: 0 }], 10)).toBe(0);
  });
});

describe("the joystick target", () => {
  it("stays put inside the dead zone", () => {
    const t = joystickTarget(START, 30, -20, STICK.stepPx);
    expect(t.axis).toBeNull();
    expect(sameCell(t.layout, START)).toBe(true);
  });

  it("takes a step at 48 px and another for each further 48 px, and comes back", () => {
    expect(keyAt(joystickTarget(START, 48, 5, 48).layout)).toBe("a3");
    expect(keyAt(joystickTarget(START, 96, 5, 48).layout)).toBe("a4");
    expect(keyAt(joystickTarget(START, -48, 5, 48).layout)).toBe("a1");
    expect(sameCell(joystickTarget(START, 10, 0, 48).layout, START)).toBe(true);
  });

  it("reads up as the previous space and down as the next, never mixing the axes", () => {
    expect(keyAt(joystickTarget(START, 5, 50, 48).layout)).toBe("b2");
    const diagonal = joystickTarget(START, 60, 100, 48);
    expect(diagonal.axis).toBe("space");
    expect(diagonal.layout.spaces[0]?.focus).toBe(1);
  });

  it("clamps at the ends but reports the signed steps", () => {
    const far = joystickTarget(START, 480, 0, 48);
    expect(keyAt(far.layout)).toBe("a4");
    expect(far.steps).toBe(10);
    expect(keyAt(joystickTarget(START, 0, 4800, 48).layout)).toBe("c1");
    expect(keyAt(joystickTarget(START, 0, -480, 48).layout)).toBe("a2");
  });
});

describe("the chord machine (Two fingers)", () => {
  const armed = () => play("chord", [down(0), { t: "hold-done" }]);

  it("idle -> holding on down, holding -> armed when the 300 ms hold ends", () => {
    expect(play("chord", [down()]).phase).toBe("holding");
    expect(armed().phase).toBe("armed");
    expect(isArmed(armed().phase)).toBe(true);
    expect(CHORD.holdMs).toBe(300);
  });

  it("tolerates 24 px of drift during the hold, and cancels past it", () => {
    expect(play("chord", [down(), move(120, 112)]).phase).toBe("holding");
    const s = play("chord", [down(), move(100, 130)]);
    expect(s.phase).toBe("cancel");
    expect(s.endedBy).toBe("moved before the hold finished");
  });

  it("cancels when the finger lifts before the hold ends", () => {
    expect(play("chord", [down(), up()]).endedBy).toBe("released before the hold finished");
  });

  it("takes a second finger within 300 ms of the first as a pinch, and never arms", () => {
    const s = play("chord", [down(1000), second(200, 300, 1100)]);
    expect(s.phase).toBe("cancel");
    expect(s.endedBy).toBe("a second finger within the pinch window is a pinch");
    // The hold timer firing afterwards changes nothing: the gesture is over.
    expect(play("chord", [{ t: "hold-done" }], s).phase).toBe("cancel");
  });

  it("names a late second finger before the hold as a cancel too", () => {
    const s = play("chord", [down(1000), second(200, 300, 1400)], undefined, { ...CHORD, holdMs: 500 });
    expect(s.endedBy).toBe("a second finger came before the hold finished");
  });

  it("lets the first finger drift freely once armed", () => {
    expect(play("chord", [move(400, 700)], armed()).phase).toBe("armed");
  });

  it("armed + a swipe under 40 px is no step", () => {
    const s = play("chord", [second(200, 300), swipe(230, 300)], armed());
    expect(s.phase).toBe("armed");
    expect(s.dx).toBe(30);
  });

  it("armed -> stepping at 40 px, and a further 40 px is another step", () => {
    const s = play("chord", [second(200, 300), swipe(242, 300), swipe(284, 300)], armed());
    expect(s.phase).toBe("stepping");
    expect(s.steps).toBe(2);
    expect(keyAt(must(s.target))).toBe("a4");
    expect(s.lastDir).toBe("right");
  });

  it("one swipe of twice the threshold is two steps", () => {
    const s = play("chord", [second(200, 300), swipe(285, 300)], armed());
    expect(s.steps).toBe(2);
  });

  it("a flick steps under 40 px", () => {
    const s = play("chord", [second(200, 300, 1000), swipe(228, 300, 1040)], armed());
    expect(s.steps).toBe(1);
    expect(s.lastDir).toBe("right");
  });

  it("a vertical swipe moves between spaces", () => {
    const s = play("chord", [second(200, 300), swipe(200, 345)], armed());
    expect(keyAt(must(s.target))).toBe("b2");
    expect(s.lastDir).toBe("down");
  });

  it("the second finger may lift and swipe again, and the pad stays where it first landed", () => {
    const s = play("chord", [second(200, 300), swipe(245, 300), { t: "second-up" }, second(50, 600), swipe(5, 600), { t: "second-up" }, second(60, 610), swipe(105, 610)], armed());
    expect(s.steps).toBe(3);
    expect(keyAt(must(s.target))).toBe("a3");
    expect(s.padAt).toEqual(P(200, 300));
  });

  it("ignores a third finger", () => {
    const s = play("chord", [second(200, 300), second(10, 10)], armed());
    expect(s.second).toEqual(P(200, 300));
  });

  it("lifting the first finger commits after a step and cancels with none", () => {
    const stepped = play("chord", [second(200, 300), swipe(245, 300), up()], armed());
    expect(stepped.phase).toBe("commit");
    expect(stepped.endedBy).toBe("the first finger lifted after 1 step");
    expect(keyAt(must(stepped.target))).toBe("a3");
    const none = play("chord", [up()], armed());
    expect(none.phase).toBe("cancel");
    expect(none.endedBy).toBe("the first finger lifted with no swipe");
  });

  it("the browser's cancel ends it, settle returns to idle, and a new down starts over", () => {
    const c = play("chord", [{ t: "cancel", why: "touchcancel" }], armed());
    expect(c.phase).toBe("cancel");
    expect(isTerminal(c.phase)).toBe(true);
    expect(play("chord", [{ t: "settle" }], c).phase).toBe("idle");
    expect(play("chord", [{ t: "settle" }], armed()).phase).toBe("armed");
    expect(play("chord", [down()], c).phase).toBe("holding");
  });
});

describe("the stick machine (Joystick)", () => {
  const armed = () => play("stick", [down(), { t: "hold-done" }]);

  it("idle -> holding -> armed after the 400 ms hold", () => {
    expect(play("stick", [down()]).phase).toBe("holding");
    expect(armed().phase).toBe("armed");
    expect(STICK.holdMs).toBe(400);
  });

  it("a tap is a tap, and does nothing else", () => {
    expect(play("stick", [down(), up(101, 100)]).phase).toBe("tap");
  });

  it("a quick drag up before the hold is a flick, the switcher", () => {
    expect(play("stick", [down(), move(100, 70), move(100, 40), up(100, 40)]).phase).toBe("flick");
  });

  it("a move before the hold that is not up enough cancels, and the hold never arms after a move", () => {
    const s = play("stick", [down(), move(140, 105), { t: "hold-done" }, up(140, 105)]);
    expect(s.phase).toBe("cancel");
    expect(s.endedBy).toBe("moved before the hold finished");
  });

  it("armed inside the dead zone, stepping at 48 px, more steps further out", () => {
    expect(play("stick", [move(130, 100)], armed()).phase).toBe("armed");
    const one = play("stick", [move(150, 100)], armed());
    expect(one.phase).toBe("stepping");
    expect(one.steps).toBe(1);
    expect(one.lastDir).toBe("right");
    expect(play("stick", [move(200, 100)], armed()).steps).toBe(2);
    expect(play("stick", [move(100, 40)], armed()).lastDir).toBe("up");
  });

  it("coming back reverses, and the target follows live", () => {
    const s = play("stick", [move(200, 100), move(150, 100), move(110, 100)], armed());
    expect(s.phase).toBe("armed");
    expect(s.steps).toBe(0);
    expect(s.lastDir).toBeNull();
    expect(sameCell(must(s.target), START)).toBe(true);
  });

  it("release commits on another cell and cancels back at the start", () => {
    const commit = play("stick", [move(150, 100), up(150, 100)], armed());
    expect(commit.phase).toBe("commit");
    expect(keyAt(must(commit.target))).toBe("a3");
    const back = play("stick", [move(150, 100), move(100, 100), up()], armed());
    expect(back.phase).toBe("cancel");
    expect(back.endedBy).toBe("released back at the start");
    expect(play("stick", [up()], armed()).phase).toBe("cancel");
  });

  it("a push past the start of the row clamps to the same cell, so it is no move", () => {
    const s = play("stick", [move(100 - 480, 100), up(-380, 100)], { ...armed(), origin: navLayoutOf(DEFS, "a1"), target: navLayoutOf(DEFS, "a1") });
    expect(s.phase).toBe("cancel");
  });

  it("ignores second-finger events", () => {
    const a = armed();
    expect(play("stick", [second(1, 1), swipe(300, 1)], a)).toEqual(a);
  });
});

describe("the overlay geometry", () => {
  it("names the active direction by the dominant axis, and none inside the minimum", () => {
    expect(activeDirection(5, 2, 10)).toBeNull();
    expect(activeDirection(-20, 5, 10)).toBe("left");
    expect(activeDirection(5, 20, 10)).toBe("down");
  });

  it("keeps a box inside the screen", () => {
    expect(fitCenter(P(10, 10), { w: 400, h: 800 }, P(60, 60))).toEqual(P(60, 60));
    expect(fitCenter(P(390, 790), { w: 400, h: 800 }, P(60, 60))).toEqual(P(340, 740));
    expect(fitCenter(P(10, 10), { w: 100, h: 100 }, P(60, 60))).toEqual(P(50, 50));
  });

  it("cellOf reads the cursor", () => {
    expect(cellOf(START)).toEqual({ space: 0, pane: 1 });
  });
});
