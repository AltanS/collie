import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import type { ReactNode } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { CrewProvider } from "@/components/crew-provider";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import { server } from "@/test/setup";
import type { ServerSummary, WorktreeFolderSettingResponse } from "@/lib/types";

import { WorktreeFolderControl } from "./worktree-folder-control";

// The Worktree folder card: one row per machine, each read and written through that machine's scope,
// "Default" while unset, a refusal said in the editor, and the old rule back through "Use the default".

const FALLBACK = "/home/op/.herdr/worktrees";
const UNSET: WorktreeFolderSettingResponse = { ok: true, dir: null, fallback: FALLBACK };

let reads: (string | null)[];
let posts: { host: string | null; dir: string | null }[];

beforeEach(() => {
  reads = [];
  posts = [];
  server.use(
    http.get("/api/folders", () => HttpResponse.json({ recent: [], favourites: [], home: "/home/op" })),
    http.get("/api/folders/browse", () => HttpResponse.json({ error: "no" }, { status: 404 })),
  );
});

/** The card lives under the root route in the app, so it reads the root's data. */
function renderCard(node: ReactNode) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: node, loader: () => ({}) }], {
    initialEntries: ["/"],
  });
  return render(<RouterProvider router={router} />);
}

function member(id: string, isLead: boolean): ServerSummary {
  // SAFETY: a roster entry as the crew provider reads it; the card uses only `id`, `name` and `isLead`.
  return { id, name: id, isLead, reachable: true, protocol: "ok" } as ServerSummary;
}

// CALM LOAD (row 15): while the read runs the row holds the answered row's lines and the button's box, unseen.
describe("WorktreeFolderControl while the read runs", () => {
  const row = () => screen.getByTestId("worktree-folder-row");
  const hold = () => row().querySelector('[data-slot="worktree-folder-hold"]');
  const holdButton = () => row().querySelector('[data-slot="worktree-folder-hold-button"]');

  it("reserves the path line and the button box, and the answered row stands in their place", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.get("/api/worktree/folder", async () => {
        await gate;
        return HttpResponse.json(UNSET);
      }),
    );
    renderCard(<WorktreeFolderControl />);
    expect(await screen.findByText("Reading…")).toBeInTheDocument();
    expect(hold()).toHaveClass("invisible", "font-mono", "text-xs");
    expect(hold()).toHaveAttribute("aria-hidden", "true");
    expect(holdButton()).toHaveClass("h-11", "shrink-0");
    // The held lines sit where the answer's lines will: under the loading line, beside the button's box.
    const lines = hold()!.parentElement!;
    expect(lines.children).toHaveLength(2);
    release();
    await screen.findByText("Default");
    expect(hold()).toBeNull();
    expect(holdButton()).toBeNull();
    expect(row().querySelector('[data-testid="worktree-folder-value"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Change" })).toBeInTheDocument();
  });
});

describe("WorktreeFolderControl", () => {
  it("shows Default and the folder the rule gives while nothing is set", async () => {
    server.use(http.get("/api/worktree/folder", () => HttpResponse.json(UNSET)));
    renderCard(<WorktreeFolderControl />);
    expect(await screen.findByText("Default")).toBeInTheDocument();
    expect(screen.getByTestId("worktree-folder-value")).toHaveTextContent(FALLBACK);
  });

  it("saves a typed folder and shows it as yours", async () => {
    server.use(
      http.get("/api/worktree/folder", () => HttpResponse.json(UNSET)),
      http.post<never, { dir: string | null }>("/api/worktree/folder/set", async ({ request }) => {
        const { dir } = await request.json();
        posts.push({ host: null, dir });
        return HttpResponse.json({ ok: true, dir, path: dir, fallback: FALLBACK });
      }),
    );
    const user = userEvent.setup();
    renderCard(<WorktreeFolderControl />);
    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.type(screen.getByLabelText("Folder on this machine"), "/home/op/trees");
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByText("Your folder")).toBeInTheDocument());
    expect(posts).toEqual([{ host: null, dir: "/home/op/trees" }]);
    expect(screen.getByTestId("worktree-folder-value")).toHaveTextContent("/home/op/trees");
  });

  it("says the rule a refused folder breaks, in the editor, and stores nothing", async () => {
    server.use(
      http.get("/api/worktree/folder", () => HttpResponse.json(UNSET)),
      http.post("/api/worktree/folder/set", () =>
        HttpResponse.json({ ok: false, error: "x", code: "worktree.folder_outside_home" }),
      ),
    );
    const user = userEvent.setup();
    renderCard(<WorktreeFolderControl />);
    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.type(screen.getByLabelText("Folder on this machine"), "/srv/trees");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("That folder is outside your home folder.")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("clears the setting with Use the default", async () => {
    let dir: string | null = "/home/op/trees";
    server.use(
      http.get("/api/worktree/folder", () => HttpResponse.json({ ok: true, dir, path: dir, fallback: FALLBACK })),
      http.post<never, { dir: string | null }>("/api/worktree/folder/set", async ({ request }) => {
        dir = (await request.json()).dir;
        return HttpResponse.json({ ok: true, dir, fallback: FALLBACK });
      }),
    );
    const user = userEvent.setup();
    renderCard(<WorktreeFolderControl />);
    await user.click(await screen.findByRole("button", { name: "Change" }));
    await user.click(screen.getByRole("button", { name: "Use the default" }));
    await waitFor(() => expect(screen.getByText("Default")).toBeInTheDocument());
    expect(dir).toBeNull();
  });

  it("shows the refusal of a stored folder that broke since it was saved", async () => {
    server.use(
      http.get("/api/worktree/folder", () =>
        HttpResponse.json({
          ok: true,
          dir: "/home/op/gone",
          problem: { error: "x", code: "worktree.folder_missing" },
          fallback: FALLBACK,
        }),
      ),
    );
    renderCard(<WorktreeFolderControl />);
    expect(await screen.findByText("That folder is not there.")).toBeInTheDocument();
  });

  it("says so when the machine does not answer", async () => {
    server.use(http.get("/api/worktree/folder", () => HttpResponse.json({ error: "no" }, { status: 404 })));
    renderCard(<WorktreeFolderControl />);
    expect(await screen.findByText(/did not answer/u)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
  });

  it("reads each machine of a crew through its own scope", async () => {
    server.use(
      http.get("/api/worktree/folder", ({ request }) => {
        const host = new URL(request.url).searchParams.get("host");
        reads.push(host);
        return HttpResponse.json(host === "mini" ? { ok: true, dir: "/home/op/mini", path: "/home/op/mini", fallback: FALLBACK } : UNSET);
      }),
    );
    renderCard(
      <CrewProvider servers={[member("lodge", true), member("mini", false)]} sessions={[]} ts={0} pollMs={3_000}>
        <WorktreeFolderControl />
      </CrewProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId("worktree-folder-row")).toHaveLength(2));
    await waitFor(() => expect(screen.getAllByTestId("worktree-folder-value")).toHaveLength(2));
    expect(reads).toHaveLength(2);
    expect(reads).toContain(null);
    expect(reads).toContain("mini");
    const rows = screen.getAllByTestId("worktree-folder-row");
    expect(rows[1]).toHaveTextContent("/home/op/mini");
    expect(rows[0]).toHaveTextContent("Default");
  });
});
