import { readFileSync } from "node:fs";
import { join } from "node:path";

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OfficialTrickAboutSheet, TrickAboutSheet, aboutParagraphs, repoFactsLine } from "@/components/trick-about-sheet";
import { readOfficialTricksReply, readTrick } from "@/lib/tricks/wire";
import { en, type MessageKey } from "@/lib/i18n/messages/en";
import { ABOUT_MAX, AGENT_VIEW_TAP_WORDS, AGENT_VIEW_WORDS, FLOAT_OPENS_WORDS, FLOAT_WORDS, MENU_TAP_WORDS, MENU_WORDS, PLACE_KINDS, RULES_WORDS, SHOWS_IN_AGENT_VIEW, SHOWS_IN_LEAD, SHOWS_IN_WORDS, showsInLine, type WireOfficialTrick, type WireTrickInfo } from "@/lib/tricks/schema";

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
      "It shows in: the end of the Belt in each session, a tile in the strip at the top of the Dashboard.",
      "Reads TODO.md in your agent sessions' folders.",
      "Asks for the environment names GH_TOKEN.",
      "This trick reaches the network.",
    ]);
  });

  it("says `on` and `watch` as rights, in the two lines of the proposal card, after the environment names", () => {
    open({ ...FULL, warnings: undefined, events: ["turn.end", "ask.open"], watch: ["~/notes/todo.md", "/etc/hosts"] });
    const does = within(screen.getByRole("dialog")).getByRole("list", { name: "What it does" });
    const rows = within(does).getAllByRole("listitem").map((li) => li.textContent);
    expect(rows.slice(-2)).toEqual(["Runs when a session changes state.", "Runs when these files change: ~/notes/todo.md, /etc/hosts."]);
  });

  it("a trick with a program and `on` or `watch` says it keeps running with no phone open, last of the rows", () => {
    const line = "It keeps running with no phone open.";
    const rowsOf = (trick: WireTrickInfo): (string | null)[] => {
      const { unmount } = open(trick);
      const does = within(screen.getByRole("dialog")).getByRole("list", { name: "What it does" });
      const rows = within(does).getAllByRole("listitem").map((li) => li.textContent);
      unmount();
      return rows;
    };
    const reacting: WireTrickInfo = { ...FULL, run: "bun run gates.ts", access: "see" };
    expect(rowsOf({ ...reacting, events: ["turn.end"] }).at(-1)).toBe(line);
    expect(rowsOf({ ...reacting, watch: ["~/notes/todo.md"] }).at(-1)).toBe(line);
    // After the warnings and the level line too, never before them.
    expect(rowsOf({ ...reacting, events: ["turn.end"] }).at(-2)).toBe("This trick reaches the network.");
    // A tap-only trick, a plain timer and a trick with no program do not say it.
    expect(rowsOf(reacting)).not.toContain(line);
    expect(rowsOf({ ...reacting, everyMs: 30_000 })).not.toContain(line);
    expect(rowsOf({ ...FULL, events: ["turn.end"] })).not.toContain(line);
  });

  it("says the level of access in its one plain line, none for none, and never calls it a permission", () => {
    const see = "It reads your machines, sessions, usage and the Hill.";
    const read = "It reads your sessions' screens.";
    const runsAsYou = "This trick runs as you on this machine. It can do there what you can do.";
    const rowsFor = (access: WireTrickInfo["access"]): (string | null)[] => {
      const trick: WireTrickInfo = { ...FULL, warnings: undefined };
      if (access !== undefined) trick.access = access;
      const { unmount } = open(trick);
      const does = within(screen.getByRole("dialog")).getByRole("list", { name: "What it does" });
      const rows = within(does).getAllByRole("listitem").map((li) => li.textContent);
      unmount();
      return rows;
    };
    expect(rowsFor("see").slice(-2)).toEqual([runsAsYou, see]);
    expect(rowsFor("read").slice(-2)).toEqual([runsAsYou, read]);
    expect(rowsFor(undefined).join(" ")).not.toMatch(/It reads your|runs as you on this machine/u);
    for (const text of [see, read]) expect(text).not.toMatch(/permission|can only/iu);
    // A level this phone does not know has one fixed line (review 3, item 4).
    expect(rowsFor("unknown").at(-1)).toBe("It asks for access this app does not know yet. Update the app before you say yes.");
    // The wire reader keeps one of the two words, keeps any other text as `unknown`, and drops what is not text.
    const wire = { host: "lodge", id: "gates", name: "Release Gates", icon: "flask", on: true, state: "ok", places: ["belt"] };
    expect(readTrick({ ...wire, access: "read" })?.access).toBe("read");
    expect(readTrick({ ...wire, access: "send" })?.access).toBe("unknown");
    expect(readTrick({ ...wire, access: 3 })?.access).toBeUndefined();
    expect(readTrick({ ...wire, access: "" })?.access).toBeUndefined();
    expect(readTrick({ ...wire, access: "send", accessOff: true })).toMatchObject({ access: "unknown", accessOff: true });
    expect(readTrick({ ...wire, access: "see", accessOff: true })).toMatchObject({ access: "see", accessOff: true });
    expect(readTrick({ ...wire, accessOff: true })?.accessOff).toBeUndefined();
  });

  it("says the drafts right in the cards' line, only for a trick that carries it; the wire keeps only true", () => {
    const line = "Its buttons can put text into the reply box of the session you are in. You read it and send it yourself.";
    const rowsFor = (trick: WireTrickInfo): (string | null)[] => {
      const { unmount } = open(trick);
      const does = within(screen.getByRole("dialog")).getByRole("list", { name: "What it does" });
      const rows = within(does).getAllByRole("listitem").map((li) => li.textContent);
      unmount();
      return rows;
    };
    expect(rowsFor({ ...FULL, warnings: undefined, draftsSession: true })).toContain(line);
    expect(rowsFor({ ...FULL, warnings: undefined })).not.toContain(line);
    const wire = { host: "lodge", id: "pouch", name: "Pouch", icon: "flask", on: true, state: "ok", places: ["session"] };
    expect(readTrick({ ...wire, draftsSession: true })?.draftsSession).toBe(true);
    expect(readTrick({ ...wire, draftsSession: "yes" })?.draftsSession).toBeUndefined();
    expect(readTrick(wire)?.draftsSession).toBeUndefined();
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
  const VIEW_TRICK: WireTrickInfo = {
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

  it("lists the two rights lines and the rules line under What it does, with no later note, in the schema's words", () => {
    render(<TrickAboutSheet trick={VIEW_TRICK} open onClose={vi.fn()} />);
    const does = screen.getByRole("list", { name: "What it does" });
    expect([...does.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Your agent reads this trick's instructions and draws its answers. That uses tokens.",
      "It shows in: a view of a session, beside Terminal and Chat.",
      AGENT_VIEW_WORDS,
      AGENT_VIEW_TAP_WORDS,
      RULES_WORDS,
    ]);
    expect(AGENT_VIEW_WORDS).toBe("Adds a view of a session that the session's own agent draws. You switch it on per session.");
    expect(AGENT_VIEW_TAP_WORDS).toBe("A tap in that view sends a message in your name to that session only.");
    expect(RULES_WORDS).toBe("Gives your agents instructions written by its author.");
  });

  it("holds the rules behind a closed fold, and opens them whole: the text on the screen is the file's bytes", async () => {
    const user = userEvent.setup();
    render(<TrickAboutSheet trick={VIEW_TRICK} open onClose={vi.fn()} />);
    expect(toggle()).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog").querySelector('[data-line="rules-text"]')).toBeNull();
    await user.click(toggle());
    expect(screen.getByRole("button", { name: "Hide the instructions" })).toHaveAttribute("aria-expanded", "true");
    const pre = screen.getByRole("dialog").querySelector('[data-line="rules-text"]');
    expect(pre?.tagName).toBe("PRE");
    expect(pre?.className).toContain("font-mono");
    expect(pre?.className).toContain("whitespace-pre-wrap");
    // Byte for byte: the file, the wire's reader, the drawn text.
    const wired = readTrick(JSON.parse(JSON.stringify(VIEW_TRICK)));
    expect(wired?.rules?.text).toBe(RULES_TEXT);
    expect(Buffer.from(pre?.textContent ?? "", "latin1").equals(RULES_BYTES)).toBe(true);
    // Never markdown: only the line and piece spans the wrap draws, no other element.
    expect(pre?.querySelectorAll(":not([data-prose-line]):not([data-prose-piece]):not([data-prose-wrap])").length).toBe(0);
    expect(pre?.querySelectorAll("[data-prose-line]").length).toBe(RULES_TEXT.split("\n").length - 1);
  });

  it("the playground's agent view rules are the bridge fixture's bytes", async () => {
    const { VIEW_TRICK_RULES } = await import("@/playground/fixtures/agent-view");
    expect(VIEW_TRICK_RULES).toBe(RULES_TEXT);
  });

  it("a markdown-looking line stays text", async () => {
    const user = userEvent.setup();
    const text = "# Not a heading\n**not bold** [not a link](https://example.com)\n<b>not html</b>\n";
    render(<TrickAboutSheet trick={{ ...VIEW_TRICK, rules: { file: "rules.md", text } }} open onClose={vi.fn()} />);
    await user.click(toggle());
    const pre = screen.getByRole("dialog").querySelector('[data-line="rules-text"]');
    expect(pre?.textContent).toBe(text);
    expect(screen.getByRole("dialog").querySelector("a, b, h1, strong")).toBeNull();
  });

  it("draws no Take changes without asking switch for a trick with rules, even with the write given", () => {
    render(<TrickAboutSheet trick={{ ...VIEW_TRICK, auto: true }} open onClose={vi.fn()} onAuto={vi.fn()} />);
    expect(screen.queryByText("Updates")).toBeNull();
    expect(screen.queryByRole("switch", { name: "Take changes without asking" })).toBeNull();
  });

  it("the not-added sheet says the trick gives instructions and to read them after the add: nothing is fetched before Add (review 8 V-N3)", () => {
    const entry: WireOfficialTrick = { id: "morph", name: "Morph", description: "Your agent answers by drawing one screen.", repo: "https://example.com/tricks.git", repoName: "owner/tricks", commit: "a".repeat(40), state: "absent", givesRules: true };
    render(<OfficialTrickAboutSheet entry={entry} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    expect(screen.getByText(RULES_WORDS)).toBeInTheDocument();
    expect(screen.getByRole("dialog").querySelector('[data-line="rules-after-add"]')).toHaveTextContent("Read the instructions after you add it. It stays off until you switch it on.");
    expect(screen.queryByRole("button", { name: "Read the instructions" })).toBeNull();
    // The wire keeps the flag, never a text the list does not carry.
    const wired = readOfficialTricksReply(JSON.parse(JSON.stringify({ tricks: [{ ...entry, rules: { file: "rules.md", text: RULES_TEXT } }] })));
    expect(wired?.tricks[0]?.givesRules).toBe(true);
    expect(wired?.tricks[0] !== undefined && "rules" in wired.tricks[0]).toBe(false);
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

describe("the menu place's two lines (contract 2)", () => {
  it("an installed trick with session settings rows and an Official entry that adds them say the same two lines, the schema's", () => {
    const trick: WireTrickInfo = { host: "lodge", id: "ci", name: "CI", icon: "flask", on: true, state: "ok", places: ["menu"], provenance: { via: "folder" } };
    render(<TrickAboutSheet trick={trick} open onClose={vi.fn()} />);
    const does = screen.getByRole("list", { name: "What it does" });
    expect([...does.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["It shows in: rows in each session's settings.", MENU_WORDS, MENU_TAP_WORDS]);
    cleanup();
    const entry: WireOfficialTrick = { id: "ci", name: "CI", description: "Reruns CI.", repo: "https://example.com/tricks.git", repoName: "owner/tricks", commit: "a".repeat(40), state: "absent", addsMenu: true };
    render(<OfficialTrickAboutSheet entry={entry} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    const official = screen.getByRole("list", { name: "What it does" });
    expect([...official.querySelectorAll("li")].map((li) => li.textContent)).toEqual([MENU_WORDS, MENU_TAP_WORDS]);
    expect(readOfficialTricksReply(JSON.parse(JSON.stringify({ tricks: [entry] })))?.tricks[0]?.addsMenu).toBe(true);
  });
});

describe("where it comes from: the repository's link, its facts and the version (2026-11-12)", () => {
  const URL = "https://github.com/owner/gates-trick";
  const FROM_REPO: WireTrickInfo = { ...FULL, provenance: { ...FULL.provenance, via: "repo", url: URL } };
  const FACTS = { stars: 1234, pushedAt: "2026-11-10T23:30:00Z" };
  const from = () => {
    const group = document.querySelector<HTMLElement>('[data-section="from"]');
    if (group === null) throw new Error("no from group");
    return group;
  };

  it("links the repository in the Hill Decision link's shape, the host whole, in a new tab with no opener", () => {
    render(<TrickAboutSheet trick={FROM_REPO} open onClose={vi.fn()} timeZone="UTC" />);
    const link = within(from()).getByRole("link", { name: /Open the repository/ });
    expect(link.getAttribute("href")).toBe(URL);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.className).toContain("min-h-11");
    expect(link.querySelector("[data-trick-link-host]")?.getAttribute("title")).toBe("github.com");
    // No facts yet: nothing, and no space held for them beyond the row's own 44 px.
    expect(link.querySelector('[data-line="repo-facts"]')).toBeNull();
  });

  it("puts the stars and the last commit's date inside the link row, in a pinned zone", () => {
    const view = render(<TrickAboutSheet trick={{ ...FROM_REPO, repoFacts: FACTS }} open onClose={vi.fn()} timeZone="UTC" />);
    expect(from().querySelector('[data-line="repo-facts"]')).toHaveTextContent("1,234 stars, last commit Nov 10, 2026");
    expect(from().querySelector('[data-slot="trick-repo-link"] [data-line="repo-facts"]')).not.toBeNull();
    view.unmount();
    render(<TrickAboutSheet trick={{ ...FROM_REPO, repoFacts: { stars: 1, pushedAt: FACTS.pushedAt } }} open onClose={vi.fn()} timeZone="Pacific/Auckland" />);
    expect(from().querySelector('[data-line="repo-facts"]')).toHaveTextContent("1 star, last commit Nov 11, 2026");
  });

  it("writes the star count in the app's number format, one or many, never compact", () => {
    const line = (stars: number) => repoFactsLine({ stars, pushedAt: "2026-11-10T12:00:00Z" }, "UTC");
    expect(line(1)).toBe("1 star, last commit Nov 10, 2026");
    expect(line(999)).toBe("999 stars, last commit Nov 10, 2026");
    expect(line(1234)).toBe("1,234 stars, last commit Nov 10, 2026");
    expect(line(12500)).toBe("12,500 stars, last commit Nov 10, 2026");
  });

  it("shows no facts for a host other than github.com, and no link for a trick not from a repository or a bad URL", () => {
    const other = "https://codeberg.org/owner/gates-trick";
    const view = render(<TrickAboutSheet trick={{ ...FROM_REPO, provenance: { ...FROM_REPO.provenance, via: "repo", url: other }, repoFacts: FACTS }} open onClose={vi.fn()} />);
    expect(within(from()).getByRole("link").getAttribute("href")).toBe(other);
    expect(from().querySelector("[data-trick-link-host]")?.getAttribute("title")).toBe("codeberg.org");
    expect(from().querySelector('[data-line="repo-facts"]')).toBeNull();
    view.unmount();
    for (const provenance of [{ via: "folder" as const, url: URL }, { via: "repo" as const, repo: "owner/x", url: "http://github.com/owner/x" }, { via: "repo" as const, repo: "owner/x" }]) {
      const again = render(<TrickAboutSheet trick={{ ...FULL, provenance, repoFacts: FACTS }} open onClose={vi.fn()} />);
      expect(within(from()).queryByRole("link")).toBeNull();
      again.unmount();
    }
  });

  it("shows the version when the manifest names one, and no row when it does not", () => {
    const view = render(<TrickAboutSheet trick={{ ...FROM_REPO, version: "1.2.0" }} open onClose={vi.fn()} />);
    expect(from().querySelector('[data-line="version"]')).toHaveTextContent("Version 1.2.0");
    view.unmount();
    render(<TrickAboutSheet trick={FROM_REPO} open onClose={vi.fn()} />);
    expect(from().querySelector('[data-line="version"]')).toBeNull();
  });

  it("the wire keeps a version, facts and a source URL that hold, and drops ones that do not", () => {
    const raw = { ...FROM_REPO, version: "1.2.0", repoFacts: FACTS };
    expect(readTrick(JSON.parse(JSON.stringify(raw)))).toMatchObject({ version: "1.2.0", repoFacts: FACTS, provenance: { url: URL } });
    const bad = readTrick(JSON.parse(JSON.stringify({ ...FROM_REPO, version: "1 2", repoFacts: { stars: -1, pushedAt: "yesterday" }, provenance: { via: "repo", repo: "owner/x", url: "https://user:pw@github.com/owner/x" } })));
    expect(bad?.version).toBeUndefined();
    expect(bad?.repoFacts).toBeUndefined();
    expect(bad?.provenance?.url).toBeUndefined();
  });

  it("the not-added sheet links the list's repository with its facts", () => {
    const entry: WireOfficialTrick = { id: "morph", name: "Morph", description: "One screen.", repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: "0d80399aa", state: "absent", repoFacts: FACTS };
    render(<OfficialTrickAboutSheet entry={entry} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} timeZone="UTC" />);
    const rows = [...from().querySelectorAll("li")].map((li) => li.textContent);
    expect(rows[0]).toBe("From AltanS/collie-tricks @ 0d80399");
    expect(within(from()).getByRole("link").getAttribute("href")).toBe("https://github.com/AltanS/collie-tricks");
    expect(from().querySelector('[data-line="repo-facts"]')).toHaveTextContent("1,234 stars, last commit Nov 10, 2026");
  });
});

describe("why a trick uses agent tokens: the first row of What it does (2026-11-12)", () => {
  const PROGRAM: WireTrickInfo = { host: "lodge", id: "inbox", name: "PR Inbox", icon: "plug", on: true, state: "ok", places: ["belt"], description: "Open pull requests." };
  const ENTRY: WireOfficialTrick = {
    id: "pr-inbox",
    name: "PR Inbox",
    description: "Open pull requests and issues that wait for you.",
    repo: "https://github.com/AltanS/collie-tricks",
    repoName: "AltanS/collie-tricks",
    commit: "0c1e5d82346486815073fedcdb994bc4c2041b55",
    state: "absent",
  };
  const firstRow = (): string | null | undefined => screen.getByRole("list", { name: "What it does" }).querySelector("li")?.textContent;

  it("says the sentence of its reason first, and draws no chip in the sheet", () => {
    const rows: [WireTrickInfo, string][] = [
      [{ ...PROGRAM, rules: { file: "rules.md", text: "Draw one screen.\n" } }, "Your agent reads this trick's instructions. That uses tokens."],
      [{ ...PROGRAM, decidesReply: true }, "Your answers to its Decisions go to an agent as messages. That uses tokens."],
    ];
    for (const [trick, sentence] of rows) {
      render(<TrickAboutSheet trick={trick} open onClose={vi.fn()} />);
      expect(firstRow()).toBe(sentence);
      expect(screen.getByRole("dialog").querySelector('[data-slot="token-use"]')).toBeNull();
      cleanup();
    }
  });

  it("says nothing of tokens for a program trick, even one whose last run listed Decisions", () => {
    render(<TrickAboutSheet trick={{ ...PROGRAM, decides: true }} open onClose={vi.fn()} />);
    expect(firstRow()).toBe("It shows in: the end of the Belt in each session.");
    expect(screen.getByRole("dialog").textContent).not.toContain("tokens");
  });

  it("an official entry says it before Add, from the pin alone", () => {
    render(<OfficialTrickAboutSheet entry={{ ...ENTRY, decidesReply: true }} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    expect(firstRow()).toBe("Your answers to its Decisions go to an agent as messages. That uses tokens.");
    cleanup();
    render(<OfficialTrickAboutSheet entry={{ ...ENTRY, givesRules: true, agentView: true }} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    expect([...screen.getByRole("list", { name: "What it does" }).querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Your agent reads this trick's instructions and draws its answers. That uses tokens.",
      RULES_WORDS,
    ]);
    cleanup();
    render(<OfficialTrickAboutSheet entry={ENTRY} open onClose={vi.fn()} busy={false} canWrite onAdd={vi.fn()} />);
    expect(screen.queryByRole("list", { name: "What it does" })).toBeNull();
  });
});

// THE VALUES STAND ON CHIPS: the label and the plain sentence stay muted, the one thing a row is read for sits on a
// chip (the foreground at medium weight, `muted`, a uniform hairline). The words around it are the dictionary's.
describe("TrickAboutSheet where it shows (2026-11-17)", () => {
  it("says it in the schema's words, the same line the approval cards carry, one phrase per place and the agent view last", () => {
    const trick: WireTrickInfo = { ...BASE, places: ["belt", "status", "session", "dashboard", "tabbar", "menu"], agentView: true };
    open(trick);
    const line = screen.getByRole("dialog").querySelector('[data-line="shows"]')?.textContent;
    expect(line).toBe(showsInLine({ places: ["belt", "status", "session", "dashboard", "tabbar", "menu"], agentView: true }));
    expect(line).toContain("the left end of the usage row of each session");
    expect(line).toContain("a page of its own (a row under Tricks on the Dashboard)");
  });

  it("draws no line for a trick with no place and no agent view", () => {
    open({ ...BASE, places: [] });
    expect(screen.getByRole("dialog").querySelector('[data-line="shows"]')).toBeNull();
  });

  it("keeps every phone phrase equal to the bridge's, in schema.ts", () => {
    expect(en["settings.tricks.about.shows"]).toBe(`${SHOWS_IN_LEAD} {places}.`);
    for (const place of PLACE_KINDS) expect(en[`settings.tricks.about.shows.${place}` satisfies MessageKey]).toBe(SHOWS_IN_WORDS[place]);
    expect(en["settings.tricks.about.shows.agentView"]).toBe(SHOWS_IN_AGENT_VIEW);
  });

  it("says what a floating picture can do and never does, in the schema's words, and the tap line only when a part opens the page", () => {
    expect(en["settings.tricks.about.float"]).toBe(FLOAT_WORDS);
    expect(en["settings.tricks.about.floatOpens"]).toBe(FLOAT_OPENS_WORDS);
    expect(FLOAT_WORDS).toBe("It can draw a small moving picture over the app. It never covers a question and never blocks a tap.");
    open({ ...BASE, places: ["float"] });
    const text = screen.getByRole("dialog").textContent;
    expect(text).toContain(FLOAT_WORDS);
    expect(text).not.toContain(FLOAT_OPENS_WORDS);
  });
});

describe("TrickAboutSheet values on chips", () => {
  const WITH_FACTS: WireTrickInfo = {
    ...FULL,
    places: ["belt", "status"],
    version: "1.2.0",
    run: "bun run gates.ts --repo owner/name",
    everyMs: 300_000,
    watch: ["~/notes/todo.md"],
  };
  const chips = (row: Element | null) => [...(row?.querySelectorAll('[data-slot="trick-value"]') ?? [])].map((el) => el.textContent);

  it("draws the places, the file paths, the names, the globs, the version and the timer's spans each on a chip, and the sentence stays plain", () => {
    open(WITH_FACTS);
    const dialog = screen.getByRole("dialog");
    const rowOf = (text: string) => within(dialog).getByText((_, el) => el?.tagName === "LI" && (el.textContent ?? "").includes(text));
    expect(chips(rowOf("It shows in:"))).toEqual(["the end of the Belt in each session, the left end of the usage row of each session"]);
    expect(rowOf("It shows in:")).toHaveTextContent("It shows in: the end of the Belt in each session, the left end of the usage row of each session.");
    expect(chips(rowOf("Asks for the environment names"))).toEqual(["GH_TOKEN"]);
    expect(chips(rowOf("Runs when these files change"))).toEqual(["~/notes/todo.md"]);
    expect(chips(rowOf("Reads "))).toEqual(["TODO.md"]);
    expect(chips(dialog.querySelector('[data-line="timer"]'))).toEqual(["5 min", "5 min"]);
    expect(dialog.querySelector('[data-line="timer"]')).toHaveTextContent("Runs when it starts, then every 5 min after the last run. It runs only while a phone has looked in the last 5 min.");
    expect(chips(dialog.querySelector('[data-line="version"]'))).toEqual(["1.2.0"]);
  });

  it("draws the run line whole on a chip that wraps, and a trick with no timer keeps its plain line", () => {
    open({ ...WITH_FACTS, everyMs: undefined });
    const run = screen.getByRole("dialog").querySelector('[data-line="run"]');
    expect(run).toHaveTextContent("bun run gates.ts --repo owner/name");
    expect(run?.getAttribute("data-slot")).toBe("trick-value");
    expect(run?.className).toMatch(/\bbreak-all\b/);
    expect(run?.className).toMatch(/\bwhitespace-pre-wrap\b/);
    expect(chips(screen.getByRole("dialog").querySelector('[data-line="timer"]'))).toEqual([]);
  });

  it("a chip is the foreground at medium weight on a muted ground with one border on all four sides, and wraps instead of scrolling", () => {
    open(WITH_FACTS);
    const chip = screen.getByRole("dialog").querySelector('[data-slot="trick-value"]');
    const classes = (chip?.className ?? "").split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(["bg-muted", "text-foreground", "border", "border-border", "font-medium", "whitespace-normal", "break-words"]));
    expect(classes.some((c) => /^border-(l|r|t|b|x|y)(-|$)/.test(c))).toBe(false);
    expect(classes.some((c) => /^(overflow-x|whitespace-nowrap)/.test(c))).toBe(false);
  });

  it("never lets a value break the chip marks: a value with the private marks in it is drawn without them", () => {
    open({ ...WITH_FACTS, env: ["A\uE000B", "C\uE001D"] });
    const row = screen.getByRole("dialog").querySelector('[data-slot="trick-value"]');
    expect(row).not.toBeNull();
    expect(screen.getByRole("dialog")).toHaveTextContent("Asks for the environment names AB, CD.");
  });
});
