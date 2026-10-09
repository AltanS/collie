import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import {
  folderName,
  hasFolders,
  NO_FOLDERS,
  prefetchFolders,
  resetFoldersCacheForTests,
  useFolders,
  visibleFolders,
} from "./folders";

// The pure half of the New page's folder list (#289). The read, the star and the sheet around
// them are driven in routes/new.test.tsx and routes/home-new-button.test.tsx.

describe("folderName — the name a row leads with", () => {
  it("is the last segment", () => {
    expect(folderName("/home/you/src/web")).toBe("web");
    expect(folderName("/srv/api/")).toBe("api");
    expect(folderName("relative")).toBe("relative");
  });

  it("the root names itself", () => {
    expect(folderName("/")).toBe("/");
  });
});

describe("visibleFolders — home is never drawn", () => {
  it("drops home from both lists, however either side spells the trailing slash", () => {
    const out = visibleFolders({
      recent: ["/home/you", "/home/you/a"],
      favourites: ["/home/you/", "/srv/b"],
      home: "/home/you/",
    });
    expect(out).toEqual({ recent: ["/home/you/a"], favourites: ["/srv/b"], home: "/home/you/" });
  });

  it("keeps a folder that merely shares home as a prefix", () => {
    expect(visibleFolders({ recent: ["/home/youth"], favourites: [], home: "/home/you" }).recent).toEqual([
      "/home/youth",
    ]);
  });

  it("drops nothing when the machine did not say where home is", () => {
    expect(visibleFolders({ recent: ["/home/you"], favourites: [], home: "" }).recent).toEqual(["/home/you"]);
  });
});

describe("hasFolders", () => {
  it("is false for an empty list and true when either list has a row", () => {
    expect(hasFolders(NO_FOLDERS)).toBe(false);
    expect(hasFolders({ recent: ["/a"], favourites: [], home: "" })).toBe(true);
    expect(hasFolders({ recent: [], favourites: ["/a"], home: "" })).toBe(true);
  });
});

// ── The cache (the sheet opens at its final height) ──────────────────────────────────────────────
// The hook's state lives in a module-level cache keyed by scope, so a second sheet instance starts
// with the list the first one read. The setup file empties it before every test; the tests below
// also empty it themselves so they read on their own.

/** Answer `GET /api/folders` per host (absent = the lead), counting every read. */
function serve(byHost: Record<string, { recent: string[]; favourites: string[]; home: string } | 500>) {
  const reads: string[] = [];
  server.use(
    http.get("/api/folders", ({ request }) => {
      const host = new URL(request.url).searchParams.get("host") ?? "";
      reads.push(host);
      const answer = byHost[host];
      if (answer === undefined || answer === 500) return HttpResponse.json({ error: "down" }, { status: 500 });
      return HttpResponse.json(answer);
    }),
  );
  return reads;
}

const lead = { recent: ["/srv/lead"], favourites: [], home: "/home/you" };
const peer = { recent: ["/srv/peer"], favourites: [], home: "/home/w" };

