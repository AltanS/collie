import { useEffect } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { __resetHardwareKeyboard, hasSeenHardwareKeyboard } from "@/lib/hardware-keyboard";
import { __resetOperatorCommands, getOperatorShortcuts } from "@/lib/operator-config";
import { __resetShortcutRegistry, registerPaneKeySink, registerShortcutHandler } from "@/lib/shortcuts/registry";
import { __resetShortcutState, getShortcutKeymap, useShortcutMode } from "@/lib/shortcuts/state";
import { server } from "@/test/setup";

import { useShortcuts, useShortcutKeyboard } from "./use-shortcuts";

// The root listener against fake key events: what it consumes, what it lets through, and what each
// answer calls. The keymap's own rules are pinned in lib/shortcuts/; this pins the wiring.

const CTRL_B = { key: "b", ctrlKey: true } as const;

/** A key tap on `target`; true when the page may still have it (nobody called preventDefault). */
function tap(target: Element, init: KeyboardEventInit): boolean {
  return fireEvent.keyDown(target, init);
}

function ModeText() {
  return <output data-testid="mode">{useShortcutMode()}</output>;
}

function Page({ routeKey = "/", onReplyKey, onSheetKey }: { routeKey?: string; onReplyKey?: (key: string) => void; onSheetKey?: (key: string) => void }) {
  useShortcutKeyboard(routeKey);
  // A sheet closes on Escape from a listener of its own, as BottomSheet does.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onSheetKey?.(event.key);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onSheetKey]);
  return (
    <div>
      <ModeText />
      <textarea aria-label="Reply" onKeyDown={(event) => onReplyKey?.(`${event.ctrlKey || event.metaKey ? "mod+" : ""}${event.key}`)} />
      <div role="dialog" aria-label="Sheet" />
    </div>
  );
}

function mode(): string {
  return screen.getByTestId("mode").textContent ?? "";
}

function serveShortcuts(operatorShortcuts: Record<string, string[]> | null) {
  server.use(
    http.get("/api/config", () =>
      HttpResponse.json(operatorShortcuts === null ? { push: false, vapidPublicKey: "" } : { push: false, vapidPublicKey: "", operatorShortcuts }),
    ),
  );
}

async function renderPage(props: Parameters<typeof Page>[0] = {}, user: Record<string, string[]> | null = null) {
  serveShortcuts(user);
  const view = render(<Page {...props} />);
  if (user !== null) await waitFor(() => expect(getOperatorShortcuts()).not.toBeNull());
  return view;
}

beforeEach(() => {
  __resetShortcutRegistry();
  __resetShortcutState();
  __resetHardwareKeyboard();
});
afterEach(() => {
  __resetOperatorCommands();
  __resetHardwareKeyboard();
  vi.restoreAllMocks();
});

describe("the prefix and an action key", () => {
  it("the prefix then b runs the sidebar handler, and both keys are consumed", async () => {
    const toggle = vi.fn();
    registerShortcutHandler("toggle_sidebar", toggle);
    await renderPage();
    const body = document.body;

    expect(tap(body, CTRL_B)).toBe(false);
    expect(mode()).toBe("prefix");
    expect(toggle).not.toHaveBeenCalled();

    expect(tap(body, { key: "b" })).toBe(false);
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(mode()).toBe("normal");
  });

  it("stops the key at the window, so no handler below it sees it", async () => {
    await renderPage();
    const seen = vi.fn();
    document.addEventListener("keydown", seen);
    tap(document.body, CTRL_B);
    tap(document.body, { key: "x" });
    document.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it("hands an indexed action its number", async () => {
    const toTab = vi.fn();
    registerShortcutHandler("switch_tab", toTab);
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "3" });
    expect(toTab).toHaveBeenCalledWith(3);
  });

  it("an action with no handler does nothing, and the key is still consumed", async () => {
    await renderPage();
    tap(document.body, CTRL_B);
    expect(tap(document.body, { key: "x" })).toBe(false);
    expect(mode()).toBe("normal");
  });

  it("a key the prefix does not know is swallowed and the mode ends", async () => {
    await renderPage();
    tap(document.body, CTRL_B);
    expect(tap(document.body, { key: "F9" })).toBe(false);
    expect(mode()).toBe("normal");
  });

  it("Escape ends a pending prefix and is consumed", async () => {
    const onSheetKey = vi.fn();
    await renderPage({ onSheetKey });
    const sheet = screen.getByRole("dialog");
    tap(sheet, CTRL_B);
    expect(tap(sheet, { key: "Escape" })).toBe(false);
    expect(onSheetKey).not.toHaveBeenCalled();
    expect(mode()).toBe("normal");
  });

  it("the prefix pressed twice with no pane keyboard does nothing, and still ends the mode", async () => {
    await renderPage();
    tap(document.body, CTRL_B);
    expect(tap(document.body, CTRL_B)).toBe(false);
    expect(mode()).toBe("normal");
  });

  it("a held prefix does not toggle", async () => {
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { ...CTRL_B, repeat: true });
    expect(mode()).toBe("prefix");
  });
});

