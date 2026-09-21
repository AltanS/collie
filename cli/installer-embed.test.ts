import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { INSTALLER_SH } from "./installer-embed.ts";

describe("the embedded installer", () => {
  test("is `scripts/install.sh`, byte for byte", () => {
    const onDisk = readFileSync(join(import.meta.dir, "..", "scripts", "install.sh"), "utf8");
    expect(INSTALLER_SH).toBe(onDisk);
  });

  test("is the script it claims to be — a POSIX sh installer steered by COLLIE_TAG", () => {
    expect(INSTALLER_SH.startsWith("#!/bin/sh\n")).toBe(true);
    expect(INSTALLER_SH).toContain("Collie's installer");
    expect(INSTALLER_SH).toContain('PIN="${COLLIE_TAG:-}"');
  });
});
