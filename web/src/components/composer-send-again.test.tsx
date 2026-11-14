import type { ComponentProps } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { markLive, resetLiveness } from "@/lib/liveness";
import { rememberUnknownSend, SEND_AGAIN_CONFIRM_DELAY_MS, SEND_AGAIN_WINDOW_MS, __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M100 spec 06, item 2: after a send that ended `unknown`, a second tap on the same text on the same
// pane inside the window asks "Send it again?" in the Send slot (the Really send? slot), and the next tap sends.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  resetLiveness();
  markLive("w1:p1");
  sessionStorage.clear();
  __forgetSendAgainMemory();
  __forgetSendIntentMemory();
});
afterEach(() => cleanup());

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const props: ComponentProps<typeof Composer> = {
    paneId: "w1:p1",
    agent: "claude",
    isShell: false,
    gone: false,
    readOnly: false,
    surface: { revision: 1, turn: "idle", modal: "none", composer: "empty" },
    text: "pane output",
    terminalDraft: null,
    rawTerminalDraft: null,
    prefs: { wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false },
    display: { open: false, onToggle: vi.fn() },
    onSent: vi.fn(),
    ...overrides,
  };
  const router = createMemoryRouter([{ path: "/", element: <Composer {...props} /> }]);
  render(<RouterProvider router={router} />);
}

interface Posted {
  id: string;
  text: string;
}

const UNKNOWN = { body: { receipt: { outcome: "unknown", reason: "no_evidence", keys: [] }, offers: ["keys"] } };
const SENT = { body: { receipt: { outcome: "sent", keys: [] }, offers: [] } };
const DRAFT_REFUSED = { body: { receipt: { outcome: "refused", reason: "draft_present", keys: [] }, offers: ["append", "replace", "cancel"] } };

function bridge(answers: { body: object }[]) {
  const sends: Posted[] = [];
  server.use(
    http.post(/\/api\/send$/, async ({ request }) => {
      // SAFETY: the composer under test is the only poster, and it sends a SendRequestBody, whose id and text Posted names.
      sends.push((await request.json()) as Posted);
      const next = answers.shift();
      return next === undefined ? new HttpResponse("down", { status: 500 }) : HttpResponse.json(next.body);
    }),
  );
  return sends;
}

