import { describe, expect, test } from "bun:test";

import { withSessionLabels } from "../operator-space-labels.ts";
import type { SessionSummary } from "../types.ts";
import { sameSpace, spaceNamedOf, spaceOf, spaceOfPane } from "./space.ts";

const of = (memberId: string, spaceId: string, spaceLabel: string, spaceNamed?: boolean) => spaceOf({ memberId, spaceId, spaceLabel, spaceNamed });

describe("the key of a named space is its name, on every machine", () => {
  test("two machines' spaces with one name are one space", () => {
    const a = of("desk", "w1", "api", true);
    const b = of("laptop", "$7", "api", true);
    expect(a).toEqual({ key: "api", named: true, label: "api" });
    expect(sameSpace(a, b)).toBe(true);
  });

  test("names are compared exactly: case and inner blanks count", () => {
    expect(sameSpace(of("desk", "w1", "api", true), of("desk", "w2", "API", true))).toBe(false);
    expect(sameSpace(of("desk", "w1", "my api", true), of("desk", "w2", "my  api", true))).toBe(false);
  });

  test("the name is trimmed and normalised to NFC before it is compared", () => {
    const decomposed = "caf\u0065\u0301";
    const composed = "caf\u00e9";
    const a = of("desk", "w1", `  ${decomposed} \n`, true);
    expect(a.key).toBe(composed);
    expect(a.label).toBe(composed);
    expect(sameSpace(a, of("laptop", "w9", composed, true))).toBe(true);
  });
});

describe("a space with no name of its own stays on its machine", () => {
  test("unnamed spaces with the same label on two machines are two spaces", () => {
    const a = of("desk", "w1", "w1", false);
    const b = of("laptop", "w1", "w1", false);
    expect(a.key).toBe("desk\u0000w1");
    expect(a.named).toBe(false);
    expect(sameSpace(a, b)).toBe(false);
  });

  test("an unnamed label equal to a named space's name does not join it", () => {
    expect(sameSpace(of("desk", "w1", "api", false), of("laptop", "w2", "api", true))).toBe(false);
  });

  test("two panes of one unnamed space on one machine are one space", () => {
    expect(sameSpace(of("desk", "w1", "w1", false), of("desk", "w1", "w1", false))).toBe(true);
    expect(sameSpace(of("desk", "w1", "w1", false), of("desk", "w2", "w2", false))).toBe(false);
  });

  test("a named label that is empty after the trim is unnamed, and the label falls back to the id", () => {
    expect(of("desk", "w3", " \t ", true)).toEqual({ key: "desk\u0000w3", named: false, label: "w3" });
  });

  test("a label that holds the separator cannot forge an unnamed key", () => {
    const forged = of("laptop", "w1", "desk\u0000w1", true);
    expect(forged.named).toBe(false);
    expect(sameSpace(forged, of("desk", "w1", "w1", false))).toBe(false);
  });

  test("with no word from the adapter, a label that is not the id is a name", () => {
    expect(of("desk", "w1", "api").named).toBe(true);
    expect(of("desk", "w1", "w1").named).toBe(false);
    expect(spaceNamedOf({ workspaceId: "w1", workspaceLabel: "api" })).toBe(true);
    expect(spaceNamedOf({ workspaceId: "w1", workspaceLabel: "api", workspaceNamed: false })).toBe(false);
  });
});

describe("the key is the raw mux label, never the operator's display label", () => {
  test("a `spaces.toml` display label exists beside the key and changes no key", () => {
    const entry: SessionSummary = { name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 };
    const shown = withSessionLabels([entry], () => "My phone name");
    expect(shown[0]?.label).toBe("My phone name");
    // The pane's own facts are the only input: a pane in the space the operator labels still keys on the raw name.
    expect(spaceOfPane("desk", { workspaceId: "w1", workspaceLabel: "api", workspaceNamed: true }).key).toBe("api");
  });
});
