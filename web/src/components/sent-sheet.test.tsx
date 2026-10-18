import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fixtureServers } from "@/test/handlers";
import { entry, sentCrew, sentEmpty, sentMore, sentOff, sentSolo, sentSomeSilent } from "@/test/sent-fixtures";
import type { SentAnswer } from "@/lib/types";
import { CrewProvider } from "./crew-provider";
import { SentSheet } from "./sent-sheet";

// The Sent sheet against the contract fixtures (M61 spec 02): each state it draws, what each tap
// puts on the wire, and that a tap on a row only hands the line back.

const CWD = "/home/altan/projects/collie";

interface Seen {
  url: URL;
}

/** Answers GET /api/sent with `answer` and records what was asked. */
function serveSent(answer: SentAnswer): Seen[] {
  return serveSentBy(() => answer);
}

/** Answers GET /api/sent from the asked URL, with a body or a whole response, and records what was asked. */
function serveSentBy(answer: (url: URL) => SentAnswer | Response): Seen[] {
  const asked: Seen[] = [];
  server.use(
    http.get(/\/api\/sent$/, ({ request }) => {
      const url = new URL(request.url);
      asked.push({ url });
      const body = answer(url);
      return body instanceof Response ? body : HttpResponse.json(body);
    }),
  );
  return asked;
}

function mount(props: { cwd?: string | undefined; scope?: { host?: string }; crew?: boolean } = {}) {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const sheet = (
    <SentSheet
      open
      onClose={onClose}
      cwd={"cwd" in props ? props.cwd : CWD}
      scope={props.scope}
      onPick={onPick}
    />
  );
  render(props.crew === true ? <CrewProvider servers={fixtureServers}>{sheet}</CrewProvider> : sheet);
  return { onPick, onClose };
}

describe("Sent sheet: rows", () => {
  it("draws each line with its folder, its age and its count, and no machine on one machine's view", async () => {
    serveSent(sentSolo);
    mount();
    const git = await screen.findByRole("button", { name: /^git status/ });
    expect(within(git).getByText("git status")).toHaveClass("font-mono");
    expect(git).toHaveTextContent("…/projects/collie");
    expect(git).toHaveTextContent("2m ago");
    expect(within(git).getByLabelText("7 times")).toHaveTextContent("×7");
    // Home reads as a tilde; a line sent once carries no count.
    const bun = screen.getByRole("button", { name: /^bun test/ });
    expect(bun).toHaveTextContent("~");
    expect(within(bun).queryByText(/×/)).toBeNull();
    expect(git).not.toHaveTextContent("bluefin");
  });

  it("asks this folder first, with the pane's folder and a page of fifty", async () => {
    const asked = serveSent(sentSolo);
    mount();
    await screen.findByText("git status");
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url.searchParams.get("scope")).toBe("here");
    expect(asked[0]!.url.searchParams.get("cwd")).toBe(CWD);
    expect(asked[0]!.url.searchParams.get("limit")).toBe("50");
  });

  it("hands the tapped line back and closes, and sends nothing", async () => {
    serveSent(sentSolo);
    const posts: string[] = [];
    server.use(http.post(/\/api\/(send|pane)/, ({ request }) => {
      posts.push(request.url);
      return HttpResponse.json({});
    }));
    const { onPick, onClose } = mount();
    await userEvent.click(await screen.findByRole("button", { name: /^git status/ }));
    expect(onPick).toHaveBeenCalledWith("git status");
    expect(onClose).toHaveBeenCalled();
    expect(posts).toEqual([]);
  });
});

