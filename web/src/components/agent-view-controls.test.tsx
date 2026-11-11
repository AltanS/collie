import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DisplayPrefs } from "@/hooks/use-display-prefs";
import type { AgentView } from "@/lib/types";

import { DisplayPrefsContent, type PaneViewControl } from "./display-prefs";
import { PaneActionsSheet } from "./pane-actions-sheet";

// The agent view controls: one switch row per trick that offers a view in the session's menu, the menu's
// way back to Chat or the terminal with the view left on, and the view as the third choice of the display
// sheet's View row, named by its trick. The fixture trick is named Morph.

const HINT = "Drawn by this session's agent. A tap sends a message in your name.";
const ROWS = [{ trick: "morph", label: "Morph", on: false }];
const ROWS_ON = [{ trick: "morph", label: "Morph", on: true }];

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

describe("the agent view rows of the session menu", () => {
  it("draw no view row on a pane without agent views", () => {
    renderSheet();
    expect(screen.queryByRole("switch", { name: "Morph" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Morph view" })).toBeNull();
  });

  it("turn a view on with its switch, named by its trick, which shows the value asked for while it writes", async () => {
    const user = userEvent.setup();
    let finish: (failed: string | null) => void = () => {};
    const onSwitch = vi.fn(() => new Promise<string | null>((resolve) => (finish = resolve)));
    renderSheet({ agentViews: { rows: ROWS, label: undefined, on: false, showing: false, onShow: vi.fn(), onSwitch } });
    const toggle = screen.getByRole("switch", { name: "Morph" });
    expect(toggle).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText(HINT)).toBeInTheDocument();
    await user.click(toggle);
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("morph", true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(toggle).toBeDisabled();
    finish("Not changed: offline");
    await waitFor(() => expect(screen.getByText("Not changed: offline")).toBeInTheDocument());
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("lead 2: draw one switch row per view trick, each with its own name and the same hint", async () => {
    const user = userEvent.setup();
    const onSwitch = vi.fn(() => Promise.resolve(null));
    const rows = [
      { trick: "morph", label: "Morph", on: true },
      { trick: "board", label: "Release boa…", on: false },
    ];
    renderSheet({ agentViews: { rows, label: "Morph", on: true, showing: true, onShow: vi.fn(), onSwitch } });
    expect(screen.getByRole("switch", { name: "Morph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("switch", { name: "Release boa…" })).toHaveAttribute("aria-checked", "false");
    expect(screen.getAllByText(HINT)).toHaveLength(2);
    await user.click(screen.getByRole("switch", { name: "Release boa…" }));
    expect(onSwitch).toHaveBeenCalledExactlyOnceWith("board", true);
  });

  it("draw no switch where nothing may write", () => {
    renderSheet({ agentViews: { rows: ROWS_ON, label: "Morph", on: true, showing: true, onShow: vi.fn() } });
    expect(screen.queryByRole("switch", { name: "Morph" })).toBeNull();
  });

  it("while the view shows, open the standing body itself and leave the view on", async () => {
    const user = userEvent.setup();
    const props = renderSheet({ agentViews: { rows: ROWS_ON, label: "Morph", on: true, showing: true, onShow: vi.fn(), onSwitch: vi.fn() } });
    await user.click(screen.getByRole("button", { name: "Chat view" }));
    expect(props.onPaneViewChange).toHaveBeenCalledExactlyOnceWith("chat");
  });

  it("while Chat stands in, offer the way back to the view by its trick's name", async () => {
    const user = userEvent.setup();
    const onShow = vi.fn();
    renderSheet({ agentViews: { rows: ROWS_ON, label: "Morph", on: true, showing: false, onShow, onSwitch: vi.fn() } });
    expect(screen.getByRole("button", { name: "Terminal view" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Morph view" }));
    expect(onShow).toHaveBeenCalledOnce();
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

describe("an agent view in the View row", () => {
  it("lead 2: is a third choice named by its trick, selected while the view shows", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onChange = drawPrefs({ agentView: { label: "Morph", selected: true, onPick } });
    expect(screen.getByRole("radio", { name: "Morph" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: "Terminal" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("terminal");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("brings the view back on its pick", async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    drawPrefs({ agentView: { label: "Morph", selected: false, onPick } });
    expect(screen.getByRole("radio", { name: "Chat" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("radio", { name: "Morph" }));
    expect(onPick).toHaveBeenCalledOnce();
  });

  it("is absent with no view on", () => {
    drawPrefs({});
    expect(screen.queryByRole("radio", { name: "Morph" })).toBeNull();
  });
});
