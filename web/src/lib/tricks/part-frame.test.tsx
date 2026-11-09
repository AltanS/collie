import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { JsonObject } from "../json";
import { LEGS_DOCUMENT } from "./fixtures";
import { isPastWindow, partWindowMs, readFrame } from "./frame";
import { TrickView, PartFrame } from "./part-frame";
import { renderView, type RenderCtx } from "./render";
import { TONE_TEXT_CLASS, parseTrickDocument, partKey, type TrickPart, type TricksReply, type View, type WireTrickInfo, type WireTrickPart } from "./schema";
import { createTricksStore, type TricksStore } from "./store";

const AS_OF = "2026-11-08T09:41:00Z";
const T0 = Date.parse(AS_OF);

function sessionOf(doc: JsonObject): TrickPart {
  const part = parseTrickDocument(doc).parts.find((p) => p.place === "session");
  if (part === undefined) throw new Error("no session part");
  return part.part;
}

/** A one-line part in the ok ink: a `line` styled green, which inks through the tone map. */
const GREEN: TrickPart = { at: "session", id: "deploy", view: [{ kind: "line", text: "deploy green", attrs: { style: "fg-green" } }] };

function stored(value: TrickPart, extra: Partial<WireTrickPart> = {}): WireTrickPart {
  return { host: "bluefin", trick: "deploy", part: value.id, rev: 1, value, asOf: AS_OF, fresh: "90s", ...extra };
}

const TRICK: WireTrickInfo = { host: "bluefin", id: "deploy", name: "Deploy", icon: "machine", on: true, state: "ok", places: ["session"] };

function viewOfPart(value: TrickPart): View {
  if (!("view" in value)) throw new Error("no view");
  return value.view;
}

function frame(part: WireTrickPart, now: number, extra: { trick?: WireTrickInfo; tap?: Parameters<typeof PartFrame>[0]["tap"]; retryAt?: string } = {}) {
  const ctx = (stale: boolean): RenderCtx => ({ partKey: partKey(part), trickName: "Deploy", stale, onTap: vi.fn(), onLink: vi.fn(), now });
  return render(
    <PartFrame part={part} trick={extra.trick ?? TRICK} tap={extra.tap} retryAt={extra.retryAt} now={now}>
      {({ stale }) => renderView(viewOfPart(part.value), ctx(stale))}
    </PartFrame>,
  );
}

/** The drawn words of the part's one line, whose class carries its ink. */
function inkOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-trick-node="line"] span');
}

function lineOf(container: HTMLElement): HTMLElement {
  const line = container.querySelector<HTMLElement>('[data-slot="trick-frame-line"]');
  if (line === null) throw new Error("no frame line");
  return line;
}

describe("freshness", () => {
  it("keeps the tone inside the fresh window, and takes it away past it", () => {
    const fresh = frame(stored(GREEN), T0 + 30_000);
    expect(inkOf(fresh.container)?.className).toContain(TONE_TEXT_CLASS.ok);
    expect(lineOf(fresh.container).textContent).toBe("just now");
    fresh.unmount();
    const stale = frame(stored(GREEN), T0 + 3 * 60_000);
    expect(inkOf(stale.container)?.className).toContain(TONE_TEXT_CLASS.unknown);
    expect(inkOf(stale.container)?.className).not.toContain(TONE_TEXT_CLASS.ok);
    expect(lineOf(stale.container).textContent).toBe("Updated 3 min ago");
  });

  it("reserves the line in both states, so going stale moves nothing", () => {
    const fresh = frame(stored(GREEN), T0 + 30_000);
    const freshLine = lineOf(fresh.container);
    const freshBox = `${freshLine.className}|${fresh.container.querySelector('[data-slot="trick-part"]')?.childElementCount}`;
    fresh.unmount();
    const stale = frame(stored(GREEN), T0 + 3 * 60_000);
    const staleLine = lineOf(stale.container);
    expect(`${staleLine.className}|${stale.container.querySelector('[data-slot="trick-part"]')?.childElementCount}`).toBe(freshBox);
    expect(staleLine.className).toContain("h-6");
  });

  it("never leaves a fresh part's line blank: it carries the age in muted text (slice 03 look fix)", () => {
    const now = frame(stored(GREEN), T0 + 20_000);
    const line = lineOf(now.container);
    expect(line.textContent).toBe("just now");
    expect(line.className).toContain("text-muted-foreground");
    expect(line.className).toContain("h-6");
    now.unmount();
    // Still inside the 90 s window, two minutes would be past it: a minute-old part reads its minutes.
    const minute = frame(stored(GREEN, { fresh: "5m" }), T0 + 2 * 60_000 + 5_000);
    expect(lineOf(minute.container).textContent).toBe("2 min ago");
    // No glyph on a fresh line: the clock glyph is the stale line's, so the two still read apart.
    expect(lineOf(minute.container).querySelector("svg")).toBeNull();
    minute.unmount();
    // A part with no `asOf` (a crew member on another version) has no age to say, and the line stays reserved.
    const bare = frame(stored(GREEN, { asOf: undefined }), T0);
    expect(lineOf(bare.container).textContent).toBe("");
    expect(lineOf(bare.container).className).toContain("h-6");
  });

  it("measures the window from the part's own `fresh`, else the default", () => {
    expect(partWindowMs(stored(GREEN))).toBe(90_000);
    expect(partWindowMs(stored(GREEN, { fresh: undefined }))).toBe(10 * 60_000);
    expect(isPastWindow(stored(GREEN), T0 + 89_000)).toBe(false);
    expect(isPastWindow(stored(GREEN), T0 + 91_000)).toBe(true);
    expect(isPastWindow(stored(GREEN, { asOf: undefined }), T0 + 10 * 86_400_000)).toBe(false);
  });
});

