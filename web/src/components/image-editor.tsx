import { useEffect, useId, useReducer, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PointerEvent as ReactPointerEvent, SyntheticEvent } from "react";

import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t as translate } from "@/lib/i18n";
import {
  DEFAULT_ANNOTATION_COLOR,
  EDITOR_TOOLS,
  INITIAL_EDITOR_HISTORY,
  applyCropDrag,
  canRedoEditor,
  canUndoEditor,
  canvasAvailable,
  clampUnit,
  commitAnnotation,
  commitCropChange,
  cropCornerHandleBoxes,
  drawAnnotation,
  exportEditedCanvas,
  hitCropHandle,
  isEditorDirty,
  redoEditor,
  resetEditor,
  savedImageToFile,
  undoEditor,
  type CropBox,
  type CropHandle,
  type EditorAnnotation,
  type EditorHistory,
  type EditorTool,
  type NormalizedPoint,
} from "@/lib/image-edit";

// Portaled to `document.body` because the composer sits in a sticky, transformed footer, and a
// BottomSheet mounted there would be trapped by that transform (the same reason the pane menu is
// not mounted inside the composer). BottomSheet is the floating layer. Drag-to-dismiss is off for
// this caller so a finger stroke on the canvas never drags the sheet down.

const MAX_PREVIEW_DIMENSION = 1200;

export interface ImageEditorProps {
  file: File;
  /** Open on the tools, for an image already attached (the chip's Edit). A fresh pick opens on the
   *  plain preview, where Attach is the one-tap answer. */
  startInEdit?: boolean;
  /** Called with the ORIGINAL `file` (same object, no re-encode) from Attach, and from "Use this
   *  image" when nothing was changed. Called with a new PNG only when a crop or a mark was made. */
  onConfirm: (file: File) => void;
  onCancel: () => void;
  /** The editor cannot run. The parent must not upload. */
  onFail: (reason: "unavailable" | "failed") => void;
  /** A save produced nothing uploadable. The dialog stays so the operator can cancel. */
  onReject: () => void;
}

interface LoadedImageInfo {
  element: HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
}

type ActiveGesture =
  | {
      kind: "crop";
      pointerId: number;
      handle: CropHandle;
      startCrop: CropBox;
      startPt: NormalizedPoint;
      draftCrop: CropBox;
    }
  | {
      kind: "annotation";
      pointerId: number;
      draft: EditorAnnotation;
    };

interface EditorSessionState {
  loadedImage: LoadedImageInfo | null;
  broken: boolean;
  tool: EditorTool;
  history: EditorHistory;
  gesture: ActiveGesture | null;
}

type EditorSessionAction =
  | { type: "imageLoaded"; image: LoadedImageInfo }
  | { type: "imageFailed" }
  | { type: "selectTool"; tool: EditorTool }
  | { type: "pointerDown"; pointerId: number; pt: NormalizedPoint; radiusX: number; radiusY: number }
  | { type: "pointerMove"; pointerId: number; pt: NormalizedPoint }
  | { type: "pointerUp"; pointerId: number; pt: NormalizedPoint }
  | { type: "pointerCancel"; pointerId?: number }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

const INITIAL_SESSION_STATE: EditorSessionState = {
  loadedImage: null,
  broken: false,
  tool: EDITOR_TOOLS.crop,
  history: INITIAL_EDITOR_HISTORY,
  gesture: null,
};

function updateGestureOnPoint(gesture: ActiveGesture, pt: NormalizedPoint): ActiveGesture {
  if (gesture.kind === "crop") {
    return {
      ...gesture,
      draftCrop: applyCropDrag(gesture.handle, gesture.startCrop, gesture.startPt, pt),
    };
  }
  if (gesture.draft.kind === "pen") {
    return {
      ...gesture,
      draft: {
        ...gesture.draft,
        points: [...gesture.draft.points, pt],
      },
    };
  }
  return {
    ...gesture,
    draft: {
      ...gesture.draft,
      end: pt,
    },
  };
}

