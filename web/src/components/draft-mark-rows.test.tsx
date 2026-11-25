import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { AgentCard } from "./agent-card";
import { AgentList } from "./agent-list";
import { ActionsButton, ActionsPaletteDoor } from "./actions-palette";
import { ThreadSidebar } from "./agent-sidebar";
import { SpaceView } from "./space-view";
import { __resetActionsPalette } from "@/lib/actions-palette/state";
import { paneRowKey } from "@/lib/hosts";
import { clearDraft, saveDraft, __resetDraftPrune } from "@/lib/drafts";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { __resetPins } from "@/lib/pins";
import { forgetRecentPanes } from "@/lib/recent-panes";
import { fixtureAgents, fixtureCrewAgents, fixtureServers, fixtureTabs, fixtureWorkspaces } from "@/test/handlers";
import type { AgentView } from "@/lib/types";

// THE PENCIL ON A ROW (ui/draft-mark.tsx): every list of panes draws it, from the one mark, while this device holds
// an unsent composer draft for the pane. The store's own cases are in lib/drafts-live.test.tsx.

const pane = (over: Partial<AgentView> = {}): AgentView => ({ ...fixtureAgents[0]!, ...over });
const A = pane({ paneId: "w1:p1", paneLabel: "alpha" });
const B = pane({ paneId: "w1:p2", paneLabel: "bravo", tabId: "w1:t1" });

const pencils = (root: HTMLElement | Document = document) => root.querySelectorAll('[data-slot="draft-mark"][data-on="true"]');
const slots = (root: HTMLElement | Document = document) => root.querySelectorAll('[data-slot="draft-mark"]');
const PENCIL = { name: "Unsent draft" };

beforeAll(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  localStorage.clear();
  __resetDraftPrune();
  __resetPins();
  forgetRecentPanes();
});
afterEach(() => {
  cleanup();
  __resetActionsPalette();
});

describe("the dashboard's row (AgentCard)", () => {
  it("shows the pencil on the row of a pane with a draft, and none on a pane without", () => {
    saveDraft(undefined, "w1:p1", "half a reply");
    render(
      <>
        <AgentCard agent={A} onClick={() => {}} density="row" />
        <AgentCard agent={B} onClick={() => {}} density="row" />
      </>,
    );
    const rows = document.querySelectorAll<HTMLElement>('[data-slot="agent-row-title"]');
    expect(within(rows[0]!).getByRole("img", PENCIL)).toBeInTheDocument();
    expect(within(rows[1]!).queryByRole("img", PENCIL)).toBeNull();
  });

  it("shows none for an empty or blank draft", () => {
    saveDraft(undefined, "w1:p1", "   \n ");
    render(<AgentCard agent={A} onClick={() => {}} density="row" />);
    expect(screen.queryByRole("img", PENCIL)).toBeNull();
  });

  it("shows it for a draft with only an attachment", () => {
    saveDraft(undefined, "w1:p1", "", [{ n: 1, path: "/tmp/shot.png", name: "shot.png", kind: "image" }], 2);
    render(<AgentCard agent={A} onClick={() => {}} density="row" />);
    expect(screen.getByRole("img", PENCIL)).toBeInTheDocument();
  });

  it("comes and goes live, and its slot is kept so the name never moves", () => {
    render(<AgentCard agent={A} onClick={() => {}} density="row" />);
    expect(pencils()).toHaveLength(0);
    // The flat row keeps the slot, drawn invisible and hidden from a screen reader.
    expect(slots()).toHaveLength(1);
    expect(slots()[0]).toHaveAttribute("aria-hidden", "true");
    act(() => saveDraft(undefined, "w1:p1", "typed"));
    expect(screen.getByRole("img", PENCIL)).toBeInTheDocument();
    act(() => clearDraft(undefined, "w1:p1"));
    expect(screen.queryByRole("img", PENCIL)).toBeNull();
  });

  it("is muted ink, never the blocked red, with no count", () => {
    saveDraft(undefined, "w1:p1", "typed");
    render(<AgentCard agent={pane({ paneId: "w1:p1", status: "blocked" })} onClick={() => {}} density="row" />);
    const mark = screen.getByRole("img", PENCIL);
    expect(mark.getAttribute("class")).toContain("text-muted-foreground");
    expect(mark.getAttribute("class")).not.toContain("status-blocked");
    expect(mark).toHaveTextContent("");
  });

  it("reads the draft under the address the pane's composer saves it under", () => {
    saveDraft({ host: "workshop" }, "w1:p1", "on the other machine");
    const { rerender } = render(<AgentCard agent={A} onClick={() => {}} density="row" />);
    expect(screen.queryByRole("img", PENCIL)).toBeNull();
    rerender(<AgentCard agent={A} onClick={() => {}} density="row" draftScope={{ host: "workshop" }} />);
    expect(screen.getByRole("img", PENCIL)).toBeInTheDocument();
  });
});

