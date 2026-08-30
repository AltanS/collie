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
  viewAll = false,
  host?: string,
) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <SessionSwitcher
            sessions={sessions}
            scope={{ host, session: current }}
            viewAll={viewAll}
          />
        ),
      },
    ],
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

// ── "All sessions" ───────────────────────────────────────────────────────────
//
// The one row here that does not pick a session. It asks for all of them at once, which is a
// different QUESTION from the rows below it rather than a different answer to theirs — hence its
// position above them, and hence the tests below being about the URL rather than about the list.
describe("SessionSwitcher — the widened view", () => {
  const open = async (name: RegExp) => {
    await userEvent.click(screen.getByRole("button", { name }));
  };

  it("leads the sheet, and is not one of the sessions", async () => {
    renderSwitcher([primary, demo], undefined);
    await open(/switch session/i);
    const rows = within(screen.getByRole("list")).getAllByRole("button");
    expect(rows[0]).toHaveTextContent("All sessions");
    // Putting it among the rows would make it look like a session called that.
    expect(rows.slice(1).map((r) => r.textContent)).not.toContain("All sessions");
  });

  it("navigates with `?all=1` and DROPS `?s=`", async () => {
    // The address stays "this machine, its primary session" — which is what `bridge`, the spaces
    // list and every write with no row of its own go on using. Carrying `?s=` too would name a
    // session the list no longer restricts itself to: the same url would contradict itself.
    const router = renderSwitcher([primary, demo], "collie-demo", "/?s=collie-demo");
    await open(/switch session/i);
    await userEvent.click(screen.getByRole("button", { name: /all sessions/i }));
    expect(location(router)).toBe("/?all=1");
  });

  it("keeps the host it was on", async () => {
    // Widening is a statement about one machine. It may never also move you to another.
    const router = renderSwitcher([primary, demo], undefined, "/?h=attic", false, "attic");
    await open(/switch session/i);
    await userEvent.click(screen.getByRole("button", { name: /all sessions/i }));
    expect(location(router)).toBe("/?h=attic&all=1");
  });

  it("says it is widened on the trigger, and marks no session as current", async () => {
    renderSwitcher([primary, demo], undefined, "/?all=1", true);
    expect(screen.getByRole("button", { name: /showing every session/i })).toHaveTextContent(
      "All sessions",
    );
    await open(/showing every session/i);
    const rows = within(screen.getByRole("list")).getAllByRole("button");
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    // No session row claims to be the one you are on — you are on all of them.
    expect(rows.slice(1).filter((r) => r.getAttribute("aria-current") === "true")).toHaveLength(0);
  });

  it("still offers a way back to a single session", async () => {
    const router = renderSwitcher([primary, demo], undefined, "/?all=1", true);
    await open(/showing every session/i);
    await userEvent.click(screen.getByRole("button", { name: /collie-demo/i }));
    expect(location(router)).toBe("/?s=collie-demo");
  });

  // The trigger's own hide rule has to learn about this state, or a widened view on a bridge that
  // reports one session would hide the only control that can un-widen it.
  it("shows the trigger while widened even with a single session", () => {
    renderSwitcher([primary], undefined, "/?all=1", true);
    expect(screen.getByRole("button", { name: /showing every session/i })).toBeInTheDocument();
  });
});
