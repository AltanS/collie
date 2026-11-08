import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { APPEARANCE_DOCS_URL } from "@/components/appearance-intro";
import { withHeaderHost } from "@/test/header-host";
import { SettingsAppearanceRoute } from "./settings-sections";

// Settings → Appearance opens with "Make Collie your own", then the three cards that make the app
// yours, in the order a person decides them: Character, Theme, then System/Light/Dark (the card
// still titled "Appearance"). The cards' own behaviour is pinned beside each component.

function renderPage() {
  const router = createMemoryRouter(
    [{ path: "/settings/appearance", element: withHeaderHost(<SettingsAppearanceRoute />) }],
    { initialEntries: ["/settings/appearance"] },
  );
  render(<RouterProvider router={router} />);
}

/** True when `a` comes before `b` in document order. */
function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

describe("Settings → Appearance", () => {
  it("opens with Make Collie your own and a link to the themes page", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const link = screen.getByRole("link", { name: "How themes and characters work" });
    expect(link.getAttribute("href")).toBe(APPEARANCE_DOCS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(precedes(heading, link)).toBe(true);
  });

  it("puts Character, then Theme, then System/Light/Dark under the opening", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const character = screen.getByRole("radiogroup", { name: "Character" });
    const theme = screen.getByRole("combobox", { name: "Theme" });
    const halves = screen.getByRole("radiogroup", { name: "Appearance" });
    expect(precedes(heading, character)).toBe(true);
    expect(precedes(character, theme)).toBe(true);
    expect(precedes(theme, halves)).toBe(true);
  });
});
