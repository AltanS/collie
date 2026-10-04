import { describe, expect, it, beforeEach, vi } from "vitest";

// The generic-menu race guard. The api layer is mocked so the pane can be made to drift between the
// render the user tapped and the read the guard takes; the detector is the real thing, driven by
// synthetic buffers in the /model picker's verified layout.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
  textBeforeLastSend: vi.fn(),
}));

import { fetchPane, sendKeys, textBeforeLastSend } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { detectMenu } from "./harness/claude/menu";
import { settleAfterSend } from "./harness/guard";
import type { MenuModel } from "./harness/menu-model";
import { menusEqual, menusSameIdentity, submitMenuKeys } from "./menu-action";

const mockFetchPane = vi.mocked(fetchPane);
const mockSendKeys = vi.mocked(sendKeys);

const RULE = "▔".repeat(60);

/** A synthetic picker in the verified layout; `at` places the ❯ highlight. */
function pickerBuffer(at = 1): string {
  const rows = ["Default", "Opus", "Fable"].map((label, i) => {
    const n = i + 1;
    return `${at === n ? "   ❯ " : "     "}${n}. ${label}`;
  });
  return [
    "some transcript above",
    RULE,
    "   Select model",
    "",
    ...rows,
    "",
    "   ◐ Medium effort ←/→ to adjust",
    "",
    "   Enter to set as default · s to use this session only · Esc to cancel",
  ].join("\n");
}

function menuAt(at = 1) {
  return detectMenu(splitLines(parseAnsi(pickerBuffer(at))))!;
}

/** The same menu with a printed scale bolted on — the shape the /effort grammar emits. */
function withScale(menu: MenuModel, values: string[], label = values[0]!): MenuModel {
  return { ...menu, nav: { ...menu.nav, leftRight: { verb: "adjust", label, values } } };
}

const base = { paneId: "w1:p1", requestedLines: 200, detectedRevision: 0, agent: "claude" };

beforeEach(() => {
  vi.clearAllMocks();
  mockSendKeys.mockResolvedValue({ ok: true });
});

function pane(text: string) {
  mockFetchPane.mockResolvedValue({ paneId: "w1:p1", text, truncated: false, revision: 0 });
}

describe("menusEqual / menusSameIdentity", () => {
  it("a moved highlight is the SAME screen but NOT the same render", () => {
    const a = menuAt(1);
    const b = menuAt(3);
    expect(menusSameIdentity(a, b)).toBe(true);
    expect(menusEqual(a, b)).toBe(false);
  });

  // The scale is part of identity: an arrow tap moves the marker along it and never rewrites it, so
  // a different scale is a different screen (.adr/0054).
  it("a different SCALE is a different screen", () => {
    const a = withScale(menuAt(1), ["low", "medium", "high"]);
    const b = withScale(menuAt(1), ["low", "medium", "high", "max"]);
    expect(menusSameIdentity(a, b)).toBe(false);
    // A scale on one side and none on the other is a different screen too.
    expect(menusSameIdentity(a, menuAt(1))).toBe(false);
  });

  // The label is the live value the arrows change, so it stays out — otherwise the second arrow tap
  // in a row would always be refused.
  it("a different LABEL on the same scale is still the same screen", () => {
    const scale = ["low", "medium", "high"];
    const a = withScale(menuAt(1), scale, "low");
    const b = withScale(menuAt(1), scale, "high");
    expect(menusSameIdentity(a, b)).toBe(true);
  });
});

