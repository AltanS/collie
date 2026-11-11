import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TricksSettingsCard } from "@/components/tricks-settings-card";
import { addOfficialTrick, fetchOfficialTricks } from "@/lib/api";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { OfficialTricksReply, TricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import { readOfficialAddReply, readOfficialTricksReply } from "@/lib/tricks/wire";
import { clearStatus, currentStatus } from "@/lib/status";
import { server } from "@/test/setup";

// From Collie in Settings → Tricks (M94): the official tricks this release can add, under the installed
// ones. The routes are the real api.ts calls against msw, so the paths and bodies are checked too.

const NOW = Date.parse("2026-11-11T09:41:00Z");
const COMMIT = "0d8039936aef44961a5641f4bfdc4583ed0c3e60";

function entry(id: string, name: string, description: string, state: WireOfficialTrick["state"] = "absent"): WireOfficialTrick {
  return { id, name, description, repo: "https://github.com/AltanS/collie-tricks", repoName: "AltanS/collie-tricks", commit: COMMIT, state };
}

const REVIEW = entry("design-review", "Design Review", "Turns an agent's UI notes into Decisions you approve by name.");
const INBOX = entry("pr-inbox", "PR Inbox", "Open pull requests and issues that wait for you.");
const BUILDS = entry("running-builds", "Running Builds", "Builds and long commands running in your sessions now.");

const LEGS: WireTrickInfo = { host: "bluefin", id: "legs", name: "Browser leg", icon: "flask", on: true, state: "ok", places: ["belt"], provenance: { via: "agent" } };

function installed(from: WireOfficialTrick, extra: Partial<WireTrickInfo> = {}): WireTrickInfo {
  return { host: "bluefin", id: from.id, name: from.name, icon: "plug", on: false, state: "off", places: ["belt"], provenance: { via: "repo", repo: from.repoName, sha: "1111111aaaa" }, ...extra };
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

const section = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-section="official"]');
const officialRow = (id: string) => {
  const row = document.querySelector(`[data-official="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no From Collie row for ${id}`);
  return row;
};

beforeEach(() => clearStatus());
afterEach(() => {
  clearStatus();
  vi.useRealTimers();
});

describe("From Collie: the section", () => {
  it("lists each entry not added under the installed tricks: name, its line and Add; a taken one is muted and says so", async () => {
    serveList(() => ({ tricks: [REVIEW, { ...INBOX, state: "taken" }, { ...BUILDS, state: "added" }] }));
    const { store } = await liveStore([LEGS, installed(BUILDS)]);
    renderCard(store);
    await vi.waitFor(() => expect(section()).not.toBeNull());
    const listed = section();
    if (listed === null) throw new Error("no From Collie section");
    expect(within(listed).getByText("From Collie")).toBeInTheDocument();
    // After the installed rows, before the foot.
    const card = screen.getByTestId("tricks-settings");
    const order = [...card.querySelectorAll("[data-trick], [data-section='official']")].map((el) => el.getAttribute("data-trick") ?? "official");
    expect(order).toEqual(["legs", "running-builds", "official"]);
    const review = officialRow("design-review");
    expect(within(review).getByRole("button", { name: "About Design Review" })).toBeInTheDocument();
    expect(within(review).getByText("Turns an agent's UI notes into Decisions you approve by name.").className).toContain("text-muted-foreground");
    const add = within(review).getByRole("button", { name: "Add Design Review" });
    expect(add).toHaveTextContent("Add");
    expect(add).toBeEnabled();
    const inbox = officialRow("pr-inbox");
    expect(within(inbox).getByText("A trick with this name is already here.")).toBeInTheDocument();
    expect(within(inbox).queryByRole("button")).toBeNull();
    // An added entry is a trick row above, not a row here.
    expect(document.querySelector('[data-official="running-builds"]')).toBeNull();
  });

  it("draws no section for an empty list, a crew member's, or a list the phone could not read", async () => {
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
      expect(section()).toBeNull();
      view.unmount();
    }
  });

  it("disables Add on a device that may only read", async () => {
    serveList(() => ({ tricks: [REVIEW] }));
    const { store } = await liveStore([LEGS]);
    renderCard(store, true);
    await vi.waitFor(() => expect(section()).not.toBeNull());
    expect(within(officialRow("design-review")).getByRole("button", { name: "Add Design Review" })).toBeDisabled();
  });
});

describe("From Collie: Add", () => {
  it("posts {} to the entry's add route, spins in place, takes no second tap, and leaves the section once the trick is installed", async () => {
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

describe("From Collie: the About sheet before the add", () => {
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

describe("From Collie: Update", () => {
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
    expect(section()).toBeNull();
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
  });
});

describe("From Collie: the wire", () => {
  it("fetchOfficialTricks reads the list tolerantly: an odd entry is left out, a body of another shape throws", async () => {
    serveList(() => HttpResponse.json({ tricks: [REVIEW, { ...INBOX, commit: "abc" }, { ...BUILDS, state: "gone" }], runsOn: { lead: "desk" } }));
    expect(await fetchOfficialTricks()).toEqual({ tricks: [REVIEW], runsOn: { lead: "desk" } });
    serveList(() => HttpResponse.json({ list: [] }));
    await expect(fetchOfficialTricks()).rejects.toThrow(/not the From Collie list/);
    expect(readOfficialTricksReply({ tricks: [{ ...REVIEW, name: "Le‮gs" }] })).toEqual({ tricks: [] });
    expect(readOfficialTricksReply({ tricks: [{ ...REVIEW, id: "../x" }] })).toEqual({ tricks: [] });
  });

  it("addOfficialTrick posts {} and reads { id, state } back; anything else throws", async () => {
    server.use(http.post("/api/tricks/official/:id/:mode", () => HttpResponse.json({ ok: true })));
    await expect(addOfficialTrick("design-review", "add")).rejects.toThrow(/not \{ id, state \}/);
    expect(readOfficialAddReply({ id: "x", state: "added" })).toEqual({ id: "x", state: "added" });
    expect(readOfficialAddReply({ id: "x", state: "done" })).toBeUndefined();
  });
});
