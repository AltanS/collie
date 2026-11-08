import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";

import { asJsonObject, type JsonObject, type JsonValue } from "../json";
import { THEME_TOKENS } from "../theme/schema";

import {
  FACTS,
  LEGS_DOCUMENT,
  MANIFESTS,
  NODE_FIXTURES,
  PLACE_DOCUMENTS,
  REFUSED,
  REPLY_DOCUMENTS,
  TRACKER_DOCUMENT,
  documentOfBytes,
  nodeDocument,
  sessionPartOfBytes,
} from "./fixtures";
import {
  ACTION_ICONS,
  CORE_NODE_KINDS,
  DOCUMENT_MAX_BYTES,
  LATER_PLACES,
  MOD_ICONS,
  MOD_ICON_LUCIDE,
  NEAR_PLACES,
  NODE_KEYS,
  NODE_KINDS,
  PART_MAX_BYTES,
  PLACE_KINDS,
  REFUSALS_MAX,
  TONES,
  TONE_TEXT_CLASS,
  TONE_TOKENS,
  freshWindowMs,
  globMatches,
  isModSessionId,
  isModUrl,
  isScopeKey,
  matchesSession,
  matchesTab,
  modSessionId,
  parseAt,
  parseDuration,
  parseFacts,
  parseManifest,
  parseModDocument,
  parseModDocumentText,
  parsePartKey,
  parseSessionMatch,
  parseTabMatch,
  parseTapRequest,
  partKey,
  pointer,
  toneToken,
  type NodeKind,
  type ParseModDocumentOptions,
  type ParsedModDocument,
  type PlaceKind,
  type ViewNode,
} from "./schema";

const ROOT = resolve(import.meta.dirname, "../../../..");
const readRepo = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const text = { kind: "text", text: "ok", lines: 1 };

function session(extra: JsonObject, view: JsonValue = text): JsonObject {
  return { v: 1, parts: [{ at: "session", id: "s", view, ...extra }] };
}

function inView(view: JsonValue): JsonObject {
  return session({}, view);
}

function paths(result: ParsedModDocument): string[] {
  return result.refusals.map((r) => r.path);
}

function parse(doc: JsonValue, opts: ParseModDocumentOptions = {}): string[] {
  return paths(parseModDocument(doc, opts));
}

function kindsIn(node: ViewNode, out: Set<NodeKind>): Set<NodeKind> {
  out.add(node.kind);
  if ("children" in node) for (const child of node.children) kindsIn(child, out);
  return out;
}

describe("the module", () => {
  it("imports only the JSON helpers, so the bridge and the CLI load it without a DOM", () => {
    const source = readRepo("web/src/lib/mods/schema.ts");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../json"]);
    expect(source).not.toContain(`from "@/`);
  });

  it("lists every node kind once, with its keys", () => {
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
    expect(NODE_KINDS).toHaveLength(25);
    expect(Object.keys(NODE_KEYS).toSorted()).toEqual([...NODE_KINDS].toSorted());
    for (const kind of NODE_KINDS) expect(NODE_KEYS[kind]).toContain("kind");
  });
});

