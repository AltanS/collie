import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PaneNav } from "@/hooks/use-display-prefs";
import { buzz } from "@/lib/haptics";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { panePath } from "@/lib/nav";
import type { AgentView } from "@/lib/types";
import { columnKeyOf, spaceKeyOf } from "@/lib/wide-layout";
import { __resetWideLayoutStore, setSpaceStrip } from "@/lib/wide-layout-store";

import { usePaneNavigation } from "./pane-nav";

// Pane navigation by gesture (ADR 0121), driven with touch events through the real hook, the real map
// and the real overlay. Only the move is caught: `nav.side` is the act, and the route it would open is
// not under test here.
const navMock = vi.hoisted(() => ({
  side: vi.fn(),
  down: vi.fn(),
  open: vi.fn(),
  up: vi.fn(),
  upTo: vi.fn(),
  upExact: vi.fn(),
  upTree: vi.fn(),
  crumb: vi.fn(),
}));
vi.mock("@/hooks/use-nav", () => ({ useNav: () => navMock }));
vi.mock("@/lib/haptics", async (original) => ({ ...(await original<typeof import("@/lib/haptics")>()), buzz: vi.fn() }));

function pane(paneId: string, workspaceId: string, label: string): AgentView {
  return {
    paneId,
    workspaceId,
    workspaceLabel: label,
    workspaceNumber: workspaceId === "w1" ? 1 : 2,
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    paneLabel: `${label}-${paneId}`,
    status: "idle",
    cwd: "/home/me/proj",
    focused: false,
    kind: "agent",
  };
}

const A1 = pane("w1:p1", "w1", "alpha");
const A2 = pane("w1:p2", "w1", "alpha");
const A3 = pane("w1:p3", "w1", "alpha");
const B1 = pane("w2:p1", "w2", "beta");
const B2 = pane("w2:p2", "w2", "beta");
const AGENTS = [A1, A2, A3, B1, B2];

const home = (): HomeData => ({
  bridge: "connected",
  agents: AGENTS,
  shellPanes: [],
  workspaces: [],
  tabs: [],
  device: undefined,
  sessions: [],
  servers: [],
  ts: 0,
  scope: {},
  viewAll: false,
  snoozedUntil: null,
  update: undefined,
  error: false,
  authError: false,
});

function Harness({ method, onSwitcher, agent = A2 }: { method: PaneNav; onSwitcher?: () => void; agent?: AgentView }) {
  const nav = usePaneNavigation({ method, agent, agents: AGENTS, shellPanes: [], tabs: [], servers: [], scope: {}, onSwitcher });
  return (
    <div>
      <div ref={nav.setReading} data-testid="reading">
        <p data-testid="text">Some agent output to read and select.</p>
        <button type="button" data-testid="copy">
          Copy
        </button>
      </div>
      {nav.handle}
      {nav.overlay}
    </div>
  );
}

async function mount(method: PaneNav, onSwitcher?: () => void, agent?: AgentView) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: home, element: <Harness method={method} onSwitcher={onSwitcher} agent={agent} /> }], { initialEntries: ["/"] });
  const view = render(<RouterProvider router={router} />);
  await screen.findByTestId("reading");
  vi.useFakeTimers();
  return view;
}

interface T {
  identifier: number;
  clientX: number;
  clientY: number;
}
const T = (identifier: number, clientX: number, clientY: number): T => ({ identifier, clientX, clientY });
/** Each helper returns whether the event was NOT prevented, as fireEvent does. */
const start = (el: Element, changed: T, touches: T[]) => fireEvent.touchStart(el, { touches, changedTouches: [changed] });
const moveTo = (el: Element, touches: T[]) => fireEvent.touchMove(el, { touches, changedTouches: touches });
const end = (el: Element, changed: T, touches: T[]) => fireEvent.touchEnd(el, { touches, changedTouches: [changed] });
const selectStart = (el: Element) => fireEvent(el, new Event("selectstart", { bubbles: true, cancelable: true }));
const hold = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const overlay = () => document.querySelector('[data-slot="pane-nav-overlay"]');
const targetName = () => document.querySelector('[data-slot="pane-nav-target-name"]')?.textContent;
const rootUserSelect = () => document.documentElement.style.getPropertyValue("user-select");

beforeEach(() => {
  navMock.side.mockClear();
  vi.mocked(buzz).mockClear();
  __resetWideLayoutStore();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("style");
  window.getSelection()?.removeAllRanges();
});

