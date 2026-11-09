import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStatus, currentStatus } from "@/lib/status";
import type { StatusChip, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { ModelTag } from "./model-tag";
import { statusItemsOf } from "./trick-status-item";

// A TRICK'S ITEM IN THE STATUS LINE (M94 re-cut): a chip after Collie's own items, in the row's own type; a
// tap opens the trick's session when it has one; never a control with nothing to do; a stale chip loses its
// tone and its tap says its age.

const FRESH = new Date().toISOString();
const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

function part(trick: string, chip: StatusChip, asOf = FRESH): WireTrickPart {
  return { host: "bluefin", trick, part: "status", rev: 1, asOf, fresh: "30s", value: { at: "status", id: "status", chip } };
}

const SESSION: AgentView = {
  paneId: "trick:bluefin:tag:due",
  workspaceId: "trick:bluefin",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:bluefin:tag",
  agent: "tag",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

async function mount(parts: WireTrickPart[], sessions: AgentView[] = []) {
  const tricks = parts.map((p): WireTrickInfo => ({ host: "bluefin", id: p.trick, name: p.trick, icon: "flask", on: true, state: "ok", places: ["status"] }));
  const reply: TricksReply = { rev: 1, tricks, parts, present: parts.map((p) => `${p.host}/${p.trick}/${p.part}`) };
  const store: TricksStore = createTricksStore({ fetchTricks: async () => reply, tapTrick: async () => ({ rid: "r", code: "ok" as const }), mintRequestId: () => "00000000-0000-4000-8000-000000000001" });
  await store.syncTricks(1);
  const onOpenSession = vi.fn();
  const trailing = statusItemsOf({ parts, sessions, onOpenSession, store });
  render(<ModelTag model="claude-opus-5-5" usage={{ cost: 1.5 }} trailing={trailing} />);
  return { onOpenSession };
}

beforeEach(() => clearStatus());
afterEach(() => cleanup());

describe("the tricks' items in the status line", () => {
  it("draws each chip after the cost, in manifest order, with its icon and its words", async () => {
    await mount([part("tag", { text: "tag 5/7", icon: "tag", tone: "accent" }), part("spend", { text: "$7.42" })]);
    const row = document.querySelector("[data-slot='model-tag']");
    expect(row?.textContent).toContain("Opus 5.5$1.50");
    // The eye reads the face; the screen reader reads the trick's name before it.
    const items = [...document.querySelectorAll("[data-slot='trick-status']")].map((el) => [el.getAttribute("data-trick"), el.querySelector("[aria-hidden]:not(svg)")?.textContent]);
    expect(items).toEqual([
      ["tag", "tag 5/7"],
      ["spend", "$7.42"],
    ]);
    const own = document.querySelector("[data-slot='usage-own']");
    const first = document.querySelector("[data-status-item]");
    expect(first).toBeInstanceOf(Node);
    expect(first === null ? 0 : own?.compareDocumentPosition(first)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The tone inks the chip through the schema's tone map, and the icon is the trick's own.
    expect(document.querySelector("[data-slot='trick-status'] svg")).not.toBeNull();
    expect(document.querySelector("[data-slot='trick-status'] span.text-status-working, [data-slot='trick-status'] span[class*='text-']")).not.toBeNull();
  });

  it("is no control with no session: a span, with the words for a screen reader, and takes no tap", async () => {
    await mount([part("spend", { text: "$7.42" })]);
    const item = document.querySelector("[data-slot='trick-status']");
    expect(item?.tagName).toBe("SPAN");
    expect(screen.queryByRole("button")).toBeNull();
    expect(item?.querySelector(".sr-only")?.textContent).toBe("spend: $7.42");
  });

  it("opens the trick's session on a tap when it has one", async () => {
    const { onOpenSession } = await mount([part("tag", { text: "tag 5/7" })], [SESSION]);
    const button = screen.getByRole("button", { name: "tag: tag 5/7. Open tag" });
    expect(button.className).toContain("pointer-events-auto");
    fireEvent.click(button);
    expect(onOpenSession).toHaveBeenCalledWith(SESSION);
    expect(currentStatus()).toBeNull();
  });

  it("goes grey past its fresh window, and a tap says its age", async () => {
    await mount([part("spend", { text: "$7.42", tone: "ok" }, OLD)]);
    const item = screen.getByRole("button", { name: "spend: $7.42" });
    expect(item.dataset.stale).toBe("true");
    expect(item.innerHTML).not.toContain("text-status-done");
    fireEvent.click(item);
    expect(currentStatus()?.text).toMatch(/^Updated /);
  });

  it("keeps its tone while fresh", async () => {
    await mount([part("spend", { text: "$7.42", tone: "ok" })]);
    expect(document.querySelector("[data-slot='trick-status']")?.innerHTML).toContain("text-status-done");
  });

  it("draws a clock beside its words", async () => {
    await mount([part("build", { text: "build", at: String(Date.now() - 120_000), clock: "ago" })]);
    expect(document.querySelector("[data-slot='trick-status'] time[data-clock='ago']")?.textContent).not.toBe("");
  });

  it("never nests a control in another", async () => {
    await mount([part("tag", { text: "tag 5/7" })], [SESSION]);
    expect(document.querySelectorAll("button button")).toHaveLength(0);
    await act(async () => {});
  });
});

// A PART THAT FAILS DRAWS ALONE (M94 review).
describe("a status part that is broken", () => {
  it("draws nothing for a part with no chip, and keeps the other items", async () => {
    const bare: WireTrickPart = { host: "bluefin", trick: "bare", part: "status", rev: 1, asOf: FRESH, fresh: "30s", value: JSON.parse('{"at":"status","id":"status"}') };
    await mount([bare, part("spend", { text: "$7.42" })]);
    expect([...document.querySelectorAll("[data-slot='trick-status']")].map((el) => el.getAttribute("data-trick"))).toEqual(["spend"]);
  });

  it("leaves the other items drawn when one throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bomb: WireTrickPart = {
      host: "bluefin",
      trick: "bomb",
      part: "status",
      rev: 1,
      asOf: FRESH,
      fresh: "30s",
      value: { at: "status", id: "status", get chip(): StatusChip { throw new Error("a chip that cannot be read"); } },
    };
    await mount([part("tag", { text: "tag 5/7" }), bomb, part("spend", { text: "$7.42" })]);
    expect([...document.querySelectorAll("[data-slot='trick-status']")].map((el) => el.getAttribute("data-trick"))).toEqual(["tag", "spend"]);
    vi.restoreAllMocks();
  });

  it("reaches no higher than its own line, so a touch above it reaches the Chat", async () => {
    await mount([part("tag", { text: "tag 5/7" })], [SESSION]);
    const reach = screen.getByRole("button", { name: /tag 5\/7/ }).className;
    expect(reach).toContain("before:top-0");
    expect(reach).not.toContain("-inset-y-4");
  });
});
