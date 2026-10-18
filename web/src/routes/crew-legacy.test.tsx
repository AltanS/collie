import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { en } from "@/lib/i18n/messages/en";
import { ja } from "@/lib/i18n/messages/ja";
import type { CrewData } from "@/lib/loaders";
import { fixtureCrewStatus, fixtureServers } from "@/test/handlers";

// M24: the pack became a crew and the old spelling still works. These cases were once a Playwright
// file (e2e/m24-crew.spec.ts) driven in a browser; none of them needs a real engine, because the
// redirect is a router fact and the rest is text. The crew page itself is covered in crew.test.tsx,
// and the dashboard footer line in home.test.tsx ("the crew line in the dashboard footer").

describe("the old /pack link", () => {
  it("lands on /crew with the host query intact, and leaves no history entry behind", async () => {
    // The REAL app router, not a copy of its route: the redirect is a loader on the `pack` route
    // there. Imported fresh so its browser history starts on the entry set below.
    vi.resetModules();
    window.history.replaceState(null, "", "/");
    const { router } = await import("@/router");

    const lengthBefore = window.history.length;
    await act(async () => {
      await router.navigate("/pack?h=workshop");
    });

    // The query is what makes the destination the right MACHINE: `?h=` is the scope.
    expect(router.state.location.pathname).toBe("/crew");
    expect(router.state.location.search).toBe("?h=workshop");
    // `replace`, not a push: a push would trap Back between the two spellings of one page.
    expect(window.history.length).toBe(lengthBefore);
    expect(window.location.pathname).toBe("/crew");
    router.dispose();
  });
});

describe("the crew page in Japanese", () => {
  it("is called クルー, with its own back label", async () => {
    // `crew.title` is "Crew" in German too, so only a locale that translates it proves anything.
    expect(ja["crew.title"]).not.toBe(en["crew.title"]);
    expect(ja["crew.nav.back"]).not.toBe(en["crew.nav.back"]);

    vi.resetModules();
    // Every module the page touches is re-imported together, so the header host and the page share
    // one copy of the header context.
    const [{ CrewRoute }, { __resetLocale, setLocale, whenLocaleReady }, { withHeaderHost }, { CrewProvider }] =
      await Promise.all([
        import("./crew"),
        import("@/lib/i18n"),
        import("@/test/header-host"),
        import("@/components/crew-provider"),
      ]);
    __resetLocale();
    const data: CrewData = { status: fixtureCrewStatus, error: false };
    const router = createMemoryRouter(
      [
        {
          path: "/crew",
          loader: () => data,
          element: withHeaderHost(
            <CrewProvider servers={fixtureServers}>
              <CrewRoute />
            </CrewProvider>,
          ),
        },
      ],
      { initialEntries: ["/crew"] },
    );
    render(<RouterProvider router={router} />);
    await act(async () => {
      setLocale("ja");
      await whenLocaleReady("ja");
    });

    expect(await screen.findByRole("heading", { name: ja["crew.title"] })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ja["crew.nav.back"] })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: en["crew.title"] })).not.toBeInTheDocument();
  });
});
