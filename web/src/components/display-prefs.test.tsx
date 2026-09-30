import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DisplayPrefsContent, type PaneViewControl } from "./display-prefs";
import type { DisplayPrefs } from "@/hooks/use-display-prefs";

// The dock answers for the body ON SCREEN. Five of the six terminal rows do nothing over a Chat
// stream, so drawing them there was six controls of which one worked and no way to tell which.

const PREFS: DisplayPrefs = {
  wrap: true,
  fontSize: 10,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
};

function draw(paneView?: Partial<PaneViewControl>) {
  const onChange = vi.fn();
  const setShowToolCalls = vi.fn();
  const stepChatFontSize = vi.fn();
  const stepFontSize = vi.fn();
  render(
    <DisplayPrefsContent
      prefs={PREFS}
      setWrap={vi.fn()}
      stepFontSize={stepFontSize}
      setRawTerminal={vi.fn()}
      setTapToFocus={vi.fn()}
      mirrorNative={false}
      setMirrorNative={vi.fn()}
      setExpandClippedReply={vi.fn()}
      paneView={
        paneView && {
          chosen: "terminal",
          showing: "terminal",
          onChange,
          showToolCalls: false,
          setShowToolCalls,
          chatFontSize: 14,
          stepChatFontSize,
          ...paneView,
        }
      }
    />,
  );
  return { onChange, setShowToolCalls, stepChatFontSize, stepFontSize };
}

describe("DisplayPrefsContent", () => {
  it("says nothing about Chat while the experiment is off", () => {
    draw();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByLabelText("Wrap lines")).toBeInTheDocument();
  });

  it("puts text size first, above the switches", () => {
    draw();
    const labels = [...document.querySelectorAll("label, .font-medium")].map((n) =>
      n.textContent?.trim(),
    );
    expect(labels[0]).toBe("Text size");
  });

  it("offers the body switch once this device has opted in", async () => {
    const user = userEvent.setup();
    const { onChange } = draw({ chosen: "terminal", showing: "terminal" });
    await user.click(screen.getByRole("radio", { name: "Chat" }));
    expect(onChange).toHaveBeenCalledWith("chat");
  });

  it("over a Chat stream it draws the stream's rows, not the mirror's", () => {
    draw({ chosen: "chat", showing: "chat" });
    expect(screen.getByLabelText("Tool calls")).toBeInTheDocument();
    expect(screen.queryByLabelText("Wrap lines")).toBeNull();
    expect(screen.queryByLabelText("Raw terminal")).toBeNull();
  });

  it("the stream's text size is its own number, not the mirror's", async () => {
    const user = userEvent.setup();
    const { stepChatFontSize, stepFontSize } = draw({ chosen: "chat", showing: "chat" });
    expect(screen.getByText("14")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Increase font size" }));
    expect(stepChatFontSize).toHaveBeenCalledWith(1);
    expect(stepFontSize).not.toHaveBeenCalled();
  });

  it("a pane with no journal keeps the mirror's rows and says why Chat is closed", () => {
    draw({ chosen: "chat", showing: "terminal", note: "No session. The terminal stays here." });
    expect(screen.getByRole("radio", { name: "Chat" })).toBeDisabled();
    expect(screen.getByText("No session. The terminal stays here.")).toBeInTheDocument();
    expect(screen.getByLabelText("Wrap lines")).toBeInTheDocument();
  });
});