describe("failure", () => {
  it("draws the last good part, says the run failed, and shows the masked line on a tap", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const failed = stored(GREEN, { stale: true, problem: "deploy.sh: curl: (22) 403 at https://example.invalid/?key=****" });
    const { container, getByRole } = frame(failed, T0 + 30_000);
    expect(inkOf(container)?.textContent).toBe("deploy green");
    expect(lineOf(container).textContent).toContain("Last run failed, updated just now");
    const why = getByRole("button", { name: "Why" });
    expect(why.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(why);
    expect(getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-slot="trick-frame-problem"]')?.textContent).toContain("key=****");
    // The fix button COPIES the line on the phone (design section 7): no draft, no bridge write.
    fireEvent.click(getByRole("button", { name: "Copy for an agent" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("The trick `deploy` failed: `deploy.sh: curl: (22) 403 at https://example.invalid/?key=****`"));
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("says a trick is paused, and when it retries when that is known", () => {
    const paused = { ...TRICK, state: "failing" as const, error: "exit 1" };
    const known = frame(stored(GREEN), T0, { trick: paused, retryAt: new Date(T0 + 5 * 60_000).toISOString() });
    expect(lineOf(known.container).textContent).toContain("Paused, retry in 5 min");
    known.unmount();
    const unknownTime = frame(stored(GREEN), T0, { trick: paused });
    expect(lineOf(unknownTime.container).textContent).toContain("Paused after a failure");
  });

  it("says a trick stopped after repeated failures", () => {
    const { container } = frame(stored(GREEN), T0, { trick: { ...TRICK, state: "stopped", error: "exit 1" } });
    expect(lineOf(container).textContent).toContain("Stopped after repeated failures");
  });

  it("puts a failed tap and an unknown tap in the line before anything else", () => {
    const failed = frame(stored(GREEN, { stale: true }), T0, { tap: { phase: "failed", rid: "r", control: "v", intent: "x", message: "no" } });
    expect(lineOf(failed.container).textContent).toContain("The tap failed");
    failed.unmount();
    const unknown = frame(stored(GREEN), T0, { tap: { phase: "unknown", rid: "r", control: "v", intent: "x" } });
    expect(lineOf(unknown.container).textContent).toBe("No answer. It may have run.");
  });

  it("reads one thing, the most pressing", () => {
    const part = stored(GREEN, { stale: true, problem: "p" });
    expect(readFrame(part, TRICK, undefined, T0).line.kind).toBe("failed");
    expect(readFrame(part, { ...TRICK, state: "stopped" }, undefined, T0).line.kind).toBe("stopped");
    expect(readFrame(part, TRICK, { phase: "unknown", rid: "r", control: "v", intent: "x" }, T0).line.kind).toBe("tap-unknown");
    expect(readFrame(stored(GREEN), TRICK, undefined, T0).line.kind).toBe("none");
  });
});

interface StandIn {
  store: TricksStore;
  push: (next: WireTrickPart[], rev: number) => Promise<void>;
}

function storeWith(parts: WireTrickPart[]): StandIn {
  let answer: TricksReply = { rev: 1, tricks: [TRICK], parts, present: parts.map(partKey) };
  const store = createTricksStore({ fetchTricks: () => Promise.resolve(answer), tapTrick: () => Promise.reject(new Error("no taps here")), mintRequestId: () => "r" });
  return {
    store,
    push: (next, rev) => {
      answer = { rev, tricks: [TRICK], parts: next, present: next.map(partKey) };
      return store.syncTricks(rev);
    },
  };
}

describe("TrickView", () => {
  /** A list of `rows` rows, the first saying `words`: the rows are its form, the words its data. */
  const list = (rows: number, words: string): TrickPart => ({
    at: "session",
    id: "deploy",
    view: [{ kind: "list", kids: Array.from({ length: rows }, (_, i) => ({ kind: "row" as const, text: i === 0 ? words : `row ${i}` })) }],
  });

  it("draws a held part's view in its frame", async () => {
    const legs = { ...stored(sessionOf(LEGS_DOCUMENT)), trick: "deploy" };
    const { store } = storeWith([legs]);
    await store.syncTricks(1);
    const { container } = render(<TrickView partKey={partKey(legs)} store={store} onLink={vi.fn()} now={T0} />);
    expect(container.querySelector('[data-slot="trick-part"]')).not.toBeNull();
    // The legs as a step strip, a bar of chips with state, and the figure.
    expect(container.querySelector("[data-strip]")).not.toBeNull();
    expect(container.querySelector('[data-trick-node="number"]')?.textContent).toContain("23/34");
  });

  it("draws a new version of the same form at once, and holds a new form while a finger is down", async () => {
    const { store, push } = storeWith([stored(list(2, "one"))]);
    await store.syncTricks(1);
    const { container } = render(<TrickView partKey="bluefin/deploy/deploy" store={store} onLink={vi.fn()} now={T0} />);
    const rows = () => container.querySelector('[data-trick-node="list"]')?.childElementCount;
    const root = container.querySelector('[data-slot="trick-part"]')!;
    fireEvent.pointerDown(root);
    await act(() => push([stored(list(2, "two"), { rev: 2 })], 2));
    expect(container.textContent).toContain("two");
    await act(() => push([stored(list(4, "three"), { rev: 3 })], 3));
    expect(rows()).toBe(2);
    expect(container.textContent).toContain("two");
    act(() => {
      window.dispatchEvent(new Event("pointerup"));
    });
    expect(rows()).toBe(4);
    expect(container.textContent).toContain("three");
  });

  it("draws nothing for a part it does not hold", () => {
    const { store } = storeWith([]);
    const { container } = render(<TrickView partKey="bluefin/deploy/deploy" store={store} onLink={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
