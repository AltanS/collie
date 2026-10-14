import type { ComponentProps } from "react";
import { useState } from "react";

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InlineEditor, InlineEditorOffer } from "./inline-editor";

// The primitive knows shape and behaviour and nothing else: every string arrives as a prop and every
// action belongs to the caller. These cases pin the surface the plan card drives today and the three
// cards after it will drive.
const PROPS = {
  id: "editor-text",
  label: "Tell Claude what to change",
  maxLength: 40,
  placeholder: "Describe the change",
  help: "Claude keeps planning instead of starting work.",
  textAriaLabel: "Feedback text",
  sendLabel: "Send feedback",
  cancelLabel: "Cancel",
} as const;

function editor(overrides: Partial<ComponentProps<typeof InlineEditor>> = {}) {
  const onChange = vi.fn();
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <InlineEditor
      {...PROPS}
      value=""
      onChange={onChange}
      onSend={onSend}
      onCancel={onCancel}
      sendDisabled={false}
      cancelDisabled={false}
      busy={false}
      busyAriaLabel="Sending feedback"
      {...overrides}
    />,
  );
  return { box: screen.getByRole("textbox", { name: PROPS.textAriaLabel }), onChange, onSend, onCancel };
}

describe("InlineEditor — the box a person types on the card itself", () => {
  it("focuses the textarea as soon as it mounts", () => {
    // Mounting IS opening: the caller renders the editor when it opens it.
    expect(editor().box).toHaveFocus();
  });

  it("reports every edit through onChange", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    // A controlled host, so typing exercises the real value round-trip the card drives.
    function Host() {
      const [value, setValue] = useState("");
      return (
        <InlineEditor
          {...PROPS}
          value={value}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
          onSend={() => {}}
          onCancel={() => {}}
          sendDisabled={false}
          cancelDisabled={false}
          busy={false}
          busyAriaLabel="Sending feedback"
        />
      );
    }
    render(<Host />);
    await user.type(screen.getByRole("textbox", { name: PROPS.textAriaLabel }), "use a switch");
    expect(onChange).toHaveBeenLastCalledWith("use a switch");
    expect(screen.getByRole("textbox", { name: PROPS.textAriaLabel })).toHaveValue("use a switch");
  });

  it("sends through the caller's own handler", async () => {
    const user = userEvent.setup();
    const { onSend } = editor();
    await user.click(screen.getByRole("button", { name: PROPS.sendLabel }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("refuses Send when sendDisabled says there is nothing to send", async () => {
    const user = userEvent.setup();
    const { onSend } = editor({ sendDisabled: true });
    const send = screen.getByRole("button", { name: PROPS.sendLabel });
    expect(send).toBeDisabled();
    await user.click(send);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("cancels through the caller's own handler", async () => {
    const user = userEvent.setup();
    const { onCancel } = editor();
    await user.click(screen.getByRole("button", { name: PROPS.cancelLabel }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("refuses Cancel while the caller's send is in flight", async () => {
    const user = userEvent.setup();
    const { onCancel } = editor({ cancelDisabled: true });
    const cancel = screen.getByRole("button", { name: PROPS.cancelLabel });
    expect(cancel).toBeDisabled();
    await user.click(cancel);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("shows the spinner the caller names while busy, inside the Send that is working", () => {
    editor({ busy: true, busyAriaLabel: "Sending feedback" });
    expect(screen.getByLabelText("Sending feedback")).toBeInTheDocument();
    expect(screen.getByLabelText("Sending feedback").closest("button")).toBe(
      screen.getByRole("button", { name: new RegExp(PROPS.sendLabel) }),
    );
  });

  it("ties the label to the textarea the caller names", () => {
    const { box } = editor();
    expect(box).toHaveAttribute("id", PROPS.id);
    expect(screen.getByText(PROPS.label)).toHaveAttribute("for", PROPS.id);
  });

  it("applies the caller's maxLength", () => {
    expect(editor({ maxLength: 40 }).box).toHaveAttribute("maxlength", "40");
  });
});

describe("InlineEditorOffer — the dashed button that opens the editor", () => {
  const OFFER = "Tell Claude what to change";

  it("opens the editor through the caller's handler", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<InlineEditorOffer label={OFFER} onClick={onClick} disabled={false} />);
    await user.click(screen.getByRole("button", { name: OFFER }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("is inert on a locked card, and still on screen", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<InlineEditorOffer label={OFFER} onClick={onClick} disabled />);
    const offer = screen.getByRole("button", { name: OFFER });
    expect(offer).toBeDisabled();
    await user.click(offer);
    expect(onClick).not.toHaveBeenCalled();
  });
});
