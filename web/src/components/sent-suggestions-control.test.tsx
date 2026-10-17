import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SentSuggestionsControl } from "@/components/sent-suggestions-control";

const STORAGE_KEY = "collie:display-prefs:v4";

// The Settings switch for the suggestion strip (M61): on by default, per device, stored with the
// display prefs.

describe("SentSuggestionsControl", () => {
  it("opens on, and a tap turns it off and stores that", async () => {
    render(<SentSuggestionsControl />);
    const toggle = screen.getByRole("switch", { name: "Suggestions from Sent" });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).sentSuggestions).toBe(false);
  });

  it("reads a stored off", () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ sentSuggestions: false }));
    render(<SentSuggestionsControl />);
    expect(screen.getByRole("switch", { name: "Suggestions from Sent" })).not.toBeChecked();
  });
});
