import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import * as lucide from "lucide-react";
import { describe, expect, it } from "vitest";

import { asJsonObject, type JsonObject, type JsonValue } from "../json";
import { THEME_TOKENS } from "../theme/schema";

import {
  DECISION_DOCUMENT,
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
  DECISIONS_MAX,
  DECISION_KEYS,
  DOCUMENT_KEYS,
  DOCUMENT_MAX_BYTES,
  DRAW_TONES,
  FRESH_MAX_MS,
  LATER_PLACES,
  NEAR_PLACES,
  NODE_ATTRS,
  NODE_KIDS,
  NODE_KINDS,
  NODE_TEXT,
  PART_KEYS,
  PART_MAX_BYTES,
  PLACE_KINDS,
  REFUSALS_MAX,
  REFUSAL_CODES,
  REMOVED_KINDS,
  SESSION_FACT_KEYS,
  TAP_CODES,
  TONES,
  TONE_TEXT_CLASS,
  TONE_TOKENS,
  TRICK_ICONS,
  TRICK_ICON_LUCIDE,
  VIEW_ROOT_KINDS,
  freshWindowMs,
  globMatches,
  isTapNode,
  isTrickSessionId,
  isTrickUrl,
  isScopeKey,
  matchesSession,
  matchesTab,
  trickSessionId,
  trickSpaceId,
  parseAt,
  parseDuration,
  parseFacts,
  parseManifest,
  parseTrickDocument,
  parseTrickSessionId,
  parseTrickDocumentText,
  parsePartKey,
  parseSessionMatch,
  parseTabMatch,
  parseTapRequest,
  partKey,
  pointer,
  toneToken,
  type NodeKind,
  type ParseTrickDocumentOptions,
  type ParsedTrickDocument,
  type PlaceKind,
  type ViewNode,
} from "./schema";

const ROOT = resolve(import.meta.dirname, "../../../..");
const readRepo = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

const para = { kind: "para", text: "ok" };

/**
 * The Tree UI vocabulary, draft 4: each kind's attribute names (section 2) and the 39 icon words
 * (2.15), copied here because the vocabulary lives outside this repo. A trick takes a subset of each.
 */
const TREE_ATTRS = {
  card: ["tone", "state", "live", "busy"],
  group: ["label", "fold", "badge", "hue"],
  list: ["role", "busy"],
  row: ["href", "state", "since", "badge", "tone", "anchor", "end", "cut", "disabled", "current", "holds", "icon", "hue"],
  bar: ["role", "keys", "scroll", "opens", "label"],
  chip: ["tone", "icon", "anchor", "at", "clock", "state", "current", "hue", "short", "holds"],
  button: ["intent", "label", "tone", "key", "disabled", "opens", "pressed", "pref", "confirm", "holds", "repeat", "does", "value", "badge", "icon", "hint", "span"],
  para: ["bullet", "anchor", "term", "role", "live"],
  line: ["style", "role", "anchor"],
  run: ["style", "code", "href", "anchor", "at", "clock"],
  code: ["lang", "max"],
  link: ["href", "rel", "current", "badge", "icon", "holds"],
  image: ["src", "alt", "w", "h", "href", "anchor"],
  meter: ["value", "max", "tone", "label", "role"],
  spacer: ["label"],
} as const satisfies Record<Exclude<NodeKind, "number">, readonly string[]>;
const TREE_ICONS = [
  "back", "up", "down", "next", "close", "plus", "minus", "check", "copy", "search", "settings", "star", "pin",
  "folder", "file", "image", "terminal", "chat", "machine", "crew", "branch", "edit", "delete", "move", "share",
  "link", "download", "upload", "refresh", "bell", "lock", "key", "mic", "warn", "info", "clock", "eye", "menu", "more",
] as const;

function session(extra: JsonObject, view: JsonValue = [para]): JsonObject {
  return { v: 1, parts: [{ at: "session", id: "s", view, ...extra }] };
}

function inView(...nodes: JsonValue[]): JsonObject {
  return session({}, nodes);
}

function paths(result: ParsedTrickDocument): string[] {
  return result.refusals.map((r) => r.path);
}

function parse(doc: JsonValue, opts: ParseTrickDocumentOptions = {}): string[] {
  return paths(parseTrickDocument(doc, opts));
}

function kindsIn(nodes: readonly ViewNode[], out: Set<NodeKind>): Set<NodeKind> {
  for (const node of nodes) {
    out.add(node.kind);
    if ("kids" in node && node.kids !== undefined) kindsIn(node.kids, out);
  }
  return out;
}

const button = (attrs: JsonObject) => inView({ kind: "bar", kids: [{ kind: "button", attrs }] });
const chip = (attrs: JsonObject, text?: string) => inView({ kind: "bar", kids: [text === undefined ? { kind: "chip", attrs } : { kind: "chip", text, attrs }] });
const meter = (attrs: JsonObject) => inView({ kind: "meter", attrs });
const link = (attrs: JsonObject) => inView({ kind: "para", kids: [{ kind: "link", text: "x", attrs }] });
const row = (node: JsonObject) => inView({ kind: "list", kids: [{ kind: "row", text: "x", ...node }] });

describe("the module", () => {
  it("imports only the JSON helpers, so the bridge and the CLI load it without a DOM", () => {
    const source = readRepo("web/src/lib/tricks/schema.ts");
    const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports).toEqual(["../json"]);
    expect(source).not.toContain(`from "@/`);
  });

  it("lists sixteen kinds, the tree's names plus number, each with its attributes", () => {
    expect(new Set(NODE_KINDS).size).toBe(NODE_KINDS.length);
    expect(NODE_KINDS).toHaveLength(16);
    expect(Object.keys(NODE_ATTRS).toSorted()).toEqual([...NODE_KINDS].toSorted());
    for (const kind of Object.keys(NODE_KIDS)) expect(NODE_KINDS).toContain(kind);
    for (const kind of Object.keys(NODE_TEXT)) expect(NODE_KINDS).toContain(kind);
    for (const kind of VIEW_ROOT_KINDS) expect(NODE_KINDS).toContain(kind);
  });

  it("keeps the tree's names: every kind but number is a tree kind, and every attribute is its kind's there", () => {
    for (const kind of NODE_KINDS) {
      if (kind === "number") continue;
      const tree: readonly string[] = TREE_ATTRS[kind];
      for (const name of NODE_ATTRS[kind]) expect(tree, `${kind}.${name}`).toContain(name);
    }
    for (const kind of Object.keys(REMOVED_KINDS)) expect(NODE_KINDS).not.toContain(kind);
  });

  it("never lets a row take state, nor a button take pref, key, holds, opens or repeat", () => {
    expect(NODE_ATTRS.row).not.toContain("state");
    for (const name of ["pref", "key", "holds", "opens", "repeat"]) expect(NODE_ATTRS.button).not.toContain(name);
  });

  it("has no draft and no open anywhere", () => {
    expect(DOCUMENT_KEYS).not.toContain("draft");
    expect(DOCUMENT_KEYS).not.toContain("open");
    const source = readRepo("web/src/lib/tricks/schema.ts");
    expect(source).not.toContain("DRAFT_TEXT_MAX");
    expect(source).not.toMatch(/afterTap/);
  });

  it("exports every key list the contract reference reads", () => {
    expect(Object.keys(PART_KEYS).toSorted()).toEqual([...PLACE_KINDS].toSorted());
    expect(DECISION_KEYS).toEqual(["key", "title", "summary", "body", "options", "recommends", "priority", "about", "replyTo", "media", "links", "expiresAt"]);
    expect(SESSION_FACT_KEYS).toEqual(expect.arrayContaining(["memberId", "sessionId", "paneId", "host"]));
    expect(new Set(REFUSAL_CODES).size).toBe(REFUSAL_CODES.length);
  });
});

