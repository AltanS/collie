import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FACTS_REREAD_MS, TricksSettingsCard } from "@/components/tricks-settings-card";
import { addOfficialTrick, fetchOfficialTricks } from "@/lib/api";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { OfficialTricksReply, TricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { readOfficialAddReply, readOfficialTricksReply } from "@/lib/tricks/wire";
import type { JsonObject, JsonValue } from "@/lib/json";
import { clearStatus, currentStatus } from "@/lib/status";
import { server } from "@/test/setup";

// Official tricks in Settings → Tricks (M94; one list since 2026-11-12): the official tricks this release can
// add and the installed ones as one list, each once, official first in the list's order, then the community's
// by name. The routes are the real api.ts calls against msw, so the paths and bodies are checked too.

const NOW = Date.parse("2026-11-11T09:41:00Z");
const COMMIT = "0d8039936aef44961a5641f4bfdc4583ed0c3e60";

function entry(id: string, name: string, description: string, state: WireOfficialTrick["state"] = "absent"): WireOfficialTrick {
  return { id, name, description, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: COMMIT, state };
}

const REVIEW = entry("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name.");
const INBOX = entry("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you.");
const BUILDS = entry("running-builds", "Running Builds", "Builds and long commands running in your sessions now.");

const LEGS: WireTrickInfo = { host: "lodge", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "agent" } };
/** A community trick that sorts after "Browser leg". */
const TRACKER_LIKE = entry("tracker-like", "Tracker", "Not on the list.");

function installed(from: WireOfficialTrick, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "lodge", id: from.id, name: from.name, icon: "plug", on: false, state: "off", places: ["belt"], provenance: { via: "repo", repo: from.repoName, sha: "1111111aaaa" }, ...extra };
}

/** A store whose list a test can change, as the snapshot's `tricksRev` would. */
async function liveStore(tricks: WireTrickInfo[]): Promise<{ store: TricksStore; list: (next: WireTrickInfo[]) => Promise<void> }> {
  let rev = 5;
  let held = tricks;
  const store = createTricksStore({
    fetchTricks: async (): Promise<TricksReply> => ({ rev, tricks: held, parts: [], present: [] }),
    tapTrick: async () => Promise.reject(new Error("no tap")),
    mintRequestId: () => "r",
  });
  await store.syncTricks(rev);
  return {
    store,
    list: async (next) => {
      held = next;
      rev += 1;
      await act(async () => {
        await store.syncTricks(rev);
      });
    },
  };
}

/** The bridge's list route over msw, answering what `reply()` holds at the time of the read. */
interface ServedList {
  reads: () => number;
}

function serveList(reply: () => OfficialTricksReply | Response): ServedList {
  let reads = 0;
  server.use(
    http.get("/api/tricks/official", () => {
      reads += 1;
      const body = reply();
      return body instanceof Response ? body : HttpResponse.json(body);
    }),
  );
  return { reads: () => reads };
}

