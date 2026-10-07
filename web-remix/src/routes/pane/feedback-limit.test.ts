import { expect, test } from "bun:test";

import { FEEDBACK_MAX_LENGTH as web } from "@web/lib/prompt-action";
import { NOTE_MAX_LENGTH as webNote } from "@web/lib/preview-action";

import { FEEDBACK_MAX_LENGTH } from "./dialog-card";
import { NOTE_MAX_LENGTH } from "./dialogs/preview-select-card";

test("the card's feedback limit is web's", () => {
  expect(FEEDBACK_MAX_LENGTH).toBe(web);
});

test("the preview card's note limit is web's", () => {
  expect(NOTE_MAX_LENGTH).toBe(webNote);
});
