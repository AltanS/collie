import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

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

  it("keeps the title and shows a status published `beside` next to it, announced, for its time (M104)", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success", undefined, true));
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sent");
    expect(status).toHaveAttribute("aria-live", "polite");
    // It lies over the line's free room: no box of its own in the flow, so the header keeps its height.
    expect(status).toHaveClass("absolute");
    act(() => vi.advanceTimersByTime(2600));
    expect(screen.queryByRole("status")).toBeNull();
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

  it("paints the note tone in the info blue and the warn tone in the working colour", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("The desk answered first.", "note"));
    expect(screen.getByRole("status").className).toContain("text-status-info");
    act(() => setStatus("Reconnecting", "warn"));
    expect(screen.getByRole("status").className).toContain("text-status-working");
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

// An error status is the one tone that can arrive longer than a phone row and the one an operator
// needs verbatim to act on. Tapping it used to dismiss outright; it now opens the whole message in
// StatusDetailSheet instead, and dismissing moved a tap further, into the sheet itself.
// Real timers here — the error tone has no auto-clear TTL, so nothing in this block needs the fake
// clock the parent describe uses, and userEvent's own internal waits are simpler without one.
describe("HeaderStatus — error opens the detail sheet instead of dismissing on tap", () => {
  beforeEach(() => clearStatus());

  it("shows a button labelled by status.detailAria, and tapping it opens the sheet with the whole message", async () => {
    const user = userEvent.setup();
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("connection refused: dial tcp 192.0.2.5:22: no route to host", "error"));

    const detailButton = screen.getByRole("button", { name: "Show the whole message" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(detailButton);

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(screen.getByRole("dialog")).getByText(
        "connection refused: dial tcp 192.0.2.5:22: no route to host",
      ),
    ).toBeInTheDocument();
  });

  it("dismissing from inside the sheet clears the status and brings the title back", async () => {
    const user = userEvent.setup();
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("send failed", "error"));
    await user.click(screen.getByRole("button", { name: "Show the whole message" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Scoped to the dialog: the header row keeps its own ✕ under the same name, and it is the sheet's
    // copy this test is about.
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });

  it("the row's own ✕ clears the error in one tap, without opening the sheet", async () => {
    const user = userEvent.setup();
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Connection lost", "error"));

    await user.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });

  it("publishing a NEW error while the sheet is open closes it (the effect keys on status.id)", async () => {
    const user = userEvent.setup();
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("first failure", "error"));
    await user.click(screen.getByRole("button", { name: "Show the whole message" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // A second error, same words — status.id still advances, so the sheet still closes.
    act(() => setStatus("first failure", "error"));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("first failure");
  });

  it("an info or success status renders no detail button", () => {
    render(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success"));
    expect(screen.queryByRole("button", { name: "Show the whole message" })).not.toBeInTheDocument();

    act(() => clearStatus());
    act(() => setStatus("Working on it", "info"));
    expect(screen.queryByRole("button", { name: "Show the whole message" })).not.toBeInTheDocument();
  });
});

// A CONDITION is a state of the screen, not an event: the pane's "Starting…" while an agent launches.
// It rides in the same box as an event, in the note look, and an event outranks it.
describe("HeaderStatus — a condition holds the title while it is true", () => {
  const starting = { text: "Starting…", tone: "note" } as const;

  beforeEach(() => {
    vi.useFakeTimers();
    clearStatus();
  });
  afterEach(() => {
    act(() => clearStatus());
    vi.useRealTimers();
  });

  it("replaces the title, announced, in the note look with the info icon and no dismiss button", () => {
    const { container } = render(
      <HeaderStatus condition={starting}>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    expect(screen.queryByText("webapp › main")).not.toBeInTheDocument();
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent("Starting…");
    expect(line).toHaveAttribute("aria-live", "polite");
    expect(line.className).toContain("text-status-info");
    expect(line.querySelector("svg")).not.toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    // The same box as an event's, so the title never changes height when either shows.
    expect(container.querySelector('[data-slot="header-condition"]')?.className).toContain("min-h-11");
  });

  it("gives the title back when the condition ends", () => {
    const { rerender } = render(
      <HeaderStatus condition={starting}>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    rerender(
      <HeaderStatus>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("gives way to an event status, and comes back when the event clears", () => {
    render(
      <HeaderStatus condition={starting}>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success"));
    expect(screen.getByRole("status")).toHaveTextContent("Sent");
    expect(screen.queryByText("Starting…")).toBeNull();
    act(() => clearStatus());
    expect(screen.getByRole("status")).toHaveTextContent("Starting…");
  });

  it("keeps the condition over a word published beside the title: there is no name for it to stand beside", () => {
    render(
      <HeaderStatus condition={starting}>
        <span>webapp › main</span>
      </HeaderStatus>,
    );
    act(() => setStatus("Sent", "success", undefined, true));
    expect(screen.getByRole("status")).toHaveTextContent("Starting…");
    expect(screen.queryByText("Sent")).toBeNull();
  });
});
