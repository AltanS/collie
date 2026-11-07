import { useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

  it("stays one row when the empty box is focused: the caret alone takes no room", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(field());
    expect(field()).toHaveFocus();
    expect(box).toHaveAttribute("data-box", "rest");
    expect(field().className).toMatch(/row-start-1/);
    expect(primary()).toHaveAccessibleName(/record a voice message/i);
  });

  it("opens on the first character: the field takes the full width and the buttons drop under it", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(field());
    await user.type(field(), "a");
    expect(box).toHaveAttribute("data-box", "open");
    expect(field().className).toMatch(/col-span-full/);
    expect(field().className).toMatch(/row-start-2/);
    for (const el of [screen.getByRole("button", { name: /attach file/i }), primary()]) {
      expect(el.className).toMatch(/row-start-3/);
    }
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
    // The bottom row reads Attach at the left, the field's own space growing, then the small mic
    // and Send at the right (column 3 is Expand's, where a pane view is there to cover).
    const attach = screen.getByRole("button", { name: /attach file/i });
    expect(attach.className).toMatch(/col-start-1/);
    expect(ghost.className).toMatch(/col-start-4/);
    expect(primary().className).toMatch(/col-start-5/);
  });

  it("closes when the draft is emptied with the focus still in the field, and keeps the same field", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    const before = field();
    await user.click(before);
    await user.type(before, "hello");
    expect(box).toHaveAttribute("data-box", "open");
    await user.clear(before);
    expect(box).toHaveAttribute("data-box", "rest");
    // The same element and still focused: a caret and a draft would have survived both changes.
    expect(field()).toBe(before);
    expect(before).toHaveFocus();
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

  it("focuses the field when a tap lands on the box itself, not on a control", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    await user.click(box);
    expect(field()).toHaveFocus();
  });

  it("rests as [Attach][field][main] and opens to a field of its own text, with no minimum height", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    const box = await readyBox();
    const attach = screen.getByRole("button", { name: /attach file/i });
    // At rest Attach stands at the left edge, the field between it and the main button (Altan,
    // 2026-11-07: the + goes back to the left).
    expect(box.className).toMatch(/grid-cols-\[auto_1fr_auto\]/);
    expect(attach.className).toMatch(/col-start-1/);
    expect(field().className).toMatch(/col-start-2/);
    expect(primary().className).toMatch(/col-start-3/);
    await user.type(field(), "a");
    // Open, the field is as tall as its text: nothing reserves three lines.
    expect(field().className).not.toMatch(/min-h-/);
    // Attach keeps its edge: the first cell of the bottom row, the space growing after it.
    expect(box.className).toMatch(/grid-cols-\[auto_1fr_auto_auto_auto\]/);
    expect(attach.className).toMatch(/col-start-1/);
    expect(attach.className).toMatch(/row-start-3/);
  });

  it("caps the field at the draft cap in both layouts (lib/draft-cap.ts)", async () => {
    for (const layout of ["box", "field"] as const) {
      renderComposer({ layout });
      await readyBox();
      expect(field().className).toMatch(/max-h-\[var\(--draft-cap\)\]/);
      expect(field().className).not.toMatch(/max-h-\[min\(10rem/);
      expect(field().style.getPropertyValue("--draft-cap")).toMatch(/^\d+px$/);
      cleanup();
    }
  });

  it("gives the circles 6px of air from the border and from each other", async () => {
    renderComposer({ layout: "box" });
    const box = await readyBox();
    expect(box.className).toMatch(/\bp-1\.5\b/);
    expect(box.className).toMatch(/gap-x-1\.5/);
  });

  it("mirrors for the left hand: Send on the outer left, the field, Attach at the right", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", hand: "left" });
    await readyBox();
    const attach = screen.getByRole("button", { name: /attach file/i });
    expect(primary().className).toMatch(/col-start-1/);
    expect(field().className).toMatch(/col-start-2/);
    expect(attach.className).toMatch(/col-start-3/);
    await user.type(field(), "a");
    // Open: [Send][mic][Expand][space][Attach], Attach still at the right edge.
    expect(primary().className).toMatch(/col-start-1/);
    expect(document.querySelector<HTMLElement>('[data-slot="composer-mic-draft"]')!.className).toMatch(/col-start-2/);
    expect(attach.className).toMatch(/col-start-5/);
  });

  describe("the change of shape is played", () => {
    // Typed like `Element.animate`, so each recorded call carries its keyframes and timing as such.
    const animate = vi.fn((_frames: PropertyIndexedKeyframes, _timing: KeyframeAnimationOptions) => ({ cancel: vi.fn() }));
    /** Every transform keyframe the composer asked for, as written. */
    const transforms = (): string[] =>
      animate.mock.calls.flatMap(([frames]) => {
        const value = frames.transform;
        if (value === undefined || value === null) return [];
        return (Array.isArray(value) ? value : [value]).map(String);
      });
    beforeEach(() => {
      animate.mockClear();
      Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true, writable: true });
    });
    afterEach(() => {
      Reflect.deleteProperty(HTMLElement.prototype, "animate");
      vi.unstubAllGlobals();
    });

    it("animates the buttons that appear when the box opens", async () => {
      const user = userEvent.setup();
      renderComposer({ layout: "box" });
      await readyBox();
      await user.click(field());
      expect(animate).not.toHaveBeenCalled();
      await user.type(field(), "a");
      // The ghost microphone and Send are new in the open shape and slide in (jsdom measures every
      // rect as zero, so no move is played; the geometry is covered in hooks/use-flip.test.ts).
      expect(animate).toHaveBeenCalled();
    });

    it("moves the buttons along the x-axis only, never up or down", async () => {
      const user = userEvent.setup();
      renderComposer({ layout: "box" });
      await readyBox();
      await user.type(field(), "a");
      // The small microphone slides in sideways (Altan, 2026-11-07: the buttons looked as if they
      // bounced down from the top).
      expect(transforms().length).toBeGreaterThan(0);
      for (const transform of transforms()) expect(transform).toMatch(/^translateX\(-?[\d.]+px\)$|^translateX\(0\)$/);
      for (const [, timing] of animate.mock.calls) expect(timing.duration).toBeLessThanOrEqual(200);
    });

    it("plays nothing under prefers-reduced-motion", async () => {
      vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduce"), media: query, addEventListener() {}, removeEventListener() {} }));
      const user = userEvent.setup();
      renderComposer({ layout: "box" });
      await readyBox();
      await user.type(field(), "a");
      expect(animate).not.toHaveBeenCalled();
    });

    it("plays only the sideways entrance in the field layout: no height, no row", async () => {
      const user = userEvent.setup();
      renderComposer();
      await readyBox();
      await user.type(field(), "a");
      // Send takes the microphone's place and the small microphone appears beside it: both slide in.
      expect(animate).toHaveBeenCalled();
      for (const [frames] of animate.mock.calls) expect(frames).not.toHaveProperty("height");
      expect(transforms().length).toBeGreaterThan(0);
      for (const transform of transforms()) expect(transform).toMatch(/^translateX/);
    });
  });
});

