import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { server } from "@/test/setup";
import { clearStatus, useStatus } from "@/lib/status";
import { __resetOperatorCommands } from "@/lib/operator-config";
import type { DurableConversationRow, MuxCapability, MuxConfig } from "@/lib/types";
import { withHeaderHost } from "@/test/header-host";
import { __resetProgramLists, rememberProgramList } from "@/lib/conversation-list";
import { scopeKey } from "@/lib/scope";
import { ConversationRoute, ConversationsRoute } from "./conversations";

// A durable program's own history (M53 spec 11): the list of its conversations, one conversation read only,
// and Reopen for a closed one. Served by the bridge from the program, stubbed here at the wire.

beforeAll(() => {
  // jsdom doesn't implement scrollTo; the transcript scroller may call it.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});
beforeEach(() => clearStatus());
afterEach(() => __resetOperatorCommands());

/** Serve an `/api/config` whose mux block declares exactly `capabilities`. */
function declares(capabilities: Partial<Record<MuxCapability, boolean>>): void {
  const mux: MuxConfig = { name: "reference", capabilities, unsupportedKeys: [], notes: {} };
  server.use(http.get("/api/config", () => HttpResponse.json({ push: false, vapidPublicKey: "", mux })));
}

const row = (over: Partial<DurableConversationRow> & Pick<DurableConversationRow, "id" | "title">): DurableConversationRow => ({
  startedAt: "2026-10-12T09:00:00Z",
  state: "closed",
  items: 4,
  ...over,
});

/** Shows where the router is, so a test can read a navigation's target off the page. */
function Where() {
  const { pathname, search } = useLocation();
  return <div data-testid="where">{`${pathname}${search}`}</div>;
}

/** The status line the page publishes to, as text and tone. */
function Status() {
  const status = useStatus();
  return <output aria-label="status" data-tone={status?.tone ?? ""}>{status?.text ?? ""}</output>;
}

function mount(start: string) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: withHeaderHost(
          <>
            <Where />
            <Status />
            <Outlet />
          </>,
        ),
        children: [
          { index: true, element: <div>dashboard</div> },
          { path: "conversations", element: <ConversationsRoute /> },
          { path: "conversations/:id", element: <ConversationRoute /> },
          { path: "pane/:paneId", element: <div>a pane</div> },
        ],
      },
    ],
    { initialEntries: [start] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

const where = () => screen.getByTestId("where").textContent;

describe("durable history list", () => {
  it("draws the rows newest first with their state and item count", async () => {
    declares({ programHistory: true });
    server.use(
      http.get("/api/durable/conversations", () =>
        HttpResponse.json({
          available: true,
          items: [
            row({ id: "c3", title: "Newest", state: "open", items: 1, startedAt: "2026-10-12T12:00:00Z" }),
            row({ id: "c2", title: "Middle", subtitle: "a side thread", items: 7 }),
            row({ id: "c1", title: "Oldest", items: 12 }),
          ],
        }),
      ),
    );
    mount("/conversations");
    await screen.findByText("Newest");
    const titles = screen.getAllByRole("button").map((b) => b.textContent ?? "").filter((x) => /Newest|Middle|Oldest/.test(x));
    expect(titles[0]).toContain("Newest");
    expect(titles[1]).toContain("Middle");
    expect(titles[2]).toContain("Oldest");
    expect(screen.getByText("a side thread")).toBeInTheDocument();
    expect(within(screen.getByRole("button", { name: /Newest/ })).getByText("Open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Newest/ })).toHaveTextContent("1 item");
    expect(within(screen.getByRole("button", { name: /Oldest/ })).getByText("Closed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Oldest/ })).toHaveTextContent("12 items");
  });

  it("pins the row that ?pane= names on top, whatever its age", async () => {
    server.use(
      http.get("/api/durable/conversations", () =>
        HttpResponse.json({
          available: true,
          items: [
            row({ id: "c3", title: "Newest", state: "open" }),
            row({ id: "c2", title: "Mine", state: "open", paneId: "p7" }),
            row({ id: "c1", title: "Oldest" }),
          ],
        }),
      ),
    );
    mount("/conversations?pane=p7");
    await screen.findByText("Mine");
    const buttons = screen.getAllByRole("button").filter((b) => /Newest|Mine|Oldest/.test(b.textContent ?? ""));
    expect(buttons.map((b) => /Newest|Mine|Oldest/.exec(b.textContent ?? "")![0])).toEqual(["Mine", "Newest", "Oldest"]);
    expect(screen.getByText("Shown in this pane")).toBeInTheDocument();
  });

  it("opens a closed row on its own read-only page, carrying the state, one level below the list", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/durable/conversations", () =>
        HttpResponse.json({ available: true, items: [row({ id: "a/b c", title: "Old thread" })] }),
      ),
      http.get(/\/api\/durable\/conversation\/[^/]+\/items$/, () =>
        HttpResponse.json({ available: true, id: "a/b c", entries: [], more: false }),
      ),
    );
    const router = mount("/conversations?h=lab");
    await user.click(await screen.findByRole("button", { name: /Old thread/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe(`/conversations/${encodeURIComponent("a/b c")}`));
    expect(router.state.location.search).toBe("?h=lab&state=closed");
    // A push, so the back arrow of the page steps back onto the list.
    expect(router.state.historyAction).toBe("PUSH");
  });

  it("goes to the pane for an open row that is in the live layout", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/durable/conversations", () =>
        HttpResponse.json({ available: true, items: [row({ id: "c1", title: "Live one", state: "open", paneId: "w1:p2" })] }),
      ),
    );
    mount("/conversations?h=lab");
    await user.click(await screen.findByRole("button", { name: /Live one/ }));
    await screen.findByText("a pane");
    expect(where()).toBe(`/pane/${encodeURIComponent("w1:p2")}?h=lab`);
  });

  it("sends the scope on the wire and follows next with Load more", async () => {
    const user = userEvent.setup();
    const seen: string[] = [];
    server.use(
      http.get("/api/durable/conversations", ({ request }) => {
        const url = new URL(request.url);
        seen.push(url.search);
        return HttpResponse.json(
          url.searchParams.get("after") === "cur1"
            ? { available: true, items: [row({ id: "c1", title: "Second page" })] }
            : { available: true, items: [row({ id: "c2", title: "First page" })], next: "cur1" },
        );
      }),
    );
    mount("/conversations?h=lab&s=main");
    await screen.findByText("First page");
    expect(new URLSearchParams(seen[0]).get("host")).toBe("lab");
    expect(new URLSearchParams(seen[0]).get("session")).toBe("main");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("Second page");
    expect(new URLSearchParams(seen[1]).get("after")).toBe("cur1");
    // No next on the last page: nothing left to load.
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    expect(screen.getByText("First page")).toBeInTheDocument();
  });

  it("says so in plain text when the program has no conversations", async () => {
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })));
    mount("/conversations");
    expect(await screen.findByText("This durable agent has no conversations yet.")).toBeInTheDocument();
  });

  it("reads unsupported as text, not as an error", async () => {
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: false, reason: "unsupported" })));
    mount("/conversations");
    expect(await screen.findByText("This durable agent does not keep a list of its conversations.")).toBeInTheDocument();
    expect(screen.getByLabelText("status")).toHaveTextContent("");
  });

  it("reads unreachable as text, not as an error", async () => {
    server.use(http.get("/api/durable/conversations", () => HttpResponse.json({ available: false, reason: "unreachable" })));
    mount("/conversations");
    expect(await screen.findByText("The durable agent did not answer. Try again in a moment.")).toBeInTheDocument();
  });
});