describe("Sent sheet: scope", () => {
  it("offers the folder and the machine on a solo bridge, and not all machines", async () => {
    serveSent(sentSolo);
    mount();
    await screen.findByText("git status");
    const group = screen.getByRole("radiogroup", { name: "Which lines to show" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual(["This folder", "This machine"]);
  });

  it("offers no folder when the pane reported none, and then no scope control at all", async () => {
    const asked = serveSent(sentSolo);
    mount({ cwd: undefined });
    await screen.findByText("git status");
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(asked[0]!.url.searchParams.has("cwd")).toBe(false);
  });

  it("offers all machines on a lead with members, and asks the lead for the merge with the machine named on each row", async () => {
    const asked = serveSentBy((url) => (url.searchParams.get("scope") === "all" ? sentCrew : sentSolo));
    mount({ crew: true });
    await screen.findByText("git status");
    await userEvent.click(screen.getByRole("radio", { name: "All machines" }));
    const row = await screen.findByRole("button", { name: /^journalctl/ });
    expect(row).toHaveTextContent("workshop");
    const last = asked.at(-1)!.url;
    expect(last.searchParams.get("scope")).toBe("all");
    expect(last.searchParams.has("cwd")).toBe(false);
    expect(last.searchParams.has("host")).toBe(false);
  });

  it("reads a member pane's machine with host=, and the lead's merge without it", async () => {
    const asked = serveSent(sentSolo);
    mount({ crew: true, scope: { host: "workshop" } });
    await screen.findByText("git status");
    expect(asked[0]!.url.searchParams.get("host")).toBe("workshop");
  });

  it("leaves the old place's lines off the screen while the new place loads", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get(/\/api\/sent$/, async ({ request }) => {
        if (new URL(request.url).searchParams.has("cwd")) return HttpResponse.json(sentSolo);
        await gate;
        return HttpResponse.json(sentCrew);
      }),
    );
    mount();
    await screen.findByText("git status");
    await userEvent.click(screen.getByRole("radio", { name: "This machine" }));
    expect(screen.queryByText("make deploy instance=next")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading sent lines…");
    release?.();
    await screen.findByText("journalctl -u collie -n 50");
  });
});

describe("Sent sheet: search", () => {
  it("sends the words once typing pauses, and says when nothing matches", async () => {
    const asked = serveSentBy((url) => (url.searchParams.has("q") ? sentEmpty : sentSolo));
    mount();
    await screen.findByText("git status");
    await userEvent.type(screen.getByRole("textbox", { name: "Search sent lines" }), "zzz");
    await screen.findByText("No sent line matches “zzz”.");
    const queries = asked.map((a) => a.url.searchParams.get("q"));
    expect(queries.at(-1)).toBe("zzz");
    // Three keystrokes, one request: the pause is what sends.
    expect(queries.filter((q) => q !== null)).toEqual(["zzz"]);
  });
});

describe("Sent sheet: states", () => {
  it("says what the list is for when nothing was sent", async () => {
    serveSent(sentEmpty);
    mount();
    expect(await screen.findByText("Lines you send to a shell show up here.")).toBeInTheDocument();
  });

  it("says Sent is off when the bridge records nothing", async () => {
    serveSent(sentOff);
    mount();
    expect(await screen.findByText("Sent is off on this machine.")).toBeInTheDocument();
  });

  it("says the machine is too old when the route is missing", async () => {
    serveSentBy(() => new Response(JSON.stringify({ ok: false, error: "not found" }), { status: 404, headers: { "content-type": "application/json" } }));
    mount();
    expect(await screen.findByText("This machine runs an older Collie. Update it to use Sent.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Clear Sent/ })).toBeNull();
  });

  it("offers a retry after a failed read", async () => {
    let calls = 0;
    serveSentBy(() => {
      calls += 1;
      return calls === 1 ? new Response("down", { status: 500 }) : sentSolo;
    });
    mount();
    await screen.findByText("Could not load Sent.");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("git status")).toBeInTheDocument();
  });

  it("names each machine that did not take part, in its own words", async () => {
    serveSent(sentSomeSilent);
    mount({ crew: true });
    expect(await screen.findByText("attic did not answer.")).toBeInTheDocument();
    expect(screen.getByText("barn runs an older Collie.")).toBeInTheDocument();
    expect(screen.getByText("cellar took too long to answer.")).toBeInTheDocument();
    expect(screen.queryByText(/workshop (did|runs|took)/)).toBeNull();
  });

  it("names a member that has Sent off while the lead has it on", async () => {
    serveSent({ ...sentCrew, machines: [sentCrew.machines[0]!, { ...sentCrew.machines[1]!, off: true }] });
    mount({ crew: true });
    expect(await screen.findByText("Sent is off on workshop.")).toBeInTheDocument();
  });
});

describe("Sent sheet: paging", () => {
  it("asks for lines older than the last one shown, and keeps a returning line once", async () => {
    const oldest = sentSolo.entries.at(-1)!;
    const asked = serveSentBy((url) =>
      url.searchParams.has("before")
        ? { ...sentSolo, more: false, entries: [{ ...sentSolo.entries[0]!, at: oldest.at - 1000, count: 2 }, entry({ line: "ls -la", at: oldest.at - 2000 })] }
        : sentMore,
    );
    mount();
    await screen.findByText("git status");
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await screen.findByText("ls -la");
    expect(asked.at(-1)!.url.searchParams.get("before")).toBe(String(oldest.at));
    expect(screen.getAllByText("git status")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });
});

describe("Sent sheet: forget and clear", () => {
  it("forgets one line on its own machine and drops the row", async () => {
    serveSent(sentCrew);
    const posts: { url: URL; body: { id: string } }[] = [];
    server.use(
      http.post<never, { id: string }>(/\/api\/sent\/remove$/, async ({ request }) => {
        posts.push({ url: new URL(request.url), body: await request.json() });
        return HttpResponse.json({ ok: true });
      }),
    );
    mount({ crew: true });
    await userEvent.click(await screen.findByRole("radio", { name: "All machines" }));
    await screen.findByText("journalctl -u collie -n 50");
    await userEvent.click(screen.getByRole("button", { name: "Forget journalctl -u collie -n 50" }));
    await waitFor(() => expect(screen.queryByText("journalctl -u collie -n 50")).toBeNull());
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body.id).toBe(sentCrew.entries[1]!.id);
    // The row belongs to a member, so the write goes there; a row of the lead would carry no host.
    expect(posts[0]!.url.searchParams.get("host")).toBe("workshop");
  });

  it("keeps the row and says so when the machine refuses", async () => {
    serveSent(sentSolo);
    server.use(http.post(/\/api\/sent\/remove$/, () => HttpResponse.json({ ok: false, error: "no" }, { status: 403 })));
    mount();
    await userEvent.click(await screen.findByRole("button", { name: "Forget git status" }));
    expect(await screen.findByText("Could not forget that line.")).toBeInTheDocument();
    expect(screen.getByText("git status")).toBeInTheDocument();
  });

  it("asks once before it clears, then empties the pane's machine and reads the list again", async () => {
    let cleared = false;
    serveSentBy(() => (cleared ? sentEmpty : sentSolo));
    const posts: URL[] = [];
    server.use(
      http.post(/\/api\/sent\/clear$/, ({ request }) => {
        posts.push(new URL(request.url));
        cleared = true;
        return HttpResponse.json({ ok: true });
      }),
    );
    mount({ crew: true, scope: { host: "workshop" } });
    await screen.findByText("git status");
    await userEvent.click(screen.getByRole("button", { name: "Clear Sent on workshop" }));
    expect(posts).toEqual([]);
    await userEvent.click(screen.getByRole("button", { name: "Tap again to clear" }));
    expect(await screen.findByText("Lines you send to a shell show up here.")).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.searchParams.get("host")).toBe("workshop");
  });

  it("names this machine on a solo bridge", async () => {
    serveSent(sentSolo);
    mount();
    expect(await screen.findByRole("button", { name: "Clear Sent on this machine" })).toBeInTheDocument();
  });
});
