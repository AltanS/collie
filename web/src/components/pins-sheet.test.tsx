import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus, useStatus } from "@/lib/status";
import { fixturePin, setMessagePins } from "@/test/handlers";
import { server } from "@/test/msw";
import type { PinRow } from "@/lib/types";
import { PinsSheet } from "./pins-sheet";

beforeEach(() => clearStatus());

const NOW = Date.now();
const MINUTE = 60_000;

/** Rows as the bridge lists them: an excerpt, the length, no text. */
const rows: PinRow[] = [
  { id: "p-old", itemId: "t1:0", kind: "user", excerpt: "what changed today?", textLength: 19, anchor: "what changed today?", pinnedAt: NOW - 60 * MINUTE },
  { id: "p-new", itemId: "t2:1", kind: "reply", excerpt: "One commit: abc1234.", textLength: 20, anchor: "One commit", pinnedAt: NOW - 5 * MINUTE },
  { id: "p-tool", itemId: "t2:0", kind: "tool", excerpt: "abc1234 fix", textLength: 11, anchor: "abc1234 fix", tool: { name: "Bash", input: "git log" }, pinnedAt: NOW - 30 * MINUTE },
];

function Notice() {
  const status = useStatus();
  return <p data-testid="notice">{status?.text ?? ""}</p>;
}

function mount(over: { shown?: boolean; list?: PinRow[] } = {}) {
  const calls = { unpin: new Array<string>(), opened: 0, shown: new Array<string>(), closed: 0 };
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          reopen
        </button>
        <PinsSheet
          open={open}
          onClose={() => {
            calls.closed += 1;
            setOpen(false);
          }}
          scope={undefined}
          paneId="w1:p1"
          rows={over.list ?? rows}
          onUnpin={(id) => calls.unpin.push(id)}
          onOpened={() => {
            calls.opened += 1;
          }}
          onShow={(pin) => {
            calls.shown.push(pin.id);
            return over.shown ?? true;
          }}
        />
        <Notice />
      </>
    );
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Harness /> }])} />);
  return calls;
}

const listOf = () => within(screen.getByRole("dialog", { name: "Pinned messages" }));

describe("PinsSheet, the list", () => {
  it("lists the pins newest first, each with who spoke, its excerpt and its age", () => {
    mount();
    const items = screen.getAllByRole("listitem");
    expect(items.map((li) => li.querySelector('[data-slot="pin-excerpt"]')?.textContent)).toEqual(["One commit: abc1234.", "abc1234 fix", "what changed today?"]);
    expect(items[0]).toHaveTextContent("Reply");
    expect(items[0]).toHaveTextContent("5m");
    expect(items[1]).toHaveTextContent("Tool: Bash");
    expect(items[2]).toHaveTextContent("Your message");
  });

  it("clamps the excerpt to three lines", () => {
    mount();
    expect(document.querySelector('[data-slot="pin-excerpt"]')).toHaveClass("line-clamp-3");
  });

  it("puts an Unpin at the end of every row, which unpins that pin and leaves the sheet open", async () => {
    const user = userEvent.setup();
    const calls = mount();
    const buttons = listOf().getAllByRole("button", { name: "Unpin" });
    expect(buttons).toHaveLength(3);
    await user.click(buttons[1]!);
    expect(calls.unpin).toEqual(["p-tool"]);
    expect(screen.getByRole("dialog", { name: "Pinned messages" })).toBeInTheDocument();
  });

  it("reads the list again each time it opens", async () => {
    const user = userEvent.setup();
    const calls = mount();
    expect(calls.opened).toBe(1);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(screen.getByRole("button", { name: "reopen" }));
    expect(calls.opened).toBe(2);
  });

  it("says so when nothing is pinned", () => {
    mount({ list: [] });
    expect(screen.getByText("Nothing is pinned in this session.")).toBeInTheDocument();
  });
});

describe("PinsSheet, the detail", () => {
  const whole = () =>
    setMessagePins([
      fixturePin({ id: "p-new", itemId: "t2:1", kind: "reply", text: "One commit: abc1234.\n\nAnd the whole story after it.", pinnedAt: NOW - 5 * MINUTE }),
      fixturePin({ id: "p-old", itemId: "t1:0", kind: "user", text: "what changed today?", pinnedAt: NOW - 60 * MINUTE }),
    ]);

  it("opens on a tap of the row and shows the whole text, fetched from the pin", async () => {
    const user = userEvent.setup();
    whole();
    mount();
    await user.click(screen.getByText("One commit: abc1234."));
    const detail = await screen.findByRole("dialog", { name: /^Reply · / });
    expect(await within(detail).findByText("And the whole story after it.")).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Unpin" })).toBeInTheDocument();
    expect(within(detail).getByRole("button", { name: "Show in Chat" })).toBeInTheDocument();
  });

  it("closes the detail on the first Escape and the list on the second", async () => {
    const user = userEvent.setup();
    whole();
    const calls = mount();
    await user.click(screen.getByText("One commit: abc1234."));
    await screen.findByRole("dialog", { name: /^Reply · / });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Reply · / })).toBeNull());
    expect(screen.getByRole("dialog", { name: "Pinned messages" })).toBeInTheDocument();
    expect(calls.closed).toBe(0);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(calls.closed).toBe(1));
  });

  it("unpins from the footer and goes back to the list", async () => {
    const user = userEvent.setup();
    whole();
    const calls = mount();
    await user.click(screen.getByText("One commit: abc1234."));
    const detail = await screen.findByRole("dialog", { name: /^Reply · / });
    await user.click(within(detail).getByRole("button", { name: "Unpin" }));
    expect(calls.unpin).toEqual(["p-new"]);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Reply · / })).toBeNull());
  });

  it("Show in Chat closes both sheets and says nothing when the block is loaded", async () => {
    const user = userEvent.setup();
    whole();
    const calls = mount({ shown: true });
    await user.click(screen.getByText("One commit: abc1234."));
    await user.click(await screen.findByRole("button", { name: "Show in Chat" }));
    expect(calls.shown).toEqual(["p-new"]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("notice")).toHaveTextContent("");
  });

  it("Show in Chat closes both sheets and says why when the block is not loaded", async () => {
    const user = userEvent.setup();
    whole();
    mount({ shown: false });
    await user.click(screen.getByText("One commit: abc1234."));
    await user.click(await screen.findByRole("button", { name: "Show in Chat" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByTestId("notice")).toHaveTextContent("That block is not loaded in Chat. Scroll up to load older messages.");
  });

  it("goes back to the list with the reason when the pin is gone", async () => {
    const user = userEvent.setup();
    server.use(http.get(/\/api\/pane\/[^/]+\/pins$/, () => HttpResponse.json({ error: "pin.not_found", code: "pin.not_found", message: "gone" }, { status: 404 })));
    mount();
    await user.click(screen.getByText("One commit: abc1234."));
    await waitFor(() => expect(screen.getByTestId("notice")).toHaveTextContent("That pin is gone."));
    expect(screen.queryByRole("dialog", { name: /^Reply · / })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Pinned messages" })).toBeInTheDocument();
  });

  it("moves focus to the list's title when the detail's own Unpin removed the row it was opened from", async () => {
    const user = userEvent.setup();
    whole();
    mount();
    await user.click(screen.getByText("One commit: abc1234."));
    const detail = await screen.findByRole("dialog", { name: /^Reply · / });
    await user.click(within(detail).getByRole("button", { name: "Unpin" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /^Reply · / })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByText("Pinned messages")));
  });
});
