import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { recordedSends } from "@/test/handlers";
import { entry } from "@/test/sent-fixtures";
import type { SentAnswer, SentEntry } from "@/lib/types";
import { Composer } from "./composer";

// Sent in the composer of a shell pane (M61 spec 02): the belt's button, Ctrl+R, and the arrow keys.
// A line only ever lands in the box; Send is a tap of its own and runs the ordinary Send Protocol.

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
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
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

describe("Composer: Ctrl+R", () => {
  it("opens the sheet with the cursor in the search field, and keeps the browser from reloading", async () => {
    serveSent(["git status"], ["git status"]);
    renderComposer();
    box().focus();
    const proceeded = fireEvent.keyDown(box(), { key: "r", ctrlKey: true });
    expect(proceeded).toBe(false);
    await screen.findByRole("dialog", { name: "Sent" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Search sent lines" })).toHaveFocus());
  });

  it("leaves Cmd+R and Ctrl+Shift+R to the browser, which reload", () => {
    renderComposer();
    expect(fireEvent.keyDown(box(), { key: "r", metaKey: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: "R", ctrlKey: true, shiftKey: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Sent" })).toBeNull();
  });

  it("is the browser's on an agent pane", () => {
    renderComposer({ isShell: false, agent: "claude" });
    expect(fireEvent.keyDown(box(), { key: "r", ctrlKey: true })).toBe(true);
    expect(screen.queryByRole("dialog", { name: "Sent" })).toBeNull();
  });
});

describe("Composer: arrow keys through Sent", () => {
  const FOLDER = ["make test", "git status"];
  const MACHINE = ["htop", "git status", "ls -la"];

  async function up() {
    fireEvent.keyDown(box(), { key: "ArrowUp" });
  }

  it("steps older through this folder's lines and then the machine's, and back down to the empty box", async () => {
    const asked = serveSent(FOLDER, MACHINE);
    renderComposer();
    await up();
    await waitFor(() => expect(box()).toHaveValue("make test"));
    // The walk read the folder first and the machine second, once each.
    expect(asked.map((u) => u.searchParams.has("cwd"))).toEqual([true, false]);
    await up();
    expect(box()).toHaveValue("git status");
    await up();
    expect(box()).toHaveValue("htop");
    await up();
    expect(box()).toHaveValue("ls -la");
    await up();
    expect(box()).toHaveValue("ls -la");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box()).toHaveValue("htop");
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    fireEvent.keyDown(box(), { key: "ArrowDown" });
    expect(box()).toHaveValue("");
  });

  it("restores the empty box on Escape", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await up();
    await waitFor(() => expect(box()).toHaveValue("make test"));
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box()).toHaveValue("");
    // The walk is over: the next ArrowUp starts a new one from the newest line.
    await up();
    await waitFor(() => expect(box()).toHaveValue("make test"));
  });

  it("keeps a recalled line out of the saved draft until the person edits it", async () => {
    serveSent(FOLDER, MACHINE);
    renderComposer();
    await up();
    await waitFor(() => expect(box()).toHaveValue("make test"));
    expect(loadDraft(undefined, "w1:p1")).toBeNull();
    await userEvent.type(box(), " -j4");
    expect(loadDraft(undefined, "w1:p1")).toBe("make test -j4");
    // An edited line is a draft: the arrow keys are the caret's again.
    expect(fireEvent.keyDown(box(), { key: "ArrowUp" })).toBe(true);
    expect(box()).toHaveValue("make test -j4");
  });

  it("never steals the arrow keys in a draft", async () => {
    const asked = serveSent(FOLDER, MACHINE);
    renderComposer();
    await userEvent.type(box(), "git sta");
    expect(fireEvent.keyDown(box(), { key: "ArrowUp" })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: "ArrowDown" })).toBe(true);
    expect(box()).toHaveValue("git sta");
    expect(asked).toEqual([]);
  });

  it("leaves a key with a modifier alone", async () => {
    const asked = serveSent(FOLDER, MACHINE);
    renderComposer();
    expect(fireEvent.keyDown(box(), { key: "ArrowUp", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(box(), { key: "ArrowUp", altKey: true })).toBe(true);
    expect(asked).toEqual([]);
  });

  it("does nothing on an agent pane", async () => {
    const asked = serveSent(FOLDER, MACHINE);
    renderComposer({ isShell: false, agent: "claude" });
    expect(fireEvent.keyDown(box(), { key: "ArrowUp" })).toBe(true);
    expect(asked).toEqual([]);
  });

  it("leaves the box empty when nothing was sent, or the bridge cannot answer", async () => {
    server.use(http.get(/\/api\/sent$/, () => HttpResponse.json(answer([]))));
    renderComposer();
    await up();
    await waitFor(() => expect(box()).toHaveValue(""));
    server.use(http.get(/\/api\/sent$/, () => new HttpResponse("nope", { status: 404 })));
    await up();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(box()).toHaveValue("");
  });

  it("drops the walk when the person types while the first read is out", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(/\/api\/sent$/, async () => {
        await gate;
        return HttpResponse.json(answer([entry({ line: "make test" })]));
      }),
    );
    renderComposer();
    await up();
    await userEvent.type(box(), "ls");
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(box()).toHaveValue("ls");
  });
});