function renderCard(store: TricksStore, readOnly = false) {
  const loader = readOnly ? () => ({ device: { enforced: true, authorized: false } }) : undefined;
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} />, loader }], { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

/** The rows of the one list, in order: `add:<id>` for an entry not added, `<label>:<id>` for an installed trick. */
function order(): string[] {
  const card = screen.getByTestId("tricks-settings");
  return [...card.querySelectorAll<HTMLElement>("[data-trick], [data-official]")].map((row) => {
    if (row.dataset.official !== undefined) return `add:${row.dataset.official}`;
    const label = row.querySelector<HTMLElement>('[data-slot="trick-origin"]')?.dataset.origin ?? "none";
    return `${label}:${row.dataset.trick ?? ""}`;
  });
}
const trickRow = (id: string) => {
  const row = document.querySelector(`[data-trick="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no trick row for ${id}`);
  return row;
};
const officialRow = (id: string) => {
  const row = document.querySelector(`[data-official="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no official row for ${id}`);
  return row;
};

beforeEach(() => clearStatus());
afterEach(() => {
  clearStatus();
  vi.useRealTimers();
});

describe("Official tricks: one list", () => {
  it("draws each trick once: official first in the list's order with a label, then the community's by name", async () => {
    serveList(() => ({ tricks: [REVIEW, { ...INBOX, state: "taken" }, { ...BUILDS, state: "added" }] }));
    const mine = installed(INBOX, { name: "My PR list", provenance: { via: "cli" } });
    const { store } = await liveStore([LEGS, installed(BUILDS), mine]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-official="design-review"]')).not.toBeNull());
    expect(order()).toEqual(["add:design-review", "official:running-builds", "community:legs", "community:pr-inbox"]);
    // No section and no second copy of an id: the list is one.
    expect(document.querySelector('[data-section="official"]')).toBeNull();
    expect(screen.queryByText("Official tricks")).toBeNull();
    const review = officialRow("design-review");
    expect(within(review).getByRole("button", { name: "About Design Review" })).toHaveTextContent("Design ReviewOfficial");
    expect(within(review).getByText("Turns an agent's UI notes into Decisions you approve by name.").className).toContain("text-muted-foreground");
    expect(review.querySelector('[data-line="slot"]')).toHaveTextContent("From AltanS/collie-tricks @ 0d80399");
    const add = within(review).getByRole("button", { name: "Add Design Review" });
    expect(add).toHaveTextContent("Add");
    expect(add).toBeEnabled();
    // A taken entry is no row: its trick is the community's, and says why the entry is not added.
    expect(document.querySelector('[data-official="pr-inbox"]')).toBeNull();
    expect(within(trickRow("pr-inbox")).getByText("A trick with this name is already here.")).toBeInTheDocument();
    expect(within(trickRow("pr-inbox")).getByRole("switch")).toBeInTheDocument();
    expect(trickRow("running-builds").querySelector('[data-slot="trick-origin"]')).toHaveTextContent("Official");
    expect(trickRow("legs").querySelector('[data-slot="trick-origin"]')).toHaveTextContent("Community");
  });

  it("puts Morph first, as the release list does, and draws where a not-added entry draws", async () => {
    const MORPH: WireOfficialTrick = { ...entry("morph", "Morph", "Your agent answers with one screen you can tap, not a wall of text."), givesRules: true, agentView: true };
    serveList(() => ({ tricks: [MORPH, { ...REVIEW, places: ["belt", "session"] }] }));
    const { store } = await liveStore([LEGS]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-official="morph"]')).not.toBeNull());
    expect(order()).toEqual(["add:morph", "add:design-review", "community:legs"]);
    expect(officialRow("design-review").querySelector('[data-line="places"]')).toHaveTextContent("belt, page");
    expect(officialRow("morph").querySelector('[data-line="places"]')).not.toBeNull();
  });

  it("draws Uses agent tokens on an entry before Add, from the pin alone, and keeps it on the row Add makes", async () => {
    const MORPH: WireOfficialTrick = { ...entry("morph", "Morph", "Your agent answers with one screen you can tap, not a wall of text."), givesRules: true, agentView: true };
    serveList(() => ({ tricks: [MORPH, { ...REVIEW, decidesReply: true }, BUILDS, { ...INBOX, state: "added", decidesReply: true }] }));
    const { store } = await liveStore([installed(INBOX, { decidesReply: true }), LEGS]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-official="morph"]')).not.toBeNull());
    const chip = (row: HTMLElement) => row.querySelector('[data-slot="token-use"]')?.textContent ?? null;
    expect(chip(officialRow("morph"))).toBe("Uses agent tokens");
    expect(chip(officialRow("design-review"))).toBe("Uses agent tokens");
    expect(chip(officialRow("running-builds"))).toBeNull();
    expect(chip(trickRow("pr-inbox"))).toBe("Uses agent tokens");
    expect(chip(trickRow("legs"))).toBeNull();
    // After the origin label, inside the one open button.
    const button = officialRow("design-review").querySelector('[data-slot="official-about"]');
    expect([...(button?.querySelector('[data-slot="row-labels"]')?.children ?? [])].map((el) => el.getAttribute("data-slot"))).toEqual(["trick-origin", "token-use"]);
  });

  it("adds a trick and switches it on, and its row keeps its place; no id appears twice", async () => {
    const user = userEvent.setup();
    let state: WireOfficialTrick["state"] = "absent";
    serveList(() => ({ tricks: [REVIEW, { ...INBOX, state }, BUILDS] }));
    server.use(
      http.post("/api/tricks/official/:id/:mode", () => {
        state = "added";
        return HttpResponse.json({ id: "pr-inbox", state: "added" });
      }),
    );
    const { store, list } = await liveStore([LEGS, installed(TRACKER_LIKE)]);
    const onSwitch = vi.fn(async (_host: string, id: string, on: boolean) => ({ ...installed(INBOX), id, on, state: on ? ("ok" as const) : ("off" as const) }));
    const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", element: <TricksSettingsCard store={store} now={NOW} onSwitch={onSwitch} /> }], { initialEntries: ["/"] });
    render(<RouterProvider router={router} />);
    await vi.waitFor(() => expect(document.querySelector('[data-official="pr-inbox"]')).not.toBeNull());
    const before = order();
    expect(before).toEqual(["add:design-review", "add:pr-inbox", "add:running-builds", "community:legs", "community:tracker-like"]);
    const at = before.indexOf("add:pr-inbox");
    await user.click(screen.getByRole("button", { name: "Add PR Inbox" }));
    await list([LEGS, installed(TRACKER_LIKE), installed(INBOX, { provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: COMMIT } })]);
    await vi.waitFor(() => expect(document.querySelector('[data-trick="pr-inbox"]')).not.toBeNull());
    const added = order();
    expect(added.indexOf("official:pr-inbox")).toBe(at);
    expect(added).toHaveLength(before.length);
    // Switch it on: the row changes its switch, never its place.
    await user.click(within(trickRow("pr-inbox")).getByRole("switch"));
    await list([LEGS, installed(TRACKER_LIKE), installed(INBOX, { on: true, state: "ok", provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: COMMIT } })]);
    await vi.waitFor(() => expect(within(trickRow("pr-inbox")).getByRole("switch")).toBeChecked());
    const on = order();
    expect(on.indexOf("official:pr-inbox")).toBe(at);
    // Each id once, all the way through.
    for (const rows of [before, added, on]) {
      const ids = rows.map((row) => row.split(":")[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("reads the list once more after the first answer lacked a GitHub repository's facts, and never again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listed = serveList(() => ({ tricks: [REVIEW] }));
      const { store } = await liveStore([LEGS]);
      renderCard(store);
      await vi.waitFor(() => expect(listed.reads()).toBe(1));
      await vi.advanceTimersByTimeAsync(FACTS_REREAD_MS + 100);
      await vi.waitFor(() => expect(listed.reads()).toBe(2));
      await vi.advanceTimersByTimeAsync(FACTS_REREAD_MS * 5);
      expect(listed.reads()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not read again when the first answer carried the facts", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const listed = serveList(() => ({ tricks: [{ ...REVIEW, repoFacts: { stars: 3, pushedAt: "2026-11-10T08:00:00Z" } }] }));
      const { store } = await liveStore([LEGS]);
      renderCard(store);
      await vi.waitFor(() => expect(listed.reads()).toBe(1));
      await vi.advanceTimersByTimeAsync(FACTS_REREAD_MS * 3);
      expect(listed.reads()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a taken entry whose folder came from the repository but not from the list says so on its trick's row, and never reads as the list", async () => {
    serveList(() => ({ tricks: [REVIEW, { ...INBOX, state: "taken", unlisted: true }] }));
    const { store } = await liveStore([LEGS, installed(INBOX, { provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: "5e1f00d3a9b2", unlisted: true } })]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-trick="pr-inbox"] [data-line="taken"]')).not.toBeNull());
    const inbox = trickRow("pr-inbox");
    expect(within(inbox).getByText("Added from the repository, not from the official list.")).toBeInTheDocument();
    expect(within(inbox).queryByText("A trick with this name is already here.")).toBeNull();
    expect(inbox.querySelector('[data-slot="trick-origin"]')).toHaveTextContent("Community");
    // The wire keeps the mark only on a taken entry.
    expect(readOfficialTricksReply({ tricks: [{ ...INBOX, state: "taken", unlisted: true }] })?.tricks[0]?.unlisted).toBe(true);
    expect(readOfficialTricksReply({ tricks: [{ ...INBOX, state: "update", unlisted: true }] })?.tricks[0]?.unlisted).toBeUndefined();
  });

  it("draws no official row for an empty list, a crew member's, or a list the phone could not read", async () => {
    const replies: (() => OfficialTricksReply | Response)[] = [
      () => ({ tricks: [] }),
      () => ({ tricks: [], runsOn: { lead: "desk" } }),
      () => ({ tricks: [REVIEW], runsOn: {} }),
      () => HttpResponse.json({ error: "no" }, { status: 500 }),
      () => HttpResponse.json({ nope: 1 }),
    ];
    for (const reply of replies) {
      const listed = serveList(reply);
      const { store } = await liveStore([LEGS]);
      const view = renderCard(store);
      await screen.findByTestId("tricks-settings");
      await vi.waitFor(() => expect(listed.reads()).toBeGreaterThan(0));
      await vi.waitFor(() => expect(document.querySelector('[data-trick="legs"]')).not.toBeNull());
      expect(document.querySelector("[data-official]")).toBeNull();
      view.unmount();
    }
  });

  it("disables Add on a device that may only read", async () => {
    serveList(() => ({ tricks: [REVIEW] }));
    const { store } = await liveStore([LEGS]);
    renderCard(store, true);
    await vi.waitFor(() => expect(document.querySelector('[data-official="design-review"]')).not.toBeNull());
    expect(within(officialRow("design-review")).getByRole("button", { name: "Add Design Review" })).toBeDisabled();
  });
});

describe("Official tricks: a fresh install", () => {
  it("with no trick yet the card holds only the list; an add lands the trick, off, and its row appears", async () => {
    const user = userEvent.setup();
    let state: WireOfficialTrick["state"] = "absent";
    serveList(() => ({ tricks: [{ ...REVIEW, state }] }));
    server.use(
      http.post("/api/tricks/official/:id/:mode", () => {
        state = "added";
        return HttpResponse.json({ id: "design-review", state: "added" });
      }),
    );
    // What the bridge sends with no tricks folder and a list: a rev and no trick.
    const { store, list } = await liveStore([]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-official="design-review"]')).not.toBeNull());
    expect(screen.queryByText("collie trick init <id>")).toBeNull();
    expect(screen.getByText("A trick runs as you.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add Design Review" }));
    await list([installed(REVIEW, { provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: COMMIT } })]);
    await vi.waitFor(() => expect(document.querySelector('[data-trick="design-review"]')).not.toBeNull());
    expect(within(document.querySelector<HTMLElement>('[data-trick="design-review"]') ?? document.body).getByRole("switch")).not.toBeChecked();
    await vi.waitFor(() => expect(document.querySelector('[data-official="design-review"]')).toBeNull());
  });

  it("an empty list and no trick shows the empty card as before; no tricks reply shows no card", async () => {
    serveList(() => ({ tricks: [] }));
    const { store } = await liveStore([]);
    renderCard(store);
    expect(await screen.findByText("collie trick init <id>")).toBeInTheDocument();
    expect(document.querySelector("[data-official]")).toBeNull();
    cleanup();
    const bare = createTricksStore({ fetchTricks: async () => Promise.reject(new Error("never asked")), tapTrick: async () => Promise.reject(new Error("no tap")), mintRequestId: () => "r" });
    renderCard(bare);
    expect(screen.queryByTestId("tricks-settings")).toBeNull();
  });
});

describe("Official tricks: Add", () => {
  it("posts {} to the entry's add route, spins in place, takes no second tap, and becomes the trick's row once it is installed", async () => {
    const user = userEvent.setup();
    let state: WireOfficialTrick["state"] = "absent";
    serveList(() => ({ tricks: [{ ...REVIEW, state }, INBOX] }));
    const posts: { path: string; body: unknown }[] = [];
    let answer = (): void => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    server.use(
      http.post("/api/tricks/official/:id/:mode", async ({ request }) => {
        posts.push({ path: new URL(request.url).pathname, body: await request.json() });
        await answered;
        state = "added";
        return HttpResponse.json({ id: "design-review", state: "added" });
      }),
    );
    const { store, list } = await liveStore([LEGS]);
    renderCard(store);
    const add = await screen.findByRole("button", { name: "Add Design Review" });
    const width = add.className;
    await user.click(add);
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/api/tricks/official/design-review/add", body: {} });
    expect(add).toBeDisabled();
    expect(add).toHaveAttribute("aria-busy", "true");
    expect(add.querySelector('[data-active] svg')).not.toBeNull();
    expect(add.className).toBe(width);
    await user.click(add);
    expect(posts).toHaveLength(1);
    answer();
    // The bridge took it, but the phone's list has not caught up: the row stays, still busy.
    await vi.waitFor(() => expect(currentStatus()).toBeNull());
    expect(officialRow("design-review")).toBeInTheDocument();
    await list([LEGS, installed(REVIEW, { provenance: { via: "repo", repo: "AltanS/collie-tricks", sha: COMMIT } })]);
    await vi.waitFor(() => expect(document.querySelector('[data-official="design-review"]')).toBeNull());
    expect(document.querySelector('[data-trick="design-review"]')).not.toBeNull();
    expect(officialRow("pr-inbox")).toBeInTheDocument();
  });

  it("says why in the status line when the bridge refuses, and gives the Add back", async () => {
    const user = userEvent.setup();
    serveList(() => ({ tricks: [REVIEW] }));
    const { store } = await liveStore([LEGS]);
    renderCard(store);
    const cases: [number, string, string][] = [
      [502, "unreachable", "GitHub did not answer. Nothing was added."],
      [422, "mismatch", "The code did not match. Nothing was added."],
      [422, "too-large", "The code did not match. Nothing was added."],
      [409, "busy", "Collie is adding another trick. Try again in a moment."],
      [409, "taken", "A trick with this name is already here."],
      [500, "failed", "Could not add Design Review. Try again."],
    ];
    for (const [status, error, line] of cases) {
      server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error, message: "the bridge's words" }, { status })));
      clearStatus();
      await user.click(await screen.findByRole("button", { name: "Add Design Review" }));
      await vi.waitFor(() => expect(currentStatus()).toMatchObject({ text: line, tone: "error" }));
      await vi.waitFor(() => expect(screen.getByRole("button", { name: "Add Design Review" })).toBeEnabled());
    }
  });
});

