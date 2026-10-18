import { describe, expect, test } from "bun:test";

import { hostFor } from "./host.ts";
import { procProcessIdentity } from "./proc-identity.ts";

describe("procProcessIdentity", () => {
  const LINUX = hostFor("linux");
  const now = (): number => 1_800_000_000_000;

  test("answers nothing off Linux, where /proc start times are not read", async () => {
    // Given: a macOS host and this test's own live process
    // When: the probe is asked about that process
    const identity = await procProcessIdentity(hostFor("darwin"), "arm64", now).identify(process.pid);
    // Then: it does not guess an identity
    expect(identity).toBeNull();
  });

  test("answers nothing on an architecture whose clock unit is not known", async () => {
    // Given: a Linux host on an architecture other than x64 and arm64
    // When: the probe is asked about this process
    const identity = await procProcessIdentity(LINUX, "ia32", now).identify(process.pid);
    // Then: it fails closed
    expect(identity).toBeNull();
  });

  test("answers nothing for a pid that cannot name a process", async () => {
    // Given: pids that are zero, negative or not whole numbers
    const probe = procProcessIdentity(LINUX, "x64", now);
    // When: the probe is asked about each
    const answers = await Promise.all([0, -1, 1.5].map((pid) => probe.identify(pid)));
    // Then: every answer is empty
    expect(answers).toEqual([null, null, null]);
  });

  test.if(process.platform === "linux" && (process.arch === "x64" || process.arch === "arm64"))(
    "names a live Linux process by its pid and start time, with its argv",
    async () => {
      // Given: this test's own process on a Linux host
      const probe = procProcessIdentity(LINUX, process.arch, now);
      // When: the probe is asked about it twice
      const first = await probe.identify(process.pid);
      const second = await probe.identify(process.pid);
      // Then: the token is stable, starts with the pid, and the argv is the process's own
      expect(first?.token.startsWith(`${process.pid}:`)).toBe(true);
      expect(second?.token).toBe(first?.token);
      expect(first?.observedAt).toBe(now());
      expect(first?.argv.length).toBeGreaterThan(0);
    },
  );
});
