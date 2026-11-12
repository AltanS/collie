import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { PlaygroundApp, SECTIONS } from "./app";
import type { SectionDef } from "./layout";

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
// boundary fired anywhere in it. It does not re-derive what each card should look like
// — it only guards the property that broke, which is
// "the playground shows the state it claims to, not a crash".
//
// `createMemoryRouter` initialises asynchronously even with synchronous loaders (it always resolves
// through a promise-based navigation pipeline), so the routers commit their real content one or more
// microtasks after `render()` returns — a bare synchronous query would pass vacuously against the
// still-empty pre-init DOM, and different cards settle at different times depending on what else is
// mounted (composer effects, MSW-backed fetches). The waits below are generous on purpose — the whole
// page used to be mounted at once here and settled in a few seconds under a loaded test runner; one
// tab at a time is lighter, but the budget is left as-is rather than re-measured down.
// ONE CASE PER SECTION (2026-11-11). The whole page used to render in two cases of 30 s each, one for the
// error boundaries and one for the handles, and the first sat at its budget on a quiet machine. Now each
// section mounts ONCE, in its own case with its own budget: the case waits for the section to settle,
// checks that no route threw, and collects its card handles. The handle rules then run over the union in
// one last case, so coverage is the same (every card of every section renders) at half the renders.
// The cases run in order within this file; the last one needs the whole file run, and says so.

/** One section's own budget, well under what the whole page once had in one case. */
const SECTION_BUDGET = 20_000;

/** The handles every section case collected, by section. */
const handlesBySection = new Map<string, string[]>();

describe("the states playground", () => {
  // Each section's module (and what it imports) is loaded and transformed once, up front, so a case times
  // its section's render and not the cold import that the first section to use a module would pay.
  beforeAll(async () => {
    await Promise.all(SECTIONS.map(async (entry) => await entry.load()));
  }, 60_000);

  it.each(SECTIONS.map((entry) => [entry.def.id, entry] as const))(
    "renders the section %s with no route throwing its error boundary, and reads its card handles",
    async (_id, entry) => {
      const { container } = render(<PlaygroundApp tab={entry.def.id} />);

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
      // Let the section's routers settle before reading its cards, so a card that would have thrown is
      // not silently read as handle-less.
      await waitFor(() => expect(container.querySelectorAll(".pg-grid > *").length).toBeGreaterThan(0), SLOW);

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

      handlesBySection.set(
        entry.def.id,
        Array.from(container.querySelectorAll(".pg-grid > *"), (card) => card.getAttribute("data-state") ?? ""),
      );
      cleanup();
    },
    SECTION_BUDGET,
  );
});

// The handles a browser case addresses. `state` on `Card` (playground/layout.tsx) renders as
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
// attribute. The section cases above collected the handles one tab at a time; this case pools them.
describe("the playground's card handles", () => {
  it("gives every card a unique flat-kebab handle", () => {
    // Every section case ran: this file is run whole, never this case alone.
    expect(SECTIONS.filter((entry) => !handlesBySection.has(entry.def.id)).map((entry) => entry.def.id)).toEqual([]);
    const handles = [...handlesBySection.values()].flat();

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
  });
});

// The held-send cards (numbers 14 to 18 of the composer states, ADR 0061 amended 2026-10-18): the real
// composer, with the card floating in a slot at the mirror's bottom edge. Show all is the real tap, taken
// for you on card 16, so the page shows the open list without a click.
describe("the held-send cards", () => {
  it(
    "draws one row, a collapsed queue, an open queue, a mixed queue, and the card over the draft notice",
    async () => {
      const { container } = render(<PlaygroundApp tab="composer-states" />);
      const card = (state: string) => container.querySelector<HTMLElement>(`[data-state="${state}"]`)!;
      const held = (state: string) => card(state).querySelector<HTMLElement>('[data-slot="held-card"]');
      await waitFor(() => expect(held("held-three-expanded")?.getAttribute("data-mode")).toBe("expanded"), SLOW);

      expect(held("held-one-row")?.getAttribute("data-mode")).toBe("single");
      expect(held("held-three-collapsed")?.getAttribute("data-mode")).toBe("collapsed");
      expect(card("held-three-expanded").querySelectorAll('[data-slot="held-row"]')).toHaveLength(3);
      expect(held("held-mixed")?.getAttribute("data-mode")).toBe("collapsed");
      const stacked = card("held-with-draft-notice").querySelector('[data-slot="floating-cards"]')!;
      expect(Array.from(stacked.children).map((child) => child.getAttribute("data-slot"))).toEqual(["held-card", "terminal-draft-notice"]);
    },
    30_000,
  );
});

// A card is its label alone. `reach`, `note` and a section's `intent` show only while the page-wide
// Notes switch is on; the switch is remembered in localStorage.
describe("the Notes switch", () => {
  it(
    "hides reach lines by default, shows them when on, and remembers the choice",
    async () => {
      localStorage.removeItem("collie.playground.notes");
      const { container } = render(<PlaygroundApp tab="cache" />);
      await waitFor(() => expect(container.querySelectorAll(".pg-grid > *").length).toBeGreaterThan(0), SLOW);
      expect(screen.queryByText(/reach it for real:/)).not.toBeInTheDocument();

      const switches = screen.getAllByRole("group", { name: "Notes" });
      fireEvent.click(within(switches[0]!).getByRole("button", { name: "On" }));
      expect(screen.getAllByText(/reach it for real:/).length).toBeGreaterThan(0);
      expect(localStorage.getItem("collie.playground.notes")).toBe("on");

      fireEvent.click(within(switches[0]!).getByRole("button", { name: "Off" }));
      expect(screen.queryByText(/reach it for real:/)).not.toBeInTheDocument();
      expect(localStorage.getItem("collie.playground.notes")).toBe("off");
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
  it("renders a main landmark", () => {
    render(<PlaygroundApp />);
    expect(screen.getAllByRole("main").length).toBeGreaterThan(0);
  });

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

// Each section is its own page now, loaded when it is opened, so the nav names a section before its
// file is there. The registry's id and title must stay the file's own `DEF`, or the tab and the
// heading drift apart.
describe("the playground's pages", () => {
  it("names every section as its own file does", async () => {
    for (const entry of SECTIONS) {
      // SAFETY: every file under sections/ that the registry names exports `DEF: SectionDef`; a file
      // without one fails the toEqual below on `undefined`, which is the failure this test wants.
      const mod = (await import(`./sections/${entry.def.id}.tsx`)) as { DEF: SectionDef };
      expect({ id: mod.DEF.id, title: mod.DEF.title }).toEqual(entry.def);
    }
  });

  it(
    "shows one group as a sub-page and goes back to all of them",
    async () => {
      window.location.hash = "#changes:one-file";
      render(<PlaygroundApp />);

      const nav = await screen.findByRole("navigation", { name: "Changes pages" }, SLOW);
      expect(within(nav).getByRole("link", { name: "One file" })).toHaveAttribute("aria-current", "page");
      expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual(["One file"]);

      fireEvent.click(within(nav).getByRole("link", { name: "All" }));
      await waitFor(() => expect(screen.getAllByRole("heading", { level: 3 }).length).toBeGreaterThan(1));
      expect(window.location.hash).toBe("#changes");

      window.location.hash = "";
    },
    30_000,
  );
});