describe("Official tricks: the About sheet before the add", () => {
  it("shows the name, the line and where it comes from, no invented facts, and Add at the foot; it closes once the bridge took the add", async () => {
    const user = userEvent.setup();
    serveList(() => ({ tricks: [REVIEW] }));
    const posts: string[] = [];
    server.use(
      http.post("/api/tricks/official/:id/:mode", ({ request }) => {
        posts.push(new URL(request.url).pathname);
        return HttpResponse.json({ id: "design-review", state: "added" });
      }),
    );
    const { store } = await liveStore([LEGS]);
    renderCard(store);
    await user.click(await screen.findByRole("button", { name: "About Design Review" }));
    const dialog = screen.getByRole("dialog", { name: "Design Review" });
    expect(within(dialog).getByText("Turns an agent's UI notes into Decisions you approve by name.")).toBeInTheDocument();
    expect(within(dialog).getByText("Where it comes from")).toBeInTheDocument();
    expect(within(dialog).getByText("From AltanS/collie-tricks @ 0d80399")).toBeInTheDocument();
    expect(within(dialog).getByText("Collie checks that the code matches this release before it adds it.")).toBeInTheDocument();
    expect(within(dialog).queryByText("What it does")).toBeNull();
    expect(within(dialog).queryByText("Written by the trick's author. Collie did not check it.")).toBeNull();
    expect(within(dialog).queryByRole("switch")).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posts).toEqual(["/api/tricks/official/design-review/add"]);
  });

  it("adds on a tap on the row's Add and opens no sheet: Add is a sibling of the About button, above its layer", async () => {
    const user = userEvent.setup();
    serveList(() => ({ tricks: [REVIEW] }));
    const posts: string[] = [];
    server.use(
      http.post("/api/tricks/official/:id/:mode", ({ request }) => {
        posts.push(new URL(request.url).pathname);
        return HttpResponse.json({ id: "design-review", state: "added" });
      }),
    );
    const { store } = await liveStore([LEGS]);
    renderCard(store);
    await vi.waitFor(() => officialRow("design-review"));
    const row = officialRow("design-review");
    const about = within(row).getByRole("button", { name: "About Design Review" });
    const add = within(row).getByRole("button", { name: "Add Design Review" });
    expect(about.contains(add)).toBe(false);
    expect(about.className).toContain("after:inset-0");
    expect(add.className).toContain("z-10");
    await user.click(add);
    await vi.waitFor(() => expect(posts).toEqual(["/api/tricks/official/design-review/add"]));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("stays open and says why when the add fails", async () => {
    const user = userEvent.setup();
    serveList(() => ({ tricks: [REVIEW] }));
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error: "unreachable", message: "x" }, { status: 502 })));
    const { store } = await liveStore([LEGS]);
    renderCard(store);
    await user.click(await screen.findByRole("button", { name: "About Design Review" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("GitHub did not answer. Nothing was added."));
    expect(screen.getByRole("dialog", { name: "Design Review" })).toBeInTheDocument();
  });
});

