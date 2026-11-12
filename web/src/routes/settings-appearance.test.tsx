import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { APPEARANCE_DOCS_URL } from "@/components/appearance-intro";
import { withHeaderHost } from "@/test/header-host";
import { __resetDesign, setDesignMark } from "@/lib/design";
import { SettingsAppearanceRoute, SettingsCharacterRoute } from "./settings-sections";

// Settings → Appearance opens with "Make Collie your own", then the two cards that make the app
// yours, in the order a person decides them: Theme, then System/Light/Dark (the card still titled
// "Appearance"). The Character row follows them and opens the Character page below Appearance. The cards'
// own behaviour is pinned beside each component.

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: "/settings/appearance", element: withHeaderHost(<SettingsAppearanceRoute />) },
      { path: "/settings/appearance/character", element: withHeaderHost(<SettingsCharacterRoute />) },
    ],
    { initialEntries: ["/settings/appearance"] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  localStorage.clear();
  __resetDesign();
});

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("Settings → Appearance", () => {
  it("opens with Make Collie your own and a link to the themes page", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const link = screen.getByRole("link", { name: "How themes work" });
    expect(link.getAttribute("href")).toBe(APPEARANCE_DOCS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(precedes(heading, link)).toBe(true);
  });

  it("puts Theme, then System/Light/Dark under the opening", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const theme = screen.getByRole("combobox", { name: "Theme" });
    const halves = screen.getByRole("radiogroup", { name: "Appearance" });
    expect(precedes(heading, theme)).toBe(true);
    expect(precedes(theme, halves)).toBe(true);
    // The characters are on their own page; the Appearance page holds only a row for them.
    expect(screen.queryByRole("radiogroup", { name: "Character" })).toBeNull();
  });

  it("has the Pinch to zoom switch under the Zoom pill card, on until it is turned off", async () => {
    renderPage();
    const pill = await screen.findByText("Zoom pill");
    const pinch = screen.getByRole("switch", { name: "Pinch to zoom" });
    expect(pinch).toHaveAttribute("aria-checked", "true");
    expect(precedes(pill, pinch)).toBe(true);
  });

  it("has a Character row that says From the theme, and then the name of the device's choice", async () => {
    renderPage();
    const row = await screen.findByRole("button", { name: /Character/ });
    expect(row).toHaveTextContent("From the theme");
    act(() => setDesignMark("collie-collar"));
    expect(row).toHaveTextContent("Collie with collar");
    act(() => setDesignMark(null));
    expect(row).toHaveTextContent("From the theme");
  });

  it("opens the Character page below Appearance on a tap, and Back climbs to Appearance", async () => {
    const router = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Character/ }));
    expect(router.state.location.pathname).toBe("/settings/appearance/character");
    expect(await screen.findByRole("heading", { name: "Character" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(11);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings/appearance");
  });
});
