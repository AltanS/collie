import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { EXIT_MS, FreshnessBanner, PaneFreshnessNotice, RESUMED_MS } from "./freshness-banner";

type RootFreshness = {
  bridge: "connected" | "disconnected" | undefined;
  snapshotStale: boolean;
  snapshotAuthError: boolean;
  snapshotHasLastGood: boolean;
};

let setFreshness: (next: RootFreshness) => void = () => {};

function renderBanner(initial: Partial<RootFreshness> = {}) {
  function Harness() {
    const [freshness, set] = useState<RootFreshness>({
      bridge: "connected",
      snapshotStale: false,
      snapshotAuthError: false,
      snapshotHasLastGood: true,
      ...initial,
    });
    setFreshness = set;
    return <FreshnessBanner {...freshness} />;
  }
  const router = createMemoryRouter([{ path: "/", element: <Harness /> }]);
  return render(<RouterProvider router={router} />);
}

describe("FreshnessBanner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives root auth precedence and provides a real sign-in escape", () => {
    renderBanner({ snapshotStale: true, snapshotAuthError: true, snapshotHasLastGood: true });

    expect(screen.getByRole("alert")).toHaveTextContent("Access refused.");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth/");
    expect(screen.queryByText(/Live updates delayed/)).toBeNull();
  });

  it("distinguishes cold and cached stale root snapshots", () => {
    const { rerender } = renderBanner({ snapshotStale: true, snapshotHasLastGood: false });
    expect(screen.getByRole("status")).toHaveTextContent("Live updates delayed.");
    expect(screen.queryByText(/showing the last update/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();

    rerender(
      <RouterProvider
        router={createMemoryRouter([
          {
            path: "/",
            element: (
              <FreshnessBanner
                bridge="connected"
                snapshotStale
                snapshotAuthError={false}
                snapshotHasLastGood
              />
            ),
          },
        ])}
      />,
    );
    expect(screen.getByText(/showing the last update/i)).toBeInTheDocument();
  });

  it("shows Herdr unavailable only from a fresh root snapshot", () => {
    renderBanner({ bridge: "disconnected" });
    expect(screen.getByRole("alert")).toHaveTextContent("Herdr unavailable.");

    act(() =>
      setFreshness({
        bridge: "disconnected",
        snapshotStale: true,
        snapshotAuthError: false,
        snapshotHasLastGood: true,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Live updates delayed");
    expect(screen.queryByText("Herdr unavailable.")).toBeNull();
  });

  it("announces resumed updates only after a visible cached stale root recovers", () => {
    renderBanner({ snapshotStale: true, snapshotHasLastGood: true });
    expect(screen.getByText(/Live updates delayed/)).toBeInTheDocument();

    act(() =>
      setFreshness({
        bridge: "connected",
        snapshotStale: false,
        snapshotAuthError: false,
        snapshotHasLastGood: true,
      }),
    );
    expect(screen.getByText("Live updates resumed")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(RESUMED_MS));
    act(() => vi.advanceTimersByTime(EXIT_MS));
    expect(screen.queryByText("Live updates resumed")).toBeNull();
  });

  it("does not announce a cold failure recovering", () => {
    renderBanner({ snapshotStale: true, snapshotHasLastGood: false });
    act(() =>
      setFreshness({
        bridge: "connected",
        snapshotStale: false,
        snapshotAuthError: false,
        snapshotHasLastGood: true,
      }),
    );
    expect(screen.queryByText("Live updates resumed")).toBeNull();
  });
});

describe("PaneFreshnessNotice", () => {
  it("gives pane auth precedence and retains the sign-in escape", () => {
    render(<PaneFreshnessNotice paneStale paneAuthError paneHasLastGood />);
    expect(screen.getByRole("alert")).toHaveTextContent("Pane access refused.");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/auth/");
    expect(screen.queryByText(/Pane output delayed/)).toBeNull();
  });

  it("distinguishes cold and cached stale pane output", () => {
    const { rerender } = render(
      <PaneFreshnessNotice paneStale paneAuthError={false} paneHasLastGood={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Pane output delayed.");
    expect(screen.queryByText(/showing the last update/i)).toBeNull();

    rerender(<PaneFreshnessNotice paneStale paneAuthError={false} paneHasLastGood />);
    expect(screen.getByText(/Pane output delayed — showing the last update/i)).toBeInTheDocument();
  });

  it("renders no pane row while the pane is fresh", () => {
    render(<PaneFreshnessNotice paneStale={false} paneAuthError={false} paneHasLastGood />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
