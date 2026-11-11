import { readFileSync } from "node:fs";
import { join } from "node:path";

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OfficialTrickAboutSheet, TrickAboutSheet, aboutParagraphs } from "@/components/trick-about-sheet";
import { readTrick } from "@/lib/tricks/wire";
import { ABOUT_MAX, AGENT_VIEW_LATER, AGENT_VIEW_TAP_WORDS, AGENT_VIEW_WORDS, RULES_WORDS, type WireOfficialTrick, type WireTrickInfo } from "@/lib/tricks/schema";

// A trick's About sheet: the name as the title, the description and the about paragraphs, then two groups
// built only from what the bridge already sends for the row.

const BASE: WireTrickInfo = {
  host: "lodge",
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

  it("says under the text that the author wrote it and Collie did not check it, with an about or a description", () => {
    const { unmount } = open(FULL);
    const note = screen.getByRole("dialog").querySelector('[data-line="author-note"]');
    expect(note).toHaveTextContent("Written by the trick's author. Collie did not check it.");
    expect(note?.className).toContain("text-muted-foreground");
    // It sits after the about paragraphs and before the bridge's own facts.
    const body = screen.getByRole("dialog").querySelector('[data-slot="trick-about-body"]');
    const order = [...(body?.children ?? [])].map((el) => el.getAttribute("data-section") ?? el.getAttribute("data-line"));
    expect(order).toEqual(["description", "about", "author-note", "does", "from"]);
    unmount();
    // A description alone is the text: its line, then the note, and no "no description" line.
    open({ ...BASE, description: "Only a line." });
    expect(screen.getByText("Written by the trick's author. Collie did not check it.")).toBeInTheDocument();
    expect(screen.queryByText("This trick has no description.")).toBeNull();
    const alone = screen.getByRole("dialog").querySelector('[data-slot="trick-about-body"]');
    expect([...(alone?.children ?? [])].map((el) => el.getAttribute("data-section") ?? el.getAttribute("data-line"))).toEqual(["description", "author-note", "does", "from"]);
  });

  it("says no description only when the trick has neither an about nor a description", () => {
    const { unmount } = open({ ...BASE, about: "Only an about." });
    expect(screen.queryByText("This trick has no description.")).toBeNull();
    unmount();
    open(BASE);
    expect(screen.getByText("This trick has no description.")).toBeInTheDocument();
  });

  it("says so in one muted line when the trick has no about, and draws no author note", () => {
    open(BASE);
    expect(screen.getByText("This trick has no description.")).toBeInTheDocument();
    expect(screen.queryByText("Written by the trick's author. Collie did not check it.")).toBeNull();
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

  it("says who proposed a trick that came from collie trick propose, and on which machine", () => {
    const { unmount } = open({ ...BASE, provenance: { via: "agent", at: "2026-11-08T09:38:00Z", proposed: { by: "agent", host: "workshop" } } });
    expect(screen.getByText("Proposed by an agent session on workshop.")).toBeInTheDocument();
    expect(screen.queryByText("Added on this machine.")).toBeNull();
    unmount();
    open({ ...BASE, provenance: { via: "cli", proposed: { by: "terminal", host: "lodge" } } });
    expect(screen.getByText("Proposed from lodge. The session is not confirmed.")).toBeInTheDocument();
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

describe("an agent view and its rules (contract 2)", () => {
  // The fixture the bridge's own tests read: the bytes on disk are the bytes the sheet draws.
  const RULES_BYTES = readFileSync(join(import.meta.dirname, "..", "..", "..", "bridge", "tricks", "fixtures", "morph", "rules.md"));
  const RULES_TEXT = RULES_BYTES.toString("latin1");
  const MORPH: WireTrickInfo = {
    host: "lodge",
    id: "morph",
    name: "Morph",
    icon: "eye",
    on: true,
    state: "ok",
    places: [],
    agentView: true,
    rules: { file: "rules.md", text: RULES_TEXT },
    description: "Your agent answers by drawing one screen.",
    provenance: { via: "folder" },
  };
  const toggle = () => screen.getByRole("button", { name: "Read the instructions" });

  it("lists the two rights lines, the rules line and the later note under What it does, in the schema's words", () => {
    render(<TrickAboutSheet trick={MORPH} open onClose={vi.fn()} />);
    const does = screen.getByRole("list", { name: "What it does" });
    expect([...does.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Draws in: agent view.", AGENT_VIEW_WORDS, AGENT_VIEW_TAP_WORDS, RULES_WORDS, AGENT_VIEW_LATER]);
    expect(AGENT_VIEW_WORDS).toBe("Adds a view of a session that the session's own agent draws. You switch it on per session.");
    expect(AGENT_VIEW_TAP_WORDS).toBe("A tap in that view sends a message in your name to that session only.");
    expect(RULES_WORDS).toBe("Gives your agents instructions written by its author.");
  });

  it("holds the rules behind a closed fold, and opens them whole: the text on the screen is the file's bytes", async () => {
    const user = userEvent.setup();
    render(<TrickAboutSheet trick={MORPH} open onClose={vi.fn()} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog").querySelector('[data-line="rules-text"]')).toBeNull();
    await user.click(toggle());
    expect(screen.getByRole("button", { name: "Hide the instructions" })).toHaveAttribute("aria-expanded", "true");
    const pre = screen.getByRole("dialog").querySelector('[data-line="rules-text"]');
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    // Byte for byte: the file, the wire's reader, the drawn text.
    const wired = readTrick(JSON.parse(JSON.stringify(MORPH)));
    expect(wired?.rules?.text).toBe(RULES_TEXT);
    expect(Buffer.from(pre?.textContent ?? "", "latin1").equals(RULES_BYTES)).toBe(true);
    // Never markdown: no element inside, just the text.
    expect(pre?.children.length).toBe(0);
  });

  it("the playground's Morph rules are the bridge fixture's bytes", async () => {
    const { MORPH_RULES } = await import("@/playground/fixtures/morph");
    expect(MORPH_RULES).toBe(RULES_TEXT);
  });

  it("a markdown-looking line stays text", async () => {
    const user = userEvent.setup();
    const text = "# Not a heading\n**not bold** [not a link](https://example.com)\n<b>not html</b>\n";
    render(<TrickAboutSheet trick={{ ...MORPH, rules: { file: "rules.md", text } }} open onClose={vi.fn()} />);
    await user.click(toggle());
    const pre = screen.getByRole("dialog").querySelector('[data-line="rules-text"]');
    expect(pre?.textContent).toBe(text);
    expect(screen.getByRole("dialog").querySelector("a, b, h1, strong")).toBeNull();
  });

  it("draws no Take changes without asking switch for a trick with rules, even with the write given", () => {
    render(<TrickAboutSheet trick={{ ...MORPH, auto: true }} open onClose={vi.fn()} onAuto={vi.fn()} />);
    expect(screen.queryByText("Updates")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Take changes without asking" })).toBeNull();
  });

  it("the not-added sheet shows the rules line and the same fold when the list carries rules", async () => {
    const user = userEvent.setup();
    const entry: WireOfficialTrick = { id: "morph", name: "Morph", description: "Your agent answers by drawing one screen.", repo: "https://example.com/tricks.git", repoName: "owner/tricks", commit: "a".repeat(40), state: "absent", rules: { file: "rules.md", text: RULES_TEXT } };
    render(<OfficialTrickAboutSheet entry={entry} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    expect(screen.getByText(RULES_WORDS)).toBeInTheDocument();
    await user.click(toggle());
    expect(screen.getByRole("dialog").querySelector('[data-line="rules-text"]')?.textContent).toBe(RULES_TEXT);
  });
});

describe("review 8 V-N5: rules the phone cannot show, and no auto switch on any agent view", () => {
  const VIEW: WireTrickInfo = { host: "lodge", id: "morph", name: "Morph", icon: "eye", on: true, state: "ok", places: [], agentView: true, provenance: { via: "folder" } };

  it("says the instructions cannot be shown here, draws no fold, and no Updates switch", () => {
    render(<TrickAboutSheet trick={{ ...VIEW, rulesUnshown: true, auto: false }} open onClose={vi.fn()} onAuto={vi.fn()} />);
    expect(screen.getByRole("dialog").querySelector('[data-line="rules-unshown"]')).toHaveTextContent("This phone cannot show these agent instructions, so the trick cannot be switched on here. Read them and switch it on on the machine.");
    expect(screen.queryByRole("button", { name: "Read the instructions" })).toBeNull();
    expect(screen.queryByText("Updates")).toBeNull();
  });

  it("an agent view never shows the Updates switch, even when its rules did not arrive", () => {
    render(<TrickAboutSheet trick={VIEW} open onClose={vi.fn()} onAuto={vi.fn()} />);
    expect(screen.queryByText("Updates")).toBeNull();
  });
});