describe("valid fixtures", () => {
  it.each(NEAR_PLACES)("the %s document parses clean with the default places", (place) => {
    const result = parseModDocument(PLACE_DOCUMENTS[place]);
    expect(result.refusals).toEqual([]);
    expect(result.parts.map((p) => p.place)).toEqual([place]);
  });

  it.each(LATER_PLACES)("the %s document parses clean only when the place is enabled", (place) => {
    const enabled = parseModDocument(PLACE_DOCUMENTS[place], { places: PLACE_KINDS });
    expect(enabled.refusals).toEqual([]);
    expect(enabled.parts.map((p) => p.place)).toEqual([place]);
    const by = parseModDocument(PLACE_DOCUMENTS[place]);
    expect(by.refusals.map((r) => [r.code, r.path])).toEqual([["later", "/parts/0/at"]]);
    expect(by.refusals[0]?.reason).toContain("not in this Collie");
  });

  it("has a document for every place and a fixture for every node kind", () => {
    expect(Object.keys(PLACE_DOCUMENTS).toSorted()).toEqual([...PLACE_KINDS].toSorted());
    expect(Object.keys(NODE_FIXTURES).toSorted()).toEqual([...NODE_KINDS].toSorted());
  });

  it.each(NODE_KINDS)("the %s node parses clean", (kind) => {
    const result = parseModDocument(nodeDocument(kind));
    expect(result.refusals).toEqual([]);
    const part = result.parts[0];
    expect(part?.place).toBe("session");
    if (part?.place !== "session") return;
    expect(kindsIn(part.part.view, new Set())).toContain(kind);
  });

  it("the legs and tracker mods parse clean, on the core kinds alone", () => {
    for (const doc of [LEGS_DOCUMENT, TRACKER_DOCUMENT]) {
      expect(parseModDocument(doc).refusals).toEqual([]);
      expect(parseModDocument(doc, { kinds: CORE_NODE_KINDS, declared: ["belt", "session"] }).refusals).toEqual([]);
    }
  });

  it("the legs mod carries the belt mark, the steps, the red case and Rerun red", () => {
    const result = parseModDocument(LEGS_DOCUMENT);
    const [belt, legs] = result.parts;
    expect(belt?.place === "belt" && belt.part.mark.face).toBe("23/34");
    expect(legs?.place).toBe("session");
    if (legs?.place !== "session") return;
    expect(legs.part.actions?.map((a) => a.label)).toContain("Rerun red");
    expect([...kindsIn(legs.part.view, new Set())]).toEqual(expect.arrayContaining(["steps", "list", "button", "number"]));
    expect(result.freshMs).toBe(90_000);
    expect(result.asOf).toBe("2026-11-08T09:41:00Z");
  });

  it("the replies parse clean after a tap, and carry their draft or open", () => {
    for (const [name, doc] of Object.entries(REPLY_DOCUMENTS)) {
      const result = parseModDocument(doc, { afterTap: true });
      expect(result.refusals, name).toEqual([]);
      expect(result.draft !== undefined || result.open !== undefined, name).toBe(true);
    }
    expect(parseModDocument(REPLY_DOCUMENTS["tracker-draft"], { afterTap: true }).draft?.session).toBe("bluefin:w6X:3");
    expect(parseModDocument(REPLY_DOCUMENTS["legs-open-case"], { afterTap: true }).open).toEqual({ session: "mod:bluefin:legs" });
  });

  it("keeps the part as written, so the wire round-trips", () => {
    const result = parseModDocument(LEGS_DOCUMENT);
    const doc = LEGS_DOCUMENT;
    expect(result.parts.map((p) => p.part)).toEqual(doc.parts);
  });
});

describe("refused fixtures", () => {
  it.each(Object.entries(REFUSED))("%s gives exactly its paths and keeps the rest", (_name, fx) => {
    const result = parseModDocument(fx.doc, { afterTap: fx.afterTap === true });
    expect(paths(result)).toEqual(fx.paths);
    expect(result.parts.map((p) => p.part.id)).toEqual(fx.keeps);
    expect(result.documentRefused).toBe(fx.whole === true);
    for (const r of result.refusals) expect(r.reason.length).toBeGreaterThan(10);
  });

  it("names the refused part, so the runner keeps its last good version", () => {
    const result = parseModDocument(REFUSED["long-subtitle"]?.doc ?? null);
    expect(result.refusedParts).toEqual(["s"]);
    expect(result.refusals[0]?.part).toBe("s");
    expect(result.refusals[0]?.code).toBe("text");
  });

  it("gives a status key and a status tone their own reason", () => {
    const mark = parseModDocument(REFUSED["tab-mark-status"]?.doc ?? null).refusals[0];
    expect(mark?.code).toBe("status");
    expect(mark?.reason).toContain("status mark");
    const tone = parseModDocument(REFUSED["status-tone"]?.doc ?? null).refusals[0];
    expect(tone?.code).toBe("status");
    const node = parseModDocument(inView({ kind: "mark", icon: "flask", dot: true })).refusals[0];
    expect([node?.code, node?.path]).toEqual(["status", "/parts/0/view/dot"]);
  });

  it("caps the list of refusals and counts the rest", () => {
    const items = Array.from({ length: 120 }, () => ({ text: "" }));
    const result = parseModDocument(inView({ kind: "list", rows: 5, items }));
    expect(result.refusals).toHaveLength(REFUSALS_MAX + 1);
    expect(result.refusals.at(-1)).toEqual({ code: "more", path: "", reason: "And 80 more." });
  });
});

