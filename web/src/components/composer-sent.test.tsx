import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft, saveDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { recordedSends } from "@/test/handlers";
import { entry } from "@/test/sent-fixtures";
import type { SentAnswer, SentEntry } from "@/lib/types";
import { commandsFor, suggestCommands } from "@/lib/agent-commands";
import { SUGGEST_LIMIT } from "@/lib/sent-suggest";
import { Composer } from "./composer";

// Sent in the composer of a shell pane (M61 spec 02): the belt's button and the suggestion strip above
// the box. A line only ever lands in the box; Send is a tap of its own and runs the ordinary Send Protocol.

const CWD = "/home/altan/projects/collie";

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
});
afterEach(() => cleanup());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: undefined,
    isShell: true,
    cwd: CWD,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "$ ",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
  return props;
}

const answer = (entries: SentEntry[]): SentAnswer => ({ entries, more: false, off: false, machines: [{ host: "bluefin", label: "bluefin", ok: true }] });

/** The fake bridge's Sent: lines for this folder, and the machine's lines (which repeat the folder's). */
function serveSent(folder: string[], machine: string[]) {
  const asked: URL[] = [];
  server.use(
    http.get(/\/api\/sent$/, ({ request }) => {
      const url = new URL(request.url);
      asked.push(url);
      const lines = url.searchParams.has("cwd") ? folder : machine;
      return HttpResponse.json(answer(lines.map((line, i) => entry({ line, at: Date.now() - (i + 1) * 60_000 }))));
    }),
  );
  return asked;
}

const box = () => screen.getByRole("textbox");

describe("Composer: Sent button", () => {
  it("sits on the belt of a shell pane and opens the sheet", async () => {
    serveSent(["git status"], ["git status"]);
    renderComposer();
    await userEvent.click(screen.getByRole("button", { name: "Sent" }));
    expect(await screen.findByRole("dialog", { name: "Sent" })).toBeInTheDocument();
    expect(await screen.findByText("git status")).toBeInTheDocument();
  });

  it("is not on the belt of an agent pane, which carries no Sent sheet either", () => {
    renderComposer({ isShell: false, agent: "claude" });
    expect(screen.queryByRole("button", { name: "Sent" })).toBeNull();
  });

  it("puts a tapped line in the box without sending it, and Send then posts it with a request id of its own", async () => {
    serveSent(["make test"], ["make test"]);
    renderComposer();
    await userEvent.click(screen.getByRole("button", { name: "Sent" }));
    await userEvent.click(await screen.findByRole("button", { name: /^make test/ }));
    await waitFor(() => expect(box()).toHaveValue("make test"));
    expect(screen.queryByRole("dialog", { name: "Sent" })).toBeNull();
    expect(recordedSends()).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]).toMatchObject({ text: "make test", pane: "w1:p1" });
    expect(recordedSends()[0]!.id).not.toBe("");
  });

  it("replaces a draft with the tapped line, and saves the line as the draft", async () => {
    serveSent(["make test"], ["make test"]);
    renderComposer();
    await userEvent.type(box(), "half a thought");
    await userEvent.click(screen.getByRole("button", { name: "Sent" }));
    await userEvent.click(await screen.findByRole("button", { name: /^make test/ }));
    await waitFor(() => expect(box()).toHaveValue("make test"));
    expect(loadDraft(undefined, "w1:p1")).toBe("make test");
  });
});

