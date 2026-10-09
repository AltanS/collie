import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  ClipboardPaste,
  Copy,
  Pencil,
  Plus,
  RotateCcw,
  Rows3,
  X,
} from "lucide-react";

import { ChordBuilder } from "@/components/chord-builder";
import { Button } from "@/components/ui/button";
import { OneOf } from "@/components/ui/one-of";
import { SectionLabel } from "@/components/ui/section-label";
import { BottomSheet, TALL_SHEET_CLEARANCE } from "@/components/ui/sheet";
import { shieldFromSheetPull, useBoardDrag } from "@/hooks/use-board-drag";
import { useLocale } from "@/hooks/use-locale";
import { t, tn } from "@/lib/i18n";
import {
  addRow,
  areaCss,
  BOARD_COLS,
  canRemoveRow,
  clampAnchor,
  decodeBoard,
  DEFAULT_BOARD,
  dropKey,
  encodeBoard,
  keyCount,
  keyLabel,
  MAX_H,
  MAX_ROWS,
  MAX_W,
  missingCore,
  owners,
  PRESETS,
  putBackCore,
  removeRow,
  resizeKey,
  sameBoard,
  setCell,
  spanOf,
  stepKey,
  stepsWords,
  withSize,
  type BoardKey,
  type BoardPreset,
  type DecodeRefusal,
  type KeyBoard,
} from "@/lib/key-board";
import { setKeyBoard, useKeyBoard } from "@/lib/key-board-store";
import { cn } from "@/lib/utils";

// The key board editor (M48 spec 03, ADR 0092): a tall sheet over the pane, opened by the pencil in
// the Keys dock. The whole pad is editable. Everything saves at once, so the dock behind the scrim is
// already showing the change; the only gate is the confirm screen, and it stands in front of the
// things that REPLACE the whole layout (a preset, an import, Restore default).
//
// NOTHING MOVES WHILE YOU EDIT (DESIGN.md §2). The toolbar under the board reserves its height with
// no key selected, the quiet line about a missing core key reserves its line, and a status line sits
// under each field. A tap, a drag or a typed code changes words and paint, never the size of a box.

/** What a key says to a screen reader: its chords in words, or the modifier's name. */
function wordsOf(key: BoardKey): string {
  if (key.kind === "mod") return key.mod === "shift" ? "Shift" : key.mod === "ctrl" ? "Ctrl" : "Alt";
  return stepsWords(key.steps, t("keys.pad.then"));
}

const keyOnBoard =
  "h-full min-h-0 w-full min-w-0 touch-none cursor-grab overflow-hidden px-0 text-xs font-medium active:cursor-grabbing";

interface Pending {
  readonly title: string;
  readonly board: KeyBoard;
}

type Builder = { readonly cell: number; readonly key: BoardKey | null };

