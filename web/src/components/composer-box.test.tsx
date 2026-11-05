import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { __resetHandsFree } from "@/lib/stt";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import { installFakeMediaRecorder, uninstallFakeMediaRecorder } from "@/test/media-recorder";
import { Composer } from "./composer";

// The composer's second layout, `layout="box"`: one slim row at rest, a taller box with the field on
// top and the buttons in a row of their own when open. Layout only, so these cases read the shape the
// box declares (`data-box`) and which control is the filled main button; the send, draft and speech
// behaviours have their own suites and run on the default layout.

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

vi.mock("@/components/image-editor", () => ({ ImageEditor: () => null }));

function baseProps(overrides: Partial<ComponentProps<typeof Composer>>): ComponentProps<typeof Composer> {
  return {
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
}

function renderComposer(overrides: Partial<ComponentProps<typeof Composer>> = {}) {
  const router = createMemoryRouter([{ path: "/", element: <Composer {...baseProps(overrides)} /> }]);
  render(<RouterProvider router={router} />);
}

/** The box, once the microphone has been drawn (the capability read is asynchronous). */
async function readyBox(): Promise<HTMLElement> {
  await screen.findByRole("button", { name: /record a voice message/i });
  return document.querySelector<HTMLElement>('[data-slot="composer-box"]')!;
}

const field = () => screen.getByPlaceholderText<HTMLTextAreaElement>(/type a reply/i);
const primary = () => document.querySelector<HTMLElement>('[data-slot="composer-primary"]')!;
const sendButton = () => screen.queryByRole("button", { name: "Send" });

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  __resetHandsFree();
  __resetOperatorCommands();
  installFakeMediaRecorder();
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json({ push: false, vapidPublicKey: "", stt: { provider: "openai-compatible", available: true } }),
    ),
  );
});
afterEach(() => {
  uninstallFakeMediaRecorder();
  __resetHandsFree();
  __resetOperatorCommands();
});

describe("Composer layout=box", () => {
  it("is the field layout by default: the box declares no layout and the field keeps its flex row", async () => {
    renderComposer();
    const box = await readyBox();
    expect(box).not.toHaveAttribute("data-layout");
    expect(box).not.toHaveAttribute("data-box");
    expect(box.className).toMatch(/\bflex\b/);
    expect(box.className).not.toMatch(/\bgrid\b/);
    expect(box.className).toMatch(/border-input/);
    expect(field().className).toMatch(/flex-1/);
  });

  it("rests as one row: attach, the field, and the microphone as the main button, with no Send", async () => {
    renderComposer({ layout: "box" });
    const box = await readyBox();
    expect(box).toHaveAttribute("data-layout", "box");
    expect(box).toHaveAttribute("data-box", "rest");
    // Everything stands on the first row of the grid.
    const attach = screen.getByRole("button", { name: /attach file/i });
    for (const el of [attach, field(), primary()]) expect(el.className).toMatch(/row-start-1/);
    expect(primary()).toHaveAccessibleName(/record a voice message/i);
    expect(primary().className).toMatch(/\bbg-primary\b/);
    // An empty box has no Send today (the microphone takes the slot), and none is drawn here.
    expect(sendButton()).toBeNull();
    expect(document.querySelector('[data-slot="composer-mic-draft"]')).toBeNull();
  });

  it("opens on focus: the field takes the full width on its own row and the buttons drop under it", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(field());
    expect(box).toHaveAttribute("data-box", "open");
    expect(field().className).toMatch(/col-span-full/);
    expect(field().className).toMatch(/row-start-2/);
    for (const el of [screen.getByRole("button", { name: /attach file/i }), primary()]) {
      expect(el.className).toMatch(/row-start-3/);
    }
    // Still empty: the microphone is still the main button.
    expect(primary()).toHaveAccessibleName(/record a voice message/i);
  });

  it("makes Send the main button and the microphone a ghost once there is text", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(field());
    await user.type(field(), "Make the tab a folder tab");
    expect(box).toHaveAttribute("data-box", "open");
    expect(primary()).toHaveAccessibleName("Send");
    const ghost = document.querySelector<HTMLElement>('[data-slot="composer-mic-draft"]')!;
    expect(ghost).toHaveAccessibleName(/record a voice message/i);
    // A small filled circle, not the main button (Altan, 2026-11-05: bare icons looked loose).
    expect(ghost.className).toMatch(/bg-secondary/);
    expect(ghost.className).not.toMatch(/bg-primary/);
    // The ghost mic sits left of Send in the button row.
    expect(ghost.className).toMatch(/col-start-3/);
    expect(primary().className).toMatch(/col-start-4/);
  });

  it("closes on blur while empty, and keeps the field element", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    const before = field();
    await user.click(before);
    expect(box).toHaveAttribute("data-box", "open");
    act(() => before.blur());
    expect(box).toHaveAttribute("data-box", "rest");
    // The same element: it was never remounted, so a caret and a draft would have survived.
    expect(field()).toBe(before);
  });

  it("stays open on blur while it holds text, and the draft is kept across the shapes", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(field());
    await user.type(field(), "keep this");
    act(() => field().blur());
    expect(box).toHaveAttribute("data-box", "open");
    expect(field().value).toBe("keep this");
  });

  it("stays open while a chip is attached", async () => {
    server.use(http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/tmp/shot-1.png" })));
    renderComposer({ layout: "box" });
    const box = await readyBox();
    expect(box).toHaveAttribute("data-box", "rest");
    fireEvent.change(screen.getByTestId("attach-photos"), { target: { files: [new File(["a"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(box).toHaveAttribute("data-box", "open"));
    // No text, but a chip is something to send: Send is the main button.
    expect(primary()).toHaveAccessibleName("Send");
    expect(document.querySelector("ul")!.className).toMatch(/row-start-1/);
  });

  it("opens when a tap lands on the box itself, not on a control", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(box);
    expect(field()).toHaveFocus();
    expect(box).toHaveAttribute("data-box", "open");
  });

  it("mirrors for the left hand: Send on the outer left, Attach at the right", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", hand: "left" });
    await readyBox();
    expect(primary().className).toMatch(/col-start-1/);
    expect(screen.getByRole("button", { name: /attach file/i }).className).toMatch(/col-start-3/);
    await user.click(field());
    expect(screen.getByRole("button", { name: /attach file/i }).className).toMatch(/col-start-4/);
  });
});
