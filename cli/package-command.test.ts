import { describe, expect, test } from "bun:test";

import { PACKAGED_SENTENCE } from "./install-kind.ts";
import { packageCommand } from "./package-command.ts";

// ── Naming the command, once the kind is already decided ─────────────────────
// The prefix is NEVER evidence of the kind (M17 principle 3). It only chooses which words to print
// after `classifyInstall` has already said `packaged`, and an unrecognised prefix costs the operator
// a command, never a wrong kind.

describe("packageCommand", () => {
  test("each prefix we publish to names its own manager", () => {
    expect(packageCommand("/usr/lib/collie")).toBe("sudo pacman -Syu collie-bin");
    expect(packageCommand("/nix/store/abc123-collie-1.5.3")).toBe("nix profile upgrade collie");
    expect(packageCommand("/opt/homebrew/Cellar/collie/1.5.3")).toBe("brew upgrade collie");
    expect(packageCommand("/usr/local/Cellar/collie/1.5.3")).toBe("brew upgrade collie");
  });

  test("an unrecognised prefix answers null, and the sentence stands on its own", () => {
    expect(packageCommand("/opt/vendor/collie")).toBeNull();
    expect(packageCommand("/usr/lib/collie-something-else")).toBeNull();
    expect(PACKAGED_SENTENCE).toBe("updates come from your package manager");
  });
});