export function KeyBoardEditor({
  open,
  onClose,
  unsupportedKeys,
}: {
  open: boolean;
  onClose: () => void;
  /** The chords this multiplexer refuses, so the builder greys them as the pad does. */
  unsupportedKeys: readonly string[];
}) {
  useLocale();
  const board = useKeyBoard();
  const [selected, setSelected] = useState<number | null>(null);
  const [builder, setBuilder] = useState<Builder | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const selectedKey = selected === null ? null : (board.cells[selected] ?? null);

  /** One quiet sentence under the board: why a size or a drop was refused. Cleared by the next action. */
  const [note, setNote] = useState<string | null>(null);
  const choose = (cell: number | null) => {
    setSelected(cell);
    setNote(null);
  };

  const inTheWay = (r: { readonly reason: "edge" } | { readonly reason: "blocked"; readonly by: number }): string => {
    const blocker = r.reason === "blocked" ? (board.cells[r.by] ?? null) : null;
    return blocker === null ? t("keys.editor.noRoom") : t("keys.editor.inTheWay", { key: keyLabel(blocker) });
  };

  const drag = useBoardDrag({
    onDrop: (from, to) => {
      const res = dropKey(board, from, to);
      if (res.kind === "move" || res.kind === "swap") {
        setKeyBoard(res.board);
        // The selection follows the key that was picked up, and the key it displaced if it was selected.
        setSelected((s) => (s === from ? res.at : res.kind === "swap" && s === res.at ? from : s));
        setNote(null);
      } else if (res.kind === "refused") {
        setNote(inTheWay(res));
      }
    },
    anchorFor: (from, col, row) => {
      const key = board.cells[from] ?? null;
      const { w, h } = key === null ? { w: 1, h: 1 } : spanOf(key);
      return clampAnchor(board, col, row, w, h);
    },
  });

  const step = (dc: number, dr: number) => {
    if (selected === null) return;
    const res = stepKey(board, selected, dc, dr);
    if (res.kind !== "move" && res.kind !== "swap") return;
    setKeyBoard(res.board);
    setSelected(res.at);
    setNote(null);
  };
  const canStep = (dc: number, dr: number) => {
    if (selected === null || selectedKey === null) return false;
    const res = stepKey(board, selected, dc, dr);
    return res.kind === "move" || res.kind === "swap";
  };

  const size = selectedKey === null ? null : spanOf(selectedKey);
  const resize = (w: number, h: number) => {
    if (selected === null) return;
    const res = resizeKey(board, selected, w, h);
    if (res.ok) {
      setKeyBoard(res.board);
      setNote(null);
    } else {
      setNote(inTheWay(res));
    }
  };

  const missing = missingCore(board);
  const lift = drag.lift;
  const held = lift === null ? null : (board.cells[lift.from] ?? null);
  // While a key is lifted: what letting go here would do. A refused drop says so on the outline and
  // on the status line, and the key goes back.
  const dropping = lift === null || lift.over === null ? null : dropKey(board, lift.from, lift.over);
  const own = owners(board);

  // Escape closes the TOP sheet only. Every open sheet listens on window, so the editor must not
  // close along with the builder or the confirm screen stacked over it.
  const guardedClose = () => {
    if (builder !== null || pending !== null) return;
    onClose();
  };

  const saveKey = (key: BoardKey) => {
    if (builder === null) return;
    // A key that is changed keeps its size; a new one is one cell.
    const old = board.cells[builder.cell] ?? null;
    const sized = old === null ? key : withSize(key, spanOf(old).w, spanOf(old).h);
    setKeyBoard(setCell(board, builder.cell, sized));
    choose(builder.cell);
    setBuilder(null);
  };

  const apply = () => {
    if (pending === null) return;
    setKeyBoard(pending.board);
    setSelected(null);
    setPending(null);
  };

  const arrow = (label: string, dc: number, dr: number, icon: ReactNode) => (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="size-11"
      aria-label={label}
      disabled={!canStep(dc, dr)}
      onClick={() => step(dc, dr)}
    >
      {icon}
    </Button>
  );

  // One size choice. Not `disabled` when it is only blocked: it stays tappable so the status line can
  // say what is in the way. Without a selected key there is nothing to size and it is inert.
  const sizeButton = (axis: "w" | "h", n: number) => {
    const current = size === null ? null : size[axis];
    const target = size === null ? null : axis === "w" ? { w: n, h: size.h } : { w: size.w, h: n };
    const fits = selected === null || target === null ? false : resizeKey(board, selected, target.w, target.h).ok;
    return (
      <Button
        key={`${axis}${n}`}
        type="button"
        variant="outline"
        size="icon"
        className={cn(
          "relative size-10 shrink-0 before:absolute before:-inset-0.5 before:content-['']",
          current === n && "border-primary bg-primary/10 ring-1 ring-inset ring-primary",
          selected !== null && !fits && current !== n && "opacity-50",
        )}
        aria-label={t(axis === "w" ? "keys.editor.widthAria" : "keys.editor.heightAria", { n })}
        aria-pressed={current === n}
        aria-disabled={selected !== null && !fits && current !== n ? true : undefined}
        disabled={selected === null}
        onClick={() => target !== null && current !== n && resize(target.w, target.h)}
      >
        {n}
      </Button>
    );
  };

  return (
    <>
      <BottomSheet open={open} onClose={guardedClose} title={t("keys.editor.title")} className={cn("h-[85dvh] max-h-[85dvh]", TALL_SHEET_CLEARANCE)}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">{t("keys.editor.intro")}</p>

          <div className="rounded-sm border border-border bg-muted/30 p-2">
            <div ref={drag.boxRef} className="relative" role="group" aria-label={t("keys.editor.boardAria")}>
              <div className="relative grid auto-rows-[44px] grid-cols-7 gap-1">
                {/* One slot per cell. They are what the pointer is tested against, and a free one is a
                    "+". A cell another key covers is a slot with nothing in it. */}
                {board.cells.map((_, i) => {
                  const row = Math.floor(i / BOARD_COLS) + 1;
                  const col = (i % BOARD_COLS) + 1;
                  return (
                    <div key={i} data-cell={i} style={{ gridColumn: col, gridRow: row }} className="relative rounded-sm">
                      {own[i] === -1 && (
                        <button
                          type="button"
                          aria-label={t("keys.editor.emptyAria", { row, col })}
                          onClick={() => setBuilder({ cell: i, key: null })}
                          className="grid h-full w-full place-items-center rounded-sm border border-dashed border-border/70 text-muted-foreground/60 hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                        >
                          <Plus className="size-3.5" aria-hidden="true" />
                        </button>
                      )}
                    </div>
                  );
                })}
                {/* The keys, each placed by its anchor and spanning its width and height. Lifting one
                    leaves a dashed placeholder over the same area, so nothing around it shifts. */}
                {board.cells.map((key, i) => {
                  if (key === null) return null;
                  const row = Math.floor(i / BOARD_COLS) + 1;
                  const col = (i % BOARD_COLS) + 1;
                  return (
                    <div key={`key-${i}`} style={areaCss(i, key)} className="relative rounded-sm">
                      <Button
                        ref={shieldFromSheetPull}
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-pressed={selected === i}
                        aria-label={t("keys.editor.keyAria", { key: wordsOf(key), row, col })}
                        onPointerDown={(e) => drag.begin(e, i)}
                        onContextMenu={(e) => e.preventDefault()}
                        onClick={() => {
                          if (drag.justDragged()) return;
                          choose(selected === i ? null : i);
                        }}
                        className={cn(
                          keyOnBoard,
                          selected === i && "border-primary bg-primary/10 ring-1 ring-inset ring-primary",
                          lift?.from === i && "border-dashed border-primary/60 bg-primary/5 text-transparent shadow-none hover:bg-primary/5",
                        )}
                      >
                        <span className="truncate">{keyLabel(key)}</span>
                      </Button>
                    </div>
                  );
                })}
                {/* Where the key would land. Solid when the drop works, dashed and grey when it is refused. */}
                {lift !== null && lift.over !== null && held !== null && dropping !== null && (
                  <div
                    aria-hidden="true"
                    data-slot="drop-outline"
                    data-drop={dropping.kind === "refused" ? "refused" : "ok"}
                    style={areaCss(dropping.kind === "swap" || dropping.kind === "move" ? dropping.at : lift.over, held)}
                    className={cn(
                      "pointer-events-none z-10 rounded-sm border-2",
                      dropping.kind === "refused" ? "border-dashed border-muted-foreground bg-muted/40" : "border-primary bg-primary/10",
                    )}
                  />
                )}
              </div>
              {lift !== null && (
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute z-20 grid place-items-center rounded-sm border border-primary bg-card text-xs font-medium shadow-lg ring-2 ring-primary"
                  style={{ left: lift.ghost.x, top: lift.ghost.y, width: lift.ghost.w, height: lift.ghost.h }}
                >
                  {held === null ? "" : keyLabel(held)}
                </div>
              )}
            </div>
          </div>

          {/* The selected key's toolbar. Its height is fixed and always reserved: selecting a key, or
              none, moves nothing, and the controls go inert instead of leaving. */}
          <div data-slot="key-toolbar" className="flex h-[202px] flex-col gap-2 rounded-sm border border-border bg-card p-3">
            <p
              data-slot="key-status"
              aria-live="polite"
              className={cn("h-5 truncate text-sm", dropping?.kind === "refused" || note !== null ? "text-foreground" : selectedKey === null && "text-muted-foreground")}
            >
              {dropping?.kind === "refused"
                ? inTheWay(dropping)
                : note !== null
                  ? note
                  : selectedKey === null
                    ? t("keys.editor.hint")
                    : selectedKey.kind === "mod"
                      ? t("keys.editor.selectedMod", { label: keyLabel(selectedKey) })
                      : t("keys.editor.selected", { label: keyLabel(selectedKey), keys: wordsOf(selectedKey) })}
            </p>
            <div className="flex h-11 items-center gap-2">
              {arrow(t("keys.editor.moveLeft"), -1, 0, <ArrowLeft className="size-5" aria-hidden="true" />)}
              {arrow(t("keys.editor.moveRight"), 1, 0, <ArrowRight className="size-5" aria-hidden="true" />)}
              {arrow(t("keys.editor.moveUp"), 0, -1, <ArrowUp className="size-5" aria-hidden="true" />)}
              {arrow(t("keys.editor.moveDown"), 0, 1, <ArrowDown className="size-5" aria-hidden="true" />)}
              <span className="min-w-0 truncate text-xs text-muted-foreground">{t("keys.editor.swapsIfFull")}</span>
            </div>
            <div className="flex h-11 items-center gap-1" role="group" aria-label={t("keys.editor.sizeAria")}>
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{t("keys.editor.width")}</span>
              {Array.from({ length: MAX_W }, (_, n) => sizeButton("w", n + 1))}
              <span className="ml-2 min-w-0 shrink truncate text-xs text-muted-foreground">{t("keys.editor.height")}</span>
              {Array.from({ length: MAX_H }, (_, n) => sizeButton("h", n + 1))}
            </div>
            <div className="flex h-11 gap-2">
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 gap-2"
                disabled={selectedKey === null}
                onClick={() => selected !== null && selectedKey !== null && setBuilder({ cell: selected, key: selectedKey })}
              >
                <Pencil className="size-4" aria-hidden="true" />
                {t("keys.editor.change")}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 flex-1 gap-2"
                disabled={selectedKey === null}
                onClick={() => {
                  if (selected === null) return;
                  setKeyBoard(setCell(board, selected, null));
                  choose(null);
                }}
              >
                <X className="size-4" aria-hidden="true" />
                {t("keys.editor.remove")}
              </Button>
            </div>
          </div>

          {/* The quiet line. Always 20px tall, so a missing core key adds a sentence and moves nothing. */}
          <div className="flex h-5 items-center gap-1.5 text-sm text-muted-foreground" data-slot="core-line">
            {missing.length > 0 && (
              <>
                <span className="min-w-0 truncate">{tn("keys.editor.missing", missing.length, { keys: missing.join(", ") })}</span>
                <Button
                  type="button"
                  variant="link"
                  className="relative h-5 shrink-0 px-0 text-sm before:absolute before:-inset-y-3 before:inset-x-0 before:content-['']"
                  onClick={() => setKeyBoard(putBackCore(board))}
                >
                  {t("keys.editor.putBack")}
                </Button>
              </>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1 gap-2"
              disabled={board.rows >= MAX_ROWS}
              onClick={() => setKeyBoard(addRow(board))}
            >
              <Rows3 className="size-4" aria-hidden="true" />
              {t("keys.editor.addRow")}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-11 flex-1 gap-2"
              disabled={!canRemoveRow(board)}
              onClick={() => setKeyBoard(removeRow(board))}
            >
              <X className="size-4" aria-hidden="true" />
              {t("keys.editor.removeRow")}
            </Button>
          </div>

          <section aria-label={t("keys.editor.presetsTitle")} className="space-y-1">
            <SectionLabel placement="above">{t("keys.editor.presetsTitle")}</SectionLabel>
            <ul className="divide-y divide-rule rounded-sm border border-border">
              {PRESETS.map((preset) => (
                <li key={preset.id}>
                  <PresetRow
                    preset={preset}
                    inUse={sameBoard(board, preset.board)}
                    onPick={() => setPending({ title: presetName(preset), board: preset.board })}
                  />
                </li>
              ))}
            </ul>
          </section>

          <CopyImport
            board={board}
            onReview={(next) => setPending({ title: t("keys.import.title"), board: next })}
          />

          <Button
            type="button"
            variant="outline"
            className="h-11 gap-2 self-start"
            onClick={() => setPending({ title: t("keys.editor.restore"), board: DEFAULT_BOARD })}
          >
            <RotateCcw className="size-4" aria-hidden="true" />
            {t("keys.editor.restore")}
          </Button>
        </div>
      </BottomSheet>

      {builder !== null && (
        <BottomSheet
          open
          onClose={() => setBuilder(null)}
          title={builder.key === null ? t("keys.builder.titleAdd") : t("keys.builder.titleChange")}
        >
          <ChordBuilder initial={builder.key} unsupportedKeys={unsupportedKeys} onSave={saveKey} />
        </BottomSheet>
      )}

      {pending !== null && (
        <BottomSheet open onClose={() => setPending(null)} title={pending.title}>
          <ConfirmLayout board={pending.board} onApply={apply} onCancel={() => setPending(null)} />
        </BottomSheet>
      )}
    </>
  );
}

function presetName(preset: BoardPreset): string {
  return t(`keys.preset.${preset.id}.name`);
}

function PresetRow({ preset, inUse, onPick }: { preset: BoardPreset; inUse: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
    >
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{presetName(preset)}</span>
        <span className="block text-xs text-muted-foreground">{t(`keys.preset.${preset.id}.line`)}</span>
      </span>
      {inUse && (
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <Check className="size-3.5" aria-hidden="true" />
          {t("keys.editor.inUse")}
        </span>
      )}
    </button>
  );
}

/** A read-only picture of a board: a cell per cell, the key's face in it. For the confirm screen. */
export function BoardPreview({ board }: { board: KeyBoard }) {
  return (
    <div role="group" aria-label={t("keys.layout.previewAria")} className="rounded-sm border border-border bg-muted/30 p-2">
      <div className="grid auto-rows-[28px] grid-cols-7 gap-1">
        {owners(board).map((o, i) =>
          o === -1 ? (
            <div
              key={i}
              aria-hidden="true"
              style={{ gridColumn: (i % BOARD_COLS) + 1, gridRow: Math.floor(i / BOARD_COLS) + 1 }}
              className="rounded-sm border border-dashed border-border/50"
            />
          ) : null,
        )}
        {board.cells.map((key, i) =>
          key === null ? null : (
            <div
              key={`key-${i}`}
              style={areaCss(i, key)}
              className="grid min-w-0 place-items-center overflow-hidden rounded-sm border border-border bg-background px-0.5 text-[10px] font-medium"
            >
              <span className="truncate">{keyLabel(key)}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * The screen that stands in front of anything that replaces the layout: a picture of the new board,
 * how many keys it holds, and the plain statement that it replaces yours.
 */
function ConfirmLayout({ board, onApply, onCancel }: { board: KeyBoard; onApply: () => void; onCancel: () => void }) {
  return (
    <div className="flex flex-col gap-3">
      <BoardPreview board={board} />
      <p className="text-sm font-medium">{tn("keys.layout.count", keyCount(board))}</p>
      <p className="text-sm text-muted-foreground">{t("keys.layout.replaces")}</p>
      <div className="flex gap-2">
        <Button type="button" variant="outline" className="h-11 flex-1" onClick={onCancel}>
          {t("keys.layout.cancel")}
        </Button>
        <Button type="button" className="h-11 flex-1" onClick={onApply}>
          {t("keys.layout.apply")}
        </Button>
      </div>
    </div>
  );
}

const REFUSAL_LINE = {
  empty: "keys.import.empty",
  notCode: "keys.import.notCode",
  tooLong: "keys.import.tooLong",
  damaged: "keys.import.damaged",
  schema: "keys.import.newer",
  noKeys: "keys.import.noKeys",
  tooMany: "keys.import.tooMany",
  notJson: "keys.import.invalid",
  rows: "keys.import.invalid",
  cell: "keys.import.invalid",
  key: "keys.import.invalid",
  label: "keys.import.invalid",
  area: "keys.import.area",
} as const satisfies Record<DecodeRefusal, string>;

/**
 * Copy this layout as a code, or paste one someone shared. The code is a plain line of text, so
 * a page on plain http, where the clipboard API does not exist, still works: the field is selectable
 * and the line under it says to copy by hand.
 */
function CopyImport({ board, onReview }: { board: KeyBoard; onReview: (board: KeyBoard) => void }) {
  const code = encodeBoard(board);
  const field = useRef<HTMLInputElement>(null);
  const pasteField = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "byHand">("idle");
  const [text, setText] = useState("");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("done");
    } catch {
      // No clipboard (plain http) or it refused: select the code so a long press can copy it.
      field.current?.focus({ preventScroll: true });
      field.current?.select();
      setCopied("byHand");
    }
  };
  const paste = async () => {
    try {
      setText(await navigator.clipboard.readText());
    } catch {
      pasteField.current?.focus({ preventScroll: true });
    }
  };

  const decoded = text.trim() === "" ? null : decodeBoard(text);
  const line = decoded === null ? t("keys.import.empty") : decoded.ok ? tn("keys.import.ok", keyCount(decoded.board)) : t(REFUSAL_LINE[decoded.reason]);

  return (
    <section aria-label={t("keys.editor.shareTitle")} className="space-y-2">
      <div>
        <SectionLabel placement="above">{t("keys.editor.shareTitle")}</SectionLabel>
        <p className="text-sm text-muted-foreground">{t("keys.editor.shareLine")}</p>
      </div>
      <input
        ref={field}
        readOnly
        aria-label={t("keys.editor.codeAria")}
        value={code}
        onFocus={(e) => e.currentTarget.select()}
        className="h-11 w-full min-w-0 rounded-sm border border-border bg-background px-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <Button type="button" variant="outline" className="h-11 w-full gap-2" onClick={() => void copy()}>
        {copied === "done" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
        <OneOf
          active={copied === "done" ? "done" : "idle"}
          className="justify-items-center"
          options={[
            { key: "idle", node: <span>{t("keys.editor.copy")}</span> },
            { key: "done", node: <span>{t("keys.editor.copied")}</span> },
          ]}
        />
      </Button>
      <p className="h-5 truncate text-sm text-muted-foreground" aria-live="polite">
        {copied === "byHand" ? t("keys.editor.copyByHand") : ""}
      </p>

      <div className="flex gap-2">
        <input
          ref={pasteField}
          aria-label={t("keys.editor.importAria")}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="collie-keys:1:…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="h-11 min-w-0 flex-1 rounded-sm border border-border bg-background px-3 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
        <Button type="button" variant="outline" className="h-11 gap-2" onClick={() => void paste()}>
          <ClipboardPaste className="size-4" aria-hidden="true" />
          {t("keys.editor.paste")}
        </Button>
      </div>
      <p className={cn("h-5 truncate text-sm", decoded !== null && !decoded.ok ? "text-status-working" : "text-muted-foreground")} aria-live="polite">
        {line}
      </p>
      <Button
        type="button"
        className="h-11 w-full"
        disabled={decoded === null || !decoded.ok}
        onClick={() => {
          // The pasted text stays: a Cancel on the confirm screen leaves the field as it was.
          if (decoded?.ok) onReview(decoded.board);
        }}
      >
        {t("keys.editor.import")}
      </Button>
    </section>
  );
}
