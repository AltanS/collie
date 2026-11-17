import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RepoAddRow, type RepoAddCall, type RepoListCall } from "@/components/tricks-repo-sheet";
import { addRepoTrick } from "@/lib/api";
import { REPO_INDEX_TERMINAL_LINE, type RepoAddReply, type RepoListReply } from "@/lib/tricks/repo-index";
import { server } from "@/test/setup";

// Settings, Tricks, "Add from a repository": the row, the sheet, the list it reads and the Add of one trick.
// The calls are injected here; one case runs the real `addRepoTrick` over msw to read the bridge's reason.

const COMMIT = "5c3e9a17d02b48e6a1f7c9b0d4e8a2f61b7c3d90";
const URL = "https://github.com/lodge/workshop";
const RID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function reply(tricks: RepoListReply["tricks"]): RepoListReply {
  return { rid: "r", code: "ok", url: URL, host: "github.com", repo: "lodge/workshop", commit: COMMIT, tricks };
}

const THREE: RepoListReply["tricks"] = [
  { folder: "idle-watch", name: "Idle Watch", about: "Marks a session that waits for you.", here: false },
  { folder: "build-bell", name: "Build Bell", about: "Tells you when a build ends.", here: false },
  { folder: "clock", name: "Clock", about: "A small clock in the belt.", here: true },
];

const ADDED: RepoAddReply = { rid: "r", code: "ok", id: "idle-watch", hash: "a".repeat(64) };

afterEach(cleanup);

function listing(tricks: RepoListReply["tricks"]) {
  return vi.fn<RepoListCall>().mockResolvedValue(reply(tricks));
}

async function openAndRead(onList: RepoListCall, onAdd: RepoAddCall, link = URL) {
  const user = userEvent.setup();
  render(<RepoAddRow onList={onList} onAdd={onAdd} />);
  await user.click(screen.getByRole("button", { name: "Add from a repository" }));
  await user.type(screen.getByLabelText("Repository link"), link);
  await user.click(screen.getByRole("button", { name: "Read the list" }));
  return user;
}