// THE FULLSCREEN EDITOR (Altan, 2026-11-08): Expand in the open row opens the same draft over the pane
// view; Collapse, Send, Escape and a pane switch close it, and the draft is never copied or lost.
describe("Composer layout=box, the fullscreen editor", () => {
  let area: HTMLElement;
  // jsdom lays nothing out, so a field's content height is given here: 21px a line (14px text at
  // 1.5) plus 12px of padding. The cap in this window is five rows, 117px (lib/draft-cap.ts).
  const ROW = 21;
  const contentHeight = (value: string) => value.split("\n").length * ROW + 12;
  beforeEach(() => {
    area = document.createElement("div");
    document.body.append(area);
    Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLTextAreaElement) {
        return contentHeight(this.value);
      },
    });
  });
  afterEach(() => {
    area.remove();
    Reflect.deleteProperty(HTMLTextAreaElement.prototype, "scrollHeight");
  });
  /** A draft of `rows` lines, the last one `last`. */
  const lines = (rows: number, last = "end") => [...Array.from({ length: rows - 1 }, (_, i) => `line ${String(i + 1)}`), last].join("\n");
  /** Put a long draft into the box's field, past the cap. */
  // A change event, not a paste: a long paste becomes a paste chip in this composer (ADR 0060).
  async function typeLong(user: ReturnType<typeof userEvent.setup>, last = "end") {
    await user.click(field());
    fireEvent.change(field(), { target: { value: lines(8, last) } });
  }

  /** A composer whose pane can be switched, as a pane switch keeps the composer mounted. */
  function Switchable() {
    const [paneId, setPaneId] = useState("w1:p1");
    return (
      <>
        <button type="button" onClick={() => setPaneId("w1:p2")}>
          switch pane
        </button>
        <Composer {...baseProps({ paneId, layout: "box", expandArea: area })} />
      </>
    );
  }
  function renderSwitchable() {
    const router = createMemoryRouter([{ path: "/", element: <Switchable /> }]);
    render(<RouterProvider router={router} />);
  }
  const expand = () => screen.queryByRole("button", { name: "Expand" });
  const layer = () => document.querySelector<HTMLElement>('[data-slot="composer-expanded"]');
  const layerField = () => layer()!.querySelector("textarea")!;

  it("offers Expand in the open row, between the space and the small mic, once the draft is past the cap", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    expect(expand()).toBeNull();
    await typeLong(user);
    expect(expand()!.className).toMatch(/col-start-3/);
    expect(expand()!.className).toMatch(/row-start-3/);
  });

  it("shows Expand only past the cap, and takes it away a row under it (Altan, 2026-11-08)", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    // Five lines are exactly the cap: the field has not started to scroll.
    await user.click(field());
    fireEvent.change(field(), { target: { value: lines(5) } });
    expect(expand()).toBeNull();
    // A sixth line is past it.
    await user.type(field(), "{Enter}six");
    expect(expand()).not.toBeNull();
    // Back to five lines: inside the hysteresis row, it stays.
    await user.type(field(), "{Backspace}{Backspace}{Backspace}{Backspace}");
    expect(field().value.split("\n")).toHaveLength(5);
    expect(expand()).not.toBeNull();
    // Down to three lines, a row and more under the cap: it leaves.
    fireEvent.change(field(), { target: { value: lines(3) } });
    await waitFor(() => expect(expand()).toBeNull());
  });

  it("offers no Expand where there is no pane view to cover", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box" });
    await readyBox();
    await typeLong(user);
    expect(expand()).toBeNull();
  });

  it("opens the same draft with the focus and the caret, and a change there is the composer's draft", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    await typeLong(user, "hello world");
    const draft = lines(8, "hello world");
    field().setSelectionRange(5, 5);
    await user.click(expand()!);
    expect(layerField()).toHaveValue(draft);
    expect(layerField()).toHaveFocus();
    expect(layerField().selectionStart).toBe(5);
    await user.type(layerField(), " there", { initialSelectionStart: draft.length, initialSelectionEnd: draft.length });
    await user.click(screen.getByRole("button", { name: "Collapse" }));
    expect(layer()).toBeNull();
    expect(field()).toHaveValue(`${draft} there`);
    expect(field()).toHaveFocus();
  });

  it("is a full-screen modal with the box's own row: Attach, the mic and Send (Altan, 2026-11-08)", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    await typeLong(user);
    await user.click(expand()!);
    const modal = layer()!;
    // The whole app height from the top of the screen: the header and the tab row are under it.
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(modal.className).toMatch(/\bfixed\b/);
    expect(modal.className).toMatch(/\btop-0\b/);
    expect(modal.className).toMatch(/h-\(--app-h\)/);
    const row = within(modal.querySelector<HTMLElement>('[data-slot="composer-expanded-row"]')!);
    expect(row.getByRole("button", { name: /attach file/i })).toBeInTheDocument();
    expect(row.getByRole("button", { name: /record a voice message/i })).toBeInTheDocument();
    expect(row.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(row.queryByRole("button", { name: "Expand" })).toBeNull();
    // Collapse stands at the top right for either hand.
    expect(within(modal).getByRole("button", { name: "Collapse" }).className).toMatch(/right-2/);
  });

  it("mirrors the row for the left hand, Collapse still at the top right", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", hand: "left", expandArea: area });
    await readyBox();
    await typeLong(user);
    await user.click(expand()!);
    expect(layer()!.querySelector('[data-slot="composer-expanded-row"]')!.className).toMatch(/flex-row-reverse/);
    expect(within(layer()!).getByRole("button", { name: "Collapse" }).className).toMatch(/right-2/);
  });

  it("opens Attach's picker from the editor's row, not under the layer", async () => {
    // A bridge that takes text files too: Attach asks which, through its picker.
    server.use(
      http.get("/api/config", () =>
        HttpResponse.json({
          push: false,
          vapidPublicKey: "",
          stt: { provider: "openai-compatible", available: true },
          upload: { maxBytes: 10 * 1024 * 1024, imageTypes: ["png"], textTypes: ["md"] },
        }),
      ),
    );
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    await waitFor(() => expect(screen.getByTestId("attach-files")).toHaveAttribute("accept", "image/*,.png,.md"));
    await typeLong(user);
    await user.click(expand()!);
    const row = layer()!.querySelector<HTMLElement>('[data-slot="composer-expanded-row"]')!;
    await user.click(within(row).getByRole("button", { name: /attach file/i }));
    const photos = await screen.findByRole("button", { name: /photos/i });
    expect(row.contains(photos)).toBe(true);
    expect(screen.getAllByRole("button", { name: /photos/i })).toHaveLength(1);
  });

  it("closes on Escape and keeps the draft", async () => {
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area });
    await readyBox();
    await typeLong(user, "keep me");
    await user.click(expand()!);
    await user.keyboard("{Escape}");
    expect(layer()).toBeNull();
    expect(field()).toHaveValue(lines(8, "keep me"));
  });

  it("sends from the layer through the composer's own send, and closes", async () => {
    const onSent = vi.fn();
    const user = userEvent.setup();
    renderComposer({ layout: "box", expandArea: area, onSent });
    await readyBox();
    await typeLong(user, "ship it");
    await user.click(expand()!);
    await user.click(within(layer()!).getByRole("button", { name: "Send" }));
    expect(layer()).toBeNull();
    await waitFor(() => expect(onSent).toHaveBeenCalled());
  });

  it("closes on a pane switch", async () => {
    const user = userEvent.setup();
    renderSwitchable();
    await readyBox();
    await typeLong(user);
    await user.click(expand()!);
    expect(layer()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "switch pane" }));
    expect(layer()).toBeNull();
  });
});
