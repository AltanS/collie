import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { JsonObject, JsonValue } from "../json";
import { LEGS_DOCUMENT, TRACKER_DOCUMENT, nodeDocument } from "./fixtures";
import { heightCss, reservedHeight, viewForm, viewHeight } from "./layout";
import { CONFIRM_MS, linkTargetOf, renderView, type RenderCtx } from "./render";
import { NODE_KINDS, TONE_TEXT_CLASS, parseTrickDocument, type View } from "./schema";
import type { TapState } from "./store";

const copyText = vi.hoisted(() => vi.fn((_text: string) => Promise.resolve()));
vi.mock("../clipboard", () => ({ copyText, canCopyText: () => true }));

const NOW = Date.parse("2026-11-08T09:41:00Z");
const KEY = "bluefin/legs/legs";

/** A document's session view, as the schema's own parser reads it: what the renderer gets from the bridge. */
function viewOf(doc: JsonValue): View {
  const parsed = parseTrickDocument(doc);
  if (parsed.refusals.length > 0) throw new Error(`refused: ${JSON.stringify(parsed.refusals)}`);
  const part = parsed.parts.find((p) => p.place === "session");
  if (part?.place !== "session") throw new Error("no session part");
  return part.part.view;
}

/** Hand-made nodes as one session view, through the parser, so every test node is one a trick may send. */
function viewOfNodes(...nodes: JsonObject[]): View {
  return viewOf({ v: 1, parts: [{ at: "session", id: "t", view: nodes }] });
}

/** A node as a crew member on a newer Collie might send it: a kind this Collie has never heard of. */
function foreign(json: string): View {
  const view: View = JSON.parse(json);
  return view;
}

function ctxOf(over: Partial<RenderCtx> = {}): RenderCtx {
  return { partKey: KEY, trickName: "Browser leg", stale: false, onTap: vi.fn(), onLink: vi.fn(), now: NOW, ...over };
}

function draw(view: View, over: Partial<RenderCtx> = {}) {
  return render(<div>{renderView(view, ctxOf(over))}</div>);
}

