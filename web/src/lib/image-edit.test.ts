import { uploadLimits } from "@/lib/attachments";
import {
  DEFAULT_ANNOTATION_COLOR,
  EDITOR_TOOLS,
  FULL_CROP,
  INITIAL_EDITOR_HISTORY,
  MAX_EXPORT_DIMENSION,
  MIN_CROP_SPAN,
  applyCropDrag,
  canRedoEditor,
  canUndoEditor,
  canvasAvailable,
  clampCropBox,
  commitAnnotation,
  commitCropChange,
  cropCornerHandleBoxes,
  drawAnnotation,
  exportEditedCanvas,
  extensionForMime,
  fileNameForMime,
  hitCropHandle,
  isEditableImage,
  isEditorDirty,
  isFullCrop,
  redoEditor,
  resetEditor,
  sameEditTarget,
  savedImageToFile,
  undoEditor,
} from "@/lib/image-edit";

describe("native canvas editor geometry and history", () => {
  it("exposes the four core editor tools", () => {
    expect(EDITOR_TOOLS).toEqual({
      crop: "crop",
      pen: "pen",
      ellipse: "ellipse",
      arrow: "arrow",
    });
  });

  it("clamps crop boxes to [0, 1] and enforces MIN_CROP_SPAN", () => {
    expect(isFullCrop(FULL_CROP)).toBe(true);
    expect(clampCropBox({ x: -0.5, y: 0.98, width: 0.01, height: 2 })).toEqual({
      x: 0,
      y: 0,
      width: MIN_CROP_SPAN,
      height: 1,
    });
  });

  it("identifies crop corners, edges, interior move, and exterior new drag, including narrow crop boxes", () => {
    const box = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
    expect(hitCropHandle(box, { x: 0.21, y: 0.21 }, 0.05, 0.05)).toBe("nw");
    expect(hitCropHandle(box, { x: 0.69, y: 0.21 }, 0.05, 0.05)).toBe("ne");
    expect(hitCropHandle(box, { x: 0.21, y: 0.69 }, 0.05, 0.05)).toBe("sw");
    expect(hitCropHandle(box, { x: 0.69, y: 0.69 }, 0.05, 0.05)).toBe("se");
    expect(hitCropHandle(box, { x: 0.45, y: 0.21 }, 0.05, 0.05)).toBe("n");
    expect(hitCropHandle(box, { x: 0.45, y: 0.69 }, 0.05, 0.05)).toBe("s");
    expect(hitCropHandle(box, { x: 0.21, y: 0.45 }, 0.05, 0.05)).toBe("w");
    expect(hitCropHandle(box, { x: 0.69, y: 0.45 }, 0.05, 0.05)).toBe("e");
    expect(hitCropHandle(box, { x: 0.45, y: 0.45 }, 0.05, 0.05)).toBe("move");
    expect(hitCropHandle(box, { x: 0.05, y: 0.05 }, 0.05, 0.05)).toBe("new");

    // Narrow crop box (5% wide on a 320x600 canvas, where 22px radiusX = 0.06875 exceeds box width):
    const narrow = { x: 0.2, y: 0.2, width: 0.05, height: 0.4 };
    const rx = 22 / 320;
    const ry = 22 / 600;
    expect(hitCropHandle(narrow, { x: 0.25, y: 0.2 }, rx, ry)).toBe("ne");
    expect(hitCropHandle(narrow, { x: 0.25, y: 0.4 }, rx, ry)).toBe("e");
    expect(hitCropHandle(narrow, { x: 0.225, y: 0.4 }, rx, ry)).toBe("move");

    // Narrow crop box touching the left edge (`x: 0, width: 0.05`) on a 1200x1200 preview bitmap
    // displayed at 320x320 CSS px: the visual center of every drawn corner handle must hit its own
    // corner (`nw`, `ne`, `sw`, `se`), while the top edge midpoint hits `n` and the box center hits `move`.
    const edgeNarrow = { x: 0, y: 0.25, width: 0.05, height: 0.5 };
    const squareRadius = 22 / 320;
    for (const boxHandle of cropCornerHandleBoxes(edgeNarrow, 1200, 1200)) {
      expect(hitCropHandle(edgeNarrow, boxHandle.center, squareRadius, squareRadius)).toBe(
        boxHandle.handle,
      );
    }
    expect(hitCropHandle(edgeNarrow, { x: 0.025, y: 0.25 }, squareRadius, squareRadius)).toBe("n");
    expect(hitCropHandle(edgeNarrow, { x: 0.025, y: 0.5 }, squareRadius, squareRadius)).toBe("move");

    // Minimum 2% span crop boxes at both canvas corners (including extreme 35x1200 tall preview):
    for (const [w, h] of [
      [1200, 1200],
      [35, 1200],
    ] as const) {
      for (const minBox of [
        { x: 0, y: 0, width: MIN_CROP_SPAN, height: MIN_CROP_SPAN },
        { x: 0, y: 0.25, width: MIN_CROP_SPAN, height: 0.5 },
        { x: 1 - MIN_CROP_SPAN, y: 1 - MIN_CROP_SPAN, width: MIN_CROP_SPAN, height: MIN_CROP_SPAN },
      ]) {
        for (const boxHandle of cropCornerHandleBoxes(minBox, w, h)) {
          expect(hitCropHandle(minBox, boxHandle.center, squareRadius, squareRadius)).toBe(
            boxHandle.handle,
          );
        }
        expect(
          hitCropHandle(
            minBox,
            { x: minBox.x + minBox.width / 2, y: minBox.y + minBox.height / 2 },
            squareRadius,
            squareRadius,
          ),
        ).toBe("move");
      }
    }
  });

  it("resizes, moves, and draws new crop boxes within bounds", () => {
    const resized = applyCropDrag("se", FULL_CROP, { x: 1, y: 1 }, { x: 0.6, y: 0.7 });
    expect(resized).toEqual({ x: 0, y: 0, width: 0.6, height: 0.7 });

    const moved = applyCropDrag("move", resized, { x: 0.3, y: 0.3 }, { x: 0.5, y: 0.5 });
    expect(moved.x).toBeCloseTo(0.2, 5);
    expect(moved.y).toBeCloseTo(0.2, 5);
    expect(moved.width).toBeCloseTo(0.6, 5);
    expect(moved.height).toBeCloseTo(0.7, 5);

    const fresh = applyCropDrag("new", FULL_CROP, { x: 0.8, y: 0.8 }, { x: 0.2, y: 0.3 });
    expect(fresh.x).toBeCloseTo(0.2, 5);
    expect(fresh.y).toBeCloseTo(0.3, 5);
    expect(fresh.width).toBeCloseTo(0.6, 5);
    expect(fresh.height).toBeCloseTo(0.5, 5);
  });

  it("tracks undo, redo, and reset across crop and annotation edits", () => {
    let state = INITIAL_EDITOR_HISTORY;
    expect(canUndoEditor(state)).toBe(false);
    expect(canRedoEditor(state)).toBe(false);
    expect(isEditorDirty(state)).toBe(false);

    state = commitCropChange(state, { x: 0.1, y: 0.1, width: 0.8, height: 0.8 });
    expect(canUndoEditor(state)).toBe(true);
    expect(isEditorDirty(state)).toBe(true);

    const pen = {
      kind: "pen" as const,
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.4, y: 0.4 },
      ],
      color: DEFAULT_ANNOTATION_COLOR,
    };
    state = commitAnnotation(state, pen);
    expect(state.annotations).toHaveLength(1);

    const undone = undoEditor(state);
    expect(undone.annotations).toHaveLength(0);
    expect(canRedoEditor(undone)).toBe(true);

    const redone = redoEditor(undone);
    expect(redone.annotations).toHaveLength(1);

    const reset = resetEditor(redone);
    expect(isFullCrop(reset.crop)).toBe(true);
    expect(reset.annotations).toHaveLength(0);
    expect(canUndoEditor(reset)).toBe(true);
  });

  it("draws annotations on a single cropped target canvas and caps oversize exports", () => {
    const drawImage = vi.fn();
    const beginPath = vi.fn();
    const moveTo = vi.fn();
    const lineTo = vi.fn();
    const stroke = vi.fn();
    const ellipse = vi.fn();
    const translate = vi.fn();
    const save = vi.fn();
    const restore = vi.fn();
    const partialCtx: Partial<CanvasRenderingContext2D> = {
      drawImage,
      beginPath,
      moveTo,
      lineTo,
      stroke,
      ellipse,
      translate,
      save,
      restore,
      strokeStyle: "",
      fillStyle: "",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
    };
    // SAFETY: test double implements every 2D context method drawAnnotation and exportEditedCanvas call.
    const fakeCtx = partialCtx as CanvasRenderingContext2D;

    drawAnnotation(
      fakeCtx,
      {
        kind: "ellipse",
        start: { x: 0.1, y: 0.2 },
        end: { x: 0.5, y: 0.6 },
        color: DEFAULT_ANNOTATION_COLOR,
      },
      200,
      100,
    );
    expect(ellipse).toHaveBeenCalledWith(60, 40, 40, 20, 0, 0, Math.PI * 2);

    drawAnnotation(
      fakeCtx,
      {
        kind: "arrow",
        start: { x: 0.1, y: 0.1 },
        end: { x: 0.9, y: 0.5 },
        color: DEFAULT_ANNOTATION_COLOR,
      },
      200,
      100,
    );
    expect(stroke).toHaveBeenCalledTimes(2);

    let allocatedCanvases = 0;
    const img = document.createElement("img");
    const exported = exportEditedCanvas(
      img,
      400,
      200,
      { x: 0.25, y: 0.1, width: 0.5, height: 0.5 },
      [
        {
          kind: "pen",
          points: [
            { x: 0.3, y: 0.3 },
            { x: 0.4, y: 0.4 },
          ],
          color: DEFAULT_ANNOTATION_COLOR,
        },
      ],
      () => {
        allocatedCanvases += 1;
        const c = document.createElement("canvas");
        vi.spyOn(c, "getContext").mockReturnValue(fakeCtx);
        return c;
      },
    );
    expect(allocatedCanvases).toBe(1);
    expect(exported).not.toBeNull();
    expect(exported?.width).toBe(200);
    expect(exported?.height).toBe(100);
    expect(translate).toHaveBeenCalledWith(-100, -20);

    const tallExport = exportEditedCanvas(
      img,
      1000,
      10000,
      FULL_CROP,
      [
        {
          kind: "arrow",
          start: { x: 0.1, y: 0.1 },
          end: { x: 0.5, y: 0.2 },
          color: DEFAULT_ANNOTATION_COLOR,
        },
      ],
      () => {
        const c = document.createElement("canvas");
        vi.spyOn(c, "getContext").mockReturnValue(fakeCtx);
        return c;
      },
    );
    expect(tallExport?.height).toBe(MAX_EXPORT_DIMENSION);
    expect(tallExport?.width).toBe(Math.round(1000 * (MAX_EXPORT_DIMENSION / 10000)));

    // A tall stitched screenshot (1170x20000) cropped to a small slice (1170x400) keeps a normal
    // ~7 px stroke width scaled to its shorter 1170 px axis, matching the 70x1200 preview ratio.
    drawAnnotation(
      fakeCtx,
      {
        kind: "arrow",
        start: { x: 0.2, y: 0.105 },
        end: { x: 0.8, y: 0.115 },
        color: DEFAULT_ANNOTATION_COLOR,
      },
      70,
      1200,
    );
    const previewStrokeWidth = fakeCtx.lineWidth;
    expect(previewStrokeWidth).toBeCloseTo(70 * 0.006, 5);

    exportEditedCanvas(
      img,
      1170,
      20000,
      { x: 0, y: 0.1, width: 1, height: 0.02 },
      [
        {
          kind: "arrow",
          start: { x: 0.2, y: 0.105 },
          end: { x: 0.8, y: 0.115 },
          color: DEFAULT_ANNOTATION_COLOR,
        },
      ],
      () => {
        const c = document.createElement("canvas");
        vi.spyOn(c, "getContext").mockReturnValue(fakeCtx);
        return c;
      },
    );
    expect(fakeCtx.lineWidth).toBeCloseTo(1170 * 0.006, 5);
    expect(fakeCtx.lineWidth / previewStrokeWidth).toBeCloseTo(1170 / 70, 5);
  });
});