describe("caps at the boundary", () => {
  it("subtitle: 120 characters pass, 121 do not, counted as a person counts them", () => {
    expect(parse(session({ subtitle: "x".repeat(120) }))).toEqual([]);
    expect(parse(session({ subtitle: "🐕".repeat(120) }))).toEqual([]);
    expect(parse(session({ subtitle: "x".repeat(121) }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "  " }))).toEqual(["/parts/0/subtitle"]);
  });

  it("badge: text of 12, a count of 0 to 9999, never both", () => {
    expect(parse(session({ badge: { text: "x".repeat(12) } }))).toEqual([]);
    expect(parse(session({ badge: { text: "x".repeat(13) } }))).toEqual(["/parts/0/badge/text"]);
    expect(parse(session({ badge: { count: 0 } }))).toEqual([]);
    expect(parse(session({ badge: { count: 9999 } }))).toEqual([]);
    expect(parse(session({ badge: { count: 10_000 } }))).toEqual(["/parts/0/badge/count"]);
    expect(parse(session({ badge: { count: -1 } }))).toEqual(["/parts/0/badge/count"]);
    expect(parse(session({ badge: { count: 1.5 } }))).toEqual(["/parts/0/badge/count"]);
    expect(parse(session({ badge: { count: 1, text: "x" } }))).toEqual(["/parts/0/badge"]);
    expect(parse(session({ badge: {} }))).toEqual(["/parts/0/badge"]);
  });

  it("progress: a percent from 0 to 100, or 1 to 12 steps", () => {
    expect(parse(session({ progress: { kind: "percent", value: 0 } }))).toEqual([]);
    expect(parse(session({ progress: { kind: "percent", value: 100, label: "x".repeat(60) } }))).toEqual([]);
    expect(parse(session({ progress: { kind: "percent", value: 100.5 } }))).toEqual(["/parts/0/progress/value"]);
    expect(parse(session({ progress: { kind: "percent", value: 50, label: "x".repeat(61) } }))).toEqual(["/parts/0/progress/label"]);
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `step ${i}`, state: "todo" }));
    expect(parse(session({ progress: { kind: "steps", steps: steps(12) } }))).toEqual([]);
    expect(parse(session({ progress: { kind: "steps", steps: steps(13) } }))).toEqual(["/parts/0/progress/steps"]);
    expect(parse(session({ progress: { kind: "steps", steps: [] } }))).toEqual(["/parts/0/progress/steps"]);
    expect(parse(inView({ kind: "steps", steps: steps(12) }))).toEqual([]);
    expect(parse(inView({ kind: "steps", steps: steps(13) }))).toEqual(["/parts/0/view/steps"]);
    expect(parse(inView({ kind: "progress", value: 40, steps: steps(2) }))).toEqual(["/parts/0/view"]);
  });

  it("actions: four of at most 16 characters, unique ids, an intent each", () => {
    const action = (id: string, label = "Go") => ({ id, label, intent: "go" });
    expect(parse(session({ actions: ["a", "b", "c", "d"].map((id) => action(id)) }))).toEqual([]);
    expect(parse(session({ actions: [action("a", "x".repeat(16))] }))).toEqual([]);
    expect(parse(session({ actions: [action("a", "x".repeat(17))] }))).toEqual(["/parts/0/actions/0/label"]);
    expect(parse(session({ actions: [action("a"), action("a")] }))).toEqual(["/parts/0/actions/1/id"]);
    expect(parse(session({ actions: [{ id: "a", label: "Go" }] }))).toEqual(["/parts/0/actions/0/intent"]);
    expect(parse(session({ actions: [{ ...action("a"), icon: "flask" }] }))).toEqual(["/parts/0/actions/0/icon"]);
  });

  it("a mark's face: 12 characters", () => {
    const belt = (face: string) => ({ v: 1, parts: [{ at: "belt", id: "belt", mark: { face } }] });
    expect(parse(belt("x".repeat(12)))).toEqual([]);
    expect(parse(belt("x".repeat(13)))).toEqual(["/parts/0/mark/face"]);
  });

  it("text.lines is required, 1 to 12", () => {
    for (const lines of [1, 12]) expect(parse(inView({ kind: "text", text: "a", lines }))).toEqual([]);
    for (const lines of [0, 13, 2.5]) expect(parse(inView({ kind: "text", text: "a", lines }))).toEqual(["/parts/0/view/lines"]);
    expect(parse(inView({ kind: "text", text: "x".repeat(2001), lines: 1 }))).toEqual(["/parts/0/view/text"]);
  });

  it("list.rows and table.rows are required, 1 to 50", () => {
    for (const rows of [1, 50]) {
      expect(parse(inView({ kind: "list", rows, items: [] }))).toEqual([]);
      expect(parse(inView({ kind: "table", rows, columns: [{ label: "a" }], items: [] }))).toEqual([]);
    }
    for (const rows of [0, 51]) {
      expect(parse(inView({ kind: "list", rows, items: [] }))).toEqual(["/parts/0/view/rows"]);
      expect(parse(inView({ kind: "table", rows, columns: [{ label: "a" }], items: [] }))).toEqual(["/parts/0/view/rows"]);
    }
    expect(parse(inView({ kind: "list", items: [] }))).toEqual(["/parts/0/view/rows"]);
    expect(parse(inView({ kind: "table", rows: 2, columns: [{ label: "a" }], items: [["1", "2"]] }))).toEqual(["/parts/0/view/items/0"]);
  });

  it("log.lines 1 to 40, grid.cols 2 to 4, kv.cols 1 or 2, spark 2 to 24 values", () => {
    for (const lines of [1, 40]) expect(parse(inView({ kind: "log", lines, tail: [] }))).toEqual([]);
    expect(parse(inView({ kind: "log", lines: 41, tail: [] }))).toEqual(["/parts/0/view/lines"]);
    for (const cols of [2, 4]) expect(parse(inView({ kind: "grid", cols, children: [text] }))).toEqual([]);
    for (const cols of [1, 5]) expect(parse(inView({ kind: "grid", cols, children: [text] }))).toEqual(["/parts/0/view/cols"]);
    expect(parse(inView({ kind: "kv", cols: 3, rows: [{ label: "a", value: "b" }] }))).toEqual(["/parts/0/view/cols"]);
    const values = (n: number) => Array.from({ length: n }, (_, i) => i);
    expect(parse(inView({ kind: "spark", values: values(24) }))).toEqual([]);
    expect(parse(inView({ kind: "spark", values: values(25) }))).toEqual(["/parts/0/view/values"]);
    expect(parse(inView({ kind: "spark", values: values(1) }))).toEqual(["/parts/0/view/values"]);
  });

  it("image: a ratio from the closed list, a file under the mod folder", () => {
    const image = (src: string, ratio = "4:3") => inView({ kind: "image", src, ratio, alt: "a figure" });
    for (const src of ["a.png", "shots/b.jpeg", "c.JPG"]) expect(parse(image(src))).toEqual([]);
    for (const src of ["/etc/x.png", "../x.png", "a/../x.png", "./x.png", "x.svg", "x.png?y", "a//b.png"]) {
      expect(parse(image(src)), src).toEqual(["/parts/0/view/src"]);
    }
    expect(parse(image("a.png", "21:9"))).toEqual(["/parts/0/view/ratio"]);
  });

  it("a part is at most 16 KiB on the wire", () => {
    expect(JSON.stringify(sessionPartOfBytes(PART_MAX_BYTES)).length).toBe(PART_MAX_BYTES);
    expect(parse({ v: 1, parts: [sessionPartOfBytes(PART_MAX_BYTES)] })).toEqual([]);
    expect(parse({ v: 1, parts: [sessionPartOfBytes(PART_MAX_BYTES + 1)] })).toEqual(["/parts/0"]);
  });

  it("a document is at most 64 KiB, as an object and as stdout text", () => {
    const fits = documentOfBytes(DOCUMENT_MAX_BYTES);
    expect(parseModDocument(fits).refusals).toEqual([]);
    expect(parseModDocumentText(JSON.stringify(fits)).refusals).toEqual([]);
    const over = documentOfBytes(DOCUMENT_MAX_BYTES + 1);
    for (const result of [parseModDocument(over), parseModDocumentText(JSON.stringify(over))]) {
      expect(result.documentRefused).toBe(true);
      expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["size", ""]]);
    }
  });

  it("args: an object of at most 1024 bytes", () => {
    const button = (args: JsonValue) => inView({ kind: "button", label: "Go", intent: "go", args });
    const pad = (n: number) => ({ p: "x".repeat(n - 8) });
    expect(JSON.stringify(pad(1024)).length).toBe(1024);
    expect(parse(button(pad(1024)))).toEqual([]);
    expect(parse(button(pad(1025)))).toEqual(["/parts/0/view/args"]);
    expect(parse(button([1, 2]))).toEqual(["/parts/0/view/args"]);
  });

  it("24 parts, 6 levels, 300 nodes", () => {
    const belt = { at: "belt", id: "belt", mark: { face: "ok" } };
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...belt, at: `tab:t${i}`, id: `p${i}` }));
    expect(parse({ v: 1, parts: many(24) })).toEqual([]);
    expect(parseModDocument({ v: 1, parts: many(25) }).documentRefused).toBe(true);
    const nest = (depth: number): JsonObject => (depth === 1 ? text : { kind: "stack", children: [nest(depth - 1)] });
    expect(parse(inView(nest(6)))).toEqual([]);
    expect(parse(inView(nest(7)))).toEqual(["/parts/0/view/children/0/children/0/children/0/children/0/children/0/children/0"]);
    const wide = (n: number) => ({ kind: "stack", children: Array.from({ length: n }, () => ({ kind: "stack", children: Array.from({ length: 23 }, () => text) })) });
    // 1 + 12 × 24 = 289 nodes pass; 1 + 13 × 24 = 313 do not.
    expect(parse(inView(wide(12)))).toEqual([]);
    expect(parse(inView(wide(13)))).toEqual(["/parts/0/view"]);
  });

  it("a draft: a real scope key, at most 4000 characters, line breaks allowed", () => {
    const draft = (d: JsonValue) => parse({ v: 1, parts: [], draft: d }, { afterTap: true });
    expect(draft({ session: "bluefin:w6X:3", text: "line one\nline two" })).toEqual([]);
    expect(draft({ session: "bluefin:w6X:3", text: "x".repeat(4000) })).toEqual([]);
    expect(draft({ session: "bluefin:w6X:3", text: "x".repeat(4001) })).toEqual(["/draft/text"]);
    expect(draft({ session: "bluefin:w6X:3", text: "x", send: true })).toEqual(["/draft/send"]);
  });

  it("refuses control and invisible characters, and keeps the emoji joiner", () => {
    expect(parse(session({ subtitle: "tab\there" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "a⁦b" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "tag\u{E0041}" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "👩‍💻 on it" }))).toEqual([]);
    expect(parse(inView({ kind: "log", lines: 2, tail: ["make\tok"] }))).toEqual([]);
    expect(parse(inView({ kind: "log", lines: 2, tail: ["one\ntwo"] }))).toEqual(["/parts/0/view/tail/0"]);
    expect(parse(inView({ kind: "text", text: "a\tb\nc", lines: 2 }))).toEqual([]);
  });
});

