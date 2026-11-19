import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { __reloadProjectPictures, __resetProjectPictures, setProjectPictures } from "@/lib/project-picture";
import { AgentTile } from "./agent-tile";

// THE AGENT TILE (issue 811, ADR 0160): the agent's logo, or the project's picture with the logo in its
// corner, in a box whose size never changes.

const V = "0123456789ab0123456789ab";
const COPY = "data:image/png;base64,SMALL";

/** A device that already holds the picture, as after a cold open. */
function holdPicture() {
  localStorage.setItem("collie:project-picture-copies:v1", JSON.stringify({ ["\u0000" + V]: COPY }));
  __reloadProjectPictures();
}

const pane = { agent: "claude", paneId: "p1" };
const tile = (c: HTMLElement) => c.querySelector<HTMLElement>('[data-slot="agent-tile"]')!;
const pictures = (c: HTMLElement) => c.querySelectorAll<HTMLImageElement>('img[alt=""]');

beforeEach(() => __resetProjectPictures());
afterEach(() => __resetProjectPictures());

describe("AgentTile", () => {
  it("draws only the agent's logo when the pane has no picture", () => {
    const { container } = render(<AgentTile pane={pane} />);
    expect(screen.getAllByRole("img", { name: "claude logo" })).toHaveLength(1);
    expect(pictures(container)).toHaveLength(0);
    expect(tile(container).getAttribute("data-picture")).toBe("off");
  });

  it("draws the picture, decorative, with the agent's logo in the corner when the device holds a copy", () => {
    holdPicture();
    const { container } = render(<AgentTile pane={{ ...pane, picture: V }} />);
    const shown = pictures(container);
    expect(shown).toHaveLength(1);
    expect(shown[0]?.getAttribute("src")).toBe(COPY);
    // The tile stays named by the logo it always draws.
    expect(screen.getAllByRole("img", { name: "claude logo" })).toHaveLength(1);
    expect(tile(container).getAttribute("data-picture")).toBe("on");
  });

  it("draws only the logo while the picture has not arrived yet", () => {
    const { container } = render(<AgentTile pane={{ ...pane, picture: V }} />);
    expect(pictures(container)).toHaveLength(0);
    expect(screen.getAllByRole("img", { name: "claude logo" })).toHaveLength(1);
  });

  it("keeps the same size class with and without a picture", () => {
    const without = render(<AgentTile pane={pane} className="size-5" />);
    const sizeWithout = tile(without.container).className;
    holdPicture();
    const withPicture = render(<AgentTile pane={{ ...pane, picture: V }} className="size-5" />);
    const sizeWith = tile(withPicture.container).className;
    expect(sizeWithout).toContain("size-5");
    expect(sizeWith).toBe(sizeWithout);
  });

  it("sizes the corner logo by the tile, and keeps it out of the flow", () => {
    holdPicture();
    const { container } = render(<AgentTile pane={{ ...pane, picture: V }} className="size-5" />);
    const corner = container.querySelector("svg[aria-label='claude logo']");
    expect(corner?.getAttribute("class")).toContain("absolute");
    expect(corner?.getAttribute("class")).toContain("size-3");
  });

  it("falls back to an initials tile for an agent with no logo, picture or not", () => {
    holdPicture();
    render(<AgentTile pane={{ agent: "mystery", paneId: "p2", picture: V }} />);
    expect(screen.getByRole("img", { name: "mystery icon" })).toBeInTheDocument();
  });

  it("draws only the logo with the switch off, whatever the pane carries", () => {
    holdPicture();
    setProjectPictures(false);
    const { container } = render(<AgentTile pane={{ ...pane, picture: V }} />);
    expect(pictures(container)).toHaveLength(0);
    expect(screen.getAllByRole("img", { name: "claude logo" })).toHaveLength(1);
    expect(tile(container).getAttribute("data-picture")).toBe("off");
  });

  it("draws the remembered picture for a pane whose view names none yet", () => {
    holdPicture();
    localStorage.setItem("collie:project-picture-panes:v1", JSON.stringify({ "\u0000p1": V }));
    __reloadProjectPictures();
    const { container } = render(<AgentTile pane={pane} />);
    expect(pictures(container)).toHaveLength(1);
  });
});
