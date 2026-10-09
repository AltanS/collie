import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { KeyBoardEditor } from "./key-board-editor";
import { CODE_PREFIX, DEFAULT_BOARD, encodeBoard, keyCount, PRESETS, setCell, type BoardKey } from "@/lib/key-board";
import { __reloadKeyBoard, getKeyBoard, KEY_BOARD_STORAGE_KEY, setKeyBoard } from "@/lib/key-board-store";

const step = (...steps: string[]): BoardKey => ({ kind: "chord", steps });

function open(props: { onClose?: () => void; unsupportedKeys?: readonly string[] } = {}) {
  const onClose = props.onClose ?? vi.fn();
  const user = userEvent.setup();
  render(<KeyBoardEditor open onClose={onClose} unsupportedKeys={props.unsupportedKeys ?? []} />);
  return { user, onClose };
}

const keyAt = (name: string | RegExp) => screen.getByRole("button", { name });
function slot(name: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-slot='${name}']`);
  if (el === null) throw new Error(`no ${name}`);
  return el;
}
const toolbar = () => slot("key-toolbar");
const coreLine = () => slot("core-line");

beforeEach(() => {
  localStorage.clear();
  __reloadKeyBoard();
});

describe("KeyBoardEditor: the sheet", () => {
  it("is a tall sheet named Edit keys, with every cell of the board", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Edit keys" });
    expect(dialog.querySelector("div[tabindex='-1']")).toHaveClass("h-[85dvh]");
    const board = within(screen.getByRole("group", { name: "Key board" }));
    expect(board.getAllByRole("button")).toHaveLength(14);
    expect(board.getByRole("button", { name: "Esc, row 1, column 1" })).toBeInTheDocument();
    expect(board.getByRole("button", { name: "Add a key, row 2, column 3" })).toBeInTheDocument();
  });

  it("reserves the toolbar's height whether or not a key is selected", async () => {
    const { user } = open();
    const before = toolbar().className;
    expect(before).toContain("h-[150px]");
    expect(toolbar()).toHaveTextContent("Tap a key to move, change or remove it");
    expect(screen.getByRole("button", { name: "Move right" })).toBeDisabled();
    await user.click(keyAt("Esc, row 1, column 1"));
    expect(toolbar().className).toBe(before);
    expect(toolbar()).toHaveTextContent("Selected: Esc, sends Esc");
    expect(screen.getByRole("button", { name: "Move right" })).toBeEnabled();
  });
});

describe("KeyBoardEditor: moving keys", () => {
  it("moves a selected key one cell with the arrow buttons, swapping when the cell is full", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    expect(screen.getByRole("button", { name: "Move left" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move right" }));
    // Esc swapped with Tab, and the selection followed it.
    expect(getKeyBoard().cells[0]).toEqual(step("Tab"));
    expect(getKeyBoard().cells[1]).toEqual(step("Escape"));
    expect(keyAt("Esc, row 1, column 2")).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Move down" }));
    expect(getKeyBoard().cells[8]).toEqual(step("Escape"));
    expect(getKeyBoard().cells[1]).toEqual(step("Enter"));
  });

  it("moves into an empty cell", async () => {
    const { user } = open();
    await user.click(keyAt("Enter, row 2, column 2"));
    await user.click(screen.getByRole("button", { name: "Move right" }));
    expect(getKeyBoard().cells[8]).toBeNull();
    expect(getKeyBoard().cells[9]).toEqual(step("Enter"));
  });

  it("saves at once, on this device", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    await user.click(screen.getByRole("button", { name: "Move right" }));
    expect(localStorage.getItem(KEY_BOARD_STORAGE_KEY)).toContain('"v":1');
  });

  // jsdom has no layout, so each cell's box is given: 50px squares on a 7-column grid.
  function layOut() {
    const cells = document.querySelectorAll<HTMLElement>("[data-cell]");
    cells.forEach((el) => {
      const i = Number(el.dataset.cell);
      const left = (i % 7) * 50;
      const top = Math.floor(i / 7) * 50;
      el.getBoundingClientRect = () => ({ left, top, right: left + 48, bottom: top + 48, width: 48, height: 48, x: left, y: top, toJSON: () => ({}) });
    });
  }
  const pointer = (type: string, x: number, y: number) =>
    fireEvent(window, new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }));

  it("drags a key onto a full cell and swaps the two", () => {
    open();
    layOut();
    const esc = keyAt("Esc, row 1, column 1");
    fireEvent(esc, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true, button: 0 }));
    pointer("pointermove", 120, 12);
    pointer("pointermove", 210, 12); // over cell 4 (Alt)
    act(() => pointer("pointerup", 210, 12));
    expect(getKeyBoard().cells[0]).toEqual({ kind: "mod", mod: "alt" });
    expect(getKeyBoard().cells[4]).toEqual(step("Escape"));
  });

  it("drags a key into an empty cell", () => {
    open();
    layOut();
    const enter = keyAt("Enter, row 2, column 2");
    fireEvent(enter, new MouseEvent("pointerdown", { clientX: 60, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 110, 62);
    act(() => pointer("pointerup", 110, 62)); // cell 9, empty
    expect(getKeyBoard().cells[8]).toBeNull();
    expect(getKeyBoard().cells[9]).toEqual(step("Enter"));
  });

  it("treats a small move as a tap, and a drop outside the board as nothing", () => {
    open();
    layOut();
    const esc = keyAt("Esc, row 1, column 1");
    fireEvent(esc, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true, button: 0 }));
    pointer("pointermove", 12, 11);
    act(() => pointer("pointerup", 12, 11));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    fireEvent(esc, new MouseEvent("pointerdown", { clientX: 10, clientY: 10, bubbles: true, button: 0 }));
    pointer("pointermove", 900, 900);
    act(() => pointer("pointerup", 900, 900));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
  });

  it("puts touch-none on the keys only, so the sheet still scrolls by the gaps", () => {
    open();
    const board = screen.getByRole("group", { name: "Key board" });
    for (const btn of within(board).getAllByRole("button", { name: /, row \d+, column \d+$/ })) {
      if (btn.getAttribute("aria-label")?.startsWith("Add a key")) expect(btn).not.toHaveClass("touch-none");
      else expect(btn).toHaveClass("touch-none");
    }
    expect(board.querySelector(".grid")).not.toHaveClass("touch-none");
    expect(screen.getByRole("dialog").querySelector("div[tabindex='-1']")).not.toHaveClass("touch-none");
  });

  it("a finger that starts on a key does not start the sheet's pull-down", () => {
    open();
    const panel = screen.getByRole("dialog").querySelector("div[tabindex='-1']");
    const heard = vi.fn();
    panel?.addEventListener("touchstart", heard);
    fireEvent.touchStart(keyAt("Esc, row 1, column 1"), { touches: [{ clientX: 1, clientY: 1 }] });
    expect(heard).not.toHaveBeenCalled();
    fireEvent.touchStart(screen.getByRole("group", { name: "Key board" }), { touches: [{ clientX: 1, clientY: 1 }] });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});

describe("KeyBoardEditor: adding, changing, removing", () => {
  it("an empty cell's plus opens the chord builder for that cell, and Save puts the key there", async () => {
    const { user } = open();
    await user.click(keyAt("Add a key, row 2, column 3"));
    expect(screen.getByRole("dialog", { name: "Add key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.type(screen.getByRole("textbox", { name: "One character" }), "w");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.queryByRole("dialog", { name: "Add key" })).toBeNull();
    expect(getKeyBoard().cells[9]).toEqual(step("ctrl+w"));
    expect(keyAt("Ctrl+W, row 2, column 3")).toHaveAttribute("aria-pressed", "true");
  });

  it("Change opens the builder on the selected key and replaces it", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    await user.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("dialog", { name: "Change key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(getKeyBoard().cells[0]).toEqual(step("ctrl+Escape"));
  });

  it("a sticky modifier cannot be changed, only moved or removed", async () => {
    const { user } = open();
    await user.click(keyAt("Ctrl, row 1, column 4"));
    expect(toolbar()).toHaveTextContent("Selected: Ctrl, a sticky modifier");
    expect(screen.getByRole("button", { name: "Change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeEnabled();
  });

  it("Escape closes the top sheet only", async () => {
    const { user, onClose } = open();
    await user.click(keyAt("Add a key, row 2, column 3"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Add key" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Edit keys" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Remove empties the cell and says so quietly when Esc, Enter or an arrow is gone", async () => {
    const { user } = open();
    expect(coreLine()).toHaveTextContent("");
    const heightBefore = coreLine().className;
    await user.click(keyAt("Esc, row 1, column 1"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(getKeyBoard().cells[0]).toBeNull();
    expect(coreLine()).toHaveTextContent("Esc is not on your pad.");
    expect(coreLine().className).toBe(heightBefore);
    expect(coreLine().className).toContain("h-5");

    await user.click(keyAt("Enter, row 2, column 2"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(coreLine()).toHaveTextContent("Esc, Enter are not on your pad.");

    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(getKeyBoard().cells[0]).toEqual(step("Escape"));
    expect(getKeyBoard().cells[8]).toEqual(step("Enter"));
    expect(coreLine()).toHaveTextContent("");
  });

  it("does not complain when a non-core key goes", async () => {
    const { user } = open();
    await user.click(keyAt("Tab, row 1, column 2"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(coreLine()).toHaveTextContent("");
  });
});

describe("KeyBoardEditor: rows", () => {
  it("adds a row at the bottom up to eight, and removes an empty last row", async () => {
    const { user } = open();
    expect(screen.getByRole("button", { name: "Remove row" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add row" }));
    expect(getKeyBoard().rows).toBe(3);
    expect(within(screen.getByRole("group", { name: "Key board" })).getAllByRole("button")).toHaveLength(21);
    expect(screen.getByRole("button", { name: "Remove row" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Remove row" }));
    expect(getKeyBoard().rows).toBe(2);
    for (let i = 0; i < 6; i++) await user.click(screen.getByRole("button", { name: "Add row" }));
    expect(getKeyBoard().rows).toBe(8);
    expect(screen.getByRole("button", { name: "Add row" })).toBeDisabled();
  });
});

describe("KeyBoardEditor: presets and restore go through the confirm screen", () => {
  it("lists five presets, each with a line", () => {
    open();
    const list = within(screen.getByRole("region", { name: "Presets" }));
    for (const name of ["Default", "Claude Code", "tmux", "Vim", "Navigation"]) {
      expect(list.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
    }
    expect(list.getAllByRole("button")).toHaveLength(5);
    expect(list.getByRole("button", { name: /^Default/ })).toHaveTextContent("In use");
  });

  it("shows a preview, the key count and what happens, and changes nothing until Apply", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /^tmux/ }));
    const confirm = within(screen.getByRole("dialog", { name: "tmux" }));
    expect(confirm.getByRole("group", { name: "Preview of the layout" })).toBeInTheDocument();
    expect(confirm.getByText("21 keys")).toBeInTheDocument();
    expect(confirm.getByText("This replaces your layout.")).toBeInTheDocument();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "tmux" })).toBeNull();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(screen.getByRole("button", { name: /^tmux/ }));
    await user.click(within(screen.getByRole("dialog", { name: "tmux" })).getByRole("button", { name: "Apply" }));
    expect(keyCount(getKeyBoard())).toBe(keyCount(PRESETS[2].board));
    expect(getKeyBoard().rows).toBe(3);
    expect(screen.queryByRole("dialog", { name: "tmux" })).toBeNull();
  });

  it("Restore default asks first, then restores today's pad and removes the stored key", async () => {
    setKeyBoard(PRESETS[1].board);
    const { user } = open();
    await user.click(screen.getByRole("button", { name: "Restore default" }));
    const confirm = screen.getByRole("dialog", { name: "Restore default" });
    expect(getKeyBoard()).not.toBe(DEFAULT_BOARD);
    await user.click(within(confirm).getByRole("button", { name: "Apply" }));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    expect(localStorage.getItem(KEY_BOARD_STORAGE_KEY)).toBeNull();
  });
});

describe("KeyBoardEditor: copy and import", () => {
  it("shows this layout's code, versioned and short", () => {
    open();
    const field = screen.getByRole("textbox", { name: "Layout code" });
    expect(field).toHaveAttribute("readonly");
    expect(field).toHaveValue(encodeBoard(DEFAULT_BOARD));
    expect(field).toHaveDisplayValue(/^collie-keys:1:/);
  });

  it("copies the code to the clipboard", async () => {
    const { user } = open();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await user.click(screen.getByRole("button", { name: /Copy layout/ }));
    expect(writeText).toHaveBeenCalledWith(encodeBoard(DEFAULT_BOARD));
    expect(await screen.findAllByText("Copied")).not.toHaveLength(0);
  });

  it("falls back to a selected field when there is no clipboard (plain http)", async () => {
    const { user } = open();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("no clipboard"));
    await user.click(screen.getByRole("button", { name: /Copy layout/ }));
    expect(await screen.findByText("Select the code and copy it by hand.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Layout code" })).toHaveFocus();
  });

  it("validates a pasted code, shows the confirm screen, and applies only on Apply", async () => {
    const { user } = open();
    const input = screen.getByRole("textbox", { name: "Paste a layout code" });
    const importBtn = screen.getByRole("button", { name: "Import layout" });
    expect(importBtn).toBeDisabled();
    expect(screen.getByText("Paste a code from your other device.")).toBeInTheDocument();

    await user.click(input);
    await user.paste("hello");
    expect(screen.getByText("That is not a Collie layout code.")).toBeInTheDocument();
    expect(importBtn).toBeDisabled();

    await user.clear(input);
    await user.click(input);
    await user.paste(encodeBoard(PRESETS[3].board));
    expect(screen.getByText("21 keys, ready to review")).toBeInTheDocument();
    await user.click(importBtn);
    const confirm = within(screen.getByRole("dialog", { name: "Import layout" }));
    expect(confirm.getByText("This replaces your layout.")).toBeInTheDocument();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(importBtn);
    await user.click(within(screen.getByRole("dialog", { name: "Import layout" })).getByRole("button", { name: "Apply" }));
    expect(keyCount(getKeyBoard())).toBe(21);
  });

  it("names why a damaged or hostile code is refused, and never enables Import", async () => {
    const { user } = open();
    const input = screen.getByRole("textbox", { name: "Paste a layout code" });
    const bad = btoa(JSON.stringify({ v: 1, rows: 1, keys: [[0, "ctrl+nope"]] })).replace(/=+$/, "");
    for (const [code, line] of [
      [CODE_PREFIX + "###", "That code is damaged or cut short."],
      [CODE_PREFIX + bad, "That layout holds a key Collie cannot send."],
      [CODE_PREFIX + "a".repeat(5000), "That code is too long to be a layout."],
    ] as const) {
      await user.clear(input);
      await user.click(input);
      await user.paste(code);
      expect(screen.getByText(line)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Import layout" })).toBeDisabled();
    }
  });
});

describe("KeyBoardEditor: a bad stored layout", () => {
  it("opens on the default board when storage holds junk", () => {
    localStorage.setItem(KEY_BOARD_STORAGE_KEY, "{not json");
    __reloadKeyBoard();
    open();
    expect(within(screen.getByRole("group", { name: "Key board" })).getAllByRole("button")).toHaveLength(14);
  });

  it("keeps working on a board with many custom keys", () => {
    let board = DEFAULT_BOARD;
    board = setCell(board, 9, step("ctrl+b", "c"));
    setKeyBoard(board);
    open();
    expect(keyAt("Ctrl+B, then C, row 2, column 3")).toBeInTheDocument();
  });
});
