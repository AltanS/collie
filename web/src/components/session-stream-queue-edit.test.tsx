import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";

import { SessionStream, type QueuedCardAction, type QueuedCardResult } from "./session-stream";
import type { ChatFeed } from "@/hooks/use-chat-window";
import type { ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { EMPTY_CHAT_WINDOW, type ChatWindow } from "@/lib/chat-window";

// Edit on the two queue cards (ADR 0122, the 2026-11-22 addendum). On the waiting card it shows only where the
// bridge declares a dequeue key (`ChatWindow.dequeueQueued`, data, no harness name) and the pane view passes the
// handler; it sits left of Send now, and while either runs both are disabled. On the "Back in the box" card it sits
// between Discard and Send, hands the card's id, its act and its text over, and is withheld for a masked text.

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

function feedOf(window: Partial<ChatWindow>): ChatFeed {
  return { window: { ...EMPTY_CHAT_WINDOW, ...window }, loadOlder: vi.fn(), loadingOlder: false, asked: 0, answered: 0, tried: false };
}

interface Acts {
  sendNow?: (keys: readonly string[]) => Promise<boolean>;
  edit?: () => Promise<boolean>;
  returned?: (requestId: string, action: QueuedCardAction, text: string) => Promise<QueuedCardResult>;
}

function draw(window: Partial<ChatWindow>, acts: Acts = {}) {
  const listRef = createRef<ChatMessageListHandle>();
  return render(
    <SessionStream
      feed={feedOf({ status: { kind: "live" }, entries: [], ...window })}
      address="w1:p1"
      working
      showToolCalls
      showCompactions={false}
      fontSize={14}
      listRef={listRef}
      onSendQueuedNow={acts.sendNow}
      onEditQueued={acts.edit}
      onReturned={acts.returned}
      agent="muse"
    />,
  );
}

const WAITING = { queued: ["first", "second"], sendQueuedNow: ["ctrl+Enter"], dequeueQueued: ["Up"] } as const;
const EDIT_NAME = "Take the waiting messages back into the box to edit them";

describe("SessionStream: Edit on the waiting card", () => {
  it("shows Edit left of Send now, in the head row, when the bridge declares a dequeue key and the device can write", () => {
    const { container } = draw(WAITING, { sendNow: vi.fn(async () => true), edit: vi.fn(async () => true) });
    const head = container.querySelector("[data-slot='stream-queued'] > div")!;
    expect([...head.querySelectorAll("button")].map((button) => button.getAttribute("data-slot"))).toEqual(["stream-queued-edit", "stream-send-now"]);
    expect(screen.getByRole("button", { name: EDIT_NAME })).toHaveTextContent("Edit");
  });

  it("is absent when the bridge declares no dequeue key, and Send now stays", () => {
    const { container } = draw({ ...WAITING, dequeueQueued: [] }, { sendNow: vi.fn(async () => true), edit: vi.fn(async () => true) });
    expect(container.querySelector("[data-slot='stream-queued-edit']")).toBeNull();
    expect(container.querySelector("[data-slot='stream-send-now']")).not.toBeNull();
  });

  it("is absent when the pane view withholds the handler (a device that cannot act, a saved copy)", () => {
    const { container } = draw(WAITING);
    expect(container.querySelector("[data-slot='stream-queued']")).not.toBeNull();
    expect(container.querySelector("[data-slot='stream-queued-edit']")).toBeNull();
  });

  it("stands alone when there are no Send now keys", () => {
    const { container } = draw({ ...WAITING, sendQueuedNow: [] }, { sendNow: vi.fn(async () => true), edit: vi.fn(async () => true) });
    expect(container.querySelector("[data-slot='stream-queued-edit']")).not.toBeNull();
    expect(container.querySelector("[data-slot='stream-send-now']")).toBeNull();
  });

  it("a tap asks once, disables both buttons while it runs, and a second tap on either asks nothing", async () => {
    let finish: (done: boolean) => void = () => undefined;
    const edit = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    const sendNow = vi.fn(async () => true);
    draw(WAITING, { sendNow, edit });
    const editButton = screen.getByRole("button", { name: EDIT_NAME });
    const sendButton = screen.getByRole("button", { name: "Send now, the waiting messages" });
    await userEvent.click(editButton);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(editButton).toBeDisabled();
    expect(editButton).toHaveAttribute("aria-busy", "true");
    expect(sendButton).toBeDisabled();
    expect(sendButton).toHaveAttribute("aria-busy", "false");
    await userEvent.click(editButton);
    await userEvent.click(sendButton);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(sendNow).not.toHaveBeenCalled();
    // Nothing came back: both buttons are free again.
    await act(async () => finish(false));
    expect(editButton).toBeEnabled();
    expect(sendButton).toBeEnabled();
  });

  it("Send now running disables Edit too", async () => {
    const sendNow = vi.fn(() => new Promise<boolean>(() => undefined));
    const edit = vi.fn(async () => true);
    draw(WAITING, { sendNow, edit });
    await userEvent.click(screen.getByRole("button", { name: "Send now, the waiting messages" }));
    expect(screen.getByRole("button", { name: EDIT_NAME })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: EDIT_NAME }));
    expect(edit).not.toHaveBeenCalled();
  });

  it("this card never carries the stop-the-turn line, with or without Edit", () => {
    const { container } = draw(WAITING, { edit: vi.fn(async () => true) });
    expect(container.querySelector("[data-slot='stream-queued']")).not.toHaveTextContent("To take it back, stop the turn.");
  });
});

