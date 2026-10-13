import type { JsonValue } from "./json";
import { paneBadge, paneSubtitle } from "./pane-marks";
import type { AgentView } from "./types";

// A crew peer's pane arrives unchecked, so these helpers take any JSON shape for the field.
// SAFETY: the cases below pass the wrong shapes a peer could send; the helpers under test read the field through the JSON guards.
const badge = (value: JsonValue | undefined) => paneBadge({ badge: value as AgentView["badge"] });
// SAFETY: as above, for the subtitle field.
const subtitle = (value: JsonValue | undefined) => paneSubtitle({ subtitle: value as AgentView["subtitle"] });

describe("pane marks: subtitle", () => {
  it("reads a trimmed non-empty string, and nothing else", () => {
    expect(subtitle("  a customer cannot log in ")).toBe("a customer cannot log in");
    for (const value of [undefined, null, "", "   ", 3, {}, ["x"]]) expect(subtitle(value)).toBeNull();
  });
});

describe("pane marks: badge", () => {
  it("reads a whole count from 1 to 9999 and a non-empty text", () => {
    expect(badge({ count: 1 })).toBe("1");
    expect(badge({ count: 9999 })).toBe("9999");
    expect(badge({ text: " new " })).toBe("new");
  });

  it("reads zero, a fraction, a count out of range and every other shape as no badge", () => {
    for (const value of [{ count: 0 }, { count: 1.5 }, { count: 10000 }, { count: -2 }, { count: "3" }, { text: "" }, { text: 4 }, { count: 2, text: "x" }, {}, null, undefined, 7, "3", []]) {
      expect(badge(value)).toBeNull();
    }
  });
});
