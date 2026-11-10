import { afterEach, vi } from "vitest";

import { asJsonObject, type JsonObject, type JsonValue } from "@/lib/json";
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

  it("reads a trick's routing member id beside the host it shows", () => {
    const from = { ...asJsonObject(wire({}).from), kind: "trick", host: "bluefin", memberId: "bluefin-hc", trickHost: "bluefin-hc" };
    expect(readHillDecision(wire({ from }))?.from).toMatchObject({ host: "bluefin", memberId: "bluefin-hc", trickHost: "bluefin-hc" });
    expect(readHillDecision(wire({ from: { ...from, trickHost: 5 } }))).toBeNull();
  });

  it("drops an answer or a receipt without its trick delivery, which every bridge sends", () => {
    const answered = asJsonObject(JSON.parse(JSON.stringify(hillDecision({ state: "answered", answer: { rid: "r", intent: "yes", label: "Yes", text: null, by: "phone", at: 1, delivery: "typed", trick: "none" } }))));
    expect(answered === undefined ? null : readHillDecision(answered)?.answer).toMatchObject({ trick: "none" });
    const answer = asJsonObject(answered?.answer);
    const { trick: _drop, ...bare } = answer ?? {};
    expect(answered === undefined ? undefined : readHillDecision({ ...answered, answer: bare })).toBeNull();
    const receipt = asJsonObject(JSON.parse(JSON.stringify(hillReceipt())));
    const { trick: _gone, ...old } = receipt ?? {};
    expect(readHillReceipt(old)).toBeNull();
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

  it("drops an option whose intent repeats an earlier one or is answer or dismiss, and keeps the decision", () => {
    const read = readHillDecision(
      wire({
        options: [
          { intent: "yes", label: "Yes" },
          { intent: "yes", label: "Yes, again" },
          { intent: "answer", label: "Answer" },
          { intent: "dismiss", label: "Dismiss" },
          { intent: "no", label: "No" },
        ],
      }),
    );
    expect(read?.options).toEqual([
      { intent: "yes", label: "Yes" },
      { intent: "no", label: "No" },
    ]);
  });

  it("drops a decision whose only options are reserved ones when it has no field either", () => {
    expect(readHillDecision(wire({ options: [{ intent: "dismiss", label: "Dismiss" }], text: "none" }))).toBeNull();
    expect(readHillDecision(wire({ options: [{ intent: "dismiss", label: "Dismiss" }], text: "optional" }))?.options).toEqual([]);
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

  it("leaves out an image past the bytes cap or past 8192 px on a side, and keeps the one at the cap", () => {
    const good = { id: "im_aaaaaaaaaaaaaaaa", kind: "image", mime: "image/png", bytes: 120, width: 390, height: 240 };
    const read = readHillDecision(
      wire({
        media: [
          { ...good, id: "im_bbbbbbbbbbbbbbbb", bytes: 2 * 1024 * 1024 },
          { ...good, id: "im_cccccccccccccccc", bytes: 2 * 1024 * 1024 + 1 },
          { ...good, id: "im_dddddddddddddddd", width: 8192, height: 8192 },
          { ...good, id: "im_eeeeeeeeeeeeeeee", width: 8193 },
          { ...good, id: "im_ffffffffffffffff", height: 100000 },
          { ...good, id: "im_gggggggggggggggg", bytes: -1 },
        ],
      }),
    );
    expect(read?.media.map((m) => m.id)).toEqual(["im_bbbbbbbbbbbbbbbb", "im_dddddddddddddddd"]);
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

  it("reads a display view; a view that breaks a rule is dropped and the decision stays", () => {
    const view = [{ kind: "bar", kids: [{ kind: "chip", text: "unit", attrs: { tone: "ok" } }] }];
    expect(readHillDecision(wire({ view }))?.view).toEqual(view);
    expect(readHillDecision(wire())).not.toHaveProperty("view");
    expect(readHillDecision(wire({ view: null }))).not.toHaveProperty("view");
    for (const bad of [[{ kind: "button", text: "Go", attrs: { intent: "go" } }], [{ kind: "list", kids: [{ kind: "row", text: "x", attrs: { href: "https://example.com" } }] }], "rows", [{ kind: "para", text: "x".repeat(9000) }]]) {
      const read = readHillDecision(wire({ view: bad }));
      expect(read?.title).toBe("Ship the zoom fix in 1.28.1?");
      expect(read).not.toHaveProperty("view");
    }
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
