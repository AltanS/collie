import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { PullToRefresh } from "./pull-to-refresh";

function renderScroller() {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <PullToRefresh className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <span data-testid="child">herd</span>
          </PullToRefresh>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  render(<RouterProvider router={router} />);
  // The scroller is the child's grandparent-most ancestor carrying the passed classes.
  return screen.getByTestId("child").closest("div.overflow-y-auto");
}

// jsdom does no layout, so the double-scrollbar itself is not observable here — the CLASS is what
// prevents it, and that is what this pins. Without `relative` the scroller is not the containing
// block for its `sr-only` (position: absolute) descendants: those resolve against the initial
// containing block, escape the clip, and give the document a second scrollbar beside this one.
describe("PullToRefresh", () => {
  it("is the containing block for its absolutely-positioned descendants", () => {
    expect(renderScroller()).toHaveClass("relative");
  });

  it("keeps the caller's own layout classes", () => {
    expect(renderScroller()).toHaveClass("flex", "min-h-0", "flex-1", "overflow-y-auto");
  });
});