describe("durations", () => {
  it("reads one number and one unit", () => {
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("5m")).toBe(300_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    for (const bad of ["", "5", "1h30m", "1.5m", "0s", "-5s", "05s", " 5s", "5S", "5d"]) expect(parseDuration(bad), bad).toBeUndefined();
  });

  it("fresh runs from 5s to 24h", () => {
    for (const fresh of ["5s", "24h", "90s"]) expect(parse({ v: 1, parts: [], fresh })).toEqual([]);
    for (const fresh of ["4s", "25h", "1441m", 90]) expect(parse({ v: 1, parts: [], fresh })).toEqual(["/fresh"]);
  });

  it("every part has a window, with or without fresh", () => {
    expect(freshWindowMs(90_000, 5_000)).toBe(90_000);
    expect(freshWindowMs(undefined, 30_000)).toBe(90_000);
    expect(freshWindowMs(undefined, 5_000)).toBe(60_000);
    expect(freshWindowMs(undefined, undefined)).toBe(600_000);
  });
});

describe("matches", () => {
  it("reads the session match grammar", () => {
    const terms = (t: string) => {
      const read = parseSessionMatch(t);
      return "match" in read ? read.match.terms : undefined;
    };
    expect(terms("*")).toEqual([{ term: "any" }]);
    expect(terms("composer*")).toEqual([{ term: "name", glob: "composer*" }]);
    expect(terms("agent:claude cwd:~/projects/*")).toEqual([
      { term: "agent", agent: "claude" },
      { term: "cwd", glob: "~/projects/*" },
    ]);
    expect(terms("space:collie kind:mod")).toEqual([{ term: "space", glob: "collie" }, { term: "mod" }]);
    for (const bad of ["", " *", "* ", "a  b", "agent:", "agent:Claude", "cwd:", "host:bluefin", "kind:agent"]) {
      expect(terms(bad), bad).toBeUndefined();
    }
  });

  it("reads the tab match grammar", () => {
    const read = parseTabMatch("fix* space:collie");
    expect("match" in read && read.match.terms).toEqual([
      { term: "title", glob: "fix*" },
      { term: "space", glob: "collie" },
    ]);
    for (const bad of ["", "agent:claude", "space:", "a  b"]) expect("reason" in parseTabMatch(bad), bad).toBe(true);
  });

  it("reads every place from at", () => {
    const place = (at: string) => {
      const read = parseAt(at);
      return "place" in read ? read.place : undefined;
    };
    const expected: [string, PlaceKind][] = [
      ["belt", "belt"],
      ["session", "session"],
      ["tab", "tab"],
      ["tab:fix", "tab-mark"],
      ["view:*", "view"],
      ["dashboard", "dashboard"],
      ["header.line", "header.line"],
      ["menu:agent:claude", "menu"],
      ["settings", "settings"],
    ];
    for (const [at, kind] of expected) expect(place(at), at).toBe(kind);
    for (const bad of ["Belt", "view:", "tab:", "header", "view", "menu", `view:${"x".repeat(160)}`]) expect(place(bad), bad).toBeUndefined();
  });

  it("globs with * and ?", () => {
    expect(globMatches("*", "")).toBe(true);
    expect(globMatches("comp*", "composer")).toBe(true);
    expect(globMatches("c?mposer", "composer")).toBe(true);
    expect(globMatches("*fix*", "a-fix-b")).toBe(true);
    expect(globMatches("comp", "composer")).toBe(false);
    expect(globMatches("*.ts", "a.tsx")).toBe(false);
    expect(globMatches("a*b*c", "aXbYbZc")).toBe(true);
  });

  it("matches sessions, and reaches a mod session only through kind:mod", () => {
    const m = (t: string) => {
      const read = parseSessionMatch(t);
      if (!("match" in read)) throw new Error(read.reason);
      return read.match;
    };
    const claude = { name: "composer", agent: "claude", cwd: "/var/home/a/projects/collie", space: "collie", mod: false };
    expect(matchesSession(m("*"), claude)).toBe(true);
    expect(matchesSession(m("agent:claude"), claude)).toBe(true);
    expect(matchesSession(m("agent:codex"), claude)).toBe(false);
    expect(matchesSession(m("cwd:~/projects/*"), claude, "/var/home/a")).toBe(true);
    expect(matchesSession(m("cwd:~/projects/*"), claude)).toBe(false);
    expect(matchesSession(m("comp* space:collie"), claude)).toBe(true);
    expect(matchesSession(m("comp* space:other"), claude)).toBe(false);
    const modSession = { name: "Browser leg", mod: true };
    expect(matchesSession(m("*"), modSession)).toBe(false);
    expect(matchesSession(m("kind:mod"), modSession)).toBe(true);
    expect(matchesSession(m("kind:mod"), claude)).toBe(false);
  });

  it("matches tabs by title and Space", () => {
    const read = parseTabMatch("fix space:collie");
    if (!("match" in read)) throw new Error(read.reason);
    expect(matchesTab(read.match, { title: "fix", space: "collie" })).toBe(true);
    expect(matchesTab(read.match, { title: "fix", space: "other" })).toBe(false);
    expect(matchesTab(read.match, { title: "fixes", space: "collie" })).toBe(false);
  });
});