describe("useFolders — the cache", () => {
  beforeEach(() => resetFoldersCacheForTests());

  it("a second instance for the same scope has the list on its first render", async () => {
    serve({ "": lead });
    const first = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(first.result.current.folders.recent).toEqual(["/srv/lead"]));

    // Closed, so it reads nothing: what it draws on its first render came from the cache alone.
    const renders: string[][] = [];
    renderHook(() => {
      const out = useFolders(undefined, false);
      renders.push([...out.folders.recent]);
      return out;
    });
    expect(renders[0]).toEqual(["/srv/lead"]);
  });

  it("a list cached for one scope is never returned for another", async () => {
    serve({ "": lead, workshop: peer });
    const first = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(first.result.current.folders.recent).toEqual(["/srv/lead"]));

    const other = renderHook(() => useFolders({ host: "workshop" }, false));
    expect(other.result.current.folders).toBe(NO_FOLDERS);
    const sessionOther = renderHook(() => useFolders({ session: "work" }, false));
    expect(sessionOther.result.current.folders).toBe(NO_FOLDERS);

    // Opened for the peer it reads the peer's own list, and the lead's cache entry is untouched.
    const peerOpen = renderHook(() => useFolders({ host: "workshop" }, true));
    await waitFor(() => expect(peerOpen.result.current.folders.recent).toEqual(["/srv/peer"]));
    expect(renderHook(() => useFolders(undefined, false)).result.current.folders.recent).toEqual(["/srv/lead"]);
  });

  it("a failed read clears that key's cache and shows no list", async () => {
    serve({ "": lead });
    const hook = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(hook.result.current.folders.recent).toEqual(["/srv/lead"]));

    serve({ "": 500 });
    // A second instance opens and reads again.
    const reopened = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(reopened.result.current.folders).toBe(NO_FOLDERS));
    expect(hook.result.current.folders).toBe(NO_FOLDERS);
    // The entry is gone, not kept stale: a fresh instance that does not read starts empty.
    expect(renderHook(() => useFolders(undefined, false)).result.current.folders).toBe(NO_FOLDERS);
  });

  it("a failed read leaves another key's cache alone", async () => {
    serve({ "": lead, workshop: 500 });
    const first = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(first.result.current.folders.recent).toEqual(["/srv/lead"]));
    const peerOpen = renderHook(() => useFolders({ host: "workshop" }, true));
    await waitFor(() => expect(peerOpen.result.current.folders).toBe(NO_FOLDERS));
    expect(renderHook(() => useFolders(undefined, false)).result.current.folders.recent).toEqual(["/srv/lead"]);
  });

  it("an open reads again and redraws a list that changed", async () => {
    serve({ "": lead });
    const first = renderHook(() => useFolders(undefined, true));
    await waitFor(() => expect(first.result.current.folders.recent).toEqual(["/srv/lead"]));

    const reads = serve({ "": { ...lead, recent: ["/srv/lead", "/srv/new"] } });
    const second = renderHook(() => useFolders(undefined, true));
    expect(second.result.current.folders.recent).toEqual(["/srv/lead"]);
    await waitFor(() => expect(second.result.current.folders.recent).toEqual(["/srv/lead", "/srv/new"]));
    expect(reads).toEqual([""]);
  });
});

describe("prefetchFolders", () => {
  beforeEach(() => resetFoldersCacheForTests());

  it("reads into the cache so a sheet that opens later has the list at once", async () => {
    serve({ "": lead });
    const sheet = renderHook(() => useFolders(undefined, false));
    prefetchFolders();
    await waitFor(() => expect(sheet.result.current.folders.recent).toEqual(["/srv/lead"]));
  });

  it("shares one read between concurrent calls for the same scope, and not across scopes", async () => {
    const reads = serve({ "": lead, workshop: peer });
    prefetchFolders();
    prefetchFolders(undefined);
    prefetchFolders({});
    prefetchFolders({ host: "workshop" });
    prefetchFolders({ host: "workshop" });
    const sheet = renderHook(() => useFolders({ host: "workshop" }, false));
    await waitFor(() => expect(sheet.result.current.folders.recent).toEqual(["/srv/peer"]));
    await waitFor(() => expect(reads).toHaveLength(2));
    expect(reads.toSorted()).toEqual(["", "workshop"]);
  });

  it("reads again on a later call once the first has landed", async () => {
    const reads = serve({ "": lead });
    const sheet = renderHook(() => useFolders(undefined, false));
    prefetchFolders();
    await waitFor(() => expect(sheet.result.current.folders.recent).toEqual(["/srv/lead"]));
    prefetchFolders();
    await waitFor(() => expect(reads).toHaveLength(2));
  });

  it("a failed prefetch leaves no list", async () => {
    const reads = serve({ "": 500 });
    const sheet = renderHook(() => useFolders(undefined, false));
    prefetchFolders();
    await waitFor(() => expect(reads).toHaveLength(1));
    expect(sheet.result.current.folders).toBe(NO_FOLDERS);
  });
});
