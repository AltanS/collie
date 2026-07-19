import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { __resetServerBuild, observeServerBuild } from "@/lib/server-build";
import { BuildStamp } from "./build-stamp";

// BUILD.id under vitest is "test" (vitest.config `define`). The footer nag is driven live by the
// shared server-build store, so observing a differing id must flip the nag on in real time.
afterEach(() => __resetServerBuild());

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
    expect(screen.getByText(/new build — tap to update/i)).toBeInTheDocument();

    act(() => observeServerBuild("test")); // back in sync (e.g. this bundle was reloaded)
    expect(screen.queryByText(/tap to update/i)).not.toBeInTheDocument();
  });
});
