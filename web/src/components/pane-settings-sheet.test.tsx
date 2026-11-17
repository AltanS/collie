import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { body as accountsBody, defaultRow, workRow } from "@/test/accounts-fixtures";
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

describe("PaneSettingsSheet — Change login (M101)", () => {
  beforeEach(() => {
    vi.mocked(getPushState).mockReset().mockResolvedValue({ availability: "ready", subscribed: true, userDisabled: false });
    server.use(http.get("/api/notifications/cache-watch", () => HttpResponse.json(state())));
  });

  // Pane `w1:p1` runs in the Default row's folder, `w1:p2` in the Work profile's; `w1:p3` is in no row.
  const listed = () =>
    server.use(
      http.get("/api/accounts", () =>
        HttpResponse.json(
          accountsBody({
            accounts: [
              defaultRow({ identity: { signedIn: true, email: "me@example.com" }, panes: ["w1:p1"] }),
              workRow({ identity: { signedIn: true, email: "work@example.com" }, panes: ["w1:p2"] }),
            ],
          }),
        ),
      ),
    );

  test("a session in an added profile's folder: one row naming the profile and its login, which opens that profile's Change login", async () => {
    listed();
    const onOpen = vi.fn();
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p2" changeLogin={{ harness: "claude", onOpen }} />);
    const row = await screen.findByRole("button", { name: /Change login/ });
    expect(row).toHaveTextContent("Work · work@example.com");
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith("acc-work");
  });

  test("a session in the Default's folder: the row is for Default", async () => {
    listed();
    const onOpen = vi.fn();
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" changeLogin={{ harness: "claude", onOpen }} />);
    await userEvent.click(await screen.findByRole("button", { name: /Change login/ }));
    expect(onOpen).toHaveBeenCalledWith("claude:default");
  });

  test("a session in a folder no profile names gets no row, and is not offered Default's", async () => {
    listed();
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p3" changeLogin={{ harness: "claude", onOpen: vi.fn() }} />);
    await screen.findByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Change login/ })).toBeNull();
  });

  test("a bridge that lists no panes shows no row at all", async () => {
    server.use(http.get("/api/accounts", () => HttpResponse.json(accountsBody({ accounts: [defaultRow({}), workRow({})] }))));
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" changeLogin={{ harness: "claude", onOpen: vi.fn() }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Change login/ })).toBeNull();
  });

  test("no row for a crew member's session (no changeLogin), an agent the list does not hold, or a machine with no accounts", async () => {
    listed();
    const { unmount } = render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" />);
    await screen.findByRole("switch", { name: /warn me before this pane's cache goes cold/i });
    expect(screen.queryByRole("button", { name: /Change login/ })).toBeNull();
    unmount();
    const second = render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" changeLogin={{ harness: "codex", onOpen: vi.fn() }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Change login/ })).toBeNull();
    second.unmount();
    server.use(http.get("/api/accounts", () => HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status: 404 })));
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" changeLogin={{ harness: "claude", onOpen: vi.fn() }} />);
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Change login/ })).toBeNull();
  });
});

// CALM LOAD (row 19): the row enters when the profiles read lands. The device remembers whether this machine
// had the profiles feature (the fact the Settings index keeps, `settings-accounts-row`); while the read is in
// flight and the fact is true, the row's place is held, with nothing live in it.
describe("PaneSettingsSheet, the Change login row while the profiles are read (calm load)", () => {
  const FACT = "collie:shape:/:settings-accounts-row";
  const reserved = () => document.querySelector('[data-slot="pane-change-login-reserved"]');
  const row = () => screen.queryByRole("button", { name: /Change login/ });

  /** An accounts read the test lets go of by hand. */
  function gatedAccounts(answer: Parameters<typeof accountsBody>[0]) {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get("/api/accounts", async () => {
        await gate;
        return HttpResponse.json(accountsBody(answer));
      }),
    );
    return release;
  }
  const withPane = { accounts: [defaultRow({ identity: { signedIn: true, email: "me@example.com" }, panes: ["w1:p1"] })] };

  beforeEach(() => {
    vi.mocked(getPushState).mockReset().mockResolvedValue({ availability: "ready", subscribed: true, userDisabled: false });
    server.use(http.get("/api/notifications/cache-watch", () => HttpResponse.json(state())));
  });
  afterEach(() => localStorage.clear());

  const mountSheet = () => render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" changeLogin={{ harness: "claude", onOpen: vi.fn() }} />);

  test("with the fact remembered the row's place is held on the first frame, with no live row in it, and the read fills it", async () => {
    localStorage.setItem(FACT, "1");
    const release = gatedAccounts(withPane);
    mountSheet();
    expect(reserved()).not.toBeNull();
    expect(reserved()).toHaveAttribute("aria-hidden", "true");
    expect(reserved()?.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    expect(row()).toBeNull();
    release();
    const live = await screen.findByRole("button", { name: /Change login/ });
    expect(live).toHaveTextContent("Default · me@example.com");
    expect(reserved()).toBeNull();
    expect(localStorage.getItem(FACT)).toBe("1");
  });

  test("a read that finds no row for this pane closes the held place", async () => {
    localStorage.setItem(FACT, "1");
    const release = gatedAccounts({ accounts: [defaultRow({ panes: ["w1:p9"] })] });
    mountSheet();
    expect(reserved()).not.toBeNull();
    release();
    await waitFor(() => expect(reserved()).toBeNull());
    expect(row()).toBeNull();
  });

  test("a machine that answers no profiles closes it and forgets the fact", async () => {
    localStorage.setItem(FACT, "1");
    server.use(http.get("/api/accounts", () => HttpResponse.json({ ok: false, error: "no", code: "accounts.unavailable" }, { status: 404 })));
    mountSheet();
    expect(reserved()).not.toBeNull();
    await waitFor(() => expect(reserved()).toBeNull());
    expect(localStorage.getItem(FACT)).toBe("0");
  });

  test("with no memory the sheet holds nothing, and the row comes with the read, as before", async () => {
    const release = gatedAccounts(withPane);
    mountSheet();
    expect(reserved()).toBeNull();
    expect(row()).toBeNull();
    release();
    expect(await screen.findByRole("button", { name: /Change login/ })).toBeInTheDocument();
    expect(localStorage.getItem(FACT)).toBe("1");
  });

  test("a remembered no holds nothing", () => {
    localStorage.setItem(FACT, "0");
    gatedAccounts(withPane);
    mountSheet();
    expect(reserved()).toBeNull();
  });

  test("a sheet with no Change login (a crew member's pane) holds nothing, even with the fact remembered", () => {
    localStorage.setItem(FACT, "1");
    gatedAccounts(withPane);
    render(<PaneSettingsSheet open onClose={vi.fn()} paneId="w1:p1" />);
    expect(reserved()).toBeNull();
  });
});
