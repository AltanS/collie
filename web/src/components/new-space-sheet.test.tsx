import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { NewSpaceSheet } from "./new-space-sheet";
import { CrewProvider } from "./crew-provider";
import { fixtureServers } from "@/test/handlers";
import { server } from "@/test/setup";
import { en } from "@/lib/i18n/messages/en";
import { clearStatus, useStatus } from "@/lib/status";
import type { OpenPanes } from "@/lib/folders";
import type { Scope } from "@/lib/scope";
import type { AgentView, ServerSummary } from "@/lib/types";

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

// ── Open now (#289, option B2) ───────────────────────────────────────────────────────────────────
// The third section: the folders the chosen machine's panes sit in right now, off the snapshot the
// sheet was handed, in the dashboard's place order. No request of its own; the star is the same
// route, which the bridge now lets name a folder a pane sits in.

/** A pane of the snapshot, with only what Open now reads varying. */
function openPane(paneId: string, cwd: string, over: Partial<AgentView> = {}): AgentView {
  const workspaceId = paneId.split(":")[0]!;
  return {
    paneId,
    workspaceId,
    workspaceLabel: workspaceId,
    workspaceNumber: Number(workspaceId.slice(1)),
    tabId: `${workspaceId}:t1`,
    agent: "claude",
    status: "idle",
    cwd,
    focused: false,
    ...over,
  };
}

function mountWithPanes(servers: ServerSummary[] | undefined, panes: OpenPanes, onCreate = vi.fn()) {
  const view = (p: OpenPanes) => (
    <CrewProvider servers={servers} ts={1_000} pollMs={3_000}>
      <NewSpaceSheet open onClose={() => {}} onCreate={onCreate} panes={p} />
    </CrewProvider>
  );
  const r = render(view(panes));
  return { rerenderWith: (p: OpenPanes) => r.rerender(view(p)), onCreate };
}

const openList = () => list(en["space.new.folders.open"]);
const openRows = async () => within(await screen.findByRole("list", { name: en["space.new.folders.open"] })).getAllByRole("listitem");

describe("NewSpaceSheet — Open now", () => {
  beforeEach(() => clearStatus());

  it("open now: lists the machine's pane folders after Recent, in place order, without home or a listed folder", async () => {
    serveFolders({ "": foldersOf(["/home/you/recent"], ["/home/you/fav"]) });
    mountWithPanes(solo, {
      agents: [
        openPane("w2:p1", "/home/you/two"),
        openPane("w1:p1", "/home/you/one"),
        openPane("w3:p1", "/home/you/fav/"),
        openPane("w4:p1", "/home/you"),
      ],
      shellPanes: [openPane("w1:p2", "/home/you/one", { kind: "shell", tabPosition: 1 }), openPane("w5:p1", "/home/you/recent", { kind: "shell" })],
    });
    const rows = await openRows();
    expect(rows.map((r) => r.textContent)).toEqual(["one~/one", "two~/two"]);
    const recent = list(en["space.new.folders.recent"])!;
    expect(recent.compareDocumentPosition(openList()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Use ~" })).toBeNull();
  });

  it("open now: at most eight rows", async () => {
    serveFolders({ "": foldersOf([]) });
    mountWithPanes(solo, {
      agents: Array.from({ length: 10 }, (_, i) => openPane(`w${i + 1}:p1`, `/srv/p${i}`)),
      shellPanes: [],
    });
    const rows = await openRows();
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent("/srv/p0");
    expect(rows[7]).toHaveTextContent("/srv/p7");
  });

  it("open now: none for a machine whose panes report no folder, and the sheet is as before", async () => {
    const reads = serveFolders({ "": foldersOf([]) });
    mountWithPanes(solo, { agents: [openPane("w1:p1", "")], shellPanes: [openPane("w1:p2", "", { kind: "shell" })] });
    await waitFor(() => expect(reads).toEqual([""]));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("open now: none when the machine's list could not be read", async () => {
    const reads = serveFolders({ "": 404 });
    mountWithPanes(solo, { agents: [openPane("w1:p1", "/srv/open")], shellPanes: [] });
    await waitFor(() => expect(reads).toEqual([""]));
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("open now: on a crew, only the chosen machine's panes", async () => {
    const user = userEvent.setup();
    serveFolders({ "": foldersOf([]), workshop: foldersOf([], [], "/home/w") });
    mountWithPanes(fixtureServers, {
      agents: [
        openPane("w1:p1", "/home/you/lead-a", { host: "bluefin" }),
        openPane("w1:p1", "/home/w/peer-a", { host: "workshop" }),
        openPane("w2:p1", "/home/you/lead-b", { host: "bluefin" }),
      ],
      shellPanes: [],
    });
    expect((await openRows()).map((r) => r.textContent)).toEqual(["lead-a~/lead-a", "lead-b~/lead-b"]);
    await user.click(chip(/workshop/));
    expect(await screen.findByRole("button", { name: "Use ~/peer-a" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use ~/lead-a" })).toBeNull());
    expect((await openRows()).map((r) => r.textContent)).toEqual(["peer-a~/peer-a"]);
  });

  it("open now: a tap fills the field and creates nothing", async () => {
    const user = userEvent.setup();
    serveFolders({ "": foldersOf([]) });
    const { onCreate } = mountWithPanes(solo, { agents: [openPane("w1:p1", "/home/you/src/web")], shellPanes: [] });
    await user.click(await screen.findByRole("button", { name: "Use ~/src/web" }));
    expect(dirField()).toHaveValue("/home/you/src/web");
    expect(screen.getByRole("button", { name: /create space/i })).toHaveFocus();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("open now: a star calls the route, and the folder moves to Favourites", async () => {
    const user = userEvent.setup();
    serveFolders({ "": foldersOf([]) });
    const sent: unknown[] = [];
    server.use(
      http.post("/api/folders/star", async ({ request }) => {
        // SAFETY: the only caller of this route is `lib/api.ts`'s `starFolder`, which posts exactly
        // `{ folder, starred }`; the assertion below reads both fields back.
        const body = (await request.json()) as { folder: string; starred: boolean };
        sent.push(body);
        return HttpResponse.json(foldersOf([], [body.folder]));
      }),
    );
    mountWithPanes(solo, {
      agents: [openPane("w1:p1", "/home/you/src/web"), openPane("w2:p1", "/home/you/src/api")],
      shellPanes: [],
    });
    const star = await screen.findByRole("button", { name: "Add ~/src/web to favourites" });
    expect(star).toHaveAttribute("aria-pressed", "false");
    await user.click(star);
    expect(sent).toEqual([{ folder: "/home/you/src/web", starred: true }]);
    const favourites = await screen.findByRole("list", { name: en["space.new.folders.favourites"] });
    expect(within(favourites).getByRole("button", { name: "Remove ~/src/web from favourites" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(within(openList()!).getAllByRole("listitem")).toHaveLength(1));
    expect(within(openList()!).getByRole("button", { name: "Use ~/src/api" })).toBeInTheDocument();
  });

  it("open now: a poll while the sheet is up moves no row", async () => {
    serveFolders({ "": foldersOf([]) });
    const { rerenderWith } = mountWithPanes(solo, { agents: [openPane("w1:p1", "/srv/one")], shellPanes: [] });
    expect((await openRows()).map((r) => r.textContent)).toEqual(["one/srv/one"]);
    // A pane opened and the first one closed since the list was read: the section keeps what it drew.
    rerenderWith({ agents: [openPane("w2:p1", "/srv/two")], shellPanes: [] });
    expect((await openRows()).map((r) => r.textContent)).toEqual(["one/srv/one"]);
  });
});
