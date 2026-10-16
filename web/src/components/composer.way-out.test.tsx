import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { sendAnswer, sendHandler, recordedSends } from "@/test/handlers";
import { wayOutCase } from "@/test/way-out-states";
import { server } from "@/test/setup";
import type { WayOutState } from "@/lib/way-out";
import { Composer } from "./composer";

// M56 spec 07, one test per state. The rule (ARCHITECTURE.md, "The way out"): in every state but a pane
// that is gone, a device that may not write and a link that is down, the Screen is one tap away, the Keys
// dock opens in one tap and can send, and the placeholder names the state; every outcome of a send lands
// at the thumb with its reason and its next action. The thirteen states are the table in
// test/way-out-states.ts, the same one the playground's numbered cards draw.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
});
afterEach(() => cleanup());

const PANE = "w1:p1";

/** The Composer in one of the thirteen states, with the Screen pill wired to a spy. */
function mount(state: WayOutState, over: Partial<ComponentProps<typeof Composer>> = {}) {
  const c = wayOutCase(state);
  if (!c.offline) markLive(PANE, Date.now() - c.readAgeMs);
  const onToggle = vi.fn();
  const props: ComponentProps<typeof Composer> = {
    paneId: PANE,
    agent: "claude",
    isShell: false,
    gone: c.gone,
    readOnly: c.readOnly,
    surface: c.surface,
    unreachableNote: c.unreachableNote,
    stale: c.offline,
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    screen: { on: false, onToggle },
    ...over,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  const view = render(<RouterProvider router={router} />);
  return { props, onToggle, container: view.container };
}

const keysButton = () => screen.getByRole("button", { name: "Keys" });
const screenButton = () => screen.getByRole("button", { name: "Show the screen rows, without cards" });
const statusLine = () => document.querySelector('[data-slot="status-area"]')?.textContent ?? "";

/** The Screen pill answers in one tap, and the Keys dock opens in one tap with its pad enabled or not. */
async function wayOutIs(user: ReturnType<typeof userEvent.setup>, onToggle: () => void, pad: "sends" | "waits") {
  await user.click(screenButton());
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(keysButton()).toBeEnabled();
  await user.click(keysButton());
  const esc = screen.getByRole("button", { name: "Esc" });
  if (pad === "sends") expect(esc).toBeEnabled();
  else expect(esc).toBeDisabled();
}

describe("the way out", () => {
  it("free: Send is the fast path, the placeholder is the ordinary one, and Screen and Keys are one tap away", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("free");
    const box = screen.getByPlaceholderText("Type a reply…");
    await user.type(box, "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    expect(recordedSends()[0]).toMatchObject({ text: "carry on", mode: "send" });
    await wayOutIs(user, onToggle, "sends");
  });

  it("composer draft: the placeholder names it, a send is refused at the thumb with Add, Replace and Cancel, and the way out stays", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: wayOutCase("draft").surface })));
    const user = userEvent.setup();
    const { onToggle } = mount("draft");
    await user.type(screen.getByPlaceholderText(/a draft is in the box/i), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const strip = await screen.findByTestId("send-offers");
    for (const word of ["Add to it", "Replace", "Cancel"]) expect(strip).toHaveTextContent(word);
    expect(screen.getByRole("textbox")).toHaveValue("new words");
    expect(statusLine()).toBe("");
    await wayOutIs(user, onToggle, "sends");
  });

  it("modal ask: the placeholder names the menu, a draft makes Send the word Answer the dialog, nothing is sent, and the way out stays", async () => {
    const user = userEvent.setup();
    const onAnswerDialog = vi.fn();
    const { onToggle } = mount("ask", { onAnswerDialog });
    await user.type(screen.getByPlaceholderText("Menu is waiting"), "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    expect(recordedSends()).toEqual([]);
    await wayOutIs(user, onToggle, "sends");
  });

  it("modal unreadable: the placeholder names it, Send takes two taps (prepare, then commit with the rows seen), and the Keys dock is enabled", async () => {
    server.use(
      ...sendHandler((request) =>
        request.rowsHash === undefined
          ? sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: wayOutCase("unreadable").surface, detail: "Check the rows, then tap again to type." })
          : sendAnswer(request.id, "sent"),
      ),
    );
    const user = userEvent.setup();
    const { onToggle } = mount("unreadable");
    await user.type(screen.getByPlaceholderText(/cannot read what is open/i), "carry on please");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // The first tap typed nothing and says why at the thumb, with the second tap and the way out beside it.
    await screen.findByRole("button", { name: "Type here" });
    expect(screen.getByRole("button", { name: "Open Keys" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Screen" })).toBeEnabled();
    expect(statusLine()).toBe("");
    await userEvent.setup().click(screen.getByRole("button", { name: "Type here" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]).toMatchObject({ text: "carry on please", rowsHash: "0f00ba" });
    await wayOutIs(user, onToggle, "sends");
  });

  it("turn running: the placeholder says so, a send is refused at the thumb naming the screen, and Open Keys leads to the pad that stops it", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { surface: wayOutCase("running").surface, detail: "The input box is not free." })));
    const user = userEvent.setup();
    const { onToggle } = mount("running");
    await user.type(screen.getByPlaceholderText(/the agent is working/i), "hurry up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/the agent was working/i);
    expect(statusLine()).toBe("");
    await user.click(screen.getByRole("button", { name: "Open Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("hurry up");
    await user.click(screenButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("unknown no-match: the placeholder says the box was not found, Send takes two taps, a refused probe names the Surface and points to the Keys dock", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "probe_failed", { surface: wayOutCase("no-match").surface, offers: ["keys"] })));
    const user = userEvent.setup();
    const { onToggle } = mount("no-match");
    await user.type(screen.getByPlaceholderText(/input box not found/i), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/typing did not land in the input box/i);
    expect(screen.getByText(/could not find the input box/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Keys" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Screen" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("hello");
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown contested: the placeholder names the disagreement, Send asks the bridge to read again, and the way out stays", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("contested");
    await user.type(screen.getByPlaceholderText(/two reads disagree/i), "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown stale: the placeholder shows the age of the last read, and the next tap asks the bridge to read again", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("stale");
    await user.type(screen.getByPlaceholderText(/last read 1[2-9] s ago/i), "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // The tap is one request: the bridge reads the screen fresh at S0, so nothing waits on the stale read.
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown torn: the placeholder says the screen was moving, and Send reads it again", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("torn");
    await user.type(screen.getByPlaceholderText(/the screen was moving/i), "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await wayOutIs(user, onToggle, "sends");
  });

  it("composer unreachable: the field is locked and names why, and the Keys dock still opens and sends", async () => {
    const user = userEvent.setup();
    const { onToggle } = mount("unreachable");
    expect(screen.getByPlaceholderText("workshop is not answering")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    await wayOutIs(user, onToggle, "sends");
  });

  it("pane gone: the board says so, the field is locked, and there is nothing to read or press", () => {
    mount("gone");
    expect(screen.getByPlaceholderText("Pane is gone")).toBeDisabled();
    expect(keysButton()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Show the screen rows, without cards" })).toBeNull();
  });

  it("read-only device: the board says so and Keys is withdrawn, while the Screen can still be read", async () => {
    const user = userEvent.setup();
    const { onToggle } = mount("readOnly");
    expect(screen.getByPlaceholderText(/read-only/i)).toBeDisabled();
    expect(keysButton()).toBeDisabled();
    await user.click(screenButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("offline: Send names its reason, the draft is kept, the Screen is one tap away, and the dock opens with its pad waiting", async () => {
    const user = userEvent.setup();
    const { onToggle } = mount("offline");
    const box = screen.getByPlaceholderText("Type a reply…");
    await user.type(box, "when it comes back");
    expect(screen.getByRole("button", { name: "Reconnect to send" })).toBeDisabled();
    expect(box).toHaveValue("when it comes back");
    expect(recordedSends()).toEqual([]);
    await wayOutIs(user, onToggle, "waits");
  });
});