function editorSessionReducer(state: EditorSessionState, action: EditorSessionAction): EditorSessionState {
  switch (action.type) {
    case "imageLoaded":
      return {
        ...state,
        loadedImage: action.image,
        broken: false,
      };
    case "imageFailed":
      return {
        ...state,
        broken: true,
        gesture: null,
      };
    case "selectTool":
      return {
        ...state,
        tool: action.tool,
        gesture: null,
      };
    case "pointerDown": {
      if (state.gesture !== null) return state;
      if (state.tool === EDITOR_TOOLS.crop) {
        const handle = hitCropHandle(state.history.crop, action.pt, action.radiusX, action.radiusY);
        const initialDraft =
          handle === "new"
            ? applyCropDrag("new", state.history.crop, action.pt, action.pt)
            : state.history.crop;
        return {
          ...state,
          gesture: {
            kind: "crop",
            pointerId: action.pointerId,
            handle,
            startCrop: state.history.crop,
            startPt: action.pt,
            draftCrop: initialDraft,
          },
        };
      }
      const draft: EditorAnnotation =
        state.tool === EDITOR_TOOLS.pen
          ? { kind: "pen", points: [action.pt], color: DEFAULT_ANNOTATION_COLOR }
          : {
              kind: state.tool === EDITOR_TOOLS.ellipse ? "ellipse" : "arrow",
              start: action.pt,
              end: action.pt,
              color: DEFAULT_ANNOTATION_COLOR,
            };
      return {
        ...state,
        gesture: {
          kind: "annotation",
          pointerId: action.pointerId,
          draft,
        },
      };
    }
    case "pointerMove": {
      if (state.gesture === null || state.gesture.pointerId !== action.pointerId) return state;
      return {
        ...state,
        gesture: updateGestureOnPoint(state.gesture, action.pt),
      };
    }
    case "pointerUp": {
      if (state.gesture === null || state.gesture.pointerId !== action.pointerId) return state;
      const finalGesture = updateGestureOnPoint(state.gesture, action.pt);
      const nextHistory =
        finalGesture.kind === "crop"
          ? commitCropChange(state.history, finalGesture.draftCrop)
          : commitAnnotation(state.history, finalGesture.draft);
      return {
        ...state,
        history: nextHistory,
        gesture: null,
      };
    }
    case "pointerCancel": {
      if (state.gesture === null) return state;
      if (action.pointerId !== undefined && state.gesture.pointerId !== action.pointerId) return state;
      return {
        ...state,
        gesture: null,
      };
    }
    case "undo":
      return {
        ...state,
        history: undoEditor(state.history),
        gesture: null,
      };
    case "redo":
      return {
        ...state,
        history: redoEditor(state.history),
        gesture: null,
      };
    case "reset":
      return {
        ...state,
        history: resetEditor(state.history),
        gesture: null,
      };
  }
}

function pointOnCanvas(canvas: HTMLCanvasElement, clientX: number, clientY: number): NormalizedPoint {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : canvas.width > 0 ? canvas.width : 1;
  const height = rect.height > 0 ? rect.height : canvas.height > 0 ? canvas.height : 1;
  return {
    x: clampUnit((clientX - rect.left) / width),
    y: clampUnit((clientY - rect.top) / height),
  };
}

interface HandleRadii {
  radiusX: number;
  radiusY: number;
}

function handleRadiiOnCanvas(canvas: HTMLCanvasElement): HandleRadii {
  const rect = canvas.getBoundingClientRect();
  const width = rect.width > 0 ? rect.width : canvas.width > 0 ? canvas.width : 200;
  const height = rect.height > 0 ? rect.height : canvas.height > 0 ? canvas.height : 200;
  // 22 CSS px around each corner/edge handle gives comfortable 44 px touch targets on mobile.
  return {
    radiusX: Math.max(0.04, Math.min(0.15, 22 / width)),
    radiusY: Math.max(0.04, Math.min(0.15, 22 / height)),
  };
}

