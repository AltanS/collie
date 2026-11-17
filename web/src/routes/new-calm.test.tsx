import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse, type JsonBodyType } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { useRootData } from "@/lib/route-data";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { rememberAgain, type LastStart } from "@/lib/new-page";
import { clearStatus } from "@/lib/status";
import type { HarnessInfo, MuxConfig } from "@/lib/types";
import { body, defaultRow, HARNESS_CLAUDE, HARNESS_CODEX, workRow } from "@/test/accounts-fixtures";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewRoute } from "./new";

// CALM LOAD, package accounts (rows 3 and 17 of the survey). The New page reads its launchers and its
// profiles after the first paint. These cases hold the FIRST FRAME: what the page draws from what this
// device already knows, then what the read does to it (confirm, or close it through `Collapse`).

function homeData(): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers: [],
    ts: 0,
    scope: {},
    viewAll: false,
    snoozedUntil: null,
    update: undefined,
    error: false,
    authError: false,
  };
}

function Crew() {
  const data = useRootData();
  return (
    <CrewProvider servers={data.servers} sessions={[]} ts={0} pollMs={1500}>
      <Outlet />
    </CrewProvider>
  );
}

function mount(entry = "/new") {
  const data = homeData();
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...data }),
        element: withHeaderHost(<Crew />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewRoute /> },
          { path: "pane/:paneId", element: <div data-testid="pane" /> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const HARNESSES: readonly HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: true },
];
const LAUNCHERS = { launchers: [{ command: "htop", label: "htop" }], home: "/home/dev", harnesses: HARNESSES };

/** Answer `url` with `answer` once the returned function is called, and not before. */
function gated(url: string, answer: JsonBodyType, status = 200): () => void {
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(url, async () => {
      await gate;
      return HttpResponse.json(answer, { status });
    }),
  );
  return release;
}

function serveLaunchers(): void {
  server.use(http.get("/api/launchers", () => HttpResponse.json(LAUNCHERS)));
}

function declares(capabilities: MuxConfig["capabilities"]): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

const WORK_AND_DEFAULT = body({
  harnesses: [HARNESS_CLAUDE, HARNESS_CODEX],
  accounts: [
    defaultRow({ windows: [{ window: "5h", usedPct: 42, resetsAt: null }] }),
    workRow(),
    defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" }),
  ],
});
const ONLY_DEFAULT = body({ harnesses: [HARNESS_CLAUDE, HARNESS_CODEX], accounts: [defaultRow(), defaultRow({ id: "codex:default", harness: "codex", folder: "~/.codex" })] });

const agentSelect = () => screen.findByRole("combobox", { name: "Agent" });
const profileSelect = () => screen.queryByRole("combobox", { name: "Profile" });
const reserved = () => document.querySelector<HTMLElement>('[data-slot="account-pick-reserved"]');
const againButton = () => screen.queryByRole("button", { name: /Again:/ });

const PICK_KEY = "collie:shape:/:new-profile-pick@";

function lastStart(over: Partial<LastStart> = {}): LastStart {
  return { what: { kind: "harness", id: "codex" }, label: "Codex", cwd: "/home/dev/workshop", branch: null, at: Date.now(), ...over };
}

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
});

