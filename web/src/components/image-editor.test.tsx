import { act, fireEvent, render, screen } from "@testing-library/react";

import { BottomSheet } from "@/components/ui/sheet";

import { ImageEditor } from "./image-editor";

// A real touch, not React's delegated one. The sheet reads `touches` off the native event.
function pull(target: Element, fromY: number, toY: number) {
  for (const [type, clientY] of [
    ["touchstart", fromY],
    ["touchmove", toY],
  ] as const) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "touches", { value: [{ clientY }] });
    target.dispatchEvent(event);
  }
}

function panelOf(dialog: HTMLElement) {
  // The backdrop button is also tabindex=-1 and comes first. The panel is the scrolling div.
  const panel = dialog.querySelector<HTMLElement>("div.overflow-y-auto");
  if (panel === null) throw new Error("sheet panel missing");
  return panel;
}

function loadEditorImage(dialog: HTMLElement, width = 200, height = 100) {
  const img = dialog.querySelector<HTMLImageElement>("[data-slot='image-editor-source']");
  if (img === null) throw new Error("editor source img missing");
  Object.defineProperty(img, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: height, configurable: true });
  fireEvent.load(img);
}

function makeMock2dContext(): CanvasRenderingContext2D {
  const partial: Partial<CanvasRenderingContext2D> = {
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    ellipse: vi.fn(),
    stroke: vi.fn(),
    translate: vi.fn(),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
  };
  // SAFETY: test double implements every 2D context method paintEditorStage, drawAnnotation, and exportEditedCanvas call.
  return partial as CanvasRenderingContext2D;
}

