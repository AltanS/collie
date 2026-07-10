import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import type { SessionSummary } from "@/lib/types";
import { SessionSwitcher } from "./session-switcher";

const primary: SessionSummary = {
  name: "default",
  isPrimary: true,
  reachable: true,
  agents: 2,
  working: 1,
  blocked: 1,
};
const demo: SessionSummary = {
  name: "collie-demo",
  isPrimary: false,
  reachable: true,
  agents: 1,
  working: 1,
  blocked: 0,
};
const downSession: SessionSummary = {
  name: "crashed",
  isPrimary: false,
  reachable: false,
  agents: 0,
  working: 0,
  blocked: 0,
};

function renderSwitcher(
  sessions: SessionSummary[],
  current: string | undefined,
  initialPath = "/",
) {
  const router = createMemoryRouter(
    [{ path: "/", element: <SessionSwitcher sessions={sessions} current={current} /> }],
    { initialEntries: [initialPath] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const location = (router: ReturnType<typeof renderSwitcher>) =>
  router.state.location.pathname + router.state.location.search;

describe("SessionSwitcher — trigger visibility", () => {
  it("renders nothing on a single reachable primary session (backward compatible)", () => {
    renderSwitcher([primary], undefined);
    expect(screen.queryByRole("button", { name: /switch session/i })).not.toBeInTheDocument();
  });

  it("shows the trigger when there is more than one reachable session", () => {
    renderSwitcher([primary, demo], undefined);
    expect(screen.getByRole("button", { name: /switch session/i })).toBeInTheDocument();
  });

  it("shows the trigger when the current session is non-primary, even with one reachable", () => {
    // Only the named session is reachable, but you're on it — you must be able to get back to primary.
    renderSwitcher([{ ...primary, reachable: false }, demo], "collie-demo");
    expect(screen.getByRole("button", { name: /switch session/i })).toBeInTheDocument();
  });
});

describe("SessionSwitcher — sheet + selection", () => {
  it("lists every session, marking the primary and the unreachable one", async () => {
    const user = userEvent.setup();
    renderSwitcher([primary, demo, downSession], undefined);
    await user.click(screen.getByRole("button", { name: /switch session/i }));

    const sheet = within(screen.getByRole("dialog"));
    expect(sheet.getByRole("button", { name: /default/ })).toBeInTheDocument();
    expect(sheet.getByRole("button", { name: /collie-demo/ })).toBeInTheDocument();
    // The crashed session is greyed out and non-clickable.
    expect(sheet.getByRole("button", { name: /crashed/ })).toBeDisabled();
  });

  it("navigates to a named session with ?s= on select", async () => {
    const user = userEvent.setup();
    const router = renderSwitcher([primary, demo], undefined);
    await user.click(screen.getByRole("button", { name: /switch session/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /collie-demo/ }));

    await waitFor(() => expect(location(router)).toBe("/?s=collie-demo"));
  });

  it("navigates back to the primary (no ?s=) when selecting it from a named session", async () => {
    const user = userEvent.setup();
    const router = renderSwitcher([primary, demo], "collie-demo", "/?s=collie-demo");
    await user.click(screen.getByRole("button", { name: /switch session/i }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: /default/ }));

    await waitFor(() => expect(location(router)).toBe("/"));
  });
});
