import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";

import { PlaygroundApp } from "./app";

// jsdom doesn't implement scrollTo; the terminal mirror's auto-scroll (use-auto-scroll.ts) calls it
// on mount. Same shim agent-chat.test.tsx uses to mount the real component under jsdom.
beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

// The regression this pins: commit 52c08bb hoisted the app header out of the routes and onto a shelf
// above the router outlet (`RootLayout` in routes/root.tsx), so `<RouteHeader/>` now throws when
// mounted without an `<AppHeaderHost/>` above it — loud by design (app-header.tsx's `RouteHeader`).
// The unit suite got a wrapper for this (`test/header-host.tsx`), but the playground's OWN route
// fixtures (`PaneRouter`, `PaneStackRouter`, `PackRouter`, `SettingsRouter` in `playground/harness.tsx`)
// were never given the same treatment, so every card built on them rendered React Router's default
// "Unexpected Application Error!" boundary instead of the state it claimed to show — silently,
// because nothing here was tested.
//
// This test is cheap on purpose: mount the WHOLE playground once and assert no route's error
// boundary fired anywhere on the page. It does not re-derive what each card should look like (that's
// the "reach it for real" line on the card itself) — it only guards the property that broke, which
// is "the playground shows the state it claims to, not a crash".
//
// `createMemoryRouter` initialises asynchronously even with synchronous loaders (it always resolves
// through a promise-based navigation pipeline), so the routers commit their real content one or more
// microtasks after `render()` returns — a bare synchronous query would pass vacuously against the
// still-empty pre-init DOM, and different cards settle at different times depending on what else is
// mounted (composer effects, MSW-backed fetches). The test waits, per marker, with `findBy*` rather
// than asserting once after a single fixed anchor.
describe("the states playground", () => {
  it(
    "renders every card with no route throwing its error boundary",
    async () => {
      render(<PlaygroundApp />);

      // Proves the page actually finished mounting its async routers, not just that render()
      // returned. The page mounts ~20 independent `createMemoryRouter`s (one per card), each on its
      // own microtask chain — under a loaded test runner (the full suite, not this file alone) that
      // can take a couple of seconds, so the wait is generous on purpose. "Pane actions" is
      // `AgentChat`'s own right-cluster button, portalled through `RouteHeader` into
      // `AppHeaderHost`'s right host; waiting on it is itself a positive assertion that the host is
      // really there, for the router kind (`PaneRouter`/`PaneStackRouter`) this regression broke.
      await screen.findAllByRole("button", { name: "Pane actions" }, { timeout: 8000 });
      await screen.findAllByRole("heading", { name: "Settings" }, { timeout: 8000 });

      expect(screen.queryByText(/unexpected application error/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/must be rendered inside/i)).not.toBeInTheDocument();

      // Positive checks on the exact router kinds this regression broke: each is content
      // `RouteHeader` portals into the shell's hosts, so finding it proves a live
      // `<AppHeaderHost/>` is really above the route — not just that nothing crashed. "Pack"/
      // "Settings" are the override host's take-over title (PackRoute/SettingsRoute).
      expect(screen.getAllByRole("heading", { name: "Pack" }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("heading", { name: "Settings" }).length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: "Pane actions" }).length).toBeGreaterThan(0);
    },
    20_000,
  );
});
