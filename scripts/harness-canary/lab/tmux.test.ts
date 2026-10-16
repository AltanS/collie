import { describe, expect, test } from "bun:test";
import { LabTmux, paneCommand, shellWord, socketName } from "./tmux";
import { resolveTmuxBinary } from "../../../bridge/mux/tmux/exec";

const hasTmux = resolveTmuxBinary("") !== null;

describe("the lab tmux", () => {
  test("the socket name holds the pid, and the server never uses the default socket or a config file", () => {
    expect(socketName(4242)).toBe("harness-lab-4242");
    if (!hasTmux) return;
    const tmux = new LabTmux("harness-lab-unit-test");
    const args = tmux.serverArgs();
    expect(args).toEqual(["-f", "/dev/null", "-L", "harness-lab-unit-test"]);
  });

  test("paneCommand quotes every word", () => {
    expect(shellWord("a b")).toBe("'a b'");
    expect(paneCommand({ A: "x y" }, "/bin/prog", ["--flag", "it's"])).toBe("env A='x y' '/bin/prog' '--flag' 'it'\\''s'");
  });

  test.skipIf(!hasTmux)("a real throwaway server starts, shows its pane, stops, and leaves no socket", async () => {
    const tmux = new LabTmux(`harness-lab-unit-${String(process.pid)}`);
    try {
      await tmux.start("/tmp", paneCommand({}, "sh", ["-c", "echo lab-ready; sleep 30"]), { PATH: process.env.PATH ?? "/usr/bin", TERM: "xterm-256color" });
      expect(await tmux.alive()).toBe(true);
      expect(await tmux.paneId()).toMatch(/^%?\d+|%\d+/);
    } finally {
      expect(await tmux.stop()).toBe(true);
    }
    expect(await tmux.alive()).toBe(false);
    expect(tmux.leftover()).toBe(false);
  });
});