describe("Official tricks: Update", () => {
  it("puts a quiet line with Update under an installed trick this release has a newer version of, and posts to the update route", async () => {
    const user = userEvent.setup();
    let state: WireOfficialTrick["state"] = "update";
    serveList(() => ({ tricks: [{ ...BUILDS, state }] }));
    const posts: string[] = [];
    server.use(
      http.post("/api/tricks/official/:id/:mode", ({ request }) => {
        posts.push(new URL(request.url).pathname);
        state = "added";
        return HttpResponse.json({ id: "running-builds", state: "added" });
      }),
    );
    const { store } = await liveStore([LEGS, installed(BUILDS)]);
    renderCard(store);
    const row = () => {
      const el = document.querySelector('[data-trick="running-builds"]');
      if (!(el instanceof HTMLElement)) throw new Error("no row");
      return el;
    };
    await vi.waitFor(() => expect(row().querySelector('[data-line="official-update"]')).not.toBeNull());
    expect(within(row()).getByText("A newer version comes with this Collie.")).toBeInTheDocument();
    expect(document.querySelector('[data-trick="legs"] [data-line="official-update"]')).toBeNull();
    expect(document.querySelector("[data-official]")).toBeNull();
    await user.click(within(row()).getByRole("button", { name: "Update Running Builds" }));
    await vi.waitFor(() => expect(row().querySelector('[data-line="official-update"]')).toBeNull());
    expect(posts).toEqual(["/api/tricks/official/running-builds/update"]);
  });

  it("says an update's own words when it fails", async () => {
    const user = userEvent.setup();
    serveList(() => ({ tricks: [{ ...BUILDS, state: "update" }] }));
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error: "mismatch", message: "x" }, { status: 422 })));
    const { store } = await liveStore([installed(BUILDS)]);
    renderCard(store);
    await user.click(await screen.findByRole("button", { name: "Update Running Builds" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("The code did not match. Nothing was changed."));
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error: "unreachable", message: "x" }, { status: 502 })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Update Running Builds" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Update Running Builds" }));
    await vi.waitFor(() => expect(currentStatus()?.text).toBe("GitHub did not answer. Nothing was changed."));
    // The new code needs a name the person's own files hold: its own line, not the generic one.
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error: "blocked", message: "x" }, { status: 409 })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Update Running Builds" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Update Running Builds" }));
    await vi.waitFor(() => expect(currentStatus()).toMatchObject({ text: "Your own files block it. Nothing was changed.", tone: "error" }));
    // The person changed the trick's files: Collie moves and removes none of them.
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ error: "changed", message: "x" }, { status: 409 })));
    await vi.waitFor(() => expect(screen.getByRole("button", { name: "Update Running Builds" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Update Running Builds" }));
    await vi.waitFor(() => expect(currentStatus()).toMatchObject({ text: "You edited its files. Update it on the machine.", tone: "error" }));
  });

  it("a taken entry whose files the person changed says so on its trick's row, and offers no Add and no Update", async () => {
    serveList(() => ({ tricks: [{ ...BUILDS, state: "taken", changed: true }] }));
    const { store } = await liveStore([installed(BUILDS)]);
    renderCard(store);
    await vi.waitFor(() => expect(document.querySelector('[data-trick="running-builds"] [data-line="taken"]')).not.toBeNull());
    const builds = trickRow("running-builds");
    expect(within(builds).getByText("You edited its files. Update it on the machine.")).toBeInTheDocument();
    expect(within(builds).queryByRole("button", { name: /^(Add|Update) / })).toBeNull();
    expect(document.querySelector("[data-official]")).toBeNull();
    expect(readOfficialTricksReply({ tricks: [{ ...BUILDS, state: "taken", changed: true }] })?.tricks[0]?.changed).toBe(true);
  });
});