describe("valid fixtures", () => {
  it.each(NEAR_PLACES)("the %s document parses clean with the default places", (place) => {
    const result = parseTrickDocument(PLACE_DOCUMENTS[place]);
    expect(result.refusals).toEqual([]);
    expect(result.parts.map((p) => p.place)).toEqual([place]);
  });

  it.each(LATER_PLACES)("the %s document parses clean only when the place is enabled", (place) => {
    const enabled = parseTrickDocument(PLACE_DOCUMENTS[place], { places: PLACE_KINDS });
    expect(enabled.refusals).toEqual([]);
    expect(enabled.parts.map((p) => p.place)).toEqual([place]);
    const by = parseTrickDocument(PLACE_DOCUMENTS[place]);
    expect(by.refusals.map((r) => [r.code, r.path])).toEqual([["later", "/parts/0/at"]]);
    expect(by.refusals[0]?.reason).toContain("not in this Collie");
  });

  it("has a document for every place and a fixture for every node kind", () => {
    expect(Object.keys(PLACE_DOCUMENTS).toSorted()).toEqual([...PLACE_KINDS].toSorted());
    expect(Object.keys(NODE_FIXTURES).toSorted()).toEqual([...NODE_KINDS].toSorted());
  });

  it.each(NODE_KINDS)("the %s node parses clean", (kind) => {
    const result = parseTrickDocument(nodeDocument(kind));
    expect(result.refusals).toEqual([]);
    const part = result.parts[0];
    expect(part?.place).toBe("session");
    if (part?.place !== "session") return;
    expect(kindsIn(part.part.view, new Set())).toContain(kind);
  });

  it.each(NODE_KINDS)("the %s node reads back as written, as its snapshot", (kind) => {
    const part = parseTrickDocument(nodeDocument(kind)).parts[0];
    expect(part?.place === "session" ? part.part.view : undefined).toEqual([NODE_FIXTURES[kind]]);
    expect(part?.place === "session" ? part.part.view : undefined).toMatchSnapshot();
  });

  it("the legs and tracker tricks parse clean, with their places declared", () => {
    for (const doc of [LEGS_DOCUMENT, TRACKER_DOCUMENT]) {
      expect(parseTrickDocument(doc).refusals).toEqual([]);
      expect(parseTrickDocument(doc, { declared: ["belt", "session"] }).refusals).toEqual([]);
    }
  });

  it("the legs trick carries the belt mark, the legs, the red case, Rerun red and the case 24 decision", () => {
    const result = parseTrickDocument(LEGS_DOCUMENT);
    const [belt, legs] = result.parts;
    expect(belt?.place === "belt" && belt.part.mark.label).toBe("23/34");
    expect(legs?.place).toBe("session");
    if (legs?.place !== "session") return;
    expect(legs.part.actions?.map((a) => a.label)).toContain("Rerun red");
    expect(legs.part.progress).toEqual({ value: 1, max: 3 });
    expect([...kindsIn(legs.part.view, new Set())]).toEqual(expect.arrayContaining(["number", "bar", "chip", "list", "row", "button", "line"]));
    expect(result.freshMs).toBe(90_000);
    expect(result.asOf).toBe("2026-11-08T09:41:00Z");
    expect(result.decisions.map((d) => d.key)).toEqual(["case-24"]);
  });

  it("the replies to a tap parse clean, the same as any run", () => {
    for (const [name, doc] of Object.entries(REPLY_DOCUMENTS)) expect(parseTrickDocument(doc).refusals, name).toEqual([]);
    expect(parseTrickDocument(REPLY_DOCUMENTS["legs-decision-answered"]).decisions).toEqual([]);
  });

  it("keeps the parts and the decisions as written, so the wire round-trips and the runner's content hash is stable", () => {
    const result = parseTrickDocument(LEGS_DOCUMENT);
    expect(result.parts.map((p) => p.part)).toEqual(LEGS_DOCUMENT.parts);
    expect(result.decisions).toEqual(LEGS_DOCUMENT.decisions);
    const decisions = parseTrickDocument(DECISION_DOCUMENT);
    expect(decisions.refusals).toEqual([]);
    expect(decisions.decisions).toEqual(DECISION_DOCUMENT.decisions);
  });
});

