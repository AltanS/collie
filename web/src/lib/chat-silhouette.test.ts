import {
  __forgetChatSilhouetteMemory,
  CHAT_SILHOUETTE_PREFIX,
  forgetAllChatSilhouettes,
  gapBefore,
  loadingRows,
  measureBlocks,
  PANES_KEPT,
  parseStored,
  recallSilhouette,
  rememberSilhouette,
  silhouetteHeight,
  silhouetteOf,
  type MeasuredBlock,
  type Silhouette,
} from "./chat-silhouette";
import { asJsonBoolean, asJsonNumber, asJsonObject, asJsonString, parseJson } from "./json";
import { paneScopeKey } from "./scope";
import { wipeDevice } from "./wipe";

afterEach(() => {
  sessionStorage.clear();
  __forgetChatSilhouetteMemory();
});

const SECRET = "hunter2-the-secret-words";

/** A scroller with blocks whose boxes are stubbed (jsdom lays nothing out) and whose words must never be stored. */
function page(blocks: readonly { height: number; text?: string; user?: boolean }[]): HTMLElement {
  const scroller = document.createElement("div");
  scroller.setAttribute("data-slot", "session-stream");
  Object.defineProperty(scroller, "clientHeight", { value: 600 });
  for (const spec of blocks) {
    const block = document.createElement("div");
    block.setAttribute("data-block", "");
    const content = document.createElement("div");
    content.textContent = `${SECRET} ${spec.text ?? ""}`;
    block.append(content);
    block.getBoundingClientRect = () => ({ height: spec.height, width: 360, top: 0, left: 0, right: 360, bottom: spec.height, x: 0, y: 0, toJSON: () => ({}) });
    content.getBoundingClientRect = () => ({ height: spec.height, width: spec.user ? 200 : 360, top: 0, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) });
    scroller.append(block);
  }
  document.body.append(scroller);
  return scroller;
}

