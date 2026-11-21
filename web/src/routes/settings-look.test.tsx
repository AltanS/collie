import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { APPEARANCE_DOCS_URL } from "@/components/appearance-intro";
import { withHeaderHost } from "@/test/header-host";
import { __resetDesign, setDesignMark } from "@/lib/design";
import { SettingsCharacterRoute, SettingsLookRoute } from "./settings-sections";

// Settings → Look and feel opens with "Make Collie your own", then the two cards that make the app
// yours, in the order a person decides them: Theme, then Light or dark. The Character row follows them and
// opens the Character page below. The cards' own behaviour is pinned beside each component.

function renderPage() {
  const router = createMemoryRouter(
    [
      { path: "/settings/look", element: withHeaderHost(<SettingsLookRoute />) },
      { path: "/settings/look/character", element: withHeaderHost(<SettingsCharacterRoute />) },
    ],
    { initialEntries: ["/settings/look"] },
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

describe("Settings → Look and feel", () => {
  it("opens with Make Collie your own and a link to the themes page", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const link = screen.getByRole("link", { name: "How themes work" });
    expect(link.getAttribute("href")).toBe(APPEARANCE_DOCS_URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(precedes(heading, link)).toBe(true);
  });

  it("puts Theme, then Light or dark under the opening", async () => {
    renderPage();
    const heading = await screen.findByRole("heading", { name: "Make Collie your own" });
    const theme = screen.getByRole("combobox", { name: "Theme" });
    const halves = screen.getByRole("radiogroup", { name: "Light or dark" });
    expect(precedes(heading, theme)).toBe(true);
    expect(precedes(theme, halves)).toBe(true);
    // The characters are on their own page; this page holds only a row for them.
    expect(screen.queryByRole("radiogroup", { name: "Character" })).toBeNull();
  });

  it("holds the words in one group: language, typeface, then the three text sizes", async () => {
    renderPage();
    const group = await screen.findByRole("region", { name: "Language and text" });
    const language = within(group).getByText("Language");
    const typeface = within(group).getByText("Typeface");
    const chat = within(group).getByText("Chat text size");
    const terminal = within(group).getByText("Terminal text size");
    const reply = within(group).getByText("Reply box text size");
    expect(precedes(language, typeface) && precedes(typeface, chat) && precedes(chat, terminal) && precedes(terminal, reply)).toBe(true);
  });

  it("ends with the layout group: Belt size, Large-screen layout, Project pictures, Moving pictures from tricks", async () => {
    renderPage();
    const group = await screen.findByRole("region", { name: "Layout and pictures" });
    const names = ["Belt size", "Large-screen layout", "Project pictures", "Moving pictures from tricks"].map((name) => within(group).getByText(name));
    expect(names.every((el, i) => i === 0 || precedes(names[i - 1]!, el))).toBe(true);
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

  it("opens the Character page below on a tap, and Back climbs to Look and feel", async () => {
    const router = renderPage();
    await userEvent.click(await screen.findByRole("button", { name: /Character/ }));
    expect(router.state.location.pathname).toBe("/settings/look/character");
    expect(await screen.findByRole("heading", { name: "Character" })).toBeInTheDocument();
    expect(screen.getAllByRole("radio")).toHaveLength(11);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(router.state.location.pathname).toBe("/settings/look");
  });
});
