import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { useStatus } from "@/lib/status";
import { NoticesSection } from "./notices";

// jsdom doesn't implement scrollTo; some of the real components this section mounts call it on
// mount (agent-chat.test.tsx and app.test.tsx carry the same shim for the same reason).
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

// The strip band and update-ribbon cards mount RootRouter with a real loader on fixture data (see
// StripBandCard/UpdateRibbonSwapsCard in ./notices.tsx), the same settling exposure motion.test.tsx
// documents for the app-walkthrough card: a loaded CI runner needs seconds, not Testing Library's
// default 1000ms, for the router's first render to land.
const SLOW = { timeout: 10_000 } as const;

function cardFor(state: string): HTMLElement {
  const el = document.querySelector(`[data-state="${state}"]`);
  if (!el) throw new Error(`no card with data-state="${state}"`);
  // SAFETY: every Card in this section renders a plain <div data-state="…"> (harness.tsx's Card),
  // never an SVG or other non-HTMLElement, so an Element found by this selector is an HTMLElement.
  return el as HTMLElement;
}

describe("Notices section", () => {
  it(
    "renders every card, no error boundary, unique flat-kebab handles",
    async () => {
      const { container } = render(<NoticesSection />);

      // RootRouter initialises asynchronously even with a synchronous loader (createMemoryRouter
      // always resolves through a promise-based navigation pipeline, see app.test.tsx's own note on
      // this). Waiting on a router-driven card's text is what proves every router on the page has
      // actually settled before the assertions below run.
      await screen.findByText("Auth refused", {}, SLOW);

      expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

      const cards = [...container.querySelectorAll(".pg-grid > *")];
      expect(cards.length).toBeGreaterThanOrEqual(5);

      const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
      expect(handles.every((h) => h.length > 0)).toBe(true);
      expect(new Set(handles).size).toBe(handles.length);
      for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    },
    30_000,
  );

  it(
    "strip-band-arbitration: AUTH wins by default, OUTAGE takes over once AUTH is off",
    async () => {
      render(<NoticesSection />);
      await screen.findByText("Auth refused", {}, SLOW);

      const card = cardFor("strip-band-arbitration");
      const activeText = () => card.querySelector("[data-active]")?.textContent ?? null;

      expect(activeText()).toBe("Auth refused");

      const authGroup = within(card).getByRole("group", { name: "Auth strip" });
      fireEvent.click(within(authGroup).getByRole("button", { name: "Off" }));

      await waitFor(() => {
        expect(activeText()).toBe("Bridge unreachable");
      }, SLOW);
    },
    30_000,
  );

  it("status-toast: a tone button publishes to lib/status, and unmount clears it", async () => {
    const { unmount } = render(<NoticesSection />);
    const card = cardFor("status-toast");

    fireEvent.click(within(card).getByRole("button", { name: "Success" }));

    await waitFor(() => {
      expect(within(card).getAllByText("Sent").length).toBeGreaterThan(0);
    });

    unmount();

    const probe = renderHook(() => useStatus());
    expect(probe.result.current).toBeNull();
  });
});
