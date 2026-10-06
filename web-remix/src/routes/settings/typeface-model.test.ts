/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import { acceptedFaces, noteKey, pickedDesign, shownFont } from "./typeface-model";

const faces = [{ family: "Fira Sans", basename: "fira.woff2" }];

describe("shownFont", () => {
  test("a shipped value shows as itself", () => {
    expect(shownFont("grotesk", faces)).toBe("grotesk");
  });
  test("an operator value with a row shows as itself", () => {
    expect(shownFont("op:fira.woff2", faces)).toBe("op:fira.woff2");
  });
  test("an operator value whose row is gone shows the default, never the first option", () => {
    expect(shownFont("op:gone.woff2", faces)).toBe("aldrich");
    expect(shownFont("op:fira.woff2", [])).toBe("aldrich");
  });
});

describe("noteKey", () => {
  test("one note per shipped face, the operator note for the rest", () => {
    expect(noteKey("system")).toBe("settings.typeface.note.system");
    expect(noteKey("aldrich")).toBe("settings.typeface.note.aldrich");
    expect(noteKey("op:x.woff2")).toBe("settings.typeface.note.operator");
  });
});

describe("pickedDesign", () => {
  test("a shipped pick stores the font alone", () => {
    expect(pickedDesign("system", faces)).toEqual({ font: "system" });
  });
  test("an operator pick stores the validated face from the current list", () => {
    expect(pickedDesign("op:fira.woff2", faces)).toEqual({ font: "op:fira.woff2", operatorFont: faces[0] });
  });
  test("a value nobody offered is refused", () => {
    expect(pickedDesign("comic-sans", faces)).toBeNull();
  });
});

describe("acceptedFaces", () => {
  test("drops rows the client refuses and keeps identity while the rows are unchanged", () => {
    const first = acceptedFaces([{ family: "Fira Sans", basename: "fira.woff2" }, { family: "serif", basename: "x.woff2" }], []);
    expect(first).toEqual(faces);
    expect(acceptedFaces([{ family: "Fira Sans", basename: "fira.woff2" }], first)).toBe(first);
  });
});
