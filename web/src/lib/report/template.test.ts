import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FIELD_IDS, ISSUE_TEMPLATE, issueLink, reportFields } from "./body";

// THE LINK AND THE FORM NAME THE SAME FIELDS (ADR 0123). GitHub fills a form field from the URL
// parameter that has the field's `id`, and silently drops a parameter that names no field. So a
// renamed id on either side leaves the issue empty with no error anywhere. This reads the form the
// link names and wants every parameter the link sends to be one of its ids.

const FORM = readFileSync(join(import.meta.dirname, "../../../../.github/ISSUE_TEMPLATE", ISSUE_TEMPLATE), "utf8");

/** The `id:` of every field in the form, in order. */
const formIds = [...FORM.matchAll(/^\s+id:\s*([a-z-]+)\s*$/gmu)].map((match) => match[1]);

describe("the from-app issue form", () => {
  it("has a field for every id the link fills, and no other", () => {
    expect(formIds).toEqual([FIELD_IDS.what, FIELD_IDS.sends, FIELD_IDS.setup, FIELD_IDS.screen]);
  });

  it("carries the from-app label itself, so the link needs no labels parameter", () => {
    expect(FORM).toMatch(/^labels:\n\s+- from-app$/mu);
    const link = new URL(
      issueLink(reportFields({ context: null, sends: [], note: "", includeTyped: false, screen: "a row" })),
    );
    expect([...link.searchParams.keys()]).toEqual(["template", "title", ...formIds]);
    expect(link.searchParams.has("labels")).toBe(false);
  });

  it("requires only what the app always fills", () => {
    const required = [...FORM.matchAll(/id:\s*([a-z-]+)[\s\S]*?required:\s*(true|false)/gu)].map((match) => [match[1], match[2]]);
    expect(required).toEqual([
      [FIELD_IDS.what, "true"],
      [FIELD_IDS.sends, "false"],
      [FIELD_IDS.setup, "false"],
      [FIELD_IDS.screen, "false"],
    ]);
  });
});