describe("savedImageToFile", () => {
  const png = `data:image/png;base64,${btoa("png-bytes")}`;

  it("builds a new File from imageBase64 and does not require imageCanvas", () => {
    const file = savedImageToFile({ imageBase64: png, mimeType: "image/png" }, "shot.png");
    expect(file).not.toBeNull();
    expect(file?.type).toBe("image/png");
    expect(file?.name).toBe("shot.png");
    expect(file?.size).toBe("png-bytes".length);
  });

  it("reads a canvas when imageBase64 is missing", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    vi.spyOn(canvas, "toDataURL").mockReturnValue(png);
    const file = savedImageToFile({ imageCanvas: canvas }, "holiday photo");
    expect(file?.name).toBe("holiday photo.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBeGreaterThan(0);
  });

  it("prefers a present imageBase64 over the canvas", () => {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    vi.spyOn(canvas, "toDataURL").mockImplementation(() => {
      throw new Error("canvas should not be read");
    });
    const file = savedImageToFile({ imageBase64: png, imageCanvas: canvas }, "a.png");
    expect(file?.size).toBeGreaterThan(0);
  });

  it("returns null for a missing payload, an empty body, or a non-image", () => {
    expect(savedImageToFile({}, "a.png")).toBeNull();
    expect(savedImageToFile({ imageBase64: "   " }, "a.png")).toBeNull();
    expect(savedImageToFile({ imageBase64: "data:," }, "a.png")).toBeNull();
    expect(savedImageToFile({ imageBase64: "data:image/png;base64," }, "a.png")).toBeNull();
    expect(savedImageToFile({ imageBase64: "data:text/plain;base64,YQ==" }, "a.png")).toBeNull();
    expect(savedImageToFile({ imageBase64: "not a data url" }, "a.png")).toBeNull();
    const empty = document.createElement("canvas");
    empty.width = 0;
    empty.height = 0;
    expect(savedImageToFile({ imageCanvas: empty }, "a.png")).toBeNull();
  });

  it("returns null when the canvas refuses to encode, and leaves the original File alone", async () => {
    const original = new File([Uint8Array.from([1, 2, 3, 4])], "keep.png", { type: "image/png" });
    const before = Array.from(new Uint8Array(await original.arrayBuffer()));
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    vi.spyOn(canvas, "toDataURL").mockImplementation(() => {
      throw new Error("tainted");
    });
    expect(savedImageToFile({ imageCanvas: canvas }, original.name)).toBeNull();
    expect(Array.from(new Uint8Array(await original.arrayBuffer()))).toEqual(before);
    expect(original.size).toBe(4);
  });

  it("renames a gif stem to the png the canvas actually produced", () => {
    expect(fileNameForMime("clip.gif", "image/png")).toBe("clip.png");
    expect(fileNameForMime("noext", "image/jpeg")).toBe("noext.jpg");
    expect(extensionForMime("image/webp")).toBe("webp");
    expect(extensionForMime("image/svg+xml")).toBeNull();
  });
});

