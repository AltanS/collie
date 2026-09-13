import { render, screen } from "@testing-library/react";

import { TourSection } from "./tour";
import { en } from "@/lib/i18n/messages/en";

// The section is how Altan reads the first-run screen before anything mounts in the app, so the test
// that matters is "every card is really there, with a unique handle, and no error boundary swallowed
// one".

describe("First run section", () => {
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
        "first-run-fresh",
        "first-run-panes",
        "first-run-unpaired",
        "first-run-crew",
        "first-run-push-blocked",
        "first-run-installed",
        "settings-row",
      ]),
    );
  });

  it("shows each install's own facts in its own card", async () => {
    const { container } = render(<TourSection />);
    // The Settings row is mounted inside the harness's memory router, which settles on a microtask
    // even with a synchronous loader (see app.test.tsx's own note on this).
    await screen.findByText(en["settings.tour.title"]);
    const card = (state: string) => {
      const el = container.querySelector(`[data-state="${state}"]`);
      if (!el) throw new Error(`no card with data-state="${state}"`);
      return el;
    };

    expect(card("first-run-fresh").textContent).toContain(en["tour.setup.noPanes"]);
    expect(card("first-run-panes").textContent).toContain("4 panes, 1 needs you");
    expect(card("first-run-unpaired").textContent).toContain(en["tour.pair.title"]);
    expect(card("first-run-crew").textContent).toContain("3 machines in your crew");
    expect(card("first-run-push-blocked").textContent).toContain(en["tour.setup.pushOff"]);
    expect(card("first-run-installed").textContent).toContain(en["tour.install.title"]);
    expect(card("settings-row").textContent).toContain(en["settings.tour.title"]);
  });
});
