// The SDK as an npm package (M55 spec 10, ADR 0105): the shape of packages/durable-sdk/package.json, the two versions
// the core exports, and the runtime pick of the one root import. The pack check (scripts/sdk-pack-check.sh) installs
// the built package and runs it on Node and Bun; this file holds the source to the same promises without a build.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROTOCOL_RANGE, SDK_VERSION, WIRE_VERSION } from "../../../packages/durable-sdk/src/core/index.ts";

const PKG_DIR = new URL("../../../packages/durable-sdk/", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(`${PKG_DIR}package.json`, "utf8"));
const ENTRIES = [".", "./node", "./bun", "./pi", "./core", "./durable-harness"];

describe("the package", () => {
  test("is @colliepwa/durable-sdk, an ES module with no side effects, for Node 22.19 or later", () => {
    expect(pkg.name).toBe("@colliepwa/durable-sdk");
    expect(pkg.type).toBe("module");
    expect(pkg.sideEffects).toBe(false);
    expect(pkg.engines).toEqual({ node: ">=22.19" });
    expect(pkg.license).toBe("MIT");
    expect(pkg.private).toBeUndefined();
  });

  test("exports the root, ./node, ./bun, ./pi, ./core and ./durable-harness, each with types and default from dist/", () => {
    for (const entry of ENTRIES) {
      const dir = entry === "." ? "" : `${entry.slice(2)}/`;
      expect([entry, pkg.exports[entry]]).toEqual([entry, { types: `./dist/${dir}index.d.ts`, default: `./dist/${dir}index.js` }]);
    }
  });

  test("ships dist and the three docs files only", () => {
    expect(pkg.files).toEqual(["dist", "README.md", "CHANGELOG.md", "LICENSE"]);
  });

  test("has no runtime dependency; the Pi packages are optional peers, 1.1.0 up to 2; durable-harness and @workflow/world are optional peers at the exact versions tested", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.devDependencies)).toEqual(["@types/bun"]);
    // A beta moves its API between releases: the durable-harness peers are pinned, and world-port.ts checks them at runtime.
    const exact: Record<string, string> = { "durable-harness": "0.0.1-beta.6", "@workflow/world": "5.0.5" };
    for (const [name, range] of Object.entries(pkg.peerDependencies)) {
      expect([name, range]).toEqual([name, exact[name] ?? ">=1.1.0 <2"]);
      expect([name, pkg.peerDependenciesMeta[name]]).toEqual([name, { optional: true }]);
    }
    expect(Object.keys(pkg.peerDependencies).sort()).toEqual(["@earendil-works/chord", "@earendil-works/pi-ai", "@earendil-works/pi-durable", "@workflow/world", "durable-harness"]);
  });

  test("its LICENSE is the repo's", () => {
    expect(readFileSync(`${PKG_DIR}LICENSE`, "utf8")).toBe(readFileSync(new URL("../../../LICENSE", import.meta.url), "utf8"));
  });
});

describe("the docs quote the package.json", () => {
  // The name is written once, in the package's package.json; a rename is that edit, and this test names every page
  // that still says the old one.
  const pages = ["docs/durable-agents.md", "examples/durable-member/README.md", "packages/durable-sdk/README.md"];
  for (const page of pages) {
    test(`${page} installs the package under its dist-tag and imports it by its name`, () => {
      const text = readFileSync(new URL(`../../../${page}`, import.meta.url), "utf8");
      expect(text).toContain(`npm install ${pkg.name}@experimental`);
      expect(text).toContain(`from "${pkg.name}"`);
    });
  }

  test("the docs' first program is the example's hello.ts with the npm import, ten lines of code", () => {
    const hello = readFileSync(new URL("../hello.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
      .map((line) => (line.startsWith("import ") ? `import { openCollie } from "${pkg.name}";` : line));
    expect(hello).toHaveLength(10);
    const docs = readFileSync(new URL("../../../docs/durable-agents.md", import.meta.url), "utf8");
    const block = /Save this durable agent as `hello\.mjs`\. It is ten lines:\n\n```js\n([\s\S]*?)```/.exec(docs)?.[1] ?? "";
    expect(block.split("\n").filter((line) => line.trim() !== "")).toEqual(hello);
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
  test("picks the Bun server on Bun and the Node server elsewhere, by `\"Bun\" in globalThis`, loading only the one it takes", () => {
    const code = readFileSync(`${PKG_DIR}src/index.ts`, "utf8");
    expect(code).toContain('"Bun" in globalThis ? await import("./bun/index.ts") : await import("./node/index.ts")');
    // No static import of either server, so Node never loads the Bun one.
    expect(code).not.toMatch(/^import [^;]*from "\.\/(bun|node|server)/m);
  });
});