describe("the New page, the Again row on the first frame (row 3)", () => {
  it("is drawn open from the device's own record before the launcher read, cannot be tapped yet, and the read makes it tappable", async () => {
    rememberAgain("", lastStart());
    const release = gated("/api/launchers", LAUNCHERS);
    const launches: unknown[] = [];
    server.use(
      http.post("/api/launch", async ({ request }) => {
        launches.push(await request.json());
        return HttpResponse.json({ ok: true, pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "new", tabId: "w9:t1", cwd: "/home/dev" } });
      }),
    );
    mount();
    const row = await screen.findByRole("button", { name: /Again: Codex/ });
    // On the first frame: open (nothing eased in), the record's own words, and a row nobody can tap yet.
    expect(row.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    expect(row).toHaveTextContent("/home/dev/workshop");
    expect(row).toBeDisabled();
    await userEvent.click(row);
    expect(launches).toEqual([]);

    release();
    await waitFor(() => expect(row).toBeEnabled());
    // The same row, still open, with the same words: the read confirmed it and moved nothing.
    expect(row).toBeInTheDocument();
    expect(row.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    expect(row).toHaveTextContent("Again: Codex");
    await userEvent.click(row);
    await waitFor(() => expect(launches).toHaveLength(1));
    expect(launches[0]).toMatchObject({ harness: "codex", cwd: "/home/dev/workshop" });
  });

  it("a read that no longer offers what the record started closes the row", async () => {
    rememberAgain("", lastStart({ what: { kind: "harness", id: "gone" }, label: "Gone" }));
    const release = gated("/api/launchers", LAUNCHERS);
    mount();
    const row = await screen.findByRole("button", { name: /Again: Gone/ });
    expect(row.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    release();
    await waitFor(() => expect(againButton()).toBeNull());
  });

  it("a worktree start the machine cannot make closes the row once the read says so", async () => {
    rememberAgain("", lastStart({ branch: { folder: { kind: "default" } } }));
    declares({ createWorktree: false });
    const release = gated("/api/launchers", LAUNCHERS);
    mount();
    await screen.findByRole("button", { name: /Again.*Codex/ });
    release();
    await waitFor(() => expect(againButton()).toBeNull());
  });

  it("with no record there is no row on the first frame and none after the read, as before", async () => {
    const release = gated("/api/launchers", LAUNCHERS);
    mount();
    expect(await agentSelect()).toBeDisabled();
    expect(againButton()).toBeNull();
    release();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    expect(againButton()).toBeNull();
  });
});

describe("the New page, the profile pick on the first frame (row 17)", () => {
  it("held open while the profiles are read, when the last read showed it, and the read fills it", async () => {
    localStorage.setItem(PICK_KEY, "1");
    serveLaunchers();
    const release = gated("/api/accounts", WORK_AND_DEFAULT);
    mount("/new?pick=harness:claude");
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    const held = reserved();
    expect(held).not.toBeNull();
    expect(held).toHaveAttribute("aria-hidden", "true");
    expect(held?.closest('[data-slot="collapse"]')).toHaveAttribute("data-state", "open");
    // Nothing live in the held box: no select, no button, nothing to tap.
    expect(held?.querySelector("select, button, a, input")).toBeNull();
    expect(profileSelect()).toBeNull();

    release();
    expect(await screen.findByRole("combobox", { name: "Profile" })).toHaveValue("claude:default");
    expect(reserved()).toBeNull();
    expect(document.querySelectorAll('[data-slot="collapse"][data-state="open"] [data-slot="account-pick"]')).toHaveLength(1);
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
  });

  it("held on the very first frame, before the launcher read, for the agent the address names", async () => {
    localStorage.setItem(PICK_KEY, "1");
    const releaseLaunchers = gated("/api/launchers", LAUNCHERS);
    const releaseAccounts = gated("/api/accounts", WORK_AND_DEFAULT);
    mount("/new?pick=harness:claude");
    expect(await agentSelect()).toBeDisabled();
    expect(reserved()).not.toBeNull();
    releaseLaunchers();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    expect(reserved()).not.toBeNull();
    releaseAccounts();
    expect(await screen.findByRole("combobox", { name: "Profile" })).toBeInTheDocument();
    expect(reserved()).toBeNull();
  });

  it("held on the very first frame for the agent Again names", async () => {
    localStorage.setItem(PICK_KEY, "1");
    rememberAgain("", lastStart({ what: { kind: "harness", id: "claude" }, label: "Claude Code" }));
    gated("/api/launchers", LAUNCHERS);
    gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    expect(await agentSelect()).toBeDisabled();
    expect(reserved()).not.toBeNull();
  });

  it("a read that finds no added profile closes the held box and remembers that", async () => {
    localStorage.setItem(PICK_KEY, "1");
    serveLaunchers();
    const release = gated("/api/accounts", ONLY_DEFAULT);
    mount();
    await waitFor(() => expect(reserved()).not.toBeNull());
    release();
    await waitFor(() => expect(reserved()).toBeNull());
    expect(profileSelect()).toBeNull();
    expect(localStorage.getItem(PICK_KEY)).toBe("0");
  });

  it("a machine that answers 404 closes it too, and a failed read keeps the memory", async () => {
    localStorage.setItem(PICK_KEY, "1");
    serveLaunchers();
    const gone = gated("/api/accounts", { ok: false, error: "no", code: "accounts.unavailable" }, 404);
    mount();
    await waitFor(() => expect(reserved()).not.toBeNull());
    gone();
    await waitFor(() => expect(reserved()).toBeNull());
    expect(localStorage.getItem(PICK_KEY)).toBe("0");
    cleanup();

    localStorage.setItem(PICK_KEY, "1");
    const failed = gated("/api/accounts", { ok: false, error: "boom", code: "internal" }, 500);
    mount();
    await waitFor(() => expect(reserved()).not.toBeNull());
    failed();
    await waitFor(() => expect(reserved()).toBeNull());
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
  });

  it("with no pick and no Again the agent is unknown on the first frame, so nothing is held until the launcher read names it", async () => {
    localStorage.setItem(PICK_KEY, "1");
    const releaseLaunchers = gated("/api/launchers", LAUNCHERS);
    gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    expect(await agentSelect()).toBeDisabled();
    expect(reserved()).toBeNull();
    releaseLaunchers();
    await waitFor(() => expect(reserved()).not.toBeNull());
  });

  it("with no memory nothing is held, the pick opens with the read as before, and the read is remembered", async () => {
    serveLaunchers();
    const release = gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    expect(reserved()).toBeNull();
    release();
    expect(await screen.findByRole("combobox", { name: "Profile" })).toBeInTheDocument();
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
  });

  it("a remembered no holds nothing", async () => {
    localStorage.setItem(PICK_KEY, "0");
    serveLaunchers();
    gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    expect(reserved()).toBeNull();
  });

  it("holds nothing when the page opens on the Shell half, even with the fact remembered", async () => {
    localStorage.setItem(PICK_KEY, "1");
    rememberAgain("", lastStart({ what: { kind: "shell" }, label: "Shell" }));
    serveLaunchers();
    gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    await screen.findByRole("combobox", { name: "Command" });
    expect(reserved()).toBeNull();
  });

  it("holds nothing for an agent row the operator wrote, which never carries a profile", async () => {
    localStorage.setItem(PICK_KEY, "1");
    rememberAgain("", lastStart({ what: { kind: "row", command: "claude --resume" }, label: "Claude, resume" }));
    serveLaunchers();
    gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    await waitFor(() => expect(againButton()).not.toBeNull());
    expect(reserved()).toBeNull();
  });

  it("an agent the person moves to is not written down: the fact stays what the page's own choice showed", async () => {
    serveLaunchers();
    const release = gated("/api/accounts", WORK_AND_DEFAULT);
    mount();
    await waitFor(async () => expect(await agentSelect()).toHaveValue("harness:claude"));
    release();
    await screen.findByRole("combobox", { name: "Profile" });
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
    await userEvent.selectOptions(await agentSelect(), "Codex");
    await waitFor(() => expect(profileSelect()).toBeNull());
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
  });

  it("the fact is one flag: no agent, name or path is in its key or its value", async () => {
    serveLaunchers();
    server.use(http.get("/api/accounts", () => HttpResponse.json(WORK_AND_DEFAULT)));
    mount();
    await screen.findByRole("combobox", { name: "Profile" });
    const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "").filter((k) => k.startsWith("collie:shape:"));
    expect(keys).toEqual([PICK_KEY]);
    expect(localStorage.getItem(PICK_KEY)).toBe("1");
  });
});