describe("ids and keys", () => {
  it("tells a scope key from a name and from a mod session", () => {
    for (const key of ["bluefin:w6X:3", "minibuch:%0", "bluefin:abc"]) expect(isScopeKey(key), key).toBe(true);
    for (const key of ["composer", ":w6X", "bluefin:", "bluefin:a b", "bluefin:a/b", "mod:bluefin:legs", `bluefin:${"x".repeat(129)}`]) {
      expect(isScopeKey(key), key).toBe(false);
    }
    expect(isModSessionId(modSessionId("bluefin", "legs"))).toBe(true);
    expect(isModSessionId("mod:bluefin:Legs")).toBe(false);
    expect(isModSessionId("bluefin:w6X:3")).toBe(false);
  });

  it("opens an https or an http address and nothing else", () => {
    for (const url of ["https://github.com/sprqvntrs/collie", "http://bluefin:8080/", "http://100.64.0.8:8795/x?y=1"]) expect(isModUrl(url), url).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://bluefin/", "//bluefin:8080/", "http://a b/", "HTTP://bluefin/"]) {
      expect(isModUrl(url), url).toBe(false);
    }
    expect(parseModDocument(REPLY_DOCUMENTS["legs-open-tailnet"], { afterTap: true }).open).toEqual({ url: "http://bluefin:8080/report.html" });
  });

  it("round-trips a part key", () => {
    const key = { host: "bluefin", mod: "legs", part: "belt" };
    expect(partKey(key)).toBe("bluefin/legs/belt");
    expect(parsePartKey(partKey(key))).toEqual(key);
    for (const bad of ["bluefin/legs", "bluefin/legs/belt/x", "mod/legs/belt", "bluefin/Legs/belt"]) expect(parsePartKey(bad), bad).toBeUndefined();
  });

  it("escapes a JSON pointer step", () => {
    expect(pointer("/parts/0", "a/b~c")).toBe("/parts/0/a~1b~0c");
    expect(pointer("", 3)).toBe("/3");
  });
});