const said = (uuid: string, role: "user" | "assistant", text: string) => ({
  uuid,
  ts: "",
  role,
  parts: [{ kind: "text" as const, text }],
});

describe("durable history read-only conversation view", () => {
  it("draws the entries oldest first and has no composer, belt or reply box", async () => {
    server.use(
      http.get(/\/api\/durable\/conversation\/c1\/items$/, () =>
        HttpResponse.json({
          available: true,
          id: "c1",
          entries: [said("m1", "user", "first question"), said("m2", "assistant", "first answer")],
          more: false,
        }),
      ),
    );
    mount("/conversations/c1?state=closed");
    await screen.findByText("first question");
    expect(screen.getByText("first answer")).toBeInTheDocument();
    const order = screen.getByText("first question").compareDocumentPosition(screen.getByText("first answer"));
    expect(order & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  it("names the conversation in its header: from the home's list at once, else from the program's first page", async () => {
    server.use(
      http.get(/\/api\/durable\/conversation\/c1\/items$/, () => HttpResponse.json({ available: true, id: "c1", entries: [], more: false })),
      http.get("/api/durable/conversations", () =>
        HttpResponse.json({ available: true, items: [row({ id: "c1", title: "Maria Lopez", state: "closed" })] }),
      ),
    );
    mount("/conversations/c1?state=closed");
    expect(await screen.findByRole("heading", { name: "Maria Lopez" })).toBeInTheDocument();
    __resetProgramLists();
    rememberProgramList(scopeKey({}), { rows: [row({ id: "c1", title: "Jonas Berg", state: "closed" })], next: undefined });
    mount("/conversations/c1?state=closed");
    expect(await screen.findByRole("heading", { name: "Jonas Berg" })).toBeInTheDocument();
    __resetProgramLists();
  });

  it("follows next with Load more and appends the newer items below", async () => {
    const user = userEvent.setup();
    const asked: (string | null)[] = [];
    server.use(
      http.get(/\/api\/durable\/conversation\/c1\/items$/, ({ request }) => {
        const after = new URL(request.url).searchParams.get("after");
        asked.push(after);
        return HttpResponse.json(
          after === "n1"
            ? { available: true, id: "c1", entries: [said("m3", "assistant", "newer turn")], more: false }
            : { available: true, id: "c1", entries: [said("m1", "user", "older turn")], next: "n1", more: true },
        );
      }),
    );
    mount("/conversations/c1");
    await screen.findByText("older turn");
    await user.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("newer turn");
    expect(asked).toEqual([null, "n1"]);
    expect(screen.getByText("older turn")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("explains a conversation that is gone, in text", async () => {
    server.use(
      http.get(/\/api\/durable\/conversation\/c1\/items$/, () => HttpResponse.json({ available: false, reason: "gone" })),
    );
    mount("/conversations/c1");
    expect(await screen.findByText("This conversation no longer exists.")).toBeInTheDocument();
  });

  // M53 spec 12: the list is the machine's home now, so the way back from a conversation is the dashboard.
  it("goes back to the list, the machine's home, with the scope kept", async () => {
    const user = userEvent.setup();
    server.use(
      http.get(/\/api\/durable\/conversation\/c1\/items$/, () =>
        HttpResponse.json({ available: true, id: "c1", entries: [said("m1", "user", "hi")], more: false }),
      ),
      http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })),
    );
    mount("/conversations/c1?h=lab&state=closed");
    await screen.findByText("hi");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await waitFor(() => expect(where()).toBe("/?h=lab"));
  });
});

describe("durable history reopen", () => {
  const items = () =>
    http.get(/\/api\/durable\/conversation\/c1\/items$/, () =>
      HttpResponse.json({ available: true, id: "c1", entries: [said("m1", "user", "an old question")], more: false }),
    );

  it("draws Reopen only for a closed conversation on a machine that declares reopenConversation", async () => {
    server.use(items());
    declares({ reopenConversation: true });
    mount("/conversations/c1?state=closed");
    expect(await screen.findByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });

  it("draws no Reopen for an open conversation", async () => {
    server.use(items());
    declares({ reopenConversation: true });
    mount("/conversations/c1?state=open");
    await screen.findByText("an old question");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("draws no Reopen when the address names no state", async () => {
    server.use(items());
    declares({ reopenConversation: true });
    mount("/conversations/c1");
    await screen.findByText("an old question");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("draws no Reopen when the program never declared it: a durable control reads absent", async () => {
    server.use(items());
    declares({ programHistory: true });
    mount("/conversations/c1?state=closed");
    await screen.findByText("an old question");
    expect(screen.queryByRole("button", { name: "Reopen" })).toBeNull();
  });

  it("reopen sends exactly one POST however many times it is tapped, then opens the pane", async () => {
    const user = userEvent.setup();
    server.use(items());
    declares({ reopenConversation: true });
    let posts = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.use(
      http.post(/\/api\/durable\/conversation\/c1\/reopen$/, async ({ request }) => {
        posts += 1;
        expect(request.method).toBe("POST");
        await gate;
        return HttpResponse.json({ ok: true, paneId: "w1:p9" });
      }),
    );
    mount("/conversations/c1?h=lab&state=closed");
    const button = await screen.findByRole("button", { name: "Reopen" });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button);
    release();
    await screen.findByText("a pane");
    expect(where()).toBe(`/pane/${encodeURIComponent("w1:p9")}?h=lab`);
    expect(posts).toBe(1);
  });

  it("reopen with no pane in the answer goes back to the list, the machine's home", async () => {
    const user = userEvent.setup();
    server.use(
      items(),
      http.get("/api/durable/conversations", () => HttpResponse.json({ available: true, items: [] })),
      http.post(/\/api\/durable\/conversation\/c1\/reopen$/, () => HttpResponse.json({ ok: true })),
    );
    declares({ reopenConversation: true });
    mount("/conversations/c1?state=closed");
    await user.click(await screen.findByRole("button", { name: "Reopen" }));
    await waitFor(() => expect(where()).toBe("/"));
  });

  it("reopen shows the program's reason on a refusal and lets the person try again", async () => {
    const user = userEvent.setup();
    server.use(items());
    declares({ reopenConversation: true });
    let posts = 0;
    server.use(
      http.post(/\/api\/durable\/conversation\/c1\/reopen$/, () => {
        posts += 1;
        return HttpResponse.json({
          ok: false,
          error: "the program said no",
          code: "durable.reopen_failed",
          detail: { reason: "it is archived" },
        });
      }),
    );
    mount("/conversations/c1?state=closed");
    await user.click(await screen.findByRole("button", { name: "Reopen" }));
    await waitFor(() =>
      expect(screen.getByLabelText("status")).toHaveTextContent("The conversation couldn't be reopened: it is archived"),
    );
    expect(screen.getByLabelText("status")).toHaveAttribute("data-tone", "error");
    const again = screen.getByRole("button", { name: "Reopen" });
    expect(again).toBeEnabled();
    await user.click(again);
    await waitFor(() => expect(posts).toBe(2));
  });
});
