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

// M100 spec 02, items 1 and 6, as M104 left them: a send of the box empties the box at the tap, so words typed
// while it was on its way are a new text and stay as typed, with the chips the person added since; and the
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

  it("keeps the words typed after the tap as typed, and stores them as the draft, not as an empty one", async () => {
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
    // The box let go of the sent text at the tap (M104).
    expect(field().value).toBe("");
    await user.type(field(), "and the next one");
    held.open();
    await screen.findByText("You sent:", {}, { timeout: 4000 });
    expect(field().value).toBe("and the next one");
    expect(loadDraft(undefined, "w1:p1")).toBe("and the next one");
  });

  // The field is changed while the send is on its way, the way typing or a mic transcript does. The box let go of the
  // sent text at the tap (M104), so whatever it holds now is new, and nothing of it goes, also the same words again.
  it.each([
    ["A B", "A B", "a new text that starts like the sent one"],
    ["B", "B", "typed after the tap"],
    ["transcript of the mic", "transcript of the mic", "a transcript"],
    ["A", "A", "the same words again: a new message, never cleared"],
  ])("the box %j after a send of A keeps %j (%s)", async (typed, kept) => {
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
    await user.type(field(), "A");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(posted).toEqual(["A"]));
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: typed } });
    held.open();
    await screen.findByText("You sent:", {}, { timeout: 4000 });
    expect(field().value).toBe(kept);
    expect(loadDraft(undefined, "w1:p1") ?? "").toBe(kept);
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
    // The box let go of the sent chip at the tap (M104): the new chip is the box's only one, stored as such.
    fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [new File(["b"], "b.png", { type: "image/png" })] } });
    await waitFor(() => expect(loadDraftEntry(undefined, "w1:p1")?.attachments.map((a) => a.path)).toEqual(["/tmp/shot-2.png"]));
    held.open();
    await screen.findByText("You sent:", {}, { timeout: 4000 });
    const left = loadDraftEntry(undefined, "w1:p1");
    expect(left?.attachments).toHaveLength(1);
    expect(left?.attachments[0]?.path).toBe("/tmp/shot-2.png");
    // The sent chip's marker is gone from the text; the new chip's marker stays with its chip.
    expect(left?.text).toContain("#2");
    expect(left?.text).not.toContain("#1]");
  });

  it("message mode: only the words typed after the sent text stay", async () => {
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
    expect(field().value).toBe("then wait");
    expect(loadDraft(undefined, "w1:p1")).toBe("then wait");
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