describe("isEditableImage / canvas / target", () => {
  const limits = uploadLimits({ maxBytes: 1024, imageTypes: ["png", "jpg"], textTypes: ["md"] });

  it("accepts a browser image and refuses a text file or an oversize image", () => {
    expect(isEditableImage(new File(["x"], "a.png", { type: "image/png" }), limits)).toBe(true);
    expect(isEditableImage(new File(["#"], "a.md", { type: "text/markdown" }), limits)).toBe(false);
    expect(isEditableImage(new File([new Uint8Array(1025)], "big.png", { type: "image/png" }), limits)).toBe(false);
  });

  it("treats two panes, or two scopes of one pane, as different edit targets", () => {
    const open = { paneId: "w1:p1", scopeId: "lead" };
    expect(sameEditTarget(open, { paneId: "w1:p1", scopeId: "lead" })).toBe(true);
    expect(sameEditTarget(open, { paneId: "w1:p2", scopeId: "lead" })).toBe(false);
    expect(sameEditTarget(open, { paneId: "w1:p1", scopeId: "other" })).toBe(false);
  });

  it("reports a canvas only when getContext returns one", () => {
    const spy = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    expect(canvasAvailable()).toBe(false);
    // SAFETY: canvasAvailable only checks that the return is non-null. Nothing draws with this value.
    spy.mockReturnValue({} as CanvasRenderingContext2D);
    expect(canvasAvailable()).toBe(true);
    spy.mockRestore();
  });
});
