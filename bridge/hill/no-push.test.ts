import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// No ask and no card of Collie's own sends a notification (ADR 0179 addendum). The service has no push port
// to hand a card to, so the pin is the code: nothing under `bridge/hill/` or the tricks that post cards reaches
// the push path, and the push path knows no "hill" target.

const bridge = join(import.meta.dir, "..");
const read = (...parts: string[]): string => readFileSync(join(bridge, ...parts), "utf8");

describe("no card sends a notification", () => {
  test("the old push module is gone, and no hill source file imports a push module", () => {
    expect(existsSync(join(import.meta.dir, "push.ts"))).toBe(false);
    for (const file of readdirSync(import.meta.dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
      const src = readFileSync(join(import.meta.dir, file), "utf8");
      expect(src, file).not.toMatch(/from "(\.\.\/push\.ts|\.\/push\.ts)"/u);
      expect(src, file).not.toContain("pushTag");
      expect(src, file).not.toContain("HILL_NOW_MAX");
    }
  });

  test("the cards that post for Collie and for tricks reach no push path", () => {
    for (const file of ["tricks/hill.ts", "tricks/proposal-card.ts", "tricks/version-card.ts", "tricks/rights-card.ts"]) {
      if (!existsSync(join(bridge, file))) continue;
      const src = read(file);
      expect(src, file).not.toMatch(/from "(\.\.\/push\.ts|\.\.\/hill\/push\.ts)"/u);
      expect(src, file).not.toContain("pushTag");
    }
  });

  test("the generic push path has no hill target and no decision field", () => {
    const src = read("push.ts");
    expect(src).not.toContain("hillTopic");
    expect(src).not.toContain("HILL_TOPIC_PREFIX");
    expect(src).not.toMatch(/target\??: .*"hill"/u);
  });
});