/** Tap Send once the last send has settled (the button is disabled while one is in flight). */
async function tapSend(user: ReturnType<typeof userEvent.setup>) {
  const button = await screen.findByRole("button", { name: "Send" });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

/** The confirming tap on "Send it again?", given after the delay a person reading it would take. */
async function tapAgain(user: ReturnType<typeof userEvent.setup>) {
  const word = await screen.findByRole("button", { name: "Send it again?" });
  await new Promise((resolve) => setTimeout(resolve, SEND_AGAIN_CONFIRM_DELAY_MS + 50));
  await user.click(word);
}

const box = () => screen.getByPlaceholderText(/type a reply/i);

describe("Send it again? after a send that ended unknown", () => {
  it("asks on the second tap with the same text, sends nothing, and the confirming tap sends under a new id", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    // The unknown answer keeps the draft; the next tap waits for a yes.
    await tapSend(user);
    const again = await screen.findByRole("button", { name: "Send it again?" });
    expect(sends).toHaveLength(1);
    // The question takes the Send slot itself: no second Send button and no row of its own.
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Really send?" })).toBeNull();
    expect(box()).toHaveValue("run the tests");
    await new Promise((resolve) => setTimeout(resolve, SEND_AGAIN_CONFIRM_DELAY_MS + 50));
    await user.click(again);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(sends[1]).toMatchObject({ text: "run the tests" });
    expect(sends[1]!.id).not.toBe(sends[0]!.id);
  });

  it("asks again when the confirmed send ends unknown too", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, UNKNOWN]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await tapAgain(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    await tapSend(user);
    expect(await screen.findByRole("button", { name: "Send it again?" })).toBeInTheDocument();
    expect(sends).toHaveLength(2);
  });

  it("sends at once when the text changed since", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await user.type(box(), " again");
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
  });

  it("sends at once after the window, and on a pane that never had an unknown send", async () => {
    const user = userEvent.setup();
    const sends = bridge([SENT, SENT]);
    // An unknown send on this pane, older than the window; and one for another pane, just now.
    rememberUnknownSend(undefined, "w1:p1", "late words", Date.now() - SEND_AGAIN_WINDOW_MS - 1_000);
    rememberUnknownSend(undefined, "w1:p2", "other pane", Date.now());
    renderComposer();
    await user.type(box(), "late words");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await user.type(box(), "other pane");
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
  });

  it("never asks after an answer that is known: a refusal is a send that did not go", async () => {
    const user = userEvent.setup();
    const sends = bridge([DRAFT_REFUSED, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
  });

  it("a known answer to the same text ends an earlier unknown one", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, DRAFT_REFUSED, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    await tapAgain(user);
    await waitFor(() => expect(sends).toHaveLength(2)); // known: refused
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(3));
  });

  it("a tap on the question 500 ms after the arm does nothing: the word stays and nothing is sent", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    const word = await screen.findByRole("button", { name: "Send it again?" });
    // A double tap by habit: the second tap lands about 500 ms after the first.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await user.click(word);
    expect(sends).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Send it again?" })).toBeInTheDocument();
    expect(box()).toHaveValue("run the tests");
    // The same word, once it has been on screen for 750 ms, sends.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await user.click(screen.getByRole("button", { name: "Send it again?" }));
    await waitFor(() => expect(sends).toHaveLength(2));
  });

  it("an early tap does not restart the 3 seconds: the word still runs out from the arm", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    const word = await screen.findByRole("button", { name: "Send it again?" });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await user.click(word);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull(), { timeout: 3500 });
    expect(sends).toHaveLength(1);
  });

  it("Really send? still confirms on an immediate second tap: only the send-again question waits", async () => {
    const user = userEvent.setup();
    const sends = bridge([SENT]);
    renderComposer();
    await user.type(box(), "rm -rf build");
    await tapSend(user);
    await user.click(await screen.findByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    expect(sends[0]).toMatchObject({ text: "rm -rf build" });
  });

  it("trailing whitespace in the box never disarms the question: the text is read the same way when it is remembered and when it is asked", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests  ");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    expect(await screen.findByRole("button", { name: "Send it again?" })).toBeInTheDocument();
    expect(sends).toHaveLength(1);
  });

  const storedKeys = () => Array.from({ length: sessionStorage.length }, (_, i) => sessionStorage.key(i)).filter((k) => k?.startsWith("collie:send-again:"));

  it("a send to a no-echo prompt writes nothing to sessionStorage", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN]);
    renderComposer({ text: "$ sudo ls\n[sudo] password for altan:" });
    await user.type(box(), "hunter2");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toBeEnabled());
    expect(storedKeys()).toEqual([]);
  });

  it("a shell pane writes nothing to sessionStorage, and still asks while the page lives", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN]);
    renderComposer({ isShell: true });
    await user.type(screen.getByRole("textbox"), "ls -la");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    expect(await screen.findByRole("button", { name: "Send it again?" })).toBeInTheDocument();
    expect(storedKeys()).toEqual([]);
  });

  it("a reload (the memory dropped) sends at once: the question is not asked after it", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN, SENT]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    __forgetSendAgainMemory();
    await tapSend(user);
    await waitFor(() => expect(sends).toHaveLength(2));
    expect(screen.queryByRole("button", { name: "Send it again?" })).toBeNull();
  });

  it("the word is dimmed (opacity-60) for its first 700 ms and at full opacity from then on, with no other change", async () => {
    const user = userEvent.setup();
    const sends = bridge([UNKNOWN]);
    renderComposer();
    await user.type(box(), "run the tests");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sends).toHaveLength(1));
    await tapSend(user);
    const word = await screen.findByRole("button", { name: "Send it again?" });
    const dimmed = word.className;
    expect(word.classList.contains("opacity-60")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(word.classList.contains("opacity-60")).toBe(true); // still dimmed at about 400 ms
    await waitFor(() => expect(word.classList.contains("opacity-60")).toBe(false), { timeout: 1500 }); // gone at 700 ms
    // Only the cue went: the same classes otherwise, so nothing moved and the words did not change.
    expect(word.className.split(" ").filter((c) => c !== "").toSorted()).toEqual(
      dimmed.split(" ").filter((c) => c !== "opacity-60" && c !== "motion-reduce:transition-none" && c !== "").toSorted(),
    );
    expect(word.textContent).toBe("Send it again?");
  });
});
