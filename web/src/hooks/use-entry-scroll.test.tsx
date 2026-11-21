import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { useEntryScroll } from "./use-entry-scroll";

// The list keeps its place for its history entry (2026-11-21): Back from a trick's details page lands where the
// person left Settings, Tricks and the Hill; a fresh visit starts at the top.

/** A scroller whose scrollTop holds what is written, as a real one does (jsdom keeps it at 0). */
function Scroller() {
  const ref = useRef<HTMLDivElement | null>(null);
  useEntryScroll(ref, true);
  return (
    <div
      data-testid="scroller"
      ref={(el) => {
        if (el !== null && ref.current !== el) {
          let top = 0;
          Object.defineProperty(el, "scrollTop", { configurable: true, get: () => top, set: (value: number) => (top = value) });
        }
        ref.current = el;
      }}
    />
  );
}

describe("useEntryScroll", () => {
  it("brings the place back on a step back to the same entry, and starts a new visit at the top", async () => {
    const router = createMemoryRouter(
      [
        { path: "/list", element: <Scroller /> },
        { path: "/list/:id", element: <div>a page below</div> },
      ],
      { initialEntries: ["/list"] },
    );
    render(<RouterProvider router={router} />);
    const scroller = screen.getByTestId("scroller");
    scroller.scrollTop = 640;
    fireEvent.scroll(scroller);
    await act(async () => {
      await router.navigate("/list/one");
    });
    await act(async () => {
      await router.navigate(-1);
    });
    expect(screen.getByTestId("scroller").scrollTop).toBe(640);
    await act(async () => {
      await router.navigate("/list");
    });
    expect(screen.getByTestId("scroller").scrollTop).toBe(0);
  });
});
