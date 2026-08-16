import { act, render, screen } from "@testing-library/react";

import { BOOT_LOADING_DELAY_MS, BootSplash } from "./root";

describe("BootSplash", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("uses neutral loading copy before and after a delayed first load", () => {
    render(<BootSplash />);
    expect(screen.getByText("Loading Collie…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    act(() => vi.advanceTimersByTime(BOOT_LOADING_DELAY_MS));
    expect(screen.getByText("Collie is taking longer than expected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText(/not connected|connecting to the herd/i)).toBeNull();
  });
});