/** Arm Two fingers on the reading text: one finger down and held 300 ms. The mode is READY. */
async function armChord() {
  const text = screen.getByTestId("text");
  start(text, T(1, 100, 300), [T(1, 100, 300)]);
  hold(300);
  return text;
}

/** Arm, then land the second finger: the page is held off from here. */
async function armAndLand() {
  const text = await armChord();
  start(text, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)]);
  return text;
}

function selectText(node: Element) {
  const range = document.createRange();
  range.selectNodeContents(node);
  window.getSelection()?.addRange(range);
}

describe("Two fingers", () => {
  it("arms after a 300 ms hold on the reading area with a buzz and the overlay, and holds nothing off yet", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    selectText(text);
    start(text, T(1, 100, 300), [T(1, 100, 300)]);
    hold(299);
    expect(overlay()).toBeNull();
    hold(1);
    expect(buzz).toHaveBeenCalledTimes(1);
    expect(overlay()).not.toBeNull();
    expect(targetName()).toBe("alpha-w1:p2");
    expect(document.querySelector('[data-slot="pane-nav-target-where"]')?.textContent).toBe("alpha · pane 2 of 3");
    // Ready: the selection, the root's user-select and the first finger's moves are the page's still.
    expect(window.getSelection()?.toString()).toBe("Some agent output to read and select.");
    expect(rootUserSelect()).toBe("");
    expect(moveTo(text, [T(1, 101, 301)])).toBe(true);
    expect(overlay()).not.toBeNull();
  });

  it("holds the page off once the second finger lands", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    selectText(text);
    await armChord();
    expect(start(text, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)])).toBe(false);
    expect(window.getSelection()?.toString()).toBe("");
    expect(rootUserSelect()).toBe("none");
    expect(fireEvent.contextMenu(text)).toBe(false);
    expect(selectStart(text)).toBe(false);
    expect(moveTo(text, [T(1, 101, 301), T(2, 200, 400)])).toBe(false);
    expect(overlay()).not.toBeNull();
  });

  it("a long press that starts a selection wins over the ready mode", async () => {
    await mount("twoFingers");
    const text = await armChord();
    expect(overlay()).not.toBeNull();
    // The browser's own long press, at about 500 ms: neither is prevented, and the gesture yields.
    hold(200);
    expect(selectStart(text)).toBe(true);
    expect(overlay()).toBeNull();
    selectText(text);
    expect(rootUserSelect()).toBe("");
    // The rest of the touch is the browser's: a second finger now is not a move.
    expect(start(text, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)])).toBe(true);
    expect(moveTo(text, [T(1, 100, 300), T(2, 260, 400)])).toBe(true);
    end(text, T(2, 260, 400), [T(1, 100, 300)]);
    expect(end(text, T(1, 100, 300), [])).toBe(true);
    expect(navMock.side).not.toHaveBeenCalled();
    expect(window.getSelection()?.toString()).toBe("Some agent output to read and select.");
  });

  it("the long-press menu wins over the ready mode too", async () => {
    await mount("twoFingers");
    const text = await armChord();
    expect(fireEvent.contextMenu(text)).toBe(true);
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
  });

  it("a scroll the browser takes from the ready mode cancels it", async () => {
    await mount("twoFingers");
    const text = await armChord();
    fireEvent.touchMove(text, { touches: [T(1, 100, 320)], changedTouches: [T(1, 100, 320)], cancelable: false });
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
    expect(moveTo(text, [T(1, 100, 380)])).toBe(true);
  });

  it("a second finger swipe right then the first finger's lift moves to the next pane in the space", async () => {
    await mount("twoFingers");
    const text = await armChord();
    start(document.body, T(2, 200, 500), [T(1, 100, 300), T(2, 200, 500)]);
    moveTo(document.body, [T(1, 100, 300), T(2, 245, 500)]);
    expect(targetName()).toBe("alpha-w1:p3");
    expect(document.querySelector('[data-slot="pane-nav-pad"]')?.getAttribute("data-lit")).toBe("right");
    end(document.body, T(2, 245, 500), [T(1, 100, 300)]);
    end(text, T(1, 100, 300), []);
    expect(navMock.side).toHaveBeenCalledTimes(1);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w1:p3", {}));
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
  });

  it("a swipe down moves to the next space, landing on its first pane", async () => {
    await mount("twoFingers");
    const text = await armChord();
    start(text, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)]);
    moveTo(text, [T(1, 100, 300), T(2, 200, 445)]);
    expect(targetName()).toBe("beta-w2:p1");
    end(text, T(2, 200, 445), [T(1, 100, 300)]);
    end(text, T(1, 100, 300), []);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w2:p1", {}));
  });

  it("the pad stays where the second finger first landed", async () => {
    await mount("twoFingers");
    const text = await armChord();
    start(text, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)]);
    const pad = () => document.querySelector<HTMLElement>('[data-slot="pane-nav-pad"]');
    const before = { left: pad()?.style.left, top: pad()?.style.top };
    moveTo(text, [T(1, 100, 300), T(2, 260, 400)]);
    expect({ left: pad()?.style.left, top: pad()?.style.top }).toEqual(before);
  });

  it("lifting the first finger with no swipe cancels, moves nowhere and gives the page back", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    expect(rootUserSelect()).toBe("none");
    end(text, T(2, 200, 400), [T(1, 100, 300)]);
    end(text, T(1, 100, 300), []);
    expect(navMock.side).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
    expect(fireEvent.contextMenu(text)).toBe(true);
  });

  it("a second finger inside the hold is a pinch: nothing arms and nothing is prevented", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    start(text, T(1, 100, 300), [T(1, 100, 300)]);
    hold(100);
    expect(start(text, T(2, 200, 300), [T(1, 100, 300), T(2, 200, 300)])).toBe(true);
    expect(moveTo(text, [T(1, 90, 300), T(2, 230, 300)])).toBe(true);
    hold(1000);
    expect(overlay()).toBeNull();
    expect(buzz).not.toHaveBeenCalled();
    expect(rootUserSelect()).toBe("");
    // The fingers lift one by one: the sequence stays the browser's until the last is up.
    end(text, T(2, 230, 300), [T(1, 90, 300)]);
    hold(1000);
    expect(overlay()).toBeNull();
    // Once every finger is up, the next hold arms again.
    end(text, T(1, 90, 300), []);
    await armChord();
    expect(overlay()).not.toBeNull();
  });

  it("arms on a fresh one-finger touch even when the pinch's last lift was never seen", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    start(text, T(1, 100, 300), [T(1, 100, 300)]);
    start(text, T(2, 200, 300), [T(1, 100, 300), T(2, 200, 300)]);
    // Both lifts are lost. A lone new finger can only mean both are up.
    start(text, T(3, 120, 320), [T(3, 120, 320)]);
    hold(300);
    expect(overlay()).not.toBeNull();
  });

  it("does not touch a selection or the page when the hold never arms", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()?.addRange(range);
    expect(start(text, T(1, 100, 300), [T(1, 100, 300)])).toBe(true);
    expect(moveTo(text, [T(1, 105, 305)])).toBe(true);
    expect(fireEvent.contextMenu(text)).toBe(true);
    hold(200);
    expect(end(text, T(1, 105, 305), [])).toBe(true);
    hold(500);
    expect(window.getSelection()?.toString()).toBe("Some agent output to read and select.");
    expect(rootUserSelect()).toBe("");
    expect(overlay()).toBeNull();
  });

  it("a drift past 24 px during the hold is a scroll, and never arms", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    start(text, T(1, 100, 300), [T(1, 100, 300)]);
    moveTo(text, [T(1, 100, 330)]);
    hold(500);
    expect(overlay()).toBeNull();
    // Once the finger is up, the next hold arms again.
    end(text, T(1, 100, 330), []);
    await armChord();
    expect(overlay()).not.toBeNull();
  });

  it("a touchcancel before the arm ends the hold", async () => {
    await mount("twoFingers");
    const text = screen.getByTestId("text");
    start(text, T(1, 100, 300), [T(1, 100, 300)]);
    hold(100);
    fireEvent.touchCancel(text, { touches: [], changedTouches: [T(1, 100, 300)] });
    hold(500);
    expect(overlay()).toBeNull();
    expect(buzz).not.toHaveBeenCalled();
  });

  it("a lift lost with its node before the arm never arms", async () => {
    await mount("twoFingers");
    const reading = screen.getByTestId("reading");
    const row = document.createElement("span");
    row.textContent = "a row the stream replaces";
    reading.append(row);
    start(row, T(1, 100, 300), [T(1, 100, 300)]);
    hold(100);
    row.remove();
    // The touchend goes to the detached node and never reaches the document.
    end(row, T(1, 100, 300), []);
    hold(500);
    expect(overlay()).toBeNull();
    expect(buzz).not.toHaveBeenCalled();
  });

  it("a lift on a node removed while armed is still heard: the page comes back and the move commits", async () => {
    await mount("twoFingers");
    const reading = screen.getByTestId("reading");
    const row = document.createElement("span");
    reading.append(row);
    start(row, T(1, 100, 300), [T(1, 100, 300)]);
    hold(300);
    start(document.body, T(2, 200, 400), [T(1, 100, 300), T(2, 200, 400)]);
    moveTo(document.body, [T(1, 100, 300), T(2, 250, 400)]);
    expect(rootUserSelect()).toBe("none");
    row.remove();
    end(row, T(1, 100, 300), [T(2, 250, 400)]);
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
    // The detached node itself hears the lift, so it ends the gesture as any lift does.
    expect(navMock.side).toHaveBeenCalledTimes(1);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w1:p3", {}));
  });

  it("a finger missing from the live touch list cancels, and the next hold arms afresh", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    expect(rootUserSelect()).toBe("none");
    // Both lifts were lost; a new finger lands alone.
    start(text, T(5, 120, 320), [T(5, 120, 320)]);
    expect(rootUserSelect()).toBe("");
    expect(overlay()).toBeNull();
    hold(300);
    expect(overlay()).not.toBeNull();
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("ignores a third finger while the second is down", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    expect(start(text, T(3, 50, 600), [T(1, 100, 300), T(2, 200, 400), T(3, 50, 600)])).toBe(false);
    moveTo(text, [T(1, 100, 300), T(2, 200, 400), T(3, 150, 600)]);
    expect(targetName()).toBe("alpha-w1:p2");
    end(text, T(3, 150, 600), [T(1, 100, 300), T(2, 200, 400)]);
    moveTo(text, [T(1, 100, 300), T(2, 245, 400)]);
    expect(targetName()).toBe("alpha-w1:p3");
  });

  it("a swipe past the end of a space clamps there, and the lift on the pane on screen moves nowhere", async () => {
    await mount("twoFingers", undefined, A3);
    const text = await armAndLand();
    moveTo(text, [T(1, 100, 300), T(2, 245, 400)]);
    expect(targetName()).toBe("alpha-w1:p3");
    end(text, T(1, 100, 300), [T(2, 245, 400)]);
    expect(navMock.side).not.toHaveBeenCalled();
    expect(overlay()).toBeNull();
  });

  it("a swipe up past the first space clamps, and moves nowhere", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    moveTo(text, [T(1, 100, 300), T(2, 200, 355)]);
    expect(targetName()).toBe("alpha-w1:p2");
    end(text, T(1, 100, 300), [T(2, 200, 355)]);
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("a swipe right then left back onto the start pane commits nowhere", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    moveTo(text, [T(1, 100, 300), T(2, 245, 400)]);
    expect(targetName()).toBe("alpha-w1:p3");
    moveTo(text, [T(1, 100, 300), T(2, 200, 400)]);
    expect(targetName()).toBe("alpha-w1:p2");
    end(text, T(1, 100, 300), [T(2, 200, 400)]);
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("a move into another space lands on the pane that space's stored strip has in focus", async () => {
    const places = { scope: {}, servers: [], sessions: [] };
    setSpaceStrip(spaceKeyOf(B1, places), { cols: [], focus: columnKeyOf(B2, places) });
    await mount("twoFingers");
    const text = await armAndLand();
    moveTo(text, [T(1, 100, 300), T(2, 200, 445)]);
    expect(targetName()).toBe("beta-w2:p2");
    end(text, T(1, 100, 300), [T(2, 200, 445)]);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w2:p2", {}));
  });

  it("never starts on a control inside the reading area", async () => {
    await mount("twoFingers");
    const copy = screen.getByTestId("copy");
    start(copy, T(1, 10, 10), [T(1, 10, 10)]);
    hold(500);
    expect(overlay()).toBeNull();
  });

  it("puts the root's own user-select back exactly, after a commit", async () => {
    document.documentElement.style.setProperty("user-select", "text");
    await mount("twoFingers");
    const text = await armAndLand();
    expect(rootUserSelect()).toBe("none");
    moveTo(text, [T(1, 100, 300), T(2, 150, 400)]);
    end(text, T(1, 100, 300), [T(2, 150, 400)]);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w1:p1", {}));
    expect(rootUserSelect()).toBe("text");
  });

  it("gives the page back when the view goes away while armed", async () => {
    const view = await mount("twoFingers");
    await armAndLand();
    expect(rootUserSelect()).toBe("none");
    view.unmount();
    expect(rootUserSelect()).toBe("");
    expect(fireEvent.contextMenu(document.body)).toBe(true);
    expect(fireEvent.touchMove(document.body, { touches: [T(1, 1, 1), T(2, 2, 2)] })).toBe(true);
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("the browser's touchcancel ends it without a move", async () => {
    await mount("twoFingers");
    const text = await armAndLand();
    moveTo(text, [T(1, 100, 300), T(2, 250, 400)]);
    expect(rootUserSelect()).toBe("none");
    fireEvent.touchCancel(text, { touches: [], changedTouches: [T(1, 100, 300), T(2, 250, 400)] });
    expect(navMock.side).not.toHaveBeenCalled();
    expect(rootUserSelect()).toBe("");
  });

  it("draws no handle", async () => {
    await mount("twoFingers");
    expect(document.querySelector('[data-slot="pane-nav-handle"]')).toBeNull();
  });
});

describe("Off", () => {
  it("attaches nothing: no arm, no handle, nothing prevented", async () => {
    await mount("off");
    const text = screen.getByTestId("text");
    expect(start(text, T(1, 100, 300), [T(1, 100, 300)])).toBe(true);
    hold(1000);
    expect(overlay()).toBeNull();
    expect(buzz).not.toHaveBeenCalled();
    expect(document.querySelector('[data-slot="pane-nav-handle"]')).toBeNull();
    expect(fireEvent.contextMenu(text)).toBe(true);
  });
});

describe("Joystick", () => {
  const handle = (): HTMLElement => {
    const node = document.querySelector('[data-slot="pane-nav-handle"]');
    if (!(node instanceof HTMLElement)) throw new Error("no handle");
    return node;
  };

  it("draws the handle, and the reading area takes no hold", async () => {
    await mount("joystick");
    expect(handle()).toBeInTheDocument();
    start(screen.getByTestId("text"), T(1, 100, 300), [T(1, 100, 300)]);
    hold(1000);
    expect(overlay()).toBeNull();
  });

  it("a 400 ms hold arms, the same finger steers 48 px a step, and the release moves there", async () => {
    await mount("joystick");
    start(handle(), T(1, 200, 700), [T(1, 200, 700)]);
    hold(200);
    expect(handle().hasAttribute("data-holding")).toBe(true);
    hold(200);
    expect(handle().hasAttribute("data-holding")).toBe(false);
    expect(buzz).toHaveBeenCalledTimes(1);
    expect(overlay()).not.toBeNull();
    moveTo(handle(), [T(1, 250, 700)]);
    expect(targetName()).toBe("alpha-w1:p3");
    end(handle(), T(1, 250, 700), []);
    expect(navMock.side).toHaveBeenCalledWith(panePath("w1:p3", {}));
    expect(rootUserSelect()).toBe("");
  });

  it("holds the page off at its arm, and a finger missing from the live touch list cancels", async () => {
    await mount("joystick");
    start(handle(), T(1, 200, 700), [T(1, 200, 700)]);
    hold(400);
    expect(rootUserSelect()).toBe("none");
    moveTo(handle(), [T(1, 250, 700)]);
    // The lift was lost; the next touch on the handle carries a new finger only.
    moveTo(handle(), [T(7, 250, 700)]);
    expect(overlay()).toBeNull();
    expect(rootUserSelect()).toBe("");
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("coming back to the start and releasing is no move", async () => {
    await mount("joystick");
    start(handle(), T(1, 200, 700), [T(1, 200, 700)]);
    hold(400);
    moveTo(handle(), [T(1, 200, 760)]);
    expect(targetName()).toBe("beta-w2:p1");
    moveTo(handle(), [T(1, 205, 702)]);
    expect(targetName()).toBe("alpha-w1:p2");
    end(handle(), T(1, 205, 702), []);
    expect(navMock.side).not.toHaveBeenCalled();
  });

  it("a quick drag up without the hold opens the switcher, and a tap does nothing", async () => {
    const onSwitcher = vi.fn();
    await mount("joystick", onSwitcher);
    start(handle(), T(1, 200, 700), [T(1, 200, 700)]);
    moveTo(handle(), [T(1, 200, 680)]);
    moveTo(handle(), [T(1, 200, 640)]);
    end(handle(), T(1, 200, 640), []);
    expect(onSwitcher).toHaveBeenCalledTimes(1);
    start(handle(), T(2, 200, 700), [T(2, 200, 700)]);
    hold(100);
    end(handle(), T(2, 200, 700), []);
    hold(1000);
    expect(onSwitcher).toHaveBeenCalledTimes(1);
    expect(overlay()).toBeNull();
    expect(navMock.side).not.toHaveBeenCalled();
  });
});
