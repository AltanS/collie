import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { MotionSection } from "./motion";

// jsdom doesn't implement scrollTo; some of the real components this section mounts call it on
// mount (agent-chat.test.tsx and app.test.tsx carry the same shim for the same reason).
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

// The app-walkthrough card mounts the real app router with real loaders on fixture data, so every
// wait in this file rides that router's own settling time, not a fake timer. Testing Library's
// default 1000ms findBy*/waitFor timeout is fine in isolation but too tight on a loaded CI runner.
const SLOW = { timeout: 10_000 } as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement, so an Element found by this selector is an HTMLElement.
  return el as HTMLElement;
}

describe("Motion section", () => {
  it(
    "renders every card, no error boundary, unique flat-kebab handles",
    async () => {
      const { container } = render(<MotionSection />);

      // RootRouter initialises asynchronously even with a synchronous loader (createMemoryRouter
      // always resolves through a promise-based navigation pipeline, see app.test.tsx's own note on
      // this). Waiting on a router-driven card's text is what proves every router on the page has
      // actually settled before the assertions below run — the "pending-controls" card's
      // UpdateCheckControl button, mounted through a RootRouter same as every other router-backed
      // card here.
      await screen.findByRole("button", { name: "Check for updates" }, SLOW);

      expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

      const cards = [...container.querySelectorAll(".pg-grid > *")];
      expect(cards.length).toBeGreaterThanOrEqual(8);

      const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
      expect(handles.every((h) => h.length > 0)).toBe(true);
      expect(new Set(handles).size).toBe(handles.length);
      for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    },
    30_000,
  );

  it(
    "app-walkthrough: the real app navigates, and the readout follows it",
    async () => {
      render(<MotionSection />);
      const card = cardFor("app-walkthrough");
      const routeLine = () =>
        card.querySelector('[data-slot="walkthrough-route"]')?.textContent ?? "";

      // The card mounts the app's own route table, whose root loader resolves through the router's
      // promise pipeline before any route element appears (see the case above on this).
      await waitFor(() => expect(routeLine()).toContain("route: /"), SLOW);

      fireEvent.click(within(card).getByRole("button", { name: "Pane" }));

      await waitFor(() => expect(routeLine()).toContain("route: /pane/"), SLOW);
      // The pane's own header, portalled into the one shell header by the real DetailRoute.
      expect(
        await within(card).findByRole("button", { name: "Pane actions" }, SLOW),
      ).toBeInTheDocument();

      fireEvent.click(within(card).getByRole("button", { name: "Dashboard" }));

      await waitFor(() => expect(routeLine()).toContain("route: /"), SLOW);
      expect(routeLine()).not.toContain("/pane/");
      expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
    },
    30_000,
  );

  it(
    "app-walkthrough: space, tab and pane chips inside the app all lead somewhere",
    async () => {
      render(<MotionSection />);
      const card = cardFor("app-walkthrough");
      const routeLine = () =>
        card.querySelector('[data-slot="walkthrough-route"]')?.textContent ?? "";

      await waitFor(() => expect(routeLine()).toContain("route: /"), SLOW);

      // A space row on the dashboard's navigator drills in.
      fireEvent.click(await within(card).findByRole("button", { name: /collie.+pane/i }, SLOW));
      await waitFor(() => expect(routeLine()).toContain("route: /space/"), SLOW);

      // A tab chip filters the space in place, so the route must NOT move off the space.
      const tabs = await within(card).findByRole("navigation", { name: "Tabs" }, SLOW);
      fireEvent.click(within(tabs).getByRole("button", { name: /docs/i }));
      await waitFor(
        () => expect(within(card).getByText(/ARCHITECTURE/)).toBeInTheDocument(),
        SLOW,
      );
      expect(routeLine()).toContain("route: /space/");

      // A pane row in the space opens that pane. It resolves in the snapshot, so the route STAYS on
      // the pane: an unresolvable pane is what used to bounce the walk back to the dashboard.
      fireEvent.click(within(card).getByRole("button", { name: /ARCHITECTURE/ }));
      await waitFor(() => expect(routeLine()).toContain("route: /pane/"), SLOW);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(routeLine()).toContain("route: /pane/");
      expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
    },
    30_000,
  );

  it(
    "collapse-primitive: toggling flips the Collapse root's data-state",
    async () => {
      render(<MotionSection />);
      const card = cardFor("collapse-primitive");
      const collapseRoot = () => card.querySelector('[data-slot="collapse"]');

      expect(collapseRoot()?.getAttribute("data-state")).toBe("open");

      const openGroup = within(card).getByRole("group", { name: "open" });
      fireEvent.click(within(openGroup).getByRole("button", { name: "Off" }));

      await waitFor(() => {
        expect(collapseRoot()?.getAttribute("data-state")).toBe("closed");
      }, SLOW);
    },
    30_000,
  );
});
