import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { NewSpaceSheet, type BranchOffSetup, type WorktreeRepo } from "./new-space-sheet";
import { createWorktree } from "@/lib/api";
import { BRANCH_OFF_LAUNCHER_KEY } from "@/lib/branch-off";
import { CrewProvider } from "./crew-provider";
import { fixtureServers } from "@/test/handlers";
import { server } from "@/test/setup";
import { en } from "@/lib/i18n/messages/en";
import { clearStatus, useStatus } from "@/lib/status";
import type { Scope } from "@/lib/scope";
import type { Launcher, ServerSummary } from "@/lib/types";

// The host picker in the new-space sheet. Two claims, and the first is the important one:
//
//   1. A SOLO install renders nothing new. The predicate is `isMultiHost`, so a one-machine roster
//      (and no provider at all) is byte-identical to the sheet that shipped before crews existed.
//   2. On a crew the operator can never be unsure which machine the new shell is about to open on:
//      every member is listed, the one that will be used is marked, a member that is refusing
//      writes says so instead of vanishing, and what `onCreate` receives is what was picked.

const solo: ServerSummary[] = [fixtureServers[0]!];

function mount(servers: ServerSummary[] | undefined, props: { onCreate?: (opts: { label?: string; cwd?: string }, at?: Scope) => void; scope?: Scope } = {}) {
  return render(
    <CrewProvider servers={servers} ts={1_000} pollMs={3_000}>
      <NewSpaceSheet
        open
        onClose={() => {}}
        onCreate={props.onCreate ?? (() => {})}
        scope={props.scope}
      />
    </CrewProvider>,
  );
}

const hostRow = () => screen.queryByRole("radiogroup");
const chip = (name: RegExp | string) => screen.getByRole("radio", { name });

describe("NewSpaceSheet — the host picker's hide rule", () => {
  it("renders no host row on a one-machine roster", () => {
    mount(solo);
    expect(hostRow()).toBeNull();
  });

  it("renders no host row with no roster at all", () => {
    mount(undefined);
    expect(hostRow()).toBeNull();
  });

  it("still offers the create button on a solo install", () => {
    mount(solo);
    expect(screen.getByRole("button", { name: /create space/i })).toBeEnabled();
  });
});

describe("NewSpaceSheet — choosing the host on a crew", () => {
  it("lists every member, including the one that cannot take writes", () => {
    mount(fixtureServers);
    expect(hostRow()).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(3);
    expect(chip(/bluefin/)).toBeInTheDocument();
    expect(chip(/workshop/)).toBeInTheDocument();
    expect(chip(/attic/)).toBeInTheDocument();
  });

  it("defaults to the host the sheet was opened in", () => {
    mount(fixtureServers, { scope: { host: "workshop" } });
    expect(chip(/workshop/)).toHaveAttribute("aria-checked", "true");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "false");
  });

  it("defaults to the lead when the scope names no host", () => {
    mount(fixtureServers);
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("falls back to a writable member when the scope's host is refusing writes", () => {
    mount(fixtureServers, { scope: { host: "attic" } });
    expect(chip(/attic/)).toHaveAttribute("aria-checked", "false");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("marks the refusing member disabled with its own reason, and refuses the tap", async () => {
    const user = userEvent.setup();
    mount(fixtureServers);
    const attic = chip(/attic/);
    expect(attic).toHaveAttribute("aria-disabled", "true");
    expect(attic).toHaveAccessibleName(/incompatible/i);
    await user.click(attic);
    expect(attic).toHaveAttribute("aria-checked", "false");
    expect(chip(/bluefin/)).toHaveAttribute("aria-checked", "true");
  });

  it("hands the chosen member to onCreate as the scope the create is addressed to", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(fixtureServers, { onCreate, scope: { session: "work" } });
    await user.click(chip(/workshop/));
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith(
      { label: undefined, cwd: undefined },
      { session: "work", host: "workshop" },
    );
  });

  it("addresses a create on the LEAD with no host at all, so the URL stays bare", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(fixtureServers, { onCreate, scope: { host: "workshop" } });
    await user.click(chip(/bluefin/));
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith(expect.anything(), { host: undefined });
  });

  it("passes NO scope override on a solo install, leaving the ambient one alone", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    mount(solo, { onCreate, scope: { host: "bluefin" } });
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith({ label: undefined, cwd: undefined }, undefined);
  });

  // Needs a roster with NO lead in it — the lead's own health is tier 1's answer and always
  // writable (lib/host-health.ts) — which is the degenerate snapshot a departed lead leaves behind.
  it("refuses the create outright when no member is taking writes", () => {
    const refusing: ServerSummary[] = [
      { ...fixtureServers[1]!, reachable: false, lastSeenAt: 900 },
      fixtureServers[2]!,
    ];
    mount(refusing);
    expect(screen.getByRole("button", { name: /create space/i })).toBeDisabled();
    expect(screen.getByText(/workshop is unreachable/i)).toBeInTheDocument();
  });
});

