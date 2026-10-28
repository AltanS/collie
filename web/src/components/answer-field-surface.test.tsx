import { render, screen } from "@testing-library/react";

import { AnswerFieldSurface, answerFieldCopy, type AnswerEditor } from "./answer-field-surface";
import { ANSWER_MAX_LENGTH, FEEDBACK_MAX_LENGTH } from "@/lib/answer-field";
import { t } from "@/lib/i18n";

// The answer editor's own cap is the one a person meets first: a paste longer than the textarea's
// maxlength is cut by the browser before Send is ever pressed. It is the answer field's cap, not the
// plan row's 240 (grammar/ASK_FIELD_NOTES.md, "Long answers").
const editor: AnswerEditor = {
  editorOpen: true,
  draft: "",
  setDraft: () => {},
  moved: null,
  questionMoved: null,
  open: () => {},
  cancel: () => {},
  send: async () => {},
};

describe("AnswerFieldSurface", () => {
  it("the open editor takes an answer up to ANSWER_MAX_LENGTH, past the plan row's cap", () => {
    const copy = answerFieldCopy(t("prompt.feedback.answer.help"));
    render(
      <AnswerFieldSurface
        field={{ focused: false, text: "" }}
        asked={{ question: "Which color do you prefer?", step: "" }}
        copy={copy}
        ours={false}
        anySending={false}
        editor={editor}
        onSend={() => {}}
        locked={false}
        busyIcon={null}
        showTyped
        showFocused
      />,
    );
    const box = screen.getByRole("textbox", { name: copy.textAria });
    expect(box.getAttribute("maxlength")).toBe(String(ANSWER_MAX_LENGTH));
    expect(ANSWER_MAX_LENGTH).toBeGreaterThan(FEEDBACK_MAX_LENGTH);
  });
});
