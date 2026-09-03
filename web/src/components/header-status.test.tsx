import { act, render, screen } from "@testing-library/react";

import { clearStatus, setStatus } from "@/lib/status";
import { HeaderStatus } from "./header-status";

// The pane screen's title slot: while a status is live it replaces `children` in place; when it
// clears, `children` comes back. Driven with fake timers the same way lib/status.test.ts drives the
// channel itself — this file only checks the SWAP, not the channel's own TTL/latest-wins rules.
describe("HeaderStatus — swaps the title for a live status, in place", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the title when there is no status", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });

  it("replaces the title with the status text, announced, while one is live", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success"));
    expect(screen.queryByText("webapp › main")).not.toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sent");
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("brings the title back once the status auto-clears", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success"));
    expect(screen.getByRole("status")).toHaveTextContent("Sent");
    act(() => vi.advanceTimersByTime(2500));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });

  it("an error status stays until tapped away, same as the toast it replaced", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("send failed", "error"));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole("status")).toHaveTextContent("send failed");
    act(() => clearStatus());
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });
});