// ── Favourite and recent folders (#289, M40/02) ─────────────────────────────────────────────────
// The list is each machine's own, kept by its bridge (`GET /api/folders`, forwarded on `?host=`).
// What the sheet owes it: Favourites then Recent for the machine the picker chose, a tap that fills
// the field and creates nothing, a star that moves a folder between the two, home never drawn, and a
// machine that has no list (an older peer's 404) rendering exactly the sheet that shipped before.

/** The folder body one machine answers. */
function foldersOf(recent: string[], favourites: string[] = [], home = "/home/you") {
  return { recent, favourites, home };
}

/** Answer `GET /api/folders` per machine (`?host=`, absent = the lead), recording every read. */
function serveFolders(byHost: Record<string, ReturnType<typeof foldersOf> | 404>) {
  const reads: string[] = [];
  server.use(
    http.get("/api/folders", ({ request }) => {
      const host = new URL(request.url).searchParams.get("host") ?? "";
      reads.push(host);
      const answer = byHost[host];
      if (answer === undefined || answer === 404) {
        return HttpResponse.json({ error: "not found" }, { status: 404 });
      }
      return HttpResponse.json(answer);
    }),
  );
  return reads;
}

/** The status line, as the floating layer would draw it — to prove a quiet 404 says nothing. */
function StatusProbe() {
  const status = useStatus();
  return status === null ? null : <p data-probe="status">{status.text}</p>;
}

const list = (name: string) => screen.queryByRole("list", { name });
const dirField = () => screen.getByPlaceholderText(en["space.new.dir.placeholder"]);

