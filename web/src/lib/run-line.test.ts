import { describe, expect, it } from "vitest";

import { MAX_RUN_CHARS, runnableLine } from "./run-line";

describe("runnableLine", () => {
  it("offers a one-line shell block, tagged or bare", () => {
    expect(runnableLine("bash", "sudo systemctl restart docker\n")).toBe("sudo systemctl restart docker");
    expect(runnableLine("", "git status")).toBe("git status");
    expect(runnableLine("Shell", "ls -la")).toBe("ls -la");
  });

  it("drops the prompt in front of a console line", () => {
    expect(runnableLine("console", "$ npm test")).toBe("npm test");
  });

  it("offers nothing for another language, several lines, or a line over the limit", () => {
    expect(runnableLine("ts", "const a = 1")).toBeNull();
    expect(runnableLine("bash", "cd app\nnpm test")).toBeNull();
    expect(runnableLine("bash", "x".repeat(MAX_RUN_CHARS + 1))).toBeNull();
    expect(runnableLine("bash", "   ")).toBeNull();
    expect(runnableLine("console", "$ ")).toBeNull();
  });
});
