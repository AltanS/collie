import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TrickAboutSheet, aboutParagraphs } from "@/components/trick-about-sheet";
import { ABOUT_MAX, type WireTrickInfo } from "@/lib/tricks/schema";

// A trick's About sheet: the name as the title, the description and the about paragraphs, then two groups
// built only from what the bridge already sends for the row.

const BASE: WireTrickInfo = {
  host: "bluefin",
  id: "gates",
  name: "Release Gates",
  icon: "flask",
  on: false,
  state: "off",
  places: ["belt", "dashboard"],
  provenance: { via: "folder" },
};

const FULL: WireTrickInfo = {
  ...BASE,
  description: "Which release checks are green.",
  about: "It shows each check of the release branch.\n\nIt never changes anything.",
  inputs: { globs: ["TODO.md"], crew: false },
  env: ["GH_TOKEN"],
  warnings: [{ kind: "network", text: "x" }],
  provenance: { via: "repo", at: "2026-11-08T09:38:00Z", repo: "owner/gates-trick", sha: "3f2a91c0d4e5" },
};

function open(trick: WireTrickInfo, extra: { runsOn?: { lead?: string }; onClose?: () => void } = {}) {
  return render(<TrickAboutSheet trick={trick} runsOn={extra.runsOn} open onClose={extra.onClose ?? vi.fn()} />);
}

describe("aboutParagraphs", () => {
  it("splits on a blank line, trims, and drops empty paragraphs", () => {
    expect(aboutParagraphs("one\n\ntwo\n  \n\n  three  ")).toEqual(["one", "two", "three"]);
    expect(aboutParagraphs("one\ntwo")).toEqual(["one\ntwo"]);
    expect(aboutParagraphs("\n\n")).toEqual([]);
  });
});

describe("TrickAboutSheet", () => {
  it("is a dialog named by the trick, with the description and one paragraph element per paragraph", () => {
    open(FULL);
    const dialog = screen.getByRole("dialog", { name: "Release Gates" });
    expect(dialog.querySelector('[data-line="description"]')).toHaveTextContent("Which release checks are green.");
    const paragraphs = [...dialog.querySelectorAll('[data-section="about"] p')].map((p) => p.textContent);
    expect(paragraphs).toEqual(["It shows each check of the release branch.", "It never changes anything."]);
  });

  it("says so in one muted line when the trick has no about", () => {
    open(BASE);
    expect(screen.getByText("This trick has no description.")).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector('[data-line="description"]')).toBeNull();
  });

  it("draws about as plain text: markup and links in it are text, not elements", () => {
    open({ ...BASE, about: "Use <b>bold</b> and [a link](https://example.com) and https://example.com" });
    const body = screen.getByRole("dialog").querySelector('[data-section="about"]');
    expect(body?.querySelector("b, a")).toBeNull();
    expect(body).toHaveTextContent("Use <b>bold</b> and [a link](https://example.com) and https://example.com");
  });

  it("lists what it does from the wire alone, in the card's own words", () => {
    open(FULL);
    const does = within(screen.getByRole("dialog")).getByRole("list", { name: "What it does" });
    const rows = within(does).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows).toEqual([
      "Draws in: belt, Dashboard.",
      "Reads TODO.md in your agent sessions' folders.",
      "Asks for the environment names GH_TOKEN.",
      "This trick reaches the network.",
    ]);
  });

  it("leaves out each row whose fact is absent, and the whole group when none is there", () => {
    open({ ...BASE, places: [] });
    expect(screen.queryByText("What it does")).toBeNull();
    expect(screen.getByText("Where it comes from")).toBeInTheDocument();
  });

  it("names the origin with the short commit, else says it was added on this machine", () => {
    const { unmount } = open(FULL);
    expect(within(screen.getByRole("list", { name: "Where it comes from" })).getByText("From owner/gates-trick @ 3f2a91c")).toBeInTheDocument();
    unmount();
    open({ ...BASE, provenance: { via: "agent", at: "2026-11-08T09:38:00Z" } });
    expect(screen.getByText("Added on this machine.")).toBeInTheDocument();
  });

  it("adds the one line a bridge that runs no tricks says", () => {
    open(BASE, { runsOn: { lead: "desk" } });
    expect(screen.getByText("Tricks run on the lead of this crew (desk). This machine runs none.")).toBeInTheDocument();
  });

  it("holds a long about at the cap in the sheet without a control of its own", () => {
    const paragraph = "word ".repeat(59).trim();
    const about = Array.from({ length: 4 }, () => paragraph).join("\n\n").slice(0, ABOUT_MAX);
    open({ ...BASE, about });
    expect(screen.getByRole("dialog").querySelectorAll('[data-section="about"] p').length).toBe(4);
    // The only buttons are the sheet's own Close and its scrim.
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Close"]);
  });

  describe("the Updates group", () => {
    const ON: WireTrickInfo = { ...FULL, on: true, state: "ok", warnings: undefined };
    const HINT = "A change that asks for new rights, or does something new such as reaching the network, still asks.";

    it("is the last group, with the switch at the wire's position and the hint under it", () => {
      render(<TrickAboutSheet trick={{ ...ON, auto: true }} open onClose={vi.fn()} onAuto={vi.fn()} />);
      const groups = [...screen.getByRole("dialog").querySelectorAll("[data-section]")].map((g) => g.getAttribute("data-section"));
      expect(groups.at(-1)).toBe("updates");
      const group = screen.getByRole("dialog").querySelector<HTMLElement>('[data-section="updates"]');
      if (group === null) throw new Error("no Updates group");
      expect(within(group).getByRole("switch", { name: "Take changes without asking" })).toBeChecked();
      expect(within(group).getByText(HINT)).toBeInTheDocument();
    });

    it("writes the position asked for, on and off", async () => {
      const user = userEvent.setup();
      const onAuto = vi.fn();
      const { rerender } = render(<TrickAboutSheet trick={ON} open onClose={vi.fn()} onAuto={onAuto} auto={false} />);
      await user.click(screen.getByRole("switch", { name: "Take changes without asking" }));
      expect(onAuto).toHaveBeenLastCalledWith(true);
      rerender(<TrickAboutSheet trick={ON} open onClose={vi.fn()} onAuto={onAuto} auto />);
      await user.click(screen.getByRole("switch", { name: "Take changes without asking" }));
      expect(onAuto).toHaveBeenLastCalledWith(false);
    });

    it("is not drawn for a trick that is off, on a bridge that runs none, or with no write given", () => {
      const { unmount } = render(<TrickAboutSheet trick={{ ...ON, on: false, state: "off" }} open onClose={vi.fn()} onAuto={vi.fn()} />);
      expect(screen.queryByText("Updates")).toBeNull();
      unmount();
      const crew = render(<TrickAboutSheet trick={ON} runsOn={{ lead: "desk" }} open onClose={vi.fn()} onAuto={vi.fn()} />);
      expect(screen.queryByText("Updates")).toBeNull();
      crew.unmount();
      render(<TrickAboutSheet trick={ON} open onClose={vi.fn()} />);
      expect(screen.queryByRole("switch")).toBeNull();
    });

    it("is a switch that may not be flipped on a device that may only read", () => {
      render(<TrickAboutSheet trick={ON} open onClose={vi.fn()} onAuto={vi.fn()} canWrite={false} />);
      expect(screen.getByRole("switch", { name: "Take changes without asking" })).toBeDisabled();
    });
  });

  it("closes from the close button and from Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    open(FULL, { onClose });
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
