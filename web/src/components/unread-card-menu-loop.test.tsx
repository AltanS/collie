import { createRef, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { parseAnsi } from "@/lib/ansi";
import { splitLines } from "@/lib/blocks";
import { markLive, resetLiveness } from "@/lib/liveness";
import { __forgetSendAgainMemory } from "@/lib/send-again";
import { __forgetSendIntentMemory } from "@/lib/send-intent";
import { overridePasses } from "@/lib/send-protocol";
import { clearStatus } from "@/lib/status";
import type { Surface } from "@/lib/surface/surface";
import { recordedSends, sendAnswer, sendHandler } from "@/test/handlers";
import { server } from "@/test/setup";
import { Composer, type ComposerHandle } from "./composer";
import { CrewProvider } from "./crew-provider";
import { UnreadDialogBlock } from "./unread-dialog-block";

// Issue 863 (2026-11-25): on a pane with no reader profile the bridge's menu sign is a guess. Its first
// refusal opens the unread card; the card's "Send anyway" is the second tap, and the bridge now types
// that send with no key. The phone must take that answer as the end: no re-armed override, no loop.

const UNREAD: Surface = { revision: 3, turn: "idle", modal: "unknown", composer: "unknown" };
const LINES = splitLines(parseAnsi("$ ./tool\n\nPick one to go on:\n  1. Keep it\n  2. Stop here"));

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

/**
 * The pane as the app draws it here (agent-chat.tsx): the unread card over the composer, its "Send anyway"
 * wired to the composer, and drawn only while the refusal that opened the card is one an override can pass.
 */
function mount() {
  const handle = createRef<ComposerHandle>();
  function Pane() {
    const [past, setPast] = useState(true);
    return (
      <CrewProvider servers={undefined}>
        <UnreadDialogBlock cancel={null} lines={LINES} onAction={vi.fn()} onTypeAnyway={past ? () => void handle.current?.typeAnyway() : undefined} />
        <Composer
          ref={handle}
          paneId="w1:p1"
          agent="qwen"
          isShell={false}
          gone={false}
          readOnly={false}
          surface={UNREAD}
          text="pane output"
          terminalDraft={null}
          rawTerminalDraft={null}
          prefs={{ wrap: true, fontSize: 11, draftFontSize: 14, chatFontSize: 14, fontFamily: "system", rawTerminal: false, tapToFocus: true, expandClippedReply: true, stretchText: false }}
          display={{ open: false, onToggle: vi.fn() }}
          onSent={vi.fn()}
          onScreenUnread={(p) => setPast(p !== false)}
        />
      </CrewProvider>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Pane /> }])} />);
  return handle;
}

const refusalText = (): string => document.querySelector('[data-slot="composer-refusal"]')?.textContent ?? "";

describe("the unread card at a guessed menu (no reader profile)", () => {
  it("the card's second tap ends the loop: the text goes in with no Enter, and the next send carries no override", async () => {
    server.use(
      ...sendHandler((request) => {
        if (request.mode === "prepare") return sendAnswer(request.id, null, undefined, { rowsHash: "0b0b02" });
        if (request.override === true) return sendAnswer(request.id, "typed_not_submitted", "override", { offers: ["keys"], surface: UNREAD });
        if (request.text === "go on") return sendAnswer(request.id, "refused", "menu_open", { offers: ["keys"], rowsHash: "0a0a01", surface: UNREAD });
        return sendAnswer(request.id, "sent");
      }),
    );
    const user = userEvent.setup();
    mount();
    const field = screen.getByRole("textbox");
    await user.type(field, "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    // The first tap: refused as before, and the sentence names both ways out.
    await waitFor(() => expect(refusalText()).toMatch(/A menu or a question is on the screen, so nothing was typed\. Answer it with the Keys pad, or use Type to send keys with no check\./u));
    expect(recordedSends()).toHaveLength(1);
    expect(recordedSends()[0]?.override).toBeUndefined();

    // The card's "Send anyway": a fresh read for the rows hash, then the person's Send with the word.
    await user.click(screen.getByRole("button", { name: "Send anyway" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]).toMatchObject({ mode: "prepare", text: "" });
    await waitFor(() => expect(field).toHaveAttribute("placeholder", "Your message goes past this screen…"));
    // The person's words stayed in the field through the refusal.
    expect(field).toHaveValue("go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(3));
    expect(recordedSends()[2]).toMatchObject({ text: "go on", rowsHash: "0b0b02", override: true });
    await waitFor(() => expect(refusalText()).toMatch(/Collie pressed no Enter\. Check the screen, then press Enter on the Keys pad/u));
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();

    // The loop is over: nothing stays armed, so the person's next message is a plain send.
    expect(field).not.toHaveAttribute("placeholder", "Your message goes past this screen…");
    await user.clear(field);
    await user.type(field, "and then this");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(4));
    expect(recordedSends()[3]).toMatchObject({ text: "and then this" });
    expect(recordedSends()[3]?.override).toBeUndefined();
    expect(recordedSends()[3]?.rowsHash).toBeUndefined();
  });

  it("a refusal the override cannot pass does not offer Send anyway: the card keeps the Keys pad, and the next send carries no override", async () => {
    // The bridge's guarded menu_open: no rows hash, the key pad only.
    server.use(...sendHandler((request) => sendAnswer(request.id, "refused", "menu_open", { offers: ["keys"], surface: UNREAD })));
    const user = userEvent.setup();
    mount();
    const field = screen.getByRole("textbox");
    await user.type(field, "go on");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(refusalText()).toMatch(/Answer it with the Keys pad, or use Type to send keys with no check\./u));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Send anyway" })).toBeNull());
    expect(screen.getByRole("button", { name: "Keys" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(recordedSends()).toHaveLength(2));
    expect(recordedSends()[1]?.override).toBeUndefined();
    expect(recordedSends()[1]?.rowsHash).toBeUndefined();
  });

  it("names which refusals an override can pass: a menu_open with no rows hash is none", () => {
    expect(overridePasses({ reason: "menu_open", rowsHash: null })).toBe(false);
    expect(overridePasses({ reason: "menu_open", rowsHash: "0a0a01" })).toBe(true);
    expect(overridePasses({ reason: "not_free", rowsHash: null })).toBe(true);
  });
});
