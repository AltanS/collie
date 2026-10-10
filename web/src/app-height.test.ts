import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// THE APP'S HEIGHT on an iOS home-screen launch (index.css, `--app-h`). A bare `100lvh` there ran
// the app ~62pt past the bottom edge on an iOS whose web view starts below the opaque status bar
// (#394, WebKit bugs 301994 and 316008). This pins the shape of the rule; e2e/app-height.spec.ts
// asks a real WebKit to resolve the token.
const css = readFileSync(join(import.meta.dirname, "index.css"), "utf8");

function standaloneBlock(): string {
  const start = css.indexOf("@media (display-mode: standalone)");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf("@layer base", start));
}

describe("--app-h", () => {
  it("is 100dvh outside a home-screen launch", () => {
    expect(css).toMatch(/:root\s*\{\s*--app-h:\s*100dvh;/);
  });

  it("caps dvh plus the top inset at lvh, as one token", () => {
    expect(css).toContain(
      "--app-h-ios-standalone: min(100lvh, calc(100dvh + env(safe-area-inset-top, 0px)));",
    );
  });

  it("takes that token on an iOS home-screen launch, and never a bare viewport unit", () => {
    const block = standaloneBlock();
    expect(block).toContain("--app-h: var(--app-h-ios-standalone);");
    expect(block).not.toMatch(/--app-h:\s*100[ldsv]*vh/);
  });
});
