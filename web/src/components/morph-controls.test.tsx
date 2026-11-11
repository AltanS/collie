import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import type { AgentView } from "@/lib/types";

import { DisplayPrefsContent, type PaneViewControl } from "./display-prefs";
import { PaneActionsSheet } from "./pane-actions-sheet";

// Morph's controls: the switch row in the session's menu, the menu's way back to Chat or the terminal
// with Morph left on, and Morph as the third choice of the display sheet's View row.

const agent: AgentView = {
  paneId: "w1:p1",
  workspaceId: "w1",
  workspaceLabel: "webapp",
  workspaceNumber: 1,
  tabId: "w1:t1",
  agent: "claude",
  status: "idle",
  cwd: "/home/you/webapp",
  focused: false,
};

type SheetProps = React.ComponentProps<typeof PaneActionsSheet>;

function renderSheet(overrides: Partial<SheetProps> = {}): SheetProps {
  const props: SheetProps = {
    open: true,
    onClose: vi.fn(),
    pane: agent,
    onRenamed: vi.fn(),
    onClosed: vi.fn(),
    paneView: "chat",
    onPaneViewChange: vi.fn(),
    ...overrides,
  };
  render(<PaneActionsSheet {...props} />);
  return props;
}

describe("the Morph rows of the session menu", () => {
  it("draw no Morph row on a pane without Morph", () => {
    renderSheet();
    expect(screen.queryByRole("switch", { name: "Morph" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Morph view" })).toBeNull();
  });

  it("turn Morph on with the switch, which shows the value asked for while it writes", async () => {
    const user = userEvent.setup();
    let finish: (failed: string | null) => void = () => {};
    const onSwitch = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)));
    renderSheet({ morph: { on: false, showing: false, onShowMorph: vi.fn(), onSwitch } });
    const toggle = screen.getByRole("switch", { name: "Morph" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("The agent answers by drawing one screen.")).toBeInTheDocument();
    await user.click(toggle);
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    finish("Not changed: offline");
    await waitFor(() => expect(screen.getByText("Not changed: offline")).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("draw no switch where nothing may write", () => {
    renderSheet({ morph: { on: true, showing: true, onShowMorph: vi.fn() } });
    expect(screen.queryByRole("switch", { name: "Morph" })).toBeNull();
  });

  it("while the Morph body shows, open the standing body itself and leave Morph on", async () => {
    const user = userEvent.setup();
    const props = renderSheet({ morph: { on: true, showing: true, onShowMorph: vi.fn(), onSwitch: vi.fn() } });
    await user.click(screen.getByRole("button", { name: "Chat view" }));
    expect(props.onPaneViewChange).toHaveBeenCalledExactlyOnceWith("chat");
  });

  it("while Chat stands in, offer the way back to Morph", async () => {
    const user = userEvent.setup();
    const onShowMorph = vi.fn();
    renderSheet({ morph: { on: true, showing: false, onShowMorph, onSwitch: vi.fn() } });
    expect(screen.getByRole("button", { name: "Terminal view" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Morph view" }));
    expect(onShowMorph).toHaveBeenCalledOnce();
  });
});

const PREFS: DisplayPrefs = {
  wrap: true,
  fontSize: 10,
  draftFontSize: 14,
  chatFontSize: 14,
  fontFamily: "system",
  rawTerminal: false,
  tapToFocus: true,
  expandClippedReply: true,
  stretchText: false,
};

function drawPrefs(paneView: Partial<PaneViewControl>) {
  const onChange = vi.fn();
  render(
    <DisplayPrefsContent
      prefs={PREFS}
      setWrap={vi.fn()}
      stepFontSize={vi.fn()}
      setRawTerminal={vi.fn()}
      setTapToFocus={vi.fn()}
      mirrorNative={false}
      setMirrorNative={vi.fn()}
      setExpandClippedReply={vi.fn()}
      setStretchText={vi.fn()}
      paneView={{
        chosen: "chat",
        showing: "chat",
        onChange,
        showToolCalls: false,
        setShowToolCalls: vi.fn(),
        showCompactions: false,
        setShowCompactions: vi.fn(),
        chatFontSize: 14,
        stepChatFontSize: vi.fn(),
        ...paneView,
      }}
    />,
  );
  return onChange;
}

describe("Morph in the View row", () => {
  it("is a third choice, selected while the Morph body shows", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onChange = drawPrefs({ morph: { selected: true, onPick } });
    expect(screen.getByRole("radio", { name: "Morph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("terminal");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("brings the Morph body back on its pick", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    drawPrefs({ morph: { selected: false, onPick } });
    expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Morph" }));
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("is absent with Morph off", () => {
    drawPrefs({});
    expect(screen.queryByRole("radio", { name: "Morph" })).toBeNull();
  });
});
