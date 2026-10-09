import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useRootData } from "@/lib/route-data";
import { clearStatus } from "@/lib/status";
import type { HarnessInfo, LauncherItem, LaunchersAdding, Recipe, ServerSummary } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { server } from "@/test/setup";
import { NewAddRoute } from "./new-add";

// "ADD YOUR OWN" (M48 spec 02, ADR 0094), through the router at `/new/add`: the recipe way, the
// written way and its check, the off state, a retry that replays, a refusal that is read, the list of
// rows already added with rename and remove, and the explainer sheet.

const CLAUDE: Recipe = {
  harness: "claude",
  label: "Claude Code",
  binary: "claude",
  options: [
    { id: "skip", label: "Skip permission prompts", args: "--dangerously-skip-permissions", group: "permissions", noPrompts: true },
    { id: "plan", label: "Plan mode", args: "--permission-mode plan", group: "permissions" },
    { id: "opus", label: "Model: opus", args: "--model opus", group: "model" },
    { id: "sonnet", label: "Model: sonnet", args: "--model sonnet", group: "model" },
    { id: "continue", label: "Continue last", args: "--continue" },
  ],
};
const CODEX: Recipe = {
  harness: "codex",
  label: "Codex",
  binary: "codex",
  options: [{ id: "search", label: "Web search", args: "--search" }],
};
const GROK: Recipe = { harness: "grok", label: "Grok", binary: "grok", options: [] };

const HARNESSES: HarnessInfo[] = [
  { id: "claude", label: "Claude Code", found: true },
  { id: "codex", label: "Codex", found: true },
  { id: "grok", label: "Grok", found: false },
];

const FILE = "/home/op/.config/collie/launchers.toml";
const ADDING: LaunchersAdding = { adds: true, freeText: true, file: FILE, count: 1, max: 20, recipes: [CLAUDE, CODEX, GROK], off: [] };

const ROWS: LauncherItem[] = [
  {
    key: "row:claude --model opus",
    start: { command: "claude --model opus" },
    group: "agents",
    label: "Claude, opus",
    harness: "claude",
    command: "claude --model opus",
    source: "added",
    noPrompts: false,
    branch: true,
    available: true,
    id: "row-1",
    addedBy: "alice-phone",
  },
  {
    key: "row:claude --dangerously-skip-permissions",
    start: { command: "claude --dangerously-skip-permissions" },
    group: "agents",
    label: "Claude, no prompts",
    harness: "claude",
    command: "claude --dangerously-skip-permissions",
    source: "added",
    noPrompts: true,
    branch: true,
    available: true,
    id: "row-2",
    addedBy: "bob-tablet",
  },
  {
    key: "row:make test",
    start: { command: "make test" },
    group: "commands",
    label: "Run tests",
    command: "make test",
    source: "operator",
    noPrompts: false,
    branch: false,
    available: true,
  },
];

function serve(adding: LaunchersAdding | null = ADDING, items: LauncherItem[] = ROWS): void {
  server.use(
    http.get("/api/launchers", () =>
      HttpResponse.json({ launchers: [], home: "/home/op", harnesses: HARNESSES, items, adding }),
    ),
  );
}

/** What the add route is sent: the ask's fields and the request id. */
interface AddBody {
  recipe?: { harness: string; options: string[] };
  text?: string;
  kind?: string;
  harness?: string;
  noPrompts?: boolean;
  label?: string;
  requestId?: string;
}

interface Posted {
  body: AddBody;
  url: string;
}

/** Answer the add route and record what it was sent. `fail` lists 1-based attempts that die in transit. */
function serveAdd(posts: Posted[], opts: { fail?: number[]; refuse?: { code: string; status: number } } = {}): void {
  server.use(
    http.post("/api/launchers/added", async ({ request }) => {
      // SAFETY: the page under test is the only caller, and it sends exactly an `AddBody`.
      const body = (await request.json()) as AddBody;
      posts.push({ body, url: request.url });
      if (opts.fail?.includes(posts.length)) return new HttpResponse("bad gateway", { status: 502 });
      if (opts.refuse !== undefined) {
        return HttpResponse.json({ ok: false, error: "refused", code: opts.refuse.code }, { status: opts.refuse.status });
      }
      const text = body.text ?? "claude --model opus";
      return HttpResponse.json({ ok: true, row: { command: text, label: "New row", source: "added", id: "new-1" } });
    }),
  );
}

