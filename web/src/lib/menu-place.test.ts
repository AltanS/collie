import { isAnchorShown, MENU_GAP, MENU_MARGIN, placeMenu } from "./menu-place";

const WINDOW = { width: 1440, height: 900 };

describe("placeMenu", () => {
  it("opens below the button with the trailing edges aligned", () => {
    const at = placeMenu({ anchor: { left: 1000, top: 20, width: 44, height: 44 }, panel: { width: 320, height: 300 }, window: WINDOW });
    expect(at.side).toBe("below");
    expect(at.top).toBe(20 + 44 + MENU_GAP);
    expect(at.left + 320).toBe(1044);
    expect(at.maxHeight).toBe(900 - MENU_MARGIN - (20 + 44 + MENU_GAP));
  });

  it("flips above when the room below is too small and the room above is enough", () => {
    const at = placeMenu({ anchor: { left: 600, top: 800, width: 44, height: 44 }, panel: { width: 320, height: 300 }, window: WINDOW });
    expect(at.side).toBe("above");
    expect(at.top + 300).toBe(800 - MENU_GAP);
  });

  it("takes the larger side as tall as its room when it fits on neither", () => {
    const at = placeMenu({ anchor: { left: 600, top: 300, width: 44, height: 44 }, panel: { width: 320, height: 2000 }, window: WINDOW });
    expect(at.side).toBe("below");
    expect(at.maxHeight).toBe(900 - MENU_MARGIN - (300 + 44 + MENU_GAP));
    expect(at.top).toBe(300 + 44 + MENU_GAP);
  });

  it("stays 8px inside the window: a button at the left edge, and one at the right", () => {
    const left = placeMenu({ anchor: { left: 2, top: 20, width: 44, height: 44 }, panel: { width: 320, height: 100 }, window: WINDOW });
    expect(left.left).toBe(MENU_MARGIN);
    const right = placeMenu({ anchor: { left: 1430, top: 20, width: 44, height: 44 }, panel: { width: 320, height: 100 }, window: WINDOW });
    expect(right.left + 320).toBe(1440 - MENU_MARGIN);
  });
});

describe("isAnchorShown", () => {
  const el = (rect: Partial<DOMRect>, connected = true) => {
    const node = document.createElement("button");
    if (connected) document.body.appendChild(node);
    node.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0, ...rect });
    return node;
  };

  it("needs a button in the document, laid out, and in view", () => {
    expect(isAnchorShown(null, WINDOW)).toBe(false);
    expect(isAnchorShown(el({ x: 10, y: 10, width: 44, height: 44 }, false), WINDOW)).toBe(false);
    expect(isAnchorShown(el({ x: 10, y: 10 }), WINDOW)).toBe(false);
    expect(isAnchorShown(el({ x: 10, y: -100, width: 44, height: 44 }), WINDOW)).toBe(false);
    expect(isAnchorShown(el({ x: 10, y: 10, width: 44, height: 44 }), WINDOW)).toBe(true);
    document.body.innerHTML = "";
  });
});
