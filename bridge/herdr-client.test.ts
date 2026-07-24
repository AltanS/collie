import { describe, expect, test } from "bun:test";

import { type CliResult, type CliRunner, CliTransport, HerdrClient } from "./herdr-client.ts";

// The CLI transport's argv table is the one part of the Windows path neither reader can verify by
// eye and no non-Windows CI can exercise for real. CliTransport takes its runner as a constructor
// arg, so here we inject a recording fake: assert the exact argv each method spawns, and that the
// JSON-envelope / raw-text / void result handling is right. No process is ever spawned.

interface Call {
  bin: string;
  args: string[];
  env: Record<string, string | undefined>;
}

/** A fake runner that records every invocation and returns a scripted result (default: empty exit 0). */
function recordingRunner(result: Partial<CliResult> = {}) {
  const calls: Call[] = [];
  const runner: CliRunner = async (bin, args, env) => {
    calls.push({ bin, args, env });
    return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  };
  return { calls, runner };
}

/** Build a HerdrClient whose CLI transport uses the given runner. */
function cliClient(runner: CliRunner, bin = "C:\\herdr.exe", socket = "C:\\herdr.sock") {
  return new HerdrClient(new CliTransport(socket, bin, 5000, runner));
}

/** Wrap a result payload in the full `{"id","result":{...}}` envelope the CLI prints on stdout. */
function envelope(result: unknown): string {
  return JSON.stringify({ id: "x", result });
}

describe("CliTransport — argv table", () => {
  test("list/snapshot calls map to their subcommands", async () => {
    const cases: Array<{ run: (c: HerdrClient) => Promise<unknown>; args: string[]; result: unknown }> = [
      { run: (c) => c.listWorkspaces(), args: ["workspace", "list"], result: { workspaces: [] } },
      { run: (c) => c.listPanes(), args: ["pane", "list"], result: { panes: [] } },
      { run: (c) => c.listTabs(), args: ["tab", "list"], result: { tabs: [] } },
      {
        run: (c) => c.sessionSnapshot(),
        args: ["api", "snapshot"],
        result: { type: "snapshot", snapshot: { version: "0.7.5", protocol: 16, workspaces: [], tabs: [], panes: [] } },
      },
    ];
    for (const { run, args, result } of cases) {
      const { calls, runner } = recordingRunner({ stdout: envelope(result) });
      await run(cliClient(runner));
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args).toEqual(args);
    }
  });

  test("createTab includes --no-focus and optional --label/--cwd", async () => {
    const rootPane = { pane_id: "w1:p9", workspace_id: "w1", tab_id: "t9", cwd: "/x" };
    const { calls, runner } = recordingRunner({ stdout: envelope({ root_pane: rootPane }) });
    const client = cliClient(runner);

    await client.createTab("w1");
    expect(calls[0]!.args).toEqual(["tab", "create", "--workspace", "w1", "--no-focus"]);

    await client.createTab("w1", { label: "build", cwd: "/repo" });
    expect(calls[1]!.args).toEqual([
      "tab", "create", "--workspace", "w1", "--no-focus", "--label", "build", "--cwd", "/repo",
    ]);
  });

  test("createWorkspace passes --cwd, --no-focus and optional --label", async () => {
    const result = {
      workspace: { workspace_id: "w2", label: "space", number: 2 },
      root_pane: { pane_id: "w2:p1", workspace_id: "w2", tab_id: "t1", cwd: "/repo" },
    };
    const { calls, runner } = recordingRunner({ stdout: envelope(result) });
    const client = cliClient(runner);

    await client.createWorkspace({ cwd: "/repo" });
    expect(calls[0]!.args).toEqual(["workspace", "create", "--cwd", "/repo", "--no-focus"]);

    await client.createWorkspace({ cwd: "/repo", label: "work" });
    expect(calls[1]!.args).toEqual(["workspace", "create", "--cwd", "/repo", "--no-focus", "--label", "work"]);
  });

  test("send/close/rename map to their subcommands", async () => {
    const { calls, runner } = recordingRunner();
    const client = cliClient(runner);

    // Reply text with quotes/&/%/spaces goes through as ONE argv element (real .exe — no cmd.exe shim).
    await client.sendPaneText("w1:p1", 'echo "a & b" 100%');
    expect(calls[0]!.args).toEqual(["pane", "send-text", "w1:p1", 'echo "a & b" 100%']);

    await client.sendPaneKeys("w1:p1", ["ctrl+a", "Enter"]);
    expect(calls[1]!.args).toEqual(["pane", "send-keys", "w1:p1", "ctrl+a", "Enter"]);

    await client.closePane("w1:p1");
    expect(calls[2]!.args).toEqual(["pane", "close", "w1:p1"]);

    await client.renamePane("w1:p1", "hot");
    expect(calls[3]!.args).toEqual(["pane", "rename", "w1:p1", "hot"]);

    // A null label clears via --clear, not a literal "null".
    await client.renamePane("w1:p1", null);
    expect(calls[4]!.args).toEqual(["pane", "rename", "w1:p1", "--clear"]);

    await client.renameTab("t1", "logs");
    expect(calls[5]!.args).toEqual(["tab", "rename", "t1", "logs"]);

    await client.closeTab("t1");
    expect(calls[6]!.args).toEqual(["tab", "close", "t1"]);
  });

  test("HERDR_SOCKET_PATH is injected into every invocation's env", async () => {
    const { calls, runner } = recordingRunner({ stdout: envelope({ panes: [] }) });
    await cliClient(runner, "C:\\herdr.exe", "C:\\my.sock").listPanes();
    expect(calls[0]!.env.HERDR_SOCKET_PATH).toBe("C:\\my.sock");
    expect(calls[0]!.bin).toBe("C:\\herdr.exe");
  });
});