function paintEditorStage(
  canvas: HTMLCanvasElement,
  loadedImage: LoadedImageInfo,
  crop: CropBox,
  annotations: readonly EditorAnnotation[],
  showHandles: boolean,
): boolean {
  const scale = Math.min(
    1,
    MAX_PREVIEW_DIMENSION / Math.max(1, loadedImage.naturalWidth, loadedImage.naturalHeight),
  );
  const targetW = Math.max(1, Math.round(loadedImage.naturalWidth * scale));
  const targetH = Math.max(1, Math.round(loadedImage.naturalHeight * scale));
  if (canvas.width !== targetW) canvas.width = targetW;
  if (canvas.height !== targetH) canvas.height = targetH;

  const ctx = canvas.getContext("2d");
  if (ctx === null || !("drawImage" in ctx)) return false;

  ctx.clearRect?.(0, 0, targetW, targetH);
  ctx.drawImage(loadedImage.element, 0, 0, targetW, targetH);

  for (const ann of annotations) {
    drawAnnotation(ctx, ann, targetW, targetH);
  }

  const cx = Math.round(crop.x * targetW);
  const cy = Math.round(crop.y * targetH);
  const cw = Math.round(crop.width * targetW);
  const ch = Math.round(crop.height * targetH);

  ctx.save?.();
  ctx.fillStyle = "rgba(0, 0, 0, 0.48)";
  if (cy > 0) ctx.fillRect?.(0, 0, targetW, cy);
  if (cy + ch < targetH) ctx.fillRect?.(0, cy + ch, targetW, targetH - (cy + ch));
  if (cx > 0) ctx.fillRect?.(0, cy, cx, ch);
  if (cx + cw < targetW) ctx.fillRect?.(cx + cw, cy, targetW - (cx + cw), ch);

  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = Math.max(2, Math.round(Math.min(targetW, targetH) * 0.004));
  ctx.strokeRect?.(cx, cy, cw, ch);

  if (showHandles) {
    const handles = cropCornerHandleBoxes(crop, targetW, targetH);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#0a0a0a";
    ctx.lineWidth = 1.5;
    for (const box of handles) {
      ctx.fillRect?.(box.x, box.y, box.size, box.size);
      ctx.strokeRect?.(box.x, box.y, box.size, box.size);
    }
  }
  ctx.restore?.();
  return true;
}

