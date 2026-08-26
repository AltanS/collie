import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { PackProvider } from "@/components/pack-provider";
import { PackSettingsCard } from "@/components/pack-settings-card";
import { ServerSwitcher } from "@/components/server-switcher";
import { type PackData } from "@/lib/loaders";
import { fixturePackStatus, fixtureServers } from "@/test/handlers";
import { PackRoute } from "./pack";

// The pack census, and the two entry points that lead to it.
//
// The pair that matters is the same one home.test.tsx makes: a SOLO install grows nothing. No
// Settings row, no switcher footer — the census is host chrome, and host chrome is gated on there
// being more than one machine. The multi-host cases below are the same page with real members on it.

function renderPack(data: PackData, entry = "/pack") {
  const router = createMemoryRouter(
    [
      { path: "/pack", loader: () => data, element: <PackRoute /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const loaded: PackData = { status: fixturePackStatus, error: false };

describe("PackRoute", () => {
  it("lists every member, with the lead badged and each health named", async () => {
    renderPack(loaded);

    // One row per machine, lead first — the order the lead serves them in.
    const rows = await screen.findAllByRole("button", { name: /bluefin|workshop|attic/ });
    // Each row LEADS with its machine name; the badge and the health chip follow it.
    const names = ["bluefin", "workshop", "attic"];
    expect(rows).toHaveLength(names.length);
    for (const [i, name] of names.entries()) {
      expect(rows[i]!.textContent?.trim().startsWith(name)).toBe(true);
    }
    // The Crown badge, on the lead's row and nowhere else.
    expect(within(rows[0]!).getByText("lead")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("lead")).not.toBeInTheDocument();

    // The lead's own word for each member, verbatim.
    expect(screen.getAllByText("reachable")).toHaveLength(2);
    expect(screen.getByText("conflicted")).toBeInTheDocument();
  });

  it("names the pack, the deputy and the secret generation", async () => {
    renderPack(loaded);

    expect(await screen.findByText("home")).toBeInTheDocument();
    expect(screen.getByText("3 machines · 2 reachable")).toBeInTheDocument();
    // The deputy is named, and its warrant generation with it (ADR 0027).
    expect(screen.getByText(/warrant 2/)).toBeInTheDocument();
    // `rotatedAt` is aged against the payload's own `ts` — the LEAD's clock. 100_000 → 400_000 is
    // 5 minutes on that clock, and no value of `Date.now()` may change the answer.
    expect(screen.getByText("generation 3 · rotated 5m")).toBeInTheDocument();
  });

  it("says 'no deputy named' rather than leaving the row blank", async () => {
    renderPack({ status: { ...fixturePackStatus, deputy: null }, error: false });
    expect(await screen.findByText("no deputy named")).toBeInTheDocument();
  });

  it("shouts about a conflict, a stale secret and a member never reached", async () => {
    renderPack(loaded);

    // The second lead and its warrant — the operator decides which believer is stale from these.
    expect(await screen.findByText("cellar also leads · warrant 7")).toBeInTheDocument();
    expect(screen.getByText("Has not picked up the current secret.")).toBeInTheDocument();
    expect(screen.getByText("Enrolled but never reached.")).toBeInTheDocument();
    // The lead's reason, verbatim — never paraphrased.
    expect(screen.getByText("pack protocol 2 (this collie speaks 1)")).toBeInTheDocument();
  });

  it("flags a member whose version differs from the lead's, and only that one", async () => {
    renderPack(loaded);
    // `workshop` runs 0.29.0 against the lead's 0.30.0; the lead itself never differs from itself.
    expect(await screen.findAllByText("differs from lead")).toHaveLength(1);
  });

  it("renders one honest card, not a spinner, when this collie leads no pack", async () => {
    renderPack({ status: null, error: false });
    expect(await screen.findByText("This collie is not leading a pack")).toBeInTheDocument();
    expect(screen.queryByText("Could not load pack status")).not.toBeInTheDocument();
  });

  it("keeps 'could not ask' apart from 'nothing to ask about'", async () => {
    renderPack({ status: null, error: true });
    expect(await screen.findByText("Could not load pack status")).toBeInTheDocument();
    expect(screen.queryByText("This collie is not leading a pack")).not.toBeInTheDocument();
  });

  it("opens a peer at its own home — its own machine, never a pane id carried across", async () => {
    const user = userEvent.setup();
    const router = renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /workshop/ }));
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toBe("?h=workshop");
  });

  it("opens the lead at the bare URL — absent `?h=` IS the lead", async () => {
    const user = userEvent.setup();
    const router = renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /bluefin/ }));
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toBe("");
  });
});

describe("the entry points", () => {
  it("renders no Settings row on a solo install", () => {
    render(
      <MemoryRouter>
        <PackProvider servers={undefined}>
          <PackSettingsCard />
        </PackProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText("Pack overview")).not.toBeInTheDocument();
  });

  it("renders the Settings row on a pack, pointing at /pack", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/settings",
          element: (
            <PackProvider servers={fixtureServers} ts={1_000} pollMs={1500}>
              <PackSettingsCard />
            </PackProvider>
          ),
        },
        { path: "/pack", element: <div data-testid="pack" /> },
      ],
      { initialEntries: ["/settings"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: /Pack overview/ }));
    expect(await screen.findByTestId("pack")).toBeInTheDocument();
  });

  it("puts no footer in a switcher that a solo install never opens", () => {
    // The switcher hides itself entirely when there is one machine and you are not parked on a peer,
    // so the footer inherits the hide rule rather than restating it — assert the whole thing is gone.
    const solo = fixtureServers.slice(0, 1);
    const router = createMemoryRouter(
      [{ path: "/", element: <ServerSwitcher servers={solo} scope={{}} /> }],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);
    expect(screen.queryByText("Pack overview")).not.toBeInTheDocument();
  });

  it("offers the census from the switcher sheet on a pack", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        { path: "/", element: <ServerSwitcher servers={fixtureServers} scope={{}} /> },
        { path: "/pack", element: <div data-testid="pack" /> },
      ],
      { initialEntries: ["/"] },
    );
    render(<RouterProvider router={router} />);

    await user.click(screen.getByRole("button", { name: /Switch host/ }));
    await user.click(await screen.findByRole("button", { name: "Pack overview" }));
    expect(await screen.findByTestId("pack")).toBeInTheDocument();
  });
});
