import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { withHeaderHost } from "@/test/header-host";
import { SettingsRoute } from "./settings";

// Settings' HEADER, and only its header.
//
// This route used to hand-roll its own `<header>` beneath a comment claiming "one header treatment
// app-wide". It was not one: the hand-rolled bar carried no <AlphaBar/> and had its own padding
// recipe, so it stood 20px short of every other route's header and silently dropped the "you are on
// a prerelease build" strip on the way in. It fills the one hoisted header shell now, and these cases pin
// that — a false comment in the code is worse than no comment, so the claim is asserted rather than
// written down.

// The index carries NO loader now — the paired-device registry belongs to the one page that
// renders it (/settings/system). The section routes are stubs here: this file tests the index, and
// what each section mounts is that section's own business.
function renderSettings() {
  const router = createMemoryRouter(
    [
      { path: "/settings", element: withHeaderHost(<SettingsRoute />) },
      { path: "/settings/:section", element: <div data-testid="section" /> },
      { path: "/", element: <div data-testid="home" /> },
    ],
    { initialEntries: ["/settings"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

describe("SettingsRoute — the shared header shell", () => {
  it("mounts exactly one header, and it is the shell that carries the prerelease strip", async () => {
    // vitest's define stamps BUILD.version as "0.0.0-test", which IS a prerelease — so the real
    // shell shows the strip here. A hand-rolled header cannot.
    renderSettings();
    expect(await screen.findByText(/TEST/)).toBeInTheDocument();
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("leads with a 44px back button where every other route puts the Collie mark", async () => {
    renderSettings();
    const back = await screen.findByRole("button", { name: "Back" });
    expect(back.className).toContain("size-11");
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    // The mark is NOT here — this route leads with the way out, not with the way home.
    expect(screen.queryByRole("button", { name: /^Collie/ })).toBeNull();
  });
});

// ── THE FOOTER, AFTER THE UPDATE CHIP LEFT IT (M16/01) ──────────────────────────────────────────
//
// Settings used to end with three update surfaces for one subject. Updating has a page of its own
// now, so this page keeps one row that links to it — and the footer keeps the build stamp, which is
// a diagnostic and was never an update surface.
describe("SettingsRoute — the update surfaces", () => {
  it("keeps the build stamp and drops the footer update chip", async () => {
    renderSettings();
    // The build stamp is the vitest define — `v<version> · <sha> · <time> UTC`.
    expect(await screen.findByText(/^v0\.0\.0-test · .* UTC$/)).toBeInTheDocument();
    // Nothing on this page nudges an update any more: no chip line, no copyable command.
    expect(screen.queryByText(/Bridge restart needed/)).toBeNull();
    expect(screen.queryByRole("button", { name: /^Copy command/ })).toBeNull();
  });

  it("holds no update surface at all: they are one row on the System page now", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    // The row, the card and the check control all sit behind System. The word "Updates" IS still
    // on this page — it is the first word of the System row's blurb — so the assertion is about
    // the update ROW's own title, not about the string.
    expect(screen.queryByText("Updates", { selector: ".font-medium" })).toBeNull();
    expect(screen.queryByText("Update Collie")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check for updates" })).toBeNull();
  });
});

// ── THE INDEX ───────────────────────────────────────────────────────────────────────────────────
//
// Settings was one column of seventeen cards. The page is four rows now, and these cases pin the
// two things that makes true: every section is reachable, and no setting is still rendered here.
describe("SettingsRoute — the index", () => {
  it("offers the four sections, in the order of how standing a choice is", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    const rows = screen
      .getAllByRole("button")
      .map((b) => b.textContent ?? "")
      .filter((text) => /Appearance|Device|Alerts|System/.test(text));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Appearance");
    expect(rows[3]).toContain("System");
  });

  it("opens a section as a push, so back returns here rather than home", async () => {
    const router = renderSettings();
    await userEvent.click(await screen.findByRole("button", { name: /Appearance/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/appearance"));
    expect(screen.getByTestId("section")).toBeInTheDocument();
  });

  // The fifth row, and the only one that can be absent: it renders while `lib/experiments.ts` holds
  // something, because a row that opens an empty page is noise. Chat was the last thing filed
  // there and left in 1.17.0 (ADR 0082), so the index shows four rows.
  it("shows no Experiments row while nothing is filed under it", async () => {
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryByRole("button", { name: /Experiments/ })).toBeNull();
  });

  it("renders no setting of its own: every switch moved behind a row", async () => {
    // The regression this guards is a card being added back to the index out of habit. The index
    // has exactly one interactive element per section and nothing else with a switch role.
    renderSettings();
    await screen.findByRole("button", { name: /Appearance/ });
    expect(screen.queryAllByRole("switch")).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});