describe("the hardware keyboard seen", () => {
  it("is learned from the first keydown that names a physical key, ours or not", async () => {
    await renderPage();
    expect(tap(document.body, { key: "x", code: "" })).toBe(true);
    expect(hasSeenHardwareKeyboard()).toBe(false);
    expect(tap(document.body, { key: "x", code: "KeyX" })).toBe(true);
    expect(hasSeenHardwareKeyboard()).toBe(true);
  });
});

describe("keys that are not the keymap's", () => {
  it("the composer still gets Enter and Ctrl or Cmd+Enter, untouched", async () => {
    const onReplyKey = vi.fn();
    await renderPage({ onReplyKey });
    const reply = screen.getByLabelText("Reply");
    expect(tap(reply, { key: "Enter" })).toBe(true);
    expect(tap(reply, { key: "Enter", ctrlKey: true })).toBe(true);
    expect(tap(reply, { key: "Enter", metaKey: true })).toBe(true);
    expect(onReplyKey.mock.calls.map(([key]) => key)).toEqual(["Enter", "mod+Enter", "mod+Enter"]);
    expect(mode()).toBe("normal");
  });

  it("plain typing, including the action letters, reaches the page", async () => {
    const onReplyKey = vi.fn();
    const toggle = vi.fn();
    registerShortcutHandler("toggle_sidebar", toggle);
    await renderPage({ onReplyKey });
    const reply = screen.getByLabelText("Reply");
    for (const key of ["b", "c", "s", "?"]) expect(tap(reply, { key }), key).toBe(true);
    expect(onReplyKey).toHaveBeenCalledTimes(4);
    expect(toggle).not.toHaveBeenCalled();
  });

  it("Escape still closes a sheet while no mode is active", async () => {
    const onSheetKey = vi.fn();
    await renderPage({ onSheetKey });
    expect(tap(screen.getByRole("dialog"), { key: "Escape" })).toBe(true);
    expect(onSheetKey).toHaveBeenCalledWith("Escape");
  });

  it("an IME step passes, even on the prefix", async () => {
    await renderPage();
    expect(tap(document.body, { ...CTRL_B, isComposing: true })).toBe(true);
    expect(mode()).toBe("normal");
  });
});

describe("Type mode, where the page is a terminal's keyboard", () => {
  function typeInto(isDirectTyping: boolean) {
    const send = vi.fn().mockResolvedValue(true);
    registerPaneKeySink({ send, isDirectTyping: () => isDirectTyping });
    return send;
  }

  it("keeps a printable key", async () => {
    typeInto(true);
    await renderPage();
    expect(tap(screen.getByLabelText("Reply"), { key: "a" })).toBe(true);
    expect(mode()).toBe("normal");
  });

  it("the prefix twice sends ctrl+b to the pane through its key path", async () => {
    const send = typeInto(true);
    await renderPage();
    expect(tap(document.body, CTRL_B)).toBe(false);
    expect(tap(document.body, CTRL_B)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(["ctrl+b"]);
    expect(mode()).toBe("normal");
  });

  it("takes the prefix, so an action after it still runs", async () => {
    typeInto(true);
    const toggle = vi.fn();
    registerShortcutHandler("toggle_sidebar", toggle);
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "b" });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("keeps a direct binding too: it is typing there, and goes to the pane", async () => {
    typeInto(true);
    const newTab = vi.fn();
    registerShortcutHandler("new_tab", newTab);
    await renderPage({}, { new_tab: ["ctrl+alt+c"] });
    expect(tap(document.body, { key: "c", ctrlKey: true, altKey: true })).toBe(true);
    expect(newTab).not.toHaveBeenCalled();
    expect(mode()).toBe("normal");
  });

  it("outside Type mode that direct binding runs", async () => {
    typeInto(false);
    const newTab = vi.fn();
    registerShortcutHandler("new_tab", newTab);
    await renderPage({}, { new_tab: ["ctrl+alt+c"] });
    expect(tap(document.body, { key: "c", ctrlKey: true, altKey: true })).toBe(false);
    expect(newTab).toHaveBeenCalledTimes(1);
  });

  it("outside Type mode the prefix twice goes to the focused pane too", async () => {
    const send = typeInto(false);
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, CTRL_B);
    expect(send).toHaveBeenCalledWith(["ctrl+b"]);
  });

  it("sends the operator's own prefix", async () => {
    const send = typeInto(false);
    await renderPage({}, { prefix: ["ctrl+a"] });
    tap(document.body, { key: "a", ctrlKey: true });
    tap(document.body, { key: "a", ctrlKey: true });
    expect(send).toHaveBeenCalledWith(["ctrl+a"]);
  });
});

