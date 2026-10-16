import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { __resetServerBuild, observeServerBuild } from "@/lib/server-build";
import { BuildStamp } from "./build-stamp";

// BUILD.id under vitest is "test" (vitest.config `define`). The footer nag is driven live by the
// shared server-build store, so observing a differing id must flip the nag on in real time.
afterEach(() => {
  __resetServerBuild();
  vi.unstubAllGlobals();
});

describe("BuildStamp — live staleness from the server-build store", () => {
  it("shows no update nag while the server build matches (or is unknown)", () => {
    render(<BuildStamp />);
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();
    act(() => observeServerBuild("test")); // === BUILD.id → not stale
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();
  });

  it("flips the nag on the moment a newer build is observed, and off again when it re-matches", () => {
    render(<BuildStamp />);
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();

    act(() => observeServerBuild("0.99.0+new.1")); // differs from BUILD.id → stale
    expect(screen.getByText(/new build, tap to update/i)).toBeInTheDocument();

    act(() => observeServerBuild("test")); // back in sync (e.g. this bundle was reloaded)
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();
  });
});

describe("BuildStamp — the mount-time config fetch", () => {
  it("seeds the store from /api/config when nothing has been observed yet", async () => {
    let reads = 0;
    server.use(
      http.get("/api/config", () => {
        reads += 1;
        return HttpResponse.json({ push: false, vapidPublicKey: "", build: "0.99.0+new.1" });
      }),
    );

    render(<BuildStamp />);

    await waitFor(() => expect(screen.getByText(/new build, tap to update/i)).toBeInTheDocument());
    expect(reads).toBe(1);
  });

  it("skips the fetch on mount when the build is already known", async () => {
    let reads = 0;
    server.use(
      http.get("/api/config", () => {
        reads += 1;
        return HttpResponse.json({ push: false, vapidPublicKey: "", build: "test" });
      }),
    );
    observeServerBuild("test"); // already known before this mount, e.g. a prior poll

    render(<BuildStamp />);

    // No request to wait for a positive result on, so prove absence by giving any pending
    // fetch a turn to land and then asserting it never did.
    await act(() => Promise.resolve());
    expect(reads).toBe(0);
  });
});

describe("BuildStamp — viewport sizes on dev builds", () => {
  it("shows innerH/visualH/screenH beside a dev build stamp", () => {
    vi.stubGlobal("innerHeight", 956);
    vi.stubGlobal("visualViewport", Object.assign(new EventTarget(), { height: 899.6 }));
    vi.stubGlobal("screen", { height: 923 });
    render(<BuildStamp version="1.19.2-dev" />);
    expect(screen.getByText("vp 956/900/923")).toBeInTheDocument();
  });

  it("updates when the visual viewport resizes", () => {
    const visual = Object.assign(new EventTarget(), { height: 900 });
    vi.stubGlobal("innerHeight", 956);
    vi.stubGlobal("visualViewport", visual);
    vi.stubGlobal("screen", { height: 923 });
    render(<BuildStamp version="1.19.2-dev" />);
    visual.height = 600;
    act(() => {
      visual.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByText("vp 956/600/923")).toBeInTheDocument();
  });

  it("shows nothing on a release version", () => {
    vi.stubGlobal("innerHeight", 956);
    vi.stubGlobal("screen", { height: 923 });
    render(<BuildStamp version="1.19.2" />);
    expect(screen.queryByText(/^vp /)).not.toBeInTheDocument();
  });
});
