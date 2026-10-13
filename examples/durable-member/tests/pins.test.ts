// The Pi packages moved to the @earendil-works npm scope (the repo is earendil-works/pi). A pin under the old scope would
// resolve to a stale package, so the manifests and the lockfile are checked for the scope and for exact versions.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL("..", import.meta.url));
const PI_PACKAGES = ["chord", "pi-ai", "pi-durable"];
const OLD_SCOPES = ["@mariozechner/", "@badlogic/"];
const read = (path: string) => readFileSync(path, "utf8");

/** The Cloudflare example is parked under experiments/ in a clone of collie, and may be absent from a copy of this folder. */
const manifests = [join(HERE, "package.json"), join(HERE, "..", "..", "experiments", "durable-member-cloudflare", "package.json")].filter(existsSync);

describe("the Pi pins", () => {
  test("every manifest pins chord, pi-ai and pi-durable under @earendil-works at one exact version", () => {
    expect(manifests.length).toBeGreaterThan(0);
    for (const path of manifests) {
      const dependencies = JSON.parse(read(path)).dependencies as Record<string, string>;
      const pins = PI_PACKAGES.map((name) => dependencies[`@earendil-works/${name}`]);
      for (const pin of pins) expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
      expect(new Set(pins).size).toBe(1);
      for (const name of Object.keys(dependencies)) for (const old of OLD_SCOPES) expect(name.startsWith(old)).toBe(false);
    }
  });

  test("the lockfile resolves them under the same scope, and names no old scope", () => {
    const lock = read(join(HERE, "bun.lock"));
    for (const name of PI_PACKAGES) expect(lock).toContain(`"@earendil-works/${name}@`);
    for (const old of OLD_SCOPES) expect(lock).not.toContain(old);
  });

  test("the sources import Pi under the new scope only", () => {
    for (const file of ["app.ts", "script.ts", "pi-durable/index.ts", "state.ts"]) {
      const text = read(join(HERE, file));
      for (const old of OLD_SCOPES) expect(text).not.toContain(old);
    }
  });
});
