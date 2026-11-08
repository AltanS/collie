import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../json";
import { LEGS_DOCUMENT, TRACKER_DOCUMENT, nodeDocument } from "./fixtures";
import { heightCss, reservedHeight, viewForm } from "./layout";
import { renderView, type RenderCtx } from "./render";
import { CORE_NODE_KINDS, MORE_NODE_KINDS, TONE_TEXT_CLASS, parseTrickDocument, type NodeKind, type ViewNode } from "./schema";
import type { TapState } from "./store";

const NOW = Date.parse("2026-11-08T09:41:00Z");
const KEY = "bluefin/legs/legs";

/** A fixture as the typed node the schema's own parser reads it to: what the renderer gets from the bridge. */
function viewOf(doc: JsonObject): ViewNode {
  const parsed = parseTrickDocument(doc);
  const part = parsed.parts.find((p) => p.place === "session");
  if (part?.place !== "session") throw new Error(`no session part: ${JSON.stringify(parsed.refusals)}`);
  return part.part.view;
}

function fixture(kind: NodeKind): ViewNode {
  return viewOf(nodeDocument(kind));
}

/** A node as a crew member on a newer Collie might send it: a kind this Collie has never heard of. */
function foreign(kind: string): ViewNode {
  const node: ViewNode = JSON.parse(JSON.stringify({ kind, text: "x", lines: 1 }));
  return node;
}

function ctxOf(over: Partial<RenderCtx> = {}): RenderCtx {
  return { partKey: KEY, trickName: "Browser leg", stale: false, onTap: vi.fn(), onDraft: vi.fn(), onOpen: vi.fn(), now: NOW, ...over };
}

function draw(node: ViewNode, over: Partial<RenderCtx> = {}) {
  return render(<div>{renderView(node, ctxOf(over))}</div>);
}

/** The root box of a drawn node. */
function rootOf(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>("[data-trick-node]");
  if (root === null) throw new Error("no node drawn");
  return root;
}

