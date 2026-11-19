import { afterEach, describe, expect, it } from "vitest";

import { landmarkBoxes } from "./use-float-region";

// THE LANDMARKS OF A SCREEN, as the region reads them: a slot with nothing in it takes no room, so a picture
// perched above the composer stands on the composer and not on the empty padding of the notice slot.

function box(slot: string, rect: { x: number; y: number; w: number; h: number }, filled: boolean): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-slot", slot);
  if (filled) el.append(document.createElement("span"));
  el.getBoundingClientRect = () => ({ x: rect.x, y: rect.y, left: rect.x, top: rect.y, width: rect.w, height: rect.h, right: rect.x + rect.w, bottom: rect.y + rect.h, toJSON: () => ({}) });
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("landmarkBoxes", () => {
  it("reads the boxes of the landmarks that have something in them", () => {
    box("header-row", { x: 0, y: 0, w: 390, h: 60 }, true);
    box("pane-bottom", { x: 0, y: 735, w: 390, h: 109 }, true);
    expect(landmarkBoxes("session").boxes).toEqual([
      { x: 0, y: 0, w: 390, h: 60 },
      { x: 0, y: 735, w: 390, h: 109 },
    ]);
  });

  it("leaves out an empty slot's padding, and keeps watching it", () => {
    box("pane-bottom", { x: 0, y: 735, w: 390, h: 109 }, true);
    const slot = box("draft-notice-slot", { x: 0, y: 727, w: 390, h: 8 }, false);
    const { boxes, elements } = landmarkBoxes("session");
    expect(boxes).toEqual([{ x: 0, y: 735, w: 390, h: 109 }]);
    expect(elements).toContain(slot);
  });

  it("takes the slot's box once a notice is in it", () => {
    const slot = box("draft-notice-slot", { x: 0, y: 700, w: 390, h: 35 }, false);
    slot.append(document.createElement("div"));
    expect(landmarkBoxes("session").boxes).toEqual([{ x: 0, y: 700, w: 390, h: 35 }]);
  });
});