describe("options", () => {
  it("refuses a node kind this Collie does not draw yet", () => {
    const result = parseModDocument(nodeDocument("table"), { kinds: CORE_NODE_KINDS });
    expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["later", "/parts/0/view/kind"]]);
  });

  it("refuses a place the manifest does not declare", () => {
    const result = parseModDocument(LEGS_DOCUMENT, { declared: ["session"] });
    expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["undeclared", "/parts/0/at"]]);
    expect(result.parts.map((p) => p.part.id)).toEqual(["legs"]);
  });

  it("reads a view part's match out of at", () => {
    const part = parseModDocument(PLACE_DOCUMENTS.view).parts[0];
    expect(part?.place === "view" && part.match.terms.map((t) => t.term)).toEqual(["agent", "cwd"]);
  });
});

describe("parseModDocumentText", () => {
  it("refuses text that is not JSON, and a JSON value that is not an object", () => {
    expect(parseModDocumentText("hello").refusals.map((r) => r.code)).toEqual(["json"]);
    expect(parseModDocumentText("[1]").refusals.map((r) => r.code)).toEqual(["type"]);
    expect(parseModDocumentText(JSON.stringify(LEGS_DOCUMENT)).refusals).toEqual([]);
  });

  it("never throws, whatever the input", () => {
    const junk: JsonValue[] = [null, 0, "x", true, [], {}, { v: 1 }, { v: 1, parts: [null, 1, "a", [], {}] }, { v: 1, parts: [{ at: 1, id: 2 }] }];
    for (const value of junk) {
      expect(() => parseModDocument(value)).not.toThrow();
      expect(() => parseManifest(value)).not.toThrow();
      expect(() => parseFacts(value)).not.toThrow();
      expect(() => parseTapRequest(value)).not.toThrow();
    }
  });

  it("never throws on a fixture with one key swapped for junk", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };
    const swaps: JsonValue[] = [null, -1, 1e300, "", "x".repeat(300), [], {}, [null], { kind: "stack" }];
    const mutate = (value: JsonValue): JsonValue => {
      if (Array.isArray(value)) return value.map(mutate);
      const obj = asJsonObject(value);
      if (obj === undefined) return value;
      const out: JsonObject = {};
      for (const [key, inner] of Object.entries(obj)) {
        out[key] = next() % 7 === 0 ? (swaps[next() % swaps.length] ?? null) : mutate(inner ?? null);
      }
      return out;
    };
    for (let round = 0; round < 200; round += 1) {
      expect(() => parseModDocument(mutate(LEGS_DOCUMENT), { afterTap: true })).not.toThrow();
      expect(() => parseModDocument(mutate(TRACKER_DOCUMENT))).not.toThrow();
    }
  });
});