function nodeEl(container: HTMLElement, kind: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-trick-node="${kind}"]`);
  if (el === null) throw new Error(`no ${kind} drawn`);
  return el;
}

/** Every box that states its own size, in order: what fixes the view's height in the DOM. */
function heightEvidence(container: HTMLElement): string {
  return [...container.querySelectorAll<HTMLElement>("[data-trick-node]")]
    .map((el) => `${el.dataset.trickNode}:${el.style.height}${el.style.aspectRatio === "" ? "" : `@${el.style.aspectRatio}`}`)
    .join(",");
}

const row = (text: string, attrs?: JsonObject, kids?: JsonObject[]): JsonObject => ({ kind: "row", text, ...(attrs && { attrs }), ...(kids && { kids }) });
const list = (...kids: JsonObject[]): JsonObject => ({ kind: "list", kids });
const bar = (...kids: JsonObject[]): JsonObject => ({ kind: "bar", kids });
const button = (attrs: JsonObject): JsonObject => ({ kind: "button", attrs });
const para = (text: string, attrs?: JsonObject): JsonObject => ({ kind: "para", text, ...(attrs && { attrs }) });

beforeEach(() => copyText.mockClear());

describe("every kind draws", () => {
  it.each(NODE_KINDS)("%s, as its snapshot", (kind) => {
    const { container } = draw(viewOf(nodeDocument(kind)));
    expect(container.querySelector(`[data-trick-node="${kind}"]`)).not.toBeNull();
    expect(container.querySelector('[data-trick-node="placeholder"]')).toBeNull();
    expect(container.innerHTML).toMatchSnapshot();
  });

  it("draws the legs and the tracker views whole, with no placeholder", () => {
    for (const doc of [LEGS_DOCUMENT, TRACKER_DOCUMENT]) {
      const { container, unmount } = draw(viewOf(doc));
      expect(container.querySelectorAll('[data-trick-node="placeholder"]')).toHaveLength(0);
      expect(container.innerHTML).toMatchSnapshot();
      unmount();
    }
  });

  it("draws a view as a list: one box per node, top to bottom", () => {
    const { container } = draw(viewOfNodes(para("one"), { kind: "number", text: "2" }, { kind: "spacer" }));
    const view = container.querySelector("[data-trick-view]");
    expect(view?.childElementCount).toBe(3);
    expect([...(view?.children ?? [])].map((el) => el.querySelector("[data-trick-node]")?.getAttribute("data-trick-node"))).toEqual(["para", "number", "spacer"]);
  });
});

describe("the placeholder", () => {
  it("stands in for a kind this Collie has never heard of, at the tap floor's height", () => {
    const { container } = draw(foreign('[{"kind":"hologram","text":"x"}]'));
    const box = nodeEl(container, "placeholder");
    expect(box.dataset.kind).toBe("hologram");
    expect(box.textContent).toBe("This Collie cannot draw this part");
    expect(box.style.height).toBe("2.75rem");
    expect(reservedHeight(foreign('[{"kind":"hologram"}]')[0]!)).toEqual({ rem: 2.75, px: 0 });
  });

  it("stands in for one child and lets its siblings draw", () => {
    const { container } = draw(foreign('[{"kind":"list","kids":[{"kind":"row","text":"left"},{"kind":"hologram"}]}]'));
    expect(nodeEl(container, "row").textContent).toBe("left");
    expect(container.querySelector('[data-trick-node="placeholder"][data-kind="hologram"]')).not.toBeNull();
  });
});

// Two views of each kind that differ in data and agree in form. Each pair must draw the same boxes.
const PAIRS = {
  card: [
    { kind: "card", kids: [para("one"), { kind: "number", text: "3" }] },
    { kind: "card", attrs: { tone: "danger" }, kids: [para("two, a longer one"), { kind: "number", text: "23/34", attrs: { label: "cases" } }] },
  ],
  group: [
    { kind: "group", attrs: { label: "A" }, kids: [row("x")] },
    { kind: "group", attrs: { label: "Red cases", badge: "3" }, kids: [row("case 24", { end: "red", tone: "danger" })] },
  ],
  list: [list(row("one"), row("two")), list(row("case 24", { end: "red", icon: "flag" }), row("Harness", { end: "claude 2.1.318" }))],
  row: [list(row("left")), list(row("a different left side", { end: "red", tone: "danger", badge: "2", icon: "flag" }))],
  bar: [bar(button({ label: "Go", intent: "go" })), bar(button({ label: "Rerun every red case", intent: "rerun", icon: "refresh", tone: "accent" }))],
  chip: [bar({ kind: "chip", text: "a" }), bar({ kind: "chip", text: "a much longer chip text", attrs: { tone: "danger", icon: "flag" } })],
  button: [bar(button({ label: "Go", intent: "go" })), bar(button({ label: "Copy the path", does: "copy", value: "~/x" }))],
  para: [para("short"), para("a different one, still one line")],
  line: [{ kind: "line", text: "ok" }, { kind: "line", text: "case 24 red", attrs: { style: "fg-red bold" } }],
  run: [
    { kind: "para", kids: [{ kind: "run", text: "a" }, { kind: "run", text: " b" }] },
    { kind: "para", kids: [{ kind: "run", text: "b", attrs: { style: "bold" } }, { kind: "run", text: " c", attrs: { code: "" } }] },
  ],
  link: [
    { kind: "para", kids: [{ kind: "link", text: "a", attrs: { href: "https://example.invalid/a" } }] },
    { kind: "para", kids: [{ kind: "link", text: "the session", attrs: { href: "bluefin:w6X:3", rel: "pane" } }] },
  ],
  code: [
    { kind: "code", attrs: { max: "3" }, kids: [{ kind: "line", text: "one" }] },
    { kind: "code", attrs: { max: "3" }, kids: ["a", "b", "c", "d", "e"].map((text) => ({ kind: "line", text })) },
  ],
  image: [
    { kind: "image", attrs: { src: "a.png", alt: "a", w: "1280", h: "720" } },
    { kind: "image", attrs: { src: "shots/b.png", alt: "a much longer description", w: "1280", h: "720" } },
  ],
  meter: [
    { kind: "meter", attrs: { value: "1", max: "2" } },
    { kind: "meter", attrs: { value: "30", max: "34", label: "cases green", tone: "ok" } },
  ],
  spacer: [{ kind: "spacer" }, { kind: "spacer", attrs: { label: "Yesterday" } }],
  number: [
    { kind: "number", text: "7" },
    { kind: "number", text: "1234/5678", attrs: { label: "cases green", unit: "cases", tone: "ok" } },
  ],
} satisfies { readonly [K in (typeof NODE_KINDS)[number]]: readonly [JsonObject, JsonObject] };

describe("a node's height is its form's, not its data's", () => {
  it.each(NODE_KINDS)("%s draws one height for two inputs of one form", (kind) => {
    const [a, b] = PAIRS[kind].map((node) => viewOfNodes(node));
    expect(heightCss(viewHeight(a!))).toBe(heightCss(viewHeight(b!)));
    expect(viewForm(a!)).toBe(viewForm(b!));
    const first = draw(a!);
    const one = heightEvidence(first.container);
    first.unmount();
    expect(heightEvidence(draw(b!).container)).toBe(one);
  });

  it("states the leaf heights in rem, so they grow with the text size", () => {
    const [num, meter, spacer] = viewOfNodes({ kind: "number", text: "1" }, { kind: "meter", attrs: { value: "1" } }, { kind: "spacer" });
    expect(heightCss(reservedHeight(num!))).toBe("3rem");
    expect(heightCss(reservedHeight(meter!))).toBe("2rem");
    expect(heightCss(reservedHeight(spacer!))).toBe("1rem");
    const [chips] = viewOfNodes(bar({ kind: "chip", text: "a" }));
    expect(heightCss(reservedHeight(chips!))).toBe("1.5rem");
    const [hinted] = viewOfNodes(bar(button({ label: "Go", intent: "go", hint: "Runs it" })));
    expect(heightCss(reservedHeight(hinted!))).toBe("3.5rem");
  });

  it("reserves a para's lines from its text's length, capped", () => {
    const h = (node: JsonObject) => heightCss(reservedHeight(viewOfNodes(node)[0]!));
    expect(h(para("x".repeat(40)))).toBe("1.25rem");
    expect(h(para("x".repeat(80)))).toBe("2.5rem");
    expect(h(para("x".repeat(1000)))).toBe("10rem");
    expect(h(para("x".repeat(200), { role: "heading" }))).toBe("2.5rem");
  });

  it("reserves a code's max lines, else its lines, inside the limits", () => {
    const h = (node: JsonObject) => heightCss(reservedHeight(viewOfNodes(node)[0]!));
    expect(h({ kind: "code", attrs: { max: "4" }, kids: [{ kind: "line", text: "a" }] })).toBe("calc(5rem + 2px)");
    expect(h({ kind: "code", kids: [{ kind: "line", text: "a" }, { kind: "line", text: "b" }, { kind: "line", text: "c" }] })).toBe("calc(4rem + 2px)");
    expect(reservedHeight(foreign('[{"kind":"code","attrs":{"max":"400"},"kids":[]}]')[0]!)).toEqual({ rem: 41, px: 2 });
  });

  it("reserves a list's kids, a two-line row taller, and an empty list the frame alone", () => {
    const h = (node: JsonObject) => heightCss(reservedHeight(viewOfNodes(node)[0]!));
    expect(h(list(row("a"), row("b"), row("c")))).toBe("calc(8.25rem + 2px)");
    expect(h(list(row("a", undefined, [para("second line")])))).toBe("calc(3.5rem + 2px)");
    expect(reservedHeight(foreign('[{"kind":"list","kids":[]}]')[0]!)).toEqual({ rem: 0, px: 2 });
  });

  it("reserves a closed group's head alone, and a step strip one height whatever its steps", () => {
    const [closed] = viewOfNodes({ kind: "group", attrs: { label: "Older", fold: "closed" }, kids: [row("a"), row("b")] });
    expect(heightCss(reservedHeight(closed!))).toBe("1.5rem");
    const strip = (n: number) => viewOfNodes(bar(...Array.from({ length: n }, (_, i) => ({ kind: "chip", text: `leg ${i}`, attrs: { state: "idle" } }))))[0]!;
    expect(heightCss(reservedHeight(strip(2)))).toBe("2rem");
    expect(viewForm([strip(2)])).not.toBe(viewForm([strip(3)]));
    expect(heightCss(reservedHeight(strip(8)))).toBe("2rem");
  });

  it("calls a change of lines or rows a new form, and a change of words the same form", () => {
    expect(viewForm(viewOfNodes(para("x".repeat(40))))).not.toBe(viewForm(viewOfNodes(para("x".repeat(41)))));
    expect(viewForm(viewOfNodes(list(row("a"), row("b"))))).not.toBe(viewForm(viewOfNodes(list(row("a"), row("b"), row("c")))));
    expect(viewForm(viewOfNodes(para("23/34 green")))).toBe(viewForm(viewOfNodes(para("24/34 green"))));
    expect(viewForm(viewOfNodes({ kind: "image", attrs: { src: "a.png", alt: "a", w: "4", h: "3" } }))).not.toBe(
      viewForm(viewOfNodes({ kind: "image", attrs: { src: "a.png", alt: "a", w: "16", h: "9" } })),
    );
  });
});

describe("a button", () => {
  const busy = (control: string): TapState => ({ phase: "busy", rid: "r", control, intent: "rerun" });
  const GO = viewOfNodes(bar(button({ label: "Go", intent: "go" })));
  const RERUN = viewOfNodes(bar(button({ label: "Rerun red", intent: "rerun", value: "red", icon: "refresh" })));

  afterEach(() => vi.useRealTimers());

  it("taps with its part, intent, value and its own path", () => {
    const onTap = vi.fn();
    const { getByRole } = draw(RERUN, { onTap });
    fireEvent.click(getByRole("button"));
    expect(onTap).toHaveBeenCalledWith(KEY, "rerun", "red", "v/0/0");
  });

  it("draws Collie's busy state on the pressed control, and keeps its label", () => {
    const rest = draw(RERUN);
    const restCells = rest.container.querySelectorAll("button [data-active], button [inert]").length;
    rest.unmount();
    const { getByRole, container } = draw(RERUN, { tap: busy("v/0/0") });
    const pressed = getByRole("button");
    expect(pressed.getAttribute("aria-busy")).toBe("true");
    expect(pressed).toBeDisabled();
    expect(pressed.querySelector(".animate-spin")).not.toBeNull();
    expect(pressed.textContent).toContain("Rerun red");
    expect(container.querySelectorAll("button [data-active], button [inert]").length).toBe(restCells);
  });

  it("puts the spinner beside the label when it has no glyph, in the cell kept at rest too", () => {
    const rest = draw(GO);
    expect(rest.getByRole("button").querySelector('[data-slot="trick-button-busy"]')).not.toBeNull();
    rest.unmount();
    const { getByRole } = draw(GO, { tap: busy("v/0/0") });
    const active = getByRole("button").querySelector("[data-active]");
    expect(active?.textContent).toBe("Go");
    expect(active?.querySelector('[data-slot="trick-button-busy"]')).not.toBeNull();
  });

  it("ignores a tap on another control while a tap on its part is in flight, and leaves that control at rest", () => {
    const onTap = vi.fn();
    const { getByRole } = draw(viewOf(LEGS_DOCUMENT), { onTap, tap: busy("v/5/0") });
    const open = getByRole("button", { name: "Open" });
    expect(open).toBeDisabled();
    expect(open.getAttribute("aria-busy")).toBe("false");
    fireEvent.click(open);
    expect(onTap).not.toHaveBeenCalled();
  });

  it("shows 'unknown' after an unknown outcome, in the label's own cell", () => {
    const { getByRole } = draw(RERUN, { tap: { phase: "unknown", rid: "r", control: "v/0/0", intent: "rerun" } });
    const pressed = getByRole("button");
    expect(pressed.querySelector("[data-active]")?.textContent).toBe("unknown");
    expect(pressed.getAttribute("aria-label")).toBe("Rerun red, unknown");
    expect(pressed).not.toBeDisabled();
  });

  it("with confirm, arms on the first tap in the danger ink and sends on the second", () => {
    const onTap = vi.fn();
    const { getByRole } = draw(viewOfNodes(bar(button({ label: "Stop", intent: "stop", confirm: "Stop the run?" }))), { onTap });
    fireEvent.click(getByRole("button"));
    expect(onTap).not.toHaveBeenCalled();
    const armed = getByRole("button", { name: "Stop the run?" });
    expect(armed.dataset.armed).toBe("");
    expect(armed.className).toContain(TONE_TEXT_CLASS.danger);
    expect(armed.querySelector("[data-active]")?.textContent).toBe("Stop the run?");
    fireEvent.click(armed);
    expect(onTap).toHaveBeenCalledExactlyOnceWith(KEY, "stop", undefined, "v/0/0");
    expect(getByRole("button").dataset.armed).toBeUndefined();
  });

  it("with confirm, rests again 4 s after the first tap and sends nothing", () => {
    vi.useFakeTimers();
    const onTap = vi.fn();
    const { getByRole } = draw(viewOfNodes(bar(button({ label: "Stop", intent: "stop", confirm: "Stop the run?" }))), { onTap });
    fireEvent.click(getByRole("button"));
    act(() => vi.advanceTimersByTime(CONFIRM_MS - 1));
    expect(getByRole("button").dataset.armed).toBe("");
    act(() => vi.advanceTimersByTime(1));
    expect(getByRole("button").dataset.armed).toBeUndefined();
    expect(getByRole("button").querySelector("[data-active]")?.textContent).toBe("Stop");
    expect(onTap).not.toHaveBeenCalled();
  });

  it("with does copy, copies its value on the phone and sends nothing, even while the part is busy", () => {
    const onTap = vi.fn();
    const view = viewOfNodes(bar(button({ label: "Copy the task", does: "copy", value: "Work on M93 spec 03" })));
    const { getByRole } = draw(view, { onTap, tap: busy("v/9") });
    const copy = getByRole("button");
    expect(copy).not.toBeDisabled();
    fireEvent.click(copy);
    expect(copyText).toHaveBeenCalledWith("Work on M93 spec 03");
    expect(onTap).not.toHaveBeenCalled();
  });

  it("is disabled with its reason as the title, and draws its badge and hint", () => {
    const { getByRole, container } = draw(viewOfNodes(bar(button({ label: "Run", intent: "run", disabled: "No log yet", badge: "2", hint: "Runs the red cases" }))));
    const off = getByRole("button");
    expect(off).toBeDisabled();
    expect(off.title).toBe("No log yet");
    expect(container.querySelector('[data-slot="trick-badge"]')?.textContent).toBe("2");
    expect(off.textContent).toContain("Runs the red cases");
  });

  it("draws an empty badge as a dot", () => {
    const { container } = draw(viewOfNodes(bar(button({ label: "Run", intent: "run", badge: "" }))));
    expect(container.querySelector('[data-slot="trick-badge"]')?.hasAttribute("data-dot")).toBe(true);
  });
});

describe("a row and a link", () => {
  it("opens an http(s) href through onLink, as a real anchor", () => {
    const onLink = vi.fn();
    const { container } = draw(viewOfNodes(list(row("Report", { href: "https://example.invalid/legs/24" }))), { onLink });
    const anchor = container.querySelector<HTMLAnchorElement>('[data-trick-node="row"] a');
    expect(anchor?.getAttribute("href")).toBe("https://example.invalid/legs/24");
    expect(anchor?.target).toBe("_blank");
    expect(anchor?.rel).toBe("noopener noreferrer");
    fireEvent.click(anchor!);
    expect(onLink).toHaveBeenCalledWith({ url: "https://example.invalid/legs/24" });
  });

  it("opens a session key href through onLink, as a button", () => {
    const onLink = vi.fn();
    const { getByRole } = draw(viewOfNodes(list(row("The composer session", { href: "bluefin:w6X:3" }))), { onLink });
    fireEvent.click(getByRole("button", { name: "The composer session" }));
    expect(onLink).toHaveBeenCalledWith({ session: "bluefin:w6X:3" });
  });

  it("is two tap targets side by side with a trailing button, never one inside the other", () => {
    const onLink = vi.fn();
    const onTap = vi.fn();
    const { container, getByRole } = draw(viewOfNodes(list(row("case 24", { href: "https://example.invalid/24" }, [button({ label: "Rerun", intent: "rerun", value: "24" })]))), { onLink, onTap });
    const anchor = container.querySelector("a");
    const rerun = getByRole("button", { name: "Rerun" });
    expect(anchor?.contains(rerun)).toBe(false);
    expect(rerun.closest("a")).toBeNull();
    fireEvent.click(rerun);
    expect(onTap).toHaveBeenCalledWith(KEY, "rerun", "24", "v/0/0/0");
    expect(onLink).not.toHaveBeenCalled();
  });

  it("does not open from a disabled row", () => {
    const { container } = draw(viewOfNodes(list(row("case 24", { href: "https://example.invalid/24", disabled: "Not yet" }))));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[aria-disabled="true"]')?.getAttribute("title")).toBe("Not yet");
  });

  it("draws an href this Collie cannot read as plain words", () => {
    const { container } = draw(foreign('[{"kind":"list","kids":[{"kind":"row","text":"x","attrs":{"href":"javascript:alert(1)"}}]}]'));
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector('[data-trick-node="row"] button')).toBeNull();
    expect(linkTargetOf("javascript:alert(1)")).toBeUndefined();
    expect(linkTargetOf("trick:bluefin:legs")).toBeUndefined();
  });

  it("cuts a long title in the middle with cut mid, keeping its tail", () => {
    const { container } = draw(viewOfNodes(list(row("web/src/lib/tricks/render-the-long-file.tsx", { cut: "mid" }))));
    const tail = container.querySelector('[data-trick-node="row"] .whitespace-pre');
    expect(tail?.textContent).toBe("g-file.tsx");
  });

  it("taps an inline link to a session inside a para", () => {
    const onLink = vi.fn();
    const { getByRole } = draw(viewOf(nodeDocument("link")), { onLink });
    fireEvent.click(getByRole("button", { name: "the composer session" }));
    expect(onLink).toHaveBeenCalledWith({ session: "bluefin:w6X:3" });
  });
});

describe("a chip and the step strip", () => {
  it("draws a bar of chips with state as the strip: a track segment per step, and the steps in words", () => {
    const { container } = draw(viewOf(LEGS_DOCUMENT));
    const strip = container.querySelector<HTMLElement>("[data-strip]");
    expect(strip).not.toBeNull();
    expect(strip?.getAttribute("aria-label")).toBe("Legs");
    expect([...(strip?.querySelectorAll<HTMLElement>('[data-slot="trick-strip-track"] > [data-state]') ?? [])].map((s) => s.dataset.state)).toEqual(["working", "idle", "idle"]);
    const words = strip?.querySelector("ol.sr-only")?.textContent ?? "";
    expect(words).toContain("Solo leg, herdr: working");
    expect(words).toContain("1 of 3");
    expect(strip?.querySelector('li[aria-current="step"]')?.textContent).toContain("Solo leg, herdr");
  });

  it("draws a bar of chips with no state as plain chips, not a strip", () => {
    const { container } = draw(viewOfNodes(bar({ kind: "chip", text: "core" }, { kind: "chip", text: "herdr" })));
    expect(container.querySelector("[data-strip]")).toBeNull();
    expect(container.querySelectorAll('[data-trick-node="chip"]')).toHaveLength(2);
  });

  it("shows a chip's short words and its full text on a tap", () => {
    const { getByRole } = draw(viewOfNodes(bar({ kind: "chip", text: "Solo leg, herdr", attrs: { short: "herdr" } })));
    const chip = getByRole("button", { name: "Solo leg, herdr" });
    expect(chip.textContent).toBe("herdr");
    fireEvent.click(chip);
    expect(chip.textContent).toBe("Solo leg, herdr");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("a meter, a number, an image", () => {
  it("draws a meter's percent from value and max", () => {
    const { container, getByRole } = draw(viewOfNodes({ kind: "meter", attrs: { value: "17", max: "34", label: "cases green" } }));
    expect(nodeEl(container, "meter").textContent).toContain("50%");
    expect(getByRole("progressbar").getAttribute("aria-valuenow")).toBe("50");
  });

  it("draws a progress with no value as indeterminate: no figure, no valuenow", () => {
    const { container, getByRole } = draw(viewOfNodes({ kind: "meter", attrs: { role: "progress", label: "update" } }));
    expect(nodeEl(container, "meter").dataset.role).toBe("progress");
    expect(nodeEl(container, "meter").textContent).not.toMatch(/%/);
    expect(getByRole("progressbar").hasAttribute("aria-valuenow")).toBe(false);
  });

  it("draws a number's figure with its unit and label", () => {
    const { container } = draw(viewOfNodes({ kind: "number", text: "23/34", attrs: { unit: "cases", label: "green" } }));
    const box = nodeEl(container, "number");
    expect(box.textContent).toBe("23/34casesgreen");
    expect(box.querySelector(".text-2xl")?.textContent).toBe("23/34");
  });

  it("reserves an image's box from w and h, and says its alt with no URL", () => {
    const { container } = draw(viewOf(nodeDocument("image")));
    const box = nodeEl(container, "image");
    expect(box.style.aspectRatio).toBe("1280 / 720");
    expect(box.querySelector("img")).toBeNull();
    expect(box.textContent).toBe("The reply box with the draft still in it");
  });

  it("loads an image lazily from the place's URL", () => {
    const imageUrl = vi.fn((src: string) => `/api/tricks/image?src=${src}`);
    const { container } = draw(viewOf(nodeDocument("image")), { imageUrl });
    const img = nodeEl(container, "image").querySelector("img");
    expect(imageUrl).toHaveBeenCalledWith("shots/case-24.png");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("src")).toBe("/api/tricks/image?src=shots/case-24.png");
    expect(img?.getAttribute("width")).toBe("1280");
  });
});

describe("a clock", () => {
  const clock = (kind: string, at: number) => {
    const { container, unmount } = draw(viewOfNodes(bar({ kind: "chip", attrs: { at: String(at), clock: kind } })));
    const text = container.querySelector("time")?.textContent;
    unmount();
    return text;
  };

  it("says how long ago with ago", () => {
    expect(clock("ago", NOW - 20_000)).toBe("just now");
    expect(clock("ago", NOW - 3 * 60_000 - 5_000)).toBe("3 min ago");
  });

  it("counts up with elapsed, in m:ss and h:mm:ss", () => {
    expect(clock("elapsed", NOW - 65_000)).toBe("1:05");
    expect(clock("elapsed", NOW - 3_725_000)).toBe("1:02:05");
  });

  it("counts down with left, and holds 0:00 past zero", () => {
    expect(clock("left", NOW + 90_000)).toBe("1:30");
    expect(clock("left", NOW - 5_000)).toBe("0:00");
  });

  it("writes the time of day with time, in a run too", () => {
    expect(clock("time", NOW)).toMatch(/\d{1,2}:\d{2}/);
    const { container } = draw(viewOf(nodeDocument("run")));
    expect(container.querySelector('time[data-clock="time"]')?.textContent).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("tones and styles", () => {
  it("ink through the tone map, and only through it", () => {
    const { container } = draw(viewOfNodes({ kind: "number", text: "3", attrs: { tone: "danger" } }));
    expect(nodeEl(container, "number").querySelector(".text-2xl")?.className).toContain(TONE_TEXT_CLASS.danger);
  });

  it("go grey past the fresh window, and the inks stay", () => {
    const { container } = draw(viewOfNodes({ kind: "number", text: "3", attrs: { tone: "ok" } }, { kind: "number", text: "4", attrs: { tone: "muted" } }), { stale: true });
    const [green, quiet] = [...container.querySelectorAll('[data-trick-node="number"] .text-2xl')];
    expect(green?.className).toContain(TONE_TEXT_CLASS.unknown);
    expect(green?.className).not.toContain(TONE_TEXT_CLASS.ok);
    expect(quiet?.className).toContain(TONE_TEXT_CLASS.muted);
  });

  it("fall back to no tone for a word this Collie does not know", () => {
    const { container } = draw(foreign('[{"kind":"number","text":"3","attrs":{"tone":"amber"}}]'));
    expect(nodeEl(container, "number").innerHTML).not.toMatch(/text-status/);
  });

  it("draw a card's tone as Collie's edge, grey when stale", () => {
    const toned = viewOfNodes({ kind: "card", attrs: { tone: "danger" }, kids: [para("x")] });
    const fresh = draw(toned);
    expect(nodeEl(fresh.container, "card").className).toContain("shadow-[var(--edge-accent)_var(--status-blocked)]");
    fresh.unmount();
    const stale = draw(toned, { stale: true });
    expect(nodeEl(stale.container, "card").className).toContain("shadow-[var(--edge-accent)_var(--status-unknown)]");
  });

  it("ink a style's fg words through the tone map, syntax words through the syntax tokens, marks as type", () => {
    const { container } = draw(viewOfNodes({ kind: "line", text: "red", attrs: { style: "fg-red bold" } }, { kind: "line", text: "if", attrs: { style: "syn-keyword italic" } }, { kind: "line", text: "blue", attrs: { style: "fg-blue" } }));
    const [red, keyword, blue] = [...container.querySelectorAll('[data-trick-node="line"] > span')];
    expect(red?.className).toContain(TONE_TEXT_CLASS.danger);
    expect(red?.className).toContain("font-semibold");
    expect(keyword?.className).toContain("text-syntax-keyword");
    expect(keyword?.className).toContain("italic");
    expect(blue?.className).not.toMatch(/text-status|text-syntax/);
  });
});

describe("faces and groups", () => {
  it("draw a label in the UI face, the trick's words in the content face, and a line in mono", () => {
    const { container } = draw(viewOf(TRACKER_DOCUMENT));
    expect(container.querySelector('[data-trick-node="group"] [data-slot="section-label"], [data-trick-node="group"] h2, [data-trick-node="group"] h3')?.className ?? "").not.toMatch(/font-(content|mono)/);
    expect(container.querySelector('[data-trick-node="para"] p')?.className).toContain("font-content");
    const legs = draw(viewOf(LEGS_DOCUMENT));
    expect(nodeEl(legs.container, "line").className).toContain("font-mono");
  });

  it("folds a group that names fold, from its head", () => {
    const { getByRole } = draw(viewOfNodes({ kind: "group", attrs: { label: "Older", fold: "closed" }, kids: [row("case 19")] }));
    const head = getByRole("button", { name: /Older/ });
    expect(head.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
  });

  it("draws a group with no fold as a head that is not a control", () => {
    const { container } = draw(viewOf(TRACKER_DOCUMENT));
    expect(container.querySelector('[data-trick-node="group"] > button[aria-expanded]')).toBeNull();
  });

  it("draws a code block's lines in mono with the phone's copy button", () => {
    const { container } = draw(viewOf(nodeDocument("code")));
    const code = nodeEl(container, "code");
    expect(code.dataset.lang).toBe("sh");
    expect(code.querySelectorAll("pre > div")).toHaveLength(4);
    expect(code.querySelector("button")).not.toBeNull();
  });
});
