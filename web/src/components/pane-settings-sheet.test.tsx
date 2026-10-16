import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { getPushState } from "@/lib/push";
import { PaneSettingsSheet, PaneSettingsView } from "./pane-settings-sheet";
import type { CacheWatchState } from "@/lib/types";

// One pane's own settings (ADR 0042): a single switch, disabled for one of three named reasons — push
// off on this device, the global switch already on, or the pane not watchable — each with its own
// hint. `PaneSettingsView` takes every value handed in, so the reason matrix is driven straight
// through it; the container (`PaneSettingsSheet`) gets one end-to-end case wiring the real hooks.

vi.mock("@/lib/push", () => ({
  disablePush: vi.fn(),
  enablePush: vi.fn(),
  getPushState: vi.fn(),
  isPushDisabledByUser: vi.fn(),
}));

const state = (over: Partial<CacheWatchState> = {}): CacheWatchState => ({
  on: false,
  global: false,
  watchable: true,
  warnSeconds: 300,
  ...over,
});

describe("PaneSettingsView — the disabled reasons and their hints", () => {
  test("push off on this device: disabled, and says to turn it on in Settings", () => {
    render(
      <PaneSettingsView state={state()} busy={false} pushOff onToggle={vi.fn()} />,
    );
    const toggle = screen.getByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("Turn notifications on for this device in Settings first."),
    ).toBeInTheDocument();
  });

  test("the global switch already on: disabled, reads ON, and says Settings covers this pane", () => {
    render(
      <PaneSettingsView
        state={state({ global: true })}
        busy={false}
        pushOff={false}
        onToggle={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    expect(toggle).toBeDisabled();
    expect(toggle).toBeChecked();
    expect(
      screen.getByText("Settings warns about every pane, so this one is covered."),
    ).toBeInTheDocument();
  });

  test("the pane is not watchable: disabled, and says there is nothing to watch", () => {
    render(
      <PaneSettingsView
        state={state({ watchable: false })}
        busy={false}
        pushOff={false}
        onToggle={vi.fn()}
      />,
    );
    const toggle = screen.getByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    expect(toggle).toBeDisabled();
    expect(
      screen.getByText("This pane's agent names no session, so there is nothing to watch."),
    ).toBeInTheDocument();
  });

  test("the ordinary hint quotes the bridge's warnSeconds as whole minutes", () => {
    render(
      <PaneSettingsView state={state({ warnSeconds: 300 })} busy={false} pushOff={false} onToggle={vi.fn()} />,
    );
    const toggle = screen.getByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    expect(toggle).not.toBeDisabled();
    expect(screen.getByText("about 5 minutes before it expires")).toBeInTheDocument();
  });

  test("the switch reads ON when the global switch is on, even if this pane's own flag is off", () => {
    render(
      <PaneSettingsView
        state={state({ global: true, on: false })}
        busy={false}
        pushOff={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByRole("switch", { name: /warn me before this pane's cache goes cold/i })).toBeChecked();
  });
});

describe("PaneSettingsView — the Rename row", () => {
  test("shows a Rename row above the switch when it is given a way to rename, and calls it", async () => {
    const onRename = vi.fn();
    render(<PaneSettingsView state={state()} busy={false} pushOff={false} onToggle={vi.fn()} onRename={onRename} />);
    await userEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  test("hides it when the pane cannot be renamed here", () => {
    render(<PaneSettingsView state={state()} busy={false} pushOff={false} onToggle={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });
});

describe("PaneSettingsSheet — the real hooks, end to end", () => {
  beforeEach(() => {
    vi.mocked(getPushState).mockReset().mockResolvedValue({
      availability: "ready",
      subscribed: true,
      userDisabled: false,
    });
  });

  test("reads the pane's state, renders the ordinary hint and toggles it on", async () => {
    const user = userEvent.setup();
    let body: { on?: boolean } | undefined;
    server.use(
      http.get("/api/notifications/cache-watch", () =>
        HttpResponse.json(state({ warnSeconds: 300 })),
      ),
      http.post<never, { on: boolean }>("/api/notifications/cache-watch", async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(state({ on: body.on, warnSeconds: 300 }));
      }),
    );

    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" />);

    const toggle = await screen.findByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    await waitFor(() => expect(toggle).not.toBeDisabled());
    expect(screen.getByText("about 5 minutes before it expires")).toBeInTheDocument();
    expect(toggle).not.toBeChecked();

    await user.click(toggle);

    await waitFor(() => expect(body).toEqual({ on: true }));
    await waitFor(() => expect(toggle).toBeChecked());
  });

  test("lists the pane's recent sends under the switch, read when the sheet opens (M56 spec 09)", async () => {
    server.use(
      http.get("/api/notifications/cache-watch", () => HttpResponse.json(state())),
      http.get("/api/send/receipts", () =>
        HttpResponse.json({ receipts: [{ requestId: "req00001", at: Date.now(), mode: "send", outcome: "sent", keys: ["Enter"], gapsMs: {}, harness: "agent", version: "1" }] }),
      ),
    );
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" />);
    expect(await screen.findByText("Recent sends")).toBeInTheDocument();
    expect(await screen.findByText("Sent")).toBeInTheDocument();
  });

  test("a program's sheet lists its sends with the queued detail and draws no cache switch (M56 spec 14)", async () => {
    let watched = 0;
    server.use(
      http.get("/api/notifications/cache-watch", () => {
        watched++;
        return HttpResponse.json(state());
      }),
      http.get("/api/send/receipts", () =>
        HttpResponse.json({
          receipts: [
            { requestId: "req00002", at: Date.now(), mode: "send", outcome: "effective", queued: true, keys: [], gapsMs: { s0: 0, write: 3 }, harness: "desk", version: null },
          ],
        }),
      ),
    );
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="conv-2" program />);
    expect(await screen.findByText("Recent sends")).toBeInTheDocument();
    expect(await screen.findByText("Queued behind the agent's turn")).toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
    expect(watched).toBe(0);
  });

  test("a closed sheet reads no receipts", async () => {
    let asked = 0;
    server.use(
      http.get("/api/notifications/cache-watch", () => HttpResponse.json(state())),
      http.get("/api/send/receipts", () => {
        asked++;
        return HttpResponse.json({ receipts: [] });
      }),
    );
    render(<PaneSettingsSheet open={false} onClose={vi.fn()} paneId="w1:p1" />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(0);
  });
});

describe("PaneSettingsView, the pane's hook edges (M56 spec 11)", () => {
  test("says hooks: live when the agent's own hooks report from the pane", () => {
    render(<PaneSettingsView state={state()} busy={false} pushOff={false} onToggle={vi.fn()} hooks="live" />);
    expect(screen.getByText("Hooks: live")).toBeInTheDocument();
  });

  test("says hooks: none for a pane that started before the install, and names the install", () => {
    render(<PaneSettingsView state={state()} busy={false} pushOff={false} onToggle={vi.fn()} hooks="none" />);
    expect(screen.getByText("Hooks: none")).toBeInTheDocument();
    expect(screen.getByText(/collie hooks install claude/)).toBeInTheDocument();
    expect(screen.queryByText(/restart/i)).toBeNull();
  });

  test("shows no hooks row at all on an older bridge", () => {
    render(<PaneSettingsView state={state()} busy={false} pushOff={false} onToggle={vi.fn()} />);
    expect(screen.queryByText(/^Hooks:/)).toBeNull();
  });
});
