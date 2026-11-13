import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDraft, loadDraftEntry } from "@/lib/drafts";
import { markLive, resetLiveness } from "@/lib/liveness";
import { clearStatus } from "@/lib/status";
import { server } from "@/test/setup";
import { Composer } from "./composer";

// M100 spec 02, items 1 and 6: a send that lands clears the box only while the box still holds what went
// out (words typed while it was on its way stay, with the chips the person added since), and the
// destructive confirm is armed on the line that goes, so an edited line asks again.

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
  return props;
}

/** An answer the test releases by hand, so the person can type while the send is on its way. */
function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function field(): HTMLTextAreaElement {
  // SAFETY: the composer's field is a textarea.
  return screen.getByPlaceholderText(/type a reply/i) as HTMLTextAreaElement;
}

describe("a send that lands keeps the words typed while it was on its way (M100 spec 02, item 1)", () => {
  it("clears the box and the stored draft when the box still holds what went out", async () => {
    const user = userEvent.setup();
    server.use(http.post(/\/api\/send$/, () => HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] })));
    renderComposer();
    await user.type(field(), "hello there");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(field().value).toBe(""));
    expect(loadDraft(undefined, "w1:p1") ?? "").toBe("");
  });

  it("keeps words typed after the tap, and stores them as the draft, not as an empty one", async () => {
    const user = userEvent.setup();
    const held = gate();
    const posted: string[] = [];
    server.use(
      http.post(/\/api\/send$/, async ({ request }) => {
        // SAFETY: the composer posts a SendRequestBody, which has a text.
        posted.push(((await request.json()) as { text: string }).text);
        await held.opened;
        return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
      }),
    );
    renderComposer();
    await user.type(field(), "first message");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted).toEqual(["first message"]));
    await user.type(field(), " and the next one");
    held.open();
    await screen.findByText("You sent:");
    expect(field().value).toBe("first message and the next one");
    expect(loadDraft(undefined, "w1:p1")).toBe("first message and the next one");
  });

  it("keeps the chip the person added after the tap and drops the one that went out", async () => {
    const user = userEvent.setup();
    const held = gate();
    let uploads = 0;
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: `/tmp/shot-${String(++uploads)}.png` })),
      http.post(/\/api\/send$/, async () => {
        await held.opened;
        return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
      }),
    );
    renderComposer();
    fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toHaveLength(1));
    await user.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [new File(["b"], "b.png", { type: "image/png" })] } });
    await waitFor(() => expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toHaveLength(2));
    held.open();
    await waitFor(() => expect(loadDraftEntry(undefined, "w1:p1")?.attachments).toHaveLength(1));
    const left = loadDraftEntry(undefined, "w1:p1");
    expect(left?.attachments[0]?.path).toBe("/tmp/shot-2.png");
    // The sent chip's marker is gone from the text; the new chip's marker stays with its chip.
    expect(left?.text).toContain("#2");
    expect(left?.text).not.toContain("#1]");
  });

  it("message mode: words typed while the message was on its way stay", async () => {
    const user = userEvent.setup();
    const held = gate();
    const posts: string[] = [];
    server.use(
      http.post("/api/walky", async ({ request }) => {
        // SAFETY: the composer posts a WalkySendBody, which has a body and a target.
        const posted = (await request.json()) as { to: string };
        posts.push(posted.to);
        await held.opened;
        return HttpResponse.json({ receipt: { id: "wt_aaaaaaaaaaaa", state: "delivered", verified: "local", at: 1, by: "solo", target: posted.to } });
      }),
    );
    renderComposer();
    await user.type(field(), "Stop and report");
    fireEvent.contextMenu(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Send as message" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await user.type(field(), " then wait");
    held.open();
    await screen.findByText(/Message to this pane: /);
    await waitFor(() => expect(screen.queryByText("Message to this pane: sending")).toBeNull());
    expect(field().value).toBe("Stop and report then wait");
    expect(loadDraft(undefined, "w1:p1")).toBe("Stop and report then wait");
  });
});

describe("the destructive confirm is armed on the line that goes (M100 spec 02, item 6)", () => {
  it("an edited line needs a new confirm, and the note names the reason of the line now in the box", async () => {
    const user = userEvent.setup();
    const sends: string[] = [];
    server.use(
      http.post(/\/api\/send$/, async ({ request }) => {
        // SAFETY: the composer posts a SendRequestBody, which has a text.
        sends.push(((await request.json()) as { text: string }).text);
        return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
      }),
    );
    renderComposer();
    await user.type(field(), "rm -rf build");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("button", { name: "Really send?" })).toBeInTheDocument();
    expect(screen.getByText(/Destructive: rm -r/)).toBeInTheDocument();
    // The line changes to a different destructive one inside the window: the arm no longer stands.
    await user.clear(field());
    await user.type(field(), "git push --force");
    expect(screen.queryByRole("button", { name: "Really send?" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(sends).toEqual([]);
    expect(await screen.findByRole("button", { name: "Really send?" })).toBeInTheDocument();
    expect(screen.getByText(/Destructive: .*force/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(sends).toEqual(["git push --force"]));
  });

  it("the same line still goes on the second tap", async () => {
    const user = userEvent.setup();
    const sends: string[] = [];
    server.use(
      http.post(/\/api\/send$/, async ({ request }) => {
        // SAFETY: the composer posts a SendRequestBody, which has a text.
        sends.push(((await request.json()) as { text: string }).text);
        return HttpResponse.json({ receipt: { outcome: "sent", keys: [] }, offers: [] });
      }),
    );
    renderComposer();
    await user.type(field(), "rm -rf build");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await user.click(await screen.findByRole("button", { name: "Really send?" }));
    await waitFor(() => expect(sends).toEqual(["rm -rf build"]));
  });
});