describe("Official tricks: the wire", () => {
  it("fetchOfficialTricks reads the list tolerantly: an odd entry is left out, a body of another shape throws", async () => {
    serveList(() => HttpResponse.json({ tricks: [REVIEW, { ...INBOX, commit: "abc" }, { ...BUILDS, state: "gone" }], runsOn: { lead: "desk" } }));
    expect(await fetchOfficialTricks()).toEqual({ tricks: [REVIEW], runsOn: { lead: "desk" } });
    serveList(() => HttpResponse.json({ list: [] }));
    await expect(fetchOfficialTricks()).rejects.toThrow(/not the official list/);
    expect(readOfficialTricksReply({ tricks: [{ ...REVIEW, name: "Le‮gs" }] })).toEqual({ tricks: [] });
    expect(readOfficialTricksReply({ tricks: [{ ...REVIEW, id: "../x" }] })).toEqual({ tricks: [] });
  });

  it("reads an entry's pinned places this phone draws, once each, and the agent view mark; anything else is left out", () => {
    const read = (places: JsonValue | undefined, agentView?: JsonValue) => {
      const raw: JsonObject = { id: REVIEW.id, name: REVIEW.name, description: REVIEW.description, repo: REVIEW.repo, repoName: REVIEW.repoName, commit: REVIEW.commit, state: REVIEW.state };
      if (places !== undefined) raw.places = places;
      if (agentView !== undefined) raw.agentView = agentView;
      return readOfficialTricksReply({ tricks: [raw] })?.tricks[0];
    };
    expect(read(["belt", "session"])?.places).toEqual(["belt", "session"]);
    expect(read(["belt", "belt", "sidebar", 3, "menu"])?.places).toEqual(["belt", "menu"]);
    expect(read("belt")?.places).toBeUndefined();
    expect(read([])?.places).toBeUndefined();
    expect(read(undefined, true)?.agentView).toBe(true);
    expect(read(undefined, "yes")?.agentView).toBeUndefined();
  });

  it("addOfficialTrick posts {} and reads { id, state } back; anything else throws", async () => {
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ ok: true })));
    await expect(addOfficialTrick("design-review", "add")).rejects.toThrow(/not \{ id, state \}/);
    expect(readOfficialAddReply({ id: "x", state: "added" })).toEqual({ id: "x", state: "added" });
    expect(readOfficialAddReply({ id: "x", state: "done" })).toBeUndefined();
  });
});
