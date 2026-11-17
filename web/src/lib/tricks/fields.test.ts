import { describe, expect, it } from "vitest";

import type { JsonValue } from "../json";
import { FIELD_HINT_MAX, FIELD_LABEL_MAX, FIELD_OPTION_MAX, FIELD_OPTIONS_MAX, FIELD_TEXT_MAX, FIELDS_MAX } from "./limits";
import {
  effectiveValues,
  fieldValueProblem,
  FIELDS_CONTRACT,
  keptValues,
  needsSetup,
  newerContractReason,
  parseFacts,
  parseManifest,
  TRICK_CONTRACT,
  type TrickField,
} from "./schema";
import { FACTS } from "./fixtures";

// `[[field]]` (contract 3): the settings a person keeps for a trick. Every limit refuses on its own.

const base = { id: "legs", name: "Legs", run: "./legs.sh", places: ["belt"], contract: 3 };
const text = { key: "repo", kind: "text", label: "Repository" };
const parse = (...field: JsonValue[]) => parseManifest({ ...base, field });
const codes = (...field: JsonValue[]) => parse(...field).refusals.map((r) => [r.code, r.path]);

describe("[[field]] in trick.toml", () => {
  it("reads the four kinds, with their defaults, hints and required", () => {
    const read = parse(
      { ...text, hint: "owner/name", required: true },
      { key: "branch", kind: "choice", label: "Branch", options: ["main", "edge"], default: "main" },
      { key: "notify", kind: "switch", label: "Notify me", default: true },
      { key: "rows", kind: "number", label: "Rows", min: 1, max: 50, default: 10 },
    );
    expect(read.refusals).toEqual([]);
    expect(read.manifest?.fields).toEqual([
      { key: "repo", kind: "text", label: "Repository", hint: "owner/name", required: true },
      { key: "branch", kind: "choice", label: "Branch", options: ["main", "edge"], default: "main" },
      { key: "notify", kind: "switch", label: "Notify me", default: true },
      { key: "rows", kind: "number", label: "Rows", min: 1, max: 50, default: 10 },
    ]);
  });

  it("is contract 3: an older contract refuses the key, and a Collie that knows 2 refuses the trick by its number", () => {
    expect(FIELDS_CONTRACT).toBe(3);
    expect(TRICK_CONTRACT).toBe(FIELDS_CONTRACT);
    for (const contract of [1, 2]) {
      const old = parseManifest({ ...base, contract, field: [text] });
      expect(old.manifest).toBeUndefined();
      expect(old.refusals.map((r) => [r.code, r.path])).toEqual([["version", "/field"]]);
    }
    // No contract named is 1: fields need the number.
    expect(parseManifest({ id: "legs", name: "Legs", run: "./legs.sh", places: ["belt"], field: [text] }).manifest).toBeUndefined();
    // What an older Collie (contract 2) answers a contract 3 trick: the one sentence with both numbers.
    expect(newerContractReason(3)).toContain("trick contract 3");
  });

  it(`refuses more than ${String(FIELDS_MAX)} fields, and none`, () => {
    const many = Array.from({ length: FIELDS_MAX + 1 }, (_, i) => ({ ...text, key: `k${String(i)}` }));
    expect(parse(...many).manifest).toBeUndefined();
    expect(parse(...many.slice(0, FIELDS_MAX)).manifest?.fields).toHaveLength(FIELDS_MAX);
    expect(parseManifest({ ...base, field: [] }).manifest).toBeUndefined();
  });

  it("refuses a key not spelled as a trick id, and one key twice", () => {
    for (const key of ["Repo", "-repo", "re po", "a".repeat(33), "", "__proto__"]) expect(parse({ ...text, key }).manifest, key).toBeUndefined();
    expect(codes(text, { ...text, label: "Again" })).toEqual([["duplicate", "/field/1/key"]]);
  });

  it("refuses a missing or unknown kind, label or key", () => {
    expect(parse({ key: "repo", label: "Repository" }).manifest).toBeUndefined();
    expect(parse({ ...text, kind: "secret" }).manifest).toBeUndefined();
    expect(parse({ key: "repo", kind: "text" }).manifest).toBeUndefined();
    expect(parse({ kind: "text", label: "Repository" }).manifest).toBeUndefined();
  });

  it(`refuses a label past ${String(FIELD_LABEL_MAX)} and a hint past ${String(FIELD_HINT_MAX)} characters`, () => {
    expect(parse({ ...text, label: "x".repeat(FIELD_LABEL_MAX) }).manifest).toBeDefined();
    expect(parse({ ...text, label: "x".repeat(FIELD_LABEL_MAX + 1) }).manifest).toBeUndefined();
    expect(parse({ ...text, hint: "x".repeat(FIELD_HINT_MAX) }).manifest).toBeDefined();
    expect(parse({ ...text, hint: "x".repeat(FIELD_HINT_MAX + 1) }).manifest).toBeUndefined();
  });

  it("refuses a key of another kind: options on text, required on a switch, min on a choice", () => {
    expect(codes({ ...text, options: ["a", "b"] })).toEqual([["unknown-key", "/field/0/options"]]);
    expect(codes({ key: "on", kind: "switch", label: "On", required: true })).toEqual([["unknown-key", "/field/0/required"]]);
    expect(codes({ key: "b", kind: "choice", label: "B", options: ["a", "b"], min: 1 })).toEqual([["unknown-key", "/field/0/min"]]);
  });

  it(`refuses a text default past ${String(FIELD_TEXT_MAX)} characters, over two lines, or with a control character`, () => {
    expect(parse({ ...text, default: "x".repeat(FIELD_TEXT_MAX) }).manifest).toBeDefined();
    expect(parse({ ...text, default: "x".repeat(FIELD_TEXT_MAX + 1) }).manifest).toBeUndefined();
    expect(parse({ ...text, default: "one\ntwo" }).manifest).toBeUndefined();
    expect(parse({ ...text, default: "bell\u0007" }).manifest).toBeUndefined();
    // Review G point 4: the line and paragraph separators end a line too.
    for (const separator of ["\u2028", "\u2029"]) expect(parse({ ...text, default: `one${separator}two` }).manifest, separator).toBeUndefined();
    expect(parse({ ...text, default: 3 }).manifest).toBeUndefined();
  });

  it(`refuses a choice with fewer than 2 or more than ${String(FIELD_OPTIONS_MAX)} options, a long or doubled option, a default not among them`, () => {
    const choice = { key: "b", kind: "choice", label: "Branch" };
    expect(parse({ ...choice, options: ["main"] }).manifest).toBeUndefined();
    expect(parse({ ...choice, options: Array.from({ length: FIELD_OPTIONS_MAX }, (_, i) => `o${String(i)}`) }).manifest).toBeDefined();
    expect(parse({ ...choice, options: Array.from({ length: FIELD_OPTIONS_MAX + 1 }, (_, i) => `o${String(i)}`) }).manifest).toBeUndefined();
    expect(parse({ ...choice, options: ["main", "x".repeat(FIELD_OPTION_MAX + 1)] }).manifest).toBeUndefined();
    expect(parse({ ...choice, options: ["main", "main"] }).manifest).toBeUndefined();
    expect(parse({ ...choice, options: ["main", "edge"], default: "stable" }).manifest).toBeUndefined();
    expect(parse({ ...choice }).manifest).toBeUndefined();
  });

  it("refuses a number without min and max, min not below max, a fraction, a default out of range", () => {
    const num = { key: "rows", kind: "number", label: "Rows" };
    expect(parse({ ...num, min: 1 }).manifest).toBeUndefined();
    expect(parse({ ...num, max: 9 }).manifest).toBeUndefined();
    expect(parse({ ...num, min: 5, max: 5 }).manifest).toBeUndefined();
    expect(parse({ ...num, min: 0.5, max: 9 }).manifest).toBeUndefined();
    expect(parse({ ...num, min: 1, max: 9, default: 10 }).manifest).toBeUndefined();
    expect(parse({ ...num, min: 1, max: 9, default: 2.5 }).manifest).toBeUndefined();
    expect(parse({ ...num, min: -3, max: 9, default: -3 }).manifest?.fields?.[0]).toMatchObject({ min: -3, max: 9, default: -3 });
  });

  it("refuses a switch default that is not true or false", () => {
    expect(parse({ key: "on", kind: "switch", label: "On", default: "yes" }).manifest).toBeUndefined();
  });
});