describe("NewSpaceSheet — folders", () => {
  beforeEach(() => clearStatus());

  it("folders: nothing stored renders the sheet exactly as before", async () => {
    const reads = serveFolders({ "": foldersOf([]) });
    mount(solo);
    await waitFor(() => expect(reads).toEqual([""]));
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(en["space.new.folders.recent"])).toBeNull();
    expect(screen.queryByText(en["space.new.folders.favourites"])).toBeNull();
  });

  it("folders: lists Favourites, then Recent, each row a name over its shortened path", async () => {
    serveFolders({ "": foldersOf(["/home/you/src/web", "/srv/api"], ["/home/you/notes"]) });
    mount(solo);
    const favourites = await screen.findByRole("list", { name: en["space.new.folders.favourites"] });
    const recent = list(en["space.new.folders.recent"])!;
    // Favourites comes first in the sheet.
    expect(favourites.compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(favourites).getAllByRole("listitem")).toHaveLength(1);
    const rows = within(recent).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("web~/src/web");
    expect(rows[1]).toHaveTextContent("api/srv/api");
    expect(within(recent).getByRole("button", { name: "Use ~/src/web" })).toBeInTheDocument();
  });

  it("folders: sits directly under the Directory field, above the label", async () => {
    serveFolders({ "": foldersOf(["/srv/api"]) });
    mount(solo);
    const recent = await screen.findByRole("list", { name: en["space.new.folders.recent"] });
    const label = screen.getByPlaceholderText(en["space.new.label.placeholder"]);
    expect(dirField().compareDocumentPosition(recent) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(recent.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("folders: home is never drawn, even when the machine's file holds it", async () => {
    serveFolders({ "": foldersOf(["/home/you", "/srv/api"], ["/home/you/"]) });
    mount(solo);
    const recent = await screen.findByRole("list", { name: en["space.new.folders.recent"] });
    expect(within(recent).getAllByRole("listitem")).toHaveLength(1);
    expect(list(en["space.new.folders.favourites"])).toBeNull();
    expect(screen.queryByRole("button", { name: "Use ~" })).toBeNull();
  });

  it("folders: a tap fills the field with the full path, moves to Create, and creates nothing", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn();
    serveFolders({ "": foldersOf(["/home/you/src/web"]) });
    mount(solo, { onCreate });
    await user.click(await screen.findByRole("button", { name: "Use ~/src/web" }));
    expect(dirField()).toHaveValue("/home/you/src/web");
    expect(screen.getByRole("button", { name: /create space/i })).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
    // The create that follows sends the filled folder, and nothing else changed about it.
    await user.click(screen.getByRole("button", { name: /create space/i }));
    expect(onCreate).toHaveBeenCalledWith({ label: undefined, cwd: "/home/you/src/web" }, undefined);
  });

  it("folders: a star moves a Recent folder to Favourites, and an unstar moves it back", async () => {
    const user = userEvent.setup();
    serveFolders({ "": foldersOf(["/srv/api", "/srv/web"]) });
    const sent: unknown[] = [];
    server.use(
      http.post("/api/folders/star", async ({ request }) => {
        // SAFETY: the only caller of this route is `lib/api.ts`'s `starFolder`, which posts exactly
        // `{ folder, starred }` (its `StarFolderBody`); the assertions below read both fields back.
        const body = (await request.json()) as { folder: string; starred: boolean };
        sent.push(body);
        return HttpResponse.json(
          body.starred ? foldersOf(["/srv/web"], ["/srv/api"]) : foldersOf(["/srv/api", "/srv/web"]),
        );
      }),
    );
    mount(solo);
    const star = await screen.findByRole("button", { name: "Add /srv/api to favourites" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    expect(sent).toEqual([{ folder: "/srv/api", starred: true }]);
    const favourites = await screen.findByRole("list", { name: en["space.new.folders.favourites"] });
    const unstar = within(favourites).getByRole("button", { name: "Remove /srv/api from favourites" });
    expect(unstar).toHaveAttribute("aria-pressed", "true");
    expect(within(list(en["space.new.folders.recent"])!).getAllByRole("listitem")).toHaveLength(1);

    await user.click(unstar);
    expect(sent).toEqual([
      { folder: "/srv/api", starred: true },
      { folder: "/srv/api", starred: false },
    ]);
    await waitFor(() =>
      expect(within(list(en["space.new.folders.recent"])!).getAllByRole("listitem")).toHaveLength(2),
    );
  });

  it("folders: a refused star says why and re-reads the list", async () => {
    const user = userEvent.setup();
    const reads = serveFolders({ "": foldersOf(["/srv/api"]) });
    server.use(
      http.post("/api/folders/star", () =>
        HttpResponse.json(
          { error: "/srv/api is not in Recent, so it cannot be starred", code: "folders.unknown", detail: { folder: "/srv/api" } },
          { status: 409 },
        ),
      ),
    );
    render(
      <>
        <StatusProbe />
        <CrewProvider servers={solo} ts={1_000} pollMs={3_000}>
          <NewSpaceSheet open onClose={() => {}} onCreate={() => {}} />
        </CrewProvider>
      </>,
    );
    await user.click(await screen.findByRole("button", { name: "Add /srv/api to favourites" }));
    expect(await screen.findByText(en["apiError.folders.unknown"])).toBeInTheDocument();
    await waitFor(() => expect(reads).toEqual(["", ""]));
  });

  it("folders: on a crew, each machine shows its own list, and a machine change swaps it", async () => {
    const user = userEvent.setup();
    const reads = serveFolders({
      "": foldersOf(["/home/you/lead-only"]),
      workshop: foldersOf(["/home/w/peer-only"], [], "/home/w"),
    });
    mount(fixtureServers);
    expect(await screen.findByRole("button", { name: "Use ~/lead-only" })).toBeInTheDocument();
    await user.click(chip(/workshop/));
    // The peer's list, shortened against the PEER's own home; the lead's is gone.
    expect(await screen.findByRole("button", { name: "Use ~/peer-only" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use ~/lead-only" })).toBeNull());
    expect(reads).toEqual(["", "workshop"]);
  });

  it("folders: a tap on the previous machine's row while it fades out fills nothing", async () => {
    const user = userEvent.setup();
    serveFolders({ "": foldersOf(["/home/you/lead-only"]), workshop: 404 });
    mount(fixtureServers);
    const leadRow = await screen.findByRole("button", { name: "Use ~/lead-only" });
    await user.click(chip(/workshop/));
    // The Collapse holds the lead's rows through its 240ms exit; a tap there must not reach the field.
    expect(leadRow).toBeInTheDocument();
    await user.click(leadRow);
    expect(dirField()).toHaveValue("");
    await waitFor(() => expect(leadRow).not.toBeInTheDocument());
  });

  it("folders: an older peer's 404 shows no list and no error", async () => {
    const user = userEvent.setup();
    const reads = serveFolders({ "": foldersOf([]), workshop: 404 });
    render(
      <>
        <StatusProbe />
        <CrewProvider servers={fixtureServers} ts={1_000} pollMs={3_000}>
          <NewSpaceSheet open onClose={() => {}} onCreate={() => {}} />
        </CrewProvider>
      </>,
    );
    await user.click(chip(/workshop/));
    await waitFor(() => expect(reads).toContain("workshop"));
    expect(screen.queryByRole("list")).toBeNull();
    expect(document.querySelector('[data-probe="status"]')).toBeNull();
    // And the create still works on that machine, exactly as before.
    expect(screen.getByRole("button", { name: /create space/i })).toBeEnabled();
  });
});

// "New agent on a branch" (ADR 0089): the same sheet, opened from a pane's ⋯ menu. It opens on the
// worktree side with the pane's repo chosen, a fresh branch typed and an agent picker, and it holds
// ONE create per opening however often the button is tapped.
describe("NewSpaceSheet — New agent on a branch", () => {
  const CLAUDE: Launcher = { command: "claude", label: "Claude" };
  const CODEX: Launcher = { command: "codex --full-auto", label: "Codex" };
  const repos: WorktreeRepo[] = [
    { workspaceId: "w1", repoRoot: "/src/api", label: "api" },
    { workspaceId: "w2", repoRoot: "/src/web", label: "web" },
  ];
  type OnCreate = BranchOffSetup["onCreate"];

  beforeEach(() => localStorage.removeItem(BRANCH_OFF_LAUNCHER_KEY));

  function mountBranchOff(
    onCreate: OnCreate,
    opts: { launchers?: Launcher[]; servers?: ServerSummary[]; onClose?: () => void } = {},
  ) {
    const props = (launchers: Launcher[], open = true) => (
      <CrewProvider servers={opts.servers} ts={1_000} pollMs={3_000}>
        <NewSpaceSheet
          open={open}
          onClose={opts.onClose ?? (() => {})}
          onCreate={() => {}}
          repos={repos}
          branchOff={{ workspaceId: "w2", launchers, onCreate }}
        />
      </CrewProvider>
    );
    const view = render(props(opts.launchers ?? [CLAUDE, CODEX]));
    return { ...view, rerenderWith: (launchers: Launcher[], open = true) => view.rerender(props(launchers, open)) };
  }

  const branchField = () => screen.getByDisplayValue<HTMLInputElement>(/^worktree\//u);
  const picker = () => screen.getByRole("combobox", { name: "Agent" });
  const createButton = () => screen.getByRole("button", { name: /^(Create|Creating…)$/u });

  it("opens on the worktree side, on the pane's repo, with a fresh branch typed", () => {
    mountBranchOff(vi.fn(async () => true), { servers: fixtureServers });
    expect(screen.getByRole("dialog", { name: "New agent on a branch" })).toBeInTheDocument();
    // No tab strip and no host row: a branch-off is a worktree, and the pane fixed the machine.
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.getByRole("combobox", { name: "Repository" })).toHaveValue("w2");
    expect(branchField().value).toMatch(/^worktree\/[a-z]+-[a-z]+-[0-9a-f]{4}$/u);
  });

  it("keeps the branch editable", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<OnCreate>(async () => true);
    mountBranchOff(onCreate);
    await user.clear(branchField());
    await user.type(screen.getByPlaceholderText("feature/my-change"), "feature/login");
    await user.click(createButton());
    expect(onCreate).toHaveBeenCalledWith("w2", "feature/login", expect.anything());
  });

  it("offers a plain shell and every launcher row, and defaults to the shell", () => {
    mountBranchOff(vi.fn(async () => true));
    const options = within(picker()).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Shell", "Claude", "Codex"]);
    expect(picker()).toHaveValue("");
  });

  it("defaults to the agent used last time", () => {
    localStorage.setItem(BRANCH_OFF_LAUNCHER_KEY, "codex --full-auto");
    mountBranchOff(vi.fn(async () => true));
    expect(picker()).toHaveValue("codex --full-auto");
  });

  it("picks up the remembered agent when the rows land after the sheet opened", () => {
    localStorage.setItem(BRANCH_OFF_LAUNCHER_KEY, "claude");
    const { rerenderWith } = mountBranchOff(vi.fn(async () => true), { launchers: [] });
    expect(picker()).toHaveValue("");
    rerenderWith([CLAUDE, CODEX]);
    expect(picker()).toHaveValue("claude");
  });

  it("remembers the agent it was asked to start", async () => {
    const user = userEvent.setup();
    mountBranchOff(vi.fn(async () => true));
    await user.selectOptions(picker(), "claude");
    await user.click(createButton());
    expect(localStorage.getItem(BRANCH_OFF_LAUNCHER_KEY)).toBe("claude");
  });

  it("sends the branch, a request id and the launcher's command to the bridge", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    server.use(
      http.post("/api/workspace/:id/worktree", async ({ request, params }) => {
        bodies.push({ id: params.id, body: await request.json() });
        return HttpResponse.json({
          ok: true,
          alreadyOpen: false,
          launcherStarted: true,
          pane: { paneId: "w9:p1", workspaceId: "w9", workspaceLabel: "web-x", tabId: "w9:t1", cwd: "/src/web/x" },
        });
      }),
    );
    const onCreate: OnCreate = async (workspaceId, branch, extras) =>
      (await createWorktree(workspaceId, branch, undefined, extras)).ok;
    mountBranchOff(onCreate);
    const branch = branchField().value;
    await user.selectOptions(picker(), "claude");
    await user.click(createButton());
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toEqual({
      id: "w2",
      body: {
        branch,
        requestId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
        launcher: "claude",
      },
    });
  });

  it("sends no launcher for the shell", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn<OnCreate>(async () => true);
    mountBranchOff(onCreate);
    await user.click(createButton());
    expect(onCreate).toHaveBeenCalledWith("w2", expect.any(String), {
      requestId: expect.any(String),
      launcher: undefined,
    });
  });

  it("holds one create however often the button is tapped, and shows it is busy", async () => {
    const user = userEvent.setup();
    let finish: (moved: boolean) => void = () => {};
    const onCreate = vi.fn<OnCreate>(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    mountBranchOff(onCreate, { onClose });
    const button = createButton();
    await user.click(button);
    await user.click(button);
    fireEvent.click(button);
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName("Creating…");
    // The sheet stays open while the create runs, and closes once the phone has moved.
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(true));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("a retry after a failed create carries the same request id; a new opening mints a new one", async () => {
    const user = userEvent.setup();
    const ids: string[] = [];
    const onCreate = vi.fn<OnCreate>(async (_w, _b, extras) => {
      ids.push(extras.requestId);
      return false;
    });
    const { rerenderWith } = mountBranchOff(onCreate);
    await user.click(createButton());
    await waitFor(() => expect(createButton()).toBeEnabled());
    await user.click(createButton());
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);

    rerenderWith([CLAUDE, CODEX], false);
    rerenderWith([CLAUDE, CODEX], true);
    await user.click(createButton());
    expect(ids).toHaveLength(3);
    expect(ids[2]).not.toBe(ids[0]);
  });
});
