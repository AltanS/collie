// The SDK as an npm package (M55 spec 10, ADR 0105): the shape of packages/durable-sdk/package.json, the two versions
// the core exports, and the runtime pick of the one root import. The pack check (scripts/sdk-pack-check.sh) installs
// the built package and runs it on Node and Bun; this file holds the source to the same promises without a build.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOCOL_RANGE, SDK_VERSION, WIRE_VERSION } from "../../../packages/durable-sdk/src/core/index.ts";

const PKG_DIR = new URL("../../../packages/durable-sdk/", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${PKG_DIR}package.json`, "utf8"));
const ENTRIES = [".", "./node", "./bun", "./pi", "./core"];

describe("the package", () => {
  test("is @colliepwa/durable-sdk, an ES module with no side effects, for Node 22.18 or later", () => {
    expect(pkg.name).toBe("@colliepwa/durable-sdk");
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.engines).toEqual({ node: ">=22.18" });
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).toBeUndefined();
  });

  test("exports the root, ./node, ./bun, ./pi and ./core, each with types and default from dist/", () => {
    for (const entry of ENTRIES) {
      const dir = entry === "." ? "" : `${entry.slice(2)}/`;
      expect([entry, pkg.exports[entry]]).toEqual([entry, { types: `./dist/${dir}index.d.ts`, default: `./dist/${dir}index.js` }]);
    }
  });

  test("ships dist and the three docs files only", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "CHANGELOG.md", "LICENSE"]);
  });

  test("has no runtime dependency; the Pi packages are optional peers, 1.1.0 up to 2", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies)).toEqual(["@types/bun"]);
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      expect([name, range]).toEqual([name, ">=1.1.0 <2"]);
      expect([name, pkg.peerDependenciesMeta[name]]).toEqual([name, { optional: true }]);
    }
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable"]);
  });

  test("its LICENSE is the repo's", () => {
    expect(readFileSync(`${PKG_DIR}LICENSE`, "utf8")).toBe(readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8"));
  });
});

describe("the versions", () => {
  test("SDK_VERSION in the source is the package's version, so a program that imports the source reads the same", () => {
    expect(SDK_VERSION).toBe(pkg.version);
  });

  test("WIRE_VERSION is 1, the top of the range the core speaks and the version Collie's adapter sends", () => {
    expect(WIRE_VERSION).toBe(1);
    expect(WIRE_VERSION).toBe(PROTOCOL_RANGE.max);
    const bridge = readFileSync(new URL("../../../bridge/mux/durable/protocol.ts", import.meta.url), "utf8");
    expect(/^export const WIRE_VERSION = (\d+);$/m.exec(bridge)?.[1]).toBe(String(WIRE_VERSION));
  });
});

describe("the root import", () => {
  test("picks the Bun server on Bun and the Node server elsewhere, by `typeof Bun`, loading only the one it takes", () => {
    const code = readFileSync(`${PKG_DIR}src/index.ts`, "utf8");
    expect(code).toContain('typeof Bun === "undefined" ? await import("./node/index.ts") : await import("./bun/index.ts")');
    // No static import of either server, so Node never loads the Bun one.
    expect(code).not.toMatch(/^import [^;]*from "\.\/(bun|node|server)/m);
  });
});
