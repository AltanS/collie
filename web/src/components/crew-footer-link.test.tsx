import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewFooterLink } from "./crew-footer-link";
import { CrewProvider } from "./crew-provider";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { ServerSummary } from "@/lib/types";

// The home screen's one-line census. It counts MACHINES: two Collies on one host are one machine, and
// the reachable half then counts instances, in the words the crew page's caption uses (M77).

const member = (id: string, over: Partial<ServerSummary> = {}): ServerSummary => ({
  id,
  name: id,
  isLead: false,
  reachable: true,
  protocol: "ok",
  lastSeenAt: 1_000,
  ...over,
});

function renderFooter(servers: ServerSummary[]) {
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        element: (
          <CrewProvider servers={servers}>
            <CrewFooterLink />
          </CrewProvider>
        ),
      },
    ],
    { initialEntries: ["/"] },
  );
  return render(<RouterProvider router={router} />);
}

describe("CrewFooterLink", () => {
  it("keeps today's text when every member is its own machine", () => {
    renderFooter([member("lodge", { isLead: true }), member("workshop"), member("attic", { reachable: false })]);
    expect(screen.getByText("Crew · 3 machines · 2 reachable")).toBeInTheDocument();
  });

  it("counts machines, and instances that answer, when hosts run two instances each", () => {
    // The shape of the playground's two-per-host roster, copied rather than imported.
    renderFooter([
      member("lodge", { isLead: true, host: "lodge", mux: "herdr" }),
      member("lodge-hc", { host: "lodge", mux: "herdr-core" }),
      member("workshop", { host: "workshop", mux: "herdr" }),
      member("workshop-hc", { host: "workshop", mux: "herdr-core" }),
    ]);
    expect(screen.getByText("Crew · 2 machines · 4 of 4 instances reachable")).toBeInTheDocument();
  });

  it("says how many of the instances answer when one is down", () => {
    renderFooter([
      member("lodge", { isLead: true, host: "lodge", mux: "herdr" }),
      member("lodge-hc", { host: "lodge", mux: "herdr-core" }),
      member("workshop", { host: "workshop", mux: "herdr" }),
      member("workshop-hc", { host: "workshop", mux: "herdr-core", reachable: false }),
    ]);
    expect(screen.getByText("Crew · 2 machines · 3 of 4 instances reachable")).toBeInTheDocument();
  });

  it("renders nothing on a solo install", () => {
    const { container } = renderFooter([member("lodge", { isLead: true })]);
    expect(container.querySelector("button")).toBeNull();
  });
});
