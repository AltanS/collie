import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, MemoryRouter, RouterProvider } from "react-router";

import { formationLayout } from "@/components/pack-formation";
import { PackProvider } from "@/components/pack-provider";
import { PackSettingsCard } from "@/components/pack-settings-card";
import { ServerSwitcher } from "@/components/server-switcher";
import { type PackData } from "@/lib/loaders";
import type { PackMemberStatus } from "@/lib/types";
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

/** A roster entry with only the fields the layout reads — the geometry knows nothing else. */
function member(id: string, isLead = false): PackMemberStatus {
  return { id, name: id, isLead, health: "reachable", lastSeenAt: 1, secretBehind: false, provisional: false };
}

describe("formationLayout", () => {
  // The geometry is pinned as SHAPE, not as pixels: which row a machine lands in, whether the rows
  // above it exist at all, and that the V widens outward. Exact coordinates are the component's
  // business and would make this test a change-detector.
  it("puts a solo lead alone at the apex", () => {
    const nodes = formationLayout([member("a", true)], null);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.role).toBe("lead");
    expect(nodes[0]!.row).toBe(0);
  });

  it("stacks a named deputy directly under the lead, on the centre line", () => {
    const nodes = formationLayout([member("a", true), member("b")], "b");
    expect(nodes.map((n) => n.role)).toEqual(["lead", "deputy"]);
    // Same x, increasing y — the spine is vertical, and that is what makes it read as a chain.
    expect(nodes[1]!.x).toBe(nodes[0]!.x);
    expect(nodes[1]!.y).toBeGreaterThan(nodes[0]!.y);
    expect(nodes[1]!.row).toBe(1);
  });

  it("skips the deputy row entirely when nobody is named, rather than leaving a hole", () => {
    const nodes = formationLayout([member("a", true), member("b"), member("c")], null);
    expect(nodes.map((n) => n.role)).toEqual(["lead", "peer", "peer"]);
    // Both peers are the FIRST fan rank — row 1, not row 2 — so the drawing is one tier shallower.
    expect(nodes.map((n) => n.row)).toEqual([0, 1, 1]);
    // Left first, then right, straddling the centre line.
    expect(nodes[1]!.x).toBeLessThan(nodes[0]!.x);
    expect(nodes[2]!.x).toBeGreaterThan(nodes[0]!.x);
    expect(nodes[1]!.y).toBe(nodes[2]!.y);
  });

  it("fans seven machines into three widening ranks", () => {
    const members = [member("a", true), ...["b", "c", "d", "e", "f", "g"].map((id) => member(id))];
    const nodes = formationLayout(members, null);
    expect(nodes).toHaveLength(7);
    expect(nodes.map((n) => n.role)).toEqual(["lead", ...Array<string>(6).fill("peer")]);

    const peers = nodes.filter((n) => n.role === "peer");
    // Six peers fill the V — three ranks of two, each wider and lower than the last, and every rank
    // symmetric about the apex.
    for (const rank of [0, 1, 2]) {
      const left = peers[rank * 2]!;
      const right = peers[rank * 2 + 1]!;
      expect(left.y).toBe(right.y);
      expect(nodes[0]!.x - left.x).toBe(right.x - nodes[0]!.x);
      if (rank === 0) continue;
      const prev = peers[(rank - 1) * 2]!;
      expect(left.x).toBeLessThan(prev.x);
      expect(left.y).toBeGreaterThan(prev.y);
    }
  });

  it("wraps to a second V once one has run out of half-width", () => {
    const ids = ["b", "c", "d", "e", "f", "g", "h"];
    const nodes = formationLayout([member("a", true), ...ids.map((id) => member(id))], null);
    const peers = nodes.filter((n) => n.role === "peer");
    expect(peers).toHaveLength(7);

    // The seventh peer starts a new V rather than pushing the fan past the viewBox edge: back on
    // the narrow offset, and below the widest rank of the V above it.
    const wrapped = peers[6]!;
    expect(wrapped.x).toBe(peers[0]!.x);
    expect(wrapped.y).toBeGreaterThan(peers[5]!.y);
  });
});