describe("every core kind draws", () => {
  it.each(CORE_NODE_KINDS)("%s, as its snapshot", (kind) => {
    const { container } = draw(fixture(kind));
    expect(rootOf(container).dataset.trickNode).toBe(kind);
    expect(container.querySelector('[data-trick-node="placeholder"][data-kind="' + kind + '"]')).toBeNull();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("draws the legs and the tracker views whole, with the core kinds only", () => {
    for (const doc of [LEGS_DOCUMENT, TRACKER_DOCUMENT]) {
      const { container, unmount } = draw(viewOf(doc));
      expect(container.querySelectorAll('[data-trick-node="placeholder"]')).toHaveLength(0);
      expect(container.innerHTML).toMatchSnapshot();
      unmount();
    }
  });
});

describe("the placeholder", () => {
  it.each(MORE_NODE_KINDS)("stands in for %s, which slice 08 draws", (kind) => {
    const { container } = draw(fixture(kind));
    const box = container.querySelector<HTMLElement>(`[data-trick-node="placeholder"][data-kind="${kind}"]`);
    expect(box).not.toBeNull();
    expect(box?.textContent).toBe("This Collie cannot draw this part");
    expect(box?.style.height).toBe("2.75rem");
  });

  it("stands in for a kind this Collie has never heard of", () => {
    const { container } = draw(foreign("hologram"));
    expect(rootOf(container).dataset.kind).toBe("hologram");
    expect(rootOf(container).textContent).toBe("This Collie cannot draw this part");
    expect(reservedHeight(foreign("hologram"))).toEqual({ rem: 2.75, px: 0 });
  });

  it("stands in for one child and lets its siblings draw", () => {
    const { container } = draw(fixture("row"));
    expect(container.querySelector('[data-trick-node="text"]')?.textContent).toBe("left");
    expect(container.querySelector('[data-trick-node="placeholder"][data-kind="badge"]')).not.toBeNull();
  });
});

// Two inputs of each kind that differ in data and agree in form. Each pair must draw the same box.
const PAIRS = {
  stack: [
    { kind: "stack", children: [{ kind: "text", text: "one", lines: 1 }, { kind: "number", value: 3 }] },
    { kind: "stack", children: [{ kind: "text", text: "a much longer line that would wrap if it could", lines: 1 }, { kind: "number", value: "23/34", label: "cases" }] },
  ],
  row: [
    { kind: "row", children: [{ kind: "text", text: "left", lines: 1 }, { kind: "time", at: "2026-11-08T09:38:12Z" }] },
    { kind: "row", children: [{ kind: "text", text: "a different left side", lines: 1 }, { kind: "time", at: "2026-11-01T09:38:12Z", label: "since" }] },
  ],
  text: [
    { kind: "text", text: "short", lines: 3, role: "body" },
    { kind: "text", text: "line one\nline two\nline three\nline four\nline five, which the box never shows", lines: 3, role: "body", tone: "error" },
  ],
  number: [
    { kind: "number", value: 7 },
    { kind: "number", value: "1234/5678", label: "cases green", tone: "ok" },
  ],
  kv: [
    { kind: "kv", rows: [{ label: "A", value: "1" }, { label: "B", value: "2" }] },
    { kind: "kv", rows: [{ label: "Harness", value: "claude 2.1.318, a long version line" }, { label: "Mode", value: "replay", tone: "ok" }] },
  ],
  list: [
    { kind: "list", rows: 3, items: [{ text: "one" }] },
    {
      kind: "list",
      rows: 3,
      items: [
        { text: "one", detail: "detail", icon: "bug", tone: "error", trailing: "red", intent: "open" },
        { text: "two" },
        { text: "three" },
        { text: "four" },
        { text: "five" },
      ],
    },
  ],
  button: [
    { kind: "button", label: "Go", intent: "go" },
    { kind: "button", label: "Rerun every red case now", intent: "rerun", primary: true, icon: "refresh", disabled: true },
  ],
  progress: [
    { kind: "progress", value: 5 },
    { kind: "progress", steps: [{ label: "build", state: "done" }, { label: "test", state: "running" }, { label: "ship", state: "todo" }] },
  ],
  steps: [
    { kind: "steps", steps: [{ label: "one", state: "todo" }] },
    { kind: "steps", steps: Array.from({ length: 12 }, (_, i) => ({ label: `step ${i}`, state: i < 5 ? ("done" as const) : i === 5 ? ("failed" as const) : ("todo" as const) })) },
  ],
  mark: [
    { kind: "mark", face: "1/2" },
    { kind: "mark", icon: "flask", face: "23/34", count: 4, tone: "error", intent: "open" },
  ],
  time: [
    { kind: "time", at: "2026-11-08T09:40:30Z" },
    { kind: "time", at: "2026-10-01T09:40:30Z", style: "until", label: "next run" },
  ],
} satisfies { readonly [K in (typeof CORE_NODE_KINDS)[number]]: readonly [ViewNode, ViewNode] };

/** A list's rows in order: the filled rows inside its group, then the empty hairline rows under it. */
function listRows(root: HTMLElement): HTMLElement[] {
  const filled = [...root.querySelectorAll<HTMLElement>('[data-slot="list-group"] > *')];
  const empty = [...root.querySelectorAll<HTMLElement>(':scope > [data-slot="trick-list-empty"]')];
  return [...filled, ...empty];
}

/** What fixes a box's height in the DOM: its own stated height, and for a list its reserved rows. */
function heightEvidence(container: HTMLElement): string {
  const root = rootOf(container);
  const rows = root.dataset.trickNode === "list" ? listRows(root).map((row) => (row.classList.contains("h-11") ? "h-11" : "?")).join(",") : "";
  return `${root.style.height}|${rows}`;
}

describe("a node's height is its form's, not its data's", () => {
  it.each(CORE_NODE_KINDS)("%s draws one height for two inputs of one form", (kind) => {
    const [a, b] = PAIRS[kind];
    expect(heightCss(reservedHeight(a))).toBe(heightCss(reservedHeight(b)));
    expect(viewForm(a)).toBe(viewForm(b));
    const first = draw(a);
    const one = heightEvidence(first.container);
    first.unmount();
    const second = draw(b);
    expect(heightEvidence(second.container)).toBe(one);
  });

  it("states the reserved heights in rem, so they grow with the text size", () => {
    expect(heightCss(reservedHeight({ kind: "text", text: "x", lines: 3, role: "body" }))).toBe("3.75rem");
    expect(heightCss(reservedHeight({ kind: "text", text: "x", lines: 2, role: "mono" }))).toBe("2rem");
    expect(heightCss(reservedHeight({ kind: "number", value: 1 }))).toBe("3rem");
    expect(heightCss(reservedHeight({ kind: "list", rows: 3, items: [] }))).toBe("calc(8.25rem + 2px)");
    expect(heightCss(reservedHeight({ kind: "progress", value: 1 }))).toBe("2rem");
    expect(heightCss(reservedHeight({ kind: "kv", cols: 2, rows: [{ label: "a", value: "1" }, { label: "b", value: "2" }, { label: "c", value: "3" }] }))).toBe("4.5rem");
    expect(heightCss(reservedHeight(PAIRS.stack[0]))).toBe("4.75rem");
  });

  it("calls a change of lines or rows a new form, and a change of words the same form", () => {
    expect(viewForm({ kind: "text", text: "a", lines: 2 })).not.toBe(viewForm({ kind: "text", text: "a", lines: 3 }));
    expect(viewForm({ kind: "list", rows: 2, items: [] })).not.toBe(viewForm({ kind: "list", rows: 3, items: [] }));
    expect(viewForm({ kind: "text", text: "a", lines: 2 })).toBe(viewForm({ kind: "text", text: "b", lines: 2 }));
  });

  it("clamps a number from another Collie into its limits", () => {
    expect(reservedHeight(JSON.parse('{"kind":"text","text":"x","lines":400}'))).toEqual({ rem: 15, px: 0 });
    expect(reservedHeight(JSON.parse('{"kind":"list","rows":-3,"items":[]}'))).toEqual({ rem: 2.75, px: 2 });
  });
});

describe("a list", () => {
  it("draws its reserved rows, and '+n more' in the last one past them", () => {
    const { container } = draw(PAIRS.list[1]);
    const rows = listRows(rootOf(container));
    expect(rows).toHaveLength(3);
    expect(rows[2]?.textContent).toBe("+3 more");
  });

  it("fills the rows nobody uses with empty ones", () => {
    const { container } = draw(PAIRS.list[0]);
    expect(container.querySelectorAll('[data-slot="trick-list-empty"]')).toHaveLength(2);
  });

  it("draws an empty slot as a hairline row in the border token, outside the group's frame (slice 03 look fix)", () => {
    const { container } = draw(PAIRS.list[0]);
    const group = container.querySelector('[data-slot="list-group"]');
    const empties = [...container.querySelectorAll<HTMLElement>('[data-slot="trick-list-empty"]')];
    expect(empties).toHaveLength(2);
    for (const empty of empties) {
      // Not a box: no frame of the group around it, no edge of its own but the one line at its foot.
      expect(group?.contains(empty)).toBe(false);
      expect(empty.className).toContain("border-b");
      expect(empty.className).toContain("border-border");
      expect(empty.className).not.toMatch(/(^|\s)border(\s|$)/);
      expect(empty.className).toContain("h-11");
      expect(empty.childElementCount).toBe(0);
    }
    // The group frames the filled rows only.
    expect(group?.childElementCount).toBe(1);
  });

  it("keeps a list with no item at its reserved height, with no empty frame", () => {
    const { container } = draw({ kind: "list", rows: 3, items: [] });
    expect(container.querySelector('[data-slot="list-group"]')).toBeNull();
    expect(container.querySelectorAll('[data-slot="trick-list-empty"]')).toHaveLength(3);
  });

  it("puts the count in the end slot of a one-row list", () => {
    const { container } = draw({ kind: "list", rows: 1, items: [{ text: "one" }, { text: "two" }, { text: "three" }] });
    expect(listRows(rootOf(container))).toHaveLength(1);
    expect(rootOf(container).textContent).toContain("+2 more");
  });

  it("makes a row with an intent a 44px control that taps with its args", () => {
    const onTap = vi.fn();
    const { container } = draw(fixture("list"), { onTap });
    const row = container.querySelector<HTMLButtonElement>('button[data-slot="trick-list-row"]');
    expect(row?.className).toContain("h-11");
    fireEvent.click(row!);
    expect(onTap).toHaveBeenCalledWith(KEY, "open-case", { n: 24 }, "v/0");
    // The row with no intent is not a control.
    expect(container.querySelectorAll('div[data-slot="trick-list-row"]')).toHaveLength(1);
  });
});

describe("tones", () => {
  it("ink through the tone map, and only through it", () => {
    const { container } = draw({ kind: "text", text: "red", lines: 1, tone: "error" });
    expect(container.querySelector("p")?.className).toContain(TONE_TEXT_CLASS.error);
  });

  it("go grey past the fresh window, and the inks stay", () => {
    const stale = draw({ kind: "stack", children: [{ kind: "text", text: "red", lines: 1, tone: "error" }, { kind: "text", text: "quiet", lines: 1, tone: "muted" }] }, { stale: true });
    const [red, quiet] = stale.container.querySelectorAll("p");
    expect(red?.className).toContain(TONE_TEXT_CLASS.unknown);
    expect(red?.className).not.toContain(TONE_TEXT_CLASS.error);
    expect(quiet?.className).toContain(TONE_TEXT_CLASS.muted);
  });

  it("fall back to no tone for a word this Collie does not know", () => {
    const { container } = draw(JSON.parse('{"kind":"text","text":"x","lines":1,"tone":"amber"}'));
    expect(container.querySelector("p")?.className).not.toMatch(/text-status/);
  });
});

describe("faces", () => {
  it("draw a label in the UI face, the trick's words in the content face, and mono in mono", () => {
    const { container } = draw(viewOf(LEGS_DOCUMENT));
    expect(container.querySelector('[data-trick-node="kv"] dt')?.className).not.toMatch(/font-(content|mono)/);
    expect(container.querySelector('[data-trick-node="kv"] dd')?.className).toContain("font-content");
    const texts = [...container.querySelectorAll('[data-trick-node="text"] p')];
    expect(texts.some((p) => p.className.includes("font-mono"))).toBe(true);
  });
});

describe("a button", () => {
  const busy = (control: string): TapState => ({ phase: "busy", requestId: "r", control, intent: "rerun" });

  it("taps with its part, intent, args and its own path", () => {
    const onTap = vi.fn();
    const { getByRole } = draw(fixture("button"), { onTap });
    fireEvent.click(getByRole("button"));
    expect(onTap).toHaveBeenCalledWith(KEY, "rerun", { only: "red" }, "v");
  });

  it("draws Collie's busy state on the pressed control, and the width does not move", () => {
    const rest = draw(fixture("button"));
    const restCells = rest.container.querySelectorAll("button [data-active], button [aria-hidden]").length;
    rest.unmount();
    const { getByRole, container } = draw(fixture("button"), { tap: busy("v") });
    const button = getByRole("button");
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button).toBeDisabled();
    expect(button.querySelector(".animate-spin")).not.toBeNull();
    // The label stays in its cell; only the glyph turned into the spinner.
    expect(button.textContent).toContain("Rerun red");
    expect(container.querySelectorAll("button [data-active], button [aria-hidden]").length).toBe(restCells);
  });

  it("keeps its label while busy and puts the spinner beside it when it has no glyph (slice 03 look fix)", () => {
    const { getByRole } = draw({ kind: "button", label: "Go", intent: "go" }, { tap: busy("v") });
    const button = getByRole("button");
    // The shown cell is the spinner beside the label, not a lone spinner.
    const active = button.querySelector("[data-active]");
    expect(active?.textContent).toBe("Go");
    expect(active?.querySelector('[data-slot="trick-button-busy"]')).not.toBeNull();
  });

  it("keeps the busy cell in the button at rest too, so a tap moves nothing", () => {
    const rest = draw({ kind: "button", label: "Go", intent: "go" });
    const cells = (el: HTMLElement) => el.querySelectorAll("[data-active], [inert]").length;
    const before = cells(rest.getByRole("button"));
    expect(rest.getByRole("button").querySelector('[data-slot="trick-button-busy"]')).not.toBeNull();
    rest.unmount();
    const { getByRole } = draw({ kind: "button", label: "Go", intent: "go" }, { tap: busy("v") });
    expect(cells(getByRole("button"))).toBe(before);
  });

  it("ignores a second tap while a tap on its part is in flight", () => {
    const onTap = vi.fn();
    const { container } = draw(viewOf(LEGS_DOCUMENT), { onTap, tap: busy("v/6") });
    const row = container.querySelector<HTMLButtonElement>('button[data-slot="trick-list-row"]');
    expect(row).toBeDisabled();
    fireEvent.click(row!);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("shows 'unknown' after an unknown outcome, in the label's own cell", () => {
    const { getByRole } = draw(fixture("button"), { tap: { phase: "unknown", requestId: "r", control: "v", intent: "rerun" } });
    const button = getByRole("button");
    expect(button.querySelector("[data-active]")?.textContent).toBe("unknown");
    expect(button.getAttribute("aria-label")).toBe("Rerun red, unknown");
    expect(button).not.toBeDisabled();
  });

  it("leaves the other controls of the part at rest", () => {
    const { container } = draw(viewOf(LEGS_DOCUMENT), { tap: busy("v/6") });
    const row = container.querySelector('button[data-slot="trick-list-row"]');
    expect(row?.getAttribute("aria-busy")).toBe("false");
    expect(row?.querySelector('[data-active] .animate-spin')).toBeNull();
  });
});

describe("a time", () => {
  const at = (ms: number) => new Date(NOW + ms).toISOString();
  const words = (node: ViewNode) => {
    const { container, unmount } = draw(node);
    const text = container.querySelector("time")?.textContent;
    unmount();
    return text;
  };

  it("says how long ago, in the compact units", () => {
    expect(words({ kind: "time", at: at(-20_000) })).toBe("just now");
    expect(words({ kind: "time", at: at(-3 * 60_000 - 5_000) })).toBe("3 min ago");
    expect(words({ kind: "time", at: at(-2 * 3_600_000) })).toBe("2 h ago");
  });

  it("says how long until, and counts seconds in its last minute", () => {
    expect(words({ kind: "time", at: at(2 * 3_600_000 + 60_000), style: "until" })).toBe("in 2 h");
    expect(words({ kind: "time", at: at(40_000), style: "until" })).toBe("in 40 s");
    expect(words({ kind: "time", at: at(-5 * 60_000), style: "until" })).toBe("5 min ago");
  });

  it("writes a date and a clock time past a day", () => {
    const text = words({ kind: "time", at: "2026-11-05T09:38:00Z" });
    expect(text).toMatch(/Nov/);
    expect(text).not.toMatch(/ago/);
  });

  it("writes the clock and the date styles", () => {
    expect(words({ kind: "time", at: at(0), style: "clock" })).toMatch(/\d{2}:\d{2}/);
    expect(words({ kind: "time", at: "2026-11-08T12:00:00Z", style: "date" })).toMatch(/Nov/);
  });
});