describe("CliTransport — pane.read (raw text → envelope)", () => {
  test("wraps raw stdout into a PaneRead with source args and revision 0", async () => {
    const { calls, runner } = recordingRunner({ stdout: "line-1\nline-2\n" });
    const read = await cliClient(runner).readPane("w1:p1", "recent", 200, "ansi");
    expect(calls[0]!.args).toEqual([
      "pane", "read", "w1:p1", "--source", "recent", "--lines", "200", "--format", "ansi",
    ]);
    expect(read.pane_id).toBe("w1:p1");
    expect(read.text).toBe("line-1\nline-2\n");
    expect(read.revision).toBe(0);
  });

  test("truncated is approximated true when the read fills the requested window", async () => {
    const full = Array.from({ length: 200 }, (_, i) => `l${i}`).join("\n");
    const { runner } = recordingRunner({ stdout: full });
    const read = await cliClient(runner).readPane("w1:p1", "recent", 200, "text");
    // 200 lines returned for a 200-line request → older scrollback almost certainly exists.
    expect(read.truncated).toBe(true);
  });

  test("truncated is false when fewer lines than requested come back", async () => {
    const { runner } = recordingRunner({ stdout: "only\ntwo\n" });
    const read = await cliClient(runner).readPane("w1:p1", "recent", 200, "text");
    expect(read.truncated).toBe(false);
  });
});

describe("CliTransport — result handling", () => {
  test("a non-zero exit throws with the decoded error message", async () => {
    const { runner } = recordingRunner({
      code: 1,
      stderr: JSON.stringify({ error: { code: "pane_not_found", message: "no such pane" } }),
    });
    await expect(cliClient(runner).closePane("bad")).rejects.toThrow(/pane_not_found: no such pane/);
  });

  test("an 'unknown variant' snapshot error surfaces verbatim (drives StateEngine's fallback)", async () => {
    const { runner } = recordingRunner({ code: 1, stderr: "Error: unknown variant `session.snapshot`" });
    await expect(cliClient(runner).sessionSnapshot()).rejects.toThrow(/unknown variant/);
  });

  test("subscribeEvents returns null — the CLI has no event stream", () => {
    const { runner } = recordingRunner();
    const stream = cliClient(runner).subscribeEvents({
      subscriptions: [],
      onUp: () => {},
      onEvent: () => {},
      onDown: () => {},
    });
    expect(stream).toBeNull();
  });

  test("ping resolves false when the underlying call fails (does not throw)", async () => {
    const { runner } = recordingRunner({ code: 1, stderr: "boom" });
    expect(await cliClient(runner).ping()).toBe(false);
  });
});
