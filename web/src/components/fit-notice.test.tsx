import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FitNotice } from "./fit-notice";

// The pane view's standing word that the desk's pane is at phone size. Addressed by its text and its
// button's name; queried through its own container, since a `role="status"` query is ambiguous in any
// tree that also holds a StripHost (DESIGN.md §9).

describe("FitNotice", () => {
  it("renders nothing while no lease is held", () => {
    const { container } = render(<FitNotice phase={{ kind: "idle" }} onRelease={vi.fn()} />);
    expect(container.querySelector('[data-slot="notice"]')).toBeNull();
  });

  it("says a fit is on its way, and offers Release to cancel it", () => {
    render(<FitNotice phase={{ kind: "fitting" }} onRelease={vi.fn()} />);
    expect(screen.getByText("Fitting to phone…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release" })).toBeInTheDocument();
  });

  it("names the leased size, and Release lets it go", async () => {
    const onRelease = vi.fn();
    render(<FitNotice phase={{ kind: "fitted", cols: 48, rows: 36 }} onRelease={onRelease} />);
    expect(screen.getByText("Fitted to 48×36")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Release" }));
    expect(onRelease).toHaveBeenCalledTimes(1);
  });
});