describe("the dashboard's list (AgentList)", () => {
  it("marks a row by the pane's own address: the same id on two machines is two panes", () => {
    // `w1:p1` is on the lead (lodge, whose own id is no part of the address) and on workshop.
    saveDraft({ host: "workshop" }, "w1:p1", "on workshop");
    render(<AgentList agents={fixtureCrewAgents} bridge="connected" onOpen={() => {}} servers={fixtureServers} scope={{}} />);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="agent-row-title"]')];
    const marked = rows.filter((row) => row.querySelector('[data-slot="draft-mark"][data-on="true"]'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent(/moonward|codex/);
  });

  it("marks the lead's pane under the bare scope, as its composer saves it", () => {
    saveDraft(undefined, "w1:p1", "on the lead");
    render(<AgentList agents={fixtureCrewAgents} bridge="connected" onOpen={() => {}} servers={fixtureServers} scope={{}} />);
    expect(pencils()).toHaveLength(1);
  });
});

describe("a space's rows (SpaceView)", () => {
  it("shows the pencil on the row of a pane with a draft", () => {
    saveDraft(undefined, "w2:p1", "half a reply");
    render(
      <SpaceView
        workspace={fixtureWorkspaces[1]!}
        tabs={fixtureTabs}
        agents={fixtureAgents}
        shellPanes={[]}
        selectedTab={null}
        onOpen={() => {}}
        scope={{}}
      />,
    );
    expect(pencils()).toHaveLength(1);
  });
});

describe("the sidebar and the Switch pane sheet (ThreadSidebar)", () => {
  const sidebar = (current: string, over: Partial<React.ComponentProps<typeof ThreadSidebar>> = {}) =>
    render(<ThreadSidebar agents={[A, B]} currentPaneKey={current} onSelect={() => {}} scope={{}} {...over} />);
  const rowOf = (id: string) =>
    [...document.querySelectorAll<HTMLElement>('[data-slot="pane-row"]')].find((row) => row.getAttribute("data-pane-key") === paneRowKey({ paneId: id }))!;

  it("shows the pencil on the row of a pane with a draft", () => {
    saveDraft(undefined, "w1:p2", "half a reply");
    sidebar("");
    expect(within(rowOf("w1:p2")).getByRole("img", PENCIL)).toBeInTheDocument();
    expect(within(rowOf("w1:p1")).queryByRole("img", PENCIL)).toBeNull();
  });

  it("does not show it on the row of the pane that is open: its composer is on screen", () => {
    saveDraft(undefined, "w1:p1", "half a reply");
    saveDraft(undefined, "w1:p2", "another");
    sidebar(paneRowKey({ paneId: "w1:p1" }));
    expect(within(rowOf("w1:p1")).queryByRole("img", PENCIL)).toBeNull();
    expect(within(rowOf("w1:p2")).getByRole("img", PENCIL)).toBeInTheDocument();
  });

  it("shows none for a blank draft and one for a draft of only a chip", () => {
    saveDraft(undefined, "w1:p1", "  ");
    saveDraft(undefined, "w1:p2", "", [{ n: 1, path: "/tmp/a.txt", name: "a.txt", kind: "file" }], 2);
    sidebar("");
    expect(within(rowOf("w1:p1")).queryByRole("img", PENCIL)).toBeNull();
    expect(within(rowOf("w1:p2")).getByRole("img", PENCIL)).toBeInTheDocument();
  });

  it("keeps a slot on every row, so no name moves when a pencil comes", () => {
    sidebar("");
    expect(slots(rowOf("w1:p1"))).toHaveLength(1);
    expect(slots(rowOf("w1:p2"))).toHaveLength(1);
    act(() => saveDraft(undefined, "w1:p1", "typed"));
    expect(pencils()).toHaveLength(1);
    act(() => saveDraft(undefined, "w1:p1", ""));
    expect(pencils()).toHaveLength(0);
  });

  it("marks a pane of another machine by that machine's address", () => {
    saveDraft({ host: "workshop" }, "w1:p1", "on workshop");
    const crew = [fixtureCrewAgents[0]!, fixtureCrewAgents[2]!];
    sidebar("", { agents: crew, servers: fixtureServers });
    const rows = [...document.querySelectorAll<HTMLElement>('[data-slot="pane-row"]')];
    const marked = rows.filter((row) => row.querySelector('[data-slot="draft-mark"][data-on="true"]'));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toHaveTextContent("moonward");
  });
});

describe("the Actions palette's pane rows", () => {
  function mount(openPane: AgentView | undefined) {
    const panes = [A, B];
    const router = createMemoryRouter(
      [
        {
          id: ROOT_ROUTE_ID,
          path: "*",
          loader: () => null,
          element: (
            <>
              <ActionsButton />
              <ActionsPaletteDoor scope={{}} openPane={openPane} />
            </>
          ),
        },
      ],
      {
        initialEntries: ["/"],
        hydrationData: {
          loaderData: {
            [ROOT_ROUTE_ID]: {
              agents: panes,
              shellPanes: [],
              workspaces: [{ workspaceId: "w1", number: 1, label: "webapp", focused: true, activeTabId: "w1:t1", tabCount: 1, paneCount: 2 }],
              tabs: [],
              scope: {},
            },
          },
        },
      },
    );
    render(<RouterProvider router={router} />);
  }

  it("marks the All panes rows, and leaves the open pane's row bare", async () => {
    saveDraft(undefined, "w1:p1", "half a reply");
    saveDraft(undefined, "w1:p2", "another");
    mount(A);
    await userEvent.setup().click(screen.getByRole("button", { name: "Actions" }));
    const dialog = screen.getByRole("dialog", { name: "Actions" });
    const all = dialog.querySelector<HTMLElement>('[data-slot="actions-all-panes"]')!;
    const rowOf = (id: string) =>
      [...all.querySelectorAll<HTMLElement>('[data-slot="pane-row"]')].find((row) => row.getAttribute("data-pane-key") === paneRowKey({ paneId: id }))!;
    expect(within(rowOf("w1:p2")).getByRole("img", PENCIL)).toBeInTheDocument();
    expect(within(rowOf("w1:p1")).queryByRole("img", PENCIL)).toBeNull();
  });
});
