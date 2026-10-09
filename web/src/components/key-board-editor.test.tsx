import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { KeyBoardEditor } from "./key-board-editor";
import { addRow, CODE_PREFIX, DEFAULT_BOARD, encodeBoard, keyCount, PRESETS, setCell, type BoardKey, type KeyBoard } from "@/lib/key-board";
import { __reloadKeyBoard, getKeyBoard, KEY_BOARD_STORAGE_KEY, setKeyBoard } from "@/lib/key-board-store";

const step = (...steps: string[]): BoardKey => ({ kind: "chord", steps });
/** The default pad with one key taken out, so there is a free cell to work with. */
const withoutKey = (cell: number): KeyBoard => setCell(DEFAULT_BOARD, cell, null);

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
    // Twelve keys cover all fourteen cells, so the default pad has no free cell and no "+".
    expect(board.getAllByRole("button")).toHaveLength(12);
    expect(board.getByRole("button", { name: "Esc, row 1, column 1" })).toBeInTheDocument();
    expect(board.getByRole("button", { name: "Space, row 2, column 2" })).toBeInTheDocument();
    expect(board.queryByRole("button", { name: /^Add a key/ })).toBeNull();
  });

  it("clears the home indicator at the end of the scroll: 1.5rem plus the safe area, replacing the default 1rem", () => {
    open();
    const panel = screen.getByRole("dialog", { name: "Edit keys" }).querySelector("div[tabindex='-1']");
    expect(panel).toHaveClass("pb-[calc(env(safe-area-inset-bottom)_+_1.5rem)]");
    expect(panel).not.toHaveClass("pb-[calc(env(safe-area-inset-bottom)_+_1rem)]");
  });

  it("reserves the toolbar's height whether or not a key is selected", async () => {
    const { user } = open();
    const before = toolbar().className;
    expect(before).toContain("h-[202px]");
    expect(toolbar()).toHaveTextContent("Tap a key to move, change or remove it");
    expect(screen.getByRole("button", { name: "Move right" })).toBeDisabled();
    await user.click(keyAt("Esc, row 1, column 1"));
    expect(toolbar().className).toBe(before);
    expect(toolbar()).toHaveTextContent("Selected: Esc, sends Esc");
    expect(screen.getByRole("button", { name: "Move right" })).toBeEnabled();
  });
});