describe("the operator's file", () => {
  it("rebuilds the keymap from what the bridge sent", async () => {
    const toggle = vi.fn();
    registerShortcutHandler("toggle_sidebar", toggle);
    await renderPage({}, { prefix: ["ctrl+a"], toggle_sidebar: ["prefix+m"] });
    // The default prefix is gone, the operator's is in.
    expect(tap(document.body, CTRL_B)).toBe(true);
    tap(document.body, { key: "a", ctrlKey: true });
    tap(document.body, { key: "m" });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(getShortcutKeymap()?.prefix.map((chord) => chord.key)).toEqual(["a"]);
  });

  it("says why a binding was dropped, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const view = await renderPage({}, { zen_mode: ["ctrl+w"] });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("collie shortcuts:");
    view.rerender(<Page routeKey="/elsewhere" />);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("is quiet with no file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await renderPage();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("a sticky mode", () => {
  it("opens only where one of its keys has a target, and a key runs its own handler", async () => {
    const down = vi.fn();
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    expect(mode()).toBe("normal");

    registerShortcutHandler("navigate_down", down);
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    expect(mode()).toBe("navigate");
    expect(tap(document.body, { key: "j" })).toBe(false);
    expect(down).toHaveBeenCalledTimes(1);
    expect(mode()).toBe("navigate");
    // A bare letter in the mode is not typing.
    expect(tap(document.body, { key: "q" })).toBe(false);
    expect(tap(document.body, { key: "Escape" })).toBe(false);
    expect(mode()).toBe("normal");
  });

  it("leaves Ctrl chords alone, so ctrl+c still copies", async () => {
    registerShortcutHandler("navigate_down", vi.fn());
    await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    expect(tap(document.body, { key: "c", ctrlKey: true })).toBe(true);
    expect(mode()).toBe("navigate");
  });

  it("in Type mode a direct binding cannot open a sticky mode either", async () => {
    registerShortcutHandler("resize_wider", vi.fn());
    registerPaneKeySink({ send: vi.fn(), isDirectTyping: () => true });
    await renderPage({}, { resize_mode: ["ctrl+alt+r"] });
    expect(tap(document.body, { key: "r", ctrlKey: true, altKey: true })).toBe(true);
    expect(mode()).toBe("normal");
  });
});

describe("what ends a mode", () => {
  it("a route change ends a pending prefix", async () => {
    const view = await renderPage();
    tap(document.body, CTRL_B);
    expect(mode()).toBe("prefix");
    view.rerender(<Page routeKey="/pane/p2" />);
    expect(mode()).toBe("normal");
  });

  it("the window losing focus ends it", async () => {
    await renderPage();
    tap(document.body, CTRL_B);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });
    expect(mode()).toBe("normal");
  });

  it("a route change leaves a sticky mode alone while the new screen has a target for it", async () => {
    registerShortcutHandler("navigate_down", vi.fn());
    const view = await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    tap(document.body, { key: "j" });
    view.rerender(<Page routeKey="/pane/p2" />);
    expect(mode()).toBe("navigate");
    view.rerender(<Page routeKey="/pane/p3" />);
    expect(mode()).toBe("navigate");
  });

  it("a route change to a screen with no target for the sticky mode ends it", async () => {
    const forget = registerShortcutHandler("navigate_down", vi.fn());
    const view = await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    expect(mode()).toBe("navigate");
    forget();
    view.rerender(<Page routeKey="/elsewhere" />);
    expect(mode()).toBe("normal");
  });

  it("a route change under a prefix pressed inside a sticky mode ends the prefix and keeps the mode", async () => {
    registerShortcutHandler("navigate_down", vi.fn());
    const view = await renderPage();
    tap(document.body, CTRL_B);
    tap(document.body, { key: "w" });
    tap(document.body, CTRL_B);
    expect(mode()).toBe("prefix");
    view.rerender(<Page routeKey="/pane/p2" />);
    expect(mode()).toBe("navigate");
  });

  it("Enter and Escape end Navigate mode", async () => {
    registerShortcutHandler("navigate_down", vi.fn());
    await renderPage();
    for (const key of ["Enter", "Escape"]) {
      tap(document.body, CTRL_B);
      tap(document.body, { key: "w" });
      tap(document.body, { key });
      expect(mode(), key).toBe("normal");
    }
  });

  it("leaving the root puts the keymap away and stops listening", async () => {
    const toggle = vi.fn();
    registerShortcutHandler("toggle_sidebar", toggle);
    const view = await renderPage();
    view.unmount();
    expect(getShortcutKeymap()).toBeNull();
    expect(tap(document.body, CTRL_B)).toBe(true);
  });
});