describe("Composer: the suggestion strip", () => {
  const FOLDER = ["make test", "git status"];
  const MACHINE = ["htop", "git status", "git stash", "make test", "ls -la"];
  const STRIP = { name: "Suggestions from Sent" };

  /** "open", "closed" (still leaving), or "absent": what the strip's collapse says. */
  function stripState(): "open" | "closed" | "absent" {
    const strip = screen.queryByRole("group", STRIP);
    if (strip === null) return "absent";
    return strip.closest('[data-slot="collapse"]')?.getAttribute("data-state") === "open" ? "open" : "closed";
  }
  const chips = () => {
    const strip = screen.getByRole("group", STRIP);
    return Array.from(strip.querySelectorAll("button")).map((b) => b.textContent);
  };
  async function focusBox() {
    await userEvent.click(box());
    await waitFor(() => expect(stripState()).toBe("open"));
  }

  it("reads this folder (100) and this machine (200) once when the pane opens, and again after a confirmed send", async () => {
    const asked = serveSent(FOLDER, MACHINE);
    renderComposer();
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked.map((u) => [u.searchParams.has("cwd"), u.searchParams.get("limit")])).toEqual([
      [true, "100"],
      [false, "200"],
    ]);
    await focusBox();
    await userEvent.type(box(), "git");
    // Typing filters on the phone and asks nothing.
    expect(asked).toHaveLength(2);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await waitFor(() => expect(asked).toHaveLength(4));
  });

  it("opens when the box takes focus, over an empty box with this folder's newest lines and an All chip", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await waitFor(() => expect(screen.queryByRole("group", STRIP)).toBeNull());
    await focusBox();
    expect(chips()).toEqual(["make test", "git status", "All"]);
  });

  it("closes when the box loses focus", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    fireEvent.blur(box());
    await waitFor(() => expect(stripState()).toBe("closed"));
  });

  it("filters while typing: prefix matches, then lines holding every word, with the match in bold", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    await userEvent.type(box(), "git s");
    expect(chips()).toEqual(["git status", "git stash", "All"]);
    const first = screen.getByRole("button", { name: "git status" });
    expect(first.querySelector(".font-bold")?.textContent).toBe("git s");
    await userEvent.clear(box());
    await userEvent.type(box(), "la ls");
    expect(chips()).toEqual(["ls -la", "All"]);
  });

  it("keeps one height while the chips change", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    const row = screen.getByRole("group", STRIP);
    expect(row).toHaveClass("h-11");
    await userEvent.type(box(), "zzz");
    expect(chips()).toEqual(["All"]);
    expect(screen.getByRole("group", STRIP)).toBe(row);
    expect(row).toHaveClass("h-11");
    expect(stripState()).toBe("open");
  });

  it("offers only All when the one match is the line already in the box", async () => {
    serveSent(FOLDER, ["git status"]);
    renderComposer();
    await focusBox();
    await userEvent.type(box(), "git status");
    expect(chips()).toEqual(["All"]);
  });

  it("fills the box with a tapped line, sends nothing, and leaves the box focused", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    await userEvent.type(box(), "git");
    await userEvent.click(screen.getByRole("button", { name: "git stash" }));
    expect(box()).toHaveValue("git stash");
    expect(box()).toHaveFocus();
    expect(recordedSends()).toEqual([]);
    // The caret is at the end, so the person can go on typing.
    await waitFor(() => expect(box()).toHaveProperty("selectionStart", "git stash".length));
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]).toMatchObject({ text: "git stash" });
  });

  it("cancels the mouse-down on a chip, which is what keeps the phone's keyboard up", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "make test" }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "All sent lines" }))).toBe(false);
  });

  it("opens the Sent sheet from All", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await focusBox();
    await userEvent.click(screen.getByRole("button", { name: "All sent lines" }));
    expect(await screen.findByRole("dialog", { name: "Sent" })).toBeInTheDocument();
  });

  describe("is not there", () => {
    it("on an agent pane, which reads nothing either", async () => {
      const asked = serveSent(FOLDER, MACHINE);
      renderComposer({ isShell: false, agent: "claude" });
      await userEvent.click(box());
      expect(stripState()).toBe("absent");
      expect(asked).toEqual([]);
    });

    it("when Sent has no lines, or the bridge cannot answer", async () => {
      server.use(http.get(/\/api\/sent$/, () => HttpResponse.json(answer([]))));
      renderComposer();
      await userEvent.click(box());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stripState()).not.toBe("open");
    });

    it("with the switch off in Settings, and then reads nothing", async () => {
      const asked = serveSent(FOLDER, MACHINE);
      const props = { prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system" as const, rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false, sentSuggestions: false } };
      renderComposer(props);
      await userEvent.click(box());
      expect(stripState()).toBe("absent");
      expect(asked).toEqual([]);
    });

    it("while Type into terminal is armed", async () => {
      serveSent(FOLDER, MACHINE);
      renderComposer();
      await focusBox();
      await userEvent.click(screen.getByRole("button", { name: "Type into terminal" }));
      await waitFor(() => expect(stripState()).toBe("closed"));
    });

    it("with a dialog card up", async () => {
      serveSent(FOLDER, MACHINE);
      renderComposer({ dialogCard: true });
      await userEvent.click(box());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stripState()).not.toBe("open");
    });

    it("while the composer is locked", async () => {
      serveSent(FOLDER, MACHINE);
      renderComposer({ readOnly: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stripState()).not.toBe("open");
    });

    it("with an attachment chip in the box", async () => {
      serveSent(FOLDER, MACHINE);
      saveDraft(undefined, "w1:p1", "look [Image #1]", [{ n: 1, path: "/tmp/p.png", name: "p.png", kind: "image" }], 2);
      renderComposer();
      await userEvent.click(box());
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(stripState()).not.toBe("open");
    });

    it("while the box starts with a space, which keeps the line out of Sent", async () => {
      serveSent(FOLDER, MACHINE);
      renderComposer();
      await focusBox();
      await userEvent.type(box(), " git");
      expect(chips()).toEqual(["All"]);
    });
  });
});

