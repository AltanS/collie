import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { AppHeader, SettingsGear } from "./app-header";
import { StatusBadge } from "./status-badge";
import { __resetConnectionHealth } from "@/lib/connection-health";

// AppHeader mounts CollieHome (a button) and, via SettingsGear, useNavigate — so it needs a router.
function renderHeader(ui: ReactElement) {
  return render(ui, { wrapper: MemoryRouter });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("AppHeader — the one shared header shell", () => {
  beforeEach(() => __resetConnectionHealth());

  it("renders the connection pill in the PANE variant (breadcrumb + status badge, no wordmark)", () => {
    // The whole point of the extraction: the pane header now carries the SAME pill as the dashboard,
    // alongside its own breadcrumb and agent status badge.
    renderHeader(
      <AppHeader
        online
        bridge="connected"
        error={false}
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    expect(screen.getByText("live")).toBeInTheDocument(); // the shared pill
    expect(screen.getByText("webapp › main")).toBeInTheDocument(); // the breadcrumb slot
    expect(screen.getByText("working")).toBeInTheDocument(); // the agent status badge
    expect(screen.queryByText("Collie")).toBeNull(); // no wordmark in a pane
  });

  it("renders the SAME pill in the DASHBOARD variant (wordmark + settings gear, no breadcrumb)", () => {
    renderHeader(
      <AppHeader online bridge="connected" error={false} wordmark rightTrail={<SettingsGear />} />,
    );
    expect(screen.getByText("Collie")).toBeInTheDocument(); // wordmark
    expect(screen.getByText("live")).toBeInTheDocument(); // identical pill
    expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  });

  it("returns to the dashboard via onHome when the Collie mark is tapped", async () => {
    const onHome = vi.fn();
    renderHeader(<AppHeader online bridge="connected" error={false} onHome={onHome} wordmark />);
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
  });

  it("navigates to a session-scoped /settings via the shared gear", async () => {
    render(
      <MemoryRouter initialEntries={["/?s=collie-demo"]}>
        <AppHeader
          online
          bridge="connected"
          error={false}
          rightTrail={<SettingsGear session="collie-demo" />}
        />
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("loc").textContent).toBe("/settings?s=collie-demo");
  });

  it("gallops the Collie mark while reconnecting, and rests it while live", () => {
    const { container, rerender } = renderHeader(
      <AppHeader online bridge="connected" error onHome={() => {}} />,
    );
    // Not live → the mark gallops (agreeing with the amber pill).
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    rerender(<AppHeader online bridge="connected" error={false} onHome={() => {}} />);
    // Live → static icon, no sprite.
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "/favicon.svg");
  });

  it("the find-bar override takes over the whole row (mark, breadcrumb, and pill all yield)", () => {
    renderHeader(
      <AppHeader
        online
        bridge="connected"
        error={false}
        onHome={() => {}}
        rightLead={<StatusBadge status="working" />}
        override={<div>FINDBAR</div>}
      >
        <span>webapp › main</span>
      </AppHeader>,
    );
    // The override owns the row while searching…
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    // …so the normal content (including the pill) is replaced, not stacked.
    expect(screen.queryByText("live")).toBeNull();
    expect(screen.queryByText("webapp › main")).toBeNull();
    expect(screen.queryByRole("button", { name: "Collie home" })).toBeNull();
  });
});