describe("PackRoute", () => {
  it("wears the ONE header shell — the same one every other route mounts", async () => {
    // This page used to hand-roll its own <header> under a comment claiming "one header treatment
    // app-wide", which it was not: no prerelease strip, and its own padding recipe, so it stood 20px
    // short of every other route's header and dropped the "you are on a beta" line on the way in.
    // It mounts AppHeader now. The strip is the proof it is the real shell (vitest's BUILD.version is
    // "0.0.0-test", a prerelease), and the back button carries the row's 44px tap floor.
    renderPack(loaded);
    expect(await screen.findByText(/TEST/)).toBeInTheDocument();
    expect(document.querySelectorAll("header")).toHaveLength(1);
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
  });

  it("draws every member as a node, each announcing its name and its health", async () => {
    renderPack(loaded);

    const nodes = await screen.findAllByRole("button", { name: /bluefin|workshop|attic/ });
    expect(nodes.map((n) => n.getAttribute("aria-label"))).toEqual([
      "bluefin, lead, reachable",
      "workshop, deputy, reachable",
      "attic, conflicted",
    ]);
  });

  it("badges the lead's node and the deputy's, and nobody else's", async () => {
    renderPack(loaded);
    const nodes = await screen.findAllByRole("button", { name: /bluefin|workshop|attic/ });

    expect(within(nodes[0]!).getByText("lead")).toBeInTheDocument();
    expect(within(nodes[1]!).getByText("deputy")).toBeInTheDocument();
    expect(within(nodes[2]!).queryByText("lead")).not.toBeInTheDocument();
    expect(within(nodes[2]!).queryByText("deputy")).not.toBeInTheDocument();
  });

  it("draws no deputy node when nobody is named", async () => {
    renderPack({ status: { ...fixturePackStatus, deputy: null }, error: false });
    expect(await screen.findByRole("button", { name: "workshop, reachable" })).toBeInTheDocument();
    expect(screen.queryByText("deputy")).not.toBeInTheDocument();
  });

  it("captions the drawing with the pack, its size and how much of it answers", async () => {
    renderPack(loaded);
    expect(await screen.findByText("home · 3 machines · 2 reachable")).toBeInTheDocument();
  });

  it("opens a member's paperwork on a tap — and does not navigate", async () => {
    const user = userEvent.setup();
    const router = renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /^workshop/ }));
    expect(await screen.findByText("workshop.tail1234.ts.net:8787")).toBeInTheDocument();
    // The node itself is never a navigation — that is the second tap, inside the sheet.
    expect(router.state.location.pathname).toBe("/pack");
  });

  it("puts the pack-wide facts on the LEAD's sheet, and its own word on each member's", async () => {
    const user = userEvent.setup();
    renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /^bluefin/ }));
    // `rotatedAt` is aged against the payload's own `ts` — the LEAD's clock. 100_000 → 400_000 is
    // 5 minutes on that clock, and no value of `Date.now()` may change the answer.
    expect(await screen.findByText("generation 3 · rotated 5m")).toBeInTheDocument();
    // The deputy is named on the lead's sheet, and its warrant generation with it (ADR 0027).
    expect(screen.getByText(/warrant 2/)).toBeInTheDocument();
    expect(screen.getByText("reachable")).toBeInTheDocument();
  });

  it("says 'no deputy named' rather than leaving the lead's row blank", async () => {
    const user = userEvent.setup();
    renderPack({ status: { ...fixturePackStatus, deputy: null }, error: false });

    await user.click(await screen.findByRole("button", { name: /^bluefin/ }));
    expect(await screen.findByText("no deputy named")).toBeInTheDocument();
  });

  it("shouts about a conflict, a stale secret and a member never reached", async () => {
    const user = userEvent.setup();
    renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /^attic/ }));
    // The second lead and its warrant — the operator decides which believer is stale from these.
    expect(await screen.findByText("cellar also leads · warrant 7")).toBeInTheDocument();
    expect(screen.getByText("Has not picked up the current secret.")).toBeInTheDocument();
    expect(screen.getByText("Enrolled but never reached.")).toBeInTheDocument();
    // The lead's reason, verbatim — never paraphrased.
    expect(screen.getByText("pack protocol 2 (this collie speaks 1)")).toBeInTheDocument();
  });

  it("flags a member whose version differs from the lead's, and never the lead itself", async () => {
    const user = userEvent.setup();
    renderPack(loaded);

    // `workshop` runs 0.29.0 against the lead's 0.30.0.
    await user.click(await screen.findByRole("button", { name: /^workshop/ }));
    expect(await screen.findByText("differs from lead")).toBeInTheDocument();
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

    await user.click(await screen.findByRole("button", { name: /^workshop/ }));
    await user.click(await screen.findByRole("button", { name: "Go to this machine" }));
    expect(router.state.location.pathname).toBe("/");
    expect(router.state.location.search).toBe("?h=workshop");
  });

  it("opens the lead at the bare URL — absent `?h=` IS the lead", async () => {
    const user = userEvent.setup();
    const router = renderPack(loaded);

    await user.click(await screen.findByRole("button", { name: /^bluefin/ }));
    await user.click(await screen.findByRole("button", { name: "Go to this machine" }));
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
