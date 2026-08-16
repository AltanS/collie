import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router";
import type { ReactElement } from "react";

import { AppHeader, SettingsGear } from "./app-header";
import { StatusBadge } from "./status-badge";

function renderHeader(ui: ReactElement) {
  return render(ui, { wrapper: MemoryRouter });
}

function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="loc">{loc.pathname + loc.search}</div>;
}

describe("AppHeader", () => {
  it("is calm while fresh", () => {
    const { container } = renderHeader(
      <AppHeader onHome={() => {}} rightLead={<StatusBadge status="working" />}>
        <span>webapp › main</span>
      </AppHeader>,
    );
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")).toHaveAttribute("src", "/favicon.svg");
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("returns home and preserves session-scoped settings navigation", async () => {
    const onHome = vi.fn();
    render(
      <MemoryRouter initialEntries={["/?s=collie-demo"]}>
        <AppHeader onHome={onHome} wordmark rightTrail={<SettingsGear session="collie-demo" />} />
        <LocationProbe />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Collie home" }));
    expect(onHome).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByTestId("loc")).toHaveTextContent("/settings?s=collie-demo");
  });

  it("keeps generic loading animation separate from static degraded treatment", () => {
    const { container, rerender } = renderHeader(<AppHeader loading />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    expect(screen.getByRole("button", { name: "Collie home" })).toBeInTheDocument();

    rerender(<AppHeader degraded />);
    expect(container.querySelector(".dog-gallop")).toBeNull();
    expect(container.querySelector("img")?.parentElement).toHaveClass("grayscale");
    expect(screen.getByRole("button", { name: "Collie home" })).toBeInTheDocument();

    rerender(<AppHeader loading degraded />);
    expect(container.querySelector(".dog-gallop")).toHaveClass("dog-gallop--running");
    expect(container.querySelector(".dog-gallop")?.parentElement).toHaveClass("grayscale");
  });

  it("lets an override take over the whole row", () => {
    renderHeader(
      <AppHeader loading degraded onHome={() => {}} override={<div>FINDBAR</div>}>
        <span>webapp › main</span>
      </AppHeader>,
    );
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collie home" })).toBeNull();
  });
});
