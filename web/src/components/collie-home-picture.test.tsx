import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetOperatorBusy, beginBusy } from "@/lib/busy";
import { clearStatus, setStatus } from "@/lib/status";
import { collieMark, markState } from "@/test/collie-mark";
import { CollieHome } from "./collie-home";

// THE PROJECT PICTURE IN THE MARK'S PLACE (issue 811, ADR 0160): shown only while the mark is at rest.
// Every live state brings the Collie mark back, because a picture cannot say any of them.

const PICTURE = "data:image/png;base64,AAAA";

const layer = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="collie-mark-picture"]');
const shown = (c: HTMLElement) => layer(c)?.getAttribute("data-shown");
const drawn = (c: HTMLElement) => layer(c)?.querySelector("img")?.getAttribute("src") ?? null;

beforeEach(() => {
  clearStatus();
  __resetOperatorBusy();
});
afterEach(() => {
  act(() => clearStatus());
  act(() => __resetOperatorBusy());
});

describe("CollieHome — the project picture", () => {
  it("draws the picture, decorative, while the mark rests, with the mark still mounted under it", () => {
    const { container } = render(<CollieHome trouble={false} picture={PICTURE} />);
    expect(markState(container)).toBe("rest");
    expect(shown(container)).toBe("true");
    expect(drawn(container)).toBe(PICTURE);
    expect(layer(container)?.getAttribute("aria-hidden")).toBe("true");
    // The mark stays in the DOM (its handle, its phase and the start handoff keep working), faded out.
    expect(collieMark(container)?.getAttribute("class") ?? "").toContain("opacity-0");
  });

  it("changes nothing with no picture prop", () => {
    const { container } = render(<CollieHome trouble={false} />);
    expect(shown(container)).toBe("false");
    expect(drawn(container)).toBeNull();
    expect(collieMark(container)?.getAttribute("class") ?? "").not.toContain("opacity-0");
  });

  it("changes nothing for a null picture", () => {
    const { container } = render(<CollieHome trouble={false} picture={null} />);
    expect(shown(container)).toBe("false");
    expect(collieMark(container)?.getAttribute("class") ?? "").not.toContain("opacity-0");
  });

  it("does not change the button's name: the picture is decorative", () => {
    const plain = render(<CollieHome trouble={false} />);
    const label = plain.getByRole("button").getAttribute("aria-label");
    plain.unmount();
    const pictured = render(<CollieHome trouble={false} picture={PICTURE} />);
    expect(pictured.getByRole("button").getAttribute("aria-label")).toBe(label);
  });

  it.each([
    ["trouble", { trouble: true }],
    ["lost", { trouble: true, lost: true }],
    ["applying", { trouble: false, applying: true }],
    ["reconnected", { trouble: false, reconnected: true }],
    ["starting", { trouble: false, starting: true }],
  ] as const)("hides for %s and shows the Collie mark", (_name, props) => {
    const { container } = render(<CollieHome {...props} picture={PICTURE} />);
    expect(shown(container)).toBe("false");
    expect(drawn(container)).toBeNull();
    expect(collieMark(container)?.getAttribute("class") ?? "").not.toContain("opacity-0");
  });

  it("hides for the event round and comes back when it ends", () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<CollieHome trouble={false} picture={PICTURE} />);
      expect(shown(container)).toBe("true");
      act(() => setStatus("claude is done · moonward", "success"));
      expect(shown(container)).toBe("false");
      act(() => void vi.advanceTimersByTime(2000));
      expect(shown(container)).toBe("true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides while the operator's work is in flight and comes back when it is released", () => {
    const { container } = render(<CollieHome trouble={false} picture={PICTURE} />);
    let release = () => {};
    act(() => {
      release = beginBusy();
    });
    expect(shown(container)).toBe("false");
    act(() => release());
    expect(shown(container)).toBe("true");
  });

  it("comes back and goes again as the live state arrives and leaves", () => {
    const { container, rerender } = render(<CollieHome trouble={false} picture={PICTURE} />);
    expect(shown(container)).toBe("true");
    rerender(<CollieHome trouble picture={PICTURE} />);
    expect(shown(container)).toBe("false");
    rerender(<CollieHome trouble={false} picture={PICTURE} />);
    expect(shown(container)).toBe("true");
  });
});
