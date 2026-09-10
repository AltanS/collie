import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlaygroundApp, SECTIONS } from "./app";

// jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll (use-auto-scroll.ts) calls it
// on mount. Same shim agent-chat.test.tsx uses to mount the real component under jsdom.
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

// Every router-backed card here (PaneRouter, CrewRouter, SettingsRouter, …) settles through the same
// promise-based navigation pipeline motion.test.tsx documents for the app-walkthrough card, so a
// loaded CI runner needs seconds, not Testing Library's default 1000ms, before the first render lands.
const SLOW = { timeout: 12_000 } as const;

// The regression this pins: commit 52c08bb hoisted the app header out of the routes and onto a shelf
// above the router outlet (`RootLayout` in routes/root.tsx), so `<RouteHeader/>` now throws when
// mounted without an `<AppHeaderHost/>` above it — loud by design (app-header.tsx's `RouteHeader`).
// The unit suite got a wrapper for this (`test/header-host.tsx`), but the playground's OWN route
// fixtures (`PaneRouter`, `PaneStackRouter`, `CrewRouter`, `SettingsRouter` in `playground/harness.tsx`)
// were never given the same treatment, so every card built on them rendered React Router's default
// "Unexpected Application Error!" boundary instead of the state it claimed to show — silently,
// because nothing here was tested.
//
// This test is cheap on purpose: mount every SECTION once (via the `tab` prop, which forces the
// selected tab and skips the hash/localStorage a real click would touch) and assert no route's error
// boundary fired anywhere in it. It does not re-derive what each card should look like (that's the
// "reach it for real" line on the card itself) — it only guards the property that broke, which is
// "the playground shows the state it claims to, not a crash".
//
// `createMemoryRouter` initialises asynchronously even with synchronous loaders (it always resolves
// through a promise-based navigation pipeline), so the routers commit their real content one or more
// microtasks after `render()` returns — a bare synchronous query would pass vacuously against the
// still-empty pre-init DOM, and different cards settle at different times depending on what else is
// mounted (composer effects, MSW-backed fetches). The waits below are generous on purpose — the whole
// page used to be mounted at once here and settled in a few seconds under a loaded test runner; one
// tab at a time is lighter, but the budget is left as-is rather than re-measured down.
describe("the states playground", () => {
  it(
    "renders every card with no route throwing its error boundary",
    async () => {
      for (const entry of SECTIONS) {
        render(<PlaygroundApp tab={entry.def.id} />);

        // "Pane actions" is `AgentChat`'s own right-cluster button, portalled through `RouteHeader`
        // into `AppHeaderHost`'s right host; waiting on it is itself a positive assertion that the
        // host is really there, for the router kind (`PaneRouter`/`PaneStackRouter`) this regression
        // broke. "Crew"/"Settings" are the override host's take-over title (CrewRoute/SettingsRoute).
        if (entry.def.id === "pane") {
          await screen.findAllByRole("button", { name: "Pane actions" }, SLOW);
        } else if (entry.def.id === "crew") {
          await screen.findAllByRole("heading", { name: "Crew" }, SLOW);
        } else if (entry.def.id === "settings") {
          await screen.findAllByRole("heading", { name: "Settings" }, SLOW);
        } else {
          await screen.findAllByRole("heading", { name: entry.def.title }, SLOW);
        }

        expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

        if (entry.def.id === "pane") {
          expect(screen.getAllByRole("button", { name: "Pane actions" }).length).toBeGreaterThan(0);
        }
        if (entry.def.id === "crew") {
          expect(screen.getAllByRole("heading", { name: "Crew" }).length).toBeGreaterThan(0);
        }
        if (entry.def.id === "settings") {
          expect(screen.getAllByRole("heading", { name: "Settings" }).length).toBeGreaterThan(0);
        }

        cleanup();
      }
    },
    30_000,
  );
});