describe("a value against its field", () => {
  const repo: TrickField = { key: "repo", kind: "text", label: "Repository", required: true };
  const branch: TrickField = { key: "branch", kind: "choice", label: "Branch", options: ["main", "edge"], default: "main" };
  const notify: TrickField = { key: "notify", kind: "switch", label: "Notify me" };
  const rows: TrickField = { key: "rows", kind: "number", label: "Rows", min: 1, max: 50 };

  it("names each broken rule with its code, and never echoes the value", () => {
    const secret = "lodge-workshop-value";
    expect(fieldValueProblem(repo, `${secret}\n`)?.code).toBe("text");
    expect(fieldValueProblem(repo, "x".repeat(FIELD_TEXT_MAX + 1))?.code).toBe("text");
    for (const separator of ["\u2028", "\u2029"]) expect(fieldValueProblem(repo, `lodge${separator}workshop`)?.code, separator).toBe("text");
    expect(fieldValueProblem(repo, 3)?.code).toBe("kind");
    expect(fieldValueProblem(branch, "stable")?.code).toBe("option");
    expect(fieldValueProblem(notify, "true")?.code).toBe("kind");
    expect(fieldValueProblem(rows, 51)?.code).toBe("range");
    expect(fieldValueProblem(rows, 2.5)?.code).toBe("whole");
    expect(fieldValueProblem(repo, `${secret}\n`)?.reason).not.toContain(secret);
    expect(fieldValueProblem(repo, "lodge/workshop")).toBeUndefined();
  });

  it("keeps only valid values, fills defaults, and says Needs setup for an empty required field", () => {
    const fields = [repo, branch, notify, rows];
    expect(keptValues(fields, { repo: "lodge/workshop", branch: "stable", rows: 99, gone: "x" })).toEqual({ repo: "lodge/workshop" });
    expect(effectiveValues(fields, { rows: 5 })).toEqual({ branch: "main", rows: 5 });
    expect(needsSetup(fields, {})).toBe(true);
    expect(needsSetup(fields, { repo: "" })).toBe(true);
    expect(needsSetup(fields, { repo: "lodge/workshop" })).toBe(false);
  });
});

describe("the facts' values", () => {
  it("reads a values table of text, booleans and numbers, and refuses another shape", () => {
    expect(parseFacts({ ...FACTS.timer, contract: 3, values: { repo: "lodge/workshop", notify: true, rows: 3 } }).facts?.values).toEqual({ repo: "lodge/workshop", notify: true, rows: 3 });
    expect(parseFacts({ ...FACTS.timer, contract: 3, values: { repo: ["x"] } }).refusals.length).toBeGreaterThan(0);
  });
});