function homeData(servers: ServerSummary[]): HomeData {
  return {
    bridge: "connected",
    device: undefined,
    agents: [],
    shellPanes: [],
    workspaces: [],
    tabs: [],
    sessions: [],
    servers,
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

/** The New page stub shows where the add page sent the person: its query is the receipt. */
function NewStub() {
  const { search } = useLocation();
  return <div data-testid="new-page">{search}</div>;
}

function mount(entry = "/new/add?kind=agent", servers: ServerSummary[] = []) {
  const data = homeData(servers);
  const router = createMemoryRouter(
    [
      {
        id: ROOT_ROUTE_ID,
        path: "/",
        loader: () => ({ ...data }),
        element: withHeaderHost(<Crew />),
        children: [
          { index: true, element: <div data-testid="home" /> },
          { path: "new", element: <NewStub /> },
          { path: "new/add", element: <NewAddRoute /> },
        ],
      },
    ],
    { initialEntries: ["/new", entry], initialIndex: 1 },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const roster: ServerSummary[] = [
  { id: "lead", name: "bluefin", isLead: true, reachable: true, protocol: "ok", lastSeenAt: 0 },
  { id: "mini", name: "minibuch", isLead: false, reachable: true, protocol: "ok", lastSeenAt: 0 },
];

const chip = (name: string) => screen.findByRole("button", { name, pressed: false });
const addButton = () => screen.getByRole("button", { name: "Add" });
/** The form's own badge: not the inert layers, and not the ones in the list of added rows. */
const liveBadges = () =>
  [...document.querySelectorAll('[data-slot="no-prompts-badge"]')].filter(
    (el) => el.closest('[aria-hidden="true"]') === null && el.closest('[data-testid="launcher-added-row"]') === null,
  );

afterEach(() => {
  cleanup();
  clearStatus();
  localStorage.clear();
});

describe("Add your own: the page", () => {
  it("is a full page: the app header with a 44px back arrow, a title, and Add in the bottom bar", async () => {
    serve();
    mount();
    expect(await screen.findByRole("heading", { name: "Add your own" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" }).className).toContain("size-11");
    expect(addButton().closest('[data-slot="bottom-bar"]')).not.toBeNull();
    expect(document.querySelectorAll("header")).toHaveLength(1);
  });

  it("opens on the half ?kind= names", async () => {
    serve();
    mount("/new/add?kind=command");
    const radio = await screen.findByRole("radio", { name: "Command" });
    expect(radio).toHaveAttribute("aria-checked", "true");
    cleanup();
    serve();
    mount("/new/add?kind=agent");
    expect(await screen.findByRole("radio", { name: "Agent" })).toHaveAttribute("aria-checked", "true");
  });

  it("Back returns to the New page it came from", async () => {
    serve();
    const router = mount("/new/add?kind=agent&machine=mini", roster);
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
  });
});

describe("Add your own: a recipe", () => {
  it("offers only the harnesses that have an option to pick, the harness icon as the select's lead", async () => {
    serve();
    mount();
    const select = await screen.findByRole("combobox", { name: "Agent" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Claude Code", "Codex"]);
    expect(select.parentElement?.querySelector("[data-slot='agent-icon'], svg, span[aria-hidden]")).not.toBeNull();
  });

  it("one choice per group: another chip of a group replaces the first; a chip with no group toggles", async () => {
    serve();
    mount();
    const opus = await chip("Model: opus");
    await userEvent.click(opus);
    expect(screen.getByRole("button", { name: "Model: opus" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Model: sonnet" }));
    expect(screen.getByRole("button", { name: "Model: opus" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Model: sonnet" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Continue last" }));
    expect(screen.getByRole("button", { name: "Continue last" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Model: sonnet" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Continue last" }));
    expect(screen.getByRole("button", { name: "Continue last" })).toHaveAttribute("aria-pressed", "false");
  });

  it("builds the line in a monospace box, in table order: the binary, then each option's words", async () => {
    serve();
    mount();
    const line = await screen.findByTestId("launcher-add-line");
    await waitFor(() => expect(line).toHaveTextContent(/^claude$/));
    expect(line.className).toContain("font-mono");
    await userEvent.click(await chip("Continue last"));
    await userEvent.click(screen.getByRole("button", { name: "Model: opus" }));
    expect(line).toHaveTextContent("claude --model opus --continue");
  });

  it("shows the No prompts badge while any picked option skips prompts, and not otherwise", async () => {
    serve();
    mount();
    await chip("Model: opus");
    expect(liveBadges()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Skip permission prompts" }));
    expect(liveBadges()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Plan mode" }));
    expect(liveBadges()).toHaveLength(0);
  });

  it("another harness starts with its own chips and an empty pick", async () => {
    serve();
    mount();
    await userEvent.click(await chip("Model: opus"));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Agent" }), "Codex");
    expect(await screen.findByRole("button", { name: "Web search" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("launcher-add-line")).toHaveTextContent(/^codex$/);
  });

  it("Add sends the recipe and a request id, then goes back to /new with the new row chosen, replacing the page", async () => {
    serve();
    const posts: Posted[] = [];
    serveAdd(posts);
    const router = mount("/new/add?kind=agent&machine=mini&pane=w1%3Ap1", roster);
    await userEvent.click(await chip("Model: opus"));
    await userEvent.type(screen.getByRole("textbox", { name: /Name/ }), "Opus please");
    await userEvent.click(addButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    expect(posts).toHaveLength(1);
    expect(posts[0]?.body).toEqual({
      recipe: { harness: "claude", options: ["opus"] },
      label: "Opus please",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(new URL(posts[0]!.url).searchParams.get("host")).toBe("mini");
    const query = new URLSearchParams(router.state.location.search);
    expect(query.get("pick")).toBe("row:claude --model opus");
    expect(query.get("machine")).toBe("mini");
    expect(query.get("pane")).toBe("w1:p1");
    expect(router.state.historyAction).toBe("REPLACE");
  });
});

describe("Add your own: a retry is a replay", () => {
  it("keeps the request id across a retry of the same ask, and mints a new one when the ask changes", async () => {
    serve();
    const posts: Posted[] = [];
    serveAdd(posts, { fail: [1, 2] });
    const router = mount();
    await userEvent.click(await chip("Model: opus"));
    await userEvent.click(addButton());
    expect(await screen.findByTestId("launcher-add-error")).toBeInTheDocument();
    await userEvent.click(addButton());
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]?.body.requestId).toBe(posts[0]?.body.requestId);
    // The person changes the ask: it is a new add, so a new id.
    await userEvent.click(await screen.findByRole("button", { name: "Continue last" }));
    await userEvent.click(addButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    expect(posts[2]?.body.requestId).not.toBe(posts[0]?.body.requestId);
  });
});

describe("Add your own: a refusal is read", () => {
  it.each([
    ["launcher.duplicate", 409, "That command is already a launcher."],
    ["launcher.adds_off", 403, "Adding launchers from a phone is turned off on this machine."],
    ["launcher.added_full", 409, "This machine already has"],
  ])("%s is said above Add, in the same box as the summary", async (code, status, words) => {
    serve();
    serveAdd([], { refuse: { code, status } });
    mount();
    await userEvent.click(await chip("Model: opus"));
    await userEvent.click(addButton());
    expect(await screen.findByTestId("launcher-add-error")).toHaveTextContent(words);
    expect(screen.getByTestId("launcher-add-error").closest('[data-active]')).not.toBeNull();
    // The summary is the other layer of the same cell, so nothing moved.
    expect(screen.getByTestId("launcher-add-summary").parentElement?.parentElement).toBe(
      screen.getByTestId("launcher-add-error").closest("[data-active]")?.parentElement,
    );
  });

  it("a change to the ask brings the summary back", async () => {
    serve();
    serveAdd([], { refuse: { code: "launcher.duplicate", status: 409 } });
    mount();
    await userEvent.click(await chip("Model: opus"));
    await userEvent.click(addButton());
    await screen.findByTestId("launcher-add-error");
    await userEvent.click(screen.getByRole("button", { name: "Continue last" }));
    await waitFor(() => expect(screen.getByTestId("launcher-add-summary").closest("[data-active]")).not.toBeNull());
  });
});

describe("Add your own: Write a command", () => {
  const writeWay = async () => userEvent.click(await screen.findByRole("radio", { name: "Write a command" }));
  const field = () => screen.getByRole("textbox", { name: "Command" });

  it("needs the line checked before Add, and shows hidden characters as codes with a caution", async () => {
    serve();
    const posts: Posted[] = [];
    serveAdd(posts);
    mount();
    await writeWay();
    fireEvent.change(field(), { target: { value: "claude​ --model opus" } });
    expect(addButton()).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Check the line" }));
    expect(screen.getByTestId("launcher-checked-line")).toHaveTextContent("claude⟨U+200B⟩ --model opus");
    expect(screen.getByText(/characters outside plain ASCII/)).toBeInTheDocument();
    expect(addButton()).toBeEnabled();
    // Editing the line takes the check back.
    fireEvent.change(field(), { target: { value: "claude --model opus" } });
    expect(addButton()).toBeDisabled();
  });

  it("a plain ASCII line has no caution", async () => {
    serve();
    mount();
    await writeWay();
    fireEvent.change(field(), { target: { value: "claude --model opus" } });
    await userEvent.click(screen.getByRole("button", { name: "Check the line" }));
    expect(screen.getByTestId("launcher-checked-line")).toHaveTextContent("claude --model opus");
    expect(screen.queryByText(/characters outside plain ASCII/)).toBeNull();
  });

  it("sends the line, the agent, the name and the skips-prompts tick", async () => {
    serve();
    const posts: Posted[] = [];
    serveAdd(posts);
    const router = mount();
    await writeWay();
    fireEvent.change(field(), { target: { value: "claude --yolo-ish" } });
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Which agent reads this line" }), "Codex");
    await userEvent.type(screen.getByRole("textbox", { name: /Name/ }), "My line");
    await userEvent.click(screen.getByRole("switch", { name: "This skips permission prompts" }));
    expect(liveBadges()).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Check the line" }));
    await userEvent.click(addButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    expect(posts[0]?.body).toEqual({
      text: "claude --yolo-ish",
      kind: "agent",
      harness: "codex",
      noPrompts: true,
      label: "My line",
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it("a Command is free text only: no agent select, and the body names no harness", async () => {
    serve();
    const posts: Posted[] = [];
    serveAdd(posts);
    const router = mount("/new/add?kind=command");
    const box = await screen.findByRole("textbox", { name: "Command" });
    expect(screen.queryByRole("combobox", { name: "Which agent reads this line" })).toBeNull();
    expect(screen.queryByRole("radio", { name: "Recipe" })).toBeNull();
    fireEvent.change(box, { target: { value: "make test" } });
    await userEvent.click(screen.getByRole("button", { name: "Check the line" }));
    await userEvent.click(addButton());
    await waitFor(() => expect(router.state.location.pathname).toBe("/new"));
    expect(posts[0]?.body).toEqual({ text: "make test", kind: "command", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  });
});

describe("Add your own: typed lines turned off", () => {
  it.each(["/new/add?kind=agent", "/new/add?kind=command"])("%s shows one disabled row with its reason, and Add stays off", async (entry) => {
    serve({ ...ADDING, freeText: false });
    mount(entry);
    if (entry.endsWith("agent")) await userEvent.click(await screen.findByRole("radio", { name: "Write a command" }));
    const off = await screen.findByTestId("launcher-add-off");
    expect(off).toHaveTextContent("Turned off on this machine");
    expect(off).toHaveTextContent("The operator turns this on in launchers.toml with [phone] free_text = true.");
    expect(addButton()).toBeDisabled();
  });

  it("names the machine on a crew", async () => {
    serve({ ...ADDING, freeText: false });
    mount("/new/add?kind=command&machine=mini", roster);
    expect(await screen.findByTestId("launcher-add-off")).toHaveTextContent("Turned off on minibuch");
  });

  it("the recipe way still adds", async () => {
    serve({ ...ADDING, freeText: false });
    mount();
    await userEvent.click(await chip("Model: opus"));
    expect(addButton()).toBeEnabled();
  });
});

describe("Add your own: adding turned off", () => {
  it("says so and Add stays off", async () => {
    serve({ ...ADDING, adds: false });
    mount();
    expect(await screen.findByText(/Adding is turned off on this machine/)).toBeInTheDocument();
    await userEvent.click(await chip("Model: opus"));
    expect(addButton()).toBeDisabled();
  });
});

describe("Add your own: the rows already added", () => {
  it("lists each added row with its label, line, who added it and the No prompts badge", async () => {
    serve();
    mount();
    const rows = await screen.findAllByTestId("launcher-added-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Claude, opus");
    expect(rows[0]).toHaveTextContent("claude --model opus");
    expect(rows[0]).toHaveTextContent("added by alice-phone");
    expect(rows[1]).toHaveTextContent("Claude, no prompts");
    expect(rows[1]?.querySelector('[data-slot="no-prompts-badge"]')).not.toBeNull();
    expect(rows[0]?.querySelector('[data-slot="no-prompts-badge"]')).toBeNull();
    expect(screen.getByText("Added on this machine")).toBeInTheDocument();
  });

  it("an operator row sits in the same list with a lock and 'From launchers.toml', and no actions", async () => {
    serve();
    mount();
    const row = await screen.findByTestId("launcher-operator-row");
    expect(row).toHaveTextContent("Run tests");
    expect(row).toHaveTextContent("From launchers.toml");
    expect(within(row).queryByRole("button")).toBeNull();
    expect(row.querySelector("svg")).not.toBeNull();
  });

  it("Rename swaps the label for a field, sends the new name, and reads the list again", async () => {
    serve();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/launchers/added/rename", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, row: { command: "claude --model opus", label: "Opus", source: "added", id: "row-1" } });
      }),
    );
    mount();
    const row = (await screen.findAllByTestId("launcher-added-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "Rename" }));
    const input = within(row).getByRole("textbox", { name: "New name for Claude, opus" });
    await userEvent.clear(input);
    await userEvent.type(input, "Opus");
    await userEvent.click(within(row).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "row-1", label: "Opus" }]));
    await waitFor(() => expect(within(row).queryByRole("textbox")).toBeNull());
  });

  it("Rename can be cancelled, and sends nothing", async () => {
    serve();
    const bodies: unknown[] = [];
    server.use(http.post("/api/launchers/added/rename", async ({ request }) => HttpResponse.json(bodies.push(await request.json()))));
    mount();
    const row = (await screen.findAllByTestId("launcher-added-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "Rename" }));
    await userEvent.click(within(row).getByRole("button", { name: "Cancel" }));
    expect(within(row).queryByRole("textbox")).toBeNull();
    expect(bodies).toHaveLength(0);
  });

  it("Remove asks first, in a sheet; Cancel removes nothing, Remove sends the id", async () => {
    serve();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/launchers/added/remove", async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ ok: true, removed: 1 });
      }),
    );
    mount();
    const row = (await screen.findAllByTestId("launcher-added-row"))[0]!;
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    const sheet = await screen.findByRole("dialog", { name: "Remove Claude, opus?" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Cancel" }));
    expect(bodies).toHaveLength(0);
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await userEvent.click(within(await screen.findByRole("dialog", { name: "Remove Claude, opus?" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(bodies).toEqual([{ id: "row-1" }]));
  });
});

describe("Add your own: how adding works", () => {
  it("opens a sheet with the recipe, Write a command and its switch, this machine's file, one example and the docs link", async () => {
    serve();
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "How adding works" }));
    const sheet = await screen.findByRole("dialog", { name: "How adding works" });
    expect(within(sheet).getByText(/Collie builds the line from a fixed table/)).toBeInTheDocument();
    expect(within(sheet).getByText("free_text = true")).toBeInTheDocument();
    expect(within(sheet).getByTestId("launcher-file")).toHaveTextContent(FILE);
    expect(within(sheet).getByRole("textbox", { name: "Example row for launchers.toml" })).toHaveValue(
      '[[launchers]]\ncommand = "claude --model opus"\nlabel = "Claude, opus"\nharness = "claude"',
    );
    expect(within(sheet).getByText(/lives on this machine only/)).toBeInTheDocument();
    expect(within(sheet).getByText(/Removing a device also removes the rows it added/)).toBeInTheDocument();
    expect(within(sheet).getByRole("link", { name: "How to add an agent" })).toHaveAttribute("href", expect.stringContaining("configure"));
  });

  it("Copy writes the example to the clipboard", async () => {
    serve();
    mount();
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await userEvent.click(await screen.findByRole("button", { name: "How adding works" }));
    const sheet = await screen.findByRole("dialog", { name: "How adding works" });
    await userEvent.click(within(sheet).getByRole("button", { name: /Copy/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('command = "claude --model opus"')));
    expect(await within(sheet).findByText("Copied")).toBeInTheDocument();
  });

  it("with no clipboard it selects the text so it can be copied by hand", async () => {
    serve();
    mount();
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
      configurable: true,
    });
    await userEvent.click(await screen.findByRole("button", { name: "How adding works" }));
    const sheet = await screen.findByRole("dialog", { name: "How adding works" });
    await userEvent.click(within(sheet).getByRole("button", { name: /Copy/ }));
    expect(await within(sheet).findByText(/copy it by hand/)).toBeInTheDocument();
    const box = within(sheet).getByRole("textbox", { name: "Example row for launchers.toml" });
    expect(box).toBeInstanceOf(HTMLTextAreaElement);
    if (!(box instanceof HTMLTextAreaElement)) return;
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(box.value.length);
  });
});