describe("SessionStream: Edit on the Back in the box card", () => {
  const BACK = { requestId: "req-back-00001", state: "returned", text: "second message", whole: true } as const;
  const EDIT_BACK = "Take this message back into the box to edit it";

  it("orders the buttons Discard, Edit, Send", () => {
    const { container } = draw({ queuedSends: [BACK] }, { returned: vi.fn(async () => true) });
    const card = container.querySelector("[data-slot='stream-returned']")!;
    expect([...card.querySelectorAll("button")].map((button) => button.textContent)).toEqual(["Discard", "Edit", "Send"]);
    expect(screen.getByRole("button", { name: EDIT_BACK })).toHaveAttribute("data-slot", "stream-returned-edit");
  });

  it("hands the card's id, the edit act and its text over, once, and disables the row while it runs", async () => {
    let finish: (done: QueuedCardResult) => void = () => undefined;
    const returned = vi.fn(() => new Promise<QueuedCardResult>((resolve) => (finish = resolve)));
    draw({ queuedSends: [BACK] }, { returned });
    const edit = screen.getByRole("button", { name: EDIT_BACK });
    await userEvent.click(edit);
    expect(returned).toHaveBeenCalledWith("req-back-00001", "edit", "second message");
    expect(edit).toBeDisabled();
    expect(screen.getByRole("button", { name: "Discard this message from the agent's box" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send this message from the agent's box" })).toBeDisabled();
    await userEvent.click(edit);
    expect(returned).toHaveBeenCalledTimes(1);
    await act(async () => finish(false));
    expect(edit).toBeEnabled();
  });

  it("is withheld where the bridge does not say the text is its own and whole (an older bridge, a kept line after a restart)", () => {
    const { container } = draw({ queuedSends: [{ requestId: "req-back-00002", state: "returned", text: "second message" }] }, { returned: vi.fn(async () => true) });
    expect([...container.querySelectorAll("[data-slot='stream-returned'] button")].map((button) => button.textContent)).toEqual(["Discard", "Send"]);
  });

  it("is withheld for a text the bridge masked, because the dots are not the message", () => {
    draw({ queuedSends: [{ requestId: "req-mask-00001", state: "returned", text: "use the key sk-o••••••••", whole: true }] }, { returned: vi.fn(async () => true) });
    expect(screen.getByRole("button", { name: "Discard this message from the agent's box" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: EDIT_BACK })).toBeNull();
  });
});