describe("the actions that need only the router", () => {
  function Where() {
    return <output data-testid="at">{`${useLocation().pathname}${useLocation().search}`}</output>;
  }
  function Root() {
    useShortcuts({ host: "peer" });
    return <Where />;
  }

  function mount(initial: string) {
    serveShortcuts(null);
    const routes = ["/", "/pane/:id", "/settings", "/settings/updates", "/new"].map((path) => ({ path, element: <Root /> }));
    const router = createMemoryRouter(routes, { initialEntries: [initial] });
    render(<RouterProvider router={router} />);
    return router;
  }
  const at = () => screen.getByTestId("at").textContent;

  it("Settings opens on the machine in view", async () => {
    mount("/pane/p1?h=peer");
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "s" }));
    expect(at()).toBe("/settings?h=peer");
  });

  it("home goes to the dashboard, and from the dashboard it goes nowhere", async () => {
    const router = mount("/pane/p1?h=peer");
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "q" }));
    expect(at()).toBe("/?h=peer");
    const length = router.state.historyAction;
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "q" }));
    expect(router.state.historyAction).toBe(length);
  });

  it("New opens for the machine in view", async () => {
    mount("/pane/p1?h=peer");
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "N", shiftKey: true }));
    expect(at()).toBe("/new?machine=peer");
  });

  it("Settings does nothing while Settings is open", async () => {
    mount("/settings/updates");
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "s" }));
    expect(at()).toBe("/settings/updates");
  });
});

// A trick's Session names no machine in its own address, so the dashboard it goes home to is the one
// it was opened from, as the Dashboard tab under it does (#826).
describe("home from a screen whose address names no machine", () => {
  function Root() {
    useShortcuts({});
    return <output data-testid="at">{`${useLocation().pathname}${useLocation().search}`}</output>;
  }

  it("goes back to the peer dashboard a trick's Session was opened from", async () => {
    serveShortcuts(null);
    const routes = ["/", "/trick/:id"].map((path) => ({ path, element: <Root /> }));
    const router = createMemoryRouter(routes, {
      initialEntries: ["/?h=peer", { pathname: "/trick/t1", state: { from: "/?h=peer" } }],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "q" }));
    expect(screen.getByTestId("at").textContent).toBe("/?h=peer");
    expect(router.state.historyAction).toBe("POP");
  });

  it("goes back to the peer dashboard from New on that peer, a named session included", async () => {
    serveShortcuts(null);
    const routes = ["/", "/new"].map((path) => ({ path, element: <Root /> }));
    const router = createMemoryRouter(routes, {
      initialEntries: ["/?h=peer&s=work", { pathname: "/new", search: "?machine=peer&s=work", state: { from: "/?h=peer&s=work" } }],
      initialIndex: 1,
    });
    render(<RouterProvider router={router} />);
    tap(document.body, CTRL_B);
    await act(async () => void tap(document.body, { key: "q" }));
    expect(screen.getByTestId("at").textContent).toBe("/?h=peer&s=work");
    expect(router.state.historyAction).toBe("POP");
  });
});