describe("parseManifest", () => {
  it("reads the two first mods with their defaults", () => {
    const legs = parseManifest(MANIFESTS.legs, { folder: "legs" });
    expect(legs.refusals).toEqual([]);
    expect(legs.manifest).toEqual({
      id: "legs",
      name: "Browser leg",
      run: "./legs.sh",
      every: "30s",
      everyMs: 30_000,
      mode: "once",
      facts: 1,
      icon: "flask",
      places: ["belt", "session"],
    });
    expect(parseManifest(MANIFESTS.tracker).manifest?.places).toEqual(["session"]);
  });

  it("skips the later fields with a reason and keeps the mod", () => {
    const result = parseManifest(MANIFESTS.later);
    expect(result.refusals.map((r) => [r.code, r.path])).toEqual([
      ["later", "/watch"],
      ["later", "/on"],
      ["later", "/mode"],
      ["later", "/places/1"],
    ]);
    expect(result.manifest?.places).toEqual(["belt"]);
    expect(result.manifest?.mode).toBe("once");
    expect(result.manifest?.watch).toBeUndefined();
    const on = parseManifest(MANIFESTS.later, { triggers: ["watch", "on", "serve"], places: PLACE_KINDS });
    expect(on.refusals).toEqual([]);
    expect(on.manifest?.mode).toBe("serve");
    expect(on.manifest?.on).toEqual(["turn.end"]);
  });

  it("refuses what it cannot run", () => {
    const base = { id: "legs", name: "Legs", run: "./legs.sh", places: ["belt"] };
    const bad = (extra: JsonObject, opts = {}) => parseManifest({ ...base, ...extra }, opts);
    expect(bad({}, { folder: "other" }).refusals.map((r) => r.path)).toEqual(["/id"]);
    expect(bad({ facts: 2 }).refusals.map((r) => r.code)).toEqual(["version"]);
    expect(bad({ facts: 2 }).manifest).toBeUndefined();
    expect(bad({ every: "4s" }).refusals.map((r) => r.path)).toEqual(["/every"]);
    expect(bad({ every: "5s" }).manifest?.everyMs).toBe(5000);
    expect(bad({ every: "24h" }).refusals).toEqual([]);
    expect(bad({ every: "25h" }).refusals.map((r) => r.path)).toEqual(["/every"]);
    expect(bad({ description: "x" }).refusals.map((r) => r.code)).toEqual(["unknown-key"]);
    expect(bad({ icon: "rocket" }).refusals.map((r) => r.path)).toEqual(["/icon"]);
    expect(bad({ places: ["belt", "belt"] }).refusals.map((r) => r.code)).toEqual(["duplicate"]);
    expect(bad({ places: ["dashboard"] }).refusals.map((r) => r.code)).toEqual(["later", "place"]);
    expect(bad({ places: ["dashboard"] }).manifest).toBeUndefined();
    expect(bad({ id: "Legs" }).refusals.map((r) => r.path)).toEqual(["/id"]);
    expect(parseManifest({ id: "legs" }).refusals.map((r) => r.path)).toEqual(["/name", "/run", "/places"]);
  });
});