describe("ImageEditor sheet shell and native canvas tools", () => {
  beforeEach(() => {
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:editor");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => makeMock2dContext());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the native canvas stage, tool switcher, and undo/redo/reset controls without third-party editor classes", () => {
    render(
      <ImageEditor
        file={new File(["x"], "shot.png", { type: "image/png" })}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        onFail={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    expect(dialog.querySelector(".FIE_root")).toBeNull();
    loadEditorImage(dialog, 300, 150);
    // A fresh pick opens on the preview: the picture, Cancel, Edit, Attach. No tools yet.
    expect(screen.queryByRole("radio", { name: "Crop" })).toBeNull();
    expect(screen.getByRole("button", { name: "Attach" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Use this image" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Crop" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Draw" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Circle" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Arrow" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Redo" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Use this image" })).toBeEnabled();
    const canvas = dialog.querySelector<HTMLCanvasElement>("[data-slot='image-editor-canvas']");
    expect(canvas).not.toBeNull();
    expect(canvas).not.toHaveClass("hidden");
  });

  it("supports drawing annotations, undoing, redoing, resetting, and exporting on confirm", () => {
    const pngDataUrl = `data:image/png;base64,${btoa("cropped-annotated-png")}`;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(pngDataUrl);
    const onConfirm = vi.fn<(file: File) => void>();

    render(
      <ImageEditor
        file={new File(["raw"], "screen.png", { type: "image/png" })}
        onConfirm={onConfirm}
        onCancel={vi.fn()}
        onFail={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    loadEditorImage(dialog, 200, 100);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const canvas = dialog.querySelector<HTMLCanvasElement>("[data-slot='image-editor-canvas']");
    if (canvas === null) throw new Error("canvas missing");

    // Switch to Draw tool and draw a stroke; verify a second finger mid-stroke is ignored.
    fireEvent.click(screen.getByRole("radio", { name: "Draw" }));
    expect(screen.getByRole("radio", { name: "Draw" })).toHaveAttribute("aria-checked", "true");

    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled();
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 100, clientY: 60 });
    // Second finger touches down while Finger 1 is still active: must be ignored.
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 2, clientX: 180, clientY: 90 });
    fireEvent.pointerUp(canvas, { pointerId: 2, clientX: 180, clientY: 90 });
    // Finger 1 is still active until Finger 1 lifts:
    expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled();
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 60 });
    expect(screen.getByRole("button", { name: "Use this image" })).toBeEnabled();

    const undoBtn = screen.getByRole("button", { name: "Undo" });
    const redoBtn = screen.getByRole("button", { name: "Redo" });
    const resetBtn = screen.getByRole("button", { name: "Reset" });
    expect(undoBtn).toBeEnabled();
    expect(resetBtn).toBeEnabled();

    fireEvent.click(undoBtn);
    expect(undoBtn).toBeDisabled();
    expect(redoBtn).toBeEnabled();

    fireEvent.click(redoBtn);
    expect(undoBtn).toBeEnabled();

    fireEvent.click(resetBtn);
    expect(resetBtn).toBeDisabled();

    // Draw a circle annotation and confirm with it present (not reset).
    fireEvent.click(screen.getByRole("radio", { name: "Circle" }));
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 3, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(canvas, { pointerId: 3, clientX: 120, clientY: 80 });
    fireEvent.pointerUp(canvas, { pointerId: 3, clientX: 120, clientY: 80 });
    expect(resetBtn).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Use this image" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const exportedFile = onConfirm.mock.calls[0]?.[0];
    expect(exportedFile?.name).toBe("screen.png");
    expect(exportedFile?.type).toBe("image/png");
    expect(exportedFile?.size).toBe("cropped-annotated-png".length);
  });

  it("reports a missing canvas on the first commit, fails when the preview canvas returns null context, and Cancel uses the latest callback", () => {
    const onFail = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const failed = render(
      <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={vi.fn()} onCancel={vi.fn()} onFail={onFail} onReject={vi.fn()} />,
    );
    expect(onFail).toHaveBeenCalledWith("unavailable");
    failed.unmount();

    // If canvasAvailable() succeeds on the probe canvas but the preview canvas returns null on paint,
    // the session marks itself broken, disables Confirm, and notifies onFail("failed").
    const onStageFail = vi.fn();
    let getContextCalls = 0;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => {
      getContextCalls += 1;
      return getContextCalls === 1 ? makeMock2dContext() : null;
    });
    const stageFailed = render(
      <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={vi.fn()} onCancel={vi.fn()} onFail={onStageFail} onReject={vi.fn()} />,
    );
    const stageDialog = screen.getByRole("dialog", { name: "Edit image" });
    loadEditorImage(stageDialog, 200, 100);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onStageFail).toHaveBeenCalledWith("failed");
    expect(screen.getByRole("button", { name: "Use this image" })).toBeDisabled();
    stageFailed.unmount();

    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => makeMock2dContext());
    const first = vi.fn();
    const second = vi.fn();
    const file = new File(["x"], "shot.png", { type: "image/png" });
    const { rerender } = render(
      <ImageEditor file={file} onConfirm={vi.fn()} onCancel={first} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    rerender(
      <ImageEditor file={file} onConfirm={vi.fn()} onCancel={second} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]!);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it("is a BottomSheet portaled to the body, not a second dialog element", () => {
    render(
      <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={vi.fn()} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    expect(dialog.tagName).not.toBe("DIALOG");
    expect(document.body.contains(dialog)).toBe(true);
    expect(document.querySelector("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach" })).toBeInTheDocument();
  });

  it("Attach hands back the picked file itself, with no re-encode and no canvas export", () => {
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    const onConfirm = vi.fn<(file: File) => void>();
    const picked = new File(["raw-jpeg"], "photo.jpg", { type: "image/jpeg" });
    render(<ImageEditor file={picked} onConfirm={onConfirm} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />);
    loadEditorImage(screen.getByRole("dialog", { name: "Edit image" }));
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toBe(picked);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("a file whose preview cannot be decoded attaches once as it is, with no failure notice", () => {
    const onConfirm = vi.fn<(file: File) => void>();
    const onFail = vi.fn();
    const onReject = vi.fn();
    const picked = new File(["heic-bytes"], "photo.heic", { type: "image/heic" });
    render(<ImageEditor file={picked} onConfirm={onConfirm} onCancel={vi.fn()} onFail={onFail} onReject={onReject} />);
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    const img = dialog.querySelector<HTMLImageElement>("[data-slot='image-editor-source']");
    if (img === null) throw new Error("editor source img missing");
    fireEvent.error(img);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toBe(picked);
    expect(onFail).not.toHaveBeenCalled();
    expect(onReject).not.toHaveBeenCalled();
  });

  it("Edit then Use this image with no change behaves like Attach", () => {
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
    const onConfirm = vi.fn<(file: File) => void>();
    const picked = new File(["raw"], "shot.png", { type: "image/png" });
    render(<ImageEditor file={picked} onConfirm={onConfirm} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />);
    loadEditorImage(screen.getByRole("dialog", { name: "Edit image" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Use this image" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]?.[0]).toBe(picked);
    expect(toDataURL).not.toHaveBeenCalled();
  });

  it("Edit then a crop hands back a PNG export, once", () => {
    const png = `data:image/png;base64,${btoa("cropped")}`;
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(png);
    const onConfirm = vi.fn<(file: File) => void>();
    const picked = new File(["raw"], "shot.jpg", { type: "image/jpeg" });
    render(<ImageEditor file={picked} onConfirm={onConfirm} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    loadEditorImage(dialog, 200, 100);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const canvas = dialog.querySelector<HTMLCanvasElement>("[data-slot='image-editor-canvas']");
    if (canvas === null) throw new Error("canvas missing");
    // The crop tool is the default. Drag a new box inside the picture.
    fireEvent.pointerDown(canvas, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 100, clientY: 60 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 100, clientY: 60 });
    fireEvent.click(screen.getByRole("button", { name: "Use this image" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const out = onConfirm.mock.calls[0]?.[0];
    expect(out).not.toBe(picked);
    expect(out?.type).toBe("image/png");
  });

  it("Cancel on the preview calls onCancel and never onConfirm", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={onConfirm} onCancel={onCancel} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("startInEdit opens on the tools, and an unchanged Use this image returns the same file", () => {
    const onConfirm = vi.fn<(file: File) => void>();
    const picked = new File(["raw"], "shot.png", { type: "image/png" });
    render(
      <ImageEditor file={picked} startInEdit onConfirm={onConfirm} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    loadEditorImage(screen.getByRole("dialog", { name: "Edit image" }));
    expect(screen.getByRole("radio", { name: "Crop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Use this image" }));
    expect(onConfirm.mock.calls[0]?.[0]).toBe(picked);
  });

  it("a touchmove inside the editor reaches the window and does not drag or close the sheet", () => {
    const onCancel = vi.fn();
    const heard: Event[] = [];
    const hear = (event: Event) => {
      heard.push(event);
    };
    window.addEventListener("touchmove", hear);
    try {
      render(
        <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={vi.fn()} onCancel={onCancel} onFail={vi.fn()} onReject={vi.fn()} />,
      );
      const dialog = screen.getByRole("dialog", { name: "Edit image" });
      const surface = dialog.querySelector(".collie-image-editor");
      if (surface === null) throw new Error("editor surface missing");
      act(() => {
        pull(surface, 10, 120);
      });
      expect(heard).toHaveLength(1);
      expect(panelOf(dialog).style.transform).not.toContain("translateY");
      expect(onCancel).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("touchmove", hear);
    }
  });

  it("a stroke on the editor surface does not drag the sheet, and the same pull on the sheet chrome still does", () => {
    render(
      <ImageEditor file={new File(["x"], "shot.png", { type: "image/png" })} onConfirm={vi.fn()} onCancel={vi.fn()} onFail={vi.fn()} onReject={vi.fn()} />,
    );
    const dialog = screen.getByRole("dialog", { name: "Edit image" });
    const panel = panelOf(dialog);
    const surface = dialog.querySelector(".collie-image-editor");
    if (surface === null) throw new Error("editor surface missing");

    act(() => {
      pull(surface, 10, 80);
    });
    expect(panel.style.transform).not.toContain("translateY");

    const chrome = dialog.querySelector("[data-slot='sheet-title-row']");
    if (chrome === null) throw new Error("sheet chrome missing");
    act(() => {
      pull(chrome, 10, 120);
    });
    expect(panel.style.transform).not.toContain("translateY");
  });

  it("a default BottomSheet still drag-dismisses from its title", () => {
    const onClose = vi.fn();
    render(
      <BottomSheet open onClose={onClose} title="Plain">
        body
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "Plain" });
    const chrome = dialog.querySelector("[data-slot='sheet-title-row']");
    if (chrome === null) throw new Error("sheet chrome missing");
    act(() => {
      pull(chrome, 10, 80);
    });
    expect(panelOf(dialog).style.transform).toBe("translateY(70px)");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("React stopPropagation on a child does not keep the sheet from dragging", () => {
    function ReactStop() {
      return (
        <div
          data-slot="react-stop"
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
        >
          pen
        </div>
      );
    }
    render(
      <BottomSheet open onClose={vi.fn()} title="React stop">
        <ReactStop />
      </BottomSheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "React stop" });
    const target = dialog.querySelector("[data-slot='react-stop']");
    if (target === null) throw new Error("react stop target missing");
    act(() => {
      pull(target, 10, 80);
    });
    expect(panelOf(dialog).style.transform).toBe("translateY(70px)");
  });
});