describe("the silhouette of a page", () => {
  it("keeps kinds, heights in steps of 4, a text's line count and last-line class, and a bubble's width class", () => {
    const blocks: MeasuredBlock[] = [
      { kind: "person", height: 49, width: 0.5 },
      { kind: "agent", height: 111, lines: 5, lastLine: 0.2 },
      { kind: "tool", height: 43 },
      { kind: "card", height: 130 },
      { kind: "other", height: 20 },
    ];
    const silhouette = silhouetteOf(blocks, { viewport: 600, older: false, count: 5 });
    expect(silhouette.rows).toEqual([
      { k: "person", h: 48, w: 2 },
      { k: "agent", h: 112, n: 5, w: 1 },
      { k: "tool", h: 44 },
      { k: "card", h: 132 },
      { k: "other", h: 20 },
    ]);
    expect(silhouette.whole).toBe(true);
  });

  it("keeps the newest rows up to about two screens and is not whole then", () => {
    const blocks: MeasuredBlock[] = Array.from({ length: 30 }, () => ({ kind: "tool", height: 100 }));
    const silhouette = silhouetteOf(blocks, { viewport: 400, older: false, count: 30 });
    expect(silhouetteHeight(silhouette.rows)).toBeGreaterThanOrEqual(800);
    expect(silhouette.rows.length).toBeLessThan(30);
    expect(silhouette.whole).toBe(false);
  });

  it("is never whole while the thread has older rows", () => {
    expect(silhouetteOf([{ kind: "tool", height: 44 }], { viewport: 600, older: true, count: 1 }).whole).toBe(false);
  });

  it("is measured from a rendered page, and what is stored holds no text, only the allowed keys and numbers", () => {
    const scroller = page([{ height: 60, user: true }, { height: 88, text: "a long reply" }]);
    const measured = measureBlocks(scroller, ["person", "agent"]);
    expect(measured).not.toBeNull();
    rememberSilhouette("host\u0000w1:p1", silhouetteOf(measured!, { viewport: 600, older: false, count: 2 }));
    const raw = sessionStorage.getItem(`${CHAT_SILHOUETTE_PREFIX}host\u0000w1:p1`);
    expect(raw).not.toBeNull();
    expect(raw).not.toContain("hunter2");
    expect(raw).not.toContain("reply");
    const stored = asJsonObject(parseJson(raw!));
    expect(Object.keys(stored ?? {}).toSorted()).toEqual(["at", "rows", "whole"]);
    expect(asJsonNumber(stored?.at)).toBeDefined();
    expect(asJsonBoolean(stored?.whole)).toBeDefined();
    const rows = Array.isArray(stored?.rows) ? stored.rows : [];
    expect(rows.length).toBeGreaterThan(0);
    for (const item of rows) {
      const row = asJsonObject(item) ?? {};
      expect(Object.keys(row).every((key) => ["k", "h", "n", "w"].includes(key))).toBe(true);
      expect(["person", "agent", "tool", "card", "other"]).toContain(asJsonString(row.k));
      for (const key of ["h", "n", "w"]) if (key in row) expect(asJsonNumber(row[key])).toBeDefined();
    }
    expect(parseStored(raw!)).not.toBeNull();
  });

  it("measures nothing when the scroller does not hold exactly the blocks it was told about", () => {
    expect(measureBlocks(page([{ height: 40 }]), ["agent", "agent"])).toBeNull();
  });

  it("is refused on the way back in when it carries anything but the allowed keys and numbers", () => {
    const good = { at: 1, whole: false, rows: [{ k: "agent", h: 44, n: 2, w: 1 }] };
    expect(parseStored(JSON.stringify(good))).not.toBeNull();
    expect(parseStored(JSON.stringify({ ...good, text: "words" }))).toBeNull();
    expect(parseStored(JSON.stringify({ ...good, rows: [{ k: "agent", h: 44, text: "words" }] }))).toBeNull();
    expect(parseStored(JSON.stringify({ ...good, rows: [{ k: "agent", h: "44" }] }))).toBeNull();
    expect(parseStored(JSON.stringify({ ...good, rows: [{ k: "path", h: 44 }] }))).toBeNull();
    expect(parseStored("not json")).toBeNull();
  });
});