describe("KeyBoardEditor: moving keys", () => {
  it("moves a selected key with the arrow buttons, swapping with a key of its own size", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    expect(screen.getByRole("button", { name: "Move left" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move up" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move right" }));
    // Esc swapped with Tab, and the selection followed it.
    expect(getKeyBoard().cells[0]).toEqual(step("Tab"));
    expect(getKeyBoard().cells[1]).toEqual(step("Escape"));
    expect(keyAt("Esc, row 1, column 2")).toHaveAttribute("aria-pressed", "true");
    // Down from column 2 is the wide Space: a different size, so the arrow is off.
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Move left" }));
    await user.click(screen.getByRole("button", { name: "Move down" }));
    expect(getKeyBoard().cells[7]).toEqual(step("Escape"));
    expect(getKeyBoard().cells[0]).toEqual(step("Enter"));
  });

  it("moves into a free cell", async () => {
    setKeyBoard(withoutKey(12));
    const { user } = open();
    await user.click(keyAt("Left, row 2, column 5"));
    await user.click(screen.getByRole("button", { name: "Move right" }));
    expect(getKeyBoard().cells[11]).toBeNull();
    expect(getKeyBoard().cells[12]).toEqual(step("Left"));
  });

  it("moves a wide key by its whole area, and its arrow stays off where the area does not fit", async () => {
    setKeyBoard(setCell(addRow(DEFAULT_BOARD), 16, step("x")));
    const { user } = open();
    await user.click(keyAt("Space, row 2, column 2"));
    // Row 3 holds x under the wide key's middle, so the whole area does not fit there.
    expect(screen.getByRole("button", { name: "Move down" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Move left" })).toBeDisabled(); // Enter is another size
    await user.click(keyAt("X, row 3, column 3"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(keyAt("Space, row 2, column 2"));
    await user.click(screen.getByRole("button", { name: "Move down" }));
    expect(getKeyBoard().cells[8]).toBeNull();
    expect(getKeyBoard().cells[15]).toEqual({ kind: "chord", steps: ["Space"], w: 3 });
  });

  it("saves at once", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    await user.click(screen.getByRole("button", { name: "Move right" }));
    expect(localStorage.getItem(KEY_BOARD_STORAGE_KEY)).toContain('"v":2');
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

  it("drags a key onto a key of its own size and swaps the two", () => {
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

  it("drags a key into a free cell", () => {
    setKeyBoard(withoutKey(12));
    open();
    layOut();
    const left = keyAt("Left, row 2, column 5");
    fireEvent(left, new MouseEvent("pointerdown", { clientX: 210, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 250, 62);
    act(() => pointer("pointerup", 260, 62)); // cell 12, free
    expect(getKeyBoard().cells[11]).toBeNull();
    expect(getKeyBoard().cells[12]).toEqual(step("Left"));
  });

  it("drags a wide key by the end the finger holds: the area lands where the grab point is", () => {
    setKeyBoard(addRow(DEFAULT_BOARD));
    open();
    layOut();
    const space = keyAt("Space, row 2, column 2");
    // Grab the right-hand cell of Space (cell 10, x 150), drop that grab point on cell 20 (row 3, col 6).
    fireEvent(space, new MouseEvent("pointerdown", { clientX: 160, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 200, 110);
    act(() => pointer("pointerup", 260, 110));
    // Grab was 2 cells into the key, so the corner sits 2 columns left of the finger: cell 17, covering 17 to 19.
    expect(getKeyBoard().cells[8]).toBeNull();
    expect(getKeyBoard().cells[17]).toEqual({ kind: "chord", steps: ["Space"], w: 3 });
  });

  it("pulls a dragged wide key back inside the board when the finger is at the edge", () => {
    setKeyBoard(addRow(DEFAULT_BOARD));
    open();
    layOut();
    const space = keyAt("Space, row 2, column 2");
    fireEvent(space, new MouseEvent("pointerdown", { clientX: 60, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 200, 110);
    act(() => pointer("pointerup", 310, 110)); // cell 20, the last column
    expect(getKeyBoard().cells[18]).toEqual({ kind: "chord", steps: ["Space"], w: 3 });
  });

  it("refuses a drop onto a key of another size: the outline says so, the key goes back, nothing moves", () => {
    open();
    layOut();
    const enter = keyAt("Enter, row 2, column 1");
    fireEvent(enter, new MouseEvent("pointerdown", { clientX: 10, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 60, 62);
    pointer("pointermove", 110, 62); // over cell 9, which the wide Space covers
    const outline = document.querySelector("[data-slot='drop-outline']");
    expect(outline).toHaveAttribute("data-drop", "refused");
    expect(slot("key-status")).toHaveTextContent(/^Move Space first, it is in the way\.$/);
    act(() => pointer("pointerup", 110, 62));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    expect(document.querySelector("[data-slot='drop-outline']")).toBeNull();
    expect(slot("key-status")).toHaveTextContent("it is in the way");
  });

  it("draws a solid outline where a drop works", () => {
    setKeyBoard(withoutKey(12));
    open();
    layOut();
    const left = keyAt("Left, row 2, column 5");
    fireEvent(left, new MouseEvent("pointerdown", { clientX: 210, clientY: 60, bubbles: true, button: 0 }));
    pointer("pointermove", 250, 62);
    pointer("pointermove", 260, 62);
    expect(document.querySelector("[data-slot='drop-outline']")).toHaveAttribute("data-drop", "ok");
    act(() => pointer("pointerup", 260, 62));
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
  it("shows a plus on free cells only, and Save puts a one-cell key there", async () => {
    // Left and Down gone: cells 11 and 12 are free; nothing else is.
    setKeyBoard(setCell(withoutKey(11), 12, null));
    const { user } = open();
    expect(screen.getAllByRole("button", { name: /^Add a key/ })).toHaveLength(2);
    await user.click(keyAt("Add a key, row 2, column 6"));
    expect(screen.getByRole("dialog", { name: "Add key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.type(screen.getByRole("textbox", { name: "One character" }), "w");
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(screen.queryByRole("dialog", { name: "Add key" })).toBeNull();
    expect(getKeyBoard().cells[12]).toEqual(step("ctrl+w"));
    expect(keyAt("Ctrl+W, row 2, column 6")).toHaveAttribute("aria-pressed", "true");
  });

  it("no plus sits in a cell that a wide key covers", () => {
    setKeyBoard(addRow(DEFAULT_BOARD));
    open();
    // 7 free cells in row 3 and nothing else.
    expect(screen.getAllByRole("button", { name: /^Add a key/ })).toHaveLength(7);
    expect(screen.queryByRole("button", { name: "Add a key, row 2, column 3" })).toBeNull();
  });

  it("adds a sticky modifier key from the builder, and removing it takes it off the board", async () => {
    setKeyBoard(withoutKey(4)); // the stock Alt goes; its cell is free
    const { user } = open();
    expect(screen.queryByRole("button", { name: "Alt, row 1, column 5" })).toBeNull();
    await user.click(keyAt("Add a key, row 1, column 5"));
    await user.click(screen.getByRole("radio", { name: "Modifier" }));
    await user.click(within(screen.getByRole("group", { name: "Sticky modifier" })).getByRole("button", { name: "Alt" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(getKeyBoard().cells[4]).toEqual({ kind: "mod", mod: "alt" });
    expect(keyAt("Alt, row 1, column 5")).toHaveAttribute("aria-pressed", "true");
    expect(toolbar()).toHaveTextContent("Selected: Alt, a sticky modifier");
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(getKeyBoard().cells[4]).toBeNull();
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

  it("changing a wide key keeps its width", async () => {
    const { user } = open();
    await user.click(keyAt("Space, row 2, column 2"));
    await user.click(screen.getByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: "Ctrl" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(getKeyBoard().cells[8]).toEqual({ kind: "chord", steps: ["ctrl+Space"], w: 3 });
  });

  it("a sticky modifier opens the builder on its own kind, and can become another modifier", async () => {
    const { user } = open();
    await user.click(keyAt("Ctrl, row 1, column 4"));
    expect(toolbar()).toHaveTextContent("Selected: Ctrl, a sticky modifier");
    expect(screen.getByRole("button", { name: "Change" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Change" }));
    const picker = within(screen.getByRole("group", { name: "Sticky modifier" }));
    expect(picker.getByRole("button", { name: "Alt" })).toHaveAttribute("aria-pressed", "false");
    expect(picker.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
    await user.click(within(screen.getByRole("group", { name: "Sticky modifier" })).getByRole("button", { name: "Alt" }));
    await user.click(screen.getByRole("button", { name: "Save key" }));
    expect(getKeyBoard().cells[3]).toEqual({ kind: "mod", mod: "alt" });
  });

  it("Escape closes the top sheet only", async () => {
    const { user, onClose } = open();
    await user.click(screen.getByRole("button", { name: "Add row" }));
    await user.click(keyAt("Add a key, row 3, column 1"));
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

    await user.click(keyAt("Enter, row 2, column 1"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(coreLine()).toHaveTextContent("Esc, Enter are not on your pad.");

    await user.click(screen.getByRole("button", { name: "Put back" }));
    expect(getKeyBoard().cells[0]).toEqual(step("Escape"));
    expect(getKeyBoard().cells[7]).toEqual(step("Enter"));
    expect(coreLine()).toHaveTextContent("");
  });

  it("does not complain when a non-core key goes", async () => {
    const { user } = open();
    await user.click(keyAt("Tab, row 1, column 2"));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(coreLine()).toHaveTextContent("");
  });
});

describe("KeyBoardEditor: width and height", () => {
  const size = (axis: "Width" | "Height", n: number) => screen.getByRole("button", { name: `${axis} ${n}` });

  it("is inert with no key selected, and shows the selected key's size", async () => {
    const { user } = open();
    expect(size("Width", 1)).toBeDisabled();
    expect(size("Height", 2)).toBeDisabled();
    await user.click(keyAt("Space, row 2, column 2"));
    expect(size("Width", 3)).toHaveAttribute("aria-pressed", "true");
    expect(size("Width", 1)).toHaveAttribute("aria-pressed", "false");
    expect(size("Height", 1)).toHaveAttribute("aria-pressed", "true");
    expect(toolbar().className).toContain("h-[202px]");
  });

  it("shrinks a wide key, and grows it back over the cells it left", async () => {
    const { user } = open();
    await user.click(keyAt("Space, row 2, column 2"));
    await user.click(size("Width", 1));
    expect(getKeyBoard().cells[8]).toEqual(step("Space"));
    // Cells 9 and 10 are free now, so the plus shows there.
    expect(screen.getByRole("button", { name: "Add a key, row 2, column 3" })).toBeInTheDocument();
    await user.click(size("Width", 2));
    expect(getKeyBoard().cells[8]).toEqual({ kind: "chord", steps: ["Space"], w: 2 });
    expect(screen.queryByRole("button", { name: "Add a key, row 2, column 3" })).toBeNull();
  });

  it("will not grow over another key: the size looks off, and a tap says which key is in the way", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    const wider = size("Width", 2);
    expect(wider).toHaveAttribute("aria-disabled", "true");
    await user.click(wider);
    expect(slot("key-status")).toHaveTextContent("Move Tab first, it is in the way.");
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    await user.click(size("Height", 2));
    expect(slot("key-status")).toHaveTextContent("Move ⏎ first, it is in the way.");
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
  });

  it("will not grow past the edge of the board", async () => {
    const { user } = open();
    await user.click(keyAt("Right, row 2, column 7"));
    await user.click(size("Width", 2));
    expect(slot("key-status")).toHaveTextContent("There is no room for that here.");
    await user.click(size("Height", 2));
    expect(slot("key-status")).toHaveTextContent("There is no room for that here.");
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
  });

  it("makes a key two rows tall when the cell below is free, and a tall key keeps its last row", async () => {
    setKeyBoard(addRow(withoutKey(12)));
    const { user } = open();
    await user.click(keyAt("Up, row 1, column 6"));
    await user.click(size("Height", 2));
    // Down (cell 12) was taken out, so the cell under Up is free.
    expect(getKeyBoard().cells[5]).toEqual({ kind: "chord", steps: ["Up"], h: 2 });
    expect(screen.getByRole("button", { name: "Remove row" })).toBeEnabled();
    await user.click(keyAt("Left, row 2, column 5"));
    await user.click(size("Height", 2));
    // Left now spans rows 2 and 3, so row 3 is in use.
    expect(screen.getByRole("button", { name: "Remove row" })).toBeDisabled();
  });

  it("clears the status sentence when the selection changes", async () => {
    const { user } = open();
    await user.click(keyAt("Esc, row 1, column 1"));
    await user.click(size("Width", 2));
    expect(slot("key-status")).toHaveTextContent("it is in the way");
    await user.click(keyAt("Tab, row 1, column 2"));
    expect(slot("key-status")).toHaveTextContent("Selected: Tab");
  });
});

describe("KeyBoardEditor: rows", () => {
  it("adds a row at the bottom up to eight, and removes an empty last row", async () => {
    const { user } = open();
    expect(screen.getByRole("button", { name: "Remove row" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Add row" }));
    expect(getKeyBoard().rows).toBe(3);
    expect(within(screen.getByRole("group", { name: "Key board" })).getAllByRole("button")).toHaveLength(19);
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
    for (const name of ["Default", "Claude Code", "Prefix (Ctrl+B)", "Vim", "Navigation"]) {
      expect(list.getByRole("button", { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) })).toBeInTheDocument();
    }
    expect(list.getAllByRole("button")).toHaveLength(5);
    expect(list.getByRole("button", { name: /^Default/ })).toHaveTextContent("In use");
  });

  it("shows a preview, the key count and what happens, and changes nothing until Apply", async () => {
    const { user } = open();
    await user.click(screen.getByRole("button", { name: /^Prefix \(Ctrl\+B\)/ }));
    const confirm = within(screen.getByRole("dialog", { name: "Prefix (Ctrl+B)" }));
    expect(confirm.getByRole("group", { name: "Preview of the layout" })).toBeInTheDocument();
    expect(confirm.getByText(`${keyCount(PRESETS[2].board)} keys`)).toBeInTheDocument();
    expect(confirm.getByText("This replaces your layout.")).toBeInTheDocument();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Prefix (Ctrl+B)" })).toBeNull();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(screen.getByRole("button", { name: /^Prefix \(Ctrl\+B\)/ }));
    await user.click(within(screen.getByRole("dialog", { name: "Prefix (Ctrl+B)" })).getByRole("button", { name: "Apply" }));
    expect(keyCount(getKeyBoard())).toBe(keyCount(PRESETS[2].board));
    expect(getKeyBoard().rows).toBe(3);
    expect(screen.queryByRole("dialog", { name: "Prefix (Ctrl+B)" })).toBeNull();
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
    expect(field).toHaveDisplayValue(/^collie-keys:2:/);
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
    expect(screen.getByText("Paste a layout code.")).toBeInTheDocument();

    await user.click(input);
    await user.paste("hello");
    expect(screen.getByText("That is not a Collie layout code.")).toBeInTheDocument();
    expect(importBtn).toBeDisabled();

    await user.clear(input);
    await user.click(input);
    await user.paste(encodeBoard(PRESETS[3].board));
    expect(screen.getByText(`${keyCount(PRESETS[3].board)} keys, ready to review`)).toBeInTheDocument();
    await user.click(importBtn);
    const confirm = within(screen.getByRole("dialog", { name: "Import layout" }));
    expect(confirm.getByText("This replaces your layout.")).toBeInTheDocument();
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);
    await user.click(confirm.getByRole("button", { name: "Cancel" }));
    expect(getKeyBoard()).toBe(DEFAULT_BOARD);

    await user.click(importBtn);
    await user.click(within(screen.getByRole("dialog", { name: "Import layout" })).getByRole("button", { name: "Apply" }));
    expect(keyCount(getKeyBoard())).toBe(keyCount(PRESETS[3].board));
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
    expect(within(screen.getByRole("group", { name: "Key board" })).getAllByRole("button")).toHaveLength(12);
  });

  it("keeps working on a board with many custom keys", () => {
    let board = DEFAULT_BOARD;
    board = setCell(addRow(board), 16, step("ctrl+b", "c"));
    setKeyBoard(board);
    open();
    expect(keyAt("Ctrl+B, then C, row 3, column 3")).toBeInTheDocument();
  });
});
