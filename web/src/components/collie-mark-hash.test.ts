import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// collie-mark.tsx is generated upstream (collie-brand/scripts/logo-ship.ts) and copied in
// whole. Its first line records a sha256 of everything after it; this test recomputes that
// hash and fails on ANY hand edit made to the file in this repo — re-copy it from
// collie-brand/assets/ instead of editing.
describe("collie-mark.tsx generated hash", () => {
  it("matches the sha256 recorded in its own header", () => {
    const path = join(import.meta.dirname, "collie-mark.tsx");
    const source = readFileSync(path, "utf-8");
    const newlineIndex = source.indexOf("\n");
    const header = source.slice(0, newlineIndex);
    const body = source.slice(newlineIndex + 1);

    const match = header.match(/sha256=([0-9a-f]+)/);
    expect(match).not.toBeNull();

    const expected = match?.[1];
    const actual = createHash("sha256").update(body).digest("hex");
    expect(actual).toBe(expected);
  });
});
