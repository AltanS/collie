import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";

import { HeightSwap, mergeKeys, PRESENCE_DURATION, PRESENCE_MS, PRESENCE_REDUCED_MS, PresenceList } from "./presence";

// The presence primitives (2026-11-10): keyed items that arrive and leave with an eased collapse, and
// one band whose content is replaced while its height eases. jsdom has no layout, so these read the
// state each element heads for, what stays drawn and for how long, and what is out of reach.

/** jsdom reports `prefers-reduced-motion` as "no preference"; this makes it say the opposite. */
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const items = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-slot="presence-item"]')];
const words = (container: HTMLElement) => items(container).map((el) => el.textContent);

function List({ keys, gap = 12, as }: { keys: string[]; gap?: number; as?: "div" | "li" }) {
  return (
    <PresenceList gap={gap} itemAs={as}>
      {keys.map((key) => (
        <p key={key}>{key}</p>
      ))}
    </PresenceList>
  );
}

describe("mergeKeys", () => {
  it("keeps a leaving key in its old place", () => {
    expect(mergeKeys(["a", "b", "c"], ["a", "c"])).toEqual(["a", "b", "c"]);
    expect(mergeKeys(["a", "b", "c"], ["b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("puts an arrival where the next list has it", () => {
    expect(mergeKeys(["a", "b"], ["x", "a", "b"])).toEqual(["x", "a", "b"]);
    expect(mergeKeys(["a", "b"], ["a", "x", "b"])).toEqual(["a", "x", "b"]);
    expect(mergeKeys(["a", "b"], ["a", "b", "x"])).toEqual(["a", "b", "x"]);
  });

  it("follows a new order and never draws a key twice", () => {
    expect(mergeKeys(["a", "b", "c"], ["c", "b", "a"])).toEqual(["c", "b", "a"]);
    expect(mergeKeys(["a", "b"], ["c"])).toEqual(["a", "b", "c"]);
  });
});

describe("PresenceList", () => {
  it("draws the first paint at rest: nothing animates in", () => {
    const { container } = render(<List keys={["a", "b"]} />);
    expect(items(container).map((el) => el.dataset.state)).toEqual(["open", "open"]);
    expect(items(container)[0]).toHaveClass("grid-rows-[1fr]", "opacity-100");
    expect(items(container)[0]!.style.marginTop).toBe("");
  });

  it("keeps a leaving item in its place, out of reach, collapsing with its gap, and unmounts it after the motion", () => {
    const { container, rerender } = render(<List keys={["a", "b", "c"]} />);
    rerender(<List keys={["a", "c"]} />);
    expect(words(container)).toEqual(["a", "b", "c"]);
    const leaving = items(container)[1]!;
    expect(leaving.dataset.state).toBe("closed");
    expect(leaving).toHaveClass("grid-rows-[0fr]", "opacity-0");
    expect(leaving).toHaveAttribute("inert");
    expect(leaving).toHaveAttribute("aria-hidden", "true");
    // The gap goes with it, so the item below lands where it stays: no jump at the unmount.
    expect(leaving.style.marginBottom).toBe("-12px");
    expect(leaving.firstElementChild).toHaveClass("scale-[0.98]", "overflow-hidden");
    act(() => vi.advanceTimersByTime(PRESENCE_MS - 1));
    expect(words(container)).toEqual(["a", "b", "c"]);
    act(() => vi.advanceTimersByTime(1));
    expect(words(container)).toEqual(["a", "c"]);
  });

  it("draws what a leaving item drew last, even though the caller no longer renders it", () => {
    function Labelled({ entries }: { entries: [string, string][] }) {
      return (
        <PresenceList>
          {entries.map(([key, label]) => (
            <p key={key}>{label}</p>
          ))}
        </PresenceList>
      );
    }
    const { container, rerender } = render(<Labelled entries={[["a", "first"], ["b", "second"]]} />);
    rerender(<Labelled entries={[["b", "second"]]} />);
    expect(words(container)).toEqual(["first", "second"]);
  });

  it("grows an arrival from nothing: closed for two painted frames, then open, then unclipped", () => {
    const { container, rerender } = render(<List keys={["a"]} />);
    rerender(<List keys={["x", "a"]} />);
    const arriving = items(container)[0]!;
    expect(arriving.textContent).toBe("x");
    expect(arriving.dataset.state).toBe("closed");
    expect(arriving).toHaveClass("grid-rows-[0fr]");
    expect(arriving).not.toHaveAttribute("inert");
    act(() => vi.advanceTimersByTime(48));
    expect(arriving.dataset.state).toBe("open");
    expect(arriving).toHaveClass("grid-rows-[1fr]", "opacity-100");
    expect(arriving.style.marginTop).toBe("");
    expect(arriving.firstElementChild).toHaveClass("overflow-hidden");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(arriving.firstElementChild).not.toHaveClass("overflow-hidden");
  });

  it("takes back an item whose key returns before its exit is over", () => {
    const { container, rerender } = render(<List keys={["a", "b"]} />);
    rerender(<List keys={["a"]} />);
    act(() => vi.advanceTimersByTime(PRESENCE_MS / 2));
    rerender(<List keys={["a", "b"]} />);
    act(() => vi.advanceTimersByTime(PRESENCE_MS * 2));
    expect(words(container)).toEqual(["a", "b"]);
    expect(items(container)[1]!.dataset.state).toBe("open");
    expect(items(container)[1]).not.toHaveAttribute("inert");
  });

  it("wraps each item in a list item inside a list, so the rows of a ul can leave too", () => {
    const { container, rerender } = render(
      <ul>
        <List keys={["a", "b"]} gap={0} as="li" />
      </ul>,
    );
    expect(items(container).map((el) => el.tagName)).toEqual(["LI", "LI"]);
    rerender(
      <ul>
        <List keys={["b"]} gap={0} as="li" />
      </ul>,
    );
    // A row that touches its neighbours collapses its own rule with it.
    expect(items(container)[0]!.style.borderBottomWidth).toBe("0px");
    expect(items(container)[0]!.style.marginTop).toBe("0px");
  });

  it("lets a group leave with its last item inside it, as one motion", () => {
    // A group of an outer list holds an inner list. When the group's last item and the group go in the
    // same render, the group collapses showing that item: the inner list never sees it leave.
    function Groups({ groups }: { groups: [string, string[]][] }) {
      return (
        <PresenceList gap={28}>
          {groups.map(([name, members]) => (
            <section key={name} data-group={name}>
              <h2>{name}</h2>
              <PresenceList gap={12}>
                {members.map((m) => (
                  <p key={m}>{m}</p>
                ))}
              </PresenceList>
            </section>
          ))}
        </PresenceList>
      );
    }
    const { container, rerender } = render(<Groups groups={[["now", ["n1"]], ["today", ["t1", "t2"]]]} />);
    rerender(<Groups groups={[["today", ["t1", "t2"]]]} />);
    const now = container.querySelector('[data-group="now"]')!;
    expect(now.textContent).toBe("nown1");
    expect(now.closest('[data-slot="presence-item"]')).toHaveAttribute("data-state", "closed");
    // The card inside is not collapsing on its own: the group's height carries it.
    const inner = now.querySelector('[data-slot="presence-item"]')!;
    expect(inner).toHaveAttribute("data-state", "open");
    expect(now.closest('[data-slot="presence-item"]')!.getAttribute("style")).toContain("margin-bottom: -28px");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(container.querySelector('[data-group="now"]')).toBeNull();
  });

  it("spends the same number in CSS and in the timers", () => {
    const { container } = render(<List keys={["a"]} />);
    expect(PRESENCE_DURATION).toBe(`duration-[${PRESENCE_MS}ms]`);
    expect(items(container)[0]).toHaveClass(PRESENCE_DURATION);
  });

  describe("under reduced motion", () => {
    beforeEach(() => preferReducedMotion(true));

    it("only fades a leaving item: no height, no margin, no scale, and it is gone after the short fade", () => {
      const { container, rerender } = render(<List keys={["a", "b"]} />);
      rerender(<List keys={["a"]} />);
      const leaving = items(container)[1]!;
      expect(leaving).toHaveClass("grid-rows-[1fr]", "opacity-0", "transition-opacity", "duration-[120ms]");
      expect(leaving.style.marginBottom).toBe("");
      expect(leaving.firstElementChild).not.toHaveClass("scale-[0.98]");
      act(() => vi.advanceTimersByTime(PRESENCE_REDUCED_MS));
      expect(words(container)).toEqual(["a"]);
    });

    it("draws an arrival at its full height at once and fades it in", () => {
      const { container, rerender } = render(<List keys={["a"]} />);
      rerender(<List keys={["a", "x"]} />);
      const arriving = items(container)[1]!;
      expect(arriving).toHaveClass("grid-rows-[1fr]", "opacity-0");
      act(() => vi.advanceTimersByTime(48));
      expect(arriving).toHaveClass("opacity-100");
    });
  });
});

describe("HeightSwap", () => {
  const options = (status = "Sending…") => [
    { key: "answer", node: <button type="button">Yes</button> },
    { key: "status", node: <p>{status}</p> },
  ];
  const layer = (container: HTMLElement, key: string) => container.querySelector<HTMLElement>(`[data-swap-layer="${key}"]`);

  it("draws only the shown content at the first paint", () => {
    const { container } = render(<HeightSwap active="answer" options={options()} />);
    expect(layer(container, "answer")).toHaveAttribute("data-active");
    expect(layer(container, "status")).toBeNull();
  });

  it("brings the new content in and keeps the old one on top, faded and out of reach, for the motion", () => {
    const { container, rerender } = render(<HeightSwap active="answer" options={options()} />);
    rerender(<HeightSwap active="status" options={options()} />);
    expect(layer(container, "status")).toHaveAttribute("data-active");
    const old = layer(container, "answer")!;
    expect(old).toHaveAttribute("inert");
    expect(old).toHaveAttribute("aria-hidden", "true");
    expect(old).toHaveClass("absolute", "opacity-0", "pointer-events-none");
    act(() => vi.advanceTimersByTime(PRESENCE_MS));
    expect(layer(container, "answer")).toBeNull();
    expect(container.firstElementChild).not.toHaveAttribute("data-swap");
  });

  it("holds what the leaving content drew last", () => {
    const { container, rerender } = render(<HeightSwap active="status" options={options("Sending…")} />);
    rerender(<HeightSwap active="answer" options={options("Sent")} />);
    expect(layer(container, "status")!.textContent).toBe("Sending…");
  });

  it("swaps back mid-motion without a stray layer left behind", () => {
    const { container, rerender } = render(<HeightSwap active="answer" options={options()} />);
    rerender(<HeightSwap active="status" options={options()} />);
    act(() => vi.advanceTimersByTime(PRESENCE_MS / 2));
    rerender(<HeightSwap active="answer" options={options()} />);
    expect(layer(container, "answer")).toHaveAttribute("data-active");
    expect(layer(container, "status")).toHaveAttribute("inert");
    // The first swap's timer cannot end the second one early.
    act(() => vi.advanceTimersByTime(PRESENCE_MS - 1));
    expect(layer(container, "status")).not.toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(layer(container, "status")).toBeNull();
  });

  it("moves its height on the presence curve and time", () => {
    const { container } = render(<HeightSwap active="answer" options={options()} />);
    expect(container.firstElementChild).toHaveClass("transition-[height]", PRESENCE_DURATION);
  });

  it("under reduced motion moves no height and fades the new content in briefly", () => {
    preferReducedMotion(true);
    const { container, rerender } = render(<HeightSwap active="answer" options={options()} />);
    expect(container.firstElementChild).not.toHaveClass("transition-[height]");
    rerender(<HeightSwap active="status" options={options()} />);
    expect(layer(container, "status")).toHaveClass("duration-[120ms]");
    expect(layer(container, "answer")).toHaveClass("duration-0");
    act(() => vi.advanceTimersByTime(PRESENCE_REDUCED_MS));
    expect(layer(container, "answer")).toBeNull();
  });
});
