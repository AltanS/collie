import { render, screen } from "@testing-library/react";

import { ToastViewport } from "./toast-viewport";

describe("ToastViewport — where a transient event floats", () => {
  it("portals the dock to <body>, never leaving it inside the caller's tree", () => {
    // NOT a formality. A `fixed` element is positioned against the viewport only while no ancestor
    // has created a containing block — and backdrop-filter, filter, transform, perspective and
    // contain all create one, on any ancestor, at any depth. This app has already been bitten:
    // server-switcher.tsx:103-104 portals for exactly this reason, because a backdrop-filter on the
    // header would clip a `fixed inset-0` sheet to the header band. A viewport-anchored layer must
    // not assume a clean ancestor chain, because the chain belongs to whoever mounts it and the
    // failure is silent.
    const { container } = render(
      <ToastViewport>
        <p>Connected</p>
      </ToastViewport>,
    );
    expect(container).toBeEmptyDOMElement();
    const toast = screen.getByText("Connected");
    expect(toast).toBeInTheDocument();
    expect(container).not.toContainElement(toast);
  });

  it("reproduces the bottom wrapper that already works", () => {
    // routes/home.tsx:121-123, generalised rather than redesigned: fixed to the bottom, column
    // centred at the page's max width, on the page gutter, clearing the home indicator. The one
    // deliberate change is z-30 -> z-40, the unclaimed rung above all chrome and below the sheets.
    render(
      <ToastViewport>
        <p>Connected</p>
      </ToastViewport>,
    );
    const wrapper = screen.getByText("Connected").parentElement;
    expect(wrapper).toHaveClass("fixed", "inset-x-0", "bottom-0", "z-40");
    expect(wrapper).toHaveClass("mx-auto", "w-full", "max-w-screen-sm", "px-4");
    expect(wrapper?.className).toContain("safe-area-inset-bottom");
  });

  it("never eats a tap meant for the content it is only visiting", () => {
    // `pointer-events-none` on the wrapper; whatever inside is genuinely meant to be tapped — the
    // dismiss on a persisting error — turns it back on for itself. An overlay that swallows taps
    // over content is worse than the layout shift it replaced.
    render(
      <ToastViewport>
        <p>Connected</p>
      </ToastViewport>,
    );
    expect(screen.getByText("Connected").parentElement).toHaveClass("pointer-events-none");
  });

  it("owns position and nothing else", () => {
    // No ground, no border, no radius, no text colour. What floats in it — the status line, its
    // surface, its dismissal — belongs to the feature rendered inside.
    render(
      <ToastViewport>
        <p>Connected</p>
      </ToastViewport>,
    );
    const wrapper = screen.getByText("Connected").parentElement;
    expect(wrapper?.className).not.toMatch(/(?:^|\s)(?:bg-|text-|border|rounded|shadow)/);
  });
});
