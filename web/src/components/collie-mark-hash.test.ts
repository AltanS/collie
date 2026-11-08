import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The four marks and their contract are generated upstream (collie-brand/scripts/logo-ship.ts for
// collie-mark.tsx and mark-contract.ts,
// collie-brand/scripts/logo-ship-theme.ts for the three theme marks) and copied in whole. Each file's
// first line records a sha256 of everything after it; this test recomputes that hash and fails on ANY
// hand edit made to the file in this repo. Re-copy it from collie-brand/assets/ instead of editing.
describe.each(["collie-mark.tsx", "kawaii-mark.tsx", "kawaii-tilt-mark.tsx", "pixel-mark.tsx", "mark-contract.ts"])("%s generated hash", (file) => {
  it("matches the sha256 recorded in its own header", () => {
    const source = readFileSync(join(import.meta.dirname, file), "utf-8");
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