// The handles a browser case addresses. `state` on `Card` (playground/harness.tsx) renders as
// `data-state` on the card's wrapper, so a Playwright case says
// `[data-state="update-band-in-flight"]` instead of matching the card's label — the labels are
// prose, they carry em dashes and curly quotes, they get reworded, and two of them are identical
// already.
//
// The compiler already catches a card with NO handle, because the prop is required. It cannot catch
// two cards with the SAME handle, and that is what this test is for. It also refuses a handle that
// is not flat kebab-case, because a case in another file has to be able to type it from memory.
//
// The selector is `.pg-grid > *`: `Section` renders that grid and every card is a direct child of
// one, while `ui/collapse.tsx` renders its OWN `data-state` ("open" / "closed") deep inside several
// cards. Scoping to the grid's children tells the two apart without giving the app a second
// attribute. Only one section mounts at a time now, so the handles are collected one tab at a time
// and pooled into a single union before the rules run over it.
describe("the playground's card handles", () => {
  it(
    "gives every card a unique flat-kebab handle",
    async () => {
      const handles: string[] = [];
      for (const entry of SECTIONS) {
        const { container } = render(<PlaygroundApp tab={entry.def.id} />);
        // Let each section's routers settle before reading its cards, the same way the render test
        // does, so a card that would have thrown is not silently read as handle-less.
        await waitFor(
          () => expect(container.querySelectorAll(".pg-grid > *").length).toBeGreaterThan(0),
          SLOW,
        );
        for (const card of container.querySelectorAll(".pg-grid > *")) {
          handles.push(card.getAttribute("data-state") ?? "");
        }
        cleanup();
      }

      // A floor, not the count: adding a card must not mean editing this test. It is here only to
      // stop the three assertions below passing over an empty page.
      expect(handles.length).toBeGreaterThanOrEqual(54);

      expect(handles.filter((handle) => handle === "")).toEqual([]);
      expect(handles.filter((handle) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle))).toEqual([]);

      const seen = new Set<string>();
      const repeated: string[] = [];
      for (const handle of handles) {
        if (seen.has(handle)) repeated.push(handle);
        seen.add(handle);
      }
      expect(repeated).toEqual([]);
    },
    30_000,
  );
});

// The tab bar: the URL hash selects a section (and, with `#<id>/<card>`, scrolls a card into view),
// the last tab is remembered across visits, and it is a real ARIA tab list — roving focus included.
//
// TWO tab lists are always mounted (the sidebar's vertical rail and the top bar's horizontal row —
// see app.tsx's chrome comment), and only one is shown at a time via a `lg:` breakpoint jsdom does
// not evaluate, so both render here regardless of viewport. Every query below scopes to one list by
// its `aria-orientation` rather than asserting on `role="tab"` directly, which would find two.
function tablist(orientation: "horizontal" | "vertical") {
  const match = screen
    .getAllByRole("tablist")
    .find((el) => el.getAttribute("aria-orientation") === orientation);
  if (match === undefined) throw new Error(`no tablist with aria-orientation="${orientation}"`);
  return match;
}

describe("the playground's tab bar", () => {
  it(
    "selects the tab named in the hash and scrolls to the card handle",
    async () => {
      const scrollSpy = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
      window.location.hash = "#pane/pane-mid-tool-run";

      render(<PlaygroundApp />);

      await screen.findAllByRole("button", { name: "Pane actions" }, SLOW);
      expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "pg-panel-pane");
      await waitFor(() => expect(scrollSpy).toHaveBeenCalled(), SLOW);

      scrollSpy.mockRestore();
      window.location.hash = "";
    },
    30_000,
  );

  it(
    "remembers the last tab",
    async () => {
      render(<PlaygroundApp />);

      fireEvent.click(within(tablist("horizontal")).getByRole("tab", { name: "Crew" }));

      await screen.findAllByRole("heading", { name: "Crew" }, SLOW);
      expect(localStorage.getItem("collie.playground.tab")).toBe("crew");

      // A tab reached by editing the hash (or by back/forward, which fires the same event) must be
      // remembered too, not just a click.
      window.location.hash = "#settings";
      fireEvent(window, new Event("hashchange"));

      await screen.findAllByRole("heading", { name: "Settings" }, SLOW);
      expect(localStorage.getItem("collie.playground.tab")).toBe("settings");

      window.location.hash = "";
    },
    30_000,
  );

  it("moves the active tab with arrow keys (horizontal, top bar)", async () => {
    render(<PlaygroundApp />);
    const horizontal = within(tablist("horizontal"));

    const first = horizontal.getByRole("tab", { name: SECTIONS[0]?.def.title });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });

    const second = horizontal.getByRole("tab", { name: SECTIONS[1]?.def.title });
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(second);
  });

  it("moves the active tab with arrow keys (vertical, sidebar)", async () => {
    render(<PlaygroundApp />);
    const vertical = within(tablist("vertical"));

    const first = vertical.getByRole("tab", { name: SECTIONS[0]?.def.title });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });

    const second = vertical.getByRole("tab", { name: SECTIONS[1]?.def.title });
    await waitFor(() => expect(second).toHaveAttribute("aria-selected", "true"));
    expect(document.activeElement).toBe(second);

    // Left/Right must not move focus on the vertical list.
    fireEvent.keyDown(second, { key: "ArrowRight" });
    expect(second).toHaveAttribute("aria-selected", "true");
  });
});
