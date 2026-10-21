import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useState, type ComponentProps } from "react";

import { asJsonString, parseJsonObject } from "@/lib/json";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { sendAnswer, sendHandler, recordedSends } from "@/test/handlers";
import { wayOutCase } from "@/test/way-out-states";
import { server } from "@/test/setup";
import type { WayOutState } from "@/lib/way-out";
import { Composer } from "./composer";

// M56 spec 07, one test per state. The rule (ARCHITECTURE.md, "The way out"): in every state but a pane
// that is gone, a device that may not write and a link that is down, the Screen is one tap away, the Keys
// dock opens in one tap and can send, and the placeholder stays the plain reply line (it names only a pane
// that is gone, a device that may not write and a box out of reach); every outcome of a send lands
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
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
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

  it("free: while a send is in flight the probe character reads as a draft, and the placeholder keeps the plain line before, during and after", async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = false;
    server.use(
      http.post("/api/send", async ({ request }) => {
        const body = parseJsonObject(await request.text());
        arrived = true;
        await held;
        return HttpResponse.json(sendAnswer(asJsonString(body?.id) ?? "", "sent"));
      }),
    );
    const free = wayOutCase("free");
    markLive(PANE, Date.now() - free.readAgeMs);
    let showDraft: (draft: boolean) => void = () => undefined;
    function Pane() {
      const [draft, setDraft] = useState(false);
      showDraft = setDraft;
      return (
        <Composer
          paneId={PANE}
          agent="claude"
          isShell={false}
          gone={false}
          readOnly={false}
          surface={draft ? wayOutCase("draft").surface : free.surface}
          text="pane output"
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false }}
          display={{ open: false, onToggle: vi.fn() }}
          onSent={vi.fn()}
          screen={{ on: false, onToggle: vi.fn() }}
        />
      );
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Pane /> }])} />);
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText("Type a reply…"), "carry on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(arrived).toBe(true));
    // The bridge's probe character stands in the box: the pane's read says draft, mid-request.
    act(() => showDraft(true));
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Type a reply…");
    release();
    await waitFor(() => expect(screen.getByRole("textbox")).toHaveValue(""));
    // The request is over: a draft the pane still shows does not change the placeholder.
    expect(screen.getByRole("textbox")).toHaveAttribute("placeholder", "Type a reply…");
  });

  it("composer draft: the placeholder stays plain, a send is refused at the thumb with Add, Replace and Cancel, and the way out stays", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "draft_present", { offers: ["append", "replace", "cancel"], surface: wayOutCase("draft").surface })));
    const user = userEvent.setup();
    const { onToggle } = mount("draft");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "new words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    const strip = await screen.findByTestId("send-offers");
    for (const word of ["Add to it", "Replace", "Cancel"]) expect(strip).toHaveTextContent(word);
    expect(screen.getByRole("textbox")).toHaveValue("new words");
    expect(statusLine()).toBe("");
    await wayOutIs(user, onToggle, "sends");
  });

  it("modal ask: the placeholder stays plain, a draft makes Send the word Answer the dialog, nothing is sent, and the way out stays", async () => {
    const user = userEvent.setup();
    const onAnswerDialog = vi.fn();
    const { onToggle } = mount("ask", { onAnswerDialog });
    await user.type(screen.getByPlaceholderText("Type a reply…"), "for after the dialog");
    await user.click(screen.getByRole("button", { name: "Answer the dialog" }));
    expect(onAnswerDialog).toHaveBeenCalledTimes(1);
    expect(recordedSends()).toEqual([]);
    await wayOutIs(user, onToggle, "sends");
  });

  it("modal unreadable: the placeholder stays plain, Send takes two taps (prepare, then commit with the rows seen), and the Keys dock is enabled", async () => {
    server.use(
      ...sendHandler((request) =>
        request.rowsHash === undefined
          ? sendAnswer(request.id, "refused", "unconfirmed", { offers: ["commit", "keys"], rowsHash: "0f00ba", surface: wayOutCase("unreadable").surface, detail: "Check the pane, then tap Type here." })
          : sendAnswer(request.id, "sent"),
      ),
    );
    const user = userEvent.setup();
    const { onToggle } = mount("unreadable");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "carry on please");
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

  it("turn running: the placeholder stays plain, a send is refused at the thumb naming the screen, and Open Keys leads to the pad that stops it", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "not_free", { surface: wayOutCase("running").surface, detail: "The input box is not free." })));
    const user = userEvent.setup();
    const { onToggle } = mount("running");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "hurry up");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/the agent was working/i);
    expect(statusLine()).toBe("");
    await user.click(screen.getByRole("button", { name: "Open Keys" }));
    expect(screen.getByRole("button", { name: "Esc" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("hurry up");
    await user.click(screenButton());
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("unknown no-match: the placeholder stays plain, Send takes two taps, a refused probe names the Surface and points to the Keys dock", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "probe_failed", { surface: wayOutCase("no-match").surface, offers: ["keys"] })));
    const user = userEvent.setup();
    const { onToggle } = mount("no-match");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "hello");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await screen.findByText(/typing did not land in the input box/i);
    expect(screen.getByText(/could not find the input box/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open Keys" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Screen" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("hello");
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown contested: the placeholder stays plain, Send asks the bridge to read again, and the way out stays", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("contested");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown stale: the placeholder stays plain, and the next tap asks the bridge to read again", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("stale");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // The tap is one request: the bridge reads the screen fresh at S0, so nothing waits on the stale read.
    await waitFor(() => expect(recordedSends()).toHaveLength(1));
    await wayOutIs(user, onToggle, "sends");
  });

  it("unknown torn: the placeholder stays plain, and Send reads it again", async () => {
    server.use(...sendHandler((request) => sendAnswer(request.id, "sent")));
    const user = userEvent.setup();
    const { onToggle } = mount("torn");
    await user.type(screen.getByPlaceholderText("Type a reply…"), "go on");
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