describe("the memory of silhouettes", () => {
  const silhouette: Silhouette = { whole: false, rows: [{ k: "tool", h: 44 }] };

  it("is kept per host and pane, and survives a reload through sessionStorage", () => {
    const a = paneScopeKey({ host: "alpha" }, "w1:p1");
    const b = paneScopeKey({ host: "beta" }, "w1:p1");
    rememberSilhouette(a, silhouette);
    rememberSilhouette(b, { whole: true, rows: [{ k: "card", h: 80 }] });
    __forgetChatSilhouetteMemory();
    expect(recallSilhouette(a)?.rows).toEqual([{ k: "tool", h: 44 }]);
    expect(recallSilhouette(b)?.rows).toEqual([{ k: "card", h: 80 }]);
    expect(recallSilhouette(paneScopeKey({ host: "gamma" }, "w1:p1"))).toBeUndefined();
  });

  it("writes nothing for a silhouette equal to the one kept", () => {
    rememberSilhouette("p", silhouette);
    const spy = vi.spyOn(Storage.prototype, "setItem");
    rememberSilhouette("p", { ...silhouette, rows: [{ k: "tool", h: 44 }] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("keeps the last 40 panes and drops the oldest written", () => {
    for (let i = 0; i < PANES_KEPT + 5; i++) rememberSilhouette(`pane-${i}`, { whole: false, rows: [{ k: "tool", h: 44 + i * 4 }] });
    const kept = Object.keys(sessionStorage).filter((key) => key.startsWith(CHAT_SILHOUETTE_PREFIX));
    expect(kept).toHaveLength(PANES_KEPT);
    expect(recallSilhouette("pane-0")).toBeUndefined();
    expect(recallSilhouette("pane-4")).toBeUndefined();
    expect(recallSilhouette("pane-5")).toBeDefined();
    expect(recallSilhouette(`pane-${PANES_KEPT + 4}`)).toBeDefined();
    // After a reload the memory is empty and storage alone holds the same forty.
    __forgetChatSilhouetteMemory();
    expect(recallSilhouette("pane-5")).toBeDefined();
    expect(recallSilhouette("pane-0")).toBeUndefined();
  });

  it("is wiped at unpair, memory and storage", async () => {
    rememberSilhouette("p1", silhouette);
    rememberSilhouette("p2", silhouette);
    await wipeDevice("unpair");
    expect(recallSilhouette("p1")).toBeUndefined();
    expect(Object.keys(sessionStorage).filter((key) => key.startsWith(CHAT_SILHOUETTE_PREFIX))).toEqual([]);
  });

  it("drops only that pane at a password wipe", async () => {
    const scope = { host: "alpha" };
    const a = paneScopeKey(scope, "w1:p1");
    const b = paneScopeKey(scope, "w1:p2");
    rememberSilhouette(a, silhouette);
    rememberSilhouette(b, silhouette);
    await wipeDevice("password", { scope, paneId: "w1:p1" });
    expect(recallSilhouette(a)).toBeUndefined();
    expect(recallSilhouette(b)).toBeDefined();
  });

  it("forgetAll leaves other sessionStorage keys alone", () => {
    sessionStorage.setItem("collie:other", "1");
    rememberSilhouette("p", silhouette);
    forgetAllChatSilhouettes();
    expect(sessionStorage.getItem("collie:other")).toBe("1");
    expect(recallSilhouette("p")).toBeUndefined();
  });
});

describe("the rows the loading view draws", () => {
  it("fills the screen for a pane never seen, from the typical thread", () => {
    const { rows, top } = loadingRows(undefined, 700);
    expect(silhouetteHeight(rows)).toBeGreaterThanOrEqual(700);
    expect(top).toBe(false);
    expect(rows.at(-1)?.k).toBe("agent");
  });

  it("draws at least one typical thread when the screen cannot be measured", () => {
    expect(loadingRows(undefined, 0).rows.length).toBeGreaterThanOrEqual(4);
  });

  it("draws the remembered rows last, and the typical thread above them where they fall short", () => {
    const remembered: Silhouette = { whole: false, rows: [{ k: "person", h: 48, w: 3 }, { k: "agent", h: 88, n: 4, w: 2 }] };
    const { rows } = loadingRows(remembered, 800);
    expect(rows.slice(-2)).toEqual(remembered.rows);
    expect(silhouetteHeight(rows)).toBeGreaterThanOrEqual(800);
  });

  it("keeps only the newest rows that cover the screen", () => {
    const tall: Silhouette = { whole: false, rows: Array.from({ length: 20 }, () => ({ k: "tool" as const, h: 100 })) };
    const { rows } = loadingRows(tall, 400);
    expect(rows.length).toBeLessThanOrEqual(5);
    expect(silhouetteHeight(rows)).toBeGreaterThanOrEqual(400);
  });

  it("draws a whole thread that is shorter than the screen from the top, as it will arrive", () => {
    const short: Silhouette = { whole: true, rows: [{ k: "person", h: 48, w: 1 }, { k: "agent", h: 44, n: 2, w: 2 }] };
    const { rows, top } = loadingRows(short, 700);
    expect(top).toBe(true);
    expect(rows).toEqual(short.rows);
  });

  it("spaces rows as the stream does", () => {
    expect(gapBefore(undefined, "person")).toBe(0);
    expect(gapBefore("agent", "person")).toBe(20);
    expect(gapBefore("person", "agent")).toBe(12);
    expect(gapBefore("agent", "tool")).toBe(8);
  });
});
