import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FLIP_MS } from "@/hooks/use-flip";

import { FLOW_HOLD_MAX_MS, FLOW_STAGGER_MAX, FLOW_STAGGER_MS, KeyedFlow, staggerDelay, type FlowItem } from "./keyed-flow";
import { PRESENCE_MS } from "./presence";

// The keyed flow (2026-11-10, agent views): what it adds over PresenceList and HeightSwap. jsdom has no layout
// and no Web Animations, so a test stands in both: a block's top is its place among the column's blocks
// times 40 px, and `animate` records what it was asked to play.

function preferReducedMotion(reduce: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: reduce && query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

interface Played {
  readonly key: string | undefined;
  readonly keyframes: Keyframe[] | PropertyIndexedKeyframes | null;
  /** The delay asked for, or null for none. */
  readonly delay: number | null;
  readonly duration: number | null;
}

let played: Played[] = [];

const ROW = 40;

beforeEach(() => {
  vi.useFakeTimers();
  played = [];
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    writable: true,
    value: function animate(this: HTMLElement, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: KeyframeAnimationOptions) {
      const duration = Number(options?.duration);
      played.push({ key: this.dataset.flowKey, keyframes, delay: options?.delay ?? null, duration: Number.isFinite(duration) ? duration : null });
      return { cancel: vi.fn() };
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
    const column = this.closest("[data-slot-flow]");
    const cells = column === null ? [] : [...column.querySelectorAll("[data-flow-key]")];
    const index = cells.indexOf(this);
    const top = index < 0 ? 0 : index * ROW;
    return { top, left: 0, width: 360, height: ROW, bottom: top + ROW, right: 360, x: 0, y: top, toJSON: () => ({}) };
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

const item = (key: string, version = "1", text = key): FlowItem => ({ key, version, node: <p>{text}</p> });
const words = (container: HTMLElement) => [...container.querySelectorAll("[data-flow-key]")].map((cell) => cell.textContent);

describe("KeyedFlow", () => {
  it("draws the blocks in order and plays nothing at the first paint", () => {
    const { container } = render(<KeyedFlow items={[item("a"), item("b")]} gap={12} />);
    expect(words(container)).toEqual(["a", "b"]);
    expect(played).toEqual([]);
  });

  it("a block that leaves stays while it collapses, then goes", () => {
    const { container, rerender } = render(<KeyedFlow items={[item("a"), item("b")]} />);
    rerender(<KeyedFlow items={[item("b")]} />);
    expect(words(container)).toEqual(["a", "b"]);
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(words(container)).toEqual(["b"]);
  });

  it("a new version cross-fades: the old content stays on top while the new one comes in", () => {
    const { container, rerender } = render(<KeyedFlow items={[item("a", "1", "old")]} />);
    rerender(<KeyedFlow items={[item("a", "2", "new")]} />);
    const layers = container.querySelectorAll("[data-swap-layer]");
    expect([...layers].map((layer) => layer.textContent)).toEqual(["new", "old"]);
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(container.querySelectorAll("[data-swap-layer]")).toHaveLength(1);
    expect(words(container)).toEqual(["new"]);
  });

  it("a block that moves glides from where it stood, by a transform on its own wrapper", () => {
    const { rerender } = render(<KeyedFlow items={[item("a"), item("b"), item("c")]} />);
    rerender(<KeyedFlow items={[item("c"), item("a"), item("b")]} />);
    const moves = new Map(played.map((p) => [p.key, p]));
    expect(moves.get("c")?.keyframes).toEqual({ transform: [`translateY(${String(2 * ROW)}px)`, "none"] });
    expect(moves.get("a")?.keyframes).toEqual({ transform: [`translateY(${String(-ROW)}px)`, "none"] });
    expect(moves.get("c")?.duration).toBe(FLIP_MS);
  });

  it("the first blocks after none come in one after another, the first six on their own beat", () => {
    const { rerender } = render(<KeyedFlow items={[]} />);
    const keys = Array.from({ length: FLOW_STAGGER_MAX + 2 }, (_, i) => `k${String(i)}`);
    rerender(<KeyedFlow items={keys.map((key) => item(key))} />);
    expect(played.map((p) => p.key)).toEqual(keys);
    const delays = played.map((p) => p.delay);
    expect(delays).toEqual(keys.map((_, i) => Math.min(i, FLOW_STAGGER_MAX - 1) * FLOW_STAGGER_MS));
    expect(staggerDelay(FLOW_STAGGER_MAX + 4)).toBe((FLOW_STAGGER_MAX - 1) * FLOW_STAGGER_MS);
  });

  it("a block added to a column that has some is not staggered", () => {
    const { rerender } = render(<KeyedFlow items={[item("a")]} />);
    rerender(<KeyedFlow items={[item("a"), item("b")]} />);
    expect(played.filter((p) => p.delay !== null)).toEqual([]);
  });

  it("under reduced motion nothing glides and nothing is staggered", () => {
    preferReducedMotion(true);
    const { rerender } = render(<KeyedFlow items={[]} />);
    rerender(<KeyedFlow items={[item("a"), item("b")]} />);
    rerender(<KeyedFlow items={[item("b"), item("a")]} />);
    expect(played).toEqual([]);
  });

  it("a finger down holds what is drawn; the new blocks land when it lifts anywhere", () => {
    const { container, rerender } = render(<KeyedFlow items={[item("a", "1", "first")]} />);
    fireEvent.pointerDown(container.querySelector("[data-slot-flow]")!);
    rerender(<KeyedFlow items={[item("a", "2", "second"), item("b")]} />);
    expect(words(container)).toEqual(["first"]);
    expect(container.querySelector("[data-slot-flow]")?.hasAttribute("data-holding")).toBe(true);
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(words(container)).toEqual(["second", "b"]);
  });

  it("a hold lets go by itself after five seconds", () => {
    const { container, rerender } = render(<KeyedFlow items={[item("a")]} />);
    fireEvent.pointerDown(container.querySelector("[data-slot-flow]")!);
    rerender(<KeyedFlow items={[item("b")]} />);
    act(() => vi.advanceTimersByTime(FLOW_HOLD_MAX_MS));
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(words(container)).toEqual(["b"]);
  });
});