describe("Composer: one strip, two sources (#475)", () => {
  const SENT = { name: "Suggestions from Sent" };
  const COMMANDS = { name: "Agent commands" };
  const OFF = { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system" as const, rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false, sentSuggestions: false };

  /** Whether a strip of that name is on screen and open (not absent, not still leaving). */
  function isOpen(name: { name: string }): boolean {
    const strip = screen.queryByRole("group", name);
    return strip?.closest('[data-slot="collapse"]')?.getAttribute("data-state") === "open";
  }

  it("offers the agent's commands on an agent pane, and no Sent rows", async () => {
    const asked = serveSent(["/codex-wrap"], ["/codex-wrap", "git status"]);
    renderComposer({ isShell: false, agent: "claude" });
    await userEvent.type(box(), "/co");
    await waitFor(() => expect(isOpen(COMMANDS)).toBe(true));
    const strip = screen.getByRole("group", COMMANDS);
    expect(strip).toHaveClass("h-11");
    expect(screen.getByRole("button", { name: "/compact" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "/codex-wrap" })).toBeNull();
    expect(screen.queryByRole("group", SENT)).toBeNull();
    expect(screen.queryByRole("button", { name: "All sent lines" })).toBeNull();
    expect(asked).toEqual([]);
  });

  it("caps the commands at Sent's twelve chips, best matches first, so a bare `/` shows the first twelve", async () => {
    renderComposer({ isShell: false, agent: "claude" });
    await userEvent.type(box(), "/");
    await waitFor(() => expect(isOpen(COMMANDS)).toBe(true));
    const ranked = suggestCommands("/", commandsFor("claude")).map((c) => c.command);
    expect(ranked.length).toBeGreaterThan(SUGGEST_LIMIT);
    const chips = Array.from(screen.getByRole("group", COMMANDS).querySelectorAll("button")).map((b) => b.textContent);
    expect(chips).toEqual(ranked.slice(0, SUGGEST_LIMIT));
  });

  it("never offers the skill and command files the Agent palette found on disk", async () => {
    server.use(
      http.get("/api/pane/w1%3Ap1/claude-commands", () =>
        HttpResponse.json({ commands: [{ command: "/to-spec", description: "Write the spec", argHint: "" }] }),
      ),
    );
    renderComposer({ isShell: false, agent: "claude" });
    // The palette reads the files and lists them...
    await userEvent.click(screen.getByRole("button", { name: "Agent" }));
    await userEvent.type(await screen.findByPlaceholderText(/Search \d+ commands/), "to-spec");
    expect(await screen.findByText("/to-spec")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // ...and the strip still offers the agent's own list only.
    await userEvent.type(box(), "/to");
    await waitFor(() => expect(isOpen(COMMANDS)).toBe(true));
    expect(screen.queryByRole("button", { name: "/to-spec" })).toBeNull();
  });

  it("offers Sent rows on a shell pane, and no commands", async () => {
    serveSent(["/codex-wrap"], ["/codex-wrap", "git status"]);
    renderComposer();
    await userEvent.click(box());
    await waitFor(() => expect(isOpen(SENT)).toBe(true));
    await userEvent.type(box(), "/co");
    expect(screen.getByRole("button", { name: "/codex-wrap" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "/compact" })).toBeNull();
    expect(screen.queryByRole("group", COMMANDS)).toBeNull();
  });

  it("with the Sent switch off, hides Sent rows on a shell pane and still offers commands on an agent pane", async () => {
    const asked = serveSent(["/codex-wrap"], ["/codex-wrap", "git status"]);
    renderComposer({ prefs: OFF });
    await userEvent.click(box());
    await userEvent.type(box(), "/co");
    expect(screen.queryByRole("group", SENT)).toBeNull();
    expect(screen.queryByRole("group", COMMANDS)).toBeNull();
    cleanup();

    renderComposer({ isShell: false, agent: "claude", prefs: OFF });
    // The same pane id: the shell render's draft came back with it.
    await userEvent.clear(box());
    await userEvent.type(box(), "/co");
    await waitFor(() => expect(isOpen(COMMANDS)).toBe(true));
    expect(screen.getByRole("button", { name: "/compact" })).toBeInTheDocument();
    expect(screen.queryByRole("group", SENT)).toBeNull();
    expect(asked).toEqual([]);
  });
});

describe("Composer: a leading space on a shell line", () => {
  async function sendTyped(text: string) {
    await userEvent.type(box(), text);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    return recordedSends()[0]!;
  }

  it("reaches the bridge, so the line stays out of Sent", async () => {
    renderComposer();
    const sent = await sendTyped(" ls  ");
    expect(sent.text).toBe(" ls");
    expect(sent.mode).toBe("send");
  });

  it("keeps a leading tab", async () => {
    renderComposer();
    expect((await sendTyped("\tls")).text).toBe("\tls");
  });

  it("still reads a spaced slash line as a command, as the trimmed text did before", async () => {
    renderComposer();
    const sent = await sendTyped("  /help");
    expect(sent.text).toBe("  /help");
    expect(sent.mode).toBe("command");
  });

  it("is trimmed on an agent pane, as it always was", async () => {
    renderComposer({ isShell: false, agent: "claude" });
    expect((await sendTyped("  hi  ")).text).toBe("hi");
  });
});