describe("RepoAddRow", () => {
  it("shows the terminal sentence for a link on another host and makes no request", async () => {
    const onList = vi.fn<RepoListCall>();
    const user = await openAndRead(onList, vi.fn<RepoAddCall>(), "https://git.example.org/lodge/workshop");
    expect(screen.getByRole("alert").textContent).toBe(REPO_INDEX_TERMINAL_LINE);
    expect(onList).not.toHaveBeenCalled();
    // Enter in the field is the same as the button.
    await user.type(screen.getByLabelText("Repository link"), "{enter}");
    expect(onList).not.toHaveBeenCalled();
  });

  it("says why a link that is not https is refused, with no request", async () => {
    const onList = vi.fn<RepoListCall>();
    await openAndRead(onList, vi.fn<RepoAddCall>(), "http://github.com/lodge/workshop");
    expect(screen.getByRole("alert").textContent).toBe("Paste an https link to a git repository.");
    expect(onList).not.toHaveBeenCalled();
  });

  it("reads the list on Enter and draws the name, the repository's words, the folder and the short commit", async () => {
    const onList = listing(THREE);
    const user = userEvent.setup();
    render(<RepoAddRow onList={onList} onAdd={vi.fn<RepoAddCall>()} />);
    await user.click(screen.getByRole("button", { name: "Add from a repository" }));
    await user.type(screen.getByLabelText("Repository link"), `${URL}{enter}`);
    await screen.findByText("Idle Watch");
    expect(onList).toHaveBeenCalledTimes(1);
    expect(onList.mock.calls[0]?.[0]).toBe(URL);
    expect(onList.mock.calls[0]?.[1]).toMatch(RID);
    expect(screen.getByText("From github.com/lodge/workshop at 5c3e9a1")).toBeTruthy();
    const row = document.querySelector('[data-folder="idle-watch"]');
    expect(row?.textContent).toContain("Idle Watch");
    expect(row?.textContent).toContain("The repository says");
    expect(row?.textContent).toContain("Marks a session that waits for you.");
    expect(row?.querySelector('[data-line="folder"]')?.textContent).toBe("idle-watch");
    expect(row?.querySelector('[data-line="about"] p:last-child')?.className).toContain("line-clamp-2");
  });

  it("offers no Add for a trick that is here, and says so", async () => {
    await openAndRead(listing(THREE), vi.fn<RepoAddCall>());
    const here = await screen.findByText("Already here");
    const row = here.closest("li");
    expect(row?.getAttribute("data-folder")).toBe("clock");
    expect(row === null ? [] : within(row).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByRole("button", { name: /^Add (Idle Watch|Build Bell)$/u })).toHaveLength(2);
  });

  it("says when the repository lists no tricks", async () => {
    await openAndRead(listing([]), vi.fn<RepoAddCall>());
    expect(await screen.findByText("This repository lists no tricks.")).toBeTruthy();
  });

  it("adds with the list's commit and a request id, keeps that id for a retry, and then says Added, off", async () => {
    const onAdd = vi.fn<RepoAddCall>().mockRejectedValueOnce(new Error("network lost")).mockResolvedValueOnce(ADDED);
    const user = await openAndRead(listing(THREE), onAdd);
    const add = await screen.findByRole("button", { name: "Add Idle Watch" });
    await user.click(add);
    await waitFor(() => expect(screen.getByText("Could not add Idle Watch. Try again.")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "Add Idle Watch" }));
    await waitFor(() => expect(screen.getByText("Added, off")).toBeTruthy());
    expect(screen.getByText("Switch it on in the list when you have read it.")).toBeTruthy();
    expect(onAdd).toHaveBeenCalledTimes(2);
    const first = onAdd.mock.calls[0]?.[0];
    const second = onAdd.mock.calls[1]?.[0];
    expect(first).toMatchObject({ url: URL, folder: "idle-watch", commit: COMMIT });
    expect(first?.rid).toMatch(RID);
    expect(second?.rid).toBe(first?.rid);
    // The other entry still offers its own Add.
    expect(screen.getByRole("button", { name: "Add Build Bell" })).toBeTruthy();
  });

  it("reads the list and adds a trick on a plain-HTTP page, where crypto.randomUUID does not exist", async () => {
    vi.stubGlobal("crypto", { getRandomValues: crypto.getRandomValues.bind(crypto) });
    try {
      const onList = listing(THREE);
      const onAdd = vi.fn<RepoAddCall>().mockResolvedValue(ADDED);
      const user = await openAndRead(onList, onAdd);
      await user.click(await screen.findByRole("button", { name: "Add Idle Watch" }));
      await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
      expect(onList.mock.calls[0]?.[1]).toMatch(RID);
      expect(onAdd.mock.calls[0]?.[0].rid).toMatch(RID);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mints a new request id for each trick", async () => {
    const onAdd = vi.fn<RepoAddCall>().mockResolvedValue(ADDED);
    const user = await openAndRead(listing(THREE), onAdd);
    await user.click(await screen.findByRole("button", { name: "Add Idle Watch" }));
    await user.click(await screen.findByRole("button", { name: "Add Build Bell" }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(2));
    expect(onAdd.mock.calls[0]?.[0].rid).not.toBe(onAdd.mock.calls[1]?.[0].rid);
  });

  it("reads the repository's reason from a refusal of the real route and shows it as text", async () => {
    server.use(http.post("/api/tricks/repo/add", () => HttpResponse.json({ error: "refused", message: "its run line <b>reaches</b> outside" }, { status: 422 })));
    const user = await openAndRead(listing(THREE), addRepoTrick);
    await user.click(await screen.findByRole("button", { name: "Add Idle Watch" }));
    const line = await screen.findByText(/Collie refused this trick:/u);
    expect(line.textContent).toBe("Collie refused this trick: its run line <b>reaches</b> outside");
    expect(line.querySelector("b")).toBeNull();
  });

  it("disables the row while tricks are off; the sentence is the card's, not the row's", async () => {
    render(<RepoAddRow tricksOff />);
    expect(screen.getByRole("button", { name: "Add from a repository" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("Tricks are switched off on this machine; switch them on in Settings, Experiments.")).toBeNull();
  });

  it("disables the row for a device that may only read", () => {
    render(<RepoAddRow readOnly />);
    expect(screen.getByRole("button", { name: "Add from a repository" })).toHaveProperty("disabled", true);
  });

  it("draws a hostile name, text and folder as plain text, with no markup and no link", async () => {
    const hostile = reply([{ folder: "idle-watch", name: "<b>Idle</b> Watch", about: '<a href="https://example.org">tap</a> <img src=x>', here: false }]);
    await openAndRead(vi.fn<RepoListCall>().mockResolvedValue(hostile), vi.fn<RepoAddCall>());
    await screen.findByText("<b>Idle</b> Watch");
    const row = document.querySelector('[data-folder="idle-watch"]');
    expect(row?.querySelector('[data-line="name"]')?.textContent).toBe("<b>Idle</b> Watch");
    expect(row?.querySelector("b, a, img")).toBeNull();
    expect(row?.querySelector('[data-line="about"]')?.textContent).toContain('<a href="https://example.org">tap</a>');
  });
});
