import { beforeEach, describe, expect, test } from "bun:test";

import { isReloadHeld, releaseReload } from "../update/reload-hold";
import { clearDraft, hasDraft, holdDraft, loadDraft, saveDraft } from "./drafts";

const SCOPE = undefined;

describe("drafts", () => {
  beforeEach(() => {
    clearDraft(SCOPE, "w1:p1");
    clearDraft(SCOPE, "w1:p2");
    releaseReload("composer:w1:p1");
  });

  test("a saved draft loads back with its chips and next number", () => {
    saveDraft(SCOPE, "w1:p1", "hello [Image #1]", [{ n: 1, path: "/tmp/a.png", name: "a.png", kind: "image" }], 2);
    const back = loadDraft(SCOPE, "w1:p1");
    expect(back.text).toBe("hello [Image #1]");
    expect(back.attachments).toHaveLength(1);
    expect(back.next).toBe(2);
  });

  test("an empty pane loads an empty draft", () => {
    expect(loadDraft(SCOPE, "w1:p2")).toEqual({ text: "", attachments: [], next: 1 });
  });

  test("words hold the reload; clearing releases it", () => {
    saveDraft(SCOPE, "w1:p1", "half a thought");
    expect(isReloadHeld()).toBe(true);
    clearDraft(SCOPE, "w1:p1");
    expect(isReloadHeld()).toBe(false);
  });

  test("whitespace is not a draft and holds nothing", () => {
    saveDraft(SCOPE, "w1:p1", "   ");
    expect(isReloadHeld()).toBe(false);
    expect(hasDraft("  ", [])).toBe(false);
  });

  test("the composer can hold without a stored draft (an open Undo window)", () => {
    holdDraft(SCOPE, "w1:p1", true);
    expect(isReloadHeld()).toBe(true);
    holdDraft(SCOPE, "w1:p1", false);
    expect(isReloadHeld()).toBe(false);
  });
});
