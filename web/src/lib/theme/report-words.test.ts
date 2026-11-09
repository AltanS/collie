import { describe, expect, it } from "vitest";

import { en } from "../i18n/messages/en";
import type { JsonObject } from "../json";
import { interpolate } from "../i18n/template";
import { REFUSAL_KEYS, headlineVars, refusalHeadline } from "./report-words";
import { parseTheme, type Refusal } from "./schema";

// The headline both readers print (the Theme card and `collie theme check`): a file of a newer
// version says so, a contrast refusal names its colours and numbers, the rest read their code's line.

function refusals(file: JsonObject): Refusal[] {
  const parsed = parseTheme(JSON.stringify(file), { maxBytes: 64 * 1024 });
  if (parsed.ok) throw new Error("the file parsed");
  return parsed.refusals;
}

function headline(refusal: Refusal): string {
  const words = refusalHeadline(refusal);
  return interpolate(en[words.key], headlineVars(words));
}

describe("refusalHeadline", () => {
  it("says a whole version above the newest read was made for a newer Collie, and only that", () => {
    const [newer] = refusals({ version: 9, id: "x", name: "X", light: { background: "#ffffff" } });
    expect(newer && headline(newer)).toBe("This file was made for a newer Collie (version 9). Update Collie to use it.");
    for (const version of [0, 2.5, "9", null]) {
      const [refusal] = refusals({ version, id: "x", name: "X", light: { background: "#ffffff" } });
      expect(refusal?.newerVersion, String(version)).toBeUndefined();
      expect(refusal && headline(refusal)).toBe(en[REFUSAL_KEYS.version]);
    }
  });

  it("names the two tokens, the ratio and the floor of the hard text refusal", () => {
    const found = refusals({ version: 1, id: "x", name: "X", dark: { foreground: "#222222", background: "#202020" } });
    const hard = found.find((refusal) => refusal.contrast !== undefined);
    expect(hard?.contrast).toMatchObject({ ink: "dark.foreground", ground: "dark.background", floor: 3 });
    expect(hard && headline(hard)).toMatch(/^dark\.foreground on dark\.background measures 1(\.\d+)?\. It needs at least 3\.$/);
  });

  it("reads the code's line for every other refusal", () => {
    const [unknown] = refusals({ version: 1, id: "x", name: "X", light: { background: "#ffffff" }, extra: 1 });
    expect(unknown && headline(unknown)).toBe(en["theme.refusal.unknown-key"]);
  });
});
