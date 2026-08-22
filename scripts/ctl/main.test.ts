import { spawn } from "node:child_process";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
};

function runCtl(...args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(import.meta.dir, "main.ts"), ...args], {
      cwd: join(import.meta.dir, "../.."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("ctl command dispatch", () => {
  test("--help exits successfully and lists every verb", async () => {
    const result = await runCtl("--help");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    for (const verb of [
      "start",
      "stop",
      "restart",
      "uninstall",
      "update",
      "build",
      "serve",
      "unserve",
      "status",
      "url",
      "version",
      "qr",
      "logs",
      "push-keys",
      "push-test",
      "exec-bridge",
      "apply-update",
    ]) {
      expect(result.stdout).toContain(`  ${verb}`);
    }
  });

  test("an unknown verb prints usage to stderr and exits 2", async () => {
    const result = await runCtl("not-a-ctl-verb");
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unknown verb: not-a-ctl-verb");
    expect(result.stderr).toContain("Usage: bun scripts/ctl/main.ts <verb> [args...]");
  });
});
