import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INEFFECTIVE_IMPORT_ALLOWED,
  ineffectiveImportError,
  ineffectiveImportOf,
  isForbiddenIneffectiveImport,
  MAIN_CHUNK_BUDGET_BYTES,
  mainChunkBudgetError,
} from "../vite-bundle-guard";
import { PRECACHE_MAX_FILE_BYTES } from "../vite-icons";

const ineffective = (module: string) => ({
  code: "INEFFECTIVE_DYNAMIC_IMPORT",
  message: `${module} is dynamically imported by src/router.tsx but also statically imported by src/routes/home.tsx, dynamic import will not move module into another chunk.`,
});

describe("the ineffective dynamic import check", () => {
  it("reads the module a log names", () => {
    expect(ineffectiveImportOf(ineffective("src/routes/settings-sections.tsx"))).toBe("src/routes/settings-sections.tsx");
    // The message as Rolldown 1.1 hands it over: colour codes and the code in brackets first.
    const real = {
      code: "INEFFECTIVE_DYNAMIC_IMPORT",
      message:
        "\u001b[33m[INEFFECTIVE_DYNAMIC_IMPORT] \u001b[0msrc/components/settings-shell.tsx is dynamically imported by src/router.tsx but also statically imported by src/components/settings-page.tsx, dynamic import will not move module into another chunk.",
    };
    expect(ineffectiveImportOf(real)).toBe("src/components/settings-shell.tsx");
    expect(isForbiddenIneffectiveImport(real)).toBe(false);
    expect(ineffectiveImportOf({ code: "CIRCULAR_DEPENDENCY", message: "a -> b -> a" })).toBeNull();
    expect(ineffectiveImportOf({ message: "plain" })).toBeNull();
  });

  it("fails for a lazy screen a static import pulled back, and names what to do", () => {
    const log = ineffective("src/routes/settings-sections.tsx");
    expect(isForbiddenIneffectiveImport(log)).toBe(true);
    const error = ineffectiveImportError(log);
    expect(error).toContain("src/routes/settings-sections.tsx is dynamically imported");
    expect(error).toContain("INEFFECTIVE_IMPORT_ALLOWED");
  });

  it("lets the listed modules through, each with a reason, and leaves other logs alone", () => {
    expect(Object.keys(INEFFECTIVE_IMPORT_ALLOWED)).toEqual(["src/components/settings-shell.tsx"]);
    for (const [module, reason] of Object.entries(INEFFECTIVE_IMPORT_ALLOWED)) {
      expect(isForbiddenIneffectiveImport(ineffective(module))).toBe(false);
      expect(reason.length).toBeGreaterThan(40);
    }
    expect(isForbiddenIneffectiveImport({ code: "CIRCULAR_DEPENDENCY", message: "a -> b -> a" })).toBe(false);
  });
});

describe("the main chunk's budget", () => {
  it("sits under the precache cap and above today's main chunk", () => {
    expect(MAIN_CHUNK_BUDGET_BYTES).toBe(2_200_000);
    expect(MAIN_CHUNK_BUDGET_BYTES).toBeLessThan(PRECACHE_MAX_FILE_BYTES);
    expect(mainChunkBudgetError("assets/index-x.js", 1_870_785)).toBeNull();
    expect(mainChunkBudgetError("assets/index-x.js", MAIN_CHUNK_BUDGET_BYTES)).toBeNull();
  });

  it("fails above it, with what to check first", () => {
    const error = mainChunkBudgetError("assets/index-x.js", MAIN_CHUNK_BUDGET_BYTES + 1);
    expect(error).toContain("assets/index-x.js is 2,200,001 bytes");
    expect(error).toContain("Check first:");
    expect(error).toContain("imported statically from an eager file");
    expect(error).toContain("The precache cap (3 MiB) stays.");
  });

  it("is wired into the build", () => {
    const config = readFileSync(join(import.meta.dirname, "..", "vite.config.ts"), "utf8");
    expect(config).toContain("if (isForbiddenIneffectiveImport(log)) throw new Error(ineffectiveImportError(log));");
    expect(config).toMatch(/plugins: \[[^\]]*mainChunkBudgetPlugin,/u);
  });
});