describe("refused fixtures", () => {
  it.each(Object.entries(REFUSED))("%s gives exactly its paths and keeps the rest", (_name, fx) => {
    const result = parseTrickDocument(fx.doc);
    expect(paths(result)).toEqual(fx.paths);
    expect(result.parts.map((p) => p.part.id)).toEqual(fx.keeps);
    expect(result.refusedDecisions).toEqual(fx.refusedDecisions ?? []);
    expect(result.decisions.map((d) => d.key)).toEqual(fx.keepsDecisions ?? []);
    expect(result.documentRefused).toBe(fx.whole === true);
    for (const r of result.refusals) expect(r.reason.length).toBeGreaterThan(10);
  });

  it.each(Object.entries(REMOVED_KINDS))("a %s node is refused by name, with what replaces it", (kind, replacement) => {
    const fx = REFUSED[`removed-${kind}`];
    expect(fx).toBeDefined();
    const refusal = parseTrickDocument(fx?.doc ?? null).refusals[0];
    expect(refusal?.code).toBe("removed");
    expect(refusal?.reason).toContain(`"${kind}"`);
    expect(refusal?.reason).toContain(replacement);
  });

  it("names the refused part, so the runner keeps its last good version", () => {
    const result = parseTrickDocument(REFUSED["long-subtitle"]?.doc ?? null);
    expect(result.refusedParts).toEqual(["s"]);
    expect(result.refusals[0]?.part).toBe("s");
    expect(result.refusals[0]?.code).toBe("text");
  });

  it("names the refused decision, and keeps the parts and the other decisions", () => {
    const result = parseTrickDocument(REFUSED["decision-no-summary"]?.doc ?? null);
    expect(result.refusals[0]?.decision).toBe("a");
    expect(result.refusals[0]?.part).toBeUndefined();
    expect(result.parts.map((p) => p.part.id)).toEqual(["belt"]);
  });

  it("gives a status key, a status tone and a row's state their own reason", () => {
    const mark = parseTrickDocument(REFUSED["tab-mark-status"]?.doc ?? null).refusals[0];
    expect(mark?.code).toBe("status");
    expect(mark?.reason).toContain("status mark");
    const tone = parseTrickDocument(REFUSED["status-tone"]?.doc ?? null).refusals[0];
    expect(tone?.code).toBe("status");
    const state = parseTrickDocument(REFUSED["row-state"]?.doc ?? null).refusals[0];
    expect(state?.code).toBe("status");
    expect(parseTrickDocument(session({ tone: "working" })).refusals[0]?.code).toBe("status");
  });

  it("points a first-schema word at the tree's", () => {
    const reason = (name: string) => parseTrickDocument(REFUSED[name]?.doc ?? null).refusals[0]?.reason ?? "";
    expect(reason("old-tone")).toContain('"danger"');
    expect(reason("mark-face")).toContain('"label"');
    expect(reason("attr-at-the-top")).toContain('"attrs"');
    expect(reason("view-not-a-list")).toContain("list of nodes");
    expect(reason("draft-is-gone")).toContain("replyTo");
    expect(reason("own-tab-is-gone")).toContain("tab:<tabmatch>");
    expect(reason("button-does-wipe")).toContain("copy");
    expect(reason("row-outside-a-list")).toContain("A view holds");
  });

  it("caps the list of refusals and counts the rest", () => {
    const kids = Array.from({ length: 50 }, () => ({ kind: "row", text: "" }));
    const result = parseTrickDocument(inView({ kind: "list", kids }));
    expect(result.refusals).toHaveLength(REFUSALS_MAX + 1);
    expect(result.refusals.at(-1)).toEqual({ code: "more", path: "", reason: "And 10 more." });
  });
});