export function ImageEditor({ file, startInEdit = false, onConfirm, onCancel, onFail, onReject }: ImageEditorProps) {
  useLocale();
  const titleId = useId();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onFailRef = useRef(onFail);
  const onRejectRef = useRef(onReject);
  const onCancelRef = useRef(onCancel);
  // Seeded by useRef for the first commit. Later callback identities land here, before the
  // effects below read them, and not during render.
  useEffect(() => {
    onFailRef.current = onFail;
    onRejectRef.current = onReject;
    onCancelRef.current = onCancel;
  }, [onFail, onReject, onCancel]);

  const [url, setUrl] = useState<string | null>(null);
  // "preview": the picture and Attach. "edit": the tools. A fresh pick starts on the preview.
  const [mode, setMode] = useState<"preview" | "edit">(startInEdit ? "edit" : "preview");
  const [session, dispatch] = useReducer(editorSessionReducer, INITIAL_SESSION_STATE);

  useEffect(() => {
    if (!canvasAvailable()) {
      onFailRef.current("unavailable");
      return;
    }
    let objectUrl: string;
    try {
      objectUrl = URL.createObjectURL(file);
    } catch {
      onFailRef.current("failed");
      return;
    }
    setUrl(objectUrl);
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (mode !== "edit" || canvas === null || session.loadedImage === null || session.broken) return;
    const activeCrop =
      session.gesture?.kind === "crop" ? session.gesture.draftCrop : session.history.crop;
    const activeAnnotations =
      session.gesture?.kind === "annotation"
        ? [...session.history.annotations, session.gesture.draft]
        : session.history.annotations;
    try {
      const painted = paintEditorStage(
        canvas,
        session.loadedImage,
        activeCrop,
        activeAnnotations,
        session.tool === EDITOR_TOOLS.crop,
      );
      if (!painted) {
        dispatch({ type: "imageFailed" });
        onFailRef.current("failed");
      }
    } catch {
      dispatch({ type: "imageFailed" });
      onFailRef.current("failed");
    }
  }, [
    mode,
    session.loadedImage,
    session.broken,
    session.tool,
    session.history.crop,
    session.history.annotations,
    session.gesture,
  ]);

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const el = event.currentTarget;
    const naturalWidth = el.naturalWidth > 0 ? el.naturalWidth : el.width > 0 ? el.width : 300;
    const naturalHeight = el.naturalHeight > 0 ? el.naturalHeight : el.height > 0 ? el.height : 200;
    dispatch({
      type: "imageLoaded",
      image: { element: el, naturalWidth, naturalHeight },
    });
  }

  function handleImageError() {
    // On the preview nothing was edited, so a picture the browser cannot decode still attaches as it
    // is, the way it did before the editor. The failure text is for the tools only.
    if (mode === "preview") {
      onConfirm(file);
      return;
    }
    dispatch({ type: "imageFailed" });
    onFailRef.current("failed");
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (
      event.button !== 0 ||
      session.loadedImage === null ||
      session.broken ||
      session.gesture !== null
    ) {
      return;
    }
    const canvas = event.currentTarget;
    try {
      canvas.setPointerCapture?.(event.pointerId);
    } catch {
      // Synthetic pointer events in jsdom or non-active pointers need no capture.
    }
    const pt = pointOnCanvas(canvas, event.clientX, event.clientY);
    const { radiusX, radiusY } = handleRadiiOnCanvas(canvas);
    dispatch({
      type: "pointerDown",
      pointerId: event.pointerId,
      pt,
      radiusX,
      radiusY,
    });
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (session.gesture === null || session.gesture.pointerId !== event.pointerId) return;
    const pt = pointOnCanvas(event.currentTarget, event.clientX, event.clientY);
    dispatch({ type: "pointerMove", pointerId: event.pointerId, pt });
  }

  function handlePointerUp(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (session.gesture === null || session.gesture.pointerId !== event.pointerId) return;
    const pt = pointOnCanvas(event.currentTarget, event.clientX, event.clientY);
    dispatch({ type: "pointerUp", pointerId: event.pointerId, pt });
  }

  function handlePointerCancel(event: ReactPointerEvent<HTMLCanvasElement>) {
    dispatch({ type: "pointerCancel", pointerId: event.pointerId });
  }

  // Attach, and "Use this image" with nothing changed: the picked bytes go on exactly as they are.
  function useOriginal() {
    onConfirm(file);
  }

  function confirm() {
    if (session.loadedImage === null || session.broken) {
      onRejectRef.current();
      return;
    }
    if (!isEditorDirty(session.history)) {
      useOriginal();
      return;
    }
    try {
      const exported = exportEditedCanvas(
        session.loadedImage.element,
        session.loadedImage.naturalWidth,
        session.loadedImage.naturalHeight,
        session.history.crop,
        session.history.annotations,
      );
      if (exported === null) {
        onRejectRef.current();
        return;
      }
      const next = savedImageToFile({ imageCanvas: exported }, file.name);
      if (next === null || next.size === 0) {
        onRejectRef.current();
        return;
      }
      onConfirm(next);
    } catch {
      onRejectRef.current();
    }
  }

  const toolOptions = [
    { value: EDITOR_TOOLS.crop, label: translate("composer.imageEdit.crop") },
    { value: EDITOR_TOOLS.pen, label: translate("composer.imageEdit.pen") },
    { value: EDITOR_TOOLS.ellipse, label: translate("composer.imageEdit.ellipse") },
    { value: EDITOR_TOOLS.arrow, label: translate("composer.imageEdit.arrow") },
  ] as const;

  const stageReady = session.loadedImage !== null && url !== null && !session.broken;
  const canConfirm = stageReady && session.gesture === null;
  const editing = mode === "edit";

  const sheet = (
    <BottomSheet
      open
      dragToDismiss={false}
      onClose={() => onCancelRef.current()}
      title={translate("composer.imageEdit.title")}
      className="max-h-[92dvh]"
    >
      <div className="collie-image-editor flex flex-col gap-3">
        <h2 id={titleId} className="sr-only">
          {translate("composer.imageEdit.title")}
        </h2>
        {editing && (
          <div className="image-editor-toolbar flex flex-col gap-2">
            <Segmented
              label={translate("composer.imageEdit.title")}
              options={toolOptions}
              value={session.tool}
              onChange={(nextTool) => dispatch({ type: "selectTool", tool: nextTool })}
              tight
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canUndoEditor(session.history)}
                onClick={() => dispatch({ type: "undo" })}
              >
                {translate("composer.imageEdit.undo")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!canRedoEditor(session.history)}
                onClick={() => dispatch({ type: "redo" })}
              >
                {translate("composer.imageEdit.redo")}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!isEditorDirty(session.history)}
                onClick={() => dispatch({ type: "reset" })}
              >
                {translate("composer.imageEdit.reset")}
              </Button>
            </div>
          </div>
        )}
        <div className="image-editor-stage relative flex min-h-48 max-h-[56dvh] flex-1 items-center justify-center overflow-hidden rounded-sm border border-border bg-muted/40">
          {url !== null && (
            <img
              src={url}
              alt={file.name}
              hidden={editing || !stageReady}
              className="block max-h-[54dvh] max-w-full object-contain"
              data-slot="image-editor-source"
              onLoad={handleImageLoad}
              onError={handleImageError}
            />
          )}
          {!stageReady && (
            <p className="py-6 text-sm text-muted-foreground">{translate("composer.imageEdit.loading")}</p>
          )}
          <canvas
            ref={canvasRef}
            data-slot="image-editor-canvas"
            aria-label={translate("composer.imageEdit.title")}
            className={
              stageReady && editing
                ? "block max-h-[54dvh] max-w-full cursor-crosshair touch-none select-none"
                : "hidden"
            }
            style={{
              touchAction: "none",
              WebkitUserSelect: "none",
              userSelect: "none",
            }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerCancel={handlePointerCancel}
            onLostPointerCapture={handlePointerCancel}
          />
        </div>
        <div className="image-editor-actions flex shrink-0 gap-2">
          <Button
            type="button"
            variant="outline"
            size="lg"
            className="min-h-11 flex-1"
            onClick={() => onCancelRef.current()}
          >
            {translate("composer.imageEdit.cancel")}
          </Button>
          {editing ? (
            <Button
              type="button"
              size="lg"
              className="min-h-11 flex-1"
              disabled={!canConfirm}
              onClick={confirm}
            >
              {translate("composer.imageEdit.confirm")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="outline"
                size="lg"
                className="min-h-11 flex-1"
                disabled={!stageReady}
                onClick={() => setMode("edit")}
              >
                {translate("composer.imageEdit.edit")}
              </Button>
              <Button
                type="button"
                size="lg"
                className="min-h-11 flex-1"
                disabled={url === null}
                onClick={useOriginal}
              >
                {translate("composer.imageEdit.attach")}
              </Button>
            </>
          )}
        </div>
      </div>
    </BottomSheet>
  );

  return createPortal(sheet, document.body);
}
