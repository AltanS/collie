import { describe, expect, it, beforeEach, vi } from "vitest";

// The generic-menu race guard. The api layer is mocked so the pane can be made to drift between the
// render the user tapped and the read the guard takes; the detector is the real thing, driven by
// synthetic buffers in the /model picker's verified layout.
vi.mock("./api", () => ({
  fetchPane: vi.fn(),
  sendKeys: vi.fn(),
}));

import { fetchPane, sendKeys } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import { detectMenu } from "./harness/claude/menu";
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

const base = {
  paneId: "w1:p1",
  requestedLines: 200,
  detectedRevision: 0,
  agent: "claude",
  canWrite: () => true,
};

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
