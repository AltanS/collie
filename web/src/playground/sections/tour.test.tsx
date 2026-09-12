import { render, screen } from "@testing-library/react";

import { TourSection } from "./tour";
import { en } from "@/lib/i18n/messages/en";

// The section is how Altan reads the slides before anything mounts in the app, so the test that
// matters is "every card is really there, with a unique handle, and no error boundary swallowed one".

describe("Tour section", () => {
  it("renders every card with a unique flat-kebab handle and no error boundary", () => {
    const { container } = render(<TourSection />);

    expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

    const cards = [...container.querySelectorAll(".pg-grid > *")];
    expect(cards).toHaveLength(7);
    const handles = cards.map((c) => c.getAttribute("data-state") ?? "");
    expect(new Set(handles).size).toBe(handles.length);
    for (const h of handles) expect(h).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(new Set(handles)).toEqual(
      new Set([
        "slide-1",
        "slide-2",
        "slide-2-read-only",
        "slide-3",
        "push-unavailable",
        "push-decided",
        "settings-row",
      ]),
    );
  });

  it("shows each slide's own copy in its own card, and the read-only variant in its", async () => {
    const { container } = render(<TourSection />);
    // The Settings row is mounted inside the harness's memory router, which settles on a microtask
    // even with a synchronous loader (see app.test.tsx's own note on this).
    await screen.findByText(en["settings.tour.title"]);
    const card = (state: string) => {
      const el = container.querySelector(`[data-state="${state}"]`);
      if (!el) throw new Error(`no card with data-state="${state}"`);
      return el;
    };

    expect(card("slide-1").textContent).toContain(en["tour.slide1.body"]);
    expect(card("slide-2").textContent).toContain(en["tour.slide2.body"]);
    expect(card("slide-2-read-only").textContent).toContain(en["tour.slide2.bodyReadOnly"]);
    expect(card("slide-3").textContent).toContain(en["tour.push.enable"]);
    expect(card("push-unavailable").textContent).toContain(
      en["settings.push.availability.serverOff"],
    );
    expect(card("push-decided").textContent).toContain(en["tour.push.subscribed"]);
    expect(card("settings-row").textContent).toContain(en["settings.tour.title"]);
  });
});
