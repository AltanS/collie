import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearStatus, currentStatus } from "@/lib/status";
import type { StatusChip, TricksReply, WireTrickInfo, WireTrickPart } from "@/lib/tricks/schema";
import { createTricksStore, type TricksStore } from "@/lib/tricks/store";
import type { AgentView } from "@/lib/types";
import { ModelTag } from "./model-tag";
import { USAGE_FIGURE, USAGE_ICON, USAGE_TYPE } from "./usage-type";
import { statusItemsOf } from "./trick-status-item";

// A TRICK'S ITEM IN THE STATUS LINE (M94 re-cut): a chip after Collie's own items, in the row's own type; a
// tap opens the trick's session when it has one; never a control with nothing to do; a stale chip loses its
// tone and its tap says its age.

const FRESH = new Date().toISOString();
const OLD = new Date(Date.now() - 10 * 60_000).toISOString();

function part(trick: string, chip: StatusChip, asOf = FRESH): WireTrickPart {
  return { host: "lodge", trick, part: "status", rev: 1, asOf, fresh: "30s", value: { at: "status", id: "status", chip } };
}

const SESSION: AgentView = {
  paneId: "trick:lodge:tag:due",
  workspaceId: "trick:lodge",
  workspaceLabel: "Tricks",
  workspaceNumber: 2,
  tabId: "trick:lodge:tag",
  agent: "tag",
  status: "idle",
  cwd: "/m",
  focused: false,
  kind: "trick",
};

async function mount(parts: WireTrickPart[], sessions: AgentView[] = []) {
  const tricks = parts.map((p): WireTrickInfo => ({ host: "lodge", id: p.trick, name: p.trick, icon: "flask", on: true, state: "ok", places: ["status"] }));
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
  it("draws each chip at the left end, before the model and the usage, in manifest order, with its icon and its words", async () => {
    await mount([part("tag", { text: "tag 5/7", icon: "tag", tone: "accent" }), part("spend", { text: "$7.42" })]);
    const row = document.querySelector("[data-slot='model-tag']");
    expect(row?.textContent).toContain("Opus 5.5$1.50");
    expect(row?.textContent?.indexOf("$7.42")).toBeLessThan(row?.textContent?.indexOf("Opus 5.5") ?? -1);
    // The eye reads the face; the screen reader reads the trick's name before it.
    const items = [...document.querySelectorAll("[data-slot='trick-status']")].map((el) => [el.getAttribute("data-trick"), el.querySelector("[aria-hidden]:not(svg)")?.textContent]);
    expect(items).toEqual([
      ["tag", "tag 5/7"],
      ["spend", "$7.42"],
    ]);
    const own = document.querySelector("[data-slot='usage-own']");
    const first = document.querySelector("[data-status-item]");
    expect(first).toBeInstanceOf(Node);
    expect(first === null ? 0 : own?.compareDocumentPosition(first)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    // The icon is the trick's own, at the row's icon size. `accent` is not a tone this row inks: the chip reads as the row.
    const icon = document.querySelector("[data-slot='trick-status'] svg");
    expect(icon?.getAttribute("class")).toContain(USAGE_ICON);
    expect(document.querySelector("[data-slot='trick-status']")?.innerHTML).not.toMatch(/text-status-/);
  });

  // THE CHIP DRAWS LIKE THE USAGE FIGURES BESIDE IT (the operator, 2026-11-18): the row's own type constants, no
  // ground of its own, and only `warn` and `danger` change the colour.
  describe("the row's type", () => {
    const classesOf = (el: Element | null) => (el?.getAttribute("class") ?? "").split(/\s+/);

    it("wears the usage row's size, line, weight, colour and tabular digits by name, and sets no ground, size or family", async () => {
      await mount([part("spend", { text: "$7.42", icon: "tag" })]);
      const chip = document.querySelector("[data-slot='trick-status']");
      const classes = classesOf(chip);
      for (const word of [...USAGE_TYPE.split(" "), ...USAGE_FIGURE.split(" ")]) expect(classes).toContain(word);
      expect(classes.some((c) => /^(bg-|border|rounded|font-(sans|mono|serif)|text-(xs|sm|base|lg))/.test(c))).toBe(false);
      // The figures beside it carry the same two constants: one source, no drift.
      const cost = document.querySelector("[data-slot='usage-cost']");
      for (const word of USAGE_FIGURE.split(" ")) expect(classesOf(cost)).toContain(word);
      const tag = document.querySelector("[data-slot='model-tag']");
      for (const word of USAGE_TYPE.split(" ")) expect(classesOf(tag)).toContain(word);
    });

    it("draws plain, muted and the tones this row has no word for in the row's own colour, with no colour class of its own", async () => {
      for (const tone of ["plain", "muted", "ok", "accent"] as const) {
        cleanup();
        await mount([part("spend", { text: "$7.42", icon: "tag", tone })]);
        const chip = document.querySelector("[data-slot='trick-status']");
        expect(chip?.innerHTML, tone).not.toMatch(/text-(status-|foreground|muted-foreground)/);
        expect(classesOf(chip)).toContain("text-muted-foreground");
      }
    });

    it("changes the colour only for warn and danger, to the caution colour and the notice red, text and icon alike", async () => {
      for (const [tone, token] of [["warn", "text-status-working"], ["danger", "text-status-blocked"]] as const) {
        cleanup();
        await mount([part("spend", { text: "$7.42", icon: "tag", tone })]);
        const chip = document.querySelector("[data-slot='trick-status']");
        expect(classesOf(chip?.querySelector("svg") ?? null), tone).toContain(token);
        expect(chip?.querySelector("span[aria-hidden] > span")?.getAttribute("class"), tone).toContain(token);
      }
    });

    it("a stale chip loses even a warn tone and reads as the row", async () => {
      await mount([part("spend", { text: "$7.42", tone: "danger" }, OLD)]);
      expect(document.querySelector("[data-slot='trick-status']")?.innerHTML).not.toMatch(/text-status-/);
    });
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

  it("keeps a warn or danger tone while fresh", async () => {
    await mount([part("spend", { text: "$7.42", tone: "danger" })]);
    expect(document.querySelector("[data-slot='trick-status']")?.innerHTML).toContain("text-status-blocked");
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
    const bare: WireTrickPart = { host: "lodge", trick: "bare", part: "status", rev: 1, asOf: FRESH, fresh: "30s", value: JSON.parse('{"at":"status","id":"status"}') };
    await mount([bare, part("spend", { text: "$7.42" })]);
    expect([...document.querySelectorAll("[data-slot='trick-status']")].map((el) => el.getAttribute("data-trick"))).toEqual(["spend"]);
  });

  it("leaves the other items drawn when one throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bomb: WireTrickPart = {
      host: "lodge",
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

  it("reaches 12px up and 4px down, never into the Belt below, as a box of about 28px", async () => {
    await mount([part("tag", { text: "tag 5/7" })], [SESSION]);
    const reach = screen.getByRole("button", { name: /tag 5\/7/ }).className;
    expect(reach).toContain("before:-top-3");
    expect(reach).toContain("before:-bottom-1");
    expect(reach).not.toContain("-inset-y-4");
  });
});
