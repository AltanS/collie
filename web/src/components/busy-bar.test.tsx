import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { BusyBar } from "./busy-bar";
import { isBusy, trackBusy } from "@/lib/busy";

afterEach(() => {
  expect(isBusy()).toBe(false); // no leaked busy state between tests
});

describe("BusyBar", () => {
  it("renders nothing when idle", () => {
    const { container } = render(<BusyBar />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the strip while a mutation is in flight, hides it after", async () => {
    render(<BusyBar />);
    expect(document.querySelector(".busy-bar")).toBeNull();

    let release!: () => void;
    let p!: Promise<void>;
    act(() => {
      p = trackBusy(new Promise<void>((r) => (release = r)));
    });
    expect(document.querySelector(".busy-bar")).not.toBeNull();

    await act(async () => {
      release();
      await p;
    });
    expect(document.querySelector(".busy-bar")).toBeNull();
  });

  it("is aria-hidden (decorative — actions surface their own status)", () => {
    let release!: () => void;
    let p!: Promise<void>;
    render(<BusyBar />);
    act(() => {
      p = trackBusy(new Promise<void>((r) => (release = r)));
    });
    expect(document.querySelector(".busy-bar")?.getAttribute("aria-hidden")).toBe("true");
    return act(async () => {
      release();
      await p;
    });
  });
});
