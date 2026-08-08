import { describe, expect, it } from "vitest";

import { isPiPastePlaceholder } from "./paste";

describe("Pi paste placeholders", () => {
  it("recognises Pi's lowercase opaque line and character markers", () => {
    expect(isPiPastePlaceholder("[paste #2 +11 lines]")).toBe(true);
    expect(isPiPastePlaceholder("[paste #12 1042 chars]")).toBe(true);
  });

  it("does not treat uppercase, mixed content, or ordinary drafts as opaque", () => {
    expect(isPiPastePlaceholder("[Paste #2 +11 lines]")).toBe(false);
    expect(isPiPastePlaceholder("[paste #2 +11 lines] tail")).toBe(false);
    expect(isPiPastePlaceholder("review the change")).toBe(false);
  });
});