describe("submitMenuKeys", () => {
  it("sends a footer-named key when the screen is unchanged", async () => {
    pane(pickerBuffer(1));
    const menu = menuAt(1);

    const res = await submitMenuKeys({ ...base, menu, keys: ["s"] });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["s"], undefined, menu.signature);
  });

  // The whole point of the strict guard: `Enter` here writes the user's DEFAULT model. A tap on a
  // render whose highlight has since moved must not commit against the row that is there now.
  it("refuses a committing key when the highlight moved underfoot", async () => {
    pane(pickerBuffer(3));

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Enter"] });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });

  // An arrow's own effect IS moving the highlight, so a signature check would make every second
  // arrow tap fail. Identity is enough: nothing is committed.
  it("allows an arrow tap after the highlight moved (identity guard)", async () => {
    pane(pickerBuffer(3));

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Down"], nav: true });

    expect(res).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenCalledWith("w1:p1", ["Down"], undefined, expect.any(String));
  });

  it("refuses even an arrow once the picker is gone", async () => {
    pane("just ordinary output now");

    const res = await submitMenuKeys({ ...base, menu: menuAt(1), keys: ["Down"], nav: true });

    expect(res).toEqual({ status: "changed" });
    expect(mockSendKeys).not.toHaveBeenCalled();
  });
});

// The fault of 2026-10-04: tap "Move up" on the /model picker, then "Use this session only". The
// card revalidated right after the arrow, a read that can land before the TUI repaints, so it kept
// the old highlight; the committing tap compared that stale picture with a fresh read and was
// refused. The fix is the settle step between the two taps. A fake pane whose repaint lands 20 ms
// (virtual) after the key stands in for the TUI, and the sleep seam is the only clock.
describe("move up, then commit: the card must show the repaint before the next tap", () => {
  const REPAINT_MS = 20;

  function fakePane() {
    let now = 0;
    let highlight = 3;
    let repaint: { at: number; to: number } | null = null;
    const shown = () => (repaint && now >= repaint.at ? repaint.to : highlight);
    const text = () => pickerBuffer(shown());
    let seenAtSend: string | undefined;
    mockFetchPane.mockImplementation(async () => ({ paneId: "w1:p1", text: text(), truncated: false, revision: 0 }));
    mockTextBeforeLastSend.mockImplementation(() => seenAtSend);
    mockSendKeys.mockImplementation(async (_pane, keys) => {
      seenAtSend = text(); // what the client had seen when the key left
      if (keys[0] === "Up") {
        highlight = shown();
        repaint = { at: now + REPAINT_MS, to: highlight - 1 };
      }
      return { ok: true };
    });
    return {
      sleep: async (ms: number) => void (now += ms),
      /** The card's own re-derivation: a read, as `revalidate()` would do, turned into a model. */
      renderedNow: () => detectMenu(splitLines(parseAnsi(text())))!,
    };
  }

  const mockTextBeforeLastSend = vi.mocked(textBeforeLastSend);

  it("with the settle step the committing tap passes and its key is sent", async () => {
    const tui = fakePane();
    const rendered = tui.renderedNow(); // highlight on row 3

    const arrow = await submitMenuKeys({ ...base, menu: rendered, keys: ["Up"], nav: true });
    expect(arrow).toEqual({ status: "sent" });

    await settleAfterSend({ paneId: "w1:p1", requestedLines: 200, sleep: tui.sleep });
    const afterSettle = tui.renderedNow(); // the revalidated card
    expect(afterSettle).not.toEqual(rendered);
    expect(menusEqual(afterSettle, menuAt(2))).toBe(true);

    const commit = await submitMenuKeys({ ...base, menu: afterSettle, keys: ["s"] });
    expect(commit).toEqual({ status: "sent" });
    expect(mockSendKeys).toHaveBeenLastCalledWith("w1:p1", ["s"], undefined, expect.any(String));
  });

  it("WITHOUT the settle step the card is stale and the committing tap is refused (the fault)", async () => {
    const tui = fakePane();
    const rendered = tui.renderedNow();

    await submitMenuKeys({ ...base, menu: rendered, keys: ["Up"], nav: true });

    // `revalidate()` right after the key: the repaint has not landed, so the card is unchanged.
    const staleCard = tui.renderedNow();
    expect(menusEqual(staleCard, rendered)).toBe(true);

    // The operator taps a moment later; by then the TUI has repainted.
    await tui.sleep(500);
    const commit = await submitMenuKeys({ ...base, menu: staleCard, keys: ["s"] });
    expect(commit).toEqual({ status: "changed" });
    expect(mockSendKeys).toHaveBeenCalledTimes(1); // only the arrow
  });
});
