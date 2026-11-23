import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

import { reviewOf } from "@/lib/hill/asks";
import { askDecision } from "@/test/asks-fixtures";

import type { AsksSendState } from "@/hooks/use-asks-send";
import type { SessionClock } from "@/lib/hill/asks-board";

import { AskSendSheet } from "./ask-send-sheet";

const A = askDecision({ id: "ak_a", title: "Keep the route?" });
const B = askDecision({ id: "ak_b", title: "Drop the flag?" });

function sheet(over: { clock?: SessionClock; state?: AsksSendState; marked?: boolean } = {}) {
  const drafts = new Map(over.marked === false ? [] : [["ak_a", { intent: "keep", text: "for now" }]]);
  const onSend = vi.fn();
  const onClose = vi.fn();
  render(<AskSendSheet open onClose={onClose} name="collie lead" review={reviewOf([A, B], drafts)} clock={over.clock ?? { kind: "warm", msLeft: 600_000 }} state={over.state ?? { phase: "idle" }} onSend={onSend} />);
  return { onSend, onClose };
}

describe("the send sheet", () => {
  it("shows the very message the bridge types, its length and the cheap turn of a warm session", async () => {
    const { onSend } = sheet();
    const dialog = await screen.findByRole("dialog", { name: "Send to collie lead" });
    expect(dialog.querySelector('[data-slot="ask-send-message"]')).toHaveTextContent('ak_a "Keep the route?": keep (Keep both routes). Note: for now');
    expect(dialog.querySelector('[data-slot="ask-send-message"]')).toHaveTextContent('ak_b "Drop the flag?"');
    expect(dialog.querySelector('[data-slot="ask-send-count"]')).toHaveTextContent(/characters$/u);
    expect(dialog).toHaveTextContent("The session is warm. This send is one cheap turn.");
    await userEvent.click(screen.getByRole("button", { name: "Send 1" }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("warns that a cold session starts a turn at full price, and says nothing for an unknown one", async () => {
    sheet({ clock: { kind: "cold" } });
    expect(await screen.findByRole("dialog")).toHaveTextContent("This send starts a turn at full price.");
  });

  it("says nothing about the cache when the clock is unknown", async () => {
    sheet({ clock: { kind: "unknown" } });
    expect((await screen.findByRole("dialog")).querySelectorAll('[data-slot="notice"]')).toHaveLength(0);
  });

  it("holds Send off with no answer and while a send runs", async () => {
    sheet({ marked: false });
    expect(await screen.findByRole("button", { name: "Send 0" })).toBeDisabled();
  });

  it("shows Sending and holds the button while the request is in flight", async () => {
    sheet({ state: { phase: "sending" } });
    expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled();
  });

  it("reads a refusal and a lost network in plain words above the buttons", async () => {
    sheet({ state: { phase: "refused", words: "These answers belong to more than one session. Nothing was sent." } });
    expect(await screen.findByRole("alert")).toHaveTextContent("These answers belong to more than one session. Nothing was sent.");
  });

  it("tells a lost send to be tried again", async () => {
    sheet({ state: { phase: "failed" } });
    expect(await screen.findByRole("alert")).toHaveTextContent("Not sent. Tap Send to try again.");
  });

  it("closes with Hold and sends nothing", async () => {
    const { onClose, onSend } = sheet();
    await userEvent.click(await screen.findByRole("button", { name: "Hold" }));
    expect(onClose).toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
  });
});
