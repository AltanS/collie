import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { AlphaBar } from "./alpha-bar";
import { AppHeader } from "./app-header";

describe("AlphaBar — the prerelease marker", () => {
  it("shouts the train and the exact version on a prerelease build", () => {
    render(<AlphaBar version="1.0.0-alpha.3" />);
    // Text is split across spans (the version is font-mono), so match the container's flat text.
    const bar = screen.getByText(/ALPHA/).closest("div");
    expect(bar?.textContent?.replace(/\s+/g, " ")).toContain("ALPHA · 1.0.0-alpha.3");
    expect(bar).toHaveAttribute("title", "Pre-release build — 1.0.0-alpha.3");
  });

  it("renders NOTHING on a stable build — solo stable never wears a banner", () => {
    const { container } = render(<AlphaBar version="0.25.0" />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a stable dev build, or for a version it can't parse", () => {
    for (const version of ["1.0.0", "0.25.0-dev", "banana", ""]) {
      const { container, unmount } = render(<AlphaBar version={version} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it("is not a live region — it never changes, so it must not re-announce", () => {
    render(<AlphaBar version="1.0.0-alpha.3" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("colours itself from the shared status-working token, with no dark: variants", () => {
    // The token is declared with light-dark() in index.css, so ONE class set is correct under both
    // themes. A `dark:` variant here would mean someone hard-coded a single-theme colour.
    render(<AlphaBar version="1.0.0-alpha.3" />);
    const cls = screen.getByText(/ALPHA/).closest("div")?.className ?? "";
    expect(cls).toContain("text-status-working");
    expect(cls).toContain("bg-status-working/15");
    expect(cls).toContain("border-status-working/40");
    expect(cls).not.toMatch(/(^|\s)dark:/);
  });
});

describe("AlphaBar inside the one AppHeader", () => {
  // The vitest define stamps BUILD.version as "0.0.0-test" (see vitest.config.ts), which IS a
  // prerelease — so the header under test carries the strip, and these assert it sits there without
  // disturbing the row.
  it("rides above the header row and leaves the row's own content intact", () => {
    render(
      <MemoryRouter>
        <AppHeader bridge="connected" error={false} wordmark>
          <span>webapp › main</span>
        </AppHeader>
      </MemoryRouter>,
    );
    expect(screen.getByText(/TEST/)).toBeInTheDocument();
    expect(screen.getByText("Collie")).toBeInTheDocument();
    expect(screen.getByText("webapp › main")).toBeInTheDocument();
  });

  it("still marks the build while the find bar has taken over the row", () => {
    render(
      <MemoryRouter>
        <AppHeader bridge="connected" error={false} override={<div>FINDBAR</div>} />
      </MemoryRouter>,
    );
    expect(screen.getByText("FINDBAR")).toBeInTheDocument();
    expect(screen.getByText(/TEST/)).toBeInTheDocument();
  });
});
