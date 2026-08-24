import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";

import {
  __resetFollowTerminal,
  holdFollowTerminal,
  setFollowTerminalEnabled,
} from "@/lib/follow-terminal";
import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";
import { panePath } from "@/lib/nav";
import { useFollowTerminal } from "./use-follow-terminal";

// "FOLLOW TERMINAL", in the four states an operator can actually get it into: off (the default and
// most of these assertions' control), on-and-still, on-and-moved, and on-while-busy. The rule the
// whole file is about is that the phone follows a CHANGE the operator made on their own screen, and
// nothing else — not the state it found, not a sweep in progress, and not while they are typing.

vi.useFakeTimers({ shouldAdvanceTime: true });

/** How long one focused pane must hold still before the phone follows it (the hook's own settle). */
const SETTLE_MS = 500;

function pane(paneId: string, focused: boolean): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "collie",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/collie",
    focused,
  };
}

/** A herd carrying nothing but the panes — the only field this hook reads. */
function home(panes: AgentView[]): HomeData {
  return {
    bridge: undefined,
    device: undefined,
    agents: panes,
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

/** Mount the hook inside a router and report where it navigated, if anywhere. */
function follow(data: HomeData, paneId?: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={["/"]}>{children}</MemoryRouter>
  );
  const view = renderHook(
    (props: { data: HomeData; paneId?: string }) => {
      useFollowTerminal(props.data, props.paneId);
      return useLocation().pathname;
    },
    { wrapper, initialProps: { data, paneId } },
  );
  return {
    rerender: (next: HomeData, nextPaneId?: string) =>
      view.rerender({ data: next, paneId: nextPaneId }),
    settle: () => act(() => void vi.advanceTimersByTime(SETTLE_MS + 50)),
    where: () => view.result.current,
  };
}

afterEach(() => __resetFollowTerminal());

describe("useFollowTerminal", () => {
  it("does nothing at all while the setting is off", () => {
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true)]));
    world.settle();
    expect(world.where()).toBe("/");
  });

  it("does not jump on the snapshot it finds — only on a change after it", () => {
    setFollowTerminalEnabled(true);
    const world = follow(home([pane("%1", true)]));
    world.settle();
    // Enabling the setting while a pane is focused elsewhere must not yank the operator off what
    // they are reading; the first snapshot is a baseline, not an instruction.
    expect(world.where()).toBe("/");
  });

  it("follows the terminal's focus once it moves and holds still", () => {
    setFollowTerminalEnabled(true);
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true)]));
    world.settle();
    expect(world.where()).toBe(panePath("%2"));
  });

  it("follows a sweep ONCE, to the pane it stopped on", () => {
    setFollowTerminalEnabled(true);
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true)]));
    act(() => void vi.advanceTimersByTime(100));
    world.rerender(home([pane("%3", true)]));
    world.settle();
    expect(world.where()).toBe(panePath("%3"));
  });

  it("stays put while something holds it — a draft, an armed mode, an open sheet", () => {
    setFollowTerminalEnabled(true);
    holdFollowTerminal("composer", true);
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true)]));
    world.settle();
    expect(world.where()).toBe("/");
  });

  it("releasing a hold does not fire the jump the hold suppressed", () => {
    setFollowTerminalEnabled(true);
    holdFollowTerminal("composer", true);
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true)]));
    world.settle();
    act(() => holdFollowTerminal("composer", false));
    world.settle();
    // The release re-baselines on what the terminal shows NOW. A jump landing here would be the
    // phone acting on a focus change the operator made minutes ago, while they were typing.
    expect(world.where()).toBe("/");
  });

  it("ignores an ambiguous herd — two focused panes are two screens", () => {
    setFollowTerminalEnabled(true);
    const world = follow(home([pane("%1", true)]));
    world.rerender(home([pane("%2", true), pane("%3", true)]));
    world.settle();
    expect(world.where()).toBe("/");
  });
});
