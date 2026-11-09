import { afterEach, vi } from "vitest";

import type { JsonObject, JsonValue } from "@/lib/json";
import { hillDecision, hillReceipt } from "@/test/hill-fixtures";

import { isWebLink, linkHost, readHillDecision, readHillList, readHillReceipt } from "./reader";

// The reader checks the bridge's answers field by field. A decision that does not fit is dropped,
// never half drawn; one warning per read says how many went.

/** A decision as JSON, the way the bridge sends it. */
function wire(over: Partial<Record<string, JsonValue>> = {}): JsonObject {
  // SAFETY: a HillDecision is plain JSON (strings, numbers, booleans, null, arrays, objects).
  const base = JSON.parse(JSON.stringify(hillDecision())) as JsonObject;
  for (const [key, value] of Object.entries(over)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

afterEach(() => vi.restoreAllMocks());

describe("readHillDecision", () => {
  it("reads a decision of the contract's shape", () => {
    const read = readHillDecision(wire({ title: "Merge it?" }));
    expect(read).toMatchObject({ v: 1, title: "Merge it?", state: "open", priority: "today" });
    expect(read?.options.map((o) => o.intent)).toEqual(["yes", "no"]);
  });

  it("drops a decision with an unknown state, priority or text mode", () => {
    expect(readHillDecision(wire({ state: "pondering" }))).toBeNull();
    expect(readHillDecision(wire({ priority: "urgent" }))).toBeNull();
    expect(readHillDecision(wire({ text: "maybe" }))).toBeNull();
  });

  it("drops a decision of another version, or without a title", () => {
    expect(readHillDecision(wire({ v: 2 }))).toBeNull();
    expect(readHillDecision(wire({ title: "" }))).toBeNull();
    expect(readHillDecision(wire({ title: 7 }))).toBeNull();
  });

  it("drops a decision with an option that has no intent", () => {
    expect(readHillDecision(wire({ options: [{ label: "Yes" }] }))).toBeNull();
  });

  it("drops a decision that offers no way to answer", () => {
    expect(readHillDecision(wire({ options: [], text: "none" }))).toBeNull();
  });

  it("reads the images in order, keeps a caption, and leaves out one that does not fit", () => {
    const good = { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 120, width: 390, height: 240, caption: "The card after" };
    const read = readHillDecision(
      wire({
        media: [
          good,
          { ...good, id: "im_bbbbbbbbbbbbbbbb", mime: "image/jpeg", width: null, height: null, caption: undefined },
          { ...good, id: "../../api/pair" },
          { ...good, id: "im_cccccccccccccccc", mime: "image/svg+xml" },
          { ...good, id: "im_dddddddddddddddd", kind: "video" },
          { ...good, id: "im_eeeeeeeeeeeeeeee", width: -3 },
        ],
      }),
    );
    expect(read?.media).toEqual([
      { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 120, width: 390, height: 240, caption: "The card after" },
      { id: "im_bbbbbbbbbbbbbbbb", kind: "image", mime: "image/jpeg", bytes: 120, width: null, height: null },
    ]);
  });

  it("reads no images from a bridge before them, and at most four from any", () => {
    expect(readHillDecision(wire({ media: undefined }))?.media).toEqual([]);
    expect(readHillDecision(wire({ media: "x" }))?.media).toEqual([]);
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `im_${String(i).repeat(16)}`, kind: "image", mime: "image/webp", bytes: 1, width: 1, height: 1 }));
    expect(readHillDecision(wire({ media: many }))?.media.map((m) => m.id)).toEqual(many.slice(0, 4).map((m) => m.id));
  });

  it("keeps only http and https links", () => {
    const read = readHillDecision(
      wire({
        links: [
          { label: "Docs", href: "https://colliepwa.dev/docs/crew" },
          { label: "Script", href: "javascript:alert(1)" },
          { label: "File", href: "file:///etc/passwd" },
        ],
      }),
    );
    expect(read?.links).toEqual([{ label: "Docs", href: "https://colliepwa.dev/docs/crew" }]);
  });

  it("drops a recommendation that names no option, and keeps the decision", () => {
    const read = readHillDecision(wire({ recommends: { intent: "maybe", why: "because" } }));
    expect(read).not.toBeNull();
    expect(read?.recommends).toBeNull();
  });

  it("fills an absent body, text mode and priorityAsked", () => {
    const read = readHillDecision(wire({ body: undefined, text: undefined, priorityAsked: undefined, priority: "now" }));
    expect(read).toMatchObject({ body: "", text: "optional", priorityAsked: "now" });
  });
});

describe("readHillList", () => {
  it("returns null for a body with no rev", () => {
    expect(readHillList({ open: [] })).toBeNull();
    expect(readHillList(null)).toBeNull();
  });

  it("reads an unchanged answer as the number alone", () => {
    expect(readHillList({ rev: 9, unchanged: true })).toEqual({ rev: 9, unchanged: true, open: [], closed: [] });
  });

  it("drops a decision in the wrong half, and warns once for all it dropped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = readHillList({
      rev: 3,
      open: [wire({ title: "Open one" }), wire({ state: "answered" }), wire({ state: "nonsense" })],
      closed: [wire({ state: "expired", title: "Gone by" }), wire({ state: "open" })],
    });
    expect(list?.open.map((d) => d.title)).toEqual(["Open one"]);
    expect(list?.closed.map((d) => d.title)).toEqual(["Gone by"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("hill: dropped 3 decision(s) this build cannot read");
  });

  it("does not warn when every decision fits", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    readHillList({ rev: 1, open: [wire()], closed: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("readHillReceipt", () => {
  it("reads a receipt", () => {
    // SAFETY: a HillReceipt is plain JSON.
    const json = JSON.parse(JSON.stringify(hillReceipt({ code: "gone", reason: "target session ended", state: null, delivery: null }))) as JsonObject;
    expect(readHillReceipt(json)).toMatchObject({ code: "gone", reason: "target session ended", delivery: null });
  });

  it("returns null for an unknown code or a missing rid", () => {
    expect(readHillReceipt({ rid: "r", code: "maybe", reason: null, at: 1 })).toBeNull();
    expect(readHillReceipt({ code: "ok", reason: null, at: 1 })).toBeNull();
  });
});

describe("links", () => {
  it("knows a web link and its host", () => {
    expect(isWebLink("https://ci.example.com/runs/4821")).toBe(true);
    expect(isWebLink("not a url")).toBe(false);
    expect(linkHost("https://ci.example.com/runs/4821")).toBe("ci.example.com");
    expect(linkHost("nope")).toBe("");
  });
});
