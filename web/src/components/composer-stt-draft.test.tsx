import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { clearStatus } from "@/lib/status";
import type { BridgeConfig } from "@/lib/types";
import type { Surface } from "@/lib/surface/surface";
import { __resetHandsFree } from "@/lib/stt";
import { __resetOperatorCommands } from "@/lib/operator-config";
import { server } from "@/test/setup";
import {
  FakeMediaRecorder,
  installFakeMediaRecorder,
  uninstallFakeMediaRecorder,
} from "@/test/media-recorder";
import { Composer } from "./composer";

vi.mock("@/lib/liveness", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/liveness")>()),
  isLive: () => true,
  useLive: () => true,
}));

// Issue 573: the round button is the microphone only on an empty box, so a box holding a draft or a
// chip needs a second microphone beside Attach, or a person cannot dictate a second clip into it.

const CONFIG_WITH_STT: BridgeConfig = {
  push: false,
  vapidPublicKey: "",
  stt: { provider: "openai-compatible", available: true },
};
const MIC = { name: /record a voice message/i };

const ASK: Surface = {
  revision: 2,
  turn: "idle",
  modal: {
    ask: {
      id: "ask-menu",
      kind: "menu",
      options: [{ id: "1", label: "Yes" }, { id: "2", label: "No" }],
      channel: "keys",
      hash: "0a1b2c",
    },
  },
  composer: "unknown",
};

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

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => {
  clearStatus();
  __resetHandsFree();
  __resetOperatorCommands();
  installFakeMediaRecorder();
  server.use(http.get("/api/config", () => HttpResponse.json(CONFIG_WITH_STT)));
});
afterEach(() => {
  uninstallFakeMediaRecorder();
  __resetHandsFree();
  __resetOperatorCommands();
});

describe("Composer, a microphone beside Attach while the box holds a draft", () => {
  it("shows the round microphone alone on an empty box, with no second one", async () => {
    renderComposer();
    const mic = await screen.findByRole("button", MIC);
    expect(screen.getAllByRole("button", MIC)).toHaveLength(1);
    expect(mic).toHaveAttribute("data-slot", "composer-primary");
    expect(document.querySelector('[data-slot="composer-mic-draft"]')).toBeNull();
  });

  it("shows one microphone beside Attach once there is a draft, and Send takes the round slot", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByRole("button", MIC);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "first part");

    const mic = await screen.findByRole("button", MIC);
    expect(screen.getAllByRole("button", MIC)).toHaveLength(1);
    expect(mic).toHaveAttribute("data-slot", "composer-mic-draft");
    expect(mic).toBeEnabled();
    expect(screen.getByRole("button", { name: /^send$/i })).toHaveAttribute("data-slot", "composer-primary");
    // Beside Attach: the mic is the next control after it in the row.
    expect(screen.getByRole("button", { name: /attach/i }).nextElementSibling).toBe(mic);
  });

  it("goes back to the round microphone when the draft is cleared", async () => {
    const user = userEvent.setup();
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", MIC);
    await user.type(box, "x");
    await waitFor(() =>
      expect(document.querySelector('[data-slot="composer-mic-draft"]')).not.toBeNull(),
    );
    await user.clear(box);
    await waitFor(() => expect(document.querySelector('[data-slot="composer-mic-draft"]')).toBeNull());
    expect(await screen.findByRole("button", MIC)).toHaveAttribute("data-slot", "composer-primary");
  });

  it("dictates a second clip into the draft at the caret and gives focus back to the same button", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/stt", () => HttpResponse.json({ ok: true, text: "there" })));
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", MIC);
    await user.type(box, "hello world");
    act(() => {
      if (box instanceof HTMLTextAreaElement) box.setSelectionRange(5, 5);
    });

    await user.click(await screen.findByRole("button", MIC));
    await waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    expect(await screen.findByRole("group", { name: /voice input/i })).toBeInTheDocument();
    act(() => FakeMediaRecorder.instances[0]!.finish());

    await waitFor(() => expect(box).toHaveValue("hello there world"));
    await waitFor(() => expect(screen.queryByRole("group", { name: /voice input/i })).toBeNull());
  });

  it("returns focus to the small microphone after a discarded clip", async () => {
    const user = userEvent.setup();
    renderComposer();
    await screen.findByRole("button", MIC);
    await user.type(screen.getByPlaceholderText(/type a reply/i), "draft");

    await user.click(await screen.findByRole("button", MIC));
    await waitFor(() => expect(screen.getByRole("button", { name: /finish and transcribe/i })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: /discard recording/i }));
    await waitFor(() => expect(screen.getByRole("button", MIC)).toHaveFocus());
    expect(screen.getByRole("button", MIC)).toHaveAttribute("data-slot", "composer-mic-draft");
  });

  it("shows it for a box holding only a chip", async () => {
    server.use(
      http.post(/\/api\/pane\/[^/]+\/upload$/, () => HttpResponse.json({ ok: true, path: "/a.png" })),
    );
    renderComposer();
    const box = screen.getByPlaceholderText(/type a reply/i);
    await screen.findByRole("button", MIC);
    // SAFETY: `getByTestId` throws when the element is absent, and this id is on an `<input>`.
    const photos = screen.getByTestId("attach-photos") as HTMLInputElement;
    fireEvent.change(photos, { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    await waitFor(() => expect(box).toHaveValue("[Image #1] "));
    fireEvent.change(box, { target: { value: "" } });

    expect(await screen.findByRole("button", MIC)).toHaveAttribute("data-slot", "composer-mic-draft");
  });

  it("is hidden while the round slot holds the word Answer the dialog", async () => {
    const user = userEvent.setup();
    renderComposer({ surface: ASK });
    await user.type(screen.getByPlaceholderText(/type a reply/i), "for later");
    await screen.findByRole("button", { name: "Answer the dialog" });
    expect(screen.queryByRole("button", MIC)).toBeNull();
  });

  it("is hidden while the round slot holds the word Really send?", async () => {
    const user = userEvent.setup();
    renderComposer();
    await user.type(screen.getByPlaceholderText(/type a reply/i), "rm -rf build");
    await user.click(await screen.findByRole("button", { name: /^send$/i }));
    await screen.findByRole("button", { name: "Really send?" });
    expect(screen.queryByRole("button", MIC)).toBeNull();
  });
});
