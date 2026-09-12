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
});