describe("caps at the boundary", () => {
  it("subtitle: 120 characters pass, 121 do not, counted as a person counts them", () => {
    expect(parse(session({ subtitle: "x".repeat(120) }))).toEqual([]);
    expect(parse(session({ subtitle: "🐕".repeat(120) }))).toEqual([]);
    expect(parse(session({ subtitle: "x".repeat(121) }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "  " }))).toEqual(["/parts/0/subtitle"]);
  });

  it("a session's badge: text of 12, a count of 0 to 9999, never both", () => {
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

  it("a badge attribute: a count from 0 to 9999 as text, or empty for a dot", () => {
    for (const badge of ["", "0", "9999"]) expect(parse(row({ attrs: { badge } })), badge).toEqual([]);
    for (const badge of ["10000", "-1", "01", "1.5", "x"]) expect(parse(row({ attrs: { badge } })), badge).toEqual(["/parts/0/view/0/kids/0/attrs/badge"]);
  });

  it("a session's progress: the meter shape, value of max, max a whole 1 to 12, default 1", () => {
    for (const progress of [{}, { value: 0 }, { value: 1 }, { value: 0.68 }, { value: 12, max: 12 }, { value: 3.5, max: 7 }, { max: 3 }]) {
      expect(parse(session({ progress })), JSON.stringify(progress)).toEqual([]);
    }
    expect(parse(session({ progress: { value: 2 } }))).toEqual(["/parts/0/progress/value"]);
    expect(parse(session({ progress: { value: 4, max: 3 } }))).toEqual(["/parts/0/progress/value"]);
    expect(parse(session({ progress: { value: 1, max: 13 } }))).toEqual(["/parts/0/progress/max"]);
    expect(parse(session({ progress: { value: 1, max: 2.5 } }))).toEqual(["/parts/0/progress/max"]);
  });

  it("a meter: value within max (default 1); a progress counts to 12 and may leave value out", () => {
    for (const attrs of [{ value: "0.68" }, { value: "23", max: "34" }, { role: "progress" }, { role: "progress", value: "3.5", max: "7" }, { role: "progress", value: "12", max: "12" }]) {
      expect(parse(meter(attrs)), JSON.stringify(attrs)).toEqual([]);
    }
    expect(parse(meter({ value: "68" }))).toEqual(["/parts/0/view/0/attrs/value"]);
    expect(parse(meter({}))).toEqual(["/parts/0/view/0/attrs/value"]);
    expect(parse(meter({ role: "progress", value: "68", max: "100" }))).toEqual(["/parts/0/view/0/attrs/max"]);
    expect(parse(meter({ value: "-1" }))).toEqual(["/parts/0/view/0/attrs/value"]);
    expect(parse(meter({ value: 0.5 }))).toEqual(["/parts/0/view/0/attrs/value"]);
  });

  it("actions: four of at most 16 characters, unique ids, an intent each, a value of at most 1024 bytes", () => {
    const action = (id: string, label = "Go") => ({ id, label, intent: "go" });
    expect(parse(session({ actions: ["a", "b", "c", "d"].map((id) => action(id)) }))).toEqual([]);
    expect(parse(session({ actions: [action("a", "x".repeat(16))] }))).toEqual([]);
    expect(parse(session({ actions: [action("a", "x".repeat(17))] }))).toEqual(["/parts/0/actions/0/label"]);
    expect(parse(session({ actions: [action("a"), action("a")] }))).toEqual(["/parts/0/actions/1/id"]);
    expect(parse(session({ actions: [{ id: "a", label: "Go" }] }))).toEqual(["/parts/0/actions/0/intent"]);
    expect(parse(session({ actions: [{ ...action("a"), icon: "flask" }] }))).toEqual(["/parts/0/actions/0/icon"]);
    expect(parse(session({ actions: [{ ...action("a"), value: "x".repeat(1024) }] }))).toEqual([]);
    expect(parse(session({ actions: [{ ...action("a"), value: "x".repeat(1025) }] }))).toEqual(["/parts/0/actions/0/value"]);
  });

  it("a mark's label: 12 characters", () => {
    const belt = (label: string) => ({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label } }] });
    expect(parse(belt("x".repeat(12)))).toEqual([]);
    expect(parse(belt("x".repeat(13)))).toEqual(["/parts/0/mark/label"]);
  });

  it("a para: 2000 characters, one paragraph, no line break", () => {
    expect(parse(inView({ kind: "para", text: "x".repeat(2000) }))).toEqual([]);
    expect(parse(inView({ kind: "para", text: "x".repeat(2001) }))).toEqual(["/parts/0/view/0/text"]);
    expect(parse(inView({ kind: "para", text: "a\nb" }))).toEqual(["/parts/0/view/0/text"]);
    expect(parse(inView({ kind: "para" }))).toEqual(["/parts/0/view/0"]);
  });

  it("a line: 240 characters, a tab allowed, blank when it holds nothing", () => {
    expect(parse(inView({ kind: "line", text: "make\tok" }))).toEqual([]);
    expect(parse(inView({ kind: "line" }))).toEqual([]);
    expect(parse(inView({ kind: "line", text: "x".repeat(241) }))).toEqual(["/parts/0/view/0/text"]);
    expect(parse(inView({ kind: "line", text: "one\ntwo" }))).toEqual(["/parts/0/view/0/text"]);
  });

  it("a run keeps the spaces between words, but is never empty", () => {
    expect(parse(inView({ kind: "para", kids: [{ kind: "run", text: "a" }, { kind: "run", text: " " }, { kind: "run", text: "b" }] }))).toEqual([]);
    expect(parse(inView({ kind: "para", kids: [{ kind: "run", text: "" }] }))).toEqual(["/parts/0/view/0/kids/0/text"]);
  });

  it("a list holds 0 to 50 rows and groups, and reserves their height: no rows attribute", () => {
    const rows = (n: number) => Array.from({ length: n }, () => ({ kind: "row", text: "x" }));
    expect(parse(inView({ kind: "list" }))).toEqual([]);
    expect(parse(inView({ kind: "list", kids: rows(50) }))).toEqual([]);
    expect(parse(inView({ kind: "list", kids: rows(51) }))).toEqual(["/parts/0/view/0/kids"]);
    expect(parse(inView({ kind: "list", attrs: { rows: "5" } }))).toEqual(["/parts/0/view/0/attrs/rows"]);
    expect(parse(inView({ kind: "list", kids: [para] }))).toEqual(["/parts/0/view/0/kids/0/kind"]);
  });

  it("a bar holds 1 to 12 buttons, chips and links; a code 1 to 200 lines and shows 1 to 40", () => {
    const chips = (n: number) => Array.from({ length: n }, () => ({ kind: "chip", text: "x" }));
    expect(parse(inView({ kind: "bar", kids: chips(12) }))).toEqual([]);
    expect(parse(inView({ kind: "bar", kids: chips(13) }))).toEqual(["/parts/0/view/0/kids"]);
    expect(parse(inView({ kind: "bar", kids: [] }))).toEqual(["/parts/0/view/0/kids"]);
    const lines = (n: number) => Array.from({ length: n }, () => ({ kind: "line", text: "x" }));
    expect(parse(inView({ kind: "code", kids: lines(200), attrs: { max: "40" } }))).toEqual([]);
    expect(parse(inView({ kind: "code", kids: lines(201) }))).toEqual(["/parts/0/view/0/kids"]);
    expect(parse(inView({ kind: "code", kids: lines(1), attrs: { max: "41" } }))).toEqual(["/parts/0/view/0/attrs/max"]);
  });

  it("a row: one para, any chips, one button at its end, an href to a URL or a session", () => {
    const b = { kind: "button", attrs: { label: "Go", intent: "go" } };
    const p = { kind: "para", text: "second line" };
    const c = { kind: "chip", text: "core" };
    expect(parse(row({ kids: [p, c, c, b] }))).toEqual([]);
    expect(parse(row({ kids: [p, p] }))).toEqual(["/parts/0/view/0/kids/0/kids"]);
    expect(parse(row({ kids: [b, c] }))).toEqual(["/parts/0/view/0/kids/0/kids"]);
    for (const href of ["https://a.example/", "http://bluefin:8080/", "bluefin:w6X:3", "trick:bluefin:legs"]) expect(parse(row({ attrs: { href } })), href).toEqual([]);
    for (const href of ["composer", "javascript:", "/etc/passwd", "https:/x"]) expect(parse(row({ attrs: { href } })), href).toEqual(["/parts/0/view/0/kids/0/attrs/href"]);
  });

  it("a link: its href fits its rel, url by default", () => {
    expect(parse(link({ href: "https://a.example/" }))).toEqual([]);
    expect(parse(link({ href: "http://bluefin:8080/" }))).toEqual([]);
    expect(parse(link({ href: "bluefin:w6X:3", rel: "pane" }))).toEqual([]);
    expect(parse(link({ href: "~/projects/a.md", rel: "file" }))).toEqual([]);
    expect(parse(link({ href: "/etc/hosts", rel: "file" }))).toEqual([]);
    expect(parse(link({ href: "bluefin:w6X:3" }))).toEqual(["/parts/0/view/0/kids/0/attrs/href"]);
    expect(parse(link({ href: "https://a.example/", rel: "pane" }))).toEqual(["/parts/0/view/0/kids/0/attrs/href"]);
    expect(parse(link({ href: "a.md", rel: "file" }))).toEqual(["/parts/0/view/0/kids/0/attrs/href"]);
    expect(parse(link({ href: "https://a.example/", rel: "web" }))).toEqual(["/parts/0/view/0/kids/0/attrs/rel"]);
    expect(parse(inView({ kind: "para", kids: [{ kind: "link", attrs: { href: "https://a.example/" } }] }))).toEqual(["/parts/0/view/0/kids/0/text"]);
  });

  it("a button: a label of 24, an intent or does copy with a value, a confirm label, a reason when disabled", () => {
    expect(parse(button({ label: "x".repeat(24), intent: "go" }))).toEqual([]);
    expect(parse(button({ label: "x".repeat(25), intent: "go" }))).toEqual(["/parts/0/view/0/kids/0/attrs/label"]);
    expect(parse(button({ intent: "go" }))).toEqual(["/parts/0/view/0/kids/0/attrs/label"]);
    expect(parse(button({ label: "Copy", does: "copy", value: "abc" }))).toEqual([]);
    expect(parse(button({ label: "Copy", does: "copy" }))).toEqual(["/parts/0/view/0/kids/0/attrs/value"]);
    expect(parse(button({ label: "Copy", does: "copy", value: "abc", intent: "go" }))).toEqual(["/parts/0/view/0/kids/0/attrs/intent"]);
    expect(parse(button({ label: "Tag", intent: "tag", confirm: "Tag 1.28.0?" }))).toEqual([]);
    expect(parse(button({ label: "Tag", intent: "tag", confirm: true }))).toEqual(["/parts/0/view/0/kids/0/attrs/confirm"]);
    expect(parse(button({ label: "Go", intent: "go", disabled: "" }))).toEqual([]);
    expect(parse(button({ label: "Go", intent: "go", disabled: "The leg is running" }))).toEqual([]);
    expect(parse(button({ label: "Go", intent: "go", pressed: "mixed" }))).toEqual([]);
    expect(parse(button({ label: "Go", intent: "go", pressed: "yes" }))).toEqual(["/parts/0/view/0/kids/0/attrs/pressed"]);
    expect(parse(button({ label: "Go", intent: "Go Now" }))).toEqual(["/parts/0/view/0/kids/0/attrs/intent"]);
    expect(parse(button({ label: "Go", intent: "go", value: "x".repeat(1024) }))).toEqual([]);
    expect(parse(button({ label: "Go", intent: "go", value: "x".repeat(1025) }))).toEqual(["/parts/0/view/0/kids/0/attrs/value"]);
    for (const does of ["install", "notify", "reload", "wipe"]) expect(parse(button({ label: "Go", does })), does).toEqual(["/parts/0/view/0/kids/0/attrs/does"]);
  });

  it("a chip: a clock is an epoch instant with how to tell it; text is needed unless it is a clock", () => {
    expect(parse(chip({ at: "1794130692000", clock: "ago" }))).toEqual([]);
    for (const clock of ["elapsed", "left", "time"]) expect(parse(chip({ at: "1794130692000", clock }, "x")), clock).toEqual([]);
    expect(parse(chip({ at: "1794130692000", clock: "date" }))).toEqual(["/parts/0/view/0/kids/0/attrs/clock"]);
    expect(parse(chip({ state: "done" }))).toEqual(["/parts/0/view/0/kids/0/text"]);
    expect(parse(chip({ state: "failed" }, "x"))).toEqual(["/parts/0/view/0/kids/0/attrs/state"]);
    expect(parse(chip({ current: "yes" }, "x"))).toEqual(["/parts/0/view/0/kids/0/attrs/current"]);
    expect(parse(chip({ short: "x".repeat(13) }, "x"))).toEqual(["/parts/0/view/0/kids/0/attrs/short"]);
  });

  it("style: a closed list of words with single spaces", () => {
    for (const style of ["bold", "fg-red bold", "bg-bright-black fg-white", "syn-keyword", "box"]) expect(parse(inView({ kind: "line", text: "x", attrs: { style } })), style).toEqual([]);
    for (const style of ["", "fg-orange", "bold  dim", "bold bold", "#ff0000"]) expect(parse(inView({ kind: "line", text: "x", attrs: { style } })), style).toEqual(["/parts/0/view/0/attrs/style"]);
  });

  it("image: a file under the trick folder, with its size in pixels", () => {
    const image = (src: string, w = "320") => inView({ kind: "image", attrs: { src, alt: "a figure", w, h: "200" } });
    for (const src of ["a.png", "shots/b.jpeg", "c.JPG"]) expect(parse(image(src))).toEqual([]);
    for (const src of ["/etc/x.png", "../x.png", "a/../x.png", "./x.png", "x.svg", "x.png?y", "a//b.png"]) {
      expect(parse(image(src)), src).toEqual(["/parts/0/view/0/attrs/src"]);
    }
    expect(parse(image("a.png", "4097"))).toEqual(["/parts/0/view/0/attrs/w"]);
    expect(parse(image("a.png", "0"))).toEqual(["/parts/0/view/0/attrs/w"]);
  });

  it("a part is at most 16 KiB on the wire", () => {
    expect(JSON.stringify(sessionPartOfBytes(PART_MAX_BYTES)).length).toBe(PART_MAX_BYTES);
    expect(parse({ v: 1, parts: [sessionPartOfBytes(PART_MAX_BYTES)] })).toEqual([]);
    expect(parse({ v: 1, parts: [sessionPartOfBytes(PART_MAX_BYTES + 1)] })).toEqual(["/parts/0"]);
  });

  it("a document is at most 64 KiB, as an object and as stdout text", () => {
    const fits = documentOfBytes(DOCUMENT_MAX_BYTES);
    expect(parseTrickDocument(fits).refusals).toEqual([]);
    expect(parseTrickDocumentText(JSON.stringify(fits)).refusals).toEqual([]);
    const over = documentOfBytes(DOCUMENT_MAX_BYTES + 1);
    for (const result of [parseTrickDocument(over), parseTrickDocumentText(JSON.stringify(over))]) {
      expect(result.documentRefused).toBe(true);
      expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["size", ""]]);
    }
  });

  it("24 parts, 24 nodes in a view, 6 levels, 300 nodes", () => {
    const belt = { at: "belt", id: "belt", mark: { label: "ok" } };
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ...belt, at: `tab:t${i}`, id: `p${i}` }));
    expect(parse({ v: 1, parts: many(24) })).toEqual([]);
    expect(parseTrickDocument({ v: 1, parts: many(25) }).documentRefused).toBe(true);
    expect(parse(session({}, Array.from({ length: 24 }, () => para)))).toEqual([]);
    expect(parse(session({}, Array.from({ length: 25 }, () => para)))).toEqual(["/parts/0/view"]);
    expect(parse(session({}, []))).toEqual(["/parts/0/view"]);
    const nest = (depth: number): JsonObject => (depth === 1 ? { kind: "row", text: "x" } : { kind: "group", kids: [nest(depth - 1)] });
    expect(parse(inView(nest(6)))).toEqual([]);
    expect(parse(inView(nest(7)))).toEqual(["/parts/0/view/0/kids/0/kids/0/kids/0/kids/0/kids/0/kids/0"]);
    const lines = Array.from({ length: 23 }, () => ({ kind: "line", text: "x" }));
    const codes = (n: number) => Array.from({ length: n }, () => ({ kind: "code", kids: lines }));
    // 12 × 24 = 288 nodes pass; 13 × 24 = 312 do not.
    expect(parse(session({}, codes(12)))).toEqual([]);
    expect(parse(session({}, codes(13)))).toEqual(["/parts/0/view"]);
  });

  it("refuses control and invisible characters, and keeps the emoji joiner", () => {
    expect(parse(session({ subtitle: "tab\there" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "a⁦b" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "tag\u{E0041}" }))).toEqual(["/parts/0/subtitle"]);
    expect(parse(session({ subtitle: "👩‍💻 on it" }))).toEqual([]);
    expect(parse(inView({ kind: "para", text: "a\tb" }))).toEqual(["/parts/0/view/0/text"]);
  });
});