describe("parseFacts", () => {
  it.each(Object.entries(FACTS))("the %s facts parse clean", (_name, facts) => {
    const result = parseFacts(facts);
    expect(result.refusals).toEqual([]);
    expect(result.facts?.v).toBe(1);
  });

  it("refuses a session id that is a name", () => {
    const facts = { ...FACTS.timer, sessions: [{ id: "composer", paneId: "w6X:3", status: "idle" }] };
    expect(parseFacts(facts).refusals.map((r) => r.path)).toEqual(["/sessions/0/id"]);
  });
});

describe("parseTapRequest", () => {
  const tap = { requestId: "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", intent: "open-case", args: { n: 24 }, part: "legs", from: { session: "bluefin:w6X:3" } };

  it("reads a tap", () => {
    expect(parseTapRequest(tap)).toEqual({ request: tap, refusals: [] });
    expect(parseTapRequest({ requestId: tap.requestId, intent: "open", part: "belt" }).request).toEqual({
      requestId: tap.requestId,
      intent: "open",
      part: "belt",
    });
  });

  it("refuses a bad request id, a name as from, an unknown key and big args", () => {
    const refused = (extra: JsonObject) => parseTapRequest({ ...tap, ...extra }).refusals.map((r) => r.path);
    expect(refused({ requestId: "1" })).toEqual(["/requestId"]);
    expect(refused({ from: { session: "composer" } })).toEqual(["/from/session"]);
    expect(refused({ turnId: "t1" })).toEqual(["/turnId"]);
    expect(refused({ args: { p: "x".repeat(1100) } })).toEqual(["/args"]);
    expect(refused({ intent: "Open Case" })).toEqual(["/intent"]);
    expect(refused({ part: "legs/belt" })).toEqual(["/part"]);
  });
});

describe("the tone map", () => {
  it("maps every tone onto a token that already exists, and spells its class", () => {
    expect(Object.keys(TONE_TOKENS).toSorted()).toEqual([...TONES].toSorted());
    for (const tone of TONES) {
      expect(THEME_TOKENS).toContain(toneToken(tone));
      expect(TONE_TEXT_CLASS[tone]).toBe(`text-${toneToken(tone)}`);
    }
  });

  it("draws warn in the caution colour of the app's Notice", () => {
    const notice = readRepo("web/src/components/ui/notice.tsx");
    expect(notice).toMatch(/caution: \{[^}]*accent: "text-status-working"/);
    expect(TONE_TEXT_CLASS.warn).toBe("text-status-working");
    expect(toneToken("error")).toBe("status-blocked");
    expect(toneToken("ok")).toBe("status-done");
  });
});

describe("the icon set", () => {
  it("is about forty words, each a lucide icon the phone already imports", () => {
    expect(MOD_ICONS.length).toBe(44);
    const imported = new Set<string>();
    // The phone's own code: every file under web/src but the playground, which is not in the app.
    const dir = resolve(ROOT, "web/src");
    for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" })) {
      if (!/\.tsx?$/.test(file) || file.startsWith("playground")) continue;
      const source = readFileSync(resolve(dir, file), "utf8");
      for (const m of source.matchAll(/import \{([^}]*)\} from "lucide-react"/g)) {
        for (const name of (m[1] ?? "").split(",")) imported.add(name.replace(/^\s*type\s+/, "").split(" as ")[0]?.trim() ?? "");
      }
    }
    const exports = new Set(Object.keys(lucide));
    for (const icon of MOD_ICONS) {
      const name = MOD_ICON_LUCIDE[icon];
      expect(exports.has(name), name).toBe(true);
      expect(imported.has(name), name).toBe(true);
    }
  });

  it("keeps Collie's spinner and status circles out", () => {
    const names: string[] = Object.values(MOD_ICON_LUCIDE);
    for (const name of ["Loader2", "CircleDot", "CheckCircle2", "XCircle", "CircleAlert"]) expect(names).not.toContain(name);
  });

  it("gives actions the twelve words of the bridge's PANE_ACTION_ICONS, all in the set", () => {
    const bridge = readRepo("bridge/types.ts").match(/export const PANE_ACTION_ICONS = \[([^\]]*)\]/)?.[1] ?? "";
    expect([...bridge.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...ACTION_ICONS]);
    for (const icon of ACTION_ICONS) expect(MOD_ICONS).toContain(icon);
  });
});
