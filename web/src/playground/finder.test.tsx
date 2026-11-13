import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { PlaygroundApp, SECTIONS } from "./app";

// The search over the design reference's entries (find.ts, `Finder` in app.tsx). Both shells are
// always mounted (app.tsx's chrome comment), so every query scopes to the phone header's finder,
// `data-slot="finder-h"`, and its tab list, the horizontal one.

const SLOW = { timeout: 12_000 } as const;

function at(address: string): void {
  window.history.replaceState(null, "", address);
}

function phoneField(): HTMLInputElement {
  const finder = document.querySelector<HTMLElement>('[data-slot="finder-h"]');
  if (finder === null) throw new Error("no phone finder");
  return within(finder).getByRole("textbox", { name: "Find an entry" });
}

function phoneTabs(): string[] {
  const list = screen.queryAllByRole("tablist").find((el) => el.getAttribute("aria-orientation") === "horizontal");
  return list === undefined ? [] : within(list).getAllByRole("tab").map((tab) => tab.textContent ?? "");
}

afterEach(() => {
  cleanup();
  at("/");
});

describe("the design reference's search", () => {
  it("narrows the list as you type, counts the matches and keeps the query in the address", async () => {
    at("/design.html#idle");
    render(<PlaygroundApp />);
    await screen.findAllByRole("heading", { name: "Idle & resume" }, SLOW);
    expect(phoneTabs()).toHaveLength(SECTIONS.length);

    fireEvent.change(phoneField(), { target: { value: "walky" } });
    expect(phoneTabs()).toEqual(["WalkyTalky"]);
    expect(within(document.querySelector<HTMLElement>('[data-slot="finder-h"]')!).getByRole("status")).toHaveTextContent(
      `1 of ${String(SECTIONS.length)}`,
    );
    expect(window.location.search).toBe("?q=walky");
    expect(window.location.hash).toBe("#idle");

    // A component name finds the entry that mounts it.
    fireEvent.change(phoneField(), { target: { value: "DecisionCard" } });
    expect(phoneTabs()).toEqual(expect.arrayContaining(["Hill", "Dashboard places"]));
  });

  it("opens the entry and the query a link carries, on a cold load", async () => {
    at("/design.html?q=cache#cache");
    render(<PlaygroundApp />);
    await screen.findAllByRole("heading", { name: "Cache" }, SLOW);
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "pg-panel-cache");
    expect(phoneField().value).toBe("cache");
    expect(phoneTabs()).toEqual(["Cache"]);
  });

  it("says when nothing matches, and Show all and the clear button bring every entry back", async () => {
    at("/design.html#idle");
    render(<PlaygroundApp />);
    await screen.findAllByRole("heading", { name: "Idle & resume" }, SLOW);
    const finder = within(document.querySelector<HTMLElement>('[data-slot="finder-h"]')!);

    fireEvent.change(phoneField(), { target: { value: "zzzz" } });
    expect(finder.getByRole("status")).toHaveTextContent("No entry matches");
    expect(phoneTabs()).toEqual([]);
    fireEvent.click(finder.getByRole("button", { name: `Show all ${String(SECTIONS.length)}` }));
    expect(phoneField().value).toBe("");
    expect(phoneTabs()).toHaveLength(SECTIONS.length);
    expect(window.location.search).toBe("");

    fireEvent.change(phoneField(), { target: { value: "pins" } });
    fireEvent.click(finder.getByRole("button", { name: "Clear the search" }));
    expect(phoneField().value).toBe("");
    expect(window.location.search).toBe("");
  });

  it("opens the first match on Enter and keeps the query", async () => {
    at("/design.html#idle");
    render(<PlaygroundApp />);
    await screen.findAllByRole("heading", { name: "Idle & resume" }, SLOW);

    fireEvent.change(phoneField(), { target: { value: "cachechip" } });
    fireEvent.keyDown(phoneField(), { key: "Enter" });
    await screen.findAllByRole("heading", { name: "Cache" }, SLOW);
    await waitFor(() => expect(window.location.hash).toBe("#cache"));
    expect(window.location.search).toBe("?q=cachechip");
  });
});