describe("decisions", () => {
  const d = (extra: JsonObject) => ({ v: 1, parts: [], decisions: [{ key: "k", title: "T", summary: "S", ...extra }] });

  it("a key of 1 to 64 of a-z, 0-9 and -, a title of 120, a summary of 280 (required), a body of 4000", () => {
    expect(parse(d({}))).toEqual([]);
    expect(parse(d({ key: "x".repeat(64) }))).toEqual([]);
    for (const key of ["", "x".repeat(65), "Case", "a_b", "a b"]) expect(parse(d({ key })), key).toEqual(["/decisions/0/key"]);
    expect(parse(d({ title: "x".repeat(120), summary: "x".repeat(280), body: `${"x".repeat(3990)}\n\nend.` }))).toEqual([]);
    expect(parse(d({ title: "x".repeat(121) }))).toEqual(["/decisions/0/title"]);
    expect(parse(d({ summary: "x".repeat(281) }))).toEqual(["/decisions/0/summary"]);
    expect(parse(d({ body: "x".repeat(4001) }))).toEqual(["/decisions/0/body"]);
    expect(parse({ v: 1, parts: [], decisions: [{ key: "k", title: "T" }] })).toEqual(["/decisions/0/summary"]);
  });

  it("0 to 5 options with unique intents, never the Hill's answer or dismiss; recommends names one, or is null", () => {
    const option = (intent: string) => ({ intent, label: "O" });
    expect(parse(d({ options: [] }))).toEqual([]);
    expect(parse(d({ options: ["a", "b", "c", "d", "e"].map(option) }))).toEqual([]);
    expect(parse(d({ options: ["a", "b", "c", "d", "e", "f"].map(option) }))).toEqual(["/decisions/0/options"]);
    expect(parse(d({ options: [option("a"), option("a")] }))).toEqual(["/decisions/0/options/1/intent"]);
    expect(parse(d({ options: [option("answer")] }))).toEqual(["/decisions/0/options/0/intent"]);
    expect(parse(d({ options: [option("a")], recommends: { intent: "a", why: "x".repeat(200) } }))).toEqual([]);
    expect(parse(d({ options: [option("a")], recommends: { intent: "a", why: "x".repeat(201) } }))).toEqual(["/decisions/0/recommends/why"]);
    expect(parse(d({ options: [option("a")], recommends: { intent: "b", why: "x" } }))).toEqual(["/decisions/0/recommends/intent"]);
    expect(parse(d({ recommends: { intent: "a", why: "x" } }))).toEqual(["/decisions/0/recommends/intent"]);
    expect(parse(d({ recommends: null }))).toEqual([]);
  });

  it("priority now, today or later; about and replyTo a session's scope key; expiresAt epoch ms", () => {
    for (const priority of ["now", "today", "later"]) expect(parse(d({ priority }))).toEqual([]);
    expect(parse(d({ priority: "urgent" }))).toEqual(["/decisions/0/priority"]);
    expect(parse(d({ about: "bluefin:w6X:3", replyTo: "minibuch:%0" }))).toEqual([]);
    expect(parse(d({ about: "trick:bluefin:legs" }))).toEqual(["/decisions/0/about"]);
    expect(parse(d({ replyTo: "composer" }))).toEqual(["/decisions/0/replyTo"]);
    expect(parse(d({ expiresAt: 1_794_200_000_000 }))).toEqual([]);
    expect(parse(d({ expiresAt: "2026-11-09T00:00:00Z" }))).toEqual(["/decisions/0/expiresAt"]);
  });

  it("up to 4 images of the trick folder and 5 links", () => {
    expect(parse(d({ media: [{ file: "a.png", caption: "the step" }, { file: "b.jpg" }] }))).toEqual([]);
    expect(parse(d({ media: [{ file: "a.svg" }] }))).toEqual(["/decisions/0/media/0/file"]);
    expect(parse(d({ media: [{ file: "../a.png" }] }))).toEqual(["/decisions/0/media/0/file"]);
    expect(parse(d({ links: [{ label: "the report", href: "http://bluefin:8832/legs/24" }] }))).toEqual([]);
    expect(parse(d({ links: [{ label: "x", href: "file:///etc/passwd" }] }))).toEqual(["/decisions/0/links/0/href"]);
  });

  it("at most 20 per document; over that the list is refused, the parts still draw", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `d${i}`, title: "T", summary: "S" }));
    expect(parse({ v: 1, parts: [], decisions: list(DECISIONS_MAX) })).toEqual([]);
    const over = parseTrickDocument({ v: 1, parts: [{ at: "belt", id: "belt", mark: { label: "ok" } }], decisions: list(DECISIONS_MAX + 1) });
    expect(paths(over)).toEqual(["/decisions"]);
    expect(over.parts).toHaveLength(1);
    expect(over.documentRefused).toBe(false);
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

  it("a window never passes the 24 h a fresh may name", () => {
    expect(freshWindowMs(undefined, 9 * 3_600_000)).toBe(FRESH_MAX_MS);
    expect(freshWindowMs(undefined, 24 * 3_600_000)).toBe(FRESH_MAX_MS);
    expect(freshWindowMs(undefined, 7 * 3_600_000)).toBe(21 * 3_600_000);
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
    expect(terms("space:collie kind:trick")).toEqual([{ term: "space", glob: "collie" }, { term: "trick" }]);
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

  it("reads every place from at, the place word before the match", () => {
    const place = (at: string) => {
      const read = parseAt(at);
      return "place" in read ? read.place : undefined;
    };
    const expected: [string, PlaceKind][] = [
      ["belt", "belt"],
      ["session", "session"],
      ["tab:fix", "tab"],
      ["view:*", "view"],
      ["dashboard", "dashboard"],
    ];
    for (const [at, kind] of expected) expect(place(at), at).toBe(kind);
    for (const bad of ["Belt", "view:", "tab:", "tab", "header", "header.line", "menu:*", "settings", "view", `view:${"x".repeat(160)}`]) expect(place(bad), bad).toBeUndefined();
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

  it("matches sessions, and reaches a trick session only through kind:trick", () => {
    const m = (t: string) => {
      const read = parseSessionMatch(t);
      if (!("match" in read)) throw new Error(read.reason);
      return read.match;
    };
    const claude = { name: "composer", agent: "claude", cwd: "/var/home/a/projects/collie", space: "collie", trick: false };
    expect(matchesSession(m("*"), claude)).toBe(true);
    expect(matchesSession(m("agent:claude"), claude)).toBe(true);
    expect(matchesSession(m("agent:codex"), claude)).toBe(false);
    expect(matchesSession(m("cwd:~/projects/*"), claude, "/var/home/a")).toBe(true);
    expect(matchesSession(m("cwd:~/projects/*"), claude)).toBe(false);
    expect(matchesSession(m("comp* space:collie"), claude)).toBe(true);
    expect(matchesSession(m("comp* space:other"), claude)).toBe(false);
    const trickSession = { name: "Browser leg", trick: true };
    expect(matchesSession(m("*"), trickSession)).toBe(false);
    expect(matchesSession(m("kind:trick"), trickSession)).toBe(true);
    expect(matchesSession(m("kind:trick"), claude)).toBe(false);
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
  it("tells a scope key from a name and from a trick session", () => {
    for (const key of ["bluefin:w6X:3", "minibuch:%0", "bluefin:abc"]) expect(isScopeKey(key), key).toBe(true);
    for (const key of ["composer", ":w6X", "bluefin:", "bluefin:a b", "bluefin:a/b", "trick:bluefin:legs", `bluefin:${"x".repeat(129)}`]) {
      expect(isScopeKey(key), key).toBe(false);
    }
    expect(isTrickSessionId(trickSessionId("bluefin", "legs"))).toBe(true);
    expect(isTrickSessionId("trick:bluefin:Legs")).toBe(false);
    expect(isTrickSessionId("bluefin:w6X:3")).toBe(false);
  });

  it("names one session part of a trick, splits it back, and never reads it as a scope key", () => {
    expect(trickSessionId("bluefin", "legs", "runs")).toBe("trick:bluefin:legs:runs");
    expect(trickSpaceId("bluefin")).toBe("trick:bluefin");
    expect(parseTrickSessionId("trick:bluefin:legs:runs")).toEqual({ host: "bluefin", trick: "legs", part: "runs" });
    expect(parseTrickSessionId("trick:bluefin:legs")).toEqual({ host: "bluefin", trick: "legs" });
    for (const bad of ["trick:bluefin:legs/runs", "trick:bluefin:legs:Runs", "trick:bluefin:legs:runs:x", "trick:trick:legs", "trick:bluefin"]) {
      expect(parseTrickSessionId(bad), bad).toBeUndefined();
    }
    // The pane id carries no `/`: it is one URL path segment, like every pane id (mux id rule 5).
    expect(trickSessionId("bluefin", "legs", "runs")).not.toContain("/");
    // A host's key around a trick session's pane id is not a real session's key, so no reply reaches it.
    expect(isScopeKey(`bluefin:${trickSessionId("bluefin", "legs", "runs")}`)).toBe(false);
    expect(isScopeKey("bluefin:trick:x")).toBe(false);
    expect(isScopeKey("bluefin:modx:3")).toBe(true);
  });

  it("reads a session part's tone, the tree's words, and refuses a status word there", () => {
    const ok = parseTrickDocument(session({ tone: "accent" }));
    const part = ok.parts[0];
    expect(part?.place === "session" ? part.part.tone : undefined).toBe("accent");
    const refused = parseTrickDocument(session({ tone: "blocked" }));
    expect(refused.refusedParts).toEqual(["s"]);
    expect(refused.refusals[0]?.path).toBe("/parts/0/tone");
  });

  it("opens an https or an http address and nothing else", () => {
    for (const url of ["https://github.com/sprqvntrs/collie", "http://bluefin:8080/", "http://100.64.0.8:8795/x?y=1"]) expect(isTrickUrl(url), url).toBe(true);
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://bluefin/", "//bluefin:8080/", "http://a b/", "HTTP://bluefin/"]) {
      expect(isTrickUrl(url), url).toBe(false);
    }
  });

  it("round-trips a part key", () => {
    const key = { host: "bluefin", trick: "legs", part: "belt" };
    expect(partKey(key)).toBe("bluefin/legs/belt");
    expect(parsePartKey(partKey(key))).toEqual(key);
    for (const bad of ["bluefin/legs", "bluefin/legs/belt/x", "trick/legs/belt", "bluefin/Legs/belt"]) expect(parsePartKey(bad), bad).toBeUndefined();
  });

  it("names a tap's node: a part id or hill/<key>", () => {
    for (const node of ["legs", "belt", "hill/case-24", "hill/x"]) expect(isTapNode(node), node).toBe(true);
    for (const node of ["", "Legs", "hill/", "hill/Case", "legs/belt", "other/x"]) expect(isTapNode(node), node).toBe(false);
  });

  it("escapes a JSON pointer step", () => {
    expect(pointer("/parts/0", "a/b~c")).toBe("/parts/0/a~1b~0c");
    expect(pointer("", 3)).toBe("/3");
  });
});

describe("options", () => {
  it("refuses a node kind this Collie does not draw yet", () => {
    const result = parseTrickDocument(nodeDocument("image"), { kinds: ["para", "card"] });
    expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["later", "/parts/0/view/0/kind"]]);
  });

  it("refuses a place the manifest does not declare", () => {
    const result = parseTrickDocument(LEGS_DOCUMENT, { declared: ["session"] });
    expect(result.refusals.map((r) => [r.code, r.path])).toEqual([["undeclared", "/parts/0/at"]]);
    expect(result.parts.map((p) => p.part.id)).toEqual(["legs"]);
  });

  it("reads a view part's match out of at", () => {
    const part = parseTrickDocument(PLACE_DOCUMENTS.view).parts[0];
    expect(part?.place === "view" && part.match.terms.map((t) => t.term)).toEqual(["agent", "cwd"]);
  });
});

describe("parseTrickDocumentText", () => {
  it("refuses text that is not JSON, and a JSON value that is not an object", () => {
    expect(parseTrickDocumentText("hello").refusals.map((r) => r.code)).toEqual(["json"]);
    expect(parseTrickDocumentText("[1]").refusals.map((r) => r.code)).toEqual(["type"]);
    expect(parseTrickDocumentText(JSON.stringify(LEGS_DOCUMENT)).refusals).toEqual([]);
  });

  it("never throws, whatever the input", () => {
    const junk: JsonValue[] = [
      null,
      0,
      "x",
      true,
      [],
      {},
      { v: 1 },
      { v: 1, parts: [null, 1, "a", [], {}] },
      { v: 1, parts: [{ at: 1, id: 2 }] },
      { v: 1, parts: [], decisions: [null, 1, {}, { options: [null] }] },
      { v: 1, parts: [{ at: "session", id: "s", view: [null, { kind: "row" }, { kind: "card", kids: {} }, { kind: "para", attrs: [] }] }] },
    ];
    for (const value of junk) {
      expect(() => parseTrickDocument(value)).not.toThrow();
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
    const swaps: JsonValue[] = [null, -1, 1e300, "", "x".repeat(300), [], {}, [null], { kind: "card" }, { text: null }];
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
      expect(() => parseTrickDocument(mutate(LEGS_DOCUMENT))).not.toThrow();
      expect(() => parseTrickDocument(mutate(TRACKER_DOCUMENT))).not.toThrow();
      expect(() => parseTrickDocument(mutate(DECISION_DOCUMENT))).not.toThrow();
      for (const kind of NODE_KINDS) expect(() => parseTrickDocument(mutate(nodeDocument(kind)))).not.toThrow();
    }
  });
});

describe("parseManifest", () => {
  it("reads the two first tricks with their defaults", () => {
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
    expect(parseManifest(MANIFESTS.tracker).manifest?.places).toEqual(["session", "tab"]);
  });

  it("skips the later fields with a reason and keeps the trick", () => {
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
    expect(bad({ places: ["tab-mark"] }).refusals[0]?.reason).toContain("tab:<tabmatch>");
    expect(bad({ places: ["header.line"] }).refusals.map((r) => r.code)).toEqual(["place"]);
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
    const [first] = FACTS.timer.sessions;
    const facts = { ...FACTS.timer, sessions: [{ ...first, id: "composer" }] };
    expect(parseFacts(facts).refusals.map((r) => r.path)).toEqual(["/sessions/0/id"]);
  });

  it("gives every session its member, its opaque session id, its pane and a host to show", () => {
    const [first] = FACTS.timer.sessions;
    expect(parseFacts(FACTS.timer).facts?.sessions[0]).toMatchObject({ memberId: "bluefin", sessionId: "bluefin:w6X:3", paneId: "w6X:3", host: "bluefin" });
    for (const key of ["memberId", "sessionId", "paneId", "host"]) {
      const without: JsonObject = { ...first };
      delete without[key];
      expect(parseFacts({ ...FACTS.timer, sessions: [without] }).refusals.map((r) => r.path), key).toEqual([`/sessions/0/${key}`]);
    }
  });

  it("carries a decision's answer as a tap on hill/<key>, with the person's words", () => {
    const trigger = parseFacts(FACTS.answer).facts?.trigger;
    expect(trigger).toEqual({ kind: "tap", rid: "0b9e8d7c-6f5a-4b3c-9d2e-1f0a9b8c7d6e", node: "hill/case-24", intent: "rerun", value: { text: "Rerun it, then tell me." } });
  });
});

describe("parseTapRequest", () => {
  const tap = { rid: "7f0c1d2e-3b4a-4c5d-8e6f-708192a3b4c5", node: "legs", intent: "open-case", value: "24", from: { session: "bluefin:w6X:3" } };

  it("reads a tap in the tree's intent shape", () => {
    expect(parseTapRequest(tap)).toEqual({ request: tap, refusals: [] });
    expect(parseTapRequest({ rid: tap.rid, intent: "open", node: "belt" }).request).toEqual({ rid: tap.rid, intent: "open", node: "belt" });
  });

  it("reads a decision's answer: a text, or null when only an option was tapped", () => {
    const answer = { rid: tap.rid, node: "hill/case-24", intent: "rerun", value: { text: "and tell me" } };
    expect(parseTapRequest(answer).request).toEqual(answer);
    expect(parseTapRequest({ ...answer, value: { text: null } }).request?.value).toEqual({ text: null });
    expect(parseTapRequest({ ...answer, value: { text: "x".repeat(4001) } }).refusals.map((r) => r.path)).toEqual(["/value/text"]);
    expect(parseTapRequest({ ...answer, value: "rerun" }).refusals.map((r) => r.path)).toEqual(["/value"]);
    expect(parseTapRequest({ ...tap, value: { text: "x" } }).refusals.map((r) => r.path)).toEqual(["/value"]);
  });

  it("refuses a bad rid, a name as from, an unknown key, the first schema's keys and a big value", () => {
    const refused = (extra: JsonObject) => parseTapRequest({ ...tap, ...extra }).refusals.map((r) => r.path);
    expect(refused({ rid: "1" })).toEqual(["/rid"]);
    expect(refused({ from: { session: "composer" } })).toEqual(["/from/session"]);
    expect(refused({ turnId: "t1" })).toEqual(["/turnId"]);
    expect(refused({ requestId: tap.rid })).toEqual(["/requestId"]);
    expect(refused({ args: { n: 1 } })).toEqual(["/args"]);
    expect(refused({ value: "x".repeat(1025) })).toEqual(["/value"]);
    expect(refused({ intent: "Open Case" })).toEqual(["/intent"]);
    expect(refused({ node: "legs/belt" })).toEqual(["/node"]);
  });

  it("answers with the tree's receipt codes", () => {
    expect(TAP_CODES).toEqual(["ok", "changed", "rejected", "gone", "denied", "unknown"]);
  });
});

describe("the tone map", () => {
  it("takes the tree's tones, and maps every ink onto a token that already exists, and spells its class", () => {
    expect(TONES).toEqual(["plain", "accent", "warn", "danger", "ok", "muted"]);
    expect(Object.keys(TONE_TOKENS).toSorted()).toEqual([...DRAW_TONES].toSorted());
    for (const tone of DRAW_TONES) {
      expect(THEME_TOKENS).toContain(toneToken(tone));
      expect(TONE_TEXT_CLASS[tone]).toBe(`text-${toneToken(tone)}`);
    }
  });

  it("draws warn and accent in the caution colour of the app's Notice", () => {
    const notice = readRepo("web/src/components/ui/notice.tsx");
    expect(notice).toMatch(/caution: \{[^}]*accent: "text-status-working"/);
    expect(TONE_TEXT_CLASS.warn).toBe("text-status-working");
    expect(TONE_TEXT_CLASS.accent).toBe("text-status-working");
    expect(toneToken("danger")).toBe("status-blocked");
    expect(toneToken("ok")).toBe("status-done");
  });
});

describe("the icon set", () => {
  it("is the tree's 39 words and the tricks' 9, each a lucide icon the phone imports", () => {
    expect(TRICK_ICONS.length).toBe(48);
    expect(TREE_ICONS).toHaveLength(39);
    for (const word of TREE_ICONS) expect(TRICK_ICONS, word).toContain(word);
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
    for (const icon of TRICK_ICONS) {
      const name = TRICK_ICON_LUCIDE[icon];
      expect(exports.has(name), name).toBe(true);
      expect(imported.has(name), name).toBe(true);
    }
  });

  it("keeps Collie's spinner and status circles out", () => {
    const names: string[] = Object.values(TRICK_ICON_LUCIDE);
    for (const name of ["Loader2", "CircleDot", "CheckCircle2", "XCircle", "CircleAlert"]) expect(names).not.toContain(name);
  });

  it("gives actions the twelve words of the bridge's PANE_ACTION_ICONS", () => {
    const bridge = readRepo("bridge/types.ts").match(/export const PANE_ACTION_ICONS = \[([^\]]*)\]/)?.[1] ?? "";
    expect([...bridge.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual([...ACTION_ICONS]);
  });
});
